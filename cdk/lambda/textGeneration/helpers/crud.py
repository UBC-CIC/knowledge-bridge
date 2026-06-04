
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
    limit: int = 20,
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
            (chat_session_id, limit)
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
            dummy_email = f"user_{user_id[:8]}@example.com"
            cur.execute(
                """
                INSERT INTO users (id, email, display_name, created_at, last_seen_at, messages_sent, messages_window_started_at, metadata)
                VALUES (%s, %s, %s, NOW(), NOW(), 0, NOW(), '{}'::jsonb)
                ON CONFLICT (id) DO NOTHING
                """,
                (user_id, dummy_email, "User")
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

def get_user_groups(user_id: str, db_connection) -> List[str]:
    """Fetch Entra group IDs for a user from the DB."""
    try:
        with db_connection.cursor() as cur:
            cur.execute(
                "SELECT entra_group_ids FROM users WHERE id = %s",
                (user_id,)
            )
            row = cur.fetchone()
            if row and row[0]:
                groups = [g.lower() for g in row[0] if g]
                logger.info(f"User {user_id} groups: {groups}")
                return groups
            logger.warning(f"No Entra groups found for user {user_id}")
            return []
    except Exception as e:
        logger.error(f"get_user_groups failed for {user_id}: {e}")
        return []


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
                       max_characters_per_user_message,
                       max_characters_per_ai_message,
                       temperature,
                       support_score_threshold,
                       scope_alignment_score_threshold,
                       grounded_threshold,
                       partially_grounded_threshold,
                       max_context_chunks,
                       max_history_messages
                FROM system_settings
                ORDER BY updated_at DESC
                LIMIT 1
            """)
            row = cur.fetchone()
            if row:
                config['settings'] = {
                    'max_messages_per_day': row[0],
                    'max_characters_per_user_message': row[1],
                    'max_characters_per_ai_message': row[2],
                    'temperature': row[3],
                    'support_score_threshold': row[4],
                    'scope_alignment_score_threshold': row[5],
                    'grounded_threshold': row[6],
                    'partially_grounded_threshold': row[7],
                    'max_context_chunks': row[8],
                    'max_history_messages': row[9],
                }
    except Exception as e:
        logger.error(f"fetch_system_config failed: {e}")
        # Return what we have (empty or partial)
    return config
