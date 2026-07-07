exports.up = (pgm) => {
  pgm.sql(`
    REVOKE DELETE ON system_settings FROM readwrite;
    REVOKE DELETE ON system_messages FROM readwrite;
    REVOKE INSERT, UPDATE, DELETE ON entra_groups FROM readwrite;
    REVOKE INSERT, UPDATE, DELETE ON site_source_access FROM readwrite;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    GRANT DELETE ON system_settings TO readwrite;
    GRANT DELETE ON system_messages TO readwrite;
    GRANT INSERT, UPDATE, DELETE ON entra_groups TO readwrite;
    GRANT INSERT, UPDATE, DELETE ON site_source_access TO readwrite;
  `);
};
