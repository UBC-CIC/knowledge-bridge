const {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} = require("@aws-sdk/client-apigatewaymanagementapi");

async function writeNotification(sql, { userId, type, title, message, metadata = {} }) {
  const [notification] = await sql`
    INSERT INTO notifications (user_id, type, title, message, metadata)
    VALUES (
      ${userId}::uuid,
      ${type}::notification_type,
      ${title},
      ${message},
      ${JSON.stringify(metadata)}::jsonb
    )
    RETURNING id::text, user_id::text, type::text, title, message, metadata, created_at
  `;

  const connections = await sql`
    SELECT connection_id FROM ws_connections WHERE user_id::text = ${userId}
  `;

  if (!connections.length) return notification;

  const apigw = new ApiGatewayManagementApiClient({
    endpoint: process.env.WEBSOCKET_API_ENDPOINT,
  });
  const payload = Buffer.from(JSON.stringify({ type: "notification", notification }));

  await Promise.allSettled(
    connections.map(async (conn) => {
      try {
        await apigw.send(
          new PostToConnectionCommand({ ConnectionId: conn.connection_id, Data: payload })
        );
      } catch (err) {
        if (err.$metadata?.httpStatusCode === 410) {
          await sql`DELETE FROM ws_connections WHERE connection_id = ${conn.connection_id}`;
        }
      }
    })
  );

  return notification;
}

async function writeNotificationToAllAdmins(sql, { type, title, message, metadata = {} }) {
  const admins = await sql`SELECT id::text FROM users WHERE role::text = 'admin'`;
  await Promise.allSettled(
    admins.map((a) => writeNotification(sql, { userId: a.id, type, title, message, metadata }))
  );
}

module.exports = { writeNotification, writeNotificationToAllAdmins };
