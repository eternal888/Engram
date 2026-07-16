"""
Text chunker for document ingestion.
Splits raw text into ~300-word chunks with 50-word overlap.
"""

import re


def chunk_text(text: str, target_words: int = 300, overlap_words: int = 50) -> list:
    """
    Split text into overlapping chunks of roughly target_words each.
    Returns list of dicts: {"index": int, "text": str, "word_count": int}
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

        if end == len(words):
            break

        start += target_words - overlap_words

    return chunks