exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS message_ratings (
      id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
      message_id uuid NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
      user_id uuid NOT NULL REFERENCES users(id),
      is_positive boolean NOT NULL,
      comment text,
      created_at timestamptz DEFAULT now(),
      UNIQUE (message_id, user_id)
    );

    CREATE INDEX IF NOT EXISTS idx_message_ratings_message_id ON message_ratings(message_id);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS message_ratings;`);
};
