exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS ws_connections (
      connection_id   text        PRIMARY KEY,
      user_id         uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      connected_at    timestamptz NOT NULL DEFAULT now(),
      domain_name     text        NOT NULL,
      stage           text        NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_ws_connections_user_id ON ws_connections(user_id);

    DO $$ BEGIN
      CREATE TYPE notification_type AS ENUM (
        'export_completed', 'export_failed',
        'ingestion_completed', 'ingestion_failed'
      );
    EXCEPTION WHEN duplicate_object THEN null; END $$;

    CREATE TABLE IF NOT EXISTS notifications (
      id          uuid              PRIMARY KEY DEFAULT uuid_generate_v4(),
      user_id     uuid              NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type        notification_type NOT NULL,
      title       text              NOT NULL,
      message     text              NOT NULL,
      metadata    jsonb             NOT NULL DEFAULT '{}',
      created_at  timestamptz       NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON notifications(user_id);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS notifications;
    DROP TABLE IF EXISTS ws_connections;
    DROP TYPE  IF EXISTS notification_type;
  `);
};
