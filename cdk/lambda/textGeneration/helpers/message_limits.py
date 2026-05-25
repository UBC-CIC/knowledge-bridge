import logging
from datetime import datetime, timezone, timedelta
import helpers.config as config

logger = logging.getLogger(__name__)

def check_limit(user_id: str, db_connection) -> tuple[bool, dict]:
    """
    Checks if a user has exceeded their daily message limit.
    Always reads directly from the DB.
    Does NOT write to the DB.

    Returns:
        (is_under_limit: bool, usage_info: dict)
    """
    now_utc = datetime.now(timezone.utc)

    try:
        with db_connection.cursor() as cur:
            cur.execute(
                """
                SELECT messages_sent, messages_window_started_at
                FROM users
                WHERE id = %s
                """,
                (user_id,)
            )
            row = cur.fetchone()

            if not row:
                usage_info = {
                    "messages_sent": 0,
                    "limit": config.MAX_MESSAGES_PER_DAY,
                    "remaining": config.MAX_MESSAGES_PER_DAY,
                    "reset_at": (now_utc + timedelta(hours=24)).isoformat()
                }
                return True, usage_info

            messages_sent = row[0] or 0
            window_start = row[1]

            if window_start is None:
                window_start = now_utc

            if window_start.tzinfo is None:
                window_start = window_start.replace(tzinfo=timezone.utc)

            if now_utc - window_start >= timedelta(hours=24):
                messages_sent = 0
                window_start = now_utc

            reset_at = (window_start + timedelta(hours=24)).isoformat()

            usage_info = {
                "messages_sent": messages_sent,
                "limit": config.MAX_MESSAGES_PER_DAY,
                "remaining": max(0, config.MAX_MESSAGES_PER_DAY - messages_sent),
                "reset_at": reset_at
            }

            return messages_sent < config.MAX_MESSAGES_PER_DAY, usage_info

    except Exception as e:
        logger.error(f"Error checking message limit DB: {e}")
        return False, {"error": "Unable to verify message limits from DB."}

def record_message_sent(user_id: str, db_connection) -> dict:
    """
    Atomically increments the user's message counter by 1,
    resetting the 24-hour window if it has expired.

    Returns:
        usage_info: dict with message stats
    """
    now_utc = datetime.now(timezone.utc)

    try:
        with db_connection.cursor() as cur:
            cur.execute(
                """
                UPDATE users
                SET
                    messages_sent = CASE
                        WHEN messages_window_started_at < NOW() - INTERVAL '24 hours' THEN 1
                        ELSE messages_sent + 1
                    END,
                    messages_window_started_at = CASE
                        WHEN messages_window_started_at < NOW() - INTERVAL '24 hours' THEN NOW()
                        ELSE messages_window_started_at
                    END
                WHERE id = %s
                RETURNING messages_sent, messages_window_started_at
                """,
                (user_id,)
            )
            row = cur.fetchone()

            if not row:
                return {
                    "messages_sent": 0,
                    "limit": config.MAX_MESSAGES_PER_DAY,
                    "remaining": config.MAX_MESSAGES_PER_DAY,
                    "reset_at": (now_utc + timedelta(hours=24)).isoformat()
                }

            messages_sent = row[0] or 0
            window_start = row[1]

            db_connection.commit()

            if window_start is None:
                window_start = now_utc

            if window_start.tzinfo is None:
                window_start = window_start.replace(tzinfo=timezone.utc)

            reset_at = (window_start + timedelta(hours=24)).isoformat()

            return {
                "messages_sent": messages_sent,
                "limit": config.MAX_MESSAGES_PER_DAY,
                "remaining": max(0, config.MAX_MESSAGES_PER_DAY - messages_sent),
                "reset_at": reset_at
            }

    except Exception as e:
        logger.error(f"Error recording message usage: {e}")
        db_connection.rollback()
        return {
            "messages_sent": 0,
            "limit": config.MAX_MESSAGES_PER_DAY,
            "remaining": 0,
            "reset_at": (now_utc + timedelta(hours=24)).isoformat()
        }