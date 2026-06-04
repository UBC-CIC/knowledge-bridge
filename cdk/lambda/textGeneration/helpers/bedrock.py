import json
import logging
import boto3
from typing import List, Dict, Any

import helpers.config as config

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

EMBEDDING_MODEL_ID = "cohere.embed-english-v3"

_bedrock_ca = None

def _get_bedrock_ca():
    global _bedrock_ca
    if _bedrock_ca is None:
        _bedrock_ca = boto3.client("bedrock-runtime", region_name=config.REGION)
    return _bedrock_ca


def _embed_text(text: str) -> List[float]:
    """Embed a query string using Cohere via Bedrock (ca-central-1)."""
    response = _get_bedrock_ca().invoke_model(
        modelId=EMBEDDING_MODEL_ID,
        body=json.dumps({
            "texts": [text],
            "input_type": "search_query",
            "truncate": "END",
        }),
        contentType="application/json",
        accept="application/json",
    )
    return json.loads(response["body"].read())["embeddings"][0]


def _vector_literal(values: List[float]) -> str:
    return "[" + ",".join(str(float(v)) for v in values) + "]"


def retrieve_documents(
    query: str,
    num_results: int,
    user_groups: List[str],
    db_connection,
) -> List[Dict[str, Any]]:
    """
    Embed the query, then retrieve the top-N semantically similar chunks
    from pgvector filtered by the user's Entra group IDs.
    """
    if not user_groups:
        logger.warning("retrieve_documents: no user groups — returning empty.")
        return []

    user_groups = sorted({g.lower() for g in user_groups if g})

    try:
        embedding = _embed_text(query)
    except Exception as e:
        logger.error(f"retrieve_documents: embedding failed: {e}")
        return []

    sql = """
        SELECT
            v.content,
            v.metadata,
            d.title,
            d.source_url,
            1 - (v.embedding <=> %s::vector) AS similarity
        FROM document_vectors v
        JOIN documents d ON d.id = v.document_id
        WHERE d.status = 'ingested'
          AND (v.metadata->'group_ids') ?| %s
        ORDER BY v.embedding <=> %s::vector
        LIMIT %s
    """

    try:
        with db_connection.cursor() as cur:
            cur.execute(sql, (
                _vector_literal(embedding),
                user_groups,
                _vector_literal(embedding),
                num_results,
            ))
            columns = [desc[0] for desc in cur.description]
            results = [dict(zip(columns, row)) for row in cur.fetchall()]
            logger.info(
                f"retrieve_documents: {len(results)} chunks for query='{query[:60]}' "
                f"groups={user_groups}"
            )
            return results
    except Exception as e:
        logger.error(f"retrieve_documents: pgvector query failed: {e}")
        return []


def format_context_for_prompt(sources: List[Dict[str, Any]]) -> str:
    """Format retrieved chunks into a numbered context block for the system prompt."""
    if not sources:
        return "No relevant context was retrieved."
    blocks = []
    for i, source in enumerate(sources, 1):
        blocks.append(
            f"[Source {i}]\n"
            f"Title: {source.get('title') or 'Untitled'}\n"
            f"URL: {source.get('source_url') or 'N/A'}\n"
            f"Similarity: {float(source.get('similarity') or 0):.4f}\n"
            f"Content:\n{source.get('content')}"
        )
    return "\n\n".join(blocks)
