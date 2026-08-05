# Decisions

Every meaningful design choice in Engram, what was rejected, and why.

This is the document to read before an interview, or before changing something and
wondering whether it was deliberate.

---

## Storage

### Neo4j for everything, not Neo4j + a vector store

**Chosen:** one Neo4j AuraDB instance holds memories, embeddings, users, and traces.

**Rejected:** Pinecone/Weaviate for vectors + Postgres for users + Neo4j for the graph.

**Why:** Neo4j has a native vector index. Splitting across three databases means three
sets of credentials, three failure modes, three consistency problems, and no way to
express "find memories similar to this query *that are also connected to this entity*"
in a single query. The moment retrieval became hybrid, the case for one database became
obvious.

**Trade-off:** Neo4j's vector index is less feature-rich than a dedicated vector DB —
no built-in reranking, fewer index tuning knobs, no hybrid BM25+vector out of the box.
Acceptable at this scale.

---

### Memory as a graph, not a flat vector list

**Chosen:** Episodes, Concepts, Entities connected by typed relationships.

**Rejected:** a table of `(text, embedding)` rows.

**Why:** relationships carry meaning that embeddings can't. "User works at Google" and
"Google is in Mountain View" are separate facts, but the connection between them lets
you answer "where does the user work, geographically?" A flat store would need both facts
to be semantically similar to the query, which they aren't.

This is also the honest answer to *"why not just use a vector database?"* — because you'd
lose graph traversal, and graph traversal finds memories vector search misses.

---

### Shared `:Memory` label instead of per-type vector indexes

**Chosen:** every embeddable node gets a second label, `:Memory`. One vector index over
that label.

**Rejected:** four separate indexes on `Concept`, `Episode`, `Entity`, `Source`, with
Python-side merging.

**Why:**

| | Four indexes | Shared label |
|---|---|---|
| New node type | new index + new query + new merge branch | tag it `:Memory`, done |
| Ranking | each index returns its own top-k, you re-sort in Python | true global top-k from Neo4j |
| Round-trips | four | one |
| Maintenance | four indexes to rebuild if the embedding model changes | one |

The merging problem is the real killer. With four indexes each returning 8 results, you
get 32 rows and re-rank them yourself — which is exactly the Python-side work the index
was supposed to eliminate.

**Cost of switching:** one Cypher backfill (`MATCH (n) WHERE n.embedding IS NOT NULL SET
n:Memory`) plus adding the label in the writers. Ten minutes.

---

### Contradiction node instead of a status flag

**Chosen:** when a conflict is resolved, create a `:Contradiction` node with
`winner_fact`, `loser_fact`, `reasoning`, `detected_at`, linked to the loser via
`CONTRADICTS`.

**Rejected:** just setting `status = 'superseded'` on the losing node.

**Why:** the flag tells you *that* something was superseded. The node tells you *what it
conflicted with, why, and when*. That's the difference between "this fact is stale" and
"this fact was replaced by that fact on this date because a person can only have one
favorite sport."

It also makes "show me every time my beliefs changed" a real query.

**Trade-off:** more nodes in the graph. Negligible — contradictions are rare.

---

## Retrieval

### Hybrid retrieval, both paths always

**Chosen:** run vector search and graph traversal unconditionally on every query, then
merge and rank.

**Rejected:** a tool-using retrieval agent where Claude decides which search strategy to
use per query.

**Why:** the "intelligent routing" version assumes running both is wasteful. It isn't —
cosine similarity in an index is cheap, graph traversal is one Cypher query. Meanwhile
routing costs an extra LLM call (~1–2s), adds a failure mode (Claude picks wrong), and
can't know in advance which strategy will surface the right memory.

Trust the ranker, not the router. Same principle as letting a database plan its own
queries instead of asking the user.

**This is a case where the simpler implementation is also the better one** — worth saying
out loud, because the original plan specified the tool-using version.

---

### Ranking formula: relevance 0.5, recency 0.2, trust 0.3

**Why these weights:**

- **Relevance dominates** — a perfectly relevant old memory beats a fresh irrelevant one.
- **Trust is second** — a confirmed fact should outrank an unconfirmed one at similar
  relevance. This is what makes the ✓/✗ feedback loop actually do something.
- **Recency is a tiebreaker** — between two equally relevant, equally trusted memories,
  prefer the newer one.

**The 1.15× cross-source boost:** if a memory was found by *both* vector similarity and
graph traversal, two independent signals agree. That's stronger evidence than either
alone.

These weights are unvalidated — they're reasoned, not measured. The eval harness (Week 11)
is what would let you tune them empirically.

---

### spaCy first, Claude as fallback for entity extraction

**Chosen:** two-tier. spaCy NER + noun chunks locally (~5ms). If that returns nothing,
fall back to Claude (~2.5s).

**Rejected (A):** Claude for every query — correct but slow, an LLM round-trip on every
message just to pull out names.

**Rejected (B):** spaCy only — fast but fails on vague references like "that place I
mentioned down south," where Claude can infer "Hyderabad" and spaCy finds nothing.

**Why the hybrid:** ~80% of queries contain explicit entities and hit the fast path. The
remaining 20% get full LLM reasoning. Zero accuracy loss versus Claude-only, most of the
speed of spaCy-only.

**Why noun chunks and not just NER:** spaCy's NER finds *named* entities — proper nouns.
But the graph stores common nouns as entities too: "chess", "engrams", "data scientist".
NER alone would miss all of those and constantly fall through to the slow path.

---

### LLM-based grounding, not embedding similarity

**Chosen:** Claude reads each claim and each memory and judges whether the memory
supports the claim.

**Rejected:** embed each claim, embed each memory, use cosine similarity above a
threshold as "grounded."

**Why:** similarity measures topical overlap, not entailment. Concrete failures:

| Memory | Claim | Cosine | Truth |
|---|---|---|---|
| "User does NOT like coffee" | "User likes coffee" | ~0.95 | opposite |
| "Ritish works at Google" | "Ritish works at Microsoft" | ~0.91 | wrong entity |
| "User ran 5 kilometers" | "User ran 50 kilometers" | ~0.94 | 10× off |
| "User lived in Hyderabad until 2024" | "User lives in Hyderabad" | ~0.93 | wrong tense |

Negation is the worst case — "not X" and "X" share nearly all their tokens.

Grounding is the differentiating feature of this project. Trading its correctness for
five seconds would be trading the product for the demo.

**Deferred improvement:** an embedding prefilter to narrow candidates before the LLM
judges, plus concurrent per-claim calls. Keeps the reasoning, cuts the latency ~4×.

---

## Pipeline

### Fast path / background split

**Chosen:** respond after grounding. Run extraction, contradiction detection, and memory
writing in the background via FastAPI `BackgroundTasks`.

**Rejected:** run all seven agents before responding.

**Why:** steps 5–7 produce nothing the user sees in that turn. Making them wait ~2s for
memory writing is pure loss.

**Trade-off, and it's real:** contradictions no longer appear in the response for the turn
that caused them. They're detected and stored seconds later, but the UI's red
"Contradictions detected" panel won't fire on that turn. Fixing that properly needs
streaming or polling.

---

### Grounding stays in the fast path

**Chosen:** grounding runs before responding, despite costing ~5.4s.

**Rejected:** background it too, and let the UI fetch citations later.

**Why:** the grounding badge and citations render directly under the answer. Showing an
answer with no trust signal, then having it appear a beat later, is worse UX than waiting.
And grounding is the feature — burying it undercuts the whole pitch.

---

### PII scrubbed at ingress, not at write time

**Chosen:** scrub in the orchestrator (step 0) and in the ingestion pipeline (step 1),
before anything downstream sees the text.

**Rejected:** scrub in `memory_writer` just before the Cypher `CREATE`.

**Why:** if you scrub at write time, raw PII has already passed through retrieval,
embedding generation, and the Claude prompt. It's in OpenAI's logs, in Anthropic's logs,
possibly in your own application logs. Scrubbing at the gate means raw PII never exists
anywhere but in-memory for one function call.

**Trade-off:** Claude sees `[PERSON]` and `[EMAIL_ADDRESS]` placeholders instead of real
values, so responses are slightly less specific. The system prompt tells it to respond
naturally around placeholders and never fabricate values. Correct trade for a system
handling personal data.

---

## Auth and security

### JWT, not sessions

**Chosen:** stateless JWT signed HS256, 7-day expiry, stored in `localStorage`.

**Rejected:** server-side sessions in Redis or a database table.

**Why:** stateless means no session store to run, no session lookup per request, and it
survives a server restart. For a single-server app with no need for instant revocation,
this is the simpler correct choice.

**Trade-off:** you can't revoke a JWT before it expires. Logging out clears the client's
copy but the token would still validate if someone had it. Mitigated by the 7-day window;
a real fix would be a revocation list, which reintroduces state.

**`localStorage` vs `httpOnly` cookie:** localStorage is vulnerable to XSS. A cookie is
vulnerable to CSRF. Given a React SPA with no server-rendered forms, XSS is the smaller
surface here, and localStorage avoids CORS credential complexity. Worth revisiting before
a real production launch.

---

### user_id from the token, never from the request

**Chosen:** every protected endpoint takes `user_id: str = Depends(get_current_user)`.
The value is decoded from the JWT signature.

**Rejected:** `user_id` as a query param or body field.

**Why:** if the client supplies `user_id`, anyone can type someone else's. The earlier
version of the API did exactly this — `GET /api/memory/graph?user_id=alice` returned
Alice's data to whoever asked. Extracting from the signed token makes impersonation
cryptographically impossible.

---

### Same 404 for "not found" and "not yours"

**Chosen:** `_assert_owns` raises `404 Node not found` in both cases.

**Rejected:** `404` for missing, `403` for wrong owner.

**Why:** different responses leak information. An attacker probing UUIDs would learn which
ones are real:

```
node_id=AAAA → 404   (doesn't exist)
node_id=BBBB → 403   (exists, belongs to someone else)  ← now they know
```

Identical responses reveal nothing. This is standard practice for avoiding enumeration
oracles.

---

### Defense in depth on mutations

**Chosen:** both an explicit `_assert_owns()` check *and* `user_id` in the Cypher MATCH:

```cypher
MATCH (n {id: $id, user_id: $user_id})
SET n.confidence = ...
```

**Why:** two independent layers. If someone later refactors and drops the ownership check,
the query itself still matches nothing for a cross-user id. Neither layer is load-bearing
alone.

---

## Ingestion

### 300-word chunks, 50-word overlap

**Why 300:** embeddings work best on focused semantic units. Too small and each chunk
lacks context; too large and the embedding averages across multiple topics into mush.
200–500 words is the usual sweet spot.

**Why overlap:** without it, a sentence spanning a boundary is split across two chunks and
neither carries the full idea:

```
chunk 1: "…the hippocampus consolidates short-term"
chunk 2: "memories into long-term storage…"
```

50 words of overlap means that sentence survives intact in at least one chunk.

---

### Chunks are `:Source` nodes, not `:Concept` nodes

**Why:** Concepts are extracted *facts*. Sources are raw *content*. Conflating them would
muddy the graph — you couldn't tell "the system inferred this" from "a document said
this."

---

### No entity extraction from document chunks

**Chosen:** ingest chunks as raw retrievable text. Don't run the extraction agent over
them.

**Why:** a 60-chunk PDF would mean 60 Claude calls at ingestion time. Expensive and slow,
for uncertain benefit — the chunk text itself works fine as retrieval context, which the
Wikipedia test confirmed.

**Revisit if:** users start asking questions that require reasoning *across* documents
rather than retrieval *from* them.

---

## Observability

### Traces in Neo4j, not Supabase or Postgres

**Chosen:** `TraceEvent` nodes in the same database.

**Rejected:** the original plan's Supabase table.

**Why:** one less service to run, one less set of credentials, and traces can link to the
episodes they produced. Free tier handles the volume easily.

**Trade-off:** Neo4j is worse than Postgres at time-series aggregation. At millions of
traces you'd want a proper time-series store. Revisit then.

---

### Context manager for tracing

**Chosen:** `with trace_agent(...) as event:` wrapping each agent call.

**Rejected:** manual try/except/finally around every call, or a decorator.

**Why not manual:** the same 10 lines around seven agents. Change how tracing works,
change it in seven places.

**Why not a decorator:** decorators wrap whole functions. Some agents need to record
information only available *inside* the call — token counts from Claude's response
object, for instance. The context manager yields a mutable dict the caller fills in.

---

### Observability never breaks the app

The Neo4j write inside `trace_agent` has its own try/except that swallows failures and
prints a warning:

```python
finally:
    try:
        graph_client.run("CREATE (t:TraceEvent {...})")
    except Exception as write_err:
        print(f"⚠️ Trace write failed: {write_err}")
```

**Why:** if Neo4j hiccups, the user's chat already succeeded. Returning a 500 because
logging failed would be absurd. Observability is a secondary concern and must behave like
one.

Note the contrast with the *outer* try/except, which re-raises. Agent failures propagate;
trace-write failures don't.

---

## Things deliberately not built

| Not built | Why |
|---|---|
| `:Agent` node type | Agents are static code with no state worth modeling. A `source_agent` string property carries the same information. |
| `contradiction_monitor.py` | It would watch for contradictions unresolved >48h. Resolution is synchronous, so that state never exists. |
| Tool-using retrieval agent | Unconditional hybrid is simpler, faster, and more complete. See above. |
| OpenTelemetry | Solves cross-service tracing. There is one service. |
| Alerting / thresholds | Requires baselines from real traffic. There is no traffic yet. |
| WebSocket streaming | SSE covers one-directional server→client streaming with far less machinery. Chat doesn't need bidirectional. |

The pattern: build what solves a problem you actually have. Defer what solves problems
you might have later. Skip what solves problems you'll never have.

---

## Known open issues

| Issue | Impact | Plan |
|---|---|---|
| Ranking weights unvalidated | May not be optimal | Eval harness, Week 11 |
| Contradictions don't surface live | UI misses them on the causing turn | Streaming or polling |
| No pytest suite | Manual test scripts only, nothing runs in CI | Week 13 |
| Grounding is ~5.4s | Second-biggest fast-path cost | Prefilter + concurrent calls |
| JWT can't be revoked | Compromised token valid until expiry | Revocation list if it matters |
| 5 UI panels unbuilt | NodeInspector, QualityDashboard, ContradictionViewer, AgentTraceViewer, EpisodeTimeline | Week 13, pick the highest-value two |
