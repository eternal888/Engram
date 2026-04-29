from backend.agents.orchestrator import chat

result = chat('What city do I live in?')
print('Response:', result['response'])
print()
print('Memories used:')
for m in result['memories_used']:
    print(f"  - [{m['type']}] {m['text']} (similarity: {m['similarity']})")