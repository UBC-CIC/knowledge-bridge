exports.up = (pgm) => {
  pgm.sql(`
    CREATE TYPE feedback_category AS ENUM ('Not helpful', 'Inaccurate', 'Off-topic', 'Other');

    ALTER TABLE message_ratings
      ADD COLUMN IF NOT EXISTS category feedback_category;

    CREATE INDEX IF NOT EXISTS idx_message_ratings_category ON message_ratings(category);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS idx_message_ratings_category;
    ALTER TABLE message_ratings DROP COLUMN IF EXISTS category;
    DROP TYPE IF EXISTS feedback_category;
  `);
};
