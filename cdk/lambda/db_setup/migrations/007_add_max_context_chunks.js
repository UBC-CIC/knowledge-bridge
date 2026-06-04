/**
 * Migration 007: Add max_context_chunks to system_settings
 */

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE system_settings
      ADD COLUMN IF NOT EXISTS max_context_chunks int DEFAULT 10;

    UPDATE system_settings SET max_context_chunks = 10 WHERE max_context_chunks IS NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE system_settings DROP COLUMN IF EXISTS max_context_chunks;
  `);
};
