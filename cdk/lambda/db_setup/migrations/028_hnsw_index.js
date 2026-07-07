exports.up = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS idx_document_vectors_embedding;

    CREATE INDEX idx_document_vectors_embedding
      ON document_vectors
      USING hnsw (embedding vector_cosine_ops)
      WITH (m = 16, ef_construction = 64);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS idx_document_vectors_embedding;

    CREATE INDEX idx_document_vectors_embedding
      ON document_vectors
      USING ivfflat (embedding vector_cosine_ops)
      WITH (lists = 100);
  `);
};
