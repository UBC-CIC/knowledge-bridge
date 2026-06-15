exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE user_entra_groups RENAME TO user_memberships;

    ALTER TABLE user_memberships RENAME COLUMN group_id TO entra_group_id;

    ALTER TABLE user_memberships
      DROP CONSTRAINT IF EXISTS user_entra_groups_group_id_fkey;

    DROP INDEX IF EXISTS idx_user_entra_groups_group_id;

    CREATE INDEX IF NOT EXISTS idx_user_memberships_entra_group_id ON user_memberships(entra_group_id);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS idx_user_memberships_entra_group_id;

    CREATE INDEX IF NOT EXISTS idx_user_entra_groups_group_id ON user_memberships(group_id);

    ALTER TABLE user_memberships RENAME COLUMN entra_group_id TO group_id;

    ALTER TABLE user_memberships RENAME TO user_entra_groups;
  `);
};
