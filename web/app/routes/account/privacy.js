const { pool } = require('../../../config/db');

async function isFriend(userId1, userId2) {
  if (!userId1 || !userId2) return false;
  if (userId1 === userId2) return true;
  const [rows] = await pool.query(
    `SELECT 1 FROM friendships 
     WHERE ((requester_id = ? AND receiver_id = ?) OR (requester_id = ? AND receiver_id = ?)) 
       AND status = 'accepted'`,
    [userId1, userId2, userId2, userId1]
  );
  return rows.length > 0;
}

async function canMessageUser(sender, receiver) {
  if (!receiver) return false;
  if (!sender) return false;
  if (sender.id === receiver.id) return true;
  
  // Staff can always write
  if (sender.staff_role && ['admin', 'moderator'].includes(sender.staff_role)) {
    return true;
  }
  
  const privacy = receiver.privacy_messages || 'all';
  if (privacy === 'all') {
    return true;
  }
  if (privacy === 'only_friends') {
    return await isFriend(sender.id, receiver.id);
  }
  return false;
}

async function hasProfileAccess(reqUser, profileUser) {
  if (!profileUser) return false;
  const currentUserId = reqUser ? reqUser.id : null;
  const isOwner = currentUserId === profileUser.id;
  const isStaff = reqUser && ['admin', 'moderator'].includes(reqUser.staff_role);
  
  if (isOwner || isStaff) {
    return true;
  }
  
  const privacy = profileUser.privacy_profile || 'public';
  if (privacy === 'private') {
    return false;
  }
  
  if (privacy === 'only_friends') {
    return await isFriend(currentUserId, profileUser.id);
  }
  
  return true;
}

async function hasFriendsListAccess(reqUser, profileUser) {
  if (!profileUser) return false;
  const currentUserId = reqUser ? reqUser.id : null;
  const isOwner = currentUserId === profileUser.id;
  const isStaff = reqUser && ['admin', 'moderator'].includes(reqUser.staff_role);
  
  if (isOwner || isStaff) {
    return true;
  }
  
  // First, must have profile access
  const profileAccess = await hasProfileAccess(reqUser, profileUser);
  if (!profileAccess) return false;
  
  const privacy = profileUser.privacy_friends_list || 'all';
  if (privacy === 'nobody') {
    return false;
  }
  
  if (privacy === 'only_friends') {
    return await isFriend(currentUserId, profileUser.id);
  }
  
  return true;
}


module.exports = { isFriend, canMessageUser, hasProfileAccess, hasFriendsListAccess };
