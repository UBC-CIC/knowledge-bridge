const postgres = require("postgres");
const { getCorsHeaders } = require("./utils/cors.js");
const {
  SecretsManagerClient,
  GetSecretValueCommand,
} = require("@aws-sdk/client-secrets-manager");
const crypto = require("crypto");
const { validateUUID } = require("./utils/validation.js");

let sqlConnection;
const secretsManager = new SecretsManagerClient();

const initConnection = async () => {
  if (!sqlConnection) {
    try {
      const getSecretValueCommand = new GetSecretValueCommand({
        SecretId: process.env.SM_DB_CREDENTIALS,
      });
      const secretResponse = await secretsManager.send(getSecretValueCommand);
      const credentials = JSON.parse(secretResponse.SecretString);

      const connectionConfig = {
        host: process.env.RDS_PROXY_ENDPOINT,
        port: credentials.port,
        username: credentials.username,
        password: credentials.password,
        database: credentials.dbname,
        ssl: { rejectUnauthorized: false },
      };

      sqlConnection = postgres(connectionConfig);
      await sqlConnection`SELECT 1`;
      console.log("Database connection initialized successfully");
    } catch (error) {
      console.error("Error initializing database connection:", error);
      throw error;
    }
  }
};

const createResponse = async (event) => ({
    statusCode: 200,
    headers: await getCorsHeaders(event),
    body: "",
});

const parseBody = (body) => {
  try {
    return JSON.parse(body || "{}");
  } catch {
    throw new Error("Invalid JSON body");
  }
};

const handleError = (error, response) => {
  response.statusCode = 500;
  console.error("Internal server error:", error);
  response.body = JSON.stringify({ error: "Internal server error" });
};

exports.handler = async (event) => {
  const response = await createResponse(event);
  let data;

  try {
    // Ensure connection is initialized before proceeding
    await initConnection();
    const pathData = event.httpMethod + " " + event.resource;

    switch (pathData) {
      case "GET /user/exampleEndpoint":
        data = "Example endpoint invoked";
        response.body = JSON.stringify(data);
        break;

      case "POST /user": {
        const body = parseBody(event.body);

        // Default role is student
        const role = "student";
        const userId = crypto.randomUUID();
        const email = body.email || null;
        const displayName = body.display_name || body.displayName || null;
        const metadata = body.metadata || {};

        const now = new Date();

        // Create a new row (email can be null)
        const result = await sqlConnection`
          INSERT INTO users (
            id, email, display_name, role,
            created_at, last_seen_at,
            metadata
          )
          VALUES (
            ${userId}, ${email}, ${displayName}, ${role},
            ${now}, ${now},
            ${metadata}
          )
          RETURNING
            id, email, display_name, role,
            created_at, last_seen_at, metadata
        `;

        const row = result[0];

        data = {
          userId: row.id,
          email: row.email,
          display_name: row.display_name,
          role: row.role,
          created_at: row.created_at,
          last_seen_at: row.last_seen_at,
          metadata: row.metadata,
        };

        response.body = JSON.stringify(data);
        break;
      }

      case "GET /user/{user_id}": {
        const userId = event.pathParameters?.user_id;
        const userIdValidation = validateUUID(userId, "user_id");
        if (!userIdValidation.valid) {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: userIdValidation.error });
          break;
        }

        const user = await sqlConnection`
          SELECT id, email, display_name, role, created_at, last_seen_at,
                messages_sent, messages_window_started_at, metadata
          FROM users
          WHERE id = ${userId}
        `;

        if (user.length === 0) {
          response.statusCode = 404;
          response.body = JSON.stringify({ error: "User not found" });
          break;
        }

        // update last_seen_at
        await sqlConnection`
          UPDATE users SET last_seen_at = NOW() WHERE id = ${userId}
        `;

        response.body = JSON.stringify(user[0]);
        break;
      }

      // Update's user with email so they no longer will be anonymous
      case "PUT /user/{user_id}": {
        const userId = event.pathParameters?.user_id;
        const userIdValidation = validateUUID(userId, "user_id");
        if (!userIdValidation.valid) {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: userIdValidation.error });
          break;
        }

        let parsedBody = {};

        try {
          parsedBody = event.body ? JSON.parse(event.body) : {};
        } catch (err) {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "Request body must be valid JSON" });
          break;
        }

        const rawEmail = parsedBody.email;

        if (typeof rawEmail !== "string") {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "email is required and must be a string" });
          break;
        }

        const normalizedEmail = rawEmail.trim().toLowerCase();

        if (!normalizedEmail) {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "email cannot be empty" });
          break;
        }

        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(normalizedEmail)) {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "Invalid email format" });
          break;
        }

        const existingUser = await sqlConnection`
          SELECT id
          FROM users
          WHERE id = ${userId}
        `;

        if (existingUser.length === 0) {
          response.statusCode = 404;
          response.body = JSON.stringify({ error: "User not found" });
          break;
        }

        try {
          const updatedUser = await sqlConnection`
            UPDATE users
            SET
              email = ${normalizedEmail},
              last_seen_at = NOW()
            WHERE id = ${userId}
            RETURNING
              id,
              email,
              display_name,
              role,
              created_at,
              last_seen_at,
              messages_sent,
              messages_window_started_at,
              metadata
          `;

          response.statusCode = 200;
          response.body = JSON.stringify(updatedUser[0]);
        } catch (err) {
          // Postgres unique violation
          if (err.code === "23505") {
            response.statusCode = 409;
            response.body = JSON.stringify({ error: "Email is already in use" });
            break;
          }
          throw err;
        }
        break;
      }

      case "GET /user/{user_id}/chat_sessions/{chat_session_id}/chat_history": {
        const userId = event.pathParameters?.user_id;
        const chatSessionId = event.pathParameters?.chat_session_id;

        const userIdValidation = validateUUID(userId, "user_id");
        if (!userIdValidation.valid) {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: userIdValidation.error });
          break;
        }
        const sessionIdValidation = validateUUID(chatSessionId, "chat_session_id");
        if (!sessionIdValidation.valid) {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: sessionIdValidation.error });
          break;
        }

        // Validate user exists (optional but nice)
        const userExists = await sqlConnection`
          SELECT id FROM users WHERE id = ${userId}
        `;
        if (userExists.length === 0) {
          response.statusCode = 404;
          response.body = JSON.stringify({ error: "User not found" });
          break;
        }

        // Validate chat session exists AND belongs to user
        const chatSession = await sqlConnection`
          SELECT id, user_id
          FROM chat_sessions
          WHERE id = ${chatSessionId}
        `;
        if (chatSession.length === 0) {
          response.statusCode = 404;
          response.body = JSON.stringify({ error: "Chat session not found" });
          break;
        }
        if (chatSession[0].user_id !== userId) {
          response.statusCode = 403;
          response.body = JSON.stringify({ error: "You can only access your own chat sessions" });
          break;
        }

        const limit = Math.min(parseInt(event.queryStringParameters?.limit) || 200, 1000);
        const offset = parseInt(event.queryStringParameters?.offset) || 0;

        const rows = await sqlConnection`
          SELECT
            id,
            chat_session_id,
            sender,
            content,
            sources,
            warning,
            created_at,
            COUNT(*) OVER() as total_count
          FROM chat_messages
          WHERE chat_session_id = ${chatSessionId}
          ORDER BY created_at ASC, id ASC
          LIMIT ${limit} OFFSET ${offset}
        `;

        const total = rows.length > 0 ? parseInt(rows[0].total_count) : 0;
        const messages = rows.map(({ total_count, ...msg }) => msg);

        data = {
          chat_session_id: chatSessionId,
          user_id: userId,
          messages,
          pagination: {
            limit,
            offset,
            total,
            hasMore: offset + limit < total,
          },
        };

        response.statusCode = 200;
        response.body = JSON.stringify(data);
        break;
      }

      default:
        throw new Error(`Unsupported route: "${pathData}"`);
    }
  } catch (error) {
    handleError(error, response);
  }

  console.log(response);
  return response;
};
