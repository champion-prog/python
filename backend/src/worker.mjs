import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { PublishCommand, SNSClient } from '@aws-sdk/client-sns';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const sns = new SNSClient({});

export const handler = async (event) => {
  const failures = [];
  for (const record of event.Records ?? []) {
    try {
      const message = JSON.parse(record.body);
      if (message.kind !== 'NOTIFICATION') {
        throw new Error(`Unsupported queue event kind: ${message.kind}`);
      }
      const detail = message.detail ?? {};
      const profile = await ddb.send(new GetCommand({
        TableName: process.env.TABLE_NAME,
        Key: { PK: `USER#${detail.userId}`, SK: 'PROFILE' }
      }));
      if (!profile.Item?.notificationTopicArn) continue;
      await sns.send(new PublishCommand({
        TopicArn: profile.Item.notificationTopicArn,
        Subject: `SmartQueue: ${detail.type?.replaceAll('_', ' ').toLowerCase() ?? 'notification'}`,
        Message: detail.message,
        MessageAttributes: { userId: { DataType: 'String', StringValue: detail.userId } }
      }));
    } catch (error) {
      console.error(JSON.stringify({ message: error.message, messageId: record.messageId }));
      failures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures: failures };
};
