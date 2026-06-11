/**
 * Migration 012: Add ingestion_schedule table — stores current schedule config with last-updated metadata.
 */

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS ingestion_schedule (
      id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
      cron text NOT NULL,
      timezone text NOT NULL DEFAULT 'America/Vancouver',
      enabled boolean NOT NULL DEFAULT true,
      force_full boolean NOT NULL DEFAULT false,
      updated_by uuid REFERENCES users(id),
      updated_at timestamptz DEFAULT now()
    );
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS ingestion_schedule;`);
};
