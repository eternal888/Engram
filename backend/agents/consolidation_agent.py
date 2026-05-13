import anthropic
import json
import uuid
from datetime import datetime
from backend.core.config import ANTHROPIC_API_KEY
from backend.graph.graph_client import graph_client
from backend.core.embeddings import embed_text

client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)


def get_unconsolidated_episodes(user_id: str, limit: int = 20) -> list:
    """Get recent episodes not yet consolidated."""
    return graph_client.run("""
        MATCH (e:Episode)
        WHERE e.user_id = $user_id 
          AND coalesce(e.consolidated, false) = false
        RETURN e.id as id, e.summary as summary, e.raw_text as raw_text, e.created_at as created_at
        ORDER BY e.created_at DESC
        LIMIT $limit
        """, {"user_id": user_id, "limit": limit})


def extract_themes(episodes: list) -> list:
    """Use Claude to find recurring themes across episodes."""
    if len(episodes) < 3:
        print("⚠️ Need at least 3 episodes to consolidate")
        return []

    episode_text = "\n".join([
        f"[{i+1}] {ep['summary']}"
        for i, ep in enumerate(episodes)
    ])

    prompt = f"""You are a memory consolidation agent. Analyze these episodes and identify recurring themes or patterns.

Episodes:
{episode_text}

Return ONLY valid JSON:
{{
    "themes": [
        {{
            "theme": "high-level concept describing the pattern",
            "supporting_episodes": [1, 3, 5],
            "confidence": 0.0 to 1.0
        }}
    ]
}}

Rules:
- Only identify themes that appear in 2+ episodes
- Themes should be more general than individual facts
- Examples of good themes: "User has strong interest in chess", "User frequently discusses career changes"
- confidence based on how many episodes support the theme"""

    response = client.messages.create(
        model="claude-sonnet-4-5",
        max_tokens=1500,
        messages=[{"role": "user", "content": prompt}]
    )

    raw = response.content[0].text.strip()
    if raw.startswith("```"):
        raw = raw.split("```")[1]
        if raw.startswith("json"):
            raw = raw[4:]

    parsed = json.loads(raw)
    return parsed.get("themes", [])


def write_consolidated_concept(theme: dict, episodes: list, user_id: str) -> str:
    """Write a new Concept node from a theme, linked to source episodes."""
    concept_id = str(uuid.uuid4())
    now = datetime.utcnow().isoformat()
    embedding = embed_text(theme["theme"])

    # Get IDs of supporting episodes
    supporting_ids = [
        episodes[idx - 1]["id"]
        for idx in theme["supporting_episodes"]
        if 0 < idx <= len(episodes)
    ]

    # Create the consolidated concept
    graph_client.run("""
        CREATE (c:Concept {
            id: $id,
            content: $content,
            user_id: $user_id,
            confidence: $confidence,
            embedding: $embedding,
            ttl_tier: 'long-term',
            consolidation_score: $consolidation_score,
            is_consolidated: true,
            created_at: $created_at,
            last_accessed: $created_at
        })
        """, {
        "id": concept_id,
        "content": theme["theme"],
        "user_id": user_id,
        "confidence": theme["confidence"],
        "embedding": embedding,
        "consolidation_score": len(supporting_ids),
        "created_at": now
    })

    # Link to source episodes
    for ep_id in supporting_ids:
        graph_client.run("""
            MATCH (c:Concept {id: $concept_id})
            MATCH (e:Episode {id: $ep_id})
            MERGE (c)-[:CONSOLIDATED_FROM]->(e)
            """, {"concept_id": concept_id, "ep_id": ep_id})

    return concept_id


def mark_consolidated(episode_ids: list):
    """Mark episodes as consolidated so we don't re-process them."""
    graph_client.run("""
        UNWIND $ids as ep_id
        MATCH (e:Episode {id: ep_id})
        SET e.consolidated = true
        """, {"ids": episode_ids})


def run_consolidation(user_id: str = "default") -> dict:
    """Full consolidation run."""
    print("🧠 Running Consolidation Agent...")

    episodes = get_unconsolidated_episodes(user_id)
    print(f"  Found {len(episodes)} unconsolidated episodes")

    if len(episodes) < 3:
        return {"themes_created": 0, "episodes_processed": 0}

    themes = extract_themes(episodes)
    print(f"  Extracted {len(themes)} themes")

    created = 0
    for theme in themes:
        if theme["confidence"] >= 0.6:
            concept_id = write_consolidated_concept(theme, episodes, user_id)
            print(f"  ✅ Created concept: {theme['theme'][:60]}")
            created += 1

    # Mark all processed episodes as consolidated
    mark_consolidated([ep["id"] for ep in episodes])

    return {
        "themes_created": created,
        "episodes_processed": len(episodes)
    }