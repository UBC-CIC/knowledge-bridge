
import json
import logging
import uuid
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

def get_exchange_count(chat_session_id: str, db_connection) -> int:
    """
    Counts the number of exchanges (User + AI pairs) in a session.
    """
    try:
        with db_connection.cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM chat_messages WHERE chat_session_id = %s", (chat_session_id,))
            msg_count = cur.fetchone()[0]
            # Each exchange is roughly 2 messages (User + AI)
            exchange_count = msg_count // 2
            return exchange_count
    except Exception as e:
        logger.error(f"Could not count history: {e}")
        return 0

def fetch_recent_messages(
    db_connection,
    chat_session_id: str,
) -> List[Dict[str, Any]]:    
    """
    Fetch recent messages for a chat session (oldest->newest).
    """
    with db_connection.cursor() as cur:
        # Note: Added 'sources' (LIMIT 20 is small enough to include full json) or keep it lightweight
        # Previous implementation kept it lightweight. But chat.py retrieves sources?
        # Actually fetch_recent_messages is used for context. Context needs content only?
        # Check chat.py usage. It uses msg['sender'] and msg['content'].
        # So current query is fine.
        cur.execute(
            """
            SELECT sender, content, created_at
            FROM chat_messages
            WHERE chat_session_id = %s
            ORDER BY created_at ASC
            LIMIT %s
            """,
            (chat_session_id, 20)
        )
        rows = cur.fetchall()

    messages = []
    for sender, content, created_at in rows:
        messages.append({
            "sender": sender,          # 'user' or 'AI'
            "content": content,
            "created_at": created_at.isoformat() if created_at else None
        })
    return messages

def ensure_user_exists(db_connection, user_id: str) -> None:
    try:
        with db_connection.cursor() as cur:
            # We use a dummy email for now as we don't have it from the token in all cases yet
            dummy_email = f"user_{user_id[:8]}@example.com" 
            cur.execute(
                """
                INSERT INTO users (id, email, display_name, role, created_at, last_seen_at, messages_sent, messages_window_started_at, metadata)
                VALUES (%s, %s, %s, %s, NOW(), NOW(), 0, NOW(), '{}'::jsonb)
                ON CONFLICT (id) DO NOTHING
                """,
                (user_id, dummy_email, "Student", "student")
            )
    except Exception as e:
        logger.error(f"ensure_user_exists failed: {e}")
        # Allow proceed as key constraint might be handled or user exists

def ensure_session_exists(db_connection, chat_session_id: str, user_id: Optional[str]) -> None:
    if not user_id:
        return
    ensure_user_exists(db_connection, user_id)
    try:
        with db_connection.cursor() as cur:
            cur.execute(
                """
                INSERT INTO chat_sessions (id, user_id, title, created_at, last_active_at)
                VALUES (%s, %s, %s, NOW(), NOW())
                ON CONFLICT (id) DO NOTHING
                """,
                (chat_session_id, user_id, "New Session")
            )
    except Exception as e:
        logger.error(f"ensure_session_exists failed: {e}")

def insert_message(
    db_connection,
    chat_session_id: str,
    sender: str,
    content: str,
    sources: Optional[List[Dict[str, Any]]] = None,
    warning: Optional[str] = None
) -> str:
    message_id = str(uuid.uuid4())
    sources_json = json.dumps(sources or [])
    try:
        with db_connection.cursor() as cur:
            cur.execute(
                """
                INSERT INTO chat_messages (id, chat_session_id, sender, content, sources, warning, created_at)
                VALUES (%s, %s, %s, %s, %s::jsonb, %s, NOW())
                """,
                (message_id, chat_session_id, sender, content, sources_json, warning)
            )
    except Exception as e:
        logger.error(f"insert_message failed: {e}")
        raise e
    return message_id

def update_last_active_session(db_connection, chat_session_id: str) -> None:
    try:
        with db_connection.cursor() as cur:
            cur.execute("UPDATE chat_sessions SET last_active_at = NOW() WHERE id = %s", (chat_session_id,))
    except Exception as e:
        logger.error(f"update_last_active_session failed: {e}")

def fetch_system_config(db_connection) -> Dict[str, Any]:
    """
    Fetches system_messages (latest active version per type) and system_settings.
    """
    config = {'messages': {}, 'settings': {}}
    try:
        # Fetch System Messages
        # DISTINCT ON (type) ensures we get one row per type.
        # ORDER BY type, version DESC ensure that row is the highest version.
        with db_connection.cursor() as cur:
            cur.execute("""
                SELECT DISTINCT ON (type) type, content
                FROM system_messages
                WHERE is_active = true
                ORDER BY type, version DESC
            """)
            rows = cur.fetchall()
            for row in rows:
                config['messages'][row[0]] = row[1]

        # Fetch System Settings
        with db_connection.cursor() as cur:
            cur.execute("""
                SELECT max_messages_per_day,
                       min_messages_before_suggest,
                       max_characters_per_user_message,
                       max_characters_per_ai_message,
                       temperature,
                       top_p,
                       support_score_threshold,
                       scope_alignment_score_threshold,
                       grounded_threshold,
                       partially_grounded_threshold,
                       specialization_list
                FROM system_settings
                ORDER BY updated_at DESC
                LIMIT 1
            """)
            row = cur.fetchone()
            if row:
                config['settings'] = {
                    'max_messages_per_day': row[0],
                    'min_messages_before_suggest': row[1],
                    'max_characters_per_user_message': row[2],
                    'max_characters_per_ai_message': row[3],
                    'temperature': float(row[4]) if row[4] is not None else 0.7,
                    'top_p': float(row[5]) if row[5] is not None else 0.9,
                    'support_score_threshold': float(row[6]) if row[6] is not None else 0.25,
                    'scope_alignment_score_threshold': float(row[7]) if row[7] is not None else 0.25,
                    'grounded_threshold': float(row[8]) if row[8] is not None else 0.75,
                    'partially_grounded_threshold': float(row[9]) if row[9] is not None else 0.50,
                    'specialization_list': row[10]
                }
    except Exception as e:
        logger.error(f"fetch_system_config failed: {e}")
        # Return what we have (empty or partial)
    return config
