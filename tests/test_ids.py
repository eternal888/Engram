from backend.graph.graph_client import graph_client
import json

result = graph_client.run("""
    MATCH (n) 
    WHERE n.user_id = 'default' 
    RETURN labels(n)[0] as type, 
           n.id as id, 
           coalesce(n.content, n.name, n.summary, '') as text 
    LIMIT 10
""")

print(json.dumps(result, indent=2))