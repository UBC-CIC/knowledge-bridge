const { getCorsHeaders } = require("./utils/cors.js");
const { initConnection, getSqlConnection } = require("./initializeConnection.js");

const createResponse = async (event) => ({
    statusCode: 200,
    headers: await getCorsHeaders(event),
    body: "",
});

const handleError = (error, response) => {
    response.statusCode = 500;
    console.error("Internal server error:", error);
    response.body = JSON.stringify({ error: "Internal server error" });
};

exports.handler = async (event) => {
    const response = await createResponse(event);
    try {
        // Ensure connection is initialized before proceeding
        await initConnection();
        const pathData = event.httpMethod + " " + event.resource;

        switch (pathData) {
            case "GET /system_message/{message_type}": {
                const messageType = event.pathParameters?.message_type;

                if (!messageType) {
                    response.statusCode = 400;
                    response.body = JSON.stringify({ error: "message_type is required" });
                    break;
                }

                const allowed = new Set([
                    "disclaimer",
                    "guardrails",
                    "system_role",
                    "system_instructions",
                    "output_format",
                    "initial_prompt",
                    "welcome_message",
                    "partial_hallucination_warning",
                    "full_hallucination_warning",
                ]);

                if (!allowed.has(messageType)) {
                    response.statusCode = 400;
                    response.body = JSON.stringify({
                        error: "Invalid message_type",
                        allowed: Array.from(allowed),
                    });
                    break;
                }

                // Fetch active message of this type
                const rows = await getSqlConnection()`
                    SELECT id, type, content, version, is_active, created_at
                    FROM system_messages
                    WHERE type = ${messageType}
                    AND is_active = true
                    ORDER BY version DESC, created_at DESC
                    LIMIT 1
                `;

                if (!rows || rows.length === 0) {
                    response.statusCode = 404;
                    response.body = JSON.stringify({
                        error: `No active message found for type: ${messageType}`,
                    });
                    break;
                }

                const msg = rows[0];
                response.statusCode = 200;
                response.body = JSON.stringify({
                    id: msg.id,
                    type: msg.type,
                    message: msg.content,
                    version: msg.version,
                    created_at: msg.created_at,
                });
                break;
            }

            case "GET /system-settings/max-characters-per-user-message": {
                const rows = await getSqlConnection()`
                SELECT max_characters_per_user_message
                FROM system_settings
                ORDER BY updated_at DESC NULLS LAST
                LIMIT 1
                `;

                const fallback = {
                max_characters_per_user_message: 50000,
                };

                response.statusCode = 200;
                response.body = JSON.stringify(rows[0] ?? fallback);
                break;
            }

            default:
                throw new Error(`Unsupported route: "${pathData}"`);
        }
    } catch (error) {
        handleError(error, response);
    }

    return response;
};
