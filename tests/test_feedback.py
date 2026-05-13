from backend.graph.graph_client import graph_client
import json

result = graph_client.run("""
    MATCH (n) 
    WHERE n.user_id = 'default'
      AND n.confirmation_count IS NOT NULL
    RETURN labels(n)[0] as type, 
           coalesce(n.content, n.name, '') as text, 
           n.confidence as confidence,
           n.confirmation_count as confirmations,
           n.status as status
""")

print(f"Nodes with feedback: {len(result)}")
print(json.dumps(result, indent=2, default=str))