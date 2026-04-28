import uuid
from datetime import datetime
from backend.graph.graph_client import graph_client
from backend.core.embeddings import embed_text


def write_memory(extraction_result: dict):
    user_id = extraction_result["user_id"]
    episode_id = extraction_result["episode_id"]
    extracted = extraction_result["extracted"]

    # Embed episode summary
    summary_embedding = embed_text(extracted["episode_summary"])

    # Write Episode node
    graph_client.run("""
        MERGE (e:Episode {id: $id})
        SET e.user_id = $user_id,
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
        "created_at": extraction_result["created_at"]
    })

    # Write Entity nodes
    for entity in extracted["entities"]:
        entity_id = str(uuid.uuid4())
        entity_embedding = embed_text(entity["name"] + " " + entity["description"])
        graph_client.run("""
            MERGE (en:Entity {name: $name, user_id: $user_id})
            SET en.id = coalesce(en.id, $id),
                en.type = $type,
                en.description = $description,
                en.embedding = $embedding,
                en.created_at = $created_at,
                en.confidence = 1.0,
                en.ttl_tier = 'working'
            WITH en
            MATCH (e:Episode {id: $episode_id})
            MERGE (e)-[:MENTIONED_IN]->(en)
            """, {
            "id": entity_id,
            "name": entity["name"],
            "type": entity["type"],
            "description": entity["description"],
            "embedding": entity_embedding,
            "user_id": user_id,
            "created_at": extraction_result["created_at"],
            "episode_id": episode_id
        })

    # Write Concept nodes from facts
    for fact in extracted["facts"]:
        concept_id = str(uuid.uuid4())
        concept_embedding = embed_text(fact["content"])
        graph_client.run("""
            MERGE (c:Concept {content: $content, user_id: $user_id})
            SET c.id = coalesce(c.id, $id),
                c.confidence = $confidence,
                c.embedding = $embedding,
                c.created_at = $created_at,
                c.ttl_tier = 'working',
                c.last_accessed = $created_at
            WITH c
            MATCH (e:Episode {id: $episode_id})
            MERGE (e)-[:SUPPORTS]->(c)
            """, {
            "id": concept_id,
            "content": fact["content"],
            "confidence": fact["confidence"],
            "embedding": concept_embedding,
            "user_id": user_id,
            "created_at": extraction_result["created_at"],
            "episode_id": episode_id
        })

    print(f"✅ Memory written with embeddings — Episode {episode_id}")
    return episode_id