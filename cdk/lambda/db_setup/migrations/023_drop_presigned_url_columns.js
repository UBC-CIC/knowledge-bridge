exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE export_runs
      DROP COLUMN IF EXISTS presigned_url,
      DROP COLUMN IF EXISTS url_expires_at;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE export_runs
      ADD COLUMN IF NOT EXISTS presigned_url  text,
      ADD COLUMN IF NOT EXISTS url_expires_at timestamptz;
  `);
};
