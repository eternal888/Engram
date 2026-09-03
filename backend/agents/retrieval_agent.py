import json
import os
import re
import spacy
from datetime import datetime, timezone

from backend.core.llm_client import client
from backend.graph.graph_client import graph_client
from backend.core.embeddings import embed_text


# Load spaCy's small model once at import (~0.5s, 12MB).
# Used for fast local entity extraction — avoids a Claude round-trip.
try:
    _nlp = spacy.load("en_core_web_sm")
except Exception as e:
    print(f"⚠️ spaCy model failed to load, will use Claude for all extraction: {e}")
    _nlp = None

# PII placeholders are redaction markers, not real entities. If they reach
# graph traversal they match nearly every scrubbed node in the database.
PII_PLACEHOLDERS = {
    "person", "email_address", "phone_number", "location",
    "credit_card", "us_ssn", "ip_address", "iban_code",
    "us_bank_number", "us_passport", "us_driver_license",
    "date_time", "nrp", "url",
}

# Traversal walks only memory nodes. Without this it expands through
# TraceEvent and User nodes, which blows up the pattern match.
MEMORY_LABELS = ["Episode", "Concept", "Entity", "Source", "Contradiction"]

# Determiners and possessives spaCy leaves on noun chunks.
LEADING_WORDS = {"a", "an", "the", "my", "your", "our", "their", "his",
                 "her", "its", "this", "that", "these", "those", "some", "any"}

# Index returns its LIMIT whether anything matches or not — a guitar query
# was pulling engram memories at 0.55 and the model ran with them.
MIN_RELEVANCE = float(os.getenv("RETRIEVAL_MIN_RELEVANCE", "0.6"))

# Anchor selection is an INDEX problem, not a graph problem (Rodriguez &
# Neubauer). Anchors are found by embedding proximity, then traversal walks
# from them. String containment could not do this: 'pet' never CONTAINS-
# matched an entity named 'Max', so traversal fired on 2 of 10 eval cases.
ANCHOR_MIN_SIMILARITY = float(os.getenv("RETRIEVAL_ANCHOR_MIN", "0.55"))
MAX_ANCHOR_TERMS = 3          # one embedding call each — keep the bill small
ANCHORS_PER_TERM = 2

# Graph hits used to be scored at a flat 0.7, which sat above most real
# cosine scores and pushed up to 20 tied results over genuinely relevant
# vector hits. Score is now derived from how the node was actually reached.
GRAPH_BASE = 0.45
GRAPH_HOP_PENALTY = 0.10      # a 2-hop node is weaker than a 1-hop node
GRAPH_PATH_BONUS = 0.06       # reached by many paths => more related
GRAPH_MAX = 0.90

RECENCY_HALF_LIFE_DAYS = 14.0


def recency_score(created_at: str) -> float:
    """
    1.0 = brand new, decaying with a half-life of two weeks.

    This used to compare an aware datetime against a naive utcnow(), which
    raises TypeError. The bare `except` swallowed it and returned 0.5 for
    every memory ever scored, so the recency term contributed a constant and
    the ranker was effectively relevance and trust only.

    Both sides are now explicitly UTC-aware, and only the parse is guarded.
    """
    if not created_at:
        return 0.5

    try:
        text = created_at.strip()
        if text.endswith("Z"):
            text = text[:-1] + "+00:00"
        created = datetime.fromisoformat(text)
    except (ValueError, TypeError):
        return 0.5

    if created.tzinfo is None:
        created = created.replace(tzinfo=timezone.utc)

    age_days = (datetime.now(timezone.utc) - created).total_seconds() / 86400.0
    if age_days < 0:
        return 1.0                      # clock skew: treat as brand new

    return float(0.5 ** (age_days / RECENCY_HALF_LIFE_DAYS))


def _strip_leading(term: str) -> str:
    """Drop determiners so anchors match stored entity names."""
    words = term.strip().split()
    while words and words[0].lower() in LEADING_WORDS:
        words.pop(0)
    return " ".join(words)


# ──────────────────────────────────────────────────────────────
# 1. VECTOR SEARCH — Neo4j SEARCH clause with in-index filtering
# ──────────────────────────────────────────────────────────────
def vector_search(query: str, user_id: str, top_k: int = 8) -> list:
    """
    Semantic search via Neo4j's HNSW vector index using the SEARCH clause.

    user_id is stored in the index as an additional property, so filtering
    happens inside the index traversal — no over-fetching.
    """
    query_embedding = embed_text(query)

    results = graph_client.run("""
        MATCH (node)
          SEARCH node IN (
            VECTOR INDEX memory_embeddings
            FOR $embedding
            WHERE node.user_id = $user_id
            LIMIT $top_k
          ) SCORE AS score
        RETURN labels(node)[0] as type,
               node.id as id,
               coalesce(node.summary, node.content, node.name, '') as text,
               node.confidence as confidence,
               coalesce(node.confirmation_count, 0) as confirmations,
               node.created_at as created_at,
               score
        ORDER BY score DESC
        """, {
        "embedding": query_embedding,
        "user_id": user_id,
        "top_k": top_k,
    })

    return [{
        "type": r["type"],
        "id": r["id"],
        "text": r["text"],
        "similarity": round(r["score"], 4),
        "confidence": r["confidence"] or 0.5,
        "confirmations": r["confirmations"],
        "created_at": r["created_at"],
        "source": "vector",
    } for r in results if r["score"] >= MIN_RELEVANCE]


# ──────────────────────────────────────────────────────────────
# 2. GRAPH TRAVERSAL — walk relationships from query entities
# ──────────────────────────────────────────────────────────────
def _extract_entities_with_claude(query: str) -> list:
    """Fallback path. Slower (~2.5s) but handles vague or implicit references."""
    print("🐢 spaCy found nothing — falling back to Claude for entity extraction")
    prompt = f"""Extract entity names from this query (people, places, things, concepts).
The query may be vague or reference something implicitly — infer what it likely refers to.
Return ONLY valid JSON: {{"entities": ["name1", "name2"]}}
If truly nothing can be inferred, return {{"entities": []}}

Query: {query}"""

    try:
        response = client.messages.create(
            model="claude-sonnet-4-5",
            max_tokens=200,
            messages=[{"role": "user", "content": prompt}]
        )
        raw = response.content[0].text.strip()
        match = re.search(r'\{.*?\}', raw, re.DOTALL)
        if not match:
            print("⚠️ No JSON object found in Claude response")
            return []

        parsed = json.loads(match.group(0))
        entities = parsed.get("entities", [])
        return [e for e in entities if e.strip("[]").lower() not in PII_PLACEHOLDERS]
    except Exception as e:
        print(f"⚠️ Claude entity extraction failed: {e}")
        return []


def extract_query_entities(query: str) -> list:
    """
    Two-tier entity extraction:
      1. spaCy NER + noun chunks (local, ~5ms)
      2. Claude fallback (~2.5s) — only when spaCy finds nothing
    """
    if _nlp is not None:
        doc = _nlp(query)

        useful_labels = {"PERSON", "ORG", "GPE", "LOC", "PRODUCT",
                         "EVENT", "WORK_OF_ART", "FAC", "NORP"}
        entities = [
            ent.text.strip()
            for ent in doc.ents
            if ent.label_ in useful_labels and ent.text.strip()
        ]

        stopword_roots = {"it", "this", "that", "thing", "something",
                          "anything", "everything", "i", "you", "we", "they"}
        noun_chunks = [
            chunk.text.strip()
            for chunk in doc.noun_chunks
            if len(chunk.text.strip()) > 2
            and chunk.root.pos_ in {"NOUN", "PROPN"}
            and chunk.root.text.lower() not in stopword_roots
        ]

        combined = [_strip_leading(e) for e in entities + noun_chunks]
        combined = [e for e in combined if len(e) > 2]
        combined = list(dict.fromkeys(combined))
        combined = [e for e in combined if e.strip("[]").lower() not in PII_PLACEHOLDERS]

        if combined:
            print(f"⚡ spaCy entities: {combined}")
            return combined[:5]

    return [_strip_leading(e) for e in _extract_entities_with_claude(query)]


def find_anchors(terms: list, user_id: str) -> list:
    """
    Resolve query terms to real graph nodes by meaning rather than spelling.

    'pet' has no lexical overlap with 'Max', and 'PRIYAS' has none with
    'PRIYA', but both sit close in embedding space. Every Entity carries an
    embedding and the :Memory label, so the existing HNSW index does this
    without new infrastructure.

    Returns [{id, name, similarity, term}], best first, deduped by node id.
    """
    anchors = {}

    for term in terms[:MAX_ANCHOR_TERMS]:
        if not term.strip():
            continue
        try:
            term_embedding = embed_text(term)
        except Exception as e:
            print(f"⚠️ anchor embedding failed for {term!r}: {e}")
            continue

        rows = graph_client.run("""
            MATCH (node)
              SEARCH node IN (
                VECTOR INDEX memory_embeddings
                FOR $embedding
                WHERE node.user_id = $user_id
                LIMIT $limit
              ) SCORE AS score
            WHERE 'Entity' IN labels(node)
            RETURN node.id as id,
                   coalesce(node.name, '') as name,
                   score
            ORDER BY score DESC
            """, {
            "embedding": term_embedding,
            "user_id": user_id,
            "limit": ANCHORS_PER_TERM * 4,   # over-fetch, then keep Entities
        })

        for r in rows[:ANCHORS_PER_TERM]:
            if r["score"] < ANCHOR_MIN_SIMILARITY:
                continue
            existing = anchors.get(r["id"])
            if existing and existing["similarity"] >= r["score"]:
                continue
            anchors[r["id"]] = {
                "id": r["id"],
                "name": r["name"],
                "similarity": round(r["score"], 4),
                "term": term,
            }

    return sorted(anchors.values(), key=lambda a: a["similarity"], reverse=True)


def graph_traversal(query: str, user_id: str, depth: int = 2) -> list:
    """Resolve query terms to anchor nodes, walk 2 hops out, return what's connected."""
    terms = extract_query_entities(query)
    if not terms:
        return []

    anchors = find_anchors(terms, user_id)
    if not anchors:
        print(f"🔍 no anchors above {ANCHOR_MIN_SIMILARITY} for terms: {terms}")
        return []

    print("🔍 anchors: " + ", ".join(
        f"{a['term']!r}→{a['name']!r} {a['similarity']}" for a in anchors))

    anchor_ids = [a["id"] for a in anchors]
    anchor_sim = {a["id"]: a["similarity"] for a in anchors}

    # path_count and min_hops replace the old flat 0.7. A node reached by
    # several distinct paths is more related than one reached by a single
    # 2-hop walk — the collaborative-filtering weighting from the traversal
    # paper, applied to ranking rather than recommendation.
    results = graph_client.run("""
        MATCH (anchor)
        WHERE anchor.id IN $anchor_ids

        MATCH path = (anchor)-[*1..2]-(connected)
        WHERE connected.user_id = $user_id
          AND connected.id IS NOT NULL
          AND NOT connected.id IN $anchor_ids
          AND all(n IN nodes(path)
                  WHERE any(l IN labels(n) WHERE l IN $types))
        WITH connected, anchor, min(length(path)) as hops, count(path) as paths
        RETURN labels(connected)[0] as type,
               connected.id as id,
               coalesce(connected.summary, connected.content, connected.name, '') as text,
               connected.confidence as confidence,
               coalesce(connected.confirmation_count, 0) as confirmations,
               connected.created_at as created_at,
               anchor.id as anchor_id,
               hops,
               paths
        ORDER BY paths DESC, hops ASC
        LIMIT 20
        """, {
        "user_id": user_id,
        "anchor_ids": anchor_ids,
        "types": MEMORY_LABELS,
    })

    hits = []
    for r in results:
        # Start from how good the anchor match was, then adjust for how the
        # node was reached. Never allowed to reach 1.0 — a structural hit is
        # evidence of relatedness, not evidence of being the answer.
        base = GRAPH_BASE + 0.3 * anchor_sim.get(r["anchor_id"], 0.6)
        base -= GRAPH_HOP_PENALTY * (r["hops"] - 1)
        base += GRAPH_PATH_BONUS * min(r["paths"] - 1, 4)
        similarity = round(max(0.30, min(GRAPH_MAX, base)), 4)

        hits.append({
            "type": r["type"],
            "id": r["id"],
            "text": r["text"],
            "similarity": similarity,
            "confidence": r["confidence"] or 0.5,
            "confirmations": r["confirmations"],
            "created_at": r["created_at"],
            "anchor_id": r["anchor_id"],
            "hops": r["hops"],
            "paths": r["paths"],
            "source": "graph",
        })

    return hits


# ──────────────────────────────────────────────────────────────
# 3. HYBRID RANKER — merge, dedupe, score
# ──────────────────────────────────────────────────────────────
def hybrid_rank(vector_hits: list, graph_hits: list, top_k: int = 5) -> list:
    """
    Merge results, dedupe by id, score:
        relevance × 0.5 + recency × 0.2 + trust × 0.3
    Boost score 1.15× if a memory appeared in BOTH vector AND graph results.
    """
    merged = {}

    for hit in vector_hits + graph_hits:
        nid = hit["id"]
        if nid not in merged:
            merged[nid] = dict(hit)
            merged[nid]["sources"] = {hit["source"]}
        else:
            if hit["similarity"] > merged[nid]["similarity"]:
                merged[nid]["similarity"] = hit["similarity"]
            merged[nid]["sources"].add(hit["source"])

    for hit in merged.values():
        relevance = hit["similarity"]
        recency = recency_score(hit.get("created_at"))
        trust = min(1.0, (hit["confidence"] or 0.5) * (1 + 0.05 * hit["confirmations"]))
        score = relevance * 0.5 + recency * 0.2 + trust * 0.3
        if len(hit["sources"]) > 1:
            score *= 1.15
        hit["score"] = round(score, 4)
        hit["sources"] = list(hit["sources"])

    ranked = sorted(merged.values(), key=lambda x: x["score"], reverse=True)
    return ranked[:top_k]


# ──────────────────────────────────────────────────────────────
# Public entry point — unchanged signature.
# ──────────────────────────────────────────────────────────────
def retrieve_memories(query: str, user_id: str = "default", top_k: int = 5) -> list:
    """Hybrid retrieval: vector search + graph traversal, merged and ranked."""
    vector_hits = vector_search(query, user_id, top_k=8)
    graph_hits = graph_traversal(query, user_id, depth=2)

    print(f"   Vector hits: {len(vector_hits)}  ·  Graph hits: {len(graph_hits)}")

    return hybrid_rank(vector_hits, graph_hits, top_k=top_k)