from datetime import datetime, timedelta
from backend.graph.graph_client import graph_client


def promote_memories(user_id: str = "default") -> dict:
    """
    Promotion rules:
    - working → short-term: 3+ accesses OR 24+ hours old
    - short-term → long-term: 10+ accesses OR confirmed by 2+ sources
    """
    promoted = {"to_short": 0, "to_long": 0}
    now = datetime.utcnow().isoformat()

    # Promote working → short-term
    result = graph_client.run("""
        MATCH (n)
        WHERE n.user_id = $user_id 
          AND n.ttl_tier = 'working'
          AND (
              coalesce(n.access_count, 0) >= 3
              OR datetime(n.created_at) < datetime() - duration({hours: 24})
          )
        SET n.ttl_tier = 'short-term', 
            n.promoted_at = $now
        RETURN count(n) as count
        """, {"user_id": user_id, "now": now})

    if result:
        promoted["to_short"] = result[0]["count"]

    # Promote short-term → long-term
    result = graph_client.run("""
        MATCH (n)
        WHERE n.user_id = $user_id 
          AND n.ttl_tier = 'short-term'
          AND (
              coalesce(n.access_count, 0) >= 10
              OR coalesce(n.confirmation_count, 0) >= 2
          )
        SET n.ttl_tier = 'long-term', 
            n.promoted_at = $now
        RETURN count(n) as count
        """, {"user_id": user_id, "now": now})

    if result:
        promoted["to_long"] = result[0]["count"]

    print(f"✅ Promoted: {promoted['to_short']} to short-term, {promoted['to_long']} to long-term")
    return promoted


def decay_confidence(user_id: str = "default") -> int:
    """
    Decay confidence on nodes that haven't been accessed recently.
    """
    result = graph_client.run("""
        MATCH (n)
        WHERE n.user_id = $user_id
          AND n.confidence > 0.1
          AND datetime(coalesce(n.last_accessed, n.created_at)) < datetime() - duration({days: 7})
        SET n.confidence = CASE n.ttl_tier
            WHEN 'working' THEN n.confidence * 0.7
            WHEN 'short-term' THEN n.confidence * 0.85
            WHEN 'long-term' THEN n.confidence * 0.95
            ELSE n.confidence * 0.8
        END
        RETURN count(n) as count
        """, {"user_id": user_id})

    count = result[0]["count"] if result else 0
    print(f"✅ Decayed {count} nodes")
    return count


def prune_stale(user_id: str = "default") -> int:
    """
    Delete working memory nodes with very low confidence.
    """
    result = graph_client.run("""
        MATCH (n)
        WHERE n.user_id = $user_id
          AND n.ttl_tier = 'working'
          AND n.confidence < 0.2
          AND coalesce(n.confirmation_count, 0) = 0
        DETACH DELETE n
        RETURN count(n) as count
        """, {"user_id": user_id})

    count = result[0]["count"] if result else 0
    print(f"✅ Pruned {count} stale nodes")
    return count