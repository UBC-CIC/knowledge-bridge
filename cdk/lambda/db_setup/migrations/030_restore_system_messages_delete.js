exports.up = (pgm) => {
  pgm.sql(`
    GRANT DELETE ON system_messages TO readwrite;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    REVOKE DELETE ON system_messages FROM readwrite;
  `);
};
