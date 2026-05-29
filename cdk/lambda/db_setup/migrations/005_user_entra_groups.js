exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS entra_group_ids text[] DEFAULT '{}',
      ADD COLUMN IF NOT EXISTS entra_groups_refreshed_at timestamptz;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE users
      DROP COLUMN IF EXISTS entra_group_ids,
      DROP COLUMN IF EXISTS entra_groups_refreshed_at;
  `);
};
