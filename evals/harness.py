"""
Evaluation harness.

Runs a fixed set of test cases through the real pipeline and scores the result.
Everything happens under a dedicated eval user so production data is untouched;
that user's nodes are wiped before each run so results are reproducible.

Usage:
    $env:PYTHONPATH = "D:\\Projects\\Engram"
    python evals/harness.py
    python evals/harness.py --suite retrieval
    python evals/harness.py --keep          # skip teardown, inspect the graph
"""

import argparse
import json
import sys
import time
import uuid
from datetime import datetime
from pathlib import Path

from backend.graph.graph_client import graph_client
from backend.agents.orchestrator import chat, process_memory_background

EVAL_USER_ID = "eval-harness-fixed-uuid-0000-000000000001"
CASES_PATH = Path(__file__).parent / "test_cases.json"
RESULTS_DIR = Path(__file__).parent / "results"


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
# Suites
# ──────────────────────────────────────────────────────────────
def run_retrieval(cases: list) -> dict:
    """Does the correct memory come back, and does the answer reflect it?"""
    results = []

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
        })

        status = "PASS" if results[-1]["passed"] else "FAIL"
        rank_str = f"rank {rank}" if rank else "not retrieved"
        print(f"  [{status}] {case['id']}  {rank_str}, answer_ok={answer_ok}, {latency_ms}ms")

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
        "cases": results,
    }


def run_grounding(cases: list) -> dict:
    """
    Does grounding score high when memory supports the answer, and low when it
    does not? Both directions matter — certifying everything is as useless as
    certifying nothing.
    """
    results = []

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

        results.append({
            "id": case["id"],
            "query": case["query"],
            "grounding_score": round(score, 3),
            "expectation": expectation,
            "n_citations": len(out["grounding"].get("citations", [])),
            "n_ungrounded": len(out["grounding"].get("ungrounded_claims", [])),
            "passed": passed,
            "note": case.get("note", ""),
        })

        status = "PASS" if passed else "FAIL"
        print(f"  [{status}] {case['id']}  score={score:.2f} expected {expectation}")

    n = len(results)
    return {
        "suite": "grounding",
        "n": n,
        "pass_rate": sum(r["passed"] for r in results) / n if n else 0,
        "cases": results,
    }


def run_contradiction(cases: list) -> dict:
    """
    Are real conflicts caught, and are compatible facts left alone?
    Reported as precision and recall, because the two failure modes differ.
    """
    results = []

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

        results.append({
            "id": case["id"],
            "setup": case["setup"][0],
            "followup": case["followup"],
            "detected": detected,
            "expected": expected,
            "passed": passed,
            "note": case.get("note", ""),
        })

        status = "PASS" if passed else "FAIL"
        print(f"  [{status}] {case['id']}  detected={detected} expected={expected}")

    n = len(results)
    tp = sum(1 for r in results if r["expected"] and r["detected"])
    fp = sum(1 for r in results if not r["expected"] and r["detected"])
    fn = sum(1 for r in results if r["expected"] and not r["detected"])

    return {
        "suite": "contradiction",
        "n": n,
        "true_positives": tp,
        "false_positives": fp,
        "false_negatives": fn,
        "precision": tp / (tp + fp) if (tp + fp) else 0,
        "recall": tp / (tp + fn) if (tp + fn) else 0,
        "pass_rate": sum(r["passed"] for r in results) / n if n else 0,
        "cases": results,
    }


# ──────────────────────────────────────────────────────────────
# Entry point
# ──────────────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--suite", choices=["retrieval", "grounding", "contradiction", "all"],
                        default="all")
    parser.add_argument("--keep", action="store_true",
                        help="skip final teardown so the graph can be inspected")
    args = parser.parse_args()

    cases = json.loads(CASES_PATH.read_text(encoding="utf-8"))

    started = datetime.utcnow().isoformat()
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

    # ── Summary ──
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

    print()

    # ── Persist ──
    RESULTS_DIR.mkdir(exist_ok=True)
    stamp = started.replace(":", "-").split(".")[0]
    out_path = RESULTS_DIR / f"eval-{stamp}.json"
    out_path.write_text(json.dumps({
        "started_at": started,
        "suites": suites,
    }, indent=2), encoding="utf-8")
    print(f"  results → {out_path}\n")


if __name__ == "__main__":
    main()