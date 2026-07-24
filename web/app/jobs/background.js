'use strict';

/**
 * Background intervals for the web app.
 * @param {{ pool: import('mysql2/promise').Pool, io: import('socket.io').Server }} deps
 */
function startBackgroundJobs({ pool, io }) {
  async function collectViewerStats() {
    try {
      const connection = await pool.getConnection();
      const [activeChannels] = await connection.query("SELECT id, viewers, is_live FROM channels WHERE status = 'active'");
      let totalViewers = 0;
      if (activeChannels.length > 0) {
        const values = activeChannels.map((c) => {
          const v = c.is_live ? (c.viewers || 0) : 0;
          totalViewers += v;
          return [c.id, v];
        });
        await connection.query('INSERT INTO channel_viewer_stats (channel_id, viewer_count) VALUES ?', [values]);
      }

      const totalConnections = (io && io.engine && io.engine.clientsCount) || 0;
      await connection.query('INSERT INTO stats_snapshots (users_online, viewers_online) VALUES (?, ?)', [totalConnections, totalViewers]);
      connection.release();
    } catch (err) {
      console.error('Error collecting stats:', err);
    }
  }

  async function autoUnbanChannels() {
    try {
      const connection = await pool.getConnection();
      await connection.query(
        'UPDATE channels SET status = ?, banned_until = NULL, ban_reason = NULL WHERE status = ? AND banned_until IS NOT NULL AND banned_until < NOW()',
        ['active', 'banned']
      );
      connection.release();
    } catch (err) {
      console.error('Error auto-unbanning channels:', err);
    }
  }

  async function autoCleanupExpiredPremiums() {
    try {
      const connection = await pool.getConnection();
      await connection.query(
        'UPDATE channels SET is_premium = 0, is_verified = 0, premium_until = NULL WHERE premium_until IS NOT NULL AND premium_until < NOW()'
      );
      connection.release();
    } catch (err) {
      console.error('Error auto-cleaning up expired premiums:', err);
    }
  }

  setInterval(collectViewerStats, 5 * 60 * 1000);
  setTimeout(collectViewerStats, 5000);

  setInterval(autoUnbanChannels, 60 * 1000);
  setInterval(autoCleanupExpiredPremiums, 60 * 1000);

  const { runCleanup } = require('../../utils/cleanup');
  setInterval(runCleanup, 5 * 60 * 60 * 1000);
  setTimeout(runCleanup, 10000);

  const { syncLinkedUsers } = require('../../utils/boosty');
  setInterval(syncLinkedUsers, 60 * 60 * 1000);
  setTimeout(syncLinkedUsers, 15000);

  const { processNextExportJob } = require('../../utils/profileTransfer/exportJob');
  setInterval(processNextExportJob, 15 * 1000);
  setTimeout(processNextExportJob, 8000);
}

module.exports = { startBackgroundJobs };
