# Agents

Engram runs seven specialized agents. One orchestrator sequences the rest.

The word "agent" here means a module with a single responsibility that usually calls an
LLM. They aren't autonomous — the orchestrator decides the sequence, not the agents
themselves. That was a deliberate choice (see DECISIONS.md).

---

## 1. Orchestrator

**File:** `backend/agents/orchestrator.py`
**Runs:** every chat turn

Owns the pipeline order and — importantly — the split between what the
user waits for and what happens after.

**Fast path** (user is waiting):
```
pii_scrubber → retrieval → response_generation → grounding → RESPOND
```

**Background** (response already sent):
```
extraction → contradiction → memory_writer
```

**Why the split:** steps 5–7 produce no output the user sees in that turn. Making them
wait ~2 seconds for memory writing adds latency without benefit. `process_memory_background()` is
scheduled via FastAPI's `BackgroundTasks` from the route.

**Returns:**
```python
{
  "response":          str,     # Claude's answer
  "memories_used":     list,    # what retrieval found
  "grounding":         dict,    # citations, trust scores, ungrounded claims
  "pii_scrubbed":      bool,
  "pii_types":         list,
  "trace_id":          str,     # ties all TraceEvents for this turn
  "episode_id":        None,    # written asynchronously
  "contradictions":    [],      # detected asynchronously
  "memory_processing": "background",
}
```

**Known trade-off:** contradictions no longer appear in the response for the turn that
caused them, because detection happens after the response is sent. They're still recorded
in Neo4j seconds later. Surfacing them live would need streaming or polling.

---

## 2. Extraction Agent

**File:** `backend/agents/extraction_agent.py`
**Runs:** background, every turn

Turns unstructured text into graph-shaped data.

**Input:** the PII-scrubbed message
**Output:**
```json
{
  "entities":      [{"name": "...", "type": "person|place|thing", "description": "..."}],
  "facts":         [{"content": "...", "confidence": 0.0-1.0}],
  "relationships": [{"from": "...", "to": "...", "type": "..."}],
  "episode_summary": "..."
}
```

**Implementation notes:**
- Claude is prompted for strict JSON. It sometimes wraps output in ```` ```json ```` fences,
  so the parser strips them before `json.loads`.
- Every extracted fact becomes a `Concept` node; every entity becomes an `Entity` node;
  the summary becomes an `Episode` node.

---

## 3. Retrieval Agent

**File:** `backend/agents/retrieval_agent.py`
**Runs:** fast path, every turn

The most heavily engineered agent. Finds relevant memories using two complementary
strategies, then merges them.

### Vector search — "what *means* something similar?"

```python
query_embedding = embed_text(query)          # OpenAI, ~300-500ms

MATCH (node)
  SEARCH node IN (
    VECTOR INDEX memory_embeddings
    FOR $embedding
    WHERE node.user_id = $user_id            # filtered INSIDE the index
    LIMIT $top_k
  ) SCORE AS score
```

Neo4j's HNSW index does the similarity math server-side. Only the winning rows cross the
network — no embeddings. `user_id` is stored in the index as a filterable property, so
filtering happens during traversal rather than after.

### Graph traversal — "what's *connected* to what was mentioned?"

Two-tier entity extraction:

```python
# Tier 1 — spaCy, ~5ms, local
doc = _nlp(query)
entities   = [ent for ent in doc.ents if ent.label_ in USEFUL_LABELS]
noun_chunks = [chunk for chunk in doc.noun_chunks if ...]   # catches "chess", "engrams"

if found:
    return them

# Tier 2 — Claude, ~2.5s, only when spaCy finds nothing
# Handles vague references: "that place I mentioned down south"
```

Then walk the graph:

```cypher
MATCH (anchor) WHERE anchor.name/content CONTAINS any entity
MATCH (anchor)-[*1..2]-(connected)
RETURN DISTINCT connected LIMIT 20
```

**Why noun chunks matter:** spaCy's NER only finds *named* entities (proper nouns like
"Hyderabad"). But the graph also stores common nouns as Entity nodes — "chess",
"engrams", "data scientist". Noun-chunk extraction catches those. Without it, most
queries would fall through to the slow Claude path.

### Hybrid ranking

```python
score = relevance·0.5 + recency·0.2 + trust·0.3
if found_by_both_vector_and_graph:
    score *= 1.15
```

- **relevance** — cosine similarity (vector) or 0.7 baseline (graph)
- **recency** — `1 - age_days/30`, floors at 0
- **trust** — `confidence × (1 + 0.05 × confirmation_count)`, caps at 1.0

The 1.15× cross-source boost encodes: if two independent strategies both surfaced this
memory, that's stronger evidence than either alone.

**Why hybrid at all:** vector search finds semantically similar text. Graph traversal
finds structurally connected memories that may share no vocabulary with the query. Neither
subsumes the other. This is also the answer to *"why a graph database instead of just a
vector store?"*

---

## 4. Grounding Agent

**File:** `backend/agents/grounding_agent.py`
**Runs:** fast path, every turn

The trust layer. Takes Claude's draft answer plus the retrieved memories, and checks
whether each claim is actually supported.

**Output:**
```json
{
  "grounded_response": "...",
  "citations": [
    {"claim": "...", "memory": {...}, "trust_score": 0.0-1.0}
  ],
  "grounding_score": 0.0-1.0,
  "ungrounded_claims": ["..."],
  "is_grounded": true|false
}
```

`grounding_score` is the fraction of claims that map to a real memory. The UI shows it
per response with a color: green ≥ 0.8, amber ≥ 0.5, red below.

**Why an LLM and not embedding similarity:** similarity can't handle negation. "User does
NOT like coffee" and "User likes coffee" have ~0.95 cosine similarity — nearly identical
wording, opposite meaning. Same problem with entity swaps (Google vs Microsoft), numbers
(5km vs 50km), and tense. Claude reasons about entailment, which is what the feature requires.

---

## 5. Contradiction Agent

**File:** `backend/agents/contradiction_agent.py`
**Runs:** background, every turn

Detects when new information conflicts with existing memory, and records the conflict.

**How it works:**
1. Embed each new fact, find existing `Concept` nodes above 0.3 cosine similarity
2. For each candidate pair, ask Claude: contradiction? which wins? reasoning?
3. If the new fact wins:
   - Version the loser (`EVOLVED_FROM` snapshot)
   - Set loser `status='superseded'`, halve its confidence
   - Create a `Contradiction` node with `winner_fact`, `loser_fact`, `reasoning`,
     `detected_at`, linked to the loser via `CONTRADICTS`

**Why a Contradiction node instead of just a status flag:** the flag tells you *that*
something was superseded. The node tells you *what it conflicted with, why, and when*.
That's a real audit trail — you can answer "show me every time my beliefs changed."

**Example:** you say "my favorite sport is cricket", later "actually football". The
cricket concept is versioned, marked superseded, confidence halved. A Contradiction node
records both facts and Claude's reasoning: *"A person can only have one favorite sport
at a time."*

---

## 6. Curator Agent

**File:** `backend/agents/curator_agent.py`
**Runs:** scheduled, every 24h

Scheduled graph maintenance. Runs unattended.

**Duplicate merging** — finds `Concept` pairs above 0.92 cosine similarity, asks Claude
to confirm they're truly duplicates, then merges: keeps the higher-confidence node,
boosts its confidence +0.1 and confirmation count +1, versions and deletes the other.

**Orphan detection** — nodes with no relationships at all.

**Health report:**
```json
{
  "total_nodes": 87,
  "total_edges": 94,
  "avg_confidence": 0.915,
  "tier_distribution": {"working": 14, "short_term": 30, "long_term": 43},
  "superseded_count": 6,
  "orphan_count": 3,
  "health_score": 0.91
}
```

`health_score = avg_confidence·0.5 + (1 − orphan_ratio)·0.3 + (1 − superseded_ratio)·0.2`

**The 0.92 threshold:** deliberately high. "User lives in Hyderabad" and "User resides in
Hyderabad" ≈ 0.94 → merge. "User lives in Hyderabad" and "User works in Hyderabad" ≈ 0.88
→ don't merge, they're different facts. Merging too aggressively destroys real
distinctions.

---

## 7. Consolidation Agent

**File:** `backend/agents/consolidation_agent.py`
**Runs:** scheduled, every 24h

Compresses many episodes into fewer, higher-level concepts — modeled on the way human
memory consolidates during sleep.

**How it works:**
1. Read up to 20 episodes where `consolidated = false`
2. Ask Claude to find recurring themes across them (2+ episodes minimum)
3. For themes with confidence ≥ 0.6, create a `Concept` node with:
   - `is_consolidated: true`
   - `consolidation_score`: how many episodes contributed
   - `ttl_tier: 'long-term'` (consolidated knowledge is durable by definition)
   - `CONSOLIDATED_FROM` edges to every source episode
4. Mark those episodes `consolidated = true` so they're never reprocessed

**Real output from a run over 16 episodes:**
- "Career and occupation as software/data professional"
- "Hyderabad as a significant location (residence/work)"
- "Recent relocation or geographic movement"
- "Personal preferences and interests being shared"

None of those were stated. They were inferred from patterns across many turns. That's
episodic → semantic memory.

---

## Observability

Every agent call is wrapped:

```python
with trace_agent(trace_id, user_id, "grounding") as event:
    grounding = ground_response(answer, memories)
    event["output_summary"] = f"score={grounding['grounding_score']}"
```

Writes a `TraceEvent` node with `agent_name`, `latency_ms`, `tokens_input`,
`tokens_output`, `status`, `error_message`. All events in one turn share a `trace_id`.

Queryable at `/api/traces`, `/api/traces/stats`, `/api/traces/{id}`, and visible in the
frontend trace panel.

---

## Typical latencies

Measured on a warm connection, one user, ~90 nodes:

| Agent | Latency | Path | Notes |
|---|---|---|---|
| pii_scrubber | ~30–175ms | fast | local, no network |
| retrieval | ~0.3–2.3s | fast | mostly the OpenAI embedding call |
| response_generation | ~5.5s | fast | Claude |
| grounding | ~5.4s | fast | Claude |
| extraction | ~1.5s | background | Claude |
| contradiction | 0–2.4s | background | 0ms when nothing conflicts |
| memory_writer | ~0.4–1.2s | background | Neo4j writes + embeddings |

**Fast path total: ~13s.** The two Claude calls are ~82% of it — which is why streaming
is the next meaningful optimization.
