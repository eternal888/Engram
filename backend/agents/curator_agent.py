import anthropic
import json
from backend.core.config import ANTHROPIC_API_KEY
from backend.graph.graph_client import graph_client
from backend.graph.versioning import version_node
import numpy as np

client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)


def cosine_similarity(vec1, vec2):
    a = np.array(vec1)
    b = np.array(vec2)
    return float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b)))


def find_duplicates(user_id: str = "default", threshold: float = 0.92) -> list:
    """
    Find Concept nodes that are near-duplicates by embedding similarity.
    """
    nodes = graph_client.run("""
        MATCH (c:Concept)
        WHERE c.user_id = $user_id 
          AND c.embedding IS NOT NULL
          AND coalesce(c.status, 'active') = 'active'
        RETURN c.id as id, c.content as content, c.embedding as embedding, c.confidence as confidence
        """, {"user_id": user_id})

    duplicates = []
    for i, n1 in enumerate(nodes):
        for n2 in nodes[i+1:]:
            sim = cosine_similarity(n1["embedding"], n2["embedding"])
            if sim >= threshold:
                duplicates.append({
                    "node1": {"id": n1["id"], "content": n1["content"], "confidence": n1["confidence"]},
                    "node2": {"id": n2["id"], "content": n2["content"], "confidence": n2["confidence"]},
                    "similarity": round(sim, 4)
                })

    return duplicates


def merge_duplicates(duplicates: list) -> int:
    """
    Use Claude to confirm merges, then merge the lower-confidence node into the higher.
    """
    merged_count = 0

    for dup in duplicates:
        prompt = f"""Are these two facts essentially the same information?

Fact A: {dup['node1']['content']}
Fact B: {dup['node2']['content']}

Respond JSON only:
{{"is_duplicate": true/false, "reasoning": "..."}}"""

        response = client.messages.create(
            model="claude-sonnet-4-5",
            max_tokens=300,
            messages=[{"role": "user", "content": prompt}]
        )

        raw = response.content[0].text.strip()
        if raw.startswith("```"):
            raw = raw.split("```")[1]
            if raw.startswith("json"):
                raw = raw[4:]

        try:
            result = json.loads(raw)
        except:
            continue

        if result.get("is_duplicate"):
            # Keep node with higher confidence, merge other into it
            if dup['node1']['confidence'] >= dup['node2']['confidence']:
                keeper = dup['node1']['id']
                loser = dup['node2']['id']
            else:
                keeper = dup['node2']['id']
                loser = dup['node1']['id']

            # Version the loser before deletion
            version_node(loser, change_reason=f"merged into {keeper}")

            # Boost keeper confidence
            graph_client.run("""
                MATCH (k {id: $keeper})
                SET k.confidence = CASE 
                    WHEN k.confidence + 0.1 > 1.0 THEN 1.0 
                    ELSE k.confidence + 0.1 
                END,
                k.confirmation_count = coalesce(k.confirmation_count, 0) + 1
                """, {"keeper": keeper})

            # Delete loser (versioning preserved its history)
            graph_client.run("""
                MATCH (l {id: $loser})
                DETACH DELETE l
                """, {"loser": loser})

            merged_count += 1
            print(f"✅ Merged duplicate: {dup['node2']['content'][:50]} into {dup['node1']['content'][:50]}")

    return merged_count


def find_orphans(user_id: str = "default") -> list:
    """
    Find nodes with no relationships — disconnected from the graph.
    """
    result = graph_client.run("""
        MATCH (n)
        WHERE n.user_id = $user_id
          AND NOT (n)--()
        RETURN n.id as id, labels(n)[0] as type, 
               coalesce(n.content, n.name, '') as content
        """, {"user_id": user_id})
    return result


def graph_health_report(user_id: str = "default") -> dict:
    """
    Generate a full health report for the user's memory graph.
    """
    stats = graph_client.run("""
        MATCH (n)
        WHERE n.user_id = $user_id
        RETURN 
            count(n) as total_nodes,
            avg(n.confidence) as avg_confidence,
            count(CASE WHEN n.ttl_tier = 'working' THEN 1 END) as working,
            count(CASE WHEN n.ttl_tier = 'short-term' THEN 1 END) as short_term,
            count(CASE WHEN n.ttl_tier = 'long-term' THEN 1 END) as long_term,
            count(CASE WHEN n.status = 'superseded' THEN 1 END) as superseded
        """, {"user_id": user_id})

    edge_count = graph_client.run("""
        MATCH (a)-[r]->(b)
        WHERE a.user_id = $user_id AND b.user_id = $user_id
        RETURN count(r) as edges
        """, {"user_id": user_id})

    orphans = find_orphans(user_id)

    s = stats[0] if stats else {}
    return {
        "total_nodes": s.get("total_nodes", 0),
        "total_edges": edge_count[0]["edges"] if edge_count else 0,
        "avg_confidence": round(s.get("avg_confidence") or 0, 3),
        "tier_distribution": {
            "working": s.get("working", 0),
            "short_term": s.get("short_term", 0),
            "long_term": s.get("long_term", 0)
        },
        "superseded_count": s.get("superseded", 0),
        "orphan_count": len(orphans),
        "health_score": round(
            (s.get("avg_confidence") or 0) * 0.5 +
            (1 - len(orphans) / max(s.get("total_nodes", 1), 1)) * 0.3 +
            (1 - s.get("superseded", 0) / max(s.get("total_nodes", 1), 1)) * 0.2,
            3
        )
    }


def run_curator(user_id: str = "default") -> dict:
    """
    Full curator run: find duplicates, merge, generate health report.
    """
    print("🔧 Running Curator Agent...")

    duplicates = find_duplicates(user_id)
    print(f"  Found {len(duplicates)} potential duplicates")

    merged = merge_duplicates(duplicates) if duplicates else 0

    report = graph_health_report(user_id)

    return {
        "duplicates_found": len(duplicates),
        "merged_count": merged,
        "health_report": report
    }