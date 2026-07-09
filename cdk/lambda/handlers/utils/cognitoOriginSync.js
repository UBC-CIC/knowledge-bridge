const {
  CognitoIdentityProviderClient,
  UpdateUserPoolClientCommand,
} = require("@aws-sdk/client-cognito-identity-provider");
const { SSMClient, GetParameterCommand } = require("@aws-sdk/client-ssm");

const cognito = new CognitoIdentityProviderClient({});
const ssm = new SSMClient({});

exports.handler = async () => {
  const userPoolId = process.env.USER_POOL_ID;
  const clientId = process.env.APP_CLIENT_ID;
  const paramName = process.env.ALLOWED_ORIGINS_PARAM;

  const { Parameter } = await ssm.send(
    new GetParameterCommand({ Name: paramName })
  );

  const origins = Parameter.Value.split(",")
    .map((o) => o.trim().replace(/\/$/, ""))
    .filter(Boolean);

  await cognito.send(
    new UpdateUserPoolClientCommand({
      UserPoolId: userPoolId,
      ClientId: clientId,
      CallbackURLs: origins,
      LogoutURLs: origins,
      AllowedOAuthFlows: ["code"],
      AllowedOAuthScopes: ["openid", "email", "profile"],
      AllowedOAuthFlowsUserPoolClient: true,
      SupportedIdentityProviders: ["COGNITO", "EntraID"],
      ExplicitAuthFlows: [
        "ALLOW_USER_PASSWORD_AUTH",
        "ALLOW_CUSTOM_AUTH",
        "ALLOW_USER_SRP_AUTH",
        "ALLOW_REFRESH_TOKEN_AUTH",
      ],
    })
  );

  console.log(`Cognito callback/logout URLs updated to: ${origins.join(", ")}`);
};
