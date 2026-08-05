# Architecture

How Engram is put together, and how a request flows through it.

---

## What Engram is

A multi-agent memory operating system. Most AI conversations are stateless — you tell an
AI something today, it's gone tomorrow. Engram adds a persistent memory layer with three
properties ordinary chatbots lack:

- **Continuity** — memories survive across sessions
- **Structure** — memory is a graph, not a flat list of embeddings
- **Provenance** — every claim in a response is traceable to a source with a trust score

---

## System map

```
                          ┌──────────────────────┐
                          │   React frontend     │
                          │   (Vite + Tailwind)  │
                          │                      │
                          │  · memory graph      │
                          │  · chat + provenance │
                          │  · trace panel       │
                          │  · login / register  │
                          └──────────┬───────────┘
                                     │ HTTPS + JWT
                          ┌──────────▼───────────┐
                          │   FastAPI backend    │
                          ├──────────────────────┤
                          │ /api/auth/*          │
                          │ /api/chat            │
                          │ /api/memory/*        │
                          │ /api/documents/*     │
                          │ /api/traces/*        │
                          └──────────┬───────────┘
                                     │
              ┌──────────────────────┼──────────────────────┐
              │                      │                      │
    ┌─────────▼────────┐   ┌─────────▼────────┐   ┌────────▼─────────┐
    │   Orchestrator   │   │   Ingestion      │   │   Scheduler      │
    │                  │   │   pipeline       │   │   (APScheduler)  │
    │ pii_scrubber     │   │                  │   │                  │
    │ retrieval        │   │ fetch → scrub    │   │ promotion   1h   │
    │ response_gen     │   │ → chunk → embed  │   │ decay       6h   │
    │ grounding        │   │ → Source nodes   │   │ pruning    12h   │
    │ ─── background ──│   │                  │   │ curator    24h   │
    │ extraction       │   └─────────┬────────┘   │ consolidate 24h  │
    │ contradiction    │             │            └────────┬─────────┘
    │ memory_writer    │             │                     │
    └─────────┬────────┘             │                     │
              │                      │                     │
              └──────────────────────┼─────────────────────┘
                                     │
                     ┌───────────────▼────────────────┐
                     │      Neo4j AuraDB              │
                     │                                │
                     │  Episode  Concept  Entity      │
                     │  Source   Contradiction        │
                     │  Version  User     TraceEvent  │
                     │                                │
                     │  vector index: memory_embeddings│
                     └────────────────────────────────┘

        External services:  Claude (Anthropic)  ·  OpenAI embeddings
```

---

## Request flow — a chat turn

This is the core loop. Understanding it means understanding Engram.

```
1.  User types a message in the browser
         │
2.  Frontend attaches JWT from localStorage, POSTs to /api/chat
         │
3.  FastAPI validates the token, extracts real user_id from it
         │   (the client never gets to claim who it is)
         │
4.  Orchestrator runs the FAST PATH:
         │
         ├─ pii_scrubber     — Presidio + spaCy strip emails, phones,
         │                     names, cards, SSNs → placeholders
         │
         ├─ retrieval        — hybrid search:
         │                       vector: Neo4j SEARCH over HNSW index
         │                       graph:  spaCy entities → 2-hop traversal
         │                     merged and ranked by
         │                       relevance·0.5 + recency·0.2 + trust·0.3
         │
         ├─ response_gen     — Claude generates an answer using the
         │                     retrieved memories as context
         │
         └─ grounding        — Claude verifies each claim against the
                               retrieved memories, attaches trust scores,
                               flags anything unsupported
         │
5.  HTTP response sent to the user  ← they stop waiting here
         │
6.  BACKGROUND (FastAPI BackgroundTasks) — user already has their answer:
         │
         ├─ extraction       — Claude pulls entities, facts, relationships
         │                     out of the message
         │
         ├─ contradiction    — compares new facts against existing memory;
         │                     on conflict, creates a Contradiction node
         │                     and supersedes the loser
         │
         └─ memory_writer    — embeds and writes Episode / Concept /
                               Entity nodes with :Memory label
         │
7.  Every step above wrapped in trace_agent() — latency, tokens, status
    recorded as TraceEvent nodes sharing one trace_id
```

---

## Component responsibilities

### `backend/agents/`

| File | Responsibility |
|---|---|
| `orchestrator.py` | Runs the pipeline. Owns the fast path / background split. |
| `extraction_agent.py` | Raw text → structured entities, facts, relationships, episode summary |
| `retrieval_agent.py` | Hybrid retrieval: vector search + graph traversal + ranking |
| `grounding_agent.py` | Verifies response claims against memories, assigns trust scores |
| `contradiction_agent.py` | Detects conflicting facts, resolves them, writes audit nodes |
| `curator_agent.py` | Background: merges duplicates, finds orphans, reports graph health |
| `consolidation_agent.py` | Scheduled: compresses recurring themes across episodes into concepts |

### `backend/graph/`

| File | Responsibility |
|---|---|
| `graph_client.py` | Thin Neo4j driver wrapper. Every DB call goes through `.run()` |
| `memory_writer.py` | Writes extracted memory as nodes + edges, with dedup |
| `versioning.py` | Snapshots nodes before mutation, `EVOLVED_FROM` edges |
| `users.py` | User CRUD, bcrypt password hashing, authentication |
| `schema.py` | Constraints and indexes |

### `backend/core/`

| File | Responsibility |
|---|---|
| `config.py` | Loads env vars |
| `embeddings.py` | OpenAI `text-embedding-3-small` wrapper |
| `pii_scrubber.py` | Presidio + spaCy PII detection and redaction |
| `auth.py` | JWT create/verify, password hash/verify, `get_current_user` dependency |
| `tracing.py` | `trace_agent` context manager for observability |
| `promotion.py` | Memory lifecycle: promotion, decay, pruning |
| `scheduler.py` | APScheduler wiring for background jobs |

### `backend/ingestion/`

| File | Responsibility |
|---|---|
| `fetchers.py` | PDF text extraction (pypdf), URL fetching (BeautifulSoup) |
| `chunker.py` | Sliding-window text chunking with overlap |
| `pipeline.py` | scrub → chunk → embed → write Source nodes |

### `backend/api/`

| File | Routes |
|---|---|
| `auth_routes.py` | `/auth/register`, `/auth/login`, `/auth/me` |
| `routes.py` | `/chat`, `/memory/graph`, `/memory/episodes`, `/memory/health`, `/memory/feedback` |
| `documents_routes.py` | `/documents/upload`, `/documents/url`, `/documents`, `/documents/{id}` |
| `traces_routes.py` | `/traces`, `/traces/stats`, `/traces/{id}` |

---

## Stack

| Layer | Technology | Why |
|---|---|---|
| Graph DB | Neo4j AuraDB Free | Relationships are first-class; native vector index means one database, not two |
| Backend | FastAPI | Async-native, automatic OpenAPI docs, dependency injection for auth |
| LLM | Claude Sonnet | Reasoning quality for extraction, grounding, contradiction judgment |
| Embeddings | OpenAI `text-embedding-3-small` | 1536-dim, cheap, good quality/cost ratio |
| PII | Microsoft Presidio + spaCy `en_core_web_lg` | Industry standard, handles NER not just regex |
| NER (retrieval) | spaCy `en_core_web_sm` | 12MB, ~5ms, avoids an LLM round-trip |
| Auth | python-jose (JWT) + passlib (bcrypt) | Standard, well-audited |
| Scheduler | APScheduler | In-process, no extra infrastructure |
| Frontend | React + Vite + Tailwind | Fast dev loop, canvas for the graph viz |

---

## Security model

Three layers, each independent:

**1. Authentication** — JWT signed HS256 with a server-side secret. The token payload
contains `sub` (the user's UUID) and an expiry. Every protected endpoint depends on
`get_current_user`, which decodes and validates the token. The client cannot claim an
identity — `user_id` is extracted from the signature, never read from the request body.

**2. Authorization** — every mutation calls `_assert_owns(node_id, user_id)` before
touching a node. Cross-user access returns 404, never 403, so an attacker can't
distinguish "doesn't exist" from "not yours."

**3. Defense in depth** — the Cypher queries themselves filter on `user_id`:
`MATCH (n {id: $id, user_id: $user_id})`. Even if the ownership check were removed by
mistake, the mutation would match nothing.

**PII** — scrubbed at the ingress point (orchestrator step 0, ingestion pipeline step 1)
before anything is embedded, written, or logged. Raw PII never reaches Neo4j, so it
never reaches backups, exports, or embeddings either.

---

## What runs on a schedule

| Job | Interval | What it does |
|---|---|---|
| promotion | 1h | working → short-term → long-term based on access + age |
| decay | 6h | lowers confidence on memories unused for 7+ days |
| pruning | 12h | deletes working-tier memories below 0.2 confidence with no confirmations |
| curator | 24h | finds near-duplicate concepts, merges them, reports graph health |
| consolidation | 24h | reads unconsolidated episodes, extracts recurring themes, writes long-term concepts |

All wired through `backend/core/scheduler.py`, started in the FastAPI lifespan handler.
