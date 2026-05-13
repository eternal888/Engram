from backend.agents.consolidation_agent import run_consolidation
import json

print("=== Running Consolidation Agent ===\n")

result = run_consolidation(user_id="default")

print("\n=== Result ===")
print(json.dumps(result, indent=2))