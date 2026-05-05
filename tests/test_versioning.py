from backend.agents.orchestrator import chat
from backend.graph.versioning import get_node_history
from backend.graph.graph_client import graph_client

print("=== Testing Memory Versioning ===\n")

# Add a fact
print("1. Storing initial fact...")
chat("I work as a data scientist in Hyderabad")

# Contradict it (will trigger versioning)
print("\n2. Contradicting it...")
chat("Actually I work as a software engineer in Bangalore now")

# Find versioned nodes
print("\n3. Finding versioned nodes...")
versioned = graph_client.run("""
    MATCH (n)-[:EVOLVED_FROM]->(v:Version)
    RETURN n.id as node_id, n.content as content, count(v) as version_count
    LIMIT 5
""")

print("\nVersioned nodes:")
for v in versioned:
    print(f"  - Node: {v['content']}")
    print(f"    Versions: {v['version_count']}")
    
    # Get full history
    history = get_node_history(v['node_id'])
    for h in history:
        print(f"    History: {h['change_reason']} at {h['versioned_at']}")

print("\n=== Done ===")