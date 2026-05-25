const { SSMClient, GetParameterCommand } = require("@aws-sdk/client-ssm");

exports.handler = async (event) => {
  const ssmClient = new SSMClient();
  const parameterName = process.env.ALLOWED_EMAIL_DOMAINS;

  try {
    const getParameterCommand = new GetParameterCommand({
      Name: parameterName,
      WithDecryption: true,
    });
    const data = await ssmClient.send(getParameterCommand);
    const allowedDomains = data.Parameter.Value.split(",");
    const email = event.request.userAttributes.email;
    const emailDomain = email.split("@")[1];

    if (!allowedDomains.includes(emailDomain)) {
      throw new Error(`Signup not allowed for email domain: ${emailDomain}`);
    }

    return event;
  } catch (error) {
    console.error(error);
    throw new Error("Error validating email domain during pre-signup.");
  }
};