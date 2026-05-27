exports.up = (pgm) => {
  pgm.sql(`
    -- Enable extensions
    CREATE EXTENSION IF NOT EXISTS vector;
    CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

    -- ==============================
    -- RENAME OLD ingestion_runs
    -- ==============================
    ALTER TABLE IF EXISTS ingestion_runs RENAME TO ingestion_runs_legacy;

    -- ==============================
    -- TABLES
    -- ==============================

    -- Sites (one per SharePoint site)
    CREATE TABLE IF NOT EXISTS sites (
      id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
      external_site_id text NOT NULL UNIQUE,
      name text,
      site_url text,
      status text DEFAULT 'active',
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now()
    );

    -- Site Sources (one per SharePoint list within a site)
    CREATE TABLE IF NOT EXISTS site_sources (
      id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
      site_id uuid NOT NULL REFERENCES sites(id),
      source_type text NOT NULL,
      external_source_id text NOT NULL,
      name text,
      source_url text,
      status text DEFAULT 'active',
      total_documents int DEFAULT 0,
      ingested_documents int DEFAULT 0,
      failed_documents int DEFAULT 0,
      cursor text,
      metadata jsonb DEFAULT '{}',
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now()
    );

    -- Documents (one per SharePoint list item)
    CREATE TABLE IF NOT EXISTS documents (
      id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
      site_id uuid NOT NULL REFERENCES sites(id),
      source_id uuid NOT NULL REFERENCES site_sources(id),
      document_type text NOT NULL,
      external_document_id text NOT NULL,
      title text,
      source_url text,
      raw_content jsonb DEFAULT '{}',
      text_content text,
      status text DEFAULT 'pending',
      content_hash text,
      metadata jsonb DEFAULT '{}',
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now()
    );

    -- Document Vectors (one per chunk per document)
    CREATE TABLE IF NOT EXISTS document_vectors (
      id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
      document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      chunk_index int NOT NULL,
      content text NOT NULL,
      embedding vector(1024),
      metadata jsonb DEFAULT '{}',
      created_at timestamptz DEFAULT now()
    );

    -- Ingestion Runs (job history per site/source)
    CREATE TABLE IF NOT EXISTS ingestion_runs (
      id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
      site_id uuid REFERENCES sites(id),
      source_id uuid REFERENCES site_sources(id),
      run_type text NOT NULL,
      triggered_by text,
      status text DEFAULT 'pending',
      started_at timestamptz,
      finished_at timestamptz,
      total_documents int DEFAULT 0,
      processed_documents int DEFAULT 0,
      ingested_documents int DEFAULT 0,
      skipped_documents int DEFAULT 0,
      failed_documents int DEFAULT 0,
      error_message text,
      metadata jsonb DEFAULT '{}'
    );

    -- ==============================
    -- INDEXES
    -- ==============================
    CREATE INDEX IF NOT EXISTS idx_site_sources_site_id ON site_sources(site_id);
    CREATE INDEX IF NOT EXISTS idx_documents_site_id ON documents(site_id);
    CREATE INDEX IF NOT EXISTS idx_documents_source_id ON documents(source_id);
    CREATE INDEX IF NOT EXISTS idx_documents_external_id ON documents(external_document_id);
    CREATE INDEX IF NOT EXISTS idx_documents_content_hash ON documents(content_hash);
    CREATE INDEX IF NOT EXISTS idx_document_vectors_document_id ON document_vectors(document_id);
    CREATE INDEX IF NOT EXISTS idx_ingestion_runs_site_id ON ingestion_runs(site_id);

    -- ivfflat index for cosine similarity search (build after data is loaded)
    CREATE INDEX IF NOT EXISTS idx_document_vectors_embedding
      ON document_vectors
      USING ivfflat (embedding vector_cosine_ops)
      WITH (lists = 100);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS ingestion_runs CASCADE;
    DROP TABLE IF EXISTS document_vectors CASCADE;
    DROP TABLE IF EXISTS documents CASCADE;
    DROP TABLE IF EXISTS site_sources CASCADE;
    DROP TABLE IF EXISTS sites CASCADE;

    ALTER TABLE IF EXISTS ingestion_runs_legacy RENAME TO ingestion_runs;
  `);
};
