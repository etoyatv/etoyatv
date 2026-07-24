// utils/ipChecker.js

function ip2long(ip) {
  if (!ip || typeof ip !== 'string') return 0;
  return ip.split('.').reduce((acc, octet) => (acc << 8) + parseInt(octet, 10), 0) >>> 0;
}

function isIpInBanRecord(userIp, banStr) {
  if (!userIp || !banStr) return false;
  
  if (userIp.includes(',')) {
    userIp = userIp.split(',')[0].trim();
  }
  
  banStr = banStr.trim();
  userIp = userIp.trim();

  // Exact match
  if (userIp === banStr) return true;

  // Wildcard match (e.g. 192.168.1.*)
  if (banStr.includes('*')) {
    const regexStr = '^' + banStr.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$';
    try {
      const regex = new RegExp(regexStr);
      return regex.test(userIp);
    } catch (e) {
      return false;
    }
  }

  // CIDR match (e.g. 192.168.1.0/24)
  if (banStr.includes('/')) {
    const parts = banStr.split('/');
    if (parts.length !== 2) return false;
    const base = ip2long(parts[0]);
    const mask = parseInt(parts[1], 10);
    if (isNaN(mask) || mask < 0 || mask > 32) return false;
    const user = ip2long(userIp);
    const bitmask = -1 << (32 - mask);
    return (user & bitmask) === (base & bitmask);
  }

  // Range match (e.g. 192.168.1.0-192.168.1.255)
  if (banStr.includes('-')) {
    const parts = banStr.split('-');
    if (parts.length !== 2) return false;
    const start = ip2long(parts[0].trim());
    const end = ip2long(parts[1].trim());
    const user = ip2long(userIp);
    return user >= start && user <= end;
  }

  return false;
}

async function isProtectedIp(connection, targetBanString, myIp) {
  if (!targetBanString) return false;
  
  const [staffRows] = await connection.query('SELECT u.last_ip, u.reg_ip FROM staff s JOIN users u ON s.user_id = u.id');
  const adminIps = new Set();
  staffRows.forEach(r => {
    if (r.last_ip) adminIps.add(r.last_ip);
    if (r.reg_ip) adminIps.add(r.reg_ip);
  });
  if (myIp) adminIps.add(myIp);
  
  for (let ip of adminIps) {
    if (isIpInBanRecord(ip, targetBanString)) {
      return true;
    }
  }
  return false;
}

module.exports = { isIpInBanRecord, isProtectedIp };
