exports.up = (pgm) => {
  pgm.sql(`ALTER TABLE users DROP COLUMN IF EXISTS role`);
  pgm.sql(`DROP TYPE IF EXISTS user_role`);
};

exports.down = (pgm) => {
  // no-op
};
