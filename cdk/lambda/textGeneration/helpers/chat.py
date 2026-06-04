import boto3
import logging
import re
from typing import Dict, Any, Optional, List, Tuple

from helpers.crud import (
    fetch_recent_messages, ensure_session_exists, insert_message,
    update_last_active_session, get_user_groups
)
from helpers.logic import get_current_prompt
from helpers.bedrock import retrieve_documents, format_context_for_prompt
import helpers.config as config
from helpers.message_limits import check_limit, record_message_sent
from helpers.guardrail import invoke_guardrail, ACTION_ANONYMIZED, ACTION_BLOCKED

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

logger.info(f"boto3 version: {boto3.__version__}")


def _rewrite_query_for_retrieval(
    raw_query: str,
    chat_history: List[Dict[str, Any]],
    llm_region: str,
) -> str:
    """
    Rewrites a conversational query into a keyword-rich search query
    optimized for vector DB retrieval. Falls back to raw query on error.
    """
    history_lines = []
    for msg in chat_history[-10:]:
        role = "User" if msg["sender"] == "user" else "Assistant"
        history_lines.append(f"{role}: {msg['content']}")
    history_block = "\n".join(history_lines) if history_lines else "(no prior conversation)"

    rewrite_system_prompt = """<instructions>
You are a search query optimizer for a knowledge base containing Canadian university IT survey responses, meeting communications, subcommittee decisions, and best practices.
Given the conversation history and the user's latest message, produce a short, keyword-rich search query optimized for vector similarity search.
Focus on: topics, institutions, date ranges, decisions, technologies, or initiatives mentioned.
Output ONLY the search query — no explanation, no quotes, no preamble.
</instructions>"""

    user_message = f"""<conversation_history>
{history_block}
</conversation_history>

<latest_user_message>
{raw_query}
</latest_user_message>"""

    try:
        bedrock_runtime = boto3.client("bedrock-runtime", region_name=llm_region)
        response = bedrock_runtime.converse(
            modelId=config.HAIKU_ARN,
            messages=[{"role": "user", "content": [{"text": user_message}]}],
            system=[{"text": rewrite_system_prompt}],
            inferenceConfig={"maxTokens": 60, "temperature": 0.0}
        )
        rewritten = response["output"]["message"]["content"][0]["text"].strip()
        logger.info(f"Query rewrite: '{raw_query}' -> '{rewritten}'")
        return rewritten if rewritten else raw_query
    except Exception as e:
        logger.warning(f"Query rewrite failed, using raw query: {e}")
        return raw_query


def _prepare_conversation(
    query: str,
    llm_region: str,
    chat_session_id: str,
    user_id: Optional[str],
    user_groups: List[str],
    db_connection,
    save_user_message: bool = True,
) -> Tuple[List[Dict[str, Any]], str, str, List[Dict[str, Any]]]:
    """
    Fetches history, saves user message, rewrites query, retrieves context,
    and builds the bedrock messages array and system prompt.
    Returns: (bedrock_messages, static_system_prompt, dynamic_prompt, sources)
    """
    if not query or not query.strip():
        raise ValueError("Please provide a non-empty question.")

    # 1. Fetch history
    raw_history = fetch_recent_messages(db_connection, chat_session_id, limit=config.MAX_HISTORY_MESSAGES)

    # 2. Save user message
    try:
        if save_user_message:
            ensure_session_exists(db_connection, chat_session_id, user_id)
            insert_message(db_connection, chat_session_id, "user", query, sources=None, warning=None)
            update_last_active_session(db_connection, chat_session_id)
            db_connection.commit()
    except Exception as e:
        db_connection.rollback()
        logger.error(f"DB error saving user message: {e}")
        raise

    # 3. Build static system prompt
    static_system_prompt = get_current_prompt()

    # 4. Rewrite query for retrieval
    search_query = _rewrite_query_for_retrieval(
        raw_query=query,
        chat_history=raw_history,
        llm_region=llm_region,
    )

    # 5. Retrieve context chunks
    sources = retrieve_documents(
        query=search_query,
        num_results=config.MAX_CONTEXT_CHUNKS,
        user_groups=user_groups,
        db_connection=db_connection,
    )

    # 6. Format context block
    context_block = format_context_for_prompt(sources)

    # 7. Build dynamic prompt — injects retrieved context
    dynamic_prompt = f"""<retrieved_context record_count="{len(sources)}">
{context_block}
</retrieved_context>"""

    # 8. Build messages array from history + current query
    bedrock_messages = []
    for msg in raw_history:
        role = "user" if msg["sender"] == "user" else "assistant"
        if msg["content"]:
            bedrock_messages.append({
                "role": role,
                "content": [{"text": msg["content"]}]
            })

    bedrock_messages.append({
        "role": "user",
        "content": [{"text": query}]
    })

    return bedrock_messages, static_system_prompt, dynamic_prompt, sources


def _save_ai_response(
    db_connection,
    chat_session_id: str,
    answer_text: str,
    sources: List[Dict[str, Any]],
    warning_text: Optional[str] = None,
):
    try:
        insert_message(db_connection, chat_session_id, "AI", answer_text, sources, warning_text)
        update_last_active_session(db_connection, chat_session_id)
        db_connection.commit()
    except Exception as e:
        db_connection.rollback()
        logger.error(f"Failed to save AI response: {e}")


def get_response(
    query: str,
    region: str,
    llm_region: str,
    chat_session_id: str,
    user_id: Optional[str],
    db_connection,
    save_user_message: bool = True,
    stream_callback=None,
    is_intro_message: bool = False,
) -> Dict[str, Any]:

    usage_info = {}

    try:
        # 1. Check message limit
        if user_id:
            is_under_limit, usage_info = check_limit(user_id, db_connection)
            if not is_under_limit:
                return {
                    "response": "Daily message limit exceeded. Please try again tomorrow.",
                    "sources_used": [],
                    "sessionId": chat_session_id,
                    "message_limit_exceeded": True,
                    "message_usage": usage_info,
                    "warning": None,
                }

        # 2. Handle intro message — no retrieval, no guardrails, just return the greeting
        if is_intro_message:
            try:
                ensure_session_exists(db_connection, chat_session_id, user_id)
                insert_message(db_connection, chat_session_id, "AI", config.INITIAL_PROMPT, sources=[], warning=None)
                update_last_active_session(db_connection, chat_session_id)
                db_connection.commit()
            except Exception as e:
                db_connection.rollback()
                logger.error(f"Failed to save intro message: {e}")
            if stream_callback:
                stream_callback(config.INITIAL_PROMPT)
            return {
                "response": config.INITIAL_PROMPT,
                "sources_used": [],
                "sessionId": chat_session_id,
                "message_usage": {},
                "warning": None,
            }

        # 3. Guardrail check
        if not is_intro_message:
            try:
                guardrail_result = invoke_guardrail(query, config.REGION)
            except Exception as e:
                logger.error(f"Guardrail invocation failed: {e}")
                return {
                    "response": "An error occurred processing your request.",
                    "sources_used": [],
                    "warning": None,
                }

            if guardrail_result['action'] == ACTION_BLOCKED:
                denial_text = guardrail_result['text']
                try:
                    ensure_session_exists(db_connection, chat_session_id, user_id)
                    insert_message(db_connection, chat_session_id, 'user', query, sources=None, warning=None)
                    update_last_active_session(db_connection, chat_session_id)
                    db_connection.commit()
                except Exception as db_err:
                    db_connection.rollback()
                    logger.error(f"DB error saving blocked message: {db_err}")
                _save_ai_response(db_connection, chat_session_id, denial_text, sources=[], warning_text=None)
                if stream_callback:
                    stream_callback(denial_text)
                return {
                    "response": denial_text,
                    "sources_used": [],
                    "sessionId": chat_session_id,
                    "message_usage": {},
                    "warning": None,
                }

            if guardrail_result['action'] == ACTION_ANONYMIZED:
                query = guardrail_result['text']

        # 3. Fetch user groups from DB
        user_groups = get_user_groups(user_id, db_connection) if user_id else []
        logger.info(f"User {user_id} groups for retrieval: {user_groups}")

        # 4. Prepare conversation
        bedrock_messages, static_system_prompt, dynamic_prompt, sources = _prepare_conversation(
            query=query,
            llm_region=llm_region,
            chat_session_id=chat_session_id,
            user_id=user_id,
            user_groups=user_groups,
            db_connection=db_connection,
            save_user_message=save_user_message,
        )

        if user_id and save_user_message:
            usage_info = record_message_sent(user_id, db_connection)

    except ValueError as e:
        return {"response": str(e), "sources_used": [], "warning": None}
    except Exception as e:
        logger.error(f"Prepare conversation failed: {e}")
        return {"response": "An error occurred.", "sources_used": [], "warning": None}

    # 5. Build request payload with prompt caching on static system prompt
    request_payload = {
        "modelId": config.HAIKU_ARN,
        "messages": bedrock_messages,
        "system": [
            {"text": static_system_prompt},
            {"cachePoint": {"type": "default"}},
            {"text": dynamic_prompt}
        ],
        "inferenceConfig": {
            "maxTokens": config.MAX_TOKENS,
            "temperature": config.TEMPERATURE
        }
    }

    bedrock_runtime = boto3.client("bedrock-runtime", region_name=llm_region)

    full_response_text = ""
    yielded_text = ""
    answer_started = False
    answer_text = ""
    cited_indices = []

    # 6. Stream response
    try:
        response = bedrock_runtime.converse_stream(**request_payload)
        for event in response.get("stream", []):
            if "contentBlockDelta" in event:
                delta = event["contentBlockDelta"]["delta"]
                if "text" in delta:
                    chunk = delta["text"]
                    full_response_text += chunk

                    if "<answer>" in full_response_text:
                        answer_started = True
                        target_text = full_response_text.split("<answer>", 1)[1]
                    elif not answer_started and len(full_response_text) > 300 and "<" not in full_response_text:
                        target_text = full_response_text
                    else:
                        continue

                    stop_found = False
                    for stop_tag in ["</answer>", "<cited"]:
                        stop_idx = target_text.find(stop_tag)
                        if stop_idx != -1:
                            target_text = target_text[:stop_idx]
                            stop_found = True

                    if not stop_found:
                        held_back = 0
                        for stop_tag in ["</answer>", "<cited_indices>", "</cited_indices>", "<cited"]:
                            for i in range(1, len(stop_tag)):
                                if target_text.endswith(stop_tag[:i]):
                                    held_back = max(held_back, i)
                        safe_text = target_text[:-held_back] if held_back > 0 else target_text
                    else:
                        safe_text = target_text

                    if len(safe_text) > len(yielded_text):
                        new_text = safe_text[len(yielded_text):]
                        yielded_text += new_text
                        if stream_callback and new_text:
                            stream_callback(new_text)

        # 7. Parse final answer and cited indices
        final_answer_match = re.search(r'<answer>(.*?)</answer>', full_response_text, re.DOTALL)
        if final_answer_match:
            answer_text = final_answer_match.group(1).strip()
        else:
            answer_text = full_response_text.split('<cited_indices>')[0].strip()

        indices_match = re.search(r'<cited_indices>\s*\[(.*?)\]\s*</cited_indices>', full_response_text, re.DOTALL)
        if indices_match:
            indices_str = indices_match.group(1).strip()
            if indices_str:
                try:
                    cited_indices = [int(x.strip()) for x in indices_str.split(',')]
                except ValueError:
                    pass

    except Exception as e:
        logger.error(f"Generation failed: {e}")
        answer_text = "I encountered an error generating the response."
        cited_indices = []

    # 8. Resolve cited sources
    used_sources = [source for i, source in enumerate(sources, 1) if i in cited_indices]

    # 9. Save AI response
    _save_ai_response(db_connection, chat_session_id, answer_text, used_sources)

    return {
        "response": answer_text,
        "sources_used": used_sources,
        "sessionId": chat_session_id,
        "message_usage": usage_info,
        "warning": None,
    }
