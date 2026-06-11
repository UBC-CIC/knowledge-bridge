exports.up = (pgm) => {
  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_chat_messages_session_created
      ON chat_messages(chat_session_id, created_at ASC);

    CREATE INDEX IF NOT EXISTS idx_chat_sessions_user_active
      ON chat_sessions(user_id, last_active_at DESC NULLS LAST);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS idx_chat_messages_session_created;
    DROP INDEX IF EXISTS idx_chat_sessions_user_active;
  `);
};
