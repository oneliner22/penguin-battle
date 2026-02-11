const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, ScanCommand, QueryCommand } = require('@aws-sdk/lib-dynamodb');

const client = new DynamoDBClient({});
const ddb = DynamoDBDocumentClient.from(client);
const TABLE = process.env.TABLE_NAME;
const THROTTLE_TABLE = process.env.THROTTLE_TABLE;
const GAMELOG_TABLE = process.env.GAMELOG_TABLE;
const ADMIN_IPS = (process.env.ADMIN_IPS || '').split(',').map(s => s.trim()).filter(Boolean);

function getClientIp(event) {
  const xff = event.headers?.['x-forwarded-for'];
  if (xff) {
    const firstIp = xff.split(',')[0].trim();
    if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(firstIp)) return firstIp;
  }
  return event.requestContext?.http?.sourceIp || 'unknown';
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
    body: JSON.stringify(body),
  };
}

function dateStr(daysAgo = 0) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

async function queryGameLog(dateKey) {
  const items = [];
  let lastKey;
  do {
    const res = await ddb.send(new QueryCommand({
      TableName: GAMELOG_TABLE,
      KeyConditionExpression: 'dateKey = :dk',
      ExpressionAttributeValues: { ':dk': dateKey },
      ExclusiveStartKey: lastKey,
    }));
    items.push(...(res.Items || []));
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);
  return items;
}

// Anomaly detection flags
function flagGame(game) {
  const flags = [];
  if (game.durationSec < 5) flags.push('FAST_MATCH');
  if (game.hitCount > 100) flags.push('HIGH_HIT_COUNT');
  if (game.hitCount === 0 && game.winner !== 'draw') flags.push('NO_HITS_WIN');
  if (game.p1Ip && game.p2Ip && game.p1Ip === game.p2Ip && game.p1Ip !== 'unknown') flags.push('SAME_IP');
  return flags;
}

exports.handler = async (event) => {
  // IP whitelist check
  const ip = getClientIp(event);
  if (ADMIN_IPS.length === 0 || !ADMIN_IPS.includes(ip)) {
    console.log('Dashboard access denied:', ip);
    return json(403, { error: 'Forbidden' });
  }

  const path = event.rawPath || '';
  const qs = event.queryStringParameters || {};

  try {
    // GET /stats/overview
    if (path === '/stats/overview') {
      const now = Math.floor(Date.now() / 1000);
      const today = dateStr(0);

      // Parallel: rooms scan, bans scan, today's games
      const [roomsRes, bansRes, todayGames] = await Promise.all([
        ddb.send(new ScanCommand({ TableName: TABLE })),
        ddb.send(new ScanCommand({
          TableName: THROTTLE_TABLE,
          FilterExpression: 'begins_with(pk, :ban) AND #ttl > :now',
          ExpressionAttributeNames: { '#ttl': 'ttl' },
          ExpressionAttributeValues: { ':ban': 'ban#', ':now': now },
        })),
        queryGameLog(today),
      ]);

      const rooms = roomsRes.Items || [];
      const activeRooms = rooms.filter(r => r.status === 'waiting').length;
      const playingRooms = rooms.filter(r => r.status === 'playing').length;
      const activeBans = (bansRes.Items || []).length;

      const uniqueIps = new Set();
      todayGames.forEach(g => {
        if (g.p1Ip && g.p1Ip !== 'unknown') uniqueIps.add(g.p1Ip);
        if (g.p2Ip && g.p2Ip !== 'unknown') uniqueIps.add(g.p2Ip);
      });

      return json(200, {
        activeRooms,
        playingRooms,
        activeBans,
        todayGames: todayGames.length,
        todayUniquePlayers: uniqueIps.size,
        serverTime: new Date().toISOString(),
      });
    }

    // GET /stats/history?period=day|week|month
    if (path === '/stats/history') {
      const period = qs.period || 'week';
      const days = period === 'month' ? 30 : period === 'week' ? 7 : 1;

      const dateKeys = [];
      for (let i = 0; i < days; i++) dateKeys.push(dateStr(i));

      // Parallel query all dates
      const allResults = await Promise.all(dateKeys.map(dk => queryGameLog(dk)));

      const history = dateKeys.map((dk, i) => {
        const games = allResults[i];
        const ips = new Set();
        let totalDuration = 0;
        let p1Wins = 0, p2Wins = 0, draws = 0, timeups = 0;

        games.forEach(g => {
          if (g.p1Ip && g.p1Ip !== 'unknown') ips.add(g.p1Ip);
          if (g.p2Ip && g.p2Ip !== 'unknown') ips.add(g.p2Ip);
          totalDuration += g.durationSec || 0;
          if (g.winner === 'p1') p1Wins++;
          else if (g.winner === 'p2') p2Wins++;
          else draws++;
          if (g.timeup) timeups++;
        });

        return {
          date: dk,
          games: games.length,
          uniquePlayers: ips.size,
          avgDuration: games.length > 0 ? Math.round(totalDuration / games.length) : 0,
          p1Wins, p2Wins, draws, timeups,
        };
      }).reverse(); // oldest first

      // WAU/MAU: collect unique IPs across all queried days
      const wauIps = new Set();
      allResults.forEach(games => {
        games.forEach(g => {
          if (g.p1Ip && g.p1Ip !== 'unknown') wauIps.add(g.p1Ip);
          if (g.p2Ip && g.p2Ip !== 'unknown') wauIps.add(g.p2Ip);
        });
      });

      return json(200, {
        period,
        days,
        history,
        periodUniquePlayers: wauIps.size,
        periodTotalGames: allResults.reduce((sum, g) => sum + g.length, 0),
      });
    }

    // GET /stats/security
    if (path === '/stats/security') {
      const now = Math.floor(Date.now() / 1000);

      // Active bans
      const bansRes = await ddb.send(new ScanCommand({
        TableName: THROTTLE_TABLE,
        FilterExpression: 'begins_with(pk, :ban) AND #ttl > :now',
        ExpressionAttributeNames: { '#ttl': 'ttl' },
        ExpressionAttributeValues: { ':ban': 'ban#', ':now': now },
      }));

      const bans = (bansRes.Items || []).map(b => ({
        ip: b.pk.replace('ban#', ''),
        reason: b.reason || 'unknown',
        count: b.count || 0,
        expiresAt: new Date(b.ttl * 1000).toISOString(),
        remainingSec: b.ttl - now,
      }));

      // Last 7 days IP frequency from GameLog
      const dateKeys = [];
      for (let i = 0; i < 7; i++) dateKeys.push(dateStr(i));
      const allResults = await Promise.all(dateKeys.map(dk => queryGameLog(dk)));

      const ipFreq = {};
      allResults.forEach(games => {
        games.forEach(g => {
          [g.p1Ip, g.p2Ip].forEach(ip => {
            if (ip && ip !== 'unknown') ipFreq[ip] = (ipFreq[ip] || 0) + 1;
          });
        });
      });

      // Sort by frequency descending, top 50
      const topIps = Object.entries(ipFreq)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 50)
        .map(([ip, count]) => ({ ip, games: count }));

      return json(200, { bans, topIps });
    }

    // GET /stats/games?date=YYYY-MM-DD
    if (path === '/stats/games') {
      const date = qs.date || dateStr(0);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return json(400, { error: 'Invalid date format. Use YYYY-MM-DD' });
      }

      const games = await queryGameLog(date);

      const result = games.map(g => ({
        matchId: g.matchId,
        roomCode: g.roomCode,
        winner: g.winner,
        timeup: g.timeup || false,
        durationSec: g.durationSec || 0,
        hitCount: g.hitCount || 0,
        p1Ip: g.p1Ip,
        p2Ip: g.p2Ip,
        p1FinalHp: g.p1FinalHp,
        p2FinalHp: g.p2FinalHp,
        endedAt: g.endedAt ? new Date(g.endedAt * 1000).toISOString() : null,
        flags: flagGame(g),
      }));

      return json(200, { date, total: result.length, games: result });
    }

    return json(404, { error: 'Not found' });
  } catch (e) {
    console.error('Dashboard error:', e);
    return json(500, { error: 'Internal server error' });
  }
};
