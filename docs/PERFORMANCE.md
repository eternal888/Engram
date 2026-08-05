# Performance

The optimization work, including the parts where the obvious hypothesis was wrong.

---

## How the problem surfaced

The observability layer was built to answer "what are the agents doing?" It answered a
different question first: **a chat turn was taking 24 seconds.**

That number had been felt but never measured. `GET /api/traces/stats` made it concrete:

```
response_generation   9,024ms   ← Claude
grounding             6,896ms   ← Claude
retrieval             2,812ms   ← Claude (entity extraction)
extraction            2,584ms   ← Claude
contradiction         1,515ms   ← Claude
memory_writer         1,099ms   ← Neo4j + embeddings
pii_scrubber             28ms   ← local
────────────────────────────────
TOTAL                ~24,000ms
```

**First real insight:** `pii_scrubber` at 28ms is ~300× faster than the Claude calls.
Local computation is effectively free. Network round-trips to LLMs are the entire cost.

Five sequential Claude calls per turn, each waiting on the previous.

---

## Optimization 1 — background memory processing

**Change:** respond after grounding. Move extraction, contradiction, and memory_writer to
FastAPI `BackgroundTasks`.

**Reasoning:** those three produce nothing the user sees in that turn. Their ~5 seconds
is pure waiting.

```python
# orchestrator returns early, hands the route what it needs
return {..., "_safe_message": safe_message, "trace_id": trace_id}

# route schedules the rest
background_tasks.add_task(process_memory_background, safe_message, user_id, trace_id)
return result
```

**Result:** ~24s → ~19s perceived. No quality loss.

**Cost:** contradictions no longer appear in the response for the turn that caused them.

---

## Optimization 2 — spaCy entity extraction

**Hypothesis:** retrieval's 2.8s was mostly the Claude call inside `graph_traversal` that
extracts entity names from the query.

**Change:** spaCy NER + noun chunks locally (~5ms), Claude only when spaCy finds nothing.

```python
if _nlp is not None:
    doc = _nlp(query)
    entities    = [ent.text for ent in doc.ents if ent.label_ in USEFUL_LABELS]
    noun_chunks = [c.text for c in doc.noun_chunks if c.root.pos_ in {"NOUN","PROPN"}]
    combined = list(dict.fromkeys(entities + noun_chunks))
    if combined:
        return combined[:5]          # ~5ms
return _extract_entities_with_claude(query)   # ~2.5s, only when needed
```

**Result:** entity extraction 2,500ms → 5ms.

**But retrieval overall barely moved** — 3,194ms average, essentially unchanged.

**The hypothesis was wrong.** Entity extraction was real but wasn't the dominant cost.

---

## Optimization 3 — the actual bottleneck

Rather than theorize again, the individual steps inside retrieval were timed directly
(`tests/test_retrieval_timing.py`):

```
embed_text (OpenAI API)     : 1111ms
Neo4j vector index query    :  782ms
entity extraction (spaCy)   :    4ms
graph_traversal (full)      :  186ms
vector_search (full)        :  905ms
```

The real cost was in `vector_search`, and specifically in what it asked Neo4j for:

```python
nodes = graph_client.run("""
    MATCH (n) WHERE n.user_id = $user_id AND n.embedding IS NOT NULL
    RETURN ..., n.embedding as embedding      ← every embedding, over the network
""")
for node in nodes:
    sim = cosine_similarity(query_embedding, node["embedding"])   ← loop in Python
```

**87 nodes × 1536 floats = ~134,000 numbers crossing the wire per query.** Then a Python
loop over all of them.

Worse than slow — it's **O(n)**:

| Nodes | Floats transferred | Rough time |
|---|---|---|
| 100 | 153,600 | ~2s |
| 1,000 | 1.5M | ~15s |
| 10,000 | 15M | ~2min |
| 100,000 | 150M | unusable |

Every memory a user adds makes every future query slower. For a product whose premise is
*memory that accumulates*, that's a design flaw, not a latency annoyance.

### The fix

**Step 1** — tag every embeddable node with a shared label:
```cypher
MATCH (n) WHERE n.embedding IS NOT NULL SET n:Memory     // 87 nodes
```

**Step 2** — create a vector index with `user_id` as a filterable property:
```cypher
CREATE VECTOR INDEX memory_embeddings IF NOT EXISTS
FOR (n:Memory) ON n.embedding
WITH [n.user_id]
OPTIONS { indexConfig: {
  `vector.dimensions`: 1536,
  `vector.similarity_function`: 'cosine'
}}
```

**Step 3** — query the index instead of scanning:
```cypher
MATCH (node)
  SEARCH node IN (
    VECTOR INDEX memory_embeddings
    FOR $embedding
    WHERE node.user_id = $user_id
    LIMIT $top_k
  ) SCORE AS score
RETURN ..., score ORDER BY score DESC
```

**Result:** `vector_search` (embedding call *and* Neo4j query) → **315ms**.

Neo4j's portion went from ~1200ms to roughly 100ms. What remains is almost entirely the
OpenAI embedding round-trip.

More importantly: **O(n) → O(log n)**. At 100k memories it stays ~300ms instead of
breaking.

### Why `WITH [n.user_id]` matters

Without it, the index returns the global top-k across *all* users, then you filter:

```
300 memories, 3 users. Ask for top 8.
Index returns 8 best overall: 5 Alice's, 2 Bob's, 1 yours.
Filter by user → you get 1 result.
```

Which is why the first version needed `fetch_k = top_k * 4` — over-fetch and hope. With
`user_id` in the index, filtering happens *during* traversal. Ask for 8, get 8, all yours.

---

## Results

**Per-agent, before → after:**

| Agent | Before | After | How |
|---|---|---|---|
| pii_scrubber | 28ms | ~30–175ms | unchanged |
| retrieval | 2,812ms | ~315ms–2.3s | vector index + spaCy |
| response_generation | 9,024ms | ~5,500ms | unchanged (variance) |
| grounding | 6,896ms | ~5,400ms | unchanged (variance) |
| extraction | 2,584ms | ~1,500ms | moved to background |
| contradiction | 1,515ms | 0–2,400ms | background; 0ms when nothing conflicts |
| memory_writer | 1,099ms | ~388ms | background |

**End to end, measured in the UI trace panel:**

```
before:  35.5s   7 agents
after:   13.4s   4 agents (fast path only)
```

The **4 agents** is the visible proof of the background split — the other three ran after
the response was already sent.

---

## What's left

```
pii_scrubber           175ms
retrieval              2.3s   ← mostly the OpenAI embedding call
response_generation    5.5s   ← Claude
grounding              5.4s   ← Claude
──────────────────────────────
                      13.4s
```

**The two Claude calls are ~82% of the wait.**

### Streaming (the big one)

Right now the user stares at "thinking…" for 5.5 seconds, then the full answer appears at
once. With SSE streaming, tokens arrive as Claude generates them — text starts appearing
in ~1s and the user reads while the rest generates.

Total time unchanged. **Perceived latency 13.4s → ~2s.** Nothing else on this list comes
close.

### Concurrent grounding with prefilter

Grounding is one large Claude call verifying every claim against every memory. Instead:

1. Embed each claim, use similarity to find its top-2 candidate memories (local, ~50ms)
2. Fire N small Claude calls in parallel via `asyncio.gather` — one per claim
3. Assemble

Small prompts, run concurrently. **~5.4s → ~1.5s**, with the reasoning fully preserved.

### Embedding cache

Repeated or near-identical queries re-embed from scratch. An LRU cache keyed on the query
string would make repeats free. Small win, easy.

---

## Lessons

**1. Measure before optimizing.** Two hypotheses in a row were confidently wrong — first
that entity extraction was the bottleneck, then that the vector index alone would fix
retrieval. Only step-by-step timing found the real cost.

**2. Averages hide things.** `traces/stats` pools all calls together. After a change, the
average is dominated by old slow calls and looks like nothing improved. Query individual
recent calls instead:
```cypher
MATCH (t:TraceEvent {agent_name: 'retrieval'})
RETURN t.latency_ms, t.created_at ORDER BY t.created_at DESC LIMIT 5
```

**3. Perceived latency ≠ total work.** Background processing didn't make anything faster.
It moved work to where nobody's waiting. Streaming will do the same, more dramatically.

**4. Complexity class matters more than constant factors.** The vector index was worth
doing not for 2.8s → 0.3s, but for O(n) → O(log n). One is a nice improvement; the other
is the difference between a product that scales and one that doesn't.

**5. Watch for cold starts when benchmarking.** First `embed_text` call: 1111ms. Same call
warm: ~300ms. First Neo4j query after idle: 1780ms. Warm: ~100ms. Benchmark warm, because
that's what production looks like.
