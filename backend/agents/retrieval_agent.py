import numpy as np
import anthropic
import json
from datetime import datetime
from backend.graph.graph_client import graph_client
from backend.core.embeddings import embed_text
from backend.core.config import ANTHROPIC_API_KEY

client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)


def cosine_similarity(vec1: list, vec2: list) -> float:
    a = np.array(vec1)
    b = np.array(vec2)
    return float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b)))


def recency_score(created_at: str) -> float:
    """1.0 = brand new, fades to 0 over ~30 days."""
    if not created_at:
        return 0.5
    try:
        created = datetime.fromisoformat(created_at.replace("Z", ""))
        age_days = (datetime.utcnow() - created).total_seconds() / 86400
        return max(0.0, min(1.0, 1.0 - age_days / 30))
    except Exception:
        return 0.5


# ──────────────────────────────────────────────────────────────
# 1. VECTOR SEARCH — semantic similarity (what you had before)
# ──────────────────────────────────────────────────────────────
def vector_search(query: str, user_id: str, top_k: int = 8) -> list:
    """Find memories whose embeddings are semantically similar to the query."""
    query_embedding = embed_text(query)

    nodes = graph_client.run("""
        MATCH (n)
        WHERE n.user_id = $user_id AND n.embedding IS NOT NULL
        RETURN labels(n)[0] as type, n.id as id,
               coalesce(n.summary, n.content, n.name, '') as text,
               n.embedding as embedding,
               n.confidence as confidence,
               coalesce(n.confirmation_count, 0) as confirmations,
               n.created_at as created_at
        """, {"user_id": user_id})

    scored = []
    for node in nodes:
        if not node["embedding"]:
            continue
        sim = cosine_similarity(query_embedding, node["embedding"])
        scored.append({
            "type": node["type"],
            "id": node["id"],
            "text": node["text"],
            "similarity": round(sim, 4),
            "confidence": node["confidence"] or 0.5,
            "confirmations": node["confirmations"],
            "created_at": node["created_at"],
            "source": "vector",
        })

    scored.sort(key=lambda x: x["similarity"], reverse=True)
    return scored[:top_k]


# ──────────────────────────────────────────────────────────────
# 2. GRAPH TRAVERSAL — walk relationships from query entities
# ──────────────────────────────────────────────────────────────
def extract_query_entities(query: str) -> list:
    """Use Claude to pull entity names out of the query."""
    prompt = f"""Extract entity names from this query (people, places, things, concepts).
Return ONLY valid JSON: {{"entities": ["name1", "name2"]}}
If no entities, return {{"entities": []}}

Query: {query}"""

    try:
        response = client.messages.create(
            model="claude-sonnet-4-5",
            max_tokens=200,
            messages=[{"role": "user", "content": prompt}]
        )
        raw = response.content[0].text.strip()
        if raw.startswith("```"):
            raw = raw.split("```")[1]
            if raw.startswith("json"):
                raw = raw[4:]
        parsed = json.loads(raw)
        return parsed.get("entities", [])
    except Exception as e:
        print(f"⚠️ Entity extraction failed: {e}")
        return []


def graph_traversal(query: str, user_id: str, depth: int = 2) -> list:
    """Find entities mentioned in query, walk graph 2 hops out, return connected memories."""
    entities = extract_query_entities(query)
    if not entities:
        return []

    print(f"🔍 Graph traversal anchored on entities: {entities}")

    results = graph_client.run("""
        MATCH (anchor)
        WHERE anchor.user_id = $user_id
          AND any(name IN $entities WHERE
              toLower(coalesce(anchor.name, anchor.content, '')) CONTAINS toLower(name))
        MATCH (anchor)-[*1..2]-(connected)
        WHERE connected.user_id = $user_id
          AND connected.id IS NOT NULL
        RETURN DISTINCT 
               labels(connected)[0] as type,
               connected.id as id,
               coalesce(connected.summary, connected.content, connected.name, '') as text,
               connected.confidence as confidence,
               coalesce(connected.confirmation_count, 0) as confirmations,
               connected.created_at as created_at,
               anchor.id as anchor_id
        LIMIT 20
        """, {"user_id": user_id, "entities": entities})

    return [{
        "type": r["type"],
        "id": r["id"],
        "text": r["text"],
        "similarity": 0.7,  # baseline — graph hits are structurally relevant
        "confidence": r["confidence"] or 0.5,
        "confirmations": r["confirmations"],
        "created_at": r["created_at"],
        "anchor_id": r["anchor_id"],
        "source": "graph",
    } for r in results]


# ──────────────────────────────────────────────────────────────
# 3. HYBRID RANKER — merge, dedupe, score
# ──────────────────────────────────────────────────────────────
def hybrid_rank(vector_hits: list, graph_hits: list, top_k: int = 5) -> list:
    """
    Merge results, dedupe by id, score:
        relevance × 0.5 + recency × 0.2 + trust × 0.3
    Boost score 1.15× if memory appeared in BOTH vector AND graph.
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
# Public entry point — same name + signature as before.
# Orchestrator keeps working without changes.
# ──────────────────────────────────────────────────────────────
def retrieve_memories(query: str, user_id: str = "default", top_k: int = 5) -> list:
    """Hybrid retrieval: vector + graph traversal, merged and ranked."""
    vector_hits = vector_search(query, user_id, top_k=8)
    graph_hits = graph_traversal(query, user_id, depth=2)

    print(f"   Vector hits: {len(vector_hits)}  ·  Graph hits: {len(graph_hits)}")

    return hybrid_rank(vector_hits, graph_hits, top_k=top_k)