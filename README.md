# Engram
### A Multi-Agent Memory Operating System

Engram is a production-grade AI system where multiple specialized agents collaborate to store, retrieve, maintain, and reason over a persistent knowledge graph — mimicking how human memory actually works.

## What it does
Most AI agents are stateless — they forget everything after each conversation. Engram solves that by giving agents a living, evolving memory graph that grows smarter over time.

## Architecture

User → Orchestrator Agent
  ├── Extraction Agent    → pulls facts, entities, episodes
  ├── Retrieval Agent     → finds relevant past memory
  ├── Grounding Agent     → cites sources, scores trust
  ├── Contradiction Agent → detects + resolves conflicts
  ├── Curator Agent       → cleans, merges, prunes memory
  └── Consolidation Agent → compresses episodes → concepts
              ↓
      Neo4j Knowledge Graph

## Stack
- Backend — FastAPI + WebSocket
- Graph DB — Neo4j AuraDB
- AI — Claude API (multi-agent)
- Embeddings — OpenAI text-embedding-3-small
- Frontend — React + Vite + Tailwind
- Deploy — AWS Lambda + Vercel

## Local Setup
git clone https://github.com/eternal888/Engram
cd Engram
python -m venv venv
venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env
uvicorn backend.main:app --reload