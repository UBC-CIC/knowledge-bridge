exports.up = (pgm) => {
  pgm.sql(`
    ALTER TYPE export_scope ADD VALUE IF NOT EXISTS 'analytics';

    ALTER TABLE export_runs
      ADD COLUMN IF NOT EXISTS metadata jsonb DEFAULT '{}';
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE export_runs DROP COLUMN IF EXISTS metadata;
  `);
};
