'use strict';

const { pool } = require('../config/db');
const { formatChatMessage } = require('./chatFormatter');

/**
 * Load pinned chat message details for a channel row.
 * @param {{ pinned_message_id?: number|null, pinned_message_id_1?: number|null, pinned_message_id_2?: number|null, pinned_message_id_3?: number|null }} channelRow
 */
async function getPinnedMessages(channelRow) {
  const pinnedObj = {
    common: null,
    1: null,
    2: null,
    3: null
  };

  const idMap = {
    common: channelRow.pinned_message_id,
    1: channelRow.pinned_message_id_1,
    2: channelRow.pinned_message_id_2,
    3: channelRow.pinned_message_id_3
  };

  const idsToFetch = Object.values(idMap).filter((id) => id !== null && id !== undefined);
  if (idsToFetch.length === 0) return pinnedObj;

  try {
    const [rows] = await pool.query(`
      SELECT pm.id, pm.message, pm.guest_name, u.username, pm.role, pm.color
      FROM chat_messages pm
      LEFT JOIN users u ON pm.user_id = u.id
      WHERE pm.id IN (?)
    `, [idsToFetch]);

    const msgDetails = {};
    rows.forEach((r) => {
      msgDetails[r.id] = {
        id: r.id,
        message: formatChatMessage(r.message),
        role: r.role,
        color: r.color,
        username: r.username || r.guest_name
      };
    });

    for (const key of Object.keys(idMap)) {
      const msgId = idMap[key];
      if (msgId && msgDetails[msgId]) {
        pinnedObj[key] = msgDetails[msgId];
      }
    }
  } catch (e) {
    console.error('Error fetching pinned messages details:', e);
  }

  return pinnedObj;
}

module.exports = { getPinnedMessages };
