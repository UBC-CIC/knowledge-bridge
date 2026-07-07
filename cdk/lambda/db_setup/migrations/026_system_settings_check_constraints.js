exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE system_settings
      ADD CONSTRAINT chk_temperature
        CHECK (temperature >= 0 AND temperature <= 1),
      ADD CONSTRAINT chk_support_score_threshold
        CHECK (support_score_threshold >= 0 AND support_score_threshold <= 1),
      ADD CONSTRAINT chk_scope_alignment_score_threshold
        CHECK (scope_alignment_score_threshold >= 0 AND scope_alignment_score_threshold <= 1),
      ADD CONSTRAINT chk_grounded_threshold
        CHECK (grounded_threshold >= 0 AND grounded_threshold <= 1),
      ADD CONSTRAINT chk_partially_grounded_threshold
        CHECK (partially_grounded_threshold >= 0 AND partially_grounded_threshold <= 1),
      ADD CONSTRAINT chk_max_messages_per_day
        CHECK (max_messages_per_day > 0),
      ADD CONSTRAINT chk_max_characters_per_user_message
        CHECK (max_characters_per_user_message > 0),
      ADD CONSTRAINT chk_max_characters_per_ai_message
        CHECK (max_characters_per_ai_message > 0),
      ADD CONSTRAINT chk_max_context_chunks
        CHECK (max_context_chunks > 0),
      ADD CONSTRAINT chk_max_history_messages
        CHECK (max_history_messages > 0);

    CREATE UNIQUE INDEX IF NOT EXISTS uq_system_settings_singleton
      ON system_settings ((true));
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE system_settings
      DROP CONSTRAINT IF EXISTS chk_temperature,
      DROP CONSTRAINT IF EXISTS chk_support_score_threshold,
      DROP CONSTRAINT IF EXISTS chk_scope_alignment_score_threshold,
      DROP CONSTRAINT IF EXISTS chk_grounded_threshold,
      DROP CONSTRAINT IF EXISTS chk_partially_grounded_threshold,
      DROP CONSTRAINT IF EXISTS chk_max_messages_per_day,
      DROP CONSTRAINT IF EXISTS chk_max_characters_per_user_message,
      DROP CONSTRAINT IF EXISTS chk_max_characters_per_ai_message,
      DROP CONSTRAINT IF EXISTS chk_max_context_chunks,
      DROP CONSTRAINT IF EXISTS chk_max_history_messages;

    DROP INDEX IF EXISTS uq_system_settings_singleton;
  `);
};
