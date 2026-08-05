# Learnings

Concepts used in Engram, explained from first principles. Written so future-you can
re-learn without re-deriving.

---

## Embeddings

An embedding is a piece of text turned into a list of numbers — 1536 of them for OpenAI's
`text-embedding-3-small`.

```
"I love chess"  →  [0.0231, -0.4517, 0.8821, … ]     1536 floats
```

**Why numbers?** Computers can't compare meaning. They can compare numbers. Turn both
texts into vectors and you can ask "how close are these two points in 1536-dimensional
space?"

**Why it works better than keyword search:**

```
A: "I love chess"
B: "I enjoy playing the king's game"
C: "I had pizza for dinner"
```

A and B share **zero words** but mean the same thing. Keyword search says unrelated;
embeddings put them close together, because the model learned during training that
"chess" and "king's game" appear in similar contexts.

A and C share the word "I" and mean completely different things. Embeddings put them far
apart.

**Where the numbers come from:** trained on billions of sentences. No individual dimension
has a human-readable meaning — what matters is the overall pattern.

---

## Cosine similarity

How you measure whether two embeddings are close.

**The intuition:** picture vectors as arrows from the origin.

| Arrows point | Cosine | Meaning |
|---|---|---|
| the same direction | 1.0 | identical meaning |
| perpendicular | 0.0 | unrelated |
| opposite | −1.0 | opposite meaning |

You care about **direction, not length**. That's why cosine (angle) rather than Euclidean
(distance) — a long document and a short sentence about the same topic point the same way
even though their magnitudes differ.

```python
def cosine_similarity(v1, v2):
    a, b = np.array(v1), np.array(v2)
    return float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b)))
```

`np.dot` = how aligned. `np.linalg.norm` = length. Divide → the angle.

Engram no longer computes this in Python — Neo4j's index does it internally. But the
concept is the same.

---

## HNSW — how vector indexes are fast

**Hierarchical Navigable Small World.** A real published algorithm (Malkov & Yashunin,
2016), not a Neo4j invention. Used by Pinecone, Weaviate, Qdrant, pgvector, Elasticsearch.

### The problem

100,000 memories, each a point in 1536-dimensional space. Given a query point, find the 8
nearest.

**Brute force:** measure distance to all 100,000. Correct, but 100,000 comparisons — and
it doubles every time your data doubles.

**HNSW:** same answer in ~200 comparisons.

### The intuition — finding a house

You need one specific house among 100,000.

**Brute force:** knock on every door.

**How you'd actually do it:**
1. **Highway** — a few exits cover the whole country. Get to the right region. (3 stops)
2. **Main roads** — narrow to the right neighborhood. (5 stops)
3. **Local streets** — find the house. (10 stops)

18 stops instead of 100,000. Because roads are organized in **layers**, coarse to fine.

### The structure

```
Layer 2 (highways)      ●───────────●───────────●        ~1% of nodes, long links
Layer 1 (main roads)    ●───●───●───●───●───●───●        ~10% of nodes
Layer 0 (local streets) ●─●─●─●─●─●─●─●─●─●─●─●─●        every node, ~16 neighbors each
```

When a vector is inserted, it flips a weighted coin to decide how high it goes. Most stay
at layer 0; a few reach the top.

### The search

1. Start at the top layer, few nodes. Compare to each, move to the closest.
2. Keep hopping within the layer while neighbors get closer.
3. When no neighbor improves, drop a layer. More nodes, finer resolution.
4. Repeat to layer 0, do a careful local search there.
5. Return the best k found.

### Why it scales

| Memories | Brute force | HNSW |
|---|---|---|
| 100 | 100 | ~50 |
| 1,000 | 1,000 | ~100 |
| 10,000 | 10,000 | ~150 |
| 100,000 | 100,000 | ~200 |
| 1,000,000 | 1,000,000 | ~250 |

Brute force doubles when data doubles. HNSW adds a handful of comparisons when data
**10×**s. That's O(n) vs O(log n).

### The catch — approximate

The greedy walk can get stuck in a local pocket and miss the true nearest neighbor.
Typical recall: **95–99%**. Hence ANN — Approximate Nearest Neighbor.

Fine for memory retrieval. Occasionally returning the 9th-best instead of the 8th changes
nothing about the answer quality.

### The name

**Hierarchical** — the layers. **Navigable** — you can walk from any node to any other.
**Small World** — the network property where any two nodes connect in few hops. Same
phenomenon as six degrees of separation; a few long-range links make a huge network
traversable fast.

**Tunable parameters:** `vector.hnsw.m` (connections per node, default 16) and
`vector.hnsw.ef_construction` (candidates tracked during insertion, default 100). Higher
= better recall, slower builds, more memory.

---

## Context managers

Python's mechanism for "do setup, run something, guarantee cleanup."

### The problem it solves

```python
f = open("data.txt")
# ... use f ...
f.close()
```

If the middle line throws, `close()` never runs and the file handle leaks. The manual fix
is verbose:

```python
f = open("data.txt")
try:
    # ... use f ...
finally:
    f.close()
```

Correct, but you write it every time and anyone can forget. So Python hid it:

```python
with open("data.txt") as f:
    # ... use f ...
# closed automatically, no matter what
```

### Writing your own

```python
from contextlib import contextmanager

@contextmanager
def hello():
    print("A")      # BEFORE
    yield           # ← the with-block runs here
    print("B")      # AFTER
```

```python
with hello():
    print("middle")
```
```
A
middle
B
```

`yield` is a bookmark. Python pauses the function there, runs your block, then resumes
from the same spot.

### Yielding a mutable object

If you yield a dict, the caller can fill it in and the AFTER section sees the changes:

```python
@contextmanager
def collector():
    data = {"count": 0}
    yield data
    print(f"final: {data['count']}")

with collector() as d:
    d["count"] = 5          # → prints "final: 5"
```

This is exactly how `trace_agent` captures token counts — the tracer can't know them, but
the agent can, so it writes them into the yielded dict.

### `try/finally` around the yield

```python
@contextmanager
def trace_agent(...):
    start = perf_counter()
    try:
        yield event
    except Exception as e:
        status = "error"
        raise                       # ← observe, don't swallow
    finally:
        # runs on success, failure, or interrupt
        write_trace(...)
```

Three behaviors worth internalizing:

- **`finally` always runs** — every agent call gets a trace, including failed ones. Failed
  traces are the most useful ones.
- **`raise` at the end of `except`** — the exception is observed and then re-thrown. Remove
  it and errors vanish silently while the endpoint returns 200.
- **A second try/except around the trace write** — if logging fails, the request still
  succeeded. Observability must never break what it observes.

---

## `perf_counter` vs `time`

Python has two clocks:

| Function | What it is | Use for |
|---|---|---|
| `time.time()` | wall clock, seconds since epoch | "what time is it" |
| `time.perf_counter()` | monotonic high-resolution counter | "how long did that take" |

`time()` can jump backwards when the OS syncs with a time server — you can measure a
negative duration. `perf_counter()` only moves forward. Always use it for latency.

---

## Async and `asyncio.gather`

**Sequential:**
```python
r1 = call_api(a)   # wait 1.5s
r2 = call_api(b)   # wait 1.5s
r3 = call_api(c)   # wait 1.5s
# 4.5s
```

**Concurrent:**
```python
r1, r2, r3 = await asyncio.gather(call_api(a), call_api(b), call_api(c))
# 1.5s — all three fired at once
```

**Why it works:** during an API call your program spends 99% of the time doing nothing —
waiting on the network. The CPU is idle. Async lets that waiting overlap.

**Critical caveat:** this helps **I/O-bound** work (network, disk, database). It does
**not** help CPU-bound work — Python's GIL prevents true parallel computation with
asyncio. For CPU work you need multiprocessing.

Rule of thumb: **async = waiting on other people's computers. Processes = using your own
CPU harder.**

---

## FastAPI BackgroundTasks

Run work *after* the HTTP response has been sent.

```python
@router.post("/chat")
def chat_endpoint(request, background_tasks: BackgroundTasks, user_id = Depends(...)):
    result = chat(request.message, user_id=user_id)
    safe_message = result.pop("_safe_message")
    background_tasks.add_task(process_memory_background, safe_message, user_id, result["trace_id"])
    return result          # ← sent to the user immediately
```

FastAPI sends the response, *then* runs the registered function. The user's browser has
the answer while the server is still working.

**`result.pop(key)`** retrieves the value *and* deletes the key in one call. Used here so
the route can grab an internal field without leaking it to the frontend.

**Underscore prefix** (`_safe_message`) is the Python convention for "internal, not part
of the public contract."

**Limitation:** background tasks run in the same process. If the server restarts
mid-task, the work is lost. A real job queue (Celery, RQ, Dramatiq) would persist and
retry. Not needed at this scale.

---

## JWT

A signed token that proves who you are without the server storing a session.

```
eyJhbGciOiJIUzI1NiJ9  .  eyJzdWIiOiIyYWMzMjZ…  .  7RwDbrFDT-veqjP72ab…
      header                     payload                  signature
```

- **Header** — which algorithm (HS256)
- **Payload** — `{"sub": "<user uuid>", "exp": <expiry timestamp>}`
- **Signature** — HMAC of header+payload using a server-only secret

**Key property:** the payload is *not encrypted*, just base64. Anyone can read it. But
nobody can **modify** it without the secret, because the signature wouldn't match.

That's what makes it safe to trust: the server decodes the token, verifies the signature,
and reads `sub` as the real user id. A client claiming to be someone else would need the
secret to forge a valid signature.

**Never put anything sensitive in the payload** — it's readable by anyone holding the
token.

**Stateless** — the server keeps no session store. Also means you can't revoke a token
before it expires without reintroducing state (a revocation list).

---

## bcrypt

Password hashing designed to be **slow on purpose**.

```python
pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")
hashed = pwd_context.hash("MyPassword123!")
pwd_context.verify("MyPassword123!", hashed)   # True
```

**Why slow is good:** a fast hash like SHA-256 lets an attacker with a leaked database try
billions of guesses per second. bcrypt takes ~100ms per hash by design, cutting that to
~10 guesses per second. The cost factor is tunable as hardware gets faster.

**Salt** — bcrypt generates a random salt per password and stores it in the hash string.
Two users with the same password get different hashes, which defeats rainbow tables.

**One-way** — you cannot recover the password from the hash. Verification re-hashes the
input with the stored salt and compares.

**Gotcha hit during the build:** bcrypt has a hard **72-byte input limit**, and certain
`passlib`/`bcrypt` version combinations misreport the length, producing "password cannot
be longer than 72 bytes" on a 16-character password. Fixed by pinning `bcrypt<4.1`.

---

## PII scrubbing

**What it catches:** emails, phone numbers, credit cards, SSNs, IP addresses, passports,
driver's licenses, bank accounts, names, locations.

**Two detection layers:**
- **Pattern matching** — regex + validation. Credit cards run Luhn's algorithm, so a
  format-valid but checksum-invalid number is correctly *not* flagged.
- **NER** — spaCy's `en_core_web_lg` finds names and places that no regex could.

```python
results = analyzer.analyze(text=text, entities=DEFAULT_ENTITIES, language="en")
scrubbed = anonymizer.anonymize(text, results, operators)
# "email me at bob@x.com" → "email me at [EMAIL_ADDRESS]"
```

**Why replace with a label instead of deleting:** `[EMAIL_ADDRESS]` preserves the
*structure* of the sentence. Claude can still understand "the user shared their email"
without seeing the value. Deleting would leave "email me at" and lose the meaning.

**Where it runs:** at the ingress point, before anything else. Not at write time — by then
the raw text has already passed through embedding APIs and LLM prompts, and lives in
their logs.

---

## Text chunking

Splitting a document into pieces small enough to embed usefully.

```python
while start < len(words):
    end = min(start + 300, len(words))
    chunks.append(" ".join(words[start:end]))
    if end == len(words):
        break
    start += 300 - 50        # ← advance by 250, not 300
```

**Why 300 words:** embeddings work best on focused semantic units. Too small and there's
no context; too large and the embedding averages multiple topics, losing specificity.

**Why 50 words of overlap:** without it, a sentence crossing a boundary gets split and
neither chunk carries the full idea:

```
chunk 1: "…the hippocampus consolidates short-term"
chunk 2: "memories into long-term storage…"
```

Advancing by 250 instead of 300 means words 250–300 appear in both chunks, so that
sentence survives whole in at least one.

**Why the `break`:** without it, the final short chunk would trigger another loop
iteration and emit a duplicate tail.

---

## spaCy NER vs noun chunks

**Named Entity Recognition** finds *named* things — proper nouns:

```
"I love chess in Hyderabad"
    ents → [Hyderabad (GPE)]
```

It misses "chess" because chess isn't a name.

**Noun chunks** find noun phrases:

```
    noun_chunks → ["chess", "Hyderabad"]
```

Engram's graph stores common nouns as `Entity` nodes — "chess", "engrams", "data
scientist". NER alone would miss all of them and fall through to the slow Claude path on
most queries. Using both is what makes the fast path actually fire.

```python
combined = list(dict.fromkeys(entities + noun_chunks))
```

`dict.fromkeys` dedupes **while preserving order** — since Python 3.7 dicts keep insertion
order, whereas `set()` would scramble it.

---

## Cypher notes

**Multiple labels per node:**
```cypher
CREATE (c:Concept:Memory { … })
```
One node, two labels. Matching `(n:Concept)` finds it. So does `(n:Memory)`.

**Variable-length paths:**
```cypher
MATCH (anchor)-[*1..2]-(connected)
```
`[*1..2]` = follow 1 to 2 relationships, any type, either direction. Bare `-` means
undirected; `->` would restrict to outgoing.

**`coalesce`** — first non-null:
```cypher
coalesce(n.summary, n.content, n.name, '')
```
Episodes have `summary`, Concepts have `content`, Entities have `name`. One expression
handles all three.

**`CREATE` vs `MERGE`** — `CREATE` always makes a new node. `MERGE` creates only if no
match exists. Trace events use `CREATE` (always new). Relationships use `MERGE` (avoid
duplicates).

**Backticks for dotted keys:**
```cypher
`vector.dimensions`: 1536
```
Without them Cypher reads `vector.dimensions` as "the `dimensions` property of `vector`".

---

## Debugging notes

**The editor can lie.** During one session VS Code showed a saved file while the file on
disk still had the old content. Symptom: "I saved it" and "it doesn't work" both true.

Ground truth is the filesystem:
```powershell
Get-Content path\to\file.py | Select-String "the line you changed"
```

When editors misbehave, bypass them entirely:
```powershell
(Get-Content $path -Raw) -replace 'old', 'new' | Set-Content $path -NoNewline
```

**Read the bottom of a stack trace, not the top.** The top is where Python started. The
bottom is what actually broke. A traceback that opened with a `dateutil` error actually
ended with `email-validator is not installed`.

**Averages hide recent changes.** After an optimization, a pooled average is dominated by
old slow calls. Query individual recent records instead.

---

## Environment issues and fixes

| Symptom | Cause | Fix |
|---|---|---|
| `datetime().toString()` syntax error | Not valid in this Neo4j version | Pass ISO strings as parameters |
| `bcrypt: password cannot be longer than 72 bytes` on a 16-char password | passlib/bcrypt version mismatch | `pip install "bcrypt<4.1"` |
| `email-validator is not installed` | `EmailStr` needs an optional extra | `pip install "pydantic[email]"` |
| `DLL load failed … Application Control policy blocked` | Windows Smart App Control blocked spaCy's compiled `.pyd` | Add the venv folder as a Defender exclusion |
| `CERTIFICATE_VERIFY_FAILED` to Neo4j | Local cert chain interference | `neo4j+ssc://` scheme (encrypted, skips chain verification) |
| `Extra data: line 3 column 1` parsing Claude JSON | Claude appended prose after the JSON | `re.search(r'\{.*?\}', raw, re.DOTALL)` and parse only that |
| `42NFF permission/access denied` on `ALTER USER` | AuraDB Free doesn't grant admin | No workaround; restore from a `.backup` file instead |
| Frontend shows 0 nodes, 422 errors | Frontend not sending required `user_id` | Verify on disk, not in the editor |
