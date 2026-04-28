import numpy as np
from backend.graph.graph_client import graph_client
from backend.core.embeddings import embed_text


def cosine_similarity(vec1: list, vec2: list) -> float:
    a = np.array(vec1)
    b = np.array(vec2)
    return float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b)))


def retrieve_memories(query: str, user_id: str = "default", top_k: int = 5) -> list:
    query_embedding = embed_text(query)

    # Pull all nodes with embeddings for this user
    nodes = graph_client.run("""
        MATCH (n)
        WHERE n.user_id = $user_id AND n.embedding IS NOT NULL
        RETURN labels(n)[0] as type, n.id as id,
               coalesce(n.summary, n.content, n.name, '') as text,
               n.embedding as embedding,
               n.confidence as confidence,
               n.created_at as created_at
        """, {"user_id": user_id})

    if not nodes:
        return []

    # Score each node by cosine similarity
    scored = []
    for node in nodes:
        if node["embedding"]:
            sim = cosine_similarity(query_embedding, node["embedding"])
            scored.append({
                "type": node["type"],
                "id": node["id"],
                "text": node["text"],
                "similarity": round(sim, 4),
                "confidence": node["confidence"],
                "created_at": node["created_at"]
            })

    # Sort by similarity and return top_k
    scored.sort(key=lambda x: x["similarity"], reverse=True)
    return scored[:top_k]