'use strict';

/**
 * Startup heal: stuck recordings / live flags vs MediaMTX.
 * @param {{ pool: import('mysql2/promise').Pool }} deps
 */
function runStartupHeal({ pool }) {
  pool.query("UPDATE records SET processing_status = 'error' WHERE processing_status = 'recording'")
    .then(([result]) => {
      if (result.affectedRows > 0) {
        console.log(`Reset ${result.affectedRows} stuck 'recording' records to 'error'.`);
      }
    })
    .catch((err) => {
      console.error('Error resetting stuck recording records:', err);
    });

  pool.query('UPDATE channels SET viewers = 0 WHERE is_live = 1')
    .catch((err) => console.error('Error resetting viewers:', err));

  const axios = require('axios');
  const RTMP_SERVER_IP = process.env.RTMP_SERVER_IP || '192.168.90.5';
  const RTMP_API_PORT = process.env.RTMP_API_PORT || '9997';
  const BASE_URL = `http://${RTMP_SERVER_IP}:${RTMP_API_PORT}`;

  axios.get(`${BASE_URL}/v3/paths/list`, { timeout: 3000 })
    .then(async (response) => {
      const activeShortnames = [];
      if (response.status === 200 && response.data && response.data.items) {
        for (const item of response.data.items) {
          if (item.ready && item.name.startsWith('live/')) {
            const parts = item.name.split('/');
            const shortname = parts[parts.length - 1];
            if (shortname) activeShortnames.push(shortname);
          }
        }
      }

      let query = 'UPDATE channels SET is_live = 0, current_streamer_id = NULL WHERE is_live = 1';
      const params = [];
      if (activeShortnames.length > 0) {
        query += ' AND shortname NOT IN (?)';
        params.push(activeShortnames);
      }

      const [result] = await pool.query(query, params);
      if (result.affectedRows > 0) {
        console.log(`Reset ${result.affectedRows} stuck live channels to offline.`);
      }
    })
    .catch(async (err) => {
      console.error('Failed to fetch active paths from MediaMTX on startup, resetting all live channels:', err.message);
      try {
        const [result] = await pool.query('UPDATE channels SET is_live = 0, current_streamer_id = NULL WHERE is_live = 1');
        if (result.affectedRows > 0) {
          console.log(`Reset ${result.affectedRows} stuck live channels to offline (fallback).`);
        }
      } catch (dbErr) {
        console.error('Error resetting live channels (fallback):', dbErr);
      }
    });
}

module.exports = { runStartupHeal };
