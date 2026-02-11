const { WAFv2Client, GetIPSetCommand, UpdateIPSetCommand } = require('@aws-sdk/client-wafv2');

const wafClient = new WAFv2Client({ region: 'us-east-1' });
const IP_SET_ID = process.env.WAF_IP_SET_ID;
const IP_SET_NAME = process.env.WAF_IP_SET_NAME;

exports.handler = async (event) => {
  if (!IP_SET_ID || !IP_SET_NAME) return;

  const ipsToAdd = new Set();
  const ipsToRemove = new Set();

  for (const record of event.Records) {
    const pk = record.dynamodb?.NewImage?.pk?.S
            || record.dynamodb?.OldImage?.pk?.S;
    if (!pk || !pk.startsWith('ban#')) continue;

    const ip = pk.substring(4);
    if (!ip || !/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) continue;

    const cidr = `${ip}/32`;

    if (record.eventName === 'INSERT') {
      ipsToAdd.add(cidr);
      ipsToRemove.delete(cidr);
    } else if (record.eventName === 'REMOVE') {
      ipsToRemove.add(cidr);
      ipsToAdd.delete(cidr);
    }
  }

  if (ipsToAdd.size === 0 && ipsToRemove.size === 0) return;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const getResult = await wafClient.send(new GetIPSetCommand({
        Name: IP_SET_NAME,
        Scope: 'CLOUDFRONT',
        Id: IP_SET_ID,
      }));

      const currentAddresses = new Set(getResult.IPSet.Addresses);
      for (const ip of ipsToAdd) currentAddresses.add(ip);
      for (const ip of ipsToRemove) currentAddresses.delete(ip);

      await wafClient.send(new UpdateIPSetCommand({
        Name: IP_SET_NAME,
        Scope: 'CLOUDFRONT',
        Id: IP_SET_ID,
        Addresses: Array.from(currentAddresses),
        LockToken: getResult.LockToken,
      }));

      console.log(`WAF IPSet updated: +${ipsToAdd.size} -${ipsToRemove.size}, total: ${currentAddresses.size}`);
      return;
    } catch (e) {
      if (e.name === 'WAFOptimisticLockException' && attempt < 2) {
        console.warn('LockToken conflict, retrying');
        await new Promise(r => setTimeout(r, 100 * (attempt + 1)));
        continue;
      }
      console.error('WAF IPSet update failed (fail-open):', e);
      return;
    }
  }
};
