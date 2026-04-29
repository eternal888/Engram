from backend.agents.orchestrator import chat

result = chat('I moved to Mumbai last week')
print('Response:', result['response'])
print()
print('Memories used:', len(result['memories_used']))
print('Contradictions found:', len(result['contradictions']))
for c in result['contradictions']:
    print(f"  - {c['existing_fact']} → superseded by → {c['new_fact']}")