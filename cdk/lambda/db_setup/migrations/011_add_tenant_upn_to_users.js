/**
 * Migration 011: Add tenant_upn to users table.
 * Stores the user's UPN in the resource tenant (canonical format with #EXT# for guests).
 * Used for Graph API calls. Display email stored separately in the email column.
 */

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS tenant_upn text;
    CREATE INDEX IF NOT EXISTS idx_users_tenant_upn ON users(tenant_upn);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS idx_users_tenant_upn;
    ALTER TABLE users DROP COLUMN IF EXISTS tenant_upn;
  `);
};
