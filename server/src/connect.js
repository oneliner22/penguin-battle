const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');

const client = new DynamoDBClient({});
const ddb = DynamoDBDocumentClient.from(client);
const THROTTLE_TABLE = process.env.THROTTLE_TABLE;

const CONN_RATE_LIMIT = 30;    // max connections per minute per IP
const BAN_DURATION = 86400;     // 24 hours in seconds

function getClientIp(event) {
  // When behind CloudFront, real client IP is in X-Forwarded-For header
  const xff = event.headers?.['X-Forwarded-For'] || event.headers?.['x-forwarded-for'];
  if (xff) {
    const firstIp = xff.split(',')[0].trim();
    if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(firstIp)) return firstIp;
  }
  return event.requestContext.identity?.sourceIp || 'unknown';
}

exports.handler = async (event) => {
  const connectionId = event.requestContext.connectionId;
  const sourceIp = getClientIp(event);
  console.log('Connect:', connectionId, 'IP:', sourceIp);

  if (!THROTTLE_TABLE || sourceIp === 'unknown') {
    // Fail-open: if no throttle table configured or no IP, allow connection
    return { statusCode: 200, body: 'Connected' };
  }

  try {
    // Step 1: Check existing ban
    const now = Math.floor(Date.now() / 1000);
    const banKey = `ban#${sourceIp}`;
    const banResult = await ddb.send(new GetCommand({
      TableName: THROTTLE_TABLE,
      Key: { pk: banKey },
    }));

    // TTL deletion is delayed — explicitly check ttl value
    if (banResult.Item && banResult.Item.ttl > now) {
      console.log('Banned IP rejected:', sourceIp);
      return { statusCode: 403, body: 'Forbidden' };
    }

    // Step 2: Increment connection rate counter
    const minute = Math.floor(now / 60);
    const connKey = `conn#${sourceIp}#${minute}`;
    const counterResult = await ddb.send(new UpdateCommand({
      TableName: THROTTLE_TABLE,
      Key: { pk: connKey },
      UpdateExpression: 'ADD #cnt :one SET #ttl = if_not_exists(#ttl, :ttl)',
      ExpressionAttributeNames: { '#cnt': 'cnt', '#ttl': 'ttl' },
      ExpressionAttributeValues: { ':one': 1, ':ttl': now + 120 },
      ReturnValues: 'UPDATED_NEW',
    }));

    const count = counterResult.Attributes.cnt;

    // Step 3: If over limit, create ban record and reject
    if (count > CONN_RATE_LIMIT) {
      console.log('IP rate limit exceeded, banning:', sourceIp, 'count:', count);
      await ddb.send(new PutCommand({
        TableName: THROTTLE_TABLE,
        Item: {
          pk: banKey,
          ttl: now + BAN_DURATION,
          reason: 'conn_rate',
          count,
        },
      }));
      return { statusCode: 403, body: 'Forbidden' };
    }

    return { statusCode: 200, body: 'Connected' };
  } catch (e) {
    // Fail-open: on any error, allow connection (prevent self-DoS)
    console.error('Throttle check error (fail-open):', e);
    return { statusCode: 200, body: 'Connected' };
  }
};
