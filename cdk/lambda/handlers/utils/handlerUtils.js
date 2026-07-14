const { initializeConnection } = require("../initializeConnection.js");
const { getCorsHeaders } = require("./cors.js");

let { SM_DB_CREDENTIALS, RDS_PROXY_ENDPOINT } = process.env;
let sqlConnection;

const initConnection = async () => {
  if (!global.sqlConnection) {
    await initializeConnection(SM_DB_CREDENTIALS, RDS_PROXY_ENDPOINT);
  }
};

const getAuthenticatedUserId = (event) =>
  event.requestContext?.authorizer?.userId;

/**
 * Build a structured audit log entry. Caller is responsible for logging/storing.
 * @param {string} performedBy  - User ID of the actor
 * @param {string} action       - Verb describing the operation, e.g. "promote_user"
 * @param {*}      [target]     - Optional target identifier (user ID, message type, etc.)
 * @param {Object} [extra]      - Optional additional context fields
 * @returns {Object} Audit entry — pass to console.log, a DB insert, SNS, etc.
 */
const buildAuditEntry = (performedBy, action, target = null, extra = {}) => ({
  audit: true,
  performedBy,
  action,
  ...(target !== null ? { target } : {}),
  ...extra,
  timestamp: new Date().toISOString(),
});

const createResponse = async (event) => ({
  statusCode: 200,
  headers: await getCorsHeaders(event),
  body: "",
});

const parseBody = (body) => {
  try {
    return JSON.parse(body || '{}');
  } catch {
    throw new Error("Invalid JSON body");
  }
};

const handleError = (error, response) => {
  response.statusCode = 500;
  console.error("Internal server error:", error);
  response.body = JSON.stringify({ error: "Internal server error" });
};

const getSqlConnection = () => 
  global.sqlConnection;

module.exports = {
  initConnection,
  createResponse,
  parseBody,
  handleError,
  getSqlConnection,
  getAuthenticatedUserId,
  buildAuditEntry,
};