import re
import unicodedata
import uuid
from backend.graph.graph_client import graph_client
from backend.core.embeddings import embed_text


_LEADING = re.compile(r"^(?:the|a|an|my|your|his|her|their|our)\s+", re.I)
_POSSESSIVE = re.compile(r"['\u2019]s\b", re.I)
_NONWORD = re.compile(r"[^a-z0-9\s]")
_WS = re.compile(r"\s+")


def entity_key(name: str) -> str:
    """
    Merge key for an Entity. Collapses case, accents, punctuation, possessives
    and a leading article or possessive pronoun.

    'Ritish' / 'ritish' / "Ritish's" -> 'ritish'
    'my sister' / 'Sister'           -> 'sister'

    Deliberately does NOT resolve aliases ('Ritish' vs 'Ritish Nandikonda',
    'Max' vs 'my dog Max'). That needs judgement, and it belongs in the curator
    where a wrong merge can be reviewed rather than silently baked into a write.
    """
    s = unicodedata.normalize("NFKD", name or "")
    s = "".join(ch for ch in s if not unicodedata.combining(ch))
    s = s.lower().strip()
    s = _LEADING.sub("", s)
    s = _POSSESSIVE.sub("", s)
    s = _NONWORD.sub(" ", s)
    s = _WS.sub(" ", s).strip()
    return s or (name or "").strip().lower()


def _mentions(fact_text: str, entity_name: str) -> bool:
    """Whole-word containment. Avoids 'Al' matching inside 'Also'."""
    if not fact_text or not entity_name:
        return False
    pattern = r"\b" + re.escape(entity_name.strip()) + r"\b"
    return re.search(pattern, fact_text, re.I) is not None


def write_memory(extraction_result: dict):
    """
    Writes an extraction result to the graph as Episode / Entity / Concept nodes.

    Every node carrying an embedding also gets the :Memory label. The vector
    index is defined over :Memory, so a node without it is invisible to
    semantic search regardless of whether it has an embedding.

    Entities merge on a normalized key rather than the raw name, so repeated
    mentions accumulate edges on one node instead of spawning a new one.
    """
    user_id = extraction_result["user_id"]
    episode_id = extraction_result["episode_id"]
    created_at = extraction_result["created_at"]
    extracted = extraction_result["extracted"]

    summary_embedding = embed_text(extracted["episode_summary"])

    graph_client.run("""
        MERGE (e:Episode {id: $id})
        SET e:Memory,
            e.user_id = $user_id,
            e.raw_text = $raw_text,
            e.summary = $summary,
            e.embedding = $embedding,
            e.created_at = $created_at,
            e.ttl_tier = 'working',
            e.confidence = 1.0,
            e.last_accessed = $created_at
        """, {
        "id": episode_id,
        "user_id": user_id,
        "raw_text": extraction_result["raw_text"],
        "summary": extracted["episode_summary"],
        "embedding": summary_embedding,
        "created_at": created_at
    })

    # Entities. Merge on normalized key; first spelling seen becomes the label.
    for entity in extracted["entities"]:
        name = entity["name"]
        key = entity_key(name)
        if not key:
            continue

        description = entity.get("description", "") or ""

        # Only embed when the node is new or its description actually changed.
        # Re-embedding an unchanged entity on every mention is pure wasted spend.
        existing = graph_client.run("""
            MATCH (en:Entity {key: $key, user_id: $user_id})
            RETURN en.description AS description, en.embedding IS NOT NULL AS has_embedding
            """, {"key": key, "user_id": user_id})
        row = existing[0] if existing else None

        if row and row["has_embedding"] and row["description"] == description:
            entity_embedding = None
        else:
            entity_embedding = embed_text(f"{name} {description}".strip())

        graph_client.run("""
            MERGE (en:Entity {key: $key, user_id: $user_id})
            SET en:Memory,
                en.id = coalesce(en.id, $id),
                en.name = coalesce(en.name, $name),
                en.type = $type,
                en.description = $description,
                en.embedding = coalesce($embedding, en.embedding),
                en.created_at = coalesce(en.created_at, $created_at),
                en.last_accessed = $created_at,
                en.mention_count = coalesce(en.mention_count, 0) + 1,
                en.confidence = 1.0,
                en.ttl_tier = 'working'
            WITH en
            MATCH (e:Episode {id: $episode_id})
            MERGE (e)-[:MENTIONED_IN]->(en)
            """, {
            "id": str(uuid.uuid4()),
            "key": key,
            "name": name,
            "type": entity.get("type"),
            "description": description,
            "embedding": entity_embedding,
            "user_id": user_id,
            "created_at": created_at,
            "episode_id": episode_id
        })

    # Concepts.
    for fact in extracted["facts"]:
        concept_embedding = embed_text(fact["content"])
        graph_client.run("""
            MERGE (c:Concept {content: $content, user_id: $user_id})
            SET c:Memory,
                c.id = coalesce(c.id, $id),
                c.confidence = $confidence,
                c.embedding = $embedding,
                c.created_at = coalesce(c.created_at, $created_at),
                c.ttl_tier = 'working',
                c.last_accessed = $created_at
            WITH c
            MATCH (e:Episode {id: $episode_id})
            MERGE (e)-[:SUPPORTS]->(c)
            """, {
            "id": str(uuid.uuid4()),
            "content": fact["content"],
            "confidence": fact["confidence"],
            "embedding": concept_embedding,
            "user_id": user_id,
            "created_at": created_at,
            "episode_id": episode_id
        })

    # Entity -> Concept edges. Without these, every edge in the graph has an
    # Episode on one end, so hiding episodes leaves facts and people as
    # unconnected dust. Scoped to this turn's extraction only.
    for entity in extracted["entities"]:
        key = entity_key(entity["name"])
        if not key:
            continue
        for fact in extracted["facts"]:
            if not _mentions(fact["content"], entity["name"]):
                continue
            graph_client.run("""
                MATCH (en:Entity {key: $key, user_id: $user_id})
                MATCH (c:Concept {content: $content, user_id: $user_id})
                MERGE (c)-[:ABOUT]->(en)
                """, {
                "key": key,
                "content": fact["content"],
                "user_id": user_id
            })

    print(f"Memory written — Episode {episode_id}")
    return episode_id