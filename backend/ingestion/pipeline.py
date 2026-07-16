"""
Ingestion pipeline: takes raw text + metadata, writes Source nodes to Neo4j.

Flow:
    raw text
       ↓
    PII scrub (reuse Week 9's scrubber)
       ↓
    chunk into ~300-word overlapping pieces
       ↓
    for each chunk:
       - embed
       - CREATE Source node with user_id
       - link to previous chunk with NEXT_CHUNK edge (preserves reading order)

All Source nodes from the same upload share the same document_name and
document_id — enabling list / delete of a whole document.
"""

import uuid
from datetime import datetime
from backend.graph.graph_client import graph_client
from backend.core.embeddings import embed_text
from backend.core.pii_scrubber import scrub
from backend.ingestion.chunker import chunk_text


def ingest_text(
    user_id: str,
    text: str,
    document_name: str,
    document_source: str,  # "upload" | "url"
    source_url: str = None,
) -> dict:
    """
    Full ingestion pipeline for a chunk of raw text.
    Returns summary: {document_id, chunks_written, pii_scrubbed, error}.
    """
    if not text or not text.strip():
        return {"document_id": None, "chunks_written": 0, "pii_scrubbed": False,
                "error": "empty text"}

    # 1. Scrub PII across the whole document once (efficient)
    scrub_result = scrub(text)
    safe_text = scrub_result["scrubbed_text"]
    had_pii = scrub_result["had_pii"]

    if had_pii:
        pii_types = ", ".join(sorted({p["type"] for p in scrub_result["pii_found"]}))
        print(f"🔒 PII scrubbed from document '{document_name}': {pii_types}")

    # 2. Chunk
    chunks = chunk_text(safe_text, target_words=300, overlap_words=50)
    if not chunks:
        return {"document_id": None, "chunks_written": 0, "pii_scrubbed": had_pii,
                "error": "no chunks produced"}

    # 3. Write chunks as Source nodes
    document_id = str(uuid.uuid4())
    now = datetime.utcnow().isoformat()
    total = len(chunks)
    previous_node_id = None

    for chunk in chunks:
        chunk_id = str(uuid.uuid4())
        embedding = embed_text(chunk["text"])

        graph_client.run("""
            CREATE (s:Source {
                id: $id,
                user_id: $user_id,
                content: $content,
                embedding: $embedding,
                document_id: $document_id,
                document_name: $document_name,
                document_source: $document_source,
                source_url: $source_url,
                chunk_index: $chunk_index,
                total_chunks: $total_chunks,
                word_count: $word_count,
                confidence: 1.0,
                ttl_tier: 'long-term',
                created_at: $now,
                last_accessed: $now
            })
            """, {
            "id": chunk_id,
            "user_id": user_id,
            "content": chunk["text"],
            "embedding": embedding,
            "document_id": document_id,
            "document_name": document_name,
            "document_source": document_source,
            "source_url": source_url or "",
            "chunk_index": chunk["index"],
            "total_chunks": total,
            "word_count": chunk["word_count"],
            "now": now,
        })

        # Link to previous chunk to preserve reading order
        if previous_node_id:
            graph_client.run("""
                MATCH (prev:Source {id: $prev_id})
                MATCH (curr:Source {id: $curr_id})
                MERGE (prev)-[:NEXT_CHUNK]->(curr)
                """, {"prev_id": previous_node_id, "curr_id": chunk_id})

        previous_node_id = chunk_id

    print(f"✅ Ingested '{document_name}' — {total} chunks written")
    return {
        "document_id": document_id,
        "document_name": document_name,
        "chunks_written": total,
        "pii_scrubbed": had_pii,
        "error": None,
    }


def list_user_documents(user_id: str) -> list:
    """Return one entry per unique document for this user."""
    result = graph_client.run("""
        MATCH (s:Source)
        WHERE s.user_id = $user_id
        RETURN s.document_id as document_id,
               s.document_name as document_name,
               s.document_source as document_source,
               s.source_url as source_url,
               s.total_chunks as total_chunks,
               min(s.created_at) as created_at
        ORDER BY created_at DESC
        """, {"user_id": user_id})
    # Neo4j returns one row per chunk here — dedupe by document_id
    seen = set()
    docs = []
    for row in result:
        did = row["document_id"]
        if did in seen:
            continue
        seen.add(did)
        docs.append(row)
    return docs


def delete_document(user_id: str, document_id: str) -> int:
    """
    Delete all chunks of a document. Returns count deleted.
    Ownership enforced via user_id in the MATCH.
    """
    result = graph_client.run("""
        MATCH (s:Source {document_id: $document_id, user_id: $user_id})
        WITH count(s) as n, collect(s) as sources
        UNWIND sources as s
        DETACH DELETE s
        RETURN n
        """, {"document_id": document_id, "user_id": user_id})
    return result[0]["n"] if result else 0