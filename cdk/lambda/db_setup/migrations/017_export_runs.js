exports.up = (pgm) => {
  pgm.sql(`
    DO $$ BEGIN
      CREATE TYPE export_status AS ENUM ('pending', 'processing', 'completed', 'failed');
    EXCEPTION WHEN duplicate_object THEN null; END $$;

    DO $$ BEGIN
      CREATE TYPE export_scope AS ENUM ('all', 'group', 'user');
    EXCEPTION WHEN duplicate_object THEN null; END $$;

    CREATE TABLE IF NOT EXISTS export_runs (
      id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
      requested_by    uuid NOT NULL REFERENCES users(id),
      status          export_status NOT NULL DEFAULT 'pending',
      scope           export_scope  NOT NULL DEFAULT 'all',
      scope_id        uuid,
      s3_key          text,
      presigned_url   text,
      url_expires_at  timestamptz,
      error_message   text,
      row_count       int,
      requested_at    timestamptz NOT NULL DEFAULT now(),
      completed_at    timestamptz
    );

    CREATE INDEX IF NOT EXISTS idx_export_runs_requested_by ON export_runs(requested_by);
    CREATE INDEX IF NOT EXISTS idx_export_runs_status ON export_runs(status);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS export_runs;
    DROP TYPE IF EXISTS export_scope;
    DROP TYPE IF EXISTS export_status;
  `);
};
