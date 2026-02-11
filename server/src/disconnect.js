const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, QueryCommand, GetCommand, ScanCommand, DeleteCommand } = require('@aws-sdk/lib-dynamodb');
const { ApiGatewayManagementApiClient, PostToConnectionCommand } = require('@aws-sdk/client-apigatewaymanagementapi');

const client = new DynamoDBClient({});
const ddb = DynamoDBDocumentClient.from(client);
const TABLE = process.env.TABLE_NAME;

function getApiClient(event) {
  const endpoint = process.env.WEBSOCKET_ENDPOINT;
  return new ApiGatewayManagementApiClient({ endpoint });
}

async function sendTo(api, connectionId, data) {
  try {
    await api.send(new PostToConnectionCommand({
      ConnectionId: connectionId,
      Data: Buffer.from(JSON.stringify(data)),
    }));
  } catch (e) {
    if (e.statusCode === 410) {
      console.log('Stale connection:', connectionId);
    } else {
      console.error('Send error:', e);
    }
  }
}

exports.handler = async (event) => {
  const connectionId = event.requestContext.connectionId;
  console.log('Disconnect:', connectionId);
  const api = getApiClient(event);

  // Find room this connection belongs to via GSI (with Scan fallback during GSI creation)
  let rooms;
  try {
    const [p1Result, p2Result] = await Promise.all([
      ddb.send(new QueryCommand({
        TableName: TABLE,
        IndexName: 'P1ConnectionIndex',
        KeyConditionExpression: 'p1ConnectionId = :cid',
        ExpressionAttributeValues: { ':cid': connectionId },
      })),
      ddb.send(new QueryCommand({
        TableName: TABLE,
        IndexName: 'P2ConnectionIndex',
        KeyConditionExpression: 'p2ConnectionId = :cid',
        ExpressionAttributeValues: { ':cid': connectionId },
      })),
    ]);
    rooms = [...(p1Result.Items || []), ...(p2Result.Items || [])];
  } catch (e) {
    // Fallback to Scan during GSI creation period
    console.warn('GSI query failed, falling back to scan:', e.message);
    const scan = await ddb.send(new ScanCommand({
      TableName: TABLE,
      FilterExpression: 'p1ConnectionId = :cid OR p2ConnectionId = :cid',
      ExpressionAttributeValues: { ':cid': connectionId },
    }));
    rooms = scan.Items || [];
  }

  for (const gsiItem of rooms) {
    // GSI returns KEYS_ONLY; fetch full item to get opponent connectionId
    let room = gsiItem;
    if (!room.p1ConnectionId || !room.p2ConnectionId) {
      const fullItem = await ddb.send(new GetCommand({
        TableName: TABLE,
        Key: { roomCode: gsiItem.roomCode },
      }));
      if (!fullItem.Item) continue;
      room = fullItem.Item;
    }

    const otherCid = room.p1ConnectionId === connectionId
      ? room.p2ConnectionId
      : room.p1ConnectionId;

    // Notify opponent
    if (otherCid) {
      await sendTo(api, otherCid, { type: 'opponent_disconnected' });
    }

    // Delete room
    await ddb.send(new DeleteCommand({
      TableName: TABLE,
      Key: { roomCode: room.roomCode },
    }));
  }

  return { statusCode: 200, body: 'Disconnected' };
};
