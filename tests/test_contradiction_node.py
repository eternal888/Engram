from backend.agents.orchestrator import chat
from backend.graph.graph_client import graph_client
import json

print("=== Testing Contradiction Node Creation ===\n")

# Trigger a contradiction
print("1. Storing initial fact...")
chat("My favorite sport is cricket")

print("\n2. Contradicting it...")
chat("Actually my favorite sport is football")

# Check that Contradiction node was created
print("\n3. Querying Contradiction nodes...")
result = graph_client.run("""
    MATCH (con:Contradiction)-[:CONTRADICTS]->(loser)
    RETURN con.id as id,
           con.winner_fact as winner,
           con.loser_fact as loser,
           con.reasoning as reasoning,
           con.detected_at as detected_at,
           loser.content as loser_content,
           loser.status as loser_status
    ORDER BY con.detected_at DESC
    LIMIT 5
""")

print(f"\nFound {len(result)} Contradiction nodes:")
print(json.dumps(result, indent=2, default=str))