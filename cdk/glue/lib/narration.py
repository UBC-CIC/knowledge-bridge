"""
LLM-based narration of SharePoint list items via Amazon Bedrock (Claude Haiku).

Converts structured field dicts into natural English paragraphs for embedding.
Accepts a Bedrock client as a parameter — no module-level AWS state.
"""

import json
import logging
from typing import Optional

logger = logging.getLogger(__name__)

_DEFAULT_MODEL_ID = "us.anthropic.claude-haiku-4-5-20251001-v1:0"


def narrate_fields(
    fields: dict,
    bedrock_llm,
    list_title: Optional[str] = None,
    model_id: str = _DEFAULT_MODEL_ID,
) -> str:
    clean_fields = {k: v for k, v in fields.items() if not k.startswith("@") and v}
    llm_payload = {"list_title": list_title, "fields": clean_fields}
    prompt = f"""Convert this SharePoint list item JSON into one natural English paragraph for semantic search.
Rules: Rewrite fields into a coherent, factual sentence preserving field-value meaning. Use list_title as context.
Do not include IDs or system metadata. Output only the paragraph, nothing else.

{json.dumps(llm_payload)}"""
    body = {
        "anthropic_version": "bedrock-2023-05-31",
        "max_tokens": 512,
        "temperature": 0.0,
        "messages": [{"role": "user", "content": prompt}],
    }
    response = bedrock_llm.invoke_model(
        modelId=model_id,
        body=json.dumps(body),
        contentType="application/json",
        accept="application/json",
    )
    result = json.loads(response["body"].read())
    return result["content"][0]["text"].strip()
