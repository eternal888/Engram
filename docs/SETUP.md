# Setup

Getting Engram running from a clean machine.

---

## Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Python | 3.11+ | Check "Add python.exe to PATH" during Windows install |
| Node.js | 18+ (LTS) | Ships with npm |
| Git | any | |
| Neo4j AuraDB | Free tier | console.neo4j.io |
| Anthropic API key | — | console.anthropic.com |
| OpenAI API key | — | platform.openai.com |

---

## Clone and install

```powershell
cd D:\Projects
git clone https://github.com/eternal888/Engram.git
cd Engram

python -m venv venv
venv\Scripts\activate
pip install -r requirements.txt
```

### spaCy models

Two are needed — `en_core_web_lg` for PII detection (Presidio uses it internally),
`en_core_web_sm` for retrieval entity extraction.

```powershell
pip install https://github.com/explosion/spacy-models/releases/download/en_core_web_lg-3.8.0/en_core_web_lg-3.8.0-py3-none-any.whl
pip install https://github.com/explosion/spacy-models/releases/download/en_core_web_sm-3.8.0/en_core_web_sm-3.8.0-py3-none-any.whl
```

Install the wheels directly rather than `python -m spacy download`. The download command
routes through spaCy's servers and fails on flaky connections; the wheel URLs pull
straight from GitHub.

---

## Environment

Create `.env` at the project root:

```
NEO4J_URI=neo4j+ssc://<instance-id>.databases.neo4j.io
NEO4J_USERNAME=<from credentials file>
NEO4J_PASSWORD=<from credentials file>
NEO4J_DATABASE=<instance-id>

ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...

JWT_SECRET_KEY=<random 48+ char string>
```

Generate a JWT secret:
```python
python -c "import secrets; print(secrets.token_urlsafe(48))"
```

**Note the `neo4j+ssc://` scheme**, not `neo4j+s://`. See troubleshooting below.

**Save your Neo4j credentials file.** AuraDB Free provides **no password recovery** — no
reset button, no `ALTER USER` (permission denied on Free tier), and "Recover Database
Credentials" just links to documentation. If you lose the credentials file, the only path
back is restoring from a `.backup` snapshot into a fresh instance.

---

## Neo4j schema

Run these once in the Neo4j console Query tab.

**Constraints:**
```cypher
CREATE CONSTRAINT user_email_unique IF NOT EXISTS
FOR (u:User) REQUIRE u.email IS UNIQUE;

CREATE CONSTRAINT user_id_unique IF NOT EXISTS
FOR (u:User) REQUIRE u.id IS UNIQUE;
```

**Tag existing embedded nodes** (skip on a fresh database):
```cypher
MATCH (n) WHERE n.embedding IS NOT NULL SET n:Memory;
```

**Vector index:**
```cypher
CREATE VECTOR INDEX memory_embeddings IF NOT EXISTS
FOR (n:Memory)
ON n.embedding
WITH [n.user_id]
OPTIONS { indexConfig: {
  `vector.dimensions`: 1536,
  `vector.similarity_function`: 'cosine'
}};
```

**Verify:**
```cypher
SHOW VECTOR INDEXES
```
Expect `state: "ONLINE"` and `properties: ["embedding", "user_id"]`.

No leading colon on these — in the Neo4j console a leading `:` means a browser command
(`:use`, `:param`), not Cypher.

---

## Run

**Terminal 1 — backend:**
```powershell
cd D:\Projects\Engram
venv\Scripts\activate
$env:PYTHONPATH = "D:\Projects\Engram"
uvicorn backend.main:app --reload
```

Expect:
```
✅ Scheduler started — promotion (1h), decay (6h), pruning (12h), curator (24h), consolidation (24h)
INFO:     Application startup complete.
```

**Terminal 2 — frontend:**
```powershell
cd D:\Projects\Engram\frontend
npm install
npm run dev
```

- App: http://localhost:5173
- API docs: http://127.0.0.1:8000/docs

Register an account on first visit.

---

## Troubleshooting

### `CERTIFICATE_VERIFY_FAILED` connecting to Neo4j

```
ssl.SSLCertVerificationError: certificate verify failed:
self-signed certificate in certificate chain
```

Something local — antivirus, corporate proxy, a security suite — is intercepting TLS and
substituting its own certificate. Python doesn't trust it.

**Fix:** use `neo4j+ssc://` instead of `neo4j+s://` in `NEO4J_URI`. Traffic is still
encrypted; the certificate *chain* just isn't verified.

### `DLL load failed while importing mrmr: Application Control policy has blocked this file`

Windows Smart App Control blocking spaCy's compiled `.pyd` files. Common on fresh Windows
11 installs.

**Fix:** Windows Security → Virus & threat protection → Manage settings → Exclusions →
Add folder → your `venv` directory.

Turning Smart App Control off also works but is **irreversible without reinstalling
Windows**.

### `bcrypt: password cannot be longer than 72 bytes`

Fires even on short passwords — a version mismatch between `passlib` and `bcrypt`.

```powershell
pip install "bcrypt<4.1" --force-reinstall
```

### `email-validator is not installed`

Pydantic's `EmailStr` needs an optional extra.

```powershell
pip install "pydantic[email]"
```

### `ModuleNotFoundError: No module named 'backend'`

`PYTHONPATH` isn't set for this shell.

```powershell
$env:PYTHONPATH = "D:\Projects\Engram"
```

### `Failed to DNS resolve address …databases.neo4j.io`

AuraDB Free auto-pauses after ~3 days idle. Go to console.neo4j.io and click **Resume**.

### Frontend shows 0 nodes / 422 errors

Usually stale JavaScript, or a save that didn't reach disk. Check the file on disk, not in
the editor:

```powershell
Get-Content D:\Projects\Engram\frontend\src\App.jsx | Select-String "memory/graph"
```

If it disagrees with what your editor shows, edit through PowerShell:

```powershell
$path = "D:\Projects\Engram\frontend\src\App.jsx"
(Get-Content $path -Raw).Replace('old text', 'new text') | Set-Content $path -NoNewline
```

Then hard-reload the browser (DevTools open → right-click refresh → "Empty Cache and Hard
Reload").

### git: `Author identity unknown`

```powershell
git config --global user.name "yourname"
git config --global user.email "you@example.com"
```

### VS Code terminal doesn't see a newly installed tool

VS Code caches its environment. Kill every `Code` process in Task Manager and reopen, or
just use a regular PowerShell window.

---

## Backups

**Do this regularly.** AuraDB Free's snapshot export is the only recovery path if you lose
credentials or the instance is deleted.

Console → your instance → **⋯** → **Snapshots** → take one → download the `.backup` file.

Store it somewhere that isn't the machine running the project.

To restore: create a fresh instance → **⋯** → **Restore from File** → drag the `.backup`
in. Everything comes back, with credentials you control.

---

## Layout

```
Engram/
├── backend/
│   ├── agents/           orchestrator, extraction, retrieval, grounding,
│   │                     contradiction, curator, consolidation
│   ├── api/              auth_routes, routes, documents_routes, traces_routes
│   ├── core/             config, auth, embeddings, pii_scrubber, tracing,
│   │                     promotion, scheduler
│   ├── graph/            graph_client, memory_writer, versioning, users, schema
│   ├── ingestion/        fetchers, chunker, pipeline
│   └── main.py
├── frontend/
│   └── src/App.jsx       memory graph visualization, chat interface,
│                         provenance display, trace panel, authentication
├── docs/
├── tests/
├── .env                  never committed
└── requirements.txt
```
