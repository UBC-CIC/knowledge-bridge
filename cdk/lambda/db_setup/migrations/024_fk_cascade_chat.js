exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE chat_messages
      DROP CONSTRAINT IF EXISTS chat_messages_chat_session_id_fkey,
      ADD CONSTRAINT chat_messages_chat_session_id_fkey
        FOREIGN KEY (chat_session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE chat_messages
      DROP CONSTRAINT IF EXISTS chat_messages_chat_session_id_fkey,
      ADD CONSTRAINT chat_messages_chat_session_id_fkey
        FOREIGN KEY (chat_session_id) REFERENCES chat_sessions(id);
  `);
};
