"""
Contradiction agent.

Candidate generation runs on two channels; the union is judged in a single
Claude call per new fact.

  A. semantic — cosine similarity >= CONTRADICTION_SIM_THRESHOLD
  B. recency  — the most recent CONTRADICTION_RECENCY_N concepts, regardless
                of similarity

Channel B exists because cosine similarity measures topical proximity, not
mutual exclusivity. "I am vegetarian" and "I had steak for dinner" sit well
below any usable similarity gate, yet cannot both be true. Lowering the gate
to reach them would flood the judge with unrelated pairs; bounding by recency
reaches them at fixed cost.

Note: the candidate pool is currently loaded with a full scan over the user's
concepts. This is adequate at current scale but should move to the HNSW
vector index before deployment.
"""

import json
import os
import uuid
from datetime import datetime, timezone

import numpy as np
from backend.core.llm_client import client
from backend.core.embeddings import embed_text
from backend.graph.graph_client import graph_client
from backend.graph.versioning import version_node


# Tunable from the environment so the eval harness can sweep them without edits.
SIM_THRESHOLD = float(os.getenv("CONTRADICTION_SIM_THRESHOLD", "0.3"))
RECENCY_N = int(os.getenv("CONTRADICTION_RECENCY_N", "20"))
MAX_CANDIDATES = int(os.getenv("CONTRADICTION_MAX_CANDIDATES", "30"))
MIN_CONFIDENCE = float(os.getenv("CONTRADICTION_MIN_CONFIDENCE", "0.7"))
JUDGE_MODEL = os.getenv("CONTRADICTION_MODEL", "claude-sonnet-4-5")

NO_USAGE = {"tokens_input": 0, "tokens_output": 0}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def cosine_similarity(vec1: list, vec2: list) -> float:
    a = np.array(vec1)
    b = np.array(vec2)
    denom = np.linalg.norm(a) * np.linalg.norm(b)
    if denom == 0:
        return 0.0
    return float(np.dot(a, b) / denom)


def _load_concept_pool(user_id: str) -> list:
    """
    Every active concept for the user, with embedding and timestamp.
    Superseded nodes are excluded — they are already-resolved losers and
    re-judging them produces noise.
    """
    rows = graph_client.run("""
        MATCH (c:Concept)
        WHERE c.user_id = $user_id
          AND (c.status IS NULL OR c.status <> 'superseded')
        RETURN c.id AS id,
               c.content AS content,
               c.embedding AS embedding,
               c.confidence AS confidence,
               c.created_at AS created_at
        """, {"user_id": user_id})

    pool = [r for r in rows if r.get("content")]

    undated = sum(1 for r in pool if not r.get("created_at"))
    if pool and undated > len(pool) / 2:
        print(
            f"[contradiction] WARNING: {undated}/{len(pool)} concepts have no "
            f"created_at. The recency channel will be unreliable — check the "
            f"property name used by memory_writer."
        )

    return pool


def find_similar_concepts(new_fact: str, user_id: str, threshold: float = None) -> list:
    """Channel A, retained as a standalone entry point for evals and debugging."""
    threshold = SIM_THRESHOLD if threshold is None else threshold
    pool = _load_concept_pool(user_id)
    return _semantic_channel(new_fact, pool, threshold)


def _semantic_channel(new_fact: str, pool: list, threshold: float) -> list:
    new_embedding = embed_text(new_fact)
    hits = []
    for node in pool:
        if not node.get("embedding"):
            continue
        sim = cosine_similarity(new_embedding, node["embedding"])
        if sim >= threshold:
            hits.append({
                "id": node["id"],
                "content": node["content"],
                "confidence": node.get("confidence"),
                "similarity": round(sim, 4),
                "channel": "similarity",
            })
    hits.sort(key=lambda h: h["similarity"], reverse=True)
    return hits


def _recency_channel(pool: list, limit: int) -> list:
    ordered = sorted(pool, key=lambda n: n.get("created_at") or "", reverse=True)
    return [{
        "id": node["id"],
        "content": node["content"],
        "confidence": node.get("confidence"),
        "similarity": None,
        "channel": "recency",
    } for node in ordered[:limit]]


def _already_recorded(user_id: str, new_fact: str, candidate_ids: list) -> set:
    """Pairs already judged and written. Avoids re-billing the same comparison."""
    if not candidate_ids:
        return set()

    rows = graph_client.run("""
        MATCH (con:Contradiction {user_id: $user_id})-[:CONTRADICTS]->(c:Concept)
        WHERE c.id IN $ids AND con.winner_fact = $winner_text
        RETURN DISTINCT c.id AS id
        """, {
        "user_id": user_id,
        "ids": candidate_ids,
        "winner_text": new_fact[:200],
    })
    return {r["id"] for r in rows}


def build_candidates(new_fact: str, user_id: str) -> list:
    """Union of both channels, deduped, filtered, capped."""
    pool = _load_concept_pool(user_id)
    if not pool:
        return []

    merged = {}
    for hit in _semantic_channel(new_fact, pool, SIM_THRESHOLD):
        merged[hit["id"]] = hit

    for hit in _recency_channel(pool, RECENCY_N):
        if hit["id"] in merged:
            merged[hit["id"]]["channel"] = "both"
        else:
            merged[hit["id"]] = hit

    seen = _already_recorded(user_id, new_fact, list(merged.keys()))
    candidates = [c for cid, c in merged.items() if cid not in seen]

    # Similarity hits first so the cap, if hit, drops the weakest signal.
    candidates.sort(key=lambda c: (c["similarity"] is None, -(c["similarity"] or 0)))
    return candidates[:MAX_CANDIDATES]


def _extract_json(raw: str) -> dict:
    """Claude occasionally wraps JSON in fences or prose. Take the outermost object."""
    start = raw.find("{")
    end = raw.rfind("}")
    if start == -1 or end == -1 or end < start:
        raise ValueError(f"no JSON object in response: {raw[:200]}")
    return json.loads(raw[start:end + 1])


def judge_candidates(new_fact: str, candidates: list) -> tuple:
    """
    One call for the whole candidate set.

    Returns (verdicts, usage). The caller applies the confidence floor and
    accumulates usage across facts — a single turn can produce several facts,
    each costing a judge call, so reporting one call's tokens would understate
    a multi-fact turn severalfold.
    """
    if not candidates:
        return [], dict(NO_USAGE)

    listing = "\n".join(
        f"[{i}] {c['content']}" for i, c in enumerate(candidates)
    )

    prompt = f"""You are auditing a user's memory graph for contradictions.

NEW STATEMENT (B):
{new_fact}

EXISTING MEMORIES:
{listing}

A contradiction means the two statements cannot both be true of this user at
the same time. This includes:
  - direct opposites: "I love coffee" / "I hate coffee"
  - a later state superseding an earlier one: "I live in Boston" / "I moved to Seattle"
  - behaviour conflicting with a stated identity or preference:
    "I am vegetarian" / "I had steak for dinner"

It does NOT include statements that are merely different, unrelated, or
surprising:
  - "I bought a bike" / "I drove to work"        -> not a contradiction
  - "I like Rust" / "I like Go"                  -> not a contradiction
  - "I work at Acme" / "I enjoy hiking"          -> not a contradiction

Two statements about different subjects or different attributes are never a
contradiction, however unusual the combination.

"winner" is which statement should be trusted: "A" for the existing memory,
"B" for the new statement, "neither" if genuinely unresolvable. Prefer "B"
when the new statement is a later update of the same attribute.

Return JSON only — no prose, no code fences. Include only genuine
contradictions; return an empty list if there are none.

{{"contradictions": [{{"index": 0, "reasoning": "brief", "winner": "A", "confidence": 0.0}}]}}"""

    try:
        response = client.messages.create(
            model=JUDGE_MODEL,
            max_tokens=1500,
            messages=[{"role": "user", "content": prompt}],
        )
        usage = {
            "tokens_input": response.usage.input_tokens,
            "tokens_output": response.usage.output_tokens,
        }
        parsed = _extract_json(response.content[0].text.strip())
    except Exception as exc:
        print(f"[contradiction] judge call failed: {exc}")
        return [], dict(NO_USAGE)

    verdicts = []
    for item in parsed.get("contradictions", []):
        try:
            idx = int(item["index"])
        except (KeyError, TypeError, ValueError):
            continue
        if not 0 <= idx < len(candidates):
            continue
        verdicts.append({
            "candidate": candidates[idx],
            "reasoning": str(item.get("reasoning", ""))[:500],
            "winner": item.get("winner", "neither"),
            "confidence": float(item.get("confidence", 0.0)),
        })
    return verdicts, usage


def _record(user_id: str, new_fact: str, verdict: dict) -> None:
    candidate = verdict["candidate"]
    winner = verdict["winner"]

    if winner == "B":
        status = "resolved"       # existing memory superseded
    elif winner == "A":
        status = "retained"       # existing memory holds; new fact is the weaker claim
    else:
        status = "unresolved"

    graph_client.run("""
        MATCH (existing:Concept {id: $existing_id})
        CREATE (con:Contradiction {
            id: $con_id,
            user_id: $user_id,
            reasoning: $reasoning,
            winner_fact: $winner_text,
            loser_fact: $loser_text,
            winner: $winner,
            confidence: $confidence,
            channel: $channel,
            similarity: $similarity,
            detected_at: $now,
            status: $status
        })
        CREATE (con)-[:CONTRADICTS]->(existing)
        """, {
        "existing_id": candidate["id"],
        "con_id": str(uuid.uuid4()),
        "user_id": user_id,
        "reasoning": verdict["reasoning"],
        "winner_text": new_fact[:200],
        "loser_text": candidate["content"][:200],
        "winner": winner,
        "confidence": verdict["confidence"],
        "channel": candidate["channel"],
        "similarity": candidate["similarity"],
        "now": _now(),
        "status": status,
    })

    if winner == "B":
        version_node(
            candidate["id"],
            change_reason=f"superseded by contradiction: {new_fact[:50]}",
        )
        graph_client.run("""
            MATCH (loser:Concept {id: $loser_id})
            SET loser.status = 'superseded',
                loser.confidence = coalesce(loser.confidence, 1.0) * 0.5
            """, {"loser_id": candidate["id"]})

        print(
            f"[contradiction] superseded via {candidate['channel']}: "
            f"'{candidate['content'][:50]}' <- '{new_fact[:50]}'"
        )
    else:
        print(
            f"[contradiction] recorded via {candidate['channel']} "
            f"(winner={winner}): '{candidate['content'][:50]}' vs '{new_fact[:50]}'"
        )


def detect_contradictions(new_facts: list, user_id: str) -> dict:
    """
    Returns a dict rather than a bare list so the caller can record cost.

    One judge call is made per fact, so usage accumulates across the loop.
    A single conversational turn frequently yields two or three facts — the
    marathon case produces both "training for a marathon" and "runs every
    morning" from one sentence — so per-turn cost is a multiple of one call.
    """
    contradictions = []
    tokens_in = 0
    tokens_out = 0

    for fact in new_facts:
        content = fact.get("content")
        if not content:
            continue

        candidates = build_candidates(content, user_id)
        if not candidates:
            continue

        verdicts, usage = judge_candidates(content, candidates)
        tokens_in += usage["tokens_input"]
        tokens_out += usage["tokens_output"]

        for verdict in verdicts:
            if verdict["confidence"] < MIN_CONFIDENCE:
                print(
                    f"[contradiction] below confidence floor "
                    f"({verdict['confidence']:.2f} < {MIN_CONFIDENCE}): "
                    f"'{verdict['candidate']['content'][:50]}'"
                )
                continue

            try:
                _record(user_id, content, verdict)
            except Exception as exc:
                print(f"[contradiction] failed to record: {exc}")
                continue

            candidate = verdict["candidate"]
            contradictions.append({
                "new_fact": content,
                "existing_fact": candidate["content"],
                "existing_id": candidate["id"],
                "reasoning": verdict["reasoning"],
                "winner": verdict["winner"],
                "confidence": verdict["confidence"],
                "channel": candidate["channel"],
                "similarity": candidate["similarity"],
            })

    return {
        "contradictions": contradictions,
        "usage": {"tokens_input": tokens_in, "tokens_output": tokens_out},
    }