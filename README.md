# Engram

### A multi-agent memory operating system

Most LLM applications are stateless — they forget everything between conversations, or
they stuff a transcript into the context window and call it memory. Engram stores what
you tell it as a knowledge graph, retrieves from it, checks every claim in a reply against
what it holds, and flags contradictions rather than silently overwriting them.

**Live:** https://engram-gold.vercel.app

---

## How it works

Seven agents, split across a fast path (runs before the reply) and a background path
(runs after the response is streamed).

```
User message
  │
  ├─ PII scrubber ──────── redacts before anything is stored or embedded
  ├─ Retrieval agent ───── vector search + graph traversal, merged and ranked
  ├─ Response generation ─ streams tokens over SSE
  └─ Grounding agent ───── checks each claim against retrieved memory, scores trust
  │
  └─ (background)
      ├─ Extraction agent ───── facts, entities, episode summary
      ├─ Contradiction agent ── compares new facts against stored ones
      ├─ Memory writer ──────── embeds and writes to Neo4j
      ├─ Curator agent ──────── merges duplicates, prunes low-confidence nodes
      └─ Consolidation agent ── compresses repeated episodes into concepts
```

Every turn writes a trace of which agents ran, how long each took, and what it cost.
Those traces are visible in the interface.

### Retrieval

Hybrid, two channels:

- **Vector** — HNSW index over `text-embedding-3-small` embeddings, filtered by `user_id`
  inside the index traversal rather than after it.
- **Graph** — spaCy extracts entities from the query, those anchor a two-hop walk across
  memory nodes.

Results are merged, deduped, and scored on relevance, recency, and trust. A memory found
by both channels gets a 1.15× boost.

### Grounding

Each claim in a reply is matched against retrieved memory and marked verified or not.
The interface shows the percentage prominently, because a fluent answer with nothing
behind it is the failure mode worth surfacing.

---

## Stack

| | |
|---|---|
| Backend | FastAPI, SSE streaming, APScheduler |
| Graph | Neo4j AuraDB Free |
| Models | Claude Sonnet (responses), Claude Haiku (extraction) |
| Embeddings | OpenAI `text-embedding-3-small` |
| PII | Microsoft Presidio + spaCy `en_core_web_sm` |
| Auth | JWT HS256 + bcrypt |
| Frontend | React, Vite |
| Hosting | Railway (backend), Vercel (frontend) |

---

## Evaluation

A custom harness in `evals/` runs three suites against a dedicated eval user, wiping
state between cases.

```
Retrieval      precision@3 0.88   precision@5 1.00   MRR 0.76
               answer accuracy 1.00   avg 6.6s
Contradiction  precision 1.00   recall 1.00
Grounding      pass rate 1.00
```

**Read these with two caveats.**

Every number on record was measured while graph traversal was returning zero hits — the
graph channel contributed nothing, so "hybrid retrieval" was being scored as pure vector
search. That bug is now fixed and all suites need re-running.

And the dataset is self-authored, so `precision@5 1.00` measures internal consistency
rather than generalization. LongMemEval or an equivalent external harness is the next
step before any of this is claimed as a benchmark.

A concrete example of why that matters: the harness reported `precision@3 1.00` during a
period when the deployed product returned zero memories for ordinary questions. The eval
queries cleared a similarity threshold that real conversational phrasing did not.

---

## Known issues

Nothing here blocks the deployment. Listed because they're real.

**Data quality**
- Conversational metadata is still occasionally stored as memory (`user asked about X`),
  despite the extraction prompt forbidding it.
- Episodes outnumber extracted concepts roughly 2:1, so most facts appear twice.
- Duplicate concept nodes are created across turns; there's no dedup on write.
- A PII placeholder has been observed stored as a memory node.

**Correctness**
- `recency_score` returns a constant 0.5. An aware/naive datetime comparison raises
  `TypeError`, caught by a bare `except`. The recency term (weight 0.2) contributes nothing.
- Fence-stripping via `raw.split("```")[1]` remains in `consolidation_agent` and
  `curator_agent`.
- Writes are not idempotent. Currently mitigated by hosting choice rather than code.

**Security**
- No email verification — address format is validated, existence is not. This also blocks
  password reset.
- No rate limiting on `/api/auth/register`.
- CORS is `allow_origins=["*"]`. JWT-protected, so no data is exposed, but it should be
  narrowed to the Vercel origin.

---

## Local setup

```bash
git clone https://github.com/eternal888/Engram
cd Engram
python -m venv venv
venv\Scripts\activate          # source venv/bin/activate on macOS/Linux
pip install -r requirements.txt
cp .env.example .env           # fill in the values below
uvicorn backend.main:app --reload
```

```bash
cd frontend
npm install
npm run dev
```

### Environment

```
NEO4J_URI=neo4j+ssc://<instance>.databases.neo4j.io
NEO4J_USERNAME=<instance-id>
NEO4J_PASSWORD=
NEO4J_DATABASE=<instance-id>
ANTHROPIC_API_KEY=
OPENAI_API_KEY=
JWT_SECRET_KEY=
```


### Evals

```bash
export PYTHONPATH=$(pwd)       # $env:PYTHONPATH = "D:\Projects\Engram" on Windows
python evals/harness.py                    # all suites
python evals/harness.py --suite retrieval  # one suite
```

---

## Deployment notes

- Backend runs on Railway with `uvicorn backend.main:app --host 0.0.0.0 --port $PORT`.
  Railpack autodetects FastAPI at the repo root, so the start command must be set explicitly.
- Auto-deploy is off by default in Railway and has to be enabled in Settings → Source,
  or pushes silently do nothing and manual redeploys reuse a cached image.
- Vercel needs its root directory set to `frontend`, framework preset Vite. Left at the
  repo root it detects FastAPI and fails.
- Presidio must be pinned to `en_core_web_sm`. Its default `en_core_web_lg` is 400 MB,
  re-downloads on every container start, and is never referenced by application code.
  Pinning it took the container from 900 MB to 230 MB.
- Never paste `pip freeze` straight into `requirements.txt` — `python-certifi-win32` and
  `colorama` are Windows-only and break Linux builds.
- AuraDB Free auto-pauses. A scheduled keepalive query runs every 12 hours, but only
  while the backend is up.

---

## Repository

```
backend/
  agents/        seven agents + orchestrator
  api/           routes, auth, documents, traces
  core/          llm client, embeddings, PII scrubbing, auth, config
  graph/         Neo4j client, schema, versioning
  ingestion/     PDF and URL fetching, chunking, pipeline
evals/           harness and test cases
frontend/src/    React application
docs/            architecture, agents, data model, decisions, performance, setup
```

Built by [Ritish Nandikonda](https://github.com/eternal888).