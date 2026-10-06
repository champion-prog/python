import { randomUUID } from 'node:crypto';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand
} from '@aws-sdk/lib-dynamodb';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { CreateTopicCommand, SNSClient, SubscribeCommand } from '@aws-sdk/client-sns';
import { createToken, estimateWaitTime, getHttpError } from './domain.mjs';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true }
});
const s3 = new S3Client({});
const sqs = new SQSClient({});
const sns = new SNSClient({});
const tableName = process.env.TABLE_NAME;
const documentBucket = process.env.DOCUMENT_BUCKET;

const jsonResponse = (statusCode, body) => ({
  statusCode,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body)
});

const readBody = (event) => {
  if (!event.body) return {};
  try {
    return JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString() : event.body);
  } catch {
    throw getHttpError(400, 'INVALID_JSON', 'Request body must be valid JSON.');
  }
};

const claimsFor = (event) => {
  const authorizer = event.requestContext?.authorizer ?? {};
  return authorizer.jwt?.claims ?? authorizer.claims ?? {};
};

const userFor = (event) => {
  const claims = claimsFor(event);
  if (!claims.sub) throw getHttpError(401, 'UNAUTHORIZED', 'Please sign in to continue.');
  const groupClaim = claims['cognito:groups'] ?? [];
  return {
    id: claims.sub,
    email: claims.email ?? '',
    name: claims.name ?? claims.email ?? 'User',
    roles: Array.isArray(groupClaim) ? groupClaim : String(groupClaim).split(',').filter(Boolean)
  };
};

const requireRole = (user, role) => {
  if (!user.roles.includes(role) && !user.roles.includes('ADMIN')) {
    throw getHttpError(403, 'FORBIDDEN', 'You do not have permission to perform this action.');
  }
};

const validateString = (value, label, max = 200) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw getHttpError(400, 'INVALID_INPUT', `${label} is required and must be ${max} characters or fewer.`);
  }
  return value.trim();
};

const validateDate = (value, label = 'Date') => {
  const date = validateString(value, label, 10);
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw getHttpError(400, 'INVALID_DATE', `${label} must be a valid date in YYYY-MM-DD format.`);
  }
  return date;
};

const getItem = async (pk, sk) => {
  const result = await ddb.send(new GetCommand({ TableName: tableName, Key: { PK: pk, SK: sk } }));
  return result.Item;
};

const queryPartition = async (pk, prefix = '') => {
  const result = await ddb.send(new QueryCommand({
    TableName: tableName,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
    ExpressionAttributeValues: { ':pk': pk, ':prefix': prefix }
  }));
  return result.Items ?? [];
};

const enqueue = async (kind, detail) => {
  if (!process.env.EVENT_QUEUE_URL) return;
  await sqs.send(new SendMessageCommand({
    QueueUrl: process.env.EVENT_QUEUE_URL,
    MessageBody: JSON.stringify({ kind, detail })
  }));
};

const enqueueBestEffort = async (kind, detail, resourceId) => {
  try {
    await enqueue(kind, detail);
    return true;
  } catch (error) {
    console.error(JSON.stringify({ message: error.message, operation: 'enqueue', kind, resourceId }));
    return false;
  }
};

const notify = async (userId, appointmentId, type, message) => {
  const notification = {
    PK: `USER#${userId}`,
    SK: `NOTIFICATION#${new Date().toISOString()}#${randomUUID()}`,
    entity: 'NOTIFICATION',
    notificationId: randomUUID(),
    userId,
    appointmentId,
    type,
    message,
    status: 'SENT',
    createdAt: new Date().toISOString()
  };
  let delivered = true;
  try {
    await ddb.send(new PutCommand({ TableName: tableName, Item: notification }));
  } catch (error) {
    delivered = false;
    console.error(JSON.stringify({ message: error.message, operation: 'save-notification', type, appointmentId }));
  }
  return (await enqueueBestEffort('NOTIFICATION', notification, appointmentId)) && delivered;
};

const findAppointment = async (appointmentId, user) => {
  const appointment = await getItem(`APPOINTMENT#${appointmentId}`, 'DETAIL');
  if (!appointment) throw getHttpError(404, 'APPOINTMENT_NOT_FOUND', 'Appointment not found.');
  if (appointment.userId !== user.id) {
    if (user.roles.includes('ADMIN')) return appointment;
    const service = user.roles.includes('STAFF') ? await getItem(`SERVICE#${appointment.serviceId}`, 'DETAIL') : null;
    if (!service || service.staffId !== user.id) {
      throw getHttpError(403, 'FORBIDDEN', 'You cannot access this appointment.');
    }
  }
  return appointment;
};

const listServices = async (organizationId) => {
  const result = await ddb.send(new QueryCommand({
    TableName: tableName,
    IndexName: 'GSI1',
    KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :prefix)',
    ExpressionAttributeValues: { ':pk': `ORG#${organizationId}`, ':prefix': 'SERVICE#' }
  }));
  return result.Items ?? [];
};

async function createAppointment(event, user) {
  const body = readBody(event);
  if (event.smartQueueWalkIn === true) return joinWalkInQueue(event, user);
  const organizationId = validateString(body.organizationId, 'Organization');
  const serviceId = validateString(body.serviceId, 'Service');
  const appointmentDate = validateDate(body.appointmentDate);
  const appointmentTime = validateString(body.appointmentTime, 'Time', 30);
  if (appointmentDate < new Date().toISOString().slice(0, 10)) {
    throw getHttpError(400, 'INVALID_DATE', 'Choose today or a future appointment date.');
  }
  const service = await getItem(`SERVICE#${serviceId}`, 'DETAIL');
  if (!service || service.organizationId !== organizationId || service.status !== 'ACTIVE') {
    throw getHttpError(404, 'SERVICE_UNAVAILABLE', 'The selected service is not available.');
  }
  if (!service.schedule?.slots?.includes(appointmentTime)) {
    throw getHttpError(409, 'SLOT_UNAVAILABLE', 'That time slot is not offered by this service.');
  }
  if (appointmentDate === new Date().toISOString().slice(0, 10) && appointmentTime <= new Date().toISOString().slice(11, 16)) {
    throw getHttpError(409, 'SLOT_UNAVAILABLE', 'That time has already passed today.');
  }
  let priority = 0;
  if (body.priority !== undefined) {
    if (!Number.isInteger(body.priority) || body.priority < 1 || body.priority > 10) {
      throw getHttpError(400, 'INVALID_PRIORITY', 'Priority must be a whole number between 1 and 10.');
    }
    if (!user.roles.includes('STAFF') && !user.roles.includes('ADMIN')) {
      throw getHttpError(403, 'FORBIDDEN', 'Only authorized staff can set queue priority.');
    }
    if (service.staffId && service.staffId !== user.id && !user.roles.includes('ADMIN')) {
      throw getHttpError(403, 'FORBIDDEN', 'You are not assigned to this service.');
    }
    priority = body.priority;
  }

  async function joinWalkInQueue(event, user) {
    const body = readBody(event);
    const organizationId = validateString(body.organizationId, 'Organization');
    const serviceId = validateString(body.serviceId, 'Service');
    const appointmentDate = validateDate(body.appointmentDate ?? new Date().toISOString().slice(0, 10));
    if (appointmentDate !== new Date().toISOString().slice(0, 10)) {
      throw getHttpError(400, 'INVALID_DATE', 'Walk-in queue entries are only available for today.');
    }
    const service = await getItem(`SERVICE#${serviceId}`, 'DETAIL');
    if (!service || service.organizationId !== organizationId || service.status !== 'ACTIVE') {
      throw getHttpError(404, 'SERVICE_UNAVAILABLE', 'The selected service is not available.');
    }
    const control = await getItem(`SERVICE#${serviceId}`, 'QUEUE_CONTROL');
    if (control?.status === 'PAUSED') throw getHttpError(409, 'QUEUE_PAUSED', 'This service queue is temporarily paused.');
    const serviceDate = `${serviceId}#${appointmentDate}`;
    const counter = await ddb.send(new UpdateCommand({
      TableName: tableName,
      Key: { PK: `QUEUE#${serviceDate}`, SK: 'COUNTER' },
      UpdateExpression: 'ADD #count :one SET updatedAt = :now',
      ExpressionAttributeNames: { '#count': 'count' },
      ExpressionAttributeValues: { ':one': 1, ':now': new Date().toISOString() },
      ReturnValues: 'UPDATED_NEW'
    }));
    const appointmentId = randomUUID();
    const queueId = randomUUID();
    const tokenNumber = createToken(counter.Attributes.count);
    const now = new Date().toISOString();
    const appointment = {
      PK: `APPOINTMENT#${appointmentId}`,
      SK: 'DETAIL',
      entity: 'APPOINTMENT',
      appointmentId,
      userId: user.id,
      organizationId,
      serviceId,
      serviceName: service.name,
      staffId: service.staffId,
      queueId,
      appointmentDate,
      appointmentTime: 'WALK_IN',
      tokenNumber,
      status: 'WAITING',
      createdAt: now,
      updatedAt: now,
      GSI1PK: `USER#${user.id}`,
      GSI1SK: `APPOINTMENT#${appointmentDate}#${appointmentId}`,
      GSI2PK: `SERVICE#${serviceDate}`,
      GSI2SK: `APPOINTMENT#${now}#${appointmentId}`
    };
    if (service.staffId) {
      appointment.GSI3PK = `STAFF#${service.staffId}#${appointmentDate}`;
      appointment.GSI3SK = `APPOINTMENT#${now}#${appointmentId}`;
    }
    const entry = {
      PK: `QUEUE#${serviceDate}`,
      SK: `ENTRY#${String(counter.Attributes.count).padStart(10, '0')}`,
      entity: 'QUEUE_ENTRY',
      queueId,
      appointmentId,
      userId: user.id,
      organizationId,
      serviceId,
      serviceName: service.name,
      tokenNumber,
      priority: 0,
      status: 'WAITING',
      joinTime: now,
      appointmentDate,
      GSI1PK: `APPOINTMENT#${appointmentId}`,
      GSI1SK: 'QUEUE'
    };
    await ddb.send(new TransactWriteCommand({
      TransactItems: [
        { Put: { TableName: tableName, Item: appointment } },
        { Put: { TableName: tableName, Item: entry } }
      ]
    }));
    await notify(user.id, appointmentId, 'QUEUE_JOINED', `You joined the ${service.name} queue. Your token is ${tokenNumber}.`);
    const queue = await getQueue(serviceId, appointmentDate);
    const position = queue.entries
      .filter((item) => ['WAITING', 'CHECKED_IN', 'CALLED', 'IN_SERVICE'].includes(item.status))
      .findIndex((item) => item.queueId === queueId);
    return jsonResponse(201, {
      appointment: { appointmentId, organizationId, serviceId, serviceName: service.name, appointmentDate, appointmentTime: 'WALK_IN', tokenNumber, status: 'WAITING' },
      queue: { peopleAhead: Math.max(position, 0), estimatedWaitMinutes: Math.max(position, 0) * service.averageServiceTime }
    });
  }

  const appointmentId = randomUUID();
  const serviceDate = `${serviceId}#${appointmentDate}`;
  const counter = await ddb.send(new UpdateCommand({
    TableName: tableName,
    Key: { PK: `QUEUE#${serviceDate}`, SK: 'COUNTER' },
    UpdateExpression: 'ADD #count :one SET updatedAt = :now',
    ExpressionAttributeNames: { '#count': 'count' },
    ExpressionAttributeValues: { ':one': 1, ':now': new Date().toISOString() },
    ReturnValues: 'UPDATED_NEW'
  }));
  const tokenNumber = createToken(counter.Attributes.count);
  const now = new Date().toISOString();
  const queueId = randomUUID();
  const appointment = {
    PK: `APPOINTMENT#${appointmentId}`,
    SK: 'DETAIL',
    entity: 'APPOINTMENT',
    appointmentId,
    userId: user.id,
    organizationId,
    serviceId,
    serviceName: service.name,
    staffId: service.staffId,
    queueId,
    appointmentDate,
    appointmentTime,
    tokenNumber,
    status: 'BOOKED',
    createdAt: now,
    updatedAt: now,
    GSI1PK: `USER#${user.id}`,
    GSI1SK: `APPOINTMENT#${appointmentDate}#${appointmentId}`,
    GSI2PK: `SERVICE#${serviceDate}`,
    GSI2SK: `APPOINTMENT#${appointmentTime}#${appointmentId}`
  };
  const queueEntry = {
    PK: `QUEUE#${serviceDate}`,
    SK: `ENTRY#${String(counter.Attributes.count).padStart(10, '0')}`,
    entity: 'QUEUE_ENTRY',
    queueId,
    appointmentId,
    userId: user.id,
    organizationId,
    serviceId,
    serviceName: service.name,
    tokenNumber,
    priority,
    status: 'WAITING',
    joinTime: now,
    appointmentDate,
    GSI1PK: `APPOINTMENT#${appointmentId}`,
    GSI1SK: 'QUEUE'
  };
  if (service.staffId) {
    appointment.GSI3PK = `STAFF#${service.staffId}#${appointmentDate}`;
    appointment.GSI3SK = `APPOINTMENT#${appointmentTime}#${appointmentId}`;
  }
  try {
    await ddb.send(new TransactWriteCommand({
      TransactItems: [
        {
          Put: {
            TableName: tableName,
            Item: {
              PK: `SLOT#${serviceDate}`,
              SK: `TIME#${appointmentTime}`,
              entity: 'SLOT_RESERVATION',
              appointmentId,
              userId: user.id
            },
            ConditionExpression: 'attribute_not_exists(PK)'
          }
        },
        { Put: { TableName: tableName, Item: appointment } },
        { Put: { TableName: tableName, Item: queueEntry } }
      ]
    }));
  } catch (error) {
    if (error.name === 'TransactionCanceledException') {
      throw getHttpError(409, 'SLOT_UNAVAILABLE', 'That time slot has just been booked. Choose another time.');
    }
    throw error;
  }

  await notify(user.id, appointmentId, 'APPOINTMENT_CONFIRMED', `Appointment confirmed. Your token is ${tokenNumber}.`);
  const queueState = await getQueue(serviceId, appointmentDate);
  const ahead = queueState.entries
    .filter((entry) => ['WAITING', 'CHECKED_IN', 'CALLED', 'IN_SERVICE'].includes(entry.status))
    .findIndex((entry) => entry.queueId === queueEntry.queueId);
  return jsonResponse(201, {
    appointment: {
      appointmentId,
      organizationId,
      serviceId,
      serviceName: service.name,
      appointmentDate,
      appointmentTime,
      tokenNumber,
      status: 'BOOKED'
    },
    queue: { peopleAhead: Math.max(ahead, 0), estimatedWaitMinutes: Math.max(ahead, 0) * service.averageServiceTime }
  });
}

async function joinWalkInQueue(event, user) {
  return createAppointment({ ...event, smartQueueWalkIn: true }, user);
}

async function getQueue(serviceId, date, userId) {
  const entries = await queryPartition(`QUEUE#${serviceId}#${date}`, 'ENTRY#');
  const ordered = entries.sort((a, b) => (b.priority - a.priority) || a.joinTime.localeCompare(b.joinTime));
  const activeEntries = ordered.filter((entry) => ['WAITING', 'CHECKED_IN', 'CALLED', 'IN_SERVICE'].includes(entry.status));
  const userEntry = activeEntries.find((entry) => entry.userId === userId);
  const service = await getItem(`SERVICE#${serviceId}`, 'DETAIL');
  const serving = ordered.find((entry) => ['CALLED', 'IN_SERVICE'].includes(entry.status));
  return {
    serviceId,
    date,
    currentlyServing: serving?.tokenNumber ?? null,
    userQueuePosition: userEntry ? activeEntries.findIndex((entry) => entry.queueId === userEntry.queueId) : undefined,
    entries: ordered.map(({ PK, SK, GSI1PK, GSI1SK, entity, userId, appointmentId, organizationId, ...entry }) => entry),
    ...estimateWaitTime(ordered, service?.averageServiceTime ?? 5)
  };
}

async function updateQueueEntry(action, queueId, serviceId, date, user) {
  requireRole(user, 'STAFF');
  const entries = await queryPartition(`QUEUE#${serviceId}#${date}`, 'ENTRY#');
  const entry = entries.find((item) => item.queueId === queueId);
  if (!entry) throw getHttpError(404, 'QUEUE_ENTRY_NOT_FOUND', 'Queue entry not found.');
  const queueStatusByAction = { complete: 'COMPLETED', skip: 'SKIPPED', call: 'CALLED', start: 'IN_SERVICE', 'no-show': 'NO_SHOW' };
  const appointmentStatusByAction = { complete: 'COMPLETED', skip: 'NO_SHOW', call: 'CALLED', start: 'IN_SERVICE', 'no-show': 'NO_SHOW' };
  const status = queueStatusByAction[action];
  const appointmentStatus = appointmentStatusByAction[action];
  if (!status) throw getHttpError(400, 'INVALID_ACTION', 'Unsupported queue action.');
  const now = new Date().toISOString();
  const appointment = await getItem(`APPOINTMENT#${entry.appointmentId}`, 'DETAIL');
  if (!appointment) throw getHttpError(404, 'APPOINTMENT_NOT_FOUND', 'Appointment not found.');
  const service = await getItem(`SERVICE#${entry.serviceId}`, 'DETAIL');
  if (service?.staffId && service.staffId !== user.id && !user.roles.includes('ADMIN')) {
    throw getHttpError(403, 'FORBIDDEN', 'You are not assigned to this service queue.');
  }
  const allowedStatuses = {
    call: ['WAITING', 'CHECKED_IN'],
    start: ['CALLED'],
    complete: ['IN_SERVICE'],
    skip: ['WAITING', 'CHECKED_IN', 'CALLED'],
    'no-show': ['WAITING', 'CHECKED_IN', 'CALLED']
  };
  if (!allowedStatuses[action]?.includes(entry.status)) {
    throw getHttpError(409, 'INVALID_STATUS_TRANSITION', `Cannot ${action} a queue entry that is ${entry.status.toLowerCase()}.`);
  }
  const updatedAppointment = { ...appointment, status: appointmentStatus, updatedAt: now };
  const updatedEntry = { ...entry, status, updatedAt: now };
  if (action === 'call') updatedEntry.calledTime = now;
  if (action === 'complete') updatedEntry.completedTime = now;
  try {
    await ddb.send(new TransactWriteCommand({
  TransactItems: [
    {
      Put: {
        TableName: tableName,
        Item: updatedEntry,
        ConditionExpression: '#status = :waiting',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':waiting': entry.status }
      }
    },
    { Put: { TableName: tableName, Item: updatedAppointment } }
  ]
    }));
  } catch (error) {
    if (error.name === 'TransactionCanceledException') {
  throw getHttpError(409, 'QUEUE_ENTRY_CHANGED', 'This queue entry changed. Refresh the queue and try again.');
    }
    throw error;
  }
  await notify(entry.userId, entry.appointmentId, `QUEUE_${status}`, `Your queue status is now ${status.toLowerCase().replaceAll('_', ' ')}.`);
  return jsonResponse(200, { queueEntry: updatedEntry, appointment: updatedAppointment });
}

async function callNext(event, user) {
  requireRole(user, 'STAFF');
  const { serviceId, date } = readBody(event);
  const validServiceId = validateString(serviceId, 'Service');
  const validDate = validateDate(date);
  const queue = await getQueue(validServiceId, validDate);
  const control = await getItem(`SERVICE#${serviceId}`, 'QUEUE_CONTROL');
  if (control?.status === 'PAUSED') throw getHttpError(409, 'QUEUE_PAUSED', 'This service queue is temporarily paused.');
  const entry = queue.entries.find((item) => ['WAITING', 'CHECKED_IN'].includes(item.status));
  if (!entry) throw getHttpError(409, 'QUEUE_EMPTY', 'There are no waiting people in this queue.');
  return updateQueueEntry('call', entry.queueId, validServiceId, validDate, user);
}

async function getUploadUrl(event, user) {
  const { appointmentId, fileName, contentType, fileSize, documentType } = readBody(event);
  const appointment = await findAppointment(validateString(appointmentId, 'Appointment ID'), user);
  const allowedTypes = ['application/pdf', 'image/jpeg', 'image/png'];
  if (!allowedTypes.includes(contentType)) throw getHttpError(400, 'INVALID_FILE_TYPE', 'Upload a PDF, JPG, JPEG, or PNG file.');
  if (!Number.isInteger(fileSize) || fileSize < 1 || fileSize > 10 * 1024 * 1024) {
    throw getHttpError(400, 'INVALID_FILE_SIZE', 'Documents must be smaller than 10 MB.');
  }
  const safeName = validateString(fileName, 'File name', 180).replace(/[^\w.-]/g, '_');
  const documentId = randomUUID();
  const key = `${user.id}/${appointment.appointmentId}/${documentId}/${safeName}`;
  const upload = await createPresignedPost(s3, {
    Bucket: documentBucket,
    Key: key,
    Conditions: [
      ['content-length-range', 1, 10 * 1024 * 1024],
      ['eq', '$Content-Type', contentType],
      ['eq', '$x-amz-meta-appointmentid', appointmentId],
      ['eq', '$x-amz-meta-documentid', documentId]
    ],
    Fields: {
      'Content-Type': contentType,
      'x-amz-meta-appointmentid': appointmentId,
      'x-amz-meta-documentid': documentId
    },
    Expires: 300
  });
  const item = {
    PK: `DOCUMENT#${documentId}`,
    SK: 'DETAIL',
    entity: 'DOCUMENT',
    documentId,
    appointmentId,
    userId: user.id,
    documentType: validateString(documentType ?? 'Supporting document', 'Document type', 80),
    fileName: safeName,
    s3ObjectKey: key,
    contentType,
    fileSize,
    uploadedAt: new Date().toISOString(),
    status: 'PENDING_UPLOAD',
    GSI1PK: `APPOINTMENT#${appointmentId}`,
    GSI1SK: `DOCUMENT#${documentId}`
  };
  await ddb.send(new PutCommand({ TableName: tableName, Item: item }));
  return jsonResponse(201, { document: { documentId, fileName: safeName, uploadUrl: upload.url, fields: upload.fields, method: 'POST' } });
}

async function listDocuments(appointmentId, user) {
  await findAppointment(appointmentId, user);
  const result = await ddb.send(new QueryCommand({
    TableName: tableName,
    IndexName: 'GSI1',
    KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :prefix)',
    ExpressionAttributeValues: { ':pk': `APPOINTMENT#${appointmentId}`, ':prefix': 'DOCUMENT#' }
  }));
  return (result.Items ?? []).map(({ PK, SK, s3ObjectKey, ...document }) => document);
}

async function handleRoute(event, user) {
  const method = event.requestContext?.http?.method ?? event.httpMethod;
  const path = event.rawPath ?? event.path ?? '/';
  const params = event.pathParameters ?? {};
  const query = event.queryStringParameters ?? {};
  const body = readBody(event);

  if (method === 'GET' && path === '/organizations') {
    const result = await ddb.send(new QueryCommand({
      TableName: tableName,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :pk',
      ExpressionAttributeValues: { ':pk': 'ORGANIZATIONS' }
    }));
    return jsonResponse(200, { organizations: result.Items ?? [] });
  }
  if (method === 'GET' && path === '/users/me') {
    const profileKey = { PK: `USER#${user.id}`, SK: 'PROFILE' };
    let profile = await getItem(profileKey.PK, profileKey.SK);
    if (!profile) {
      const claims = claimsFor(event);
      profile = {
        ...profileKey,
        entity: 'USER',
        userId: user.id,
        name: user.name,
        email: user.email,
        phone: claims.phone_number ?? '',
        role: user.roles.includes('ADMIN') ? 'ADMIN' : user.roles.includes('STAFF') ? 'STAFF' : 'USER',
        createdAt: new Date().toISOString()
      };
      await ddb.send(new PutCommand({ TableName: tableName, Item: profile }));
    }
    return jsonResponse(200, { user: profile });
  }
  const departmentsPath = path.match(/^\/organizations\/([^/]+)\/departments$/);
  if (method === 'GET' && departmentsPath) {
    const result = await ddb.send(new QueryCommand({
      TableName: tableName,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :prefix)',
      ExpressionAttributeValues: { ':pk': `ORG#${departmentsPath[1]}`, ':prefix': 'DEPARTMENT#' }
    }));
    return jsonResponse(200, { departments: result.Items ?? [] });
  }
  if (method === 'GET' && path === '/services') {
    const orgId = validateString(query.organizationId, 'Organization');
    return jsonResponse(200, { services: await listServices(orgId) });
  }
  if (method === 'GET' && path === `/services/${params.id}`) {
    const service = await getItem(`SERVICE#${params.id}`, 'DETAIL');
    return service ? jsonResponse(200, { service }) : jsonResponse(404, { code: 'SERVICE_NOT_FOUND', message: 'Service not found.' });
  }
  if (method === 'GET' && path === `/services/${params.id}/availability`) {
    const date = validateDate(query.date);
    const service = await getItem(`SERVICE#${params.id}`, 'DETAIL');
    if (!service) throw getHttpError(404, 'SERVICE_NOT_FOUND', 'Service not found.');
    const reservations = await queryPartition(`SLOT#${params.id}#${date}`, 'TIME#');
    const reserved = new Set(reservations.map((slot) => slot.SK.slice(5)));
    const currentTime = new Date().toISOString().slice(11, 16);
    const slots = (service.schedule?.slots ?? []).filter((slot) =>
      !reserved.has(slot) && (date !== new Date().toISOString().slice(0, 10) || slot > currentTime)
    );
    return jsonResponse(200, { date, slots });
  }
  if (method === 'POST' && path === '/appointments') return createAppointment(event, user);
  if (method === 'GET' && path === '/appointments/my') {
    const result = await ddb.send(new QueryCommand({
      TableName: tableName,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :prefix)',
      ExpressionAttributeValues: { ':pk': `USER#${user.id}`, ':prefix': 'APPOINTMENT#' },
      ScanIndexForward: false
    }));
    return jsonResponse(200, { appointments: result.Items ?? [] });
  }
  if (method === 'GET' && path === `/appointments/${params.id}`) {
    return jsonResponse(200, { appointment: await findAppointment(params.id, user) });
  }
  const checkIn = path.match(/^\/appointments\/([^/]+)\/check-in$/);
  if (method === 'POST' && checkIn) {
    const appointment = await findAppointment(checkIn[1], user);
    if (!['BOOKED', 'CONFIRMED'].includes(appointment.status)) {
      throw getHttpError(409, 'INVALID_STATUS_TRANSITION', 'This appointment cannot be checked in now.');
    }
    const entries = await ddb.send(new QueryCommand({
      TableName: tableName,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :pk AND GSI1SK = :sk',
      ExpressionAttributeValues: { ':pk': `APPOINTMENT#${appointment.appointmentId}`, ':sk': 'QUEUE' }
    }));
    const entry = entries.Items?.[0];
    if (!entry) throw getHttpError(404, 'QUEUE_ENTRY_NOT_FOUND', 'The queue entry for this appointment was not found.');
    const now = new Date().toISOString();
    const updatedAppointment = { ...appointment, status: 'CHECKED_IN', updatedAt: now };
    await ddb.send(new TransactWriteCommand({
      TransactItems: [
        {
          Put: {
            TableName: tableName,
            Item: { ...entry, status: 'CHECKED_IN', updatedAt: now },
            ConditionExpression: '#status = :waiting',
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: { ':waiting': 'WAITING' }
          }
        },
        { Put: { TableName: tableName, Item: updatedAppointment } }
      ]
    }));
    return jsonResponse(200, { appointment: updatedAppointment });
  }
  if ((method === 'DELETE' || method === 'PUT') && path === `/appointments/${params.id}`) {
    const appointment = await findAppointment(params.id, user);
    if (method === 'DELETE') {
      if (['COMPLETED', 'CANCELLED', 'NO_SHOW'].includes(appointment.status)) {
        throw getHttpError(409, 'CANNOT_CANCEL', 'This appointment can no longer be cancelled.');
      }
      const queueEntries = await ddb.send(new QueryCommand({
        TableName: tableName,
        IndexName: 'GSI1',
        KeyConditionExpression: 'GSI1PK = :pk AND GSI1SK = :sk',
        ExpressionAttributeValues: { ':pk': `APPOINTMENT#${appointment.appointmentId}`, ':sk': 'QUEUE' }
      }));
      const queueEntry = queueEntries.Items?.[0];
      const updated = { ...appointment, status: 'CANCELLED', updatedAt: new Date().toISOString() };
      const operations = [
        { Delete: { TableName: tableName, Key: { PK: `SLOT#${appointment.serviceId}#${appointment.appointmentDate}`, SK: `TIME#${appointment.appointmentTime}` } } },
        { Put: { TableName: tableName, Item: updated } }
      ];
      if (queueEntry) operations.push({ Put: { TableName: tableName, Item: { ...queueEntry, status: 'CANCELLED', updatedAt: updated.updatedAt } } });
      await ddb.send(new TransactWriteCommand({ TransactItems: operations }));
      await notify(user.id, appointment.appointmentId, 'APPOINTMENT_CANCELLED', 'Your appointment has been cancelled.');
      return jsonResponse(200, { appointment: updated });
    }
    const date = validateDate(body.appointmentDate);
    const time = validateString(body.appointmentTime, 'Time', 30);
    if (date < new Date().toISOString().slice(0, 10)) throw getHttpError(400, 'INVALID_DATE', 'Choose today or a future date.');
    if (date === appointment.appointmentDate && time === appointment.appointmentTime) return jsonResponse(200, { appointment });
    if (!['BOOKED', 'CONFIRMED'].includes(appointment.status)) {
      throw getHttpError(409, 'CANNOT_RESCHEDULE', 'Only booked or confirmed appointments can be rescheduled.');
    }
    const service = await getItem(`SERVICE#${appointment.serviceId}`, 'DETAIL');
    if (!service?.schedule?.slots?.includes(time)) throw getHttpError(409, 'SLOT_UNAVAILABLE', 'That time slot is not offered by this service.');
    const slot = await ddb.send(new GetCommand({
      TableName: tableName,
      Key: { PK: `SLOT#${appointment.serviceId}#${date}`, SK: `TIME#${time}` }
    }));
    if (slot.Item && slot.Item.appointmentId !== appointment.appointmentId) {
      throw getHttpError(409, 'SLOT_UNAVAILABLE', 'That time slot has already been booked.');
    }
    const queueEntries = await ddb.send(new QueryCommand({
      TableName: tableName,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :pk AND GSI1SK = :sk',
      ExpressionAttributeValues: { ':pk': `APPOINTMENT#${appointment.appointmentId}`, ':sk': 'QUEUE' }
    }));
    const oldEntry = queueEntries.Items?.[0];
    if (!oldEntry) throw getHttpError(404, 'QUEUE_ENTRY_NOT_FOUND', 'The queue entry for this appointment was not found.');
    const newCounter = await ddb.send(new UpdateCommand({
      TableName: tableName,
      Key: { PK: `QUEUE#${appointment.serviceId}#${date}`, SK: 'COUNTER' },
      UpdateExpression: 'ADD #count :one SET updatedAt = :now',
      ExpressionAttributeNames: { '#count': 'count' },
      ExpressionAttributeValues: { ':one': 1, ':now': new Date().toISOString() },
      ReturnValues: 'UPDATED_NEW'
    }));
    const tokenNumber = createToken(newCounter.Attributes.count);
    const now = new Date().toISOString();
    const updated = {
      ...appointment,
      appointmentDate: date,
      appointmentTime: time,
      tokenNumber,
      status: 'CONFIRMED',
      updatedAt: now,
      GSI1SK: `APPOINTMENT#${date}#${appointment.appointmentId}`,
      GSI2PK: `SERVICE#${appointment.serviceId}#${date}`,
      GSI2SK: `APPOINTMENT#${time}#${appointment.appointmentId}`,
      GSI3PK: appointment.staffId ? `STAFF#${appointment.staffId}#${date}` : undefined,
      GSI3SK: appointment.staffId ? `APPOINTMENT#${time}#${appointment.appointmentId}` : undefined
    };
    const newEntry = {
      ...oldEntry,
      PK: `QUEUE#${appointment.serviceId}#${date}`,
      SK: `ENTRY#${String(newCounter.Attributes.count).padStart(10, '0')}`,
      queueId: randomUUID(),
      tokenNumber,
      status: 'WAITING',
      joinTime: now
    };
    await ddb.send(new TransactWriteCommand({
      TransactItems: [
        { Delete: { TableName: tableName, Key: { PK: oldEntry.PK, SK: oldEntry.SK } } },
        { Delete: { TableName: tableName, Key: { PK: `SLOT#${appointment.serviceId}#${appointment.appointmentDate}`, SK: `TIME#${appointment.appointmentTime}` } } },
        {
          Put: {
            TableName: tableName,
            Item: { PK: `SLOT#${appointment.serviceId}#${date}`, SK: `TIME#${time}`, entity: 'SLOT_RESERVATION', appointmentId: appointment.appointmentId, userId: user.id },
            ConditionExpression: 'attribute_not_exists(PK)'
          }
        },
        { Put: { TableName: tableName, Item: { ...updated, queueId: newEntry.queueId } } },
        { Put: { TableName: tableName, Item: newEntry } }
      ]
    }));
    await notify(user.id, appointment.appointmentId, 'APPOINTMENT_RESCHEDULED', 'Your appointment has been rescheduled.');
    return jsonResponse(200, { appointment: updated });
  }
  if (method === 'GET' && path === `/queue/${params.serviceId}`) {
    const date = validateDate(query.date);
    const service = await getItem(`SERVICE#${params.serviceId}`, 'DETAIL');
    if (!service) throw getHttpError(404, 'SERVICE_NOT_FOUND', 'Service not found.');
    if (!user.roles.includes('ADMIN') && !(user.roles.includes('STAFF') && service.staffId === user.id)) {
      const appointments = await ddb.send(new QueryCommand({
        TableName: tableName,
        IndexName: 'GSI1',
        KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :prefix)',
        ExpressionAttributeValues: { ':pk': `USER#${user.id}`, ':prefix': `APPOINTMENT#${date}` }
      }));
      if (!(appointments.Items ?? []).some((item) =>
        item.serviceId === params.serviceId && !['COMPLETED', 'CANCELLED', 'NO_SHOW'].includes(item.status)
      )) {
        throw getHttpError(403, 'FORBIDDEN', 'Book an appointment or join this queue before viewing it.');
      }
    }
    const queue = await getQueue(params.serviceId, date, user.id);
    const control = await getItem(`SERVICE#${params.serviceId}`, 'QUEUE_CONTROL');
    return jsonResponse(200, {
      ...queue,
      status: control?.status ?? 'OPEN',
      peopleAhead: Math.max(queue.userQueuePosition ?? queue.peopleAhead, 0),
      estimatedWaitMinutes: Math.max(queue.userQueuePosition ?? queue.peopleAhead, 0) * (service?.averageServiceTime ?? 5)
    });
  }
  if (method === 'POST' && path === '/queue/next') return callNext(event, user);
  if (method === 'POST' && path === '/queue/join') return joinWalkInQueue(event, user);
  const queueControl = path.match(/^\/queue\/([^/]+)\/(pause|resume)$/);
  if (method === 'POST' && queueControl) {
    requireRole(user, 'STAFF');
    const service = await getItem(`SERVICE#${queueControl[1]}`, 'DETAIL');
    if (!service || (service.staffId && service.staffId !== user.id && !user.roles.includes('ADMIN'))) {
      throw getHttpError(403, 'FORBIDDEN', 'You are not assigned to this service queue.');
    }
    const status = queueControl[2] === 'pause' ? 'PAUSED' : 'OPEN';
    await ddb.send(new PutCommand({
      TableName: tableName,
      Item: { PK: `SERVICE#${queueControl[1]}`, SK: 'QUEUE_CONTROL', status, updatedAt: new Date().toISOString() }
    }));
    return jsonResponse(200, { serviceId: queueControl[1], status });
  }
  const queueAction = path.match(/^\/queue\/([^/]+)\/(complete|skip|start|no-show)$/);
  if (method === 'POST' && queueAction) {
    const body = readBody(event);
    return updateQueueEntry(
      queueAction[2],
      queueAction[1],
      validateString(body.serviceId, 'Service'),
      validateDate(body.date),
      user
    );
  }
  if (method === 'POST' && path === '/documents/upload') return getUploadUrl(event, user);
  const documentComplete = path.match(/^\/documents\/([^/]+)\/complete$/);
  if (method === 'POST' && documentComplete) {
    const document = await getItem(`DOCUMENT#${documentComplete[1]}`, 'DETAIL');
    if (!document || document.userId !== user.id) throw getHttpError(404, 'DOCUMENT_NOT_FOUND', 'Document not found.');
    const uploaded = await s3.send(new HeadObjectCommand({ Bucket: documentBucket, Key: document.s3ObjectKey }));
    if (uploaded.ContentLength !== document.fileSize || uploaded.ContentLength > 10 * 1024 * 1024 || uploaded.ContentType !== document.contentType) {
      await s3.send(new DeleteObjectCommand({ Bucket: documentBucket, Key: document.s3ObjectKey }));
      throw getHttpError(400, 'INVALID_UPLOAD', 'The uploaded file did not match its validated size or file type.');
    }
    await ddb.send(new UpdateCommand({
      TableName: tableName,
      Key: { PK: document.PK, SK: document.SK },
      UpdateExpression: 'SET #status = :uploaded',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':uploaded': 'UPLOADED' }
    }));
    return jsonResponse(200, { documentId: document.documentId, status: 'UPLOADED' });
  }
  const documentList = path.match(/^\/appointments\/([^/]+)\/documents$/);
  if (method === 'GET' && documentList) return jsonResponse(200, { documents: await listDocuments(documentList[1], user) });
  const documentDownload = path.match(/^\/documents\/([^/]+)\/download$/);
  if (method === 'GET' && documentDownload) {
    const document = await getItem(`DOCUMENT#${documentDownload[1]}`, 'DETAIL');
    if (!document) throw getHttpError(404, 'DOCUMENT_NOT_FOUND', 'Document not found.');
    await findAppointment(document.appointmentId, user);
    const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: documentBucket, Key: document.s3ObjectKey }), { expiresIn: 300 });
    return jsonResponse(200, { url });
  }
  const documentDelete = path.match(/^\/documents\/([^/]+)$/);
  if (method === 'DELETE' && documentDelete) {
    const document = await getItem(`DOCUMENT#${documentDelete[1]}`, 'DETAIL');
    if (!document) throw getHttpError(404, 'DOCUMENT_NOT_FOUND', 'Document not found.');
    await findAppointment(document.appointmentId, user);
    await s3.send(new DeleteObjectCommand({ Bucket: documentBucket, Key: document.s3ObjectKey }));
    await ddb.send(new UpdateCommand({
      TableName: tableName,
      Key: { PK: document.PK, SK: document.SK },
      UpdateExpression: 'SET #status = :deleted',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':deleted': 'DELETED' }
    }));
    return jsonResponse(200, { documentId: document.documentId, status: 'DELETED' });
  }
  if (method === 'GET' && path === '/notifications') {
    const result = await ddb.send(new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: { ':pk': `USER#${user.id}`, ':prefix': 'NOTIFICATION#' },
      ScanIndexForward: false,
      Limit: 50
    }));
    return jsonResponse(200, { notifications: result.Items ?? [] });
  }
  if (method === 'POST' && path === '/notifications/subscribe') {
    if (claimsFor(event).email_verified !== true && claimsFor(event).email_verified !== 'true') {
      throw getHttpError(403, 'EMAIL_NOT_VERIFIED', 'Verify your email address before enabling email notifications.');
    }
    const email = validateString(user.email, 'Verified email');
    const topic = await sns.send(new CreateTopicCommand({
      Name: `${process.env.APPLICATION_NAME}-user-${user.id}`
    }));
    const topicArn = topic.TopicArn;
    if (!topicArn) throw getHttpError(503, 'NOTIFICATIONS_UNAVAILABLE', 'Email notifications are temporarily unavailable.');
    await sns.send(new SubscribeCommand({
      TopicArn: topicArn,
      Protocol: 'email',
      Endpoint: email,
      ReturnSubscriptionArn: true
    }));
    await ddb.send(new UpdateCommand({
      TableName: tableName,
      Key: { PK: `USER#${user.id}`, SK: 'PROFILE' },
      UpdateExpression: 'SET notificationTopicArn = :topic, updatedAt = :now',
      ExpressionAttributeValues: { ':topic': topicArn, ':now': new Date().toISOString() }
    }));
    return jsonResponse(202, { message: 'Check your email and confirm the SNS subscription to receive SmartQueue updates.' });
  }
  if (method === 'GET' && path === '/staff/appointments') {
    requireRole(user, 'STAFF');
    const date = validateDate(query.date);
    const result = await ddb.send(new QueryCommand({
      TableName: tableName,
      IndexName: 'GSI3',
      KeyConditionExpression: 'GSI3PK = :pk AND begins_with(GSI3SK, :prefix)',
      ExpressionAttributeValues: { ':pk': `STAFF#${user.id}#${date}`, ':prefix': 'APPOINTMENT#' }
    }));
    return jsonResponse(200, { appointments: (result.Items ?? []).map(({ PK, SK, GSI1PK, GSI1SK, GSI2PK, GSI2SK, GSI3PK, GSI3SK, ...appointment }) => appointment) });
  }
  if (method === 'POST' && path === '/admin/organizations') {
    requireRole(user, 'ADMIN');
    const organizationId = randomUUID();
    const organization = {
      PK: `ORGANIZATION#${organizationId}`,
      SK: 'DETAIL',
      entity: 'ORGANIZATION',
      organizationId,
      name: validateString(body.name, 'Name'),
      type: validateString(body.type, 'Organization type', 80),
      address: body.address ?? '',
      contact: body.contact ?? '',
      status: 'ACTIVE',
      createdAt: new Date().toISOString(),
      GSI1PK: 'ORGANIZATIONS',
      GSI1SK: `ORGANIZATION#${organizationId}`
    };
    await ddb.send(new PutCommand({ TableName: tableName, Item: organization }));
    return jsonResponse(201, { organization });
  }
  if (method === 'POST' && path === '/admin/services') {
    requireRole(user, 'ADMIN');
    const organizationId = validateString(body.organizationId, 'Organization');
    const departmentId = validateString(body.departmentId, 'Department');
    const department = await getItem(`DEPARTMENT#${departmentId}`, 'DETAIL');
    if (!department || department.organizationId !== organizationId || department.status !== 'ACTIVE') {
      throw getHttpError(400, 'INVALID_DEPARTMENT', 'Choose an active department in the selected organization.');
    }
    const serviceId = randomUUID();
    const service = {
      PK: `SERVICE#${serviceId}`,
      SK: 'DETAIL',
      entity: 'SERVICE',
      serviceId,
      organizationId,
      departmentId,
      name: validateString(body.name, 'Name'),
      description: body.description ?? '',
      staffId: body.staffId ?? undefined,
      averageServiceTime: Number.isInteger(body.averageServiceTime) && body.averageServiceTime > 0 ? body.averageServiceTime : 5,
      schedule: body.schedule ?? { slots: ['09:00', '09:30', '10:00', '10:30', '11:00', '11:30', '13:00', '13:30', '14:00', '14:30', '15:00'] },
      status: 'ACTIVE',
      createdAt: new Date().toISOString(),
      GSI1PK: `ORG#${organizationId}`,
      GSI1SK: `SERVICE#${serviceId}`
    };
    await ddb.send(new PutCommand({ TableName: tableName, Item: service }));
    return jsonResponse(201, { service });
  }
  if (method === 'POST' && path === '/admin/departments') {
    requireRole(user, 'ADMIN');
    const organizationId = validateString(body.organizationId, 'Organization');
    const departmentId = randomUUID();
    const department = {
      PK: `DEPARTMENT#${departmentId}`,
      SK: 'DETAIL',
      entity: 'DEPARTMENT',
      departmentId,
      organizationId,
      name: validateString(body.name, 'Name'),
      description: body.description ?? '',
      status: 'ACTIVE',
      GSI1PK: `ORG#${organizationId}`,
      GSI1SK: `DEPARTMENT#${departmentId}`
    };
    await ddb.send(new PutCommand({ TableName: tableName, Item: department }));
    return jsonResponse(201, { department });
  }
  return jsonResponse(404, { code: 'NOT_FOUND', message: 'This API route was not found.' });
}

export const handler = async (event) => {
  try {
    const user = userFor(event);
    return await handleRoute(event, user);
  } catch (error) {
    const statusCode = error.statusCode ?? 500;
    if (statusCode >= 500) console.error(JSON.stringify({ message: error.message, requestId: event.requestContext?.requestId }));
    return jsonResponse(statusCode, {
      code: error.code ?? 'INTERNAL_ERROR',
      message: statusCode >= 500 ? 'The service is temporarily unavailable. Please try again.' : error.message
    });
  }
};
