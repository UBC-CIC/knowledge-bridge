exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS site_source_access (
      site_source_id uuid NOT NULL REFERENCES site_sources(id) ON DELETE CASCADE,
      entra_group_id text NOT NULL REFERENCES entra_groups(id) ON DELETE CASCADE,
      created_at timestamptz DEFAULT now(),
      PRIMARY KEY (site_source_id, entra_group_id)
    );

    CREATE INDEX IF NOT EXISTS idx_site_source_access_group
      ON site_source_access(entra_group_id);

    -- Backfill from existing metadata
    INSERT INTO site_source_access (site_source_id, entra_group_id)
    SELECT id, jsonb_array_elements_text(metadata->'group_ids')
    FROM site_sources
    WHERE metadata ? 'group_ids'
      AND jsonb_array_length(metadata->'group_ids') > 0
    ON CONFLICT DO NOTHING;

    -- Remove group_ids and permission_scope from metadata (now in join table)
    UPDATE site_sources
    SET metadata = metadata - 'group_ids' - 'permission_scope'
    WHERE metadata ? 'group_ids';
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS site_source_access;`);
};
