"""
Text chunking utilities.

Splits document text into overlapping semantic chunks suitable for embedding.
No external dependencies — pure Python.
"""

import re
import logging

logger = logging.getLogger(__name__)


def rough_token_count(text: str) -> int:
    return max(1, int(len(text.split()) * 1.3))


def split_sentences(text: str) -> list:
    text = re.sub(r"\s+", " ", text).strip()
    if not text:
        return []
    return re.split(r"(?<=[.!?])\s+", text)


def semantic_chunk_text(text: str, max_tokens: int = 400, overlap_sentences: int = 1) -> list:
    text = (text or "").strip()
    if not text:
        return []
    if rough_token_count(text) <= max_tokens:
        return [text]
    paragraphs = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]
    units = []
    for p in paragraphs or [text]:
        if rough_token_count(p) <= max_tokens:
            units.append(p)
        else:
            units.extend(split_sentences(p))
    chunks, current = [], []
    for unit in units:
        candidate = " ".join(current + [unit]).strip()
        if current and rough_token_count(candidate) > max_tokens:
            chunks.append(" ".join(current).strip())
            current = current[-overlap_sentences:] if overlap_sentences else []
        current.append(unit)
    if current:
        chunks.append(" ".join(current).strip())
    return [c for c in chunks if c]
