const {
  SecretsManagerClient,
  GetSecretValueCommand,
} = require("@aws-sdk/client-secrets-manager");
const jwt = require("jsonwebtoken");
const { getCorsHeaders } = require("./cors.js");
const { randomUUID } = require("crypto");

const secretsManager = new SecretsManagerClient();
let cachedSecret;
let cacheExpiry = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

exports.handler = async (event) => {
  try {
    if (!cachedSecret || Date.now() > cacheExpiry) {
      const response = await secretsManager.send(
        new GetSecretValueCommand({ SecretId: process.env.JWT_SECRET })
      );
      cachedSecret = JSON.parse(response.SecretString).jwtSecret;
      cacheExpiry = Date.now() + CACHE_TTL_MS;
    }

    const token = jwt.sign(
      {
        role: "user",
        jti: randomUUID(),  // Unique token ID for tracking/revocation
        iat: Math.floor(Date.now() / 1000)  // Explicit issued-at timestamp
      },
      cachedSecret,
      { expiresIn: "15m" }  // Reduced to 15 minutes for better security
    );
    return {
      statusCode: 200,
      headers: await getCorsHeaders(event),
      body: JSON.stringify({ token }),
    };
  } catch (error) {
    console.error("Token generation error:", error);
    return {
      statusCode: 500,
      headers: await getCorsHeaders(event),
      body: JSON.stringify({ error: "Failed to generate token" }),
    };
  }
};
