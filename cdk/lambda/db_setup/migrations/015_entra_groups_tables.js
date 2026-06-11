exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS entra_groups (
      id text PRIMARY KEY,
      display_name text
    );

    CREATE TABLE IF NOT EXISTS user_entra_groups (
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      group_id text NOT NULL REFERENCES entra_groups(id) ON DELETE CASCADE,
      PRIMARY KEY (user_id, group_id)
    );

    CREATE INDEX IF NOT EXISTS idx_user_entra_groups_group_id ON user_entra_groups(group_id);

    ALTER TABLE users
      DROP COLUMN IF EXISTS entra_group_ids;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS entra_group_ids text[] DEFAULT '{}';

    DROP TABLE IF EXISTS user_entra_groups;
    DROP TABLE IF EXISTS entra_groups;
  `);
};
