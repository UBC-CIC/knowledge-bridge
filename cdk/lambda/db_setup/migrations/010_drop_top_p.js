/**
 * Migration 010: Drop top_p from system_settings — unused, temperature is used instead.
 */

exports.up = (pgm) => {
  pgm.sql(`ALTER TABLE system_settings DROP COLUMN IF EXISTS top_p;`);
};

exports.down = (pgm) => {
  pgm.sql(`ALTER TABLE system_settings ADD COLUMN IF NOT EXISTS top_p float DEFAULT 0.9;`);
};
