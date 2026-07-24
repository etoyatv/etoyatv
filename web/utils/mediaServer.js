const axios = require('axios');

const RTMP_SERVER_IP = process.env.RTMP_SERVER_IP || '192.168.90.5';
const RTMP_API_PORT = process.env.RTMP_API_PORT || '9997';
const BASE_URL = `http://${RTMP_SERVER_IP}:${RTMP_API_PORT}`;

/**
 * Kick/disconnect a publisher on MediaMTX
 * @param {string} shortname - The channel shortname
 */
async function kickStream(shortname) {
  if (!shortname) return;
  let baseShortname = shortname;
  const match = shortname.match(/^(.+)_(1|2|3)$/);
  if (match) {
    baseShortname = match[1];
  }
  
  const targetPaths = new Set([
    `live/${baseShortname.toLowerCase()}`,
    `live/${baseShortname.toLowerCase()}_2`,
    `live/${baseShortname.toLowerCase()}_3`,
    // bare path variants (some publishers omit live/)
    baseShortname.toLowerCase(),
    `${baseShortname.toLowerCase()}_2`,
    `${baseShortname.toLowerCase()}_3`
  ]);

  let kickedCount = 0;
  let kickedIp = null;

  const extractIp = (remoteAddr) => {
    if (!remoteAddr) return null;
    if (remoteAddr.startsWith('[')) {
      const closeBracketIndex = remoteAddr.indexOf(']');
      if (closeBracketIndex !== -1) {
        return remoteAddr.substring(1, closeBracketIndex);
      }
    }
    return remoteAddr.split(':')[0];
  };

  try {
    // Kick RTMP publishers
    const listUrl = `${BASE_URL}/v3/rtmpconns/list`;
    const response = await axios.get(listUrl, { timeout: 3000 });
    if (response.status === 200 && response.data && response.data.items) {
      for (const item of response.data.items) {
        if (item.state === 'publish' && item.path && targetPaths.has(item.path.toLowerCase())) {
          const kickUrl = `${BASE_URL}/v3/rtmpconns/kick/${item.id}`;
          console.log(`[MediaMTX API] Kicking RTMP publisher ${item.id} for path: ${item.path}`);
          try {
            await axios.post(kickUrl);
            kickedCount++;
            kickedIp = extractIp(item.remoteAddr) || kickedIp;
          } catch (kickErr) {
            console.error(`[MediaMTX API] Failed to kick RTMP connection ${item.id}:`, kickErr.message);
          }
        }
      }
    }
  } catch (err) {
    console.error(`[MediaMTX API] Error listing RTMP for ${shortname}:`, err.message);
  }

  try {
    // Kick WebRTC/WHIP publishers (browser studio)
    const wcUrl = `${BASE_URL}/v3/webrtcsessions/list`;
    const wcRes = await axios.get(wcUrl, { timeout: 3000 });
    if (wcRes.status === 200 && wcRes.data && wcRes.data.items) {
      for (const item of wcRes.data.items) {
        const path = (item.path || '').toLowerCase();
        if (item.state === 'publish' && path && targetPaths.has(path)) {
          const kickUrl = `${BASE_URL}/v3/webrtcsessions/kick/${item.id}`;
          console.log(`[MediaMTX API] Kicking WebRTC publisher ${item.id} for path: ${item.path}`);
          try {
            await axios.post(kickUrl);
            kickedCount++;
            kickedIp = extractIp(item.remoteAddr) || kickedIp;
          } catch (kickErr) {
            console.error(`[MediaMTX API] Failed to kick WebRTC session ${item.id}:`, kickErr.message);
          }
        }
      }
    }
  } catch (err) {
    console.error(`[MediaMTX API] Error listing WebRTC for ${shortname}:`, err.message);
  }

  return { kicked: kickedCount > 0, ip: kickedIp };
}

/**
 * Check if the MediaMTX server is online
 */
async function isServerAlive() {
  try {
    const url = `${BASE_URL}/v3/paths/list`;
    const response = await axios.get(url, { timeout: 3000 });
    return response.status === 200;
  } catch (err) {
    console.error('[MediaMTX API] Server health check failed:', err.message);
    return false;
  }
}

module.exports = {
  kickStream,
  isServerAlive
};
