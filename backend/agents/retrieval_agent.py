import anthropic
import json
import re
import spacy
from datetime import datetime
from backend.graph.graph_client import graph_client
from backend.core.embeddings import embed_text
from backend.core.config import ANTHROPIC_API_KEY

client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)

# Load spaCy's small model once at import (~0.5s, 12MB).
# Used for fast local entity extraction — avoids a Claude round-trip.
try:
    _nlp = spacy.load("en_core_web_sm")
except Exception as e:
    print(f"⚠️ spaCy model failed to load, will use Claude for all extraction: {e}")
    _nlp = None


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
# 1. VECTOR SEARCH — Neo4j SEARCH clause with in-index filtering
# ──────────────────────────────────────────────────────────────
def vector_search(query: str, user_id: str, top_k: int = 8) -> list:
    """
    Semantic search via Neo4j's HNSW vector index using the SEARCH clause.

    user_id is stored in the index as an additional property, so filtering
    happens *inside* the index traversal — no over-fetching, and it scales
    correctly as more users are added.
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
    } for r in results]


# ──────────────────────────────────────────────────────────────
# 2. GRAPH TRAVERSAL — walk relationships from query entities
# ──────────────────────────────────────────────────────────────
def _extract_entities_with_claude(query: str) -> list:
    """
    Fallback path. Slower (~2.5s) but handles vague/implicit references
    like "that place I mentioned down south".
    """
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

        # Strip markdown fences if present
        if raw.startswith("```"):
            raw = raw.split("```")[1]
            if raw.startswith("json"):
                raw = raw[4:]

        # Claude sometimes appends prose after the JSON — extract just the
        # first {...} block rather than parsing the whole response.
        match = re.search(r'\{.*?\}', raw, re.DOTALL)
        if not match:
            print("⚠️ No JSON object found in Claude response")
            return []

        parsed = json.loads(match.group(0))
        return parsed.get("entities", [])
    except Exception as e:
        print(f"⚠️ Claude entity extraction failed: {e}")
        return []


def extract_query_entities(query: str) -> list:
    """
    Two-tier entity extraction:
      1. spaCy NER + noun chunks (local, ~5ms) — handles explicit entities
      2. Claude fallback (~2.5s) — only when spaCy finds nothing,
         catches vague references like "that thing we discussed"

    Fast path for the common case, full reasoning for the hard case.
    """
    if _nlp is not None:
        doc = _nlp(query)

        # Named entities — proper nouns like "Hyderabad", "Google"
        useful_labels = {"PERSON", "ORG", "GPE", "LOC", "PRODUCT",
                         "EVENT", "WORK_OF_ART", "FAC", "NORP"}
        entities = [
            ent.text.strip()
            for ent in doc.ents
            if ent.label_ in useful_labels and ent.text.strip()
        ]

        # Noun chunks — catches common nouns like "chess", "data scientist"
        # that NER misses but which ARE Entity nodes in the graph
        stopword_roots = {"it", "this", "that", "thing", "something",
                          "anything", "everything", "i", "you", "we", "they"}
        noun_chunks = [
            chunk.text.strip()
            for chunk in doc.noun_chunks
            if len(chunk.text.strip()) > 2
            and chunk.root.pos_ in {"NOUN", "PROPN"}
            and chunk.root.text.lower() not in stopword_roots
        ]

        combined = list(dict.fromkeys(entities + noun_chunks))  # dedupe, preserve order

        if combined:
            print(f"⚡ spaCy entities: {combined}")
            return combined[:5]

    # Nothing found locally — escalate to Claude
    return _extract_entities_with_claude(query)


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
# Public entry point — unchanged signature.
# ──────────────────────────────────────────────────────────────
def retrieve_memories(query: str, user_id: str = "default", top_k: int = 5) -> list:
    """Hybrid retrieval: vector + graph traversal, merged and ranked."""
    vector_hits = vector_search(query, user_id, top_k=8)
    graph_hits = graph_traversal(query, user_id, depth=2)

    print(f"   Vector hits: {len(vector_hits)}  ·  Graph hits: {len(graph_hits)}")

    return hybrid_rank(vector_hits, graph_hits, top_k=top_k)