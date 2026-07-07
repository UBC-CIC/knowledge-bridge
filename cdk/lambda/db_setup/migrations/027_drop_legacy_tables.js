exports.up = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS ingestion_runs_legacy;
    DROP TABLE IF EXISTS data_sources;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`SELECT 1;`);
};
