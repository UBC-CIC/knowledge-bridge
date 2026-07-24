const { SNSClient, PublishCommand } = require("@aws-sdk/client-sns");

const sns = new SNSClient({});

async function publishNotification({ userId, type, title, message, metadata = {} }) {
  await sns.send(new PublishCommand({
    TopicArn: process.env.NOTIFICATION_TOPIC_ARN,
    Message: JSON.stringify({ userId, type, title, message, metadata }),
  }));
}

module.exports = { publishNotification };
