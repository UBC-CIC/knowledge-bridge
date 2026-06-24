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

  const wsEndpoint = (process.env.WEBSOCKET_API_ENDPOINT || "").replace(/^wss:\/\//, "https://");
  const apigw = new ApiGatewayManagementApiClient({ endpoint: wsEndpoint });
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
        } else {
          console.error(`[NotificationWriter] PostToConnection failed for ${conn.connection_id}:`, err.message);
        }
      }
    })
  );

  return notification;
}

module.exports = { writeNotification };
