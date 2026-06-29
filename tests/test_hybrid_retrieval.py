from backend.agents.retrieval_agent import retrieve_memories
import json

print("=== Testing Hybrid Retrieval ===\n")

queries = [
    "what do I like to do",
    "tell me about chess",
    "where do I work",
]

for q in queries:
    print(f"\n🔍 Query: {q}")
    print("-" * 60)
    results = retrieve_memories(q, user_id="default", top_k=5)
    for r in results:
        sources = "+".join(r.get("sources", ["?"]))
        print(f"  [{sources:13}] {r['type']:8} score={r['score']:.3f} sim={r['similarity']:.3f}")
        print(f"                  {r['text'][:80]}")

print("\n=== Done ===")