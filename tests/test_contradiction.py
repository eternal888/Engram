from backend.agents.extraction_agent import extract_memory
from backend.graph.memory_writer import write_memory
from backend.agents.contradiction_agent import detect_contradictions

# First store a fact
result1 = extract_memory("I live in Hyderabad")
write_memory(result1)

# Now introduce a contradicting fact
result2 = extract_memory("I moved to Mumbai last week")
contradictions = detect_contradictions(
    result2["extracted"]["facts"],
    user_id="default"
)

if contradictions:
    for c in contradictions:
        print(f"Contradiction detected!")
        print(f"  Existing: {c['existing_fact']}")
        print(f"  New: {c['new_fact']}")
        print(f"  Winner: {c['winner']}")
        print(f"  Reasoning: {c['reasoning']}")
else:
    print("No contradictions found")