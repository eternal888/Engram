"""
Timing breakdown for retrieval.
Isolates each step so we can see where time actually goes.
"""

import time
from backend.core.embeddings import embed_text
from backend.graph.graph_client import graph_client
from backend.agents.retrieval_agent import vector_search, graph_traversal, extract_query_entities

USER_ID = "2ac326c4-a3e9-4b9a-afbf-9701a1a520e1"  # test@engram.dev
QUERY = "what do I know about engrams?"

print("=== Retrieval timing breakdown ===\n")

# 1. OpenAI embedding call
t = time.perf_counter()
emb = embed_text(QUERY)
print(f"embed_text (OpenAI API)     : {int((time.perf_counter()-t)*1000)}ms")

# 2. Neo4j vector index query alone — SEARCH clause with in-index filtering
t = time.perf_counter()
rows = graph_client.run("""
    MATCH (node)
      SEARCH node IN (
        VECTOR INDEX memory_embeddings
        FOR $embedding
        WHERE node.user_id = $user_id
        LIMIT 8
      ) SCORE AS score
    RETURN node.id as id, score
    ORDER BY score DESC
""", {"embedding": emb, "user_id": USER_ID})
print(f"Neo4j SEARCH query          : {int((time.perf_counter()-t)*1000)}ms  ({len(rows)} rows)")

# 3. spaCy entity extraction
t = time.perf_counter()
ents = extract_query_entities(QUERY)
print(f"entity extraction           : {int((time.perf_counter()-t)*1000)}ms  {ents}")

# 4. Graph traversal (includes its own entity extraction)
t = time.perf_counter()
g = graph_traversal(QUERY, USER_ID)
print(f"graph_traversal (full)      : {int((time.perf_counter()-t)*1000)}ms  ({len(g)} hits)")

# 5. Full vector_search (embed + SEARCH)
t = time.perf_counter()
v = vector_search(QUERY, USER_ID, top_k=8)
print(f"vector_search (full)        : {int((time.perf_counter()-t)*1000)}ms  ({len(v)} hits)")