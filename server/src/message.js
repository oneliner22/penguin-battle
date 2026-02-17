const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand, DeleteCommand, QueryCommand } = require('@aws-sdk/lib-dynamodb');
const { ApiGatewayManagementApiClient, PostToConnectionCommand } = require('@aws-sdk/client-apigatewaymanagementapi');

const client = new DynamoDBClient({});
const ddb = DynamoDBDocumentClient.from(client);
const TABLE = process.env.TABLE_NAME;
const THROTTLE_TABLE = process.env.THROTTLE_TABLE;
const MAX_ROOMS_PER_IP = 3;
const MSG_RATE_LIMIT = 18000;   // max messages per minute per IP
const BAN_DURATION = 86400;     // 24 hours in seconds
const SAMPLE_RATE = 0.05;       // 5% sampling
const SAMPLE_MULTIPLIER = 20;   // 1/0.05 = compensate for sampling
const GAMELOG_TABLE = process.env.GAMELOG_TABLE;

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

function calcDamage(seed, hitCount, attackType, countered) {
  if (countered) return 5; // Fixed counter damage (GUARD reflects STRIKE)
  const rng = mulberry32(seed + hitCount * 7919);
  const r = rng();
  switch (attackType) {
    case 0: return 6 + r * 4;   // SLAP: 6-10 (fast, pierces GUARD)
    case 1: return 14 + r * 6;  // STRIKE: 14-20 (strong, blocked by GUARD)
    default: return 0;           // GUARD: no damage
  }
}

exports.handler = async (event) => {
  const connectionId = event.requestContext.connectionId;
  const sourceIp = event.requestContext.identity?.sourceIp || 'unknown';

  // 5% sampled message rate tracking (before JSON.parse to catch garbage data)
  if (THROTTLE_TABLE && sourceIp !== 'unknown' && Math.random() < SAMPLE_RATE) {
    try {
      const now = Math.floor(Date.now() / 1000);
      const minute = Math.floor(now / 60);
      const msgKey = `msg#${sourceIp}#${minute}`;
      const result = await ddb.send(new UpdateCommand({
        TableName: THROTTLE_TABLE,
        Key: { pk: msgKey },
        UpdateExpression: 'ADD #cnt :inc SET #ttl = if_not_exists(#ttl, :ttl)',
        ExpressionAttributeNames: { '#cnt': 'cnt', '#ttl': 'ttl' },
        ExpressionAttributeValues: { ':inc': SAMPLE_MULTIPLIER, ':ttl': now + 120 },
        ReturnValues: 'UPDATED_NEW',
      }));
      if (result.Attributes.cnt > MSG_RATE_LIMIT) {
        const banKey = `ban#${sourceIp}`;
        await ddb.send(new PutCommand({
          TableName: THROTTLE_TABLE,
          Item: { pk: banKey, ttl: now + BAN_DURATION, reason: 'msg_rate', count: result.Attributes.cnt },
        }));
        console.log('Message rate ban:', sourceIp, 'count:', result.Attributes.cnt);
      }
    } catch (e) {
      // Fail-open: ignore throttle errors
      console.error('Message throttle error (fail-open):', e);
    }
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: 'Bad JSON' };
  }

  const api = getApiClient();

  switch (body.action) {

    case 'join': {
      const roomCode = String(body.room || '').trim().toUpperCase();
      if (!/^[A-Z0-9]{6}$/.test(roomCode)) {
        await sendTo(api, connectionId, { type: 'error', code: 'INVALID_ROOM', message: '6文字の英数字を入力してください' });
        return { statusCode: 200, body: 'OK' };
      }

      // Check existing room
      const existing = await ddb.send(new GetCommand({
        TableName: TABLE,
        Key: { roomCode },
      }));

      if (existing.Item) {
        const room = existing.Item;
        if (room.status === 'waiting' && (!room.p1ConnectionId || room.p1ConnectionId === '')) {
          // Room exists but empty (after rematch reset) — join as p1
          await ddb.send(new UpdateCommand({
            TableName: TABLE,
            Key: { roomCode },
            UpdateExpression: 'SET p1ConnectionId = :cid, #t = :ttl',
            ExpressionAttributeNames: { '#t': 'ttl' },
            ExpressionAttributeValues: {
              ':cid': connectionId,
              ':ttl': Math.floor(Date.now() / 1000) + 300,
            },
          }));
          await sendTo(api, connectionId, { type: 'waiting', room: roomCode });
        } else if (room.status === 'waiting' && (!room.p2ConnectionId || room.p2ConnectionId === '')) {
          // Join as player 2
          const seed = Math.floor(Math.random() * 2147483647);
          await ddb.send(new UpdateCommand({
            TableName: TABLE,
            Key: { roomCode },
            UpdateExpression: 'SET p2ConnectionId = :cid, #s = :playing, seed = :seed, hitCount = :zero, p2Ip = :p2Ip, p1Hp = :maxHp, p2Hp = :maxHp, #t = :ttl',
            ExpressionAttributeNames: { '#s': 'status', '#t': 'ttl' },
            ConditionExpression: 'p2ConnectionId = :empty OR attribute_not_exists(p2ConnectionId)',
            ExpressionAttributeValues: {
              ':cid': connectionId,
              ':playing': 'playing',
              ':seed': seed,
              ':zero': 0,
              ':empty': '',
              ':p2Ip': sourceIp,
              ':maxHp': 100,
              ':ttl': Math.floor(Date.now() / 1000) + 420,
            },
          }));

          // Notify both players
          await sendTo(api, room.p1ConnectionId, { type: 'start', seed, you: 'p1', ttl: 420 });
          await sendTo(api, connectionId, { type: 'start', seed, you: 'p2', ttl: 420 });
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
            creatorIp: sourceIp,
            status: 'waiting',
            seed: 0,
            hitCount: 0,
            createdAt: Math.floor(Date.now() / 1000),
            ttl: Math.floor(Date.now() / 1000) + 300, // 5 minutes
          },
        }));
        await sendTo(api, connectionId, { type: 'waiting', room: roomCode });
      }
      break;
    }

    case 'state': {
      // Full state relay — pass through entire state to opponent
      const roomCode = String(body.room || '');
      const room = (await ddb.send(new GetCommand({ TableName: TABLE, Key: { roomCode } }))).Item;
      if (!room || room.status !== 'playing') break;
      if (room.p1ConnectionId !== connectionId && room.p2ConnectionId !== connectionId) break;

      const opponentCid = room.p1ConnectionId === connectionId
        ? room.p2ConnectionId
        : room.p1ConnectionId;

      if (opponentCid) {
        // Relay full state: position, velocity, attack state, input
        await sendTo(api, opponentCid, {
          type: 'state',
          x: body.x,
          y: body.y,
          vx: body.vx,
          vy: body.vy,
          atk: body.atk,       // attack type if attacking, -1 if not
          atkT: body.atkT,     // attackTimer
          isAtk: body.isAtk,   // isAttacking
          atkCd: body.atkCd,   // attackCooldown
          slideT: body.slideT, // slideTimer
          hp: body.hp,
          f: body.f,           // frame count
          gr: body.gr,         // grounded
          face: body.face,     // facing direction
        });
      }
      break;
    }

    case 'hit': {
      // Server-authoritative damage calculation
      const roomCode = String(body.room || '');
      const room = (await ddb.send(new GetCommand({ TableName: TABLE, Key: { roomCode } }))).Item;
      if (!room || room.status !== 'playing') break;
      if (room.p1ConnectionId !== connectionId && room.p2ConnectionId !== connectionId) break;

      const countered = !!body.countered;
      const newHitCount = (room.hitCount || 0) + 1;
      const dmg = calcDamage(room.seed, newHitCount, body.attackType || 0, countered);

      // Determine target — if countered, damage goes back to the attacker
      const attackerRole = room.p1ConnectionId === connectionId ? 'p1' : 'p2';
      const defenderRole = attackerRole === 'p1' ? 'p2' : 'p1';
      const target = countered ? attackerRole : defenderRole;
      const hpField = target === 'p1' ? 'p1Hp' : 'p2Hp';
      const roundedDmg = Math.round(dmg * 10) / 10;

      await ddb.send(new UpdateCommand({
        TableName: TABLE,
        Key: { roomCode },
        UpdateExpression: `SET hitCount = :hc, ${hpField} = if_not_exists(${hpField}, :maxHp) - :dmg`,
        ExpressionAttributeValues: { ':hc': newHitCount, ':dmg': roundedDmg, ':maxHp': 100 },
      }));

      const dmgMsg = { type: 'damage', target, dmg: roundedDmg, hitNum: newHitCount, countered };
      await sendTo(api, room.p1ConnectionId, dmgMsg);
      await sendTo(api, room.p2ConnectionId, dmgMsg);
      break;
    }

    case 'end': {
      // Game over — reset room for rematch instead of deleting
      const roomCode = String(body.room || '');
      const room = (await ddb.send(new GetCommand({ TableName: TABLE, Key: { roomCode } }))).Item;
      if (!room) break;

      // Only process if room is still in 'playing' state (prevents double-end race)
      if (room.status !== 'playing') break;
      if (room.p1ConnectionId !== connectionId && room.p2ConnectionId !== connectionId) break;

      const winner = body.winner || 'unknown';
      const now = Math.floor(Date.now() / 1000);

      // Write game log (fail-open, idempotent via ConditionExpression)
      if (GAMELOG_TABLE) {
        try {
          const dateKey = new Date().toISOString().slice(0, 10);
          await ddb.send(new PutCommand({
            TableName: GAMELOG_TABLE,
            Item: {
              dateKey,
              matchId: `${Date.now()}#${roomCode}`,
              roomCode,
              winner,
              timeup: !!body.timeup,
              durationSec: room.createdAt ? now - room.createdAt : 0,
              hitCount: room.hitCount || 0,
              p1Ip: room.creatorIp || 'unknown',
              p2Ip: room.p2Ip || 'unknown',
              p1FinalHp: Math.round((room.p1Hp ?? 100) * 10) / 10,
              p2FinalHp: Math.round((room.p2Hp ?? 100) * 10) / 10,
              seed: room.seed || 0,
              endedAt: now,
            },
            ConditionExpression: 'attribute_not_exists(matchId)',
          }));
        } catch (e) {
          if (e.name !== 'ConditionalCheckFailedException') {
            console.error('GameLog write error (fail-open):', e);
          }
        }
      }

      const endMsg = { type: 'end', winner };
      if (body.timeup) endMsg.timeup = true;

      if (room.p1ConnectionId) await sendTo(api, room.p1ConnectionId, endMsg);
      if (room.p2ConnectionId) await sendTo(api, room.p2ConnectionId, endMsg);

      // Reset room to waiting with no players, extend TTL for rematch
      // Use ConditionExpression to prevent race condition with second 'end' message
      try {
        await ddb.send(new UpdateCommand({
          TableName: TABLE,
          Key: { roomCode },
          UpdateExpression: 'SET #s = :waiting, seed = :zero, hitCount = :zero, #t = :ttl REMOVE p1ConnectionId, p2ConnectionId',
          ExpressionAttributeNames: { '#s': 'status', '#t': 'ttl' },
          ConditionExpression: '#s = :playing',
          ExpressionAttributeValues: {
            ':waiting': 'waiting',
            ':zero': 0,
            ':ttl': Math.floor(Date.now() / 1000) + 300,
            ':playing': 'playing',
          },
        }));
      } catch (e) {
        // ConditionalCheckFailedException means another 'end' already processed — ignore
        if (e.name !== 'ConditionalCheckFailedException') throw e;
      }
      break;
    }

    case 'cancel': {
      // Client-initiated room cancellation (waiting timeout or manual cancel)
      const roomCode = String(body.room || '');
      if (!roomCode) break;
      const room = (await ddb.send(new GetCommand({ TableName: TABLE, Key: { roomCode } }))).Item;
      if (!room) break;

      // Only allow cancellation of waiting rooms by the room creator
      if (room.status !== 'waiting') break;
      if (room.p1ConnectionId !== connectionId && room.p2ConnectionId !== connectionId) break;

      await ddb.send(new DeleteCommand({
        TableName: TABLE,
        Key: { roomCode },
      }));
      break;
    }
  }

  return { statusCode: 200, body: 'OK' };
};
