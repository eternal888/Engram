import anthropic
import json
from backend.graph.graph_client import graph_client
from backend.core.embeddings import embed_text
from backend.core.config import ANTHROPIC_API_KEY
import numpy as np

client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)


def cosine_similarity(vec1: list, vec2: list) -> float:
    a = np.array(vec1)
    b = np.array(vec2)
    return float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b)))


def find_similar_concepts(new_fact: str, user_id: str, threshold: float = 0.3) -> list:
    new_embedding = embed_text(new_fact)

    existing = graph_client.run("""
        MATCH (c:Concept)
        WHERE c.user_id = $user_id AND c.embedding IS NOT NULL
        RETURN c.id as id, c.content as content, c.embedding as embedding, c.confidence as confidence
        """, {"user_id": user_id})

    similar = []
    for node in existing:
        if node["embedding"]:
            sim = cosine_similarity(new_embedding, node["embedding"])
            if sim >= threshold:
                similar.append({
                    "id": node["id"],
                    "content": node["content"],
                    "confidence": node["confidence"],
                    "similarity": round(sim, 4)
                })

    return similar


def check_contradiction(new_fact: str, existing_fact: str) -> dict:
    response = client.messages.create(
        model="claude-sonnet-4-5",
        max_tokens=500,
        messages=[{
            "role": "user",
            "content": f"""Compare these two facts and determine if they contradict each other.

Fact A (existing memory): {existing_fact}
Fact B (new information): {new_fact}

Respond in JSON only:
{{
    "is_contradiction": true/false,
    "reasoning": "brief explanation",
    "winner": "A" or "B" or "neither",
    "confidence": 0.0 to 1.0
}}"""
        }]
    )

    raw = response.content[0].text.strip()
    if raw.startswith("```"):
        raw = raw.split("```")[1]
        if raw.startswith("json"):
            raw = raw[4:]

    return json.loads(raw)


def detect_contradictions(new_facts: list, user_id: str) -> list:
    contradictions = []

    for fact in new_facts:
        similar = find_similar_concepts(fact["content"], user_id)

        for existing in similar:
            result = check_contradiction(fact["content"], existing["content"])

            if result["is_contradiction"]:
                contradictions.append({
                    "new_fact": fact["content"],
                    "existing_fact": existing["content"],
                    "existing_id": existing["id"],
                    "reasoning": result["reasoning"],
                    "winner": result["winner"],
                    "confidence": result["confidence"]
                })

                # Flag losing node in Neo4j
                if result["winner"] == "B":
                    graph_client.run("""
                        MATCH (c:Concept {id: $id})
                        SET c.status = 'superseded', c.confidence = c.confidence * 0.5
                        """, {"id": existing["id"]})
                    print(f"⚠️ Contradiction found — existing fact superseded: {existing['content']}")

    return contradictions