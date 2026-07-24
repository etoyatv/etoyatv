'use strict';

const TRANSFER_FORMAT = 'yatv-transfer-v1';
const PERSONAL_FORMAT = 'yatv-personal-backup-v1';

const USER_EXPORT_FIELDS = [
  'username', 'email', 'avatar', 'timezone', 'birthdate', 'about',
  'telegram', 'discord', 'chat_color', 'lang',
  'privacy_profile', 'privacy_messages', 'privacy_friends_list'
];

const CHANNEL_EXPORT_FIELDS = [
  'name', 'shortname', 'description', 'logo_url', 'banner_url', 'bg_url',
  'bg_fit', 'bg_repeat', 'bg_color', 'text_color', 'player_color', 'player_logo',
  'player_bg_url', 'player_bg_color', 'player_bg_fit', 'player_menu_color',
  'player_link_color', 'chat_enabled', 'guests_allowed', 'access_level',
  'is_18_plus', 'is_personal', 'hide_live_badge', 'max_streams',
  'cdn_quota_mb'
];

function pick(obj, fields) {
  const out = {};
  for (const f of fields) {
    if (obj[f] !== undefined) out[f] = obj[f];
  }
  return out;
}

module.exports = {
  TRANSFER_FORMAT,
  PERSONAL_FORMAT,
  USER_EXPORT_FIELDS,
  CHANNEL_EXPORT_FIELDS,
  pick
};
