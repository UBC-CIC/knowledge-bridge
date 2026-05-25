const { SSMClient, GetParameterCommand } = require("@aws-sdk/client-ssm");

let cachedAllowedOrigins = null;

const getAllowedOrigins = async () => {
  if (cachedAllowedOrigins) return cachedAllowedOrigins;
  const paramName = process.env.ALLOWED_ORIGIN_PARAM;
  if (!paramName) return ["*"];
  try {
    const ssm = new SSMClient();
    const command = new GetParameterCommand({ Name: paramName });
    const response = await ssm.send(command);
    cachedAllowedOrigins = response.Parameter.Value.split(',').map(s => s.trim().replace(/\/$/, ''));
  } catch (error) {
    console.error("Failed to fetch CORS origins from SSM:", error);
    cachedAllowedOrigins = ["*"];
  }
  return cachedAllowedOrigins;
};

const getCorsHeaders = async (event) => {
  const allowedOrigins = await getAllowedOrigins();
  const origin = event?.headers?.origin || event?.headers?.Origin;
  let allowedOrigin = "";
  if (allowedOrigins.includes("*")) {
    allowedOrigin = "*";
  } else if (allowedOrigins.includes(origin)) {
    allowedOrigin = origin;
  }

  return {
    "Access-Control-Allow-Headers": "Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token",
    ...(allowedOrigin ? { "Access-Control-Allow-Origin": allowedOrigin } : {}),
    "Access-Control-Allow-Methods": "*",
  };
};

module.exports = { getCorsHeaders };