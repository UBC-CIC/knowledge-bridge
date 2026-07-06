"""
Text embedding via Amazon Bedrock (Cohere Embed).

Accepts a Bedrock client as a parameter so the module has no module-level AWS
state and can be unit-tested by injecting a mock client.
"""

import json
import logging

logger = logging.getLogger(__name__)

_COHERE_BATCH_SIZE = 96


def embed_texts(
    texts: list,
    bedrock_client,
    model_id: str = "cohere.embed-english-v3",
    batch_size: int = _COHERE_BATCH_SIZE,
    input_type: str = "search_document",
) -> list:
    """Embed a list of texts, batching at Cohere's 96-text limit. Returns one vector per input."""
    all_embeddings = []
    for i in range(0, len(texts), batch_size):
        batch = texts[i : i + batch_size]
        response = bedrock_client.invoke_model(
            modelId=model_id,
            contentType="application/json",
            accept="application/json",
            body=json.dumps({"texts": batch, "input_type": input_type}),
        )
        all_embeddings.extend(json.loads(response["body"].read())["embeddings"])
    logger.info("Embedded %d chunks in %d batch(es)", len(texts), -(-len(texts) // batch_size))
    return all_embeddings
