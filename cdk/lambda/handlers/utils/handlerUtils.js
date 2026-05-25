const { initializeConnection } = require("../initializeConnection.js");
const { getCorsHeaders } = require("./cors.js");

let { SM_DB_CREDENTIALS, RDS_PROXY_ENDPOINT } = process.env;
let sqlConnection;

const initConnection = async () => {
  if (!global.sqlConnection) {
    await initializeConnection(SM_DB_CREDENTIALS, RDS_PROXY_ENDPOINT);
  }
};

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

module.exports = {
  initConnection,
  createResponse,
  parseBody,
  handleError,
  getSqlConnection: () => global.sqlConnection
};