exports.up = (pgm) => {
  pgm.sql(`
    DO $$ BEGIN
      CREATE TYPE export_type AS ENUM ('chat', 'analytics');
    EXCEPTION WHEN duplicate_object THEN null; END $$;

    ALTER TABLE export_runs
      ADD COLUMN IF NOT EXISTS export_type export_type NOT NULL DEFAULT 'chat';
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE export_runs DROP COLUMN IF EXISTS export_type;
    DROP TYPE IF EXISTS export_type;
  `);
};
