"""
Text chunker for document ingestion.

Splits raw text into semantically coherent chunks with overlap.
- Target ~300 words per chunk (small enough for focused embeddings)
- ~50 word overlap (prevents context loss at boundaries)
- Splits on paragraph boundaries when possible, sentence boundaries as fallback

Overlap explained:
    text: [A B C D E F G H I J K L]
    chunk 1: [A B C D E]
    chunk 2: [D E F G H]     ← D E repeat as overlap
    chunk 3: [G H I J K]     ← G H repeat as overlap
"""

import re


def _split_sentences(text: str) -> list:
    """Split on sentence boundaries. Simple regex — not perfect but robust."""
    # Split on ., !, ? followed by whitespace and capital letter
    parts = re.split(r'(?<=[.!?])\s+(?=[A-Z])', text)
    return [p.strip() for p in parts if p.strip()]


def _split_paragraphs(text: str) -> list:
    """Split on blank lines. Preserves paragraph structure."""
    paras = re.split(r'\n\s*\n', text)
    return [p.strip() for p in paras if p.strip()]


def chunk_text(text: str, target_words: int = 300, overlap_words: int = 50) -> list:
    """
    Split text into overlapping chunks of roughly target_words each.
    
    Returns list of dicts:
        {"index": int, "text": str, "word_count": int}
    """
    if not text or not text.strip():
        return []

    # Normalize whitespace
    text = re.sub(r'\s+', ' ', text).strip()
    words = text.split()

    if len(words) <= target_words:
        return [{"index": 0, "text": text, "word_count": len(words)}]

    chunks = []
    start = 0
    idx = 0

    while start < len(words):
        end = min(start + target_words, len(words))
        chunk_words = words[start:end]
        chunks.append({
            "index": idx,
            "text": " ".join(chunk_words),
            "word_count": len(chunk_words),
        })
        idx += 1

        # Stop if this was the final chunk
        if end == len(words):
            break

        # Advance start by (target - overlap) so next chunk overlaps
        start += target_words - overlap_words

    return chunks