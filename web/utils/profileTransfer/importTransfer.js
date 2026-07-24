'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { TRANSFER_FORMAT } = require('./manifest');
const { ensureDirs, TRANSFERS_DIR, publicRoot } = require('./paths');
const { safeResolveUnder, safeResolvePublic } = require('../safePath');

const MAX_ZIP_ENTRIES = 20000;
const MAX_STREAMS = 3;
const DEFAULT_CDN_QUOTA_MB = 2048;
const MAX_CDN_QUOTA_MB = 102400; // 100 GB hard cap even if admin later raises
const ALLOWED_ACCESS = new Set(['public', 'friends', 'private', 'link']);
const MAX_COMMENT_TEXT = 4000;
const MAX_STUB_NAME = 64;

function listZipEntries(zipPath) {
  const r = spawnSync('unzip', ['-Z1', zipPath], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024
  });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(r.stderr || 'zip_list_failed');
  return String(r.stdout || '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

function assertSafeZipEntryNames(entries, destDir) {
  if (entries.length > MAX_ZIP_ENTRIES) throw new Error('zip_too_many_entries');
  const root = path.resolve(destDir);
  for (const entry of entries) {
    if (!entry || entry.includes('\0')) throw new Error('zip_unsafe_entry');
    const normalized = entry.replace(/\\/g, '/');
    if (
      path.isAbsolute(normalized) ||
      normalized.startsWith('/') ||
      /^[a-zA-Z]:/.test(normalized) ||
      normalized.split('/').some((p) => p === '..')
    ) {
      throw new Error('zip_path_traversal');
    }
    const resolved = path.resolve(root, normalized);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      throw new Error('zip_path_traversal');
    }
  }
}

/** After extract: no symlinks, nothing outside destDir (realpath). */
function assertExtractContained(destDir) {
  const root = path.resolve(destDir);
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch (e) {
      throw new Error('zip_extract_unreadable');
    }
    for (const name of names) {
      const full = path.join(dir, name);
      let st;
      try {
        st = fs.lstatSync(full);
      } catch (e) {
        throw new Error('zip_extract_unreadable');
      }
      if (st.isSymbolicLink()) throw new Error('zip_symlink');
      let real;
      try {
        real = fs.realpathSync(full);
      } catch (e) {
        throw new Error('zip_extract_unreadable');
      }
      if (real !== root && !real.startsWith(root + path.sep)) {
        throw new Error('zip_escape');
      }
      if (st.isDirectory()) stack.push(full);
    }
  }
}

function unzipExtract(zipPath, destDir) {
  return new Promise((resolve, reject) => {
    try {
      fs.mkdirSync(destDir, { recursive: true });
      const entries = listZipEntries(zipPath);
      assertSafeZipEntryNames(entries, destDir);
    } catch (e) {
      return reject(e);
    }
    const proc = spawn('unzip', ['-o', '-q', zipPath, '-d', destDir]);
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(stderr || `unzip exit ${code}`));
      try {
        assertExtractContained(destDir);
      } catch (e) {
        try { fs.rmSync(destDir, { recursive: true, force: true }); } catch (x) {}
        return reject(e);
      }
      resolve();
    });
  });
}

function readManifest(extractDir) {
  const manifestPath = safeResolveUnder(extractDir, 'manifest.json');
  if (!manifestPath || !fs.existsSync(manifestPath)) throw new Error('manifest_missing');
  const data = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (data.format !== TRANSFER_FORMAT) throw new Error('invalid_format');
  return data;
}

function resolveInExtract(extractDir, rel) {
  if (!rel) return null;
  const abs = safeResolveUnder(extractDir, rel);
  if (!abs || !fs.existsSync(abs)) return null;
  const st = fs.lstatSync(abs);
  if (!st.isFile()) return null;
  return abs;
}

async function uniqueShortname(connection, base) {
  let candidate = String(base || 'channel').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40) || 'channel';
  let n = 0;
  while (true) {
    const tryName = n === 0 ? candidate : `${candidate.slice(0, 35)}_${n}`;
    const [rows] = await connection.query('SELECT id FROM channels WHERE shortname = ?', [tryName]);
    if (!rows.length) return tryName;
    n += 1;
    if (n > 999) return `${candidate}_${crypto.randomBytes(3).toString('hex')}`;
  }
}

function copyIntoPublic(srcAbs, destRelUrl) {
  const destAbs = safeResolvePublic(destRelUrl, publicRoot());
  if (!destAbs) throw new Error('unsafe_public_dest');
  fs.mkdirSync(path.dirname(destAbs), { recursive: true });
  fs.copyFileSync(srcAbs, destAbs);
  return destRelUrl.startsWith('/') ? destRelUrl : '/' + destRelUrl;
}

function clampInt(value, min, max, fallback) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function sanitizeStubName(name) {
  const s = String(name || 'Пользователь').replace(/[\r\n\0<>]/g, '').trim().slice(0, MAX_STUB_NAME);
  return s || 'Пользователь';
}

function sanitizeCommentText(text) {
  return String(text || '').slice(0, MAX_COMMENT_TEXT);
}

async function findUserIdByUsername(connection, username) {
  if (!username) return null;
  const [rows] = await connection.query('SELECT id FROM users WHERE username = ? LIMIT 1', [String(username)]);
  return rows.length ? rows[0].id : null;
}

/**
 * Import a transfer archive into the submitter's account.
 * Regenerates stream_keys. Premium/verified only if grant flags set.
 * Migrated comments are always stubs (no live user_id binding).
 * Fans are linked only when the username already exists on this instance.
 */
async function importTransferArchive(connection, {
  zipAbs,
  targetUserId,
  grantPremium = false,
  grantVerified = false
}) {
  ensureDirs();
  const extractDir = path.join(TRANSFERS_DIR, `import_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`);
  try {
    await unzipExtract(zipAbs, extractDir);
    const manifest = readManifest(extractDir);

    if (manifest.user) {
      const [uRows] = await connection.query('SELECT about, telegram, discord, avatar FROM users WHERE id = ?', [targetUserId]);
      if (uRows.length) {
        const u = uRows[0];
        const updates = [];
        const vals = [];
        if (!u.about && manifest.user.about) {
          updates.push('about = ?');
          vals.push(String(manifest.user.about).slice(0, 5000));
        }
        if (!u.telegram && manifest.user.telegram) {
          updates.push('telegram = ?');
          vals.push(String(manifest.user.telegram).slice(0, 255));
        }
        if (!u.discord && manifest.user.discord) {
          updates.push('discord = ?');
          vals.push(String(manifest.user.discord).slice(0, 255));
        }
        if (manifest.user.avatar_file) {
          const src = resolveInExtract(extractDir, manifest.user.avatar_file);
          if (src) {
            const ext = path.extname(src).toLowerCase();
            const safeExt = ['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext) ? ext : '.jpg';
            const rel = `/images/avatars/import_${targetUserId}_${Date.now()}${safeExt}`;
            copyIntoPublic(src, rel);
            updates.push('avatar = ?');
            vals.push(rel);
          }
        }
        if (updates.length) {
          vals.push(targetUserId);
          await connection.query(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, vals);
        }
      }
    }

    const channelIdMap = {};
    const recordIdMap = {};
    const albumIdMap = {};

    for (const ch of (manifest.channels || [])) {
      if (ch.ownership === 'coowner') continue;

      const shortname = await uniqueShortname(connection, ch.shortname || ch.name);
      const maxStreams = clampInt(ch.max_streams, 1, MAX_STREAMS, 1);
      const cdnQuota = clampInt(ch.cdn_quota_mb, 64, MAX_CDN_QUOTA_MB, DEFAULT_CDN_QUOTA_MB);
      const access = ALLOWED_ACCESS.has(ch.access_level) ? ch.access_level : 'public';

      const [ins] = await connection.query(
        `INSERT INTO channels (
          user_id, name, shortname, description, status, chat_enabled, guests_allowed,
          access_level, is_18_plus, is_personal, logo_url, banner_url, bg_url,
          bg_fit, bg_repeat, bg_color, text_color, player_color, player_logo,
          player_bg_url, player_bg_color, player_bg_fit, player_menu_color, player_link_color,
          hide_live_badge, max_streams, cdn_quota_mb,
          is_premium, is_verified, premium_until
        ) VALUES (?, ?, ?, ?, 'offline', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          targetUserId,
          String(ch.name || shortname).slice(0, 255),
          shortname,
          String(ch.description || '').slice(0, 5000),
          ch.chat_enabled != null ? (ch.chat_enabled ? 1 : 0) : 1,
          ch.guests_allowed != null ? (ch.guests_allowed ? 1 : 0) : 1,
          access,
          ch.is_18_plus ? 1 : 0,
          ch.is_personal != null ? (ch.is_personal ? 1 : 0) : 1,
          '/images/logo_cort.png',
          null, null,
          ['stretch', 'cover', 'contain'].includes(ch.bg_fit) ? ch.bg_fit : 'stretch',
          ['no-repeat', 'repeat', 'repeat-x', 'repeat-y'].includes(ch.bg_repeat) ? ch.bg_repeat : 'no-repeat',
          String(ch.bg_color || '#000000').slice(0, 32),
          String(ch.text_color || '#ffffff').slice(0, 32),
          String(ch.player_color || '#00a0e3').slice(0, 32),
          null,
          null,
          ch.player_bg_color ? String(ch.player_bg_color).slice(0, 32) : null,
          ['stretch', 'cover', 'contain'].includes(ch.player_bg_fit) ? ch.player_bg_fit : 'stretch',
          ch.player_menu_color ? String(ch.player_menu_color).slice(0, 32) : null,
          ch.player_link_color ? String(ch.player_link_color).slice(0, 32) : null,
          ch.hide_live_badge ? 1 : 0,
          maxStreams,
          cdnQuota,
          (grantPremium && ch.was_premium) ? 1 : 0,
          (grantVerified && ch.was_verified) ? 1 : 0,
          (grantPremium && ch.was_premium && ch.premium_until) ? ch.premium_until : null
        ]
      );
      const newChannelId = ins.insertId;
      channelIdMap[ch.source_id] = newChannelId;

      if (ch.files) {
        const fieldMap = {
          logo: 'logo_url',
          banner: 'banner_url',
          bg: 'bg_url',
          player_logo: 'player_logo',
          player_bg: 'player_bg_url'
        };
        const sets = [];
        const vals = [];
        for (const [name, col] of Object.entries(fieldMap)) {
          const src = resolveInExtract(extractDir, ch.files[name]);
          if (!src) continue;
          const ext = path.extname(src).toLowerCase();
          const safeExt = ['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext) ? ext : '.png';
          const destRel = `/images/design/import_ch${newChannelId}_${name}${safeExt}`;
          copyIntoPublic(src, destRel);
          sets.push(`${col} = ?`);
          vals.push(destRel);
        }
        if (sets.length) {
          vals.push(newChannelId);
          await connection.query(`UPDATE channels SET ${sets.join(', ')} WHERE id = ?`, vals);
        }
      }

      const streamKey = 'sk_live_' + crypto.randomBytes(16).toString('hex');
      await connection.query(
        'INSERT INTO stream_keys (channel_id, user_id, stream_key, is_active) VALUES (?, ?, ?, 1)',
        [newChannelId, targetUserId, streamKey]
      );
    }

    for (const rec of (manifest.records || [])) {
      const newChannelId = channelIdMap[rec.channel_source_id];
      if (!newChannelId) continue;

      let videoUrl = null;
      let thumbUrl = null;
      let sizeBytes = clampInt(rec.size_bytes, 0, Number.MAX_SAFE_INTEGER, 0);

      if (rec.media_file) {
        const src = resolveInExtract(extractDir, rec.media_file);
        if (src) {
          const fname = `import_${newChannelId}_${Number(rec.source_id) || Date.now()}_${Date.now()}.mp4`;
          const destRel = `/uploads/records/${fname}`;
          copyIntoPublic(src, destRel);
          videoUrl = destRel;
          sizeBytes = fs.statSync(src).size;
        }
      }
      if (rec.thumbnail_file) {
        const src = resolveInExtract(extractDir, rec.thumbnail_file);
        if (src) {
          const ext = path.extname(src).toLowerCase();
          const safeExt = ['.jpg', '.jpeg', '.png', '.webp'].includes(ext) ? ext : '.jpg';
          const destRel = `/uploads/records/import_${newChannelId}_${Number(rec.source_id) || 0}_thumb${safeExt}`;
          copyIntoPublic(src, destRel);
          thumbUrl = destRel;
        }
      }

      if (!videoUrl) continue;

      const recAccess = ALLOWED_ACCESS.has(rec.access_level) ? rec.access_level : 'public';
      const [rins] = await connection.query(
        `INSERT INTO records (channel_id, title, description, video_url, thumbnail_url, duration, size_bytes, processing_status, status, access_level, is_18_plus)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 'active', ?, ?)`,
        [
          newChannelId,
          String(rec.title || 'Запись').slice(0, 255),
          String(rec.description || '').slice(0, 5000),
          videoUrl,
          thumbUrl,
          clampInt(rec.duration, 0, 86400 * 7, 0),
          sizeBytes,
          recAccess,
          rec.is_18_plus ? 1 : 0
        ]
      );
      recordIdMap[rec.source_id] = rins.insertId;
    }

    for (const al of (manifest.albums || [])) {
      const newChannelId = channelIdMap[al.channel_source_id];
      if (!newChannelId) continue;
      const [ains] = await connection.query(
        'INSERT INTO albums (channel_id, title, description) VALUES (?, ?, ?)',
        [newChannelId, String(al.title || 'Альбом').slice(0, 255), al.description ? String(al.description).slice(0, 2000) : null]
      );
      albumIdMap[al.source_id] = ains.insertId;
    }
    for (const ar of (manifest.album_records || [])) {
      const aid = albumIdMap[ar.album_source_id];
      const rid = recordIdMap[ar.record_source_id];
      if (!aid || !rid) continue;
      try {
        await connection.query('INSERT INTO album_records (album_id, record_id) VALUES (?, ?)', [aid, rid]);
      } catch (e) {}
    }

    for (const n of (manifest.channel_news || [])) {
      const newChannelId = channelIdMap[n.channel_source_id];
      if (!newChannelId) continue;
      await connection.query(
        `INSERT INTO channel_news (channel_id, title, announce, content, author_id, is_hidden) VALUES (?, ?, ?, ?, ?, ?)`,
        [
          newChannelId,
          String(n.title || '').slice(0, 255),
          String(n.announce || '').slice(0, 2000),
          String(n.content || '').slice(0, 20000),
          targetUserId,
          n.is_hidden ? 1 : 0
        ]
      );
    }
    for (const p of (manifest.programs || [])) {
      const newChannelId = channelIdMap[p.channel_source_id];
      if (!newChannelId) continue;
      await connection.query(
        `INSERT INTO programs (channel_id, title, description, start_time, is_hidden) VALUES (?, ?, ?, ?, ?)`,
        [
          newChannelId,
          String(p.title || '').slice(0, 255),
          String(p.description || '').slice(0, 2000),
          p.start_time || new Date(),
          p.is_hidden ? 1 : 0
        ]
      );
    }

    // Always stub — never bind to live accounts by username (forgery)
    for (const c of (manifest.channel_comments || [])) {
      const newChannelId = channelIdMap[c.channel_source_id];
      const text = sanitizeCommentText(c.text);
      if (!newChannelId || !text) continue;
      await connection.query(
        `INSERT INTO channel_comments (channel_id, user_id, author_name, text, is_hidden, created_at)
         VALUES (?, NULL, ?, ?, ?, ?)`,
        [newChannelId, sanitizeStubName(c.username_hint), text, c.is_hidden ? 1 : 0, c.created_at || new Date()]
      );
    }
    for (const c of (manifest.record_comments || [])) {
      const newRecordId = recordIdMap[c.record_source_id];
      const text = sanitizeCommentText(c.text);
      if (!newRecordId || !text) continue;
      await connection.query(
        `INSERT INTO record_comments (record_id, user_id, author_name, text, is_hidden, created_at)
         VALUES (?, NULL, ?, ?, ?, ?)`,
        [newRecordId, sanitizeStubName(c.username_hint), text, c.is_hidden ? 1 : 0, c.created_at || new Date()]
      );
    }

    // Fans: only accounts that already exist here. Do not create fan rows for
    // unknown names (nothing to show). Still requires admin accept of the zip.
    for (const f of (manifest.channel_fans || [])) {
      const newChannelId = channelIdMap[f.channel_source_id];
      if (!newChannelId || !f.username_hint) continue;
      const uid = await findUserIdByUsername(connection, String(f.username_hint).slice(0, 255));
      if (!uid || uid === targetUserId) continue;
      try {
        await connection.query(
          'INSERT INTO channel_fans (channel_id, user_id, created_at) VALUES (?, ?, ?)',
          [newChannelId, uid, f.created_at || new Date()]
        );
      } catch (e) {}
    }

    return {
      channels_created: Object.keys(channelIdMap).length,
      records_created: Object.keys(recordIdMap).length,
      source_username: (manifest.user && manifest.user.username) || null
    };
  } finally {
    try { fs.rmSync(extractDir, { recursive: true, force: true }); } catch (e) {}
  }
}

module.exports = {
  unzipExtract,
  readManifest,
  importTransferArchive
};
