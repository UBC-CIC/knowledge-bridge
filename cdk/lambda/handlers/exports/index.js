const { PutObjectCommand } = require("@aws-sdk/client-s3");
const chatExport = require("./chatExport");
const analyticsExport = require("./analyticsExport");

// To add a new export type: create a handler with build(exportRunId, run, { sqlConnection })
// returning { body, rowCount, contentDisposition, notification }, then register it here.
const registry = {
  chat: {
    handler:     chatExport,
    s3Key:       (id) => `exports/chat/${id}.json`,
    contentType: 'application/json',
  },
  analytics: {
    handler:     analyticsExport,
    s3Key:       (id) => `exports/analytics/${id}.csv`,
    contentType: 'text/csv',
  },
};

function resolve(exportRun) {
  if (exportRun.export_type && registry[exportRun.export_type]) return registry[exportRun.export_type];
  // Fallback for rows created before export_type column existed
  if (exportRun.scope === 'analytics') return registry.analytics;
  return registry.chat;
}

async function run(exportRunId, exportRun, { sqlConnection, s3Client, publishNotification }) {
  const entry = resolve(exportRun);
  const s3Key = entry.s3Key(exportRunId);

  const { body, rowCount, contentDisposition, notification } =
    await entry.handler.build(exportRunId, exportRun, { sqlConnection });

  await s3Client.send(new PutObjectCommand({
    Bucket: process.env.EXPORT_BUCKET_NAME,
    Key: s3Key,
    Body: body,
    ContentType: entry.contentType,
    ContentDisposition: contentDisposition,
  }));

  await sqlConnection`
    UPDATE export_runs
    SET status = 'completed', s3_key = ${s3Key},
        row_count = ${rowCount}, completed_at = now()
    WHERE id = ${exportRunId}
  `;
  console.log(`Export ${exportRunId} completed: ${rowCount} rows/records`);

  try {
    await publishNotification({
      userId: exportRun.requested_by.toString(),
      type: 'export_completed',
      metadata: { export_run_id: exportRunId },
      ...notification,
    });
  } catch (notifyErr) {
    console.error('Failed to publish export_completed notification:', notifyErr);
  }
}

module.exports = { run };
