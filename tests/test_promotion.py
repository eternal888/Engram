from backend.core.promotion import promote_memories, decay_confidence, prune_stale

print("=== Running Memory Lifecycle ===\n")

print("1. Promoting memories...")
promote_memories(user_id="default")

print("\n2. Decaying confidence on stale nodes...")
decay_confidence(user_id="default")

print("\n3. Pruning low-confidence nodes...")
prune_stale(user_id="default")

print("\n=== Done ===")