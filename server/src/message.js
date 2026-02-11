const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand, DeleteCommand, QueryCommand } = require('@aws-sdk/lib-dynamodb');
const { ApiGatewayManagementApiClient, PostToConnectionCommand } = require('@aws-sdk/client-apigatewaymanagementapi');

const client = new DynamoDBClient({});
const ddb = DynamoDBDocumentClient.from(client);
const TABLE = process.env.TABLE_NAME;
const MAX_ROOMS_PER_IP = 3;

function getApiClient() {
  return new ApiGatewayManagementApiClient({ endpoint: process.env.WEBSOCKET_ENDPOINT });
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

// Seeded PRNG (mulberry32) for deterministic damage
function mulberry32(seed) {
  return function() {
    let t = seed += 0x6D2B79F5;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function calcDamage(seed, hitCount, attackType) {
  const rng = mulberry32(seed + hitCount * 7919);
  const r = rng();
  switch (attackType) {
    case 0: return 8 + r * 5;   // slap: 8-13
    case 1: return 12 + r * 6;  // slide: 12-18
    case 2: return 15 + r * 8;  // flop: 15-23
    default: return 10;
  }
}

exports.handler = async (event) => {
  const connectionId = event.requestContext.connectionId;
  const sourceIp = event.requestContext.identity?.sourceIp || 'unknown';
  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: 'Bad JSON' };
  }

  const api = getApiClient();

  switch (body.action) {

    case 'join': {
      const roomCode = String(body.room || '').trim();
      if (!/^\d{4}$/.test(roomCode)) {
        await sendTo(api, connectionId, { type: 'error', code: 'INVALID_ROOM', message: '4桁の数字を入力してください' });
        return { statusCode: 200, body: 'OK' };
      }

      // Check existing room
      const existing = await ddb.send(new GetCommand({
        TableName: TABLE,
        Key: { roomCode },
      }));

      if (existing.Item) {
        const room = existing.Item;
        if (room.status === 'waiting' && !room.p2ConnectionId) {
          // Join as player 2
          const seed = Math.floor(Math.random() * 2147483647);
          await ddb.send(new UpdateCommand({
            TableName: TABLE,
            Key: { roomCode },
            UpdateExpression: 'SET p2ConnectionId = :cid, #s = :playing, seed = :seed, hitCount = :zero',
            ExpressionAttributeNames: { '#s': 'status' },
            ExpressionAttributeValues: {
              ':cid': connectionId,
              ':playing': 'playing',
              ':seed': seed,
              ':zero': 0,
            },
            ConditionExpression: 'attribute_not_exists(p2ConnectionId) OR p2ConnectionId = :empty',
            ExpressionAttributeValues: {
              ':cid': connectionId,
              ':playing': 'playing',
              ':seed': seed,
              ':zero': 0,
              ':empty': '',
            },
          }));

          // Notify both players
          await sendTo(api, room.p1ConnectionId, { type: 'start', seed, you: 'p1' });
          await sendTo(api, connectionId, { type: 'start', seed, you: 'p2' });
        } else {
          await sendTo(api, connectionId, { type: 'error', code: 'ROOM_FULL', message: 'このルームは満員です' });
        }
      } else {
        // Check IP rate limit
        const ipQuery = await ddb.send(new QueryCommand({
          TableName: TABLE,
          IndexName: 'IpIndex',
          KeyConditionExpression: 'creatorIp = :ip',
          ExpressionAttributeValues: { ':ip': sourceIp },
        }));

        if ((ipQuery.Items || []).length >= MAX_ROOMS_PER_IP) {
          await sendTo(api, connectionId, {
            type: 'error',
            code: 'ROOM_LIMIT',
            message: 'ルーム作成上限に達しました。1〜2分後に再度お試しください',
          });
          return { statusCode: 200, body: 'OK' };
        }

        // Create new room
        await ddb.send(new PutCommand({
          TableName: TABLE,
          Item: {
            roomCode,
            p1ConnectionId: connectionId,
            p2ConnectionId: '',
            creatorIp: sourceIp,
            status: 'waiting',
            seed: 0,
            hitCount: 0,
            ttl: Math.floor(Date.now() / 1000) + 300, // 5 minutes
          },
        }));
        await sendTo(api, connectionId, { type: 'waiting', room: roomCode });
      }
      break;
    }

    case 'input': {
      // Relay input to opponent
      const roomCode = String(body.room || '');
      const room = (await ddb.send(new GetCommand({ TableName: TABLE, Key: { roomCode } }))).Item;
      if (!room || room.status !== 'playing') break;

      const opponentCid = room.p1ConnectionId === connectionId
        ? room.p2ConnectionId
        : room.p1ConnectionId;

      if (opponentCid) {
        await sendTo(api, opponentCid, {
          type: 'input',
          frame: body.frame,
          left: body.left,
          right: body.right,
          up: body.up,
          atk: body.atk,
        });
      }
      break;
    }

    case 'hit': {
      // Server-authoritative damage calculation
      const roomCode = String(body.room || '');
      const room = (await ddb.send(new GetCommand({ TableName: TABLE, Key: { roomCode } }))).Item;
      if (!room || room.status !== 'playing') break;

      const newHitCount = (room.hitCount || 0) + 1;
      const dmg = calcDamage(room.seed, newHitCount, body.attackType || 0);

      await ddb.send(new UpdateCommand({
        TableName: TABLE,
        Key: { roomCode },
        UpdateExpression: 'SET hitCount = :hc',
        ExpressionAttributeValues: { ':hc': newHitCount },
      }));

      // Determine target
      const attacker = room.p1ConnectionId === connectionId ? 'p1' : 'p2';
      const target = attacker === 'p1' ? 'p2' : 'p1';

      const dmgMsg = { type: 'damage', target, dmg: Math.round(dmg * 10) / 10, hitNum: newHitCount };
      await sendTo(api, room.p1ConnectionId, dmgMsg);
      await sendTo(api, room.p2ConnectionId, dmgMsg);
      break;
    }

    case 'end': {
      // Game over, clean up
      const roomCode = String(body.room || '');
      const room = (await ddb.send(new GetCommand({ TableName: TABLE, Key: { roomCode } }))).Item;
      if (!room) break;

      const winner = body.winner || 'unknown';
      const endMsg = { type: 'end', winner };

      if (room.p1ConnectionId) await sendTo(api, room.p1ConnectionId, endMsg);
      if (room.p2ConnectionId) await sendTo(api, room.p2ConnectionId, endMsg);

      await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { roomCode } }));
      break;
    }
  }

  return { statusCode: 200, body: 'OK' };
};
