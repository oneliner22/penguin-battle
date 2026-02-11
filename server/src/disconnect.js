const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, ScanCommand, UpdateCommand, DeleteCommand } = require('@aws-sdk/lib-dynamodb');
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

  // Find room this connection belongs to
  const scan = await ddb.send(new ScanCommand({
    TableName: TABLE,
    FilterExpression: 'p1ConnectionId = :cid OR p2ConnectionId = :cid',
    ExpressionAttributeValues: { ':cid': connectionId },
  }));

  for (const room of (scan.Items || [])) {
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
