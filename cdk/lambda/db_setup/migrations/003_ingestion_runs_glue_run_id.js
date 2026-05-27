exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE ingestion_runs
      ADD COLUMN IF NOT EXISTS glue_run_id text;

    CREATE INDEX IF NOT EXISTS idx_ingestion_runs_glue_run_id
      ON ingestion_runs(glue_run_id);

    CREATE INDEX IF NOT EXISTS idx_ingestion_runs_status
      ON ingestion_runs(status);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS idx_ingestion_runs_glue_run_id;
    DROP INDEX IF EXISTS idx_ingestion_runs_status;
    ALTER TABLE ingestion_runs DROP COLUMN IF EXISTS glue_run_id;
  `);
};
