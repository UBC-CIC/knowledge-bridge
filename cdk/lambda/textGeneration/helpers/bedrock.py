
import logging
from typing import List, Dict, Any

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

def retrieve_documents(
    query: str,
    num_results: int,
) -> List[Dict[str, Any]]:
    # pgvector retrieval not yet implemented — returns empty until Step 5
    logger.info("retrieve_documents: pgvector retrieval not yet implemented, returning empty.")
    return []

def format_context_for_prompt(sources: List[Dict[str, Any]]) -> str:
    if not sources:
        return "No specific documents found."
    context_str = ""
    for i, source in enumerate(sources, 1):
        context_str += f"<source_{i}>\n{source['content']}\n</source_{i}>\n\n"
    return context_str
