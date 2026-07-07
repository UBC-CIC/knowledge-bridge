exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE site_sources
      DROP CONSTRAINT IF EXISTS site_sources_site_id_fkey,
      ADD CONSTRAINT site_sources_site_id_fkey
        FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE CASCADE;

    ALTER TABLE documents
      DROP CONSTRAINT IF EXISTS documents_site_id_fkey,
      ADD CONSTRAINT documents_site_id_fkey
        FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE CASCADE;

    ALTER TABLE documents
      DROP CONSTRAINT IF EXISTS documents_source_id_fkey,
      ADD CONSTRAINT documents_source_id_fkey
        FOREIGN KEY (source_id) REFERENCES site_sources(id) ON DELETE CASCADE;

    ALTER TABLE ingestion_runs
      DROP CONSTRAINT IF EXISTS ingestion_runs_site_id_fkey,
      ADD CONSTRAINT ingestion_runs_site_id_fkey
        FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE SET NULL;

    ALTER TABLE ingestion_runs
      DROP CONSTRAINT IF EXISTS ingestion_runs_source_id_fkey,
      ADD CONSTRAINT ingestion_runs_source_id_fkey
        FOREIGN KEY (source_id) REFERENCES site_sources(id) ON DELETE SET NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE site_sources
      DROP CONSTRAINT IF EXISTS site_sources_site_id_fkey,
      ADD CONSTRAINT site_sources_site_id_fkey
        FOREIGN KEY (site_id) REFERENCES sites(id);

    ALTER TABLE documents
      DROP CONSTRAINT IF EXISTS documents_site_id_fkey,
      ADD CONSTRAINT documents_site_id_fkey
        FOREIGN KEY (site_id) REFERENCES sites(id);

    ALTER TABLE documents
      DROP CONSTRAINT IF EXISTS documents_source_id_fkey,
      ADD CONSTRAINT documents_source_id_fkey
        FOREIGN KEY (source_id) REFERENCES site_sources(id);

    ALTER TABLE ingestion_runs
      DROP CONSTRAINT IF EXISTS ingestion_runs_site_id_fkey,
      ADD CONSTRAINT ingestion_runs_site_id_fkey
        FOREIGN KEY (site_id) REFERENCES sites(id);

    ALTER TABLE ingestion_runs
      DROP CONSTRAINT IF EXISTS ingestion_runs_source_id_fkey,
      ADD CONSTRAINT ingestion_runs_source_id_fkey
        FOREIGN KEY (source_id) REFERENCES site_sources(id);
  `);
};
