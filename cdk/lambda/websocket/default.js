const { LambdaClient, InvokeCommand } = require("@aws-sdk/client-lambda");
const {
  SecretsManagerClient,
  GetSecretValueCommand,
} = require("@aws-sdk/client-secrets-manager");
const postgres = require("postgres");

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const validateUUID = (value, fieldName = "id") => {
  if (!value || typeof value !== "string") return { valid: false, error: `${fieldName} is required` };
  if (!UUID_REGEX.test(value.trim())) return { valid: false, error: `${fieldName} must be a valid UUID` };
  return { valid: true };
};

const sanitizeString = (value, maxLength = 10000) => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed.slice(0, maxLength);
};

const lambda = new LambdaClient({});
const secretsManager = new SecretsManagerClient();
let sqlConnection;

const initDb = async () => {
  if (sqlConnection) return;
  const res = await secretsManager.send(
    new GetSecretValueCommand({ SecretId: process.env.SM_DB_CREDENTIALS })
  );
  const creds = JSON.parse(res.SecretString);
  sqlConnection = postgres({
    host: process.env.RDS_PROXY_ENDPOINT,
    port: creds.port,
    username: creds.username,
    password: creds.password,
    database: creds.dbname,
    ssl: { rejectUnauthorized: true },
  });
  await sqlConnection`SELECT 1`;
};

exports.handler = async (event) => {
  console.log("WebSocket message received:", {
    connectionId: event.requestContext.connectionId,
    routeKey: event.requestContext.routeKey,
    // Omit body to avoid logging sensitive data like user_id and chat_session_id
    timestamp: new Date().toISOString(),
  });

  try {
    const body = JSON.parse(event.body);
    const { action, query, chat_session_id, is_intro_message } = body;
    const connectionId = event.requestContext.connectionId;

    if (action === "ping") {
      return { statusCode: 200, body: JSON.stringify({ type: "pong" }) };
    }

    if (action === "generate_text") {
      // Validate inputs before invoking text generation Lambda
      const sanitizedQuery = sanitizeString(query, 10000);
      if (!sanitizedQuery) {
        return { statusCode: 400, body: JSON.stringify({ error: "query is required and must be a non-empty string" }) };
      }

      const sessionValidation = validateUUID(chat_session_id, "chat_session_id");
      if (!sessionValidation.valid) {
        return { statusCode: 400, body: JSON.stringify({ error: sessionValidation.error }) };
      }

      // Derive user_id from the authenticated connection record, not the client payload
      await initDb();
      const [conn] = await sqlConnection`
        SELECT user_id FROM ws_connections WHERE connection_id = ${connectionId}
      `;
      if (!conn) {
        return { statusCode: 403, body: JSON.stringify({ error: "Connection not found" }) };
      }
      const user_id = conn.user_id;

      // Invoke the text generation Lambda function
      const textGenPayload = {
        pathParameters: {
          id: chat_session_id,
        },
        body: JSON.stringify({
          query: sanitizedQuery,
          user_id: user_id,
          is_intro_message: is_intro_message
        }),
        requestContext: {
          connectionId: connectionId,
          domainName: event.requestContext.domainName,
          stage: event.requestContext.stage,
        },
      };

      const result = await lambda.send(
        new InvokeCommand({
          FunctionName: process.env.TEXT_GEN_FUNCTION_NAME,
          InvocationType: "Event", // Asynchronous invocation
          Payload: JSON.stringify(textGenPayload),
        })
      );

      console.log("Text generation function invoked successfully:", result);

      return { statusCode: 200 };
    }

    return {
      statusCode: 400,
      body: JSON.stringify({ error: "Unknown action" }),
    };
  } catch (error) {
    console.error("Error processing WebSocket message:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Internal server error" }),
    };
  }
};
