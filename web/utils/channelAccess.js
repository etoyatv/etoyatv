'use strict';

/**
 * Channel view-access helpers (password / private gates).
 */

function isPlatformStaff(user) {
  if (!user || !user.staff_role) return false;
  if (user.mask_mode === 'user_mask') return false;
  return ['admin', 'moderator', 'mod', 'support'].includes(user.staff_role) || !!user.staff_role;
}

function isChannelUnlocked(req, channelId) {
  const id = Number(channelId);
  if (!req.session || !Array.isArray(req.session.unlockedChannels)) return false;
  return req.session.unlockedChannels.some((x) => Number(x) === id);
}

/**
 * @param {object} channel - must include id, access_level, user_id (optional)
 * @returns {boolean}
 */
function canViewChannelContent(req, channel) {
  if (!channel) return false;
  const level = channel.access_level || 'public';
  if (level === 'public' || !level) return true;

  const user = req.session && req.session.user;
  if (user && channel.user_id && Number(user.id) === Number(channel.user_id)) return true;
  if (isPlatformStaff(user)) return true;

  if (level === 'password') {
    return isChannelUnlocked(req, channel.id);
  }

  // private / unknown → deny for public surfaces
  if (level === 'private') {
    return false;
  }
  return false;
}

module.exports = {
  isPlatformStaff,
  isChannelUnlocked,
  canViewChannelContent
};
