"""
Evaluation harness.

Runs a fixed set of test cases through the real pipeline and scores the result.
Everything happens under a dedicated eval user so production data is untouched;
that user's nodes are wiped before each run so results are reproducible.

Three modes:

    normal      score the suites, report quality and cost
    sweep       run one suite repeatedly across values of an env var
    ablate      run named variants and compare, to isolate each component's
                contribution

Usage:
    $env:PYTHONPATH = "D:\\Projects\\Engram"

    python evals/harness.py
    python evals/harness.py --suite retrieval
    python evals/harness.py --keep                        # inspect the graph

    python evals/harness.py --sweep RETRIEVAL_TOP_K=3,6,10,15 --suite retrieval
    python evals/harness.py --ablate --suite all

Sweep and ablation spawn subprocesses. This is deliberate: config values bound
at import time cannot be changed by mutating os.environ inside a running
process, so each variant needs a fresh interpreter.
"""

import argparse
import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

from backend.graph.graph_client import graph_client
from backend.agents.orchestrator import chat, process_memory_background

EVAL_USER_ID = "eval-harness-fixed-uuid-0000-000000000001"
CASES_PATH = Path(__file__).parent / "test_cases.json"
RESULTS_DIR = Path(__file__).parent / "results"

JSON_MARKER = "===HARNESS_JSON==="

# Named variants for --ablate. Each maps to environment overrides.
#
# 'no-recency-channel' works with no backend changes. The others require the
# retrieval agent to honour the corresponding flag — see the notes at the end
# of this file.
ABLATIONS = {
    "baseline":            {},
    "no-recency-channel":  {"CONTRADICTION_RECENCY_N": "0"},
    "no-graph-traversal":  {"ENGRAM_DISABLE_GRAPH": "1"},
    "no-vector-search":    {"ENGRAM_DISABLE_VECTOR": "1"},
}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# ──────────────────────────────────────────────────────────────
# Setup / teardown
# ──────────────────────────────────────────────────────────────
def wipe_eval_user():
    """
    Delete every node belonging to the eval user.

    The user_id filter is the only thing standing between this and deleting the
    entire database. Do not remove it.
    """
    result = graph_client.run("""
        MATCH (n {user_id: $user_id})
        WITH count(n) as n_before, collect(n) as nodes
        UNWIND nodes as node
        DETACH DELETE node
        RETURN n_before
        """, {"user_id": EVAL_USER_ID})
    deleted = result[0]["n_before"] if result else 0
    print(f"  wiped {deleted} eval nodes")
    return deleted


def seed(messages: list):
    """Send setup messages through the real pipeline, synchronously."""
    for msg in messages:
        result = chat(msg, user_id=EVAL_USER_ID)
        # chat() defers memory writing to the route; run it inline here so the
        # memory exists before the next step queries it.
        process_memory_background(
            result["_safe_message"], EVAL_USER_ID, result["trace_id"]
        )


# ──────────────────────────────────────────────────────────────
# Cost accounting
# ──────────────────────────────────────────────────────────────
def collect_costs() -> dict:
    """
    Aggregate TraceEvent nodes for the eval user.

    Because wipe_eval_user() clears TraceEvents along with everything else,
    calling this at the end of a case yields that case's cost in isolation.

    Agent invocations and LLM calls are counted separately: pii_scrubber runs
    every turn and makes no model call, so folding it into a single "calls"
    number would understate cost per call and overstate call efficiency.
    """
    empty = {"agent_calls": 0, "llm_calls": 0, "tokens_in": 0,
             "tokens_out": 0, "tokens_total": 0, "by_agent": {}}
    try:
        rows = graph_client.run("""
            MATCH (t:TraceEvent {user_id: $u})
            RETURN t.agent_name           AS agent,
                   count(t)               AS calls,
                   sum(coalesce(t.tokens_input, 0))  AS tokens_in,
                   sum(coalesce(t.tokens_output, 0)) AS tokens_out
            """, {"u": EVAL_USER_ID})
    except Exception as exc:
        print(f"  [cost] trace query failed: {exc}")
        return empty

    if not rows:
        return empty

    by_agent = {}
    for r in rows:
        name = r.get("agent") or "unknown"
        t_in = int(r.get("tokens_in") or 0)
        t_out = int(r.get("tokens_out") or 0)
        by_agent[name] = {
            "calls": int(r.get("calls") or 0),
            "tokens_in": t_in,
            "tokens_out": t_out,
            "tokens_total": t_in + t_out,
        }

    agent_calls = sum(a["calls"] for a in by_agent.values())
    llm_calls = sum(a["calls"] for a in by_agent.values() if a["tokens_total"] > 0)
    tokens_in = sum(a["tokens_in"] for a in by_agent.values())
    tokens_out = sum(a["tokens_out"] for a in by_agent.values())

    return {
        "agent_calls": agent_calls,
        "llm_calls": llm_calls,
        "tokens_in": tokens_in,
        "tokens_out": tokens_out,
        "tokens_total": tokens_in + tokens_out,
        "by_agent": by_agent,
    }


def _sum_costs(per_case: list) -> dict:
    """Fold a list of per-case cost dicts into one total, keeping agent detail."""
    total = {"agent_calls": 0, "llm_calls": 0, "tokens_in": 0,
             "tokens_out": 0, "tokens_total": 0, "by_agent": {}}
    for c in per_case:
        for key in ("agent_calls", "llm_calls", "tokens_in", "tokens_out", "tokens_total"):
            total[key] += c.get(key, 0)
        for name, stats in c.get("by_agent", {}).items():
            slot = total["by_agent"].setdefault(
                name, {"calls": 0, "tokens_in": 0, "tokens_out": 0, "tokens_total": 0}
            )
            for k in slot:
                slot[k] += stats.get(k, 0)
    return total


# ──────────────────────────────────────────────────────────────
# Suites
# ──────────────────────────────────────────────────────────────
def run_retrieval(cases: list) -> dict:
    """Does the correct memory come back, and does the answer reflect it?"""
    results = []
    costs = []

    for case in cases:
        wipe_eval_user()
        seed(case["setup"])

        t0 = time.perf_counter()
        out = chat(case["query"], user_id=EVAL_USER_ID)
        latency_ms = int((time.perf_counter() - t0) * 1000)

        memories = out["memories_used"]
        needle = case["expect_memory_containing"].lower()

        # Rank of the first memory containing the expected substring (1-based)
        rank = None
        for i, m in enumerate(memories, 1):
            if needle in (m.get("text") or "").lower():
                rank = i
                break

        answer_ok = case["expect_answer_containing"].lower() in out["response"].lower()

        cost = collect_costs()
        costs.append(cost)

        results.append({
            "id": case["id"],
            "query": case["query"],
            "memory_rank": rank,
            "hit_at_3": rank is not None and rank <= 3,
            "hit_at_5": rank is not None and rank <= 5,
            "reciprocal_rank": (1.0 / rank) if rank else 0.0,
            "answer_ok": answer_ok,
            "latency_ms": latency_ms,
            "passed": (rank is not None and rank <= 5) and answer_ok,
            "tokens": cost["tokens_total"],
            "llm_calls": cost["llm_calls"],
        })

        status = "PASS" if results[-1]["passed"] else "FAIL"
        rank_str = f"rank {rank}" if rank else "not retrieved"
        print(f"  [{status}] {case['id']}  {rank_str}, answer_ok={answer_ok}, "
              f"{latency_ms}ms, {cost['tokens_total']:,} tok")

    n = len(results)
    return {
        "suite": "retrieval",
        "n": n,
        "precision_at_3": sum(r["hit_at_3"] for r in results) / n if n else 0,
        "precision_at_5": sum(r["hit_at_5"] for r in results) / n if n else 0,
        "mrr": sum(r["reciprocal_rank"] for r in results) / n if n else 0,
        "answer_accuracy": sum(r["answer_ok"] for r in results) / n if n else 0,
        "pass_rate": sum(r["passed"] for r in results) / n if n else 0,
        "avg_latency_ms": int(sum(r["latency_ms"] for r in results) / n) if n else 0,
        "cost": _sum_costs(costs),
        "cases": results,
    }


def run_grounding(cases: list) -> dict:
    """
    Does grounding score high when memory supports the answer, and low when it
    does not? Both directions matter — certifying everything is as useless as
    certifying nothing.
    """
    results = []
    costs = []

    for case in cases:
        wipe_eval_user()
        seed(case["setup"])

        out = chat(case["query"], user_id=EVAL_USER_ID)
        score = out["grounding"].get("grounding_score", 0)

        if "expect_grounding_above" in case:
            passed = score > case["expect_grounding_above"]
            expectation = f"> {case['expect_grounding_above']}"
        else:
            passed = score < case["expect_grounding_below"]
            expectation = f"< {case['expect_grounding_below']}"

        cost = collect_costs()
        costs.append(cost)

        results.append({
            "id": case["id"],
            "query": case["query"],
            "grounding_score": round(score, 3),
            "expectation": expectation,
            "n_citations": len(out["grounding"].get("citations", [])),
            "n_ungrounded": len(out["grounding"].get("ungrounded_claims", [])),
            "passed": passed,
            "note": case.get("note", ""),
            "tokens": cost["tokens_total"],
            "llm_calls": cost["llm_calls"],
        })

        status = "PASS" if passed else "FAIL"
        print(f"  [{status}] {case['id']}  score={score:.2f} expected {expectation}, "
              f"{cost['tokens_total']:,} tok")

    n = len(results)
    return {
        "suite": "grounding",
        "n": n,
        "pass_rate": sum(r["passed"] for r in results) / n if n else 0,
        "cost": _sum_costs(costs),
        "cases": results,
    }


def run_contradiction(cases: list) -> dict:
    """
    Are real conflicts caught, and are compatible facts left alone?
    Reported as precision and recall, because the two failure modes differ.
    """
    results = []
    costs = []

    for case in cases:
        wipe_eval_user()
        seed(case["setup"])

        # Count contradiction nodes before and after the follow-up
        before = graph_client.run(
            "MATCH (c:Contradiction {user_id: $u}) RETURN count(c) as n",
            {"u": EVAL_USER_ID},
        )[0]["n"]

        seed([case["followup"]])

        after = graph_client.run(
            "MATCH (c:Contradiction {user_id: $u}) RETURN count(c) as n",
            {"u": EVAL_USER_ID},
        )[0]["n"]

        detected = after > before
        expected = case["expect_contradiction"]
        passed = detected == expected

        # Which channel surfaced it, when one did. This is what makes a
        # recall change attributable rather than merely observable.
        channels = []
        if detected:
            rows = graph_client.run("""
                MATCH (c:Contradiction {user_id: $u})
                RETURN c.channel AS channel
                """, {"u": EVAL_USER_ID})
            channels = sorted({r["channel"] for r in rows if r.get("channel")})

        cost = collect_costs()
        costs.append(cost)

        results.append({
            "id": case["id"],
            "setup": case["setup"][0],
            "followup": case["followup"],
            "detected": detected,
            "expected": expected,
            "passed": passed,
            "channels": channels,
            "note": case.get("note", ""),
            "tokens": cost["tokens_total"],
            "llm_calls": cost["llm_calls"],
        })

        status = "PASS" if passed else "FAIL"
        chan = f" via {'+'.join(channels)}" if channels else ""
        print(f"  [{status}] {case['id']}  detected={detected} expected={expected}"
              f"{chan}, {cost['tokens_total']:,} tok")

    n = len(results)
    tp = sum(1 for r in results if r["expected"] and r["detected"])
    fp = sum(1 for r in results if not r["expected"] and r["detected"])
    fn = sum(1 for r in results if r["expected"] and not r["detected"])

    # Channel attribution across the run
    channel_counts = {}
    for r in results:
        for ch in r["channels"]:
            channel_counts[ch] = channel_counts.get(ch, 0) + 1

    return {
        "suite": "contradiction",
        "n": n,
        "true_positives": tp,
        "false_positives": fp,
        "false_negatives": fn,
        "precision": tp / (tp + fp) if (tp + fp) else 0,
        "recall": tp / (tp + fn) if (tp + fn) else 0,
        "pass_rate": sum(r["passed"] for r in results) / n if n else 0,
        "channel_counts": channel_counts,
        "cost": _sum_costs(costs),
        "cases": results,
    }


# ──────────────────────────────────────────────────────────────
# Reporting
# ──────────────────────────────────────────────────────────────
def print_summary(suites: dict):
    print(f"{'=' * 62}")
    print("  SUMMARY")
    print(f"{'=' * 62}")

    if "retrieval" in suites:
        r = suites["retrieval"]
        print(f"  Retrieval      precision@3 {r['precision_at_3']:.2f}   "
              f"precision@5 {r['precision_at_5']:.2f}   MRR {r['mrr']:.2f}")
        print(f"                 answer accuracy {r['answer_accuracy']:.2f}   "
              f"avg {r['avg_latency_ms']}ms")

    if "grounding" in suites:
        g = suites["grounding"]
        print(f"  Grounding      pass rate {g['pass_rate']:.2f}  ({g['n']} cases)")

    if "contradiction" in suites:
        c = suites["contradiction"]
        print(f"  Contradiction  precision {c['precision']:.2f}   recall {c['recall']:.2f}   "
              f"pass rate {c['pass_rate']:.2f}")
        if c.get("channel_counts"):
            detail = "   ".join(f"{k} {v}" for k, v in sorted(c["channel_counts"].items()))
            print(f"                 channels: {detail}")

    total = _sum_costs([s["cost"] for s in suites.values() if "cost" in s])
    n_cases = sum(s["n"] for s in suites.values())
    if n_cases:
        print()
        print(f"  Cost           {total['llm_calls']:,} LLM calls   "
              f"{total['tokens_total']:,} tokens")
        print(f"                 {total['llm_calls'] / n_cases:.1f} calls/case   "
              f"{total['tokens_total'] // n_cases:,} tokens/case")

        if total["by_agent"]:
            print()
            print("  Tokens by agent")
            ranked = sorted(total["by_agent"].items(),
                            key=lambda kv: kv[1]["tokens_total"], reverse=True)
            for name, stats in ranked:
                share = (stats["tokens_total"] / total["tokens_total"] * 100
                         if total["tokens_total"] else 0)
                print(f"    {name:<22} {stats['calls']:>4} calls  "
                      f"{stats['tokens_total']:>10,} tok  {share:>5.1f}%")

    print()


# ──────────────────────────────────────────────────────────────
# Variant runners (sweep / ablate)
# ──────────────────────────────────────────────────────────────
def _run_variant(suite: str, env_overrides: dict) -> dict:
    """
    Run the harness in a fresh interpreter with env_overrides applied.

    A subprocess rather than mutating os.environ in place: config values read at
    module import are already bound by the time this process is running, so an
    in-process override would silently do nothing and produce identical results
    across variants — the worst kind of failure, because it looks like a
    finding.
    """
    env = os.environ.copy()
    env.update({k: str(v) for k, v in env_overrides.items()})
    env.setdefault("PYTHONIOENCODING", "utf-8")

    proc = subprocess.run(
        [sys.executable, str(Path(__file__).resolve()),
         "--suite", suite, "--emit-json"],
        env=env, capture_output=True, text=True, encoding="utf-8", errors="replace",
    )

    if JSON_MARKER not in (proc.stdout or ""):
        print(f"    variant failed (exit {proc.returncode})")
        tail = (proc.stderr or proc.stdout or "").strip().splitlines()[-5:]
        for line in tail:
            print(f"      {line}")
        return {}

    payload = proc.stdout.split(JSON_MARKER, 1)[1].strip()
    return json.loads(payload)


def _variant_row(label: str, suites: dict) -> dict:
    """Flatten a variant's results into the handful of numbers worth comparing."""
    row = {"variant": label}
    if "retrieval" in suites:
        r = suites["retrieval"]
        row.update({"p@3": r["precision_at_3"], "mrr": r["mrr"],
                    "answer": r["answer_accuracy"], "ms": r["avg_latency_ms"]})
    if "grounding" in suites:
        row["ground"] = suites["grounding"]["pass_rate"]
    if "contradiction" in suites:
        c = suites["contradiction"]
        row.update({"prec": c["precision"], "recall": c["recall"]})
    total = _sum_costs([s["cost"] for s in suites.values() if "cost" in s])
    row["tokens"] = total["tokens_total"]
    row["calls"] = total["llm_calls"]
    return row


def _print_variant_table(rows: list, first_col: str):
    if not rows:
        print("  no variants completed")
        return

    keys = [k for k in rows[0] if k != "variant"]
    width = max(len(str(r["variant"])) for r in rows + [{"variant": first_col}]) + 2

    header = f"  {first_col:<{width}}" + "".join(f"{k:>10}" for k in keys)
    print(header)
    print("  " + "-" * (len(header) - 2))

    for r in rows:
        line = f"  {str(r['variant']):<{width}}"
        for k in keys:
            v = r[k]
            if k in ("tokens", "calls", "ms"):
                line += f"{v:>10,}"
            else:
                line += f"{v:>10.2f}"
        print(line)
    print()


def run_sweep(spec: str, suite: str):
    """
    spec is VAR=v1,v2,v3 — e.g. RETRIEVAL_TOP_K=3,6,10,15

    Quality usually rises with more context and then falls as irrelevant
    memories crowd the prompt. The point of the sweep is to find where that
    turns, and to see what the extra context costs in tokens.
    """
    var, _, values = spec.partition("=")
    values = [v.strip() for v in values.split(",") if v.strip()]
    if not var or not values:
        print(f"  malformed sweep spec: {spec!r}  (expected VAR=v1,v2,v3)")
        return

    print(f"\n{'=' * 62}")
    print(f"  SWEEP  {var}  over {', '.join(values)}   suite={suite}")
    print(f"{'=' * 62}\n")

    rows = []
    for v in values:
        print(f"  → {var}={v}")
        suites = _run_variant(suite, {var: v})
        if suites:
            rows.append(_variant_row(v, suites))

    print()
    _print_variant_table(rows, var)
    _persist({"mode": "sweep", "variable": var, "suite": suite, "rows": rows},
             f"sweep-{var.lower()}")


def run_ablation(suite: str):
    """
    Run each named variant and compare against baseline.

    A component that costs tokens and does not move any metric when removed is
    either broken or unnecessary. Both are worth knowing before deployment.
    """
    print(f"\n{'=' * 62}")
    print(f"  ABLATION   suite={suite}")
    print(f"{'=' * 62}\n")

    rows = []
    for label, overrides in ABLATIONS.items():
        desc = ", ".join(f"{k}={v}" for k, v in overrides.items()) or "unmodified"
        print(f"  → {label}  ({desc})")
        suites = _run_variant(suite, overrides)
        if suites:
            rows.append(_variant_row(label, suites))

    print()
    _print_variant_table(rows, "variant")

    if rows and rows[0]["variant"] == "baseline":
        base = rows[0]
        print("  Deltas from baseline")
        for r in rows[1:]:
            parts = []
            for k in base:
                if k == "variant":
                    continue
                d = r[k] - base[k]
                if k in ("tokens", "calls", "ms"):
                    if d:
                        parts.append(f"{k} {d:+,}")
                elif abs(d) >= 0.005:
                    parts.append(f"{k} {d:+.2f}")
            print(f"    {r['variant']:<22} {'   '.join(parts) if parts else 'no change'}")
        print()

    _persist({"mode": "ablation", "suite": suite, "rows": rows}, "ablation")


# ──────────────────────────────────────────────────────────────
# Persistence
# ──────────────────────────────────────────────────────────────
def _persist(payload: dict, prefix: str) -> Path:
    RESULTS_DIR.mkdir(exist_ok=True)
    stamp = _now().replace(":", "-").split(".")[0]
    out_path = RESULTS_DIR / f"{prefix}-{stamp}.json"
    payload = {"started_at": _now(), **payload}
    out_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print(f"  results → {out_path}\n")
    return out_path


# ──────────────────────────────────────────────────────────────
# Entry point
# ──────────────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--suite", choices=["retrieval", "grounding", "contradiction", "all"],
                        default="all")
    parser.add_argument("--keep", action="store_true",
                        help="skip final teardown so the graph can be inspected")
    parser.add_argument("--sweep", metavar="VAR=v1,v2,v3",
                        help="run the suite once per value of an environment variable")
    parser.add_argument("--ablate", action="store_true",
                        help="run each named variant in ABLATIONS and compare")
    parser.add_argument("--emit-json", action="store_true",
                        help=argparse.SUPPRESS)  # used by subprocess variants
    args = parser.parse_args()

    if args.sweep:
        run_sweep(args.sweep, args.suite)
        return
    if args.ablate:
        run_ablation(args.suite)
        return

    cases = json.loads(CASES_PATH.read_text(encoding="utf-8"))

    started = _now()
    if not args.emit_json:
        print(f"\n{'=' * 62}")
        print(f"  Engram evaluation — {started}")
        print(f"  eval user: {EVAL_USER_ID}")
        print(f"{'=' * 62}\n")

    suites = {}

    if args.suite in ("retrieval", "all"):
        print("RETRIEVAL")
        suites["retrieval"] = run_retrieval(cases["retrieval"])
        print()

    if args.suite in ("grounding", "all"):
        print("GROUNDING")
        suites["grounding"] = run_grounding(cases["grounding"])
        print()

    if args.suite in ("contradiction", "all"):
        print("CONTRADICTION")
        suites["contradiction"] = run_contradiction(cases["contradiction"])
        print()

    if not args.keep:
        print("teardown")
        wipe_eval_user()
        print()

    if args.emit_json:
        print(JSON_MARKER)
        print(json.dumps(suites))
        return

    print_summary(suites)
    _persist({"suites": suites}, "eval")


if __name__ == "__main__":
    main()