exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE documents
      ADD CONSTRAINT uq_documents_source_external
      UNIQUE (source_id, external_document_id);

    ALTER TABLE site_sources
      ADD CONSTRAINT uq_site_sources_site_external
      UNIQUE (site_id, external_source_id);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE documents DROP CONSTRAINT IF EXISTS uq_documents_source_external;
    ALTER TABLE site_sources DROP CONSTRAINT IF EXISTS uq_site_sources_site_external;
  `);
};
