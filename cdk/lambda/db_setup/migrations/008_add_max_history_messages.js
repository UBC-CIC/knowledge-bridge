/**
 * Migration 008: Add max_history_messages to system_settings
 */

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE system_settings
      ADD COLUMN IF NOT EXISTS max_history_messages int DEFAULT 20;

    UPDATE system_settings SET max_history_messages = 20 WHERE max_history_messages IS NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE system_settings DROP COLUMN IF EXISTS max_history_messages;
  `);
};
