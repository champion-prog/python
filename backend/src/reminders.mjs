import { randomUUID } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { PublishCommand, SNSClient } from '@aws-sdk/client-sns';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const sns = new SNSClient({});
const tableName = process.env.TABLE_NAME;

const query = async (indexName, partitionKey, prefix) => {
  const result = await ddb.send(new QueryCommand({
    TableName: tableName,
    IndexName: indexName,
    KeyConditionExpression: `${indexName}PK = :pk AND begins_with(${indexName}SK, :prefix)`,
    ExpressionAttributeValues: { ':pk': partitionKey, ':prefix': prefix }
  }));
  return result.Items ?? [];
};

export const handler = async () => {
  const reminderDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const organizations = await query('GSI1', 'ORGANIZATIONS', 'ORGANIZATION#');
  let reminded = 0;

  for (const organization of organizations) {
    const services = await query('GSI1', `ORG#${organization.organizationId}`, 'SERVICE#');
    for (const service of services) {
      const appointments = await query(
        'GSI2',
        `SERVICE#${service.serviceId}#${reminderDate}`,
        'APPOINTMENT#'
      );
      for (const appointment of appointments) {
        if (!['BOOKED', 'CONFIRMED'].includes(appointment.status)) continue;
        const notificationId = randomUUID();
        const now = new Date().toISOString();
        const notification = {
          PK: `USER#${appointment.userId}`,
          SK: `NOTIFICATION#${now}#${notificationId}`,
          entity: 'NOTIFICATION',
          notificationId,
          userId: appointment.userId,
          appointmentId: appointment.appointmentId,
          type: 'APPOINTMENT_REMINDER',
          message: `Reminder: ${appointment.serviceName} is scheduled for ${appointment.appointmentDate} at ${appointment.appointmentTime}.`,
          status: 'SENT',
          createdAt: now
        };

        try {
          await ddb.send(new PutCommand({
            TableName: tableName,
            Item: {
              PK: `APPOINTMENT#${appointment.appointmentId}`,
              SK: `REMINDER#${reminderDate}`,
              entity: 'REMINDER_SENT'
            },
            ConditionExpression: 'attribute_not_exists(PK)'
          }));
        } catch (error) {
          if (error.name === 'ConditionalCheckFailedException') continue;
          throw error;
        }

        await ddb.send(new PutCommand({ TableName: tableName, Item: notification }));
        const profile = await ddb.send(new GetCommand({
          TableName: tableName,
          Key: { PK: `USER#${appointment.userId}`, SK: 'PROFILE' }
        }));
        if (profile.Item?.notificationTopicArn) {
          await sns.send(new PublishCommand({
            TopicArn: profile.Item.notificationTopicArn,
            Subject: 'SmartQueue appointment reminder',
            Message: notification.message,
            MessageAttributes: { userId: { DataType: 'String', StringValue: appointment.userId } }
          }));
        }
        reminded += 1;
      }
    }
  }
  return { reminded };
};
