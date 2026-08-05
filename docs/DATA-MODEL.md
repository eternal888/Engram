# Data Model

Everything lives in one Neo4j database. No separate vector store, no separate relational
DB for users or traces.

---

## Node types

### `:Episode`
One conversation turn. The raw event.

```
id                 uuid
user_id            uuid — owner
summary            str  — Claude's one-line summary of the turn
embedding          list[float] × 1536
confidence         float 0–1
ttl_tier           'working' | 'short-term' | 'long-term'
created_at         iso8601
last_accessed      iso8601
consolidated       bool — has the consolidation agent processed this?
confirmation_count int  — how many times user confirmed via ✓
```

### `:Concept`
An extracted fact. The semantic layer.

```
id                 uuid
user_id            uuid
content            str  — "User's favorite color is blue"
embedding          list[float] × 1536
confidence         float 0–1
ttl_tier           str
status             null | 'superseded' | 'disputed' | 'edited'
is_consolidated    bool — created by the consolidation agent?
consolidation_score int — how many episodes contributed (if consolidated)
confirmation_count int
created_at, last_accessed, promoted_at
```

### `:Entity`
A named thing mentioned — person, place, object, concept.

```
id            uuid
user_id       uuid
name          str  — "Hyderabad", "chess", "data scientist"
description   str
embedding     list[float] × 1536
confidence    float
ttl_tier      str
created_at, last_accessed
```

### `:Source`
A chunk of an ingested document.

```
id               uuid
user_id          uuid
content          str  — ~300 words
embedding        list[float] × 1536
document_id      uuid — shared by all chunks of one upload
document_name    str  — "ml_notes.pdf" or the page title
document_source  'upload' | 'url'
source_url       str  — empty for uploads
chunk_index      int  — 0, 1, 2, …
total_chunks     int
word_count       int
confidence       float — 1.0 (documents are treated as reliable)
ttl_tier         'long-term'
created_at, last_accessed
```

### `:Contradiction`
Audit record of a resolved conflict. No embedding — it's metadata, not memory.

```
id            uuid
user_id       uuid
winner_fact   str  — the fact that survived
loser_fact    str  — the fact that was superseded
reasoning     str  — Claude's explanation
detected_at   iso8601
status        'resolved'
```

### `:Version`
Immutable snapshot of a node before it was mutated.

```
id                uuid
original_node_id  uuid
original_type     str  — the label of the node it snapshots
snapshot          str  — stringified dict of all properties at that moment
change_reason     str  — "superseded by contradiction: …", "user marked incorrect", …
versioned_at      iso8601
```

### `:User`
A registered account.

```
id             uuid — this is the user_id on every other node
email          str  — unique constraint
password_hash  str  — bcrypt
created_at     iso8601
```

### `:TraceEvent`
One agent execution. Observability.

```
id              uuid
trace_id        uuid — shared by all events in one chat turn
user_id         uuid
agent_name      str
latency_ms      int
tokens_input    int
tokens_output   int
status          'success' | 'error'
error_message   str  — truncated to 500 chars
input_summary   str  — truncated to 200 chars
output_summary  str  — truncated to 200 chars
created_at      iso8601
```

### `:Memory` — the shared label

Not a node type. A **second label** applied to every node that has an embedding:

```
(c:Concept:Memory)
(e:Episode:Memory)
(n:Entity:Memory)
(s:Source:Memory)
```

Neo4j vector indexes are per-label. Rather than maintain four indexes and merge results
in Python, everything embeddable carries `:Memory` and one index covers it all. Adding a
new embeddable node type later costs nothing — tag it `:Memory` and it's searchable.

Backfilled with:
```cypher
MATCH (n) WHERE n.embedding IS NOT NULL SET n:Memory
```

---

## Relationship types

| Type | From → To | Meaning |
|---|---|---|
| `MENTIONED_IN` | Entity → Episode | this entity appeared in this turn |
| `SUPPORTS` | Concept → Episode | this fact was derived from this turn |
| `CONTRADICTS` | Contradiction → Concept | audit link to the superseded fact |
| `EVOLVED_FROM` | any node → Version | this node's previous state |
| `CONSOLIDATED_FROM` | Concept → Episode | this concept was distilled from these episodes |
| `NEXT_CHUNK` | Source → Source | reading order within a document |

---

## Indexes and constraints

### Vector index

```cypher
CREATE VECTOR INDEX memory_embeddings IF NOT EXISTS
FOR (n:Memory)
ON n.embedding
WITH [n.user_id]
OPTIONS { indexConfig: {
  `vector.dimensions`: 1536,
  `vector.similarity_function`: 'cosine'
}}
```

Three things worth noting:

**`FOR (n:Memory)`** — the shared label, so one index covers Concept, Episode, Entity,
and Source.

**`WITH [n.user_id]`** — stores `user_id` inside the index so it can be filtered *during*
traversal, not after. Without this, the index returns the global top-k across all users
and you filter afterward — meaning you must over-fetch and rely on enough of the results
belonging to the right user. With it, filtering is exact and there's no waste.

**Backticks** — required because Cypher would otherwise read `vector.dimensions` as
"the `dimensions` property of `vector`".

Under the hood Neo4j builds an HNSW graph (see LEARNINGS.md). Search is approximate —
95–99% recall — which is the standard trade every vector store makes.

### Uniqueness constraints

```cypher
CREATE CONSTRAINT user_email_unique IF NOT EXISTS
FOR (u:User) REQUIRE u.email IS UNIQUE;

CREATE CONSTRAINT user_id_unique IF NOT EXISTS
FOR (u:User) REQUIRE u.id IS UNIQUE;
```

---

## Memory lifecycle

Every embeddable node moves through tiers over time.

```
        created
           │
        working ──── 3+ accesses OR 24h old ────▶ short-term
                                                       │
                              10+ accesses OR 2+ confirmations
                                                       │
                                                       ▼
                                                  long-term
```

**Decay** — after 7 days without access, confidence is multiplied:

| Tier | Multiplier | Reasoning |
|---|---|---|
| working | ×0.70 | recent, unconfirmed — fades fast |
| short-term | ×0.85 | some staying power |
| long-term | ×0.95 | established knowledge, barely fades |

**Pruning** — deletes only `working`-tier nodes with confidence < 0.2 and zero
confirmations. Short-term and long-term are never auto-deleted.

Implemented in `backend/core/promotion.py`, scheduled in `backend/core/scheduler.py`.

---

## Cypher notes and constraints

**`datetime().toString()` doesn't exist** in this Neo4j version. It parses as a syntax
error. Pass timestamps as Python-side ISO strings instead:

```python
now = datetime.utcnow().isoformat()
graph_client.run("SET n.last_accessed = $now", {"now": now})
```

**`db.index.vector.queryNodes()` is deprecated** as of Neo4j 2026.04, replaced by the
`SEARCH` clause. The old procedure also can't do in-index filtering — when you add a
`WHERE`, it falls back to brute force.

**A leading colon means "browser command"** in the Neo4j Query console. `:CREATE
CONSTRAINT …` fails with `UnknownCommandError` because `:use`, `:param`, `:clear` are
console directives. Drop the colon for actual Cypher.

**Neo4j returns one row per match, not per group.** `list_user_documents` returns one row
per chunk even though the intent is one row per document, so the Python side dedupes by
`document_id`.
