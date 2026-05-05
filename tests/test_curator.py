from backend.agents.curator_agent import run_curator
import json

print("=== Running Curator Agent ===\n")

result = run_curator(user_id="default")

print("\n=== Curator Results ===")

print(json.dumps(result, indent=2))