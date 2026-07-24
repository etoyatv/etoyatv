'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const archiver = require('archiver');
const { pool } = require('../../config/db');
const { safeResolvePublic } = require('../safePath');
const {
  TRANSFER_FORMAT,
  PERSONAL_FORMAT,
  USER_EXPORT_FIELDS,
  CHANNEL_EXPORT_FIELDS,
  pick
} = require('./manifest');
const { resolveRecordMp4 } = require('./remux');
const { ensureDirs, EXPORTS_DIR, EXPORT_TMP_DIR, publicRoot, resolveExportZip } = require('./paths');

const SECONDS_PER_RECORD_ESTIMATE = 8;
const EXPORT_TTL_MS = 2 * 24 * 60 * 60 * 1000;

async function getOwnedAndCoownedChannelIds(connection, userId) {
  const [owned] = await connection.query(
    'SELECT id FROM channels WHERE user_id = ? AND deleted_at IS NULL',
    [userId]
  );
  const [co] = await connection.query(
    `SELECT channel_id AS id FROM channel_team WHERE user_id = ? AND is_coowner = 1`,
    [userId]
  );
  const ids = new Set();
  for (const r of owned) ids.add(r.id);
  for (const r of co) ids.add(r.id);
  return [...ids];
}

async function estimateExportBytes(connection, userId) {
  const channelIds = await getOwnedAndCoownedChannelIds(connection, userId);
  let bytes = 0;
  if (channelIds.length) {
    const [sumRows] = await connection.query(
      `SELECT COALESCE(SUM(size_bytes), 0) AS total FROM records WHERE channel_id IN (?) AND (status IS NULL OR status != 'deleted')`,
      [channelIds]
    );
    bytes += Number(sumRows[0].total) || 0;

    const [ch] = await connection.query(
      `SELECT logo_url, banner_url, bg_url, player_logo, player_bg_url FROM channels WHERE id IN (?)`,
      [channelIds]
    );
    const root = publicRoot();
    for (const c of ch) {
      for (const key of ['logo_url', 'banner_url', 'bg_url', 'player_logo', 'player_bg_url']) {
        const p = safeResolvePublic(c[key], root);
        if (p && fs.existsSync(p)) bytes += fs.statSync(p).size;
      }
    }
  }

  const [u] = await connection.query('SELECT avatar FROM users WHERE id = ?', [userId]);
  if (u[0] && u[0].avatar) {
    const p = safeResolvePublic(u[0].avatar, publicRoot());
    if (p && fs.existsSync(p)) bytes += fs.statSync(p).size;
  }
  return bytes;
}

async function countExportRecords(connection, userId) {
  const channelIds = await getOwnedAndCoownedChannelIds(connection, userId);
  if (!channelIds.length) return 0;
  const [rows] = await connection.query(
    `SELECT COUNT(*) AS c FROM records WHERE channel_id IN (?) AND (status IS NULL OR status != 'deleted')`,
    [channelIds]
  );
  return rows[0].c || 0;
}

function updateJob(connection, jobId, fields) {
  const keys = Object.keys(fields);
  const sets = keys.map((k) => `${k} = ?`).join(', ');
  return connection.query(`UPDATE profile_export_jobs SET ${sets} WHERE id = ?`, [...keys.map((k) => fields[k]), jobId]);
}

async function buildExportArchive(jobId) {
  ensureDirs();
  const connection = await pool.getConnection();
  let tempDir = null;
  const cleanupFiles = [];

  try {
    const [jobs] = await connection.query('SELECT * FROM profile_export_jobs WHERE id = ?', [jobId]);
    if (!jobs.length) return;
    const job = jobs[0];
    if (!['queued', 'processing'].includes(job.status)) return;

    const userId = job.user_id;
    const exportType = job.export_type;
    const isTransfer = exportType === 'transfer';

    const [users] = await connection.query('SELECT * FROM users WHERE id = ?', [userId]);
    if (!users.length) {
      await updateJob(connection, jobId, { status: 'failed', error_text: 'User not found' });
      return;
    }
    const user = users[0];
    const channelIds = await getOwnedAndCoownedChannelIds(connection, userId);

    let channels = [];
    if (channelIds.length) {
      const [chRows] = await connection.query('SELECT * FROM channels WHERE id IN (?)', [channelIds]);
      channels = chRows;
    }

    let records = [];
    if (channelIds.length) {
      const [recRows] = await connection.query(
        `SELECT * FROM records WHERE channel_id IN (?) AND (status IS NULL OR status != 'deleted') ORDER BY id ASC`,
        [channelIds]
      );
      records = recRows;
    }

    await updateJob(connection, jobId, {
      status: 'processing',
      progress_current: 0,
      progress_total: records.length,
      eta_seconds: records.length * SECONDS_PER_RECORD_ESTIMATE
    });

    tempDir = path.join(EXPORT_TMP_DIR, `job_${jobId}_${crypto.randomBytes(4).toString('hex')}`);
    fs.mkdirSync(tempDir, { recursive: true });

    const skipped = [];
    const recordAbs = {};
    const recordZip = {};
    const startedAt = Date.now();

    const channelById = Object.fromEntries(channels.map((c) => [c.id, c]));
    function safeName(s, fallback) {
      return String(s || fallback)
        .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 80) || fallback;
    }

    for (let i = 0; i < records.length; i++) {
      const rec = records[i];
      try {
        const resolved = await resolveRecordMp4(rec, tempDir);
        if (!resolved) {
          skipped.push({ record_id: rec.id, title: rec.title, reason: 'no_video' });
        } else {
          recordAbs[rec.id] = resolved.filePath;
          if (isTransfer) {
            recordZip[rec.id] = `media/records/${rec.id}.mp4`;
          } else {
            const ch = channelById[rec.channel_id];
            const chName = safeName(ch && (ch.name || ch.shortname), 'channel');
            const title = safeName(rec.title, 'record');
            recordZip[rec.id] = `Мои записи/${chName}/${title}_${rec.id}.mp4`;
          }
          if (resolved.cleanup) cleanupFiles.push(resolved.filePath);
        }
      } catch (err) {
        skipped.push({ record_id: rec.id, title: rec.title, reason: err.message || 'remux_failed' });
      }
      const done = i + 1;
      const elapsed = (Date.now() - startedAt) / 1000;
      const eta = Math.max(0, Math.round((elapsed / done) * (records.length - done)));
      await updateJob(connection, jobId, { progress_current: done, eta_seconds: eta });
    }

    let albums = [];
    let albumRecords = [];
    if (isTransfer && channelIds.length) {
      const [al] = await connection.query('SELECT * FROM albums WHERE channel_id IN (?)', [channelIds]);
      albums = al;
      if (albums.length) {
        const [ar] = await connection.query('SELECT * FROM album_records WHERE album_id IN (?)', [albums.map((a) => a.id)]);
        albumRecords = ar;
      }
    }

    let news = [];
    let programs = [];
    let team = [];
    let profileComments = [];
    let channelComments = [];
    let recordComments = [];
    let channelFans = [];

    if (isTransfer && channelIds.length) {
      ([news] = await connection.query('SELECT * FROM channel_news WHERE channel_id IN (?)', [channelIds]));
      ([programs] = await connection.query('SELECT * FROM programs WHERE channel_id IN (?)', [channelIds]));
      ([team] = await connection.query('SELECT * FROM channel_team WHERE channel_id IN (?)', [channelIds]));
      ([profileComments] = await connection.query(
        'SELECT id, profile_user_id, author_id, text, created_at, is_hidden FROM profile_comments WHERE profile_user_id = ?',
        [userId]
      ));
      ([channelComments] = await connection.query(
        `SELECT cc.channel_id, cc.text, cc.is_hidden, cc.created_at, cc.author_name,
                u.username AS username_hint
         FROM channel_comments cc
         LEFT JOIN users u ON cc.user_id = u.id
         WHERE cc.channel_id IN (?)`,
        [channelIds]
      ));
      ([recordComments] = await connection.query(
        `SELECT rc.record_id, rc.text, rc.is_hidden, rc.created_at, rc.author_name,
                u.username AS username_hint
         FROM record_comments rc
         LEFT JOIN users u ON rc.user_id = u.id
         WHERE rc.record_id IN (SELECT id FROM records WHERE channel_id IN (?) AND (status IS NULL OR status != 'deleted'))`,
        [channelIds]
      ));
      ([channelFans] = await connection.query(
        `SELECT f.channel_id, f.created_at, u.username AS username_hint
         FROM channel_fans f
         JOIN users u ON f.user_id = u.id
         WHERE f.channel_id IN (?)`,
        [channelIds]
      ));
    }

    const fileMap = {};
    const channelsPayload = channels.map((ch) => ({
      ...pick(ch, CHANNEL_EXPORT_FIELDS),
      source_id: ch.id,
      ownership: ch.user_id === userId ? 'owner' : 'coowner',
      was_premium: isTransfer ? !!ch.is_premium : undefined,
      was_verified: isTransfer ? !!ch.is_verified : undefined,
      premium_until: isTransfer ? (ch.premium_until || null) : undefined,
      files: {}
    }));

    for (const chPayload of channelsPayload) {
      const ch = channels.find((c) => c.id === chPayload.source_id);
      for (const [key, name] of [
        ['logo_url', 'logo'], ['banner_url', 'banner'], ['bg_url', 'bg'],
        ['player_logo', 'player_logo'], ['player_bg_url', 'player_bg']
      ]) {
        if (!ch[key]) continue;
        const abs = safeResolvePublic(ch[key], publicRoot());
        if (!abs || !fs.existsSync(abs)) continue;
        const ext = path.extname(abs) || '.png';
        let rel;
        if (isTransfer) {
          rel = `media/channels/${ch.id}/${name}${ext}`;
        } else {
          const chName = safeName(ch.name || ch.shortname, 'channel');
          rel = `Оформление/${chName}/${name}${ext}`;
        }
        fileMap[rel] = abs;
        chPayload.files[name] = rel;
      }
    }

    let avatarFile = null;
    if (user.avatar) {
      const abs = safeResolvePublic(user.avatar, publicRoot());
      if (abs && fs.existsSync(abs)) {
        const ext = path.extname(abs) || '.jpg';
        avatarFile = isTransfer ? `media/user/avatar${ext}` : `Профиль/avatar${ext}`;
        fileMap[avatarFile] = abs;
      }
    }

    const thumbMap = {};
    for (const rec of records) {
      if (!rec.thumbnail_url) continue;
      const abs = safeResolvePublic(rec.thumbnail_url, publicRoot());
      if (!abs || !fs.existsSync(abs)) continue;
      const ext = path.extname(abs) || '.jpg';
      let rel;
      if (isTransfer) {
        rel = `media/records/${rec.id}_thumb${ext}`;
      } else {
        const ch = channelById[rec.channel_id];
        const chName = safeName(ch && (ch.name || ch.shortname), 'channel');
        const title = safeName(rec.title, 'record');
        rel = `Мои записи/${chName}/превью/${title}_${rec.id}${ext}`;
      }
      fileMap[rel] = abs;
      thumbMap[rec.id] = rel;
    }

    let teamPayload = [];
    if (isTransfer && team.length) {
      const uids = [...new Set(team.map((t) => t.user_id))];
      const [unames] = await connection.query('SELECT id, username FROM users WHERE id IN (?)', [uids]);
      const umap = Object.fromEntries(unames.map((u) => [u.id, u.username]));
      teamPayload = team.map((t) => ({
        channel_source_id: t.channel_id,
        username_hint: umap[t.user_id] || null,
        is_reporter: !!t.is_reporter,
        is_moderator: !!t.is_moderator,
        is_editor: !!t.is_editor,
        is_coowner: !!t.is_coowner,
        order_index: t.order_index || 0
      }));
    }

    const aboutText = isTransfer
      ? null
      : [
          'О СЕБЕ',
          '=======',
          user.about || '(пусто)',
          '',
          user.telegram ? `Telegram: ${user.telegram}` : '',
          user.discord ? `Discord: ${user.discord}` : ''
        ].filter(Boolean).join('\n');

    const manifest = isTransfer ? {
      format: TRANSFER_FORMAT,
      exported_at: new Date().toISOString(),
      export_type: 'transfer',
      purpose: 'migration',
      user: { ...pick(user, USER_EXPORT_FIELDS), avatar_file: avatarFile },
      was_premium: channelsPayload.some((c) => c.was_premium),
      was_verified: channelsPayload.some((c) => c.was_verified),
      channels: channelsPayload,
      records: records.map((r) => ({
        source_id: r.id,
        channel_source_id: r.channel_id,
        title: r.title,
        description: r.description,
        duration: r.duration,
        access_level: r.access_level,
        is_18_plus: !!r.is_18_plus,
        size_bytes: r.size_bytes,
        media_file: recordZip[r.id] || null,
        thumbnail_file: thumbMap[r.id] || null,
        created_at: r.created_at
      })),
      albums: albums.map((a) => ({
        source_id: a.id,
        channel_source_id: a.channel_id,
        title: a.title,
        description: a.description || null
      })),
      album_records: albumRecords.map((ar) => ({
        album_source_id: ar.album_id,
        record_source_id: ar.record_id
      })),
      channel_news: news.map((n) => ({
        channel_source_id: n.channel_id,
        title: n.title,
        announce: n.announce,
        content: n.content,
        is_hidden: !!n.is_hidden,
        created_at: n.created_at
      })),
      programs: programs.map((p) => ({
        channel_source_id: p.channel_id,
        title: p.title,
        description: p.description,
        start_time: p.start_time,
        is_hidden: !!p.is_hidden
      })),
      channel_team: teamPayload,
      profile_comments: profileComments,
      channel_comments: channelComments.map((c) => ({
        channel_source_id: c.channel_id,
        username_hint: c.username_hint || c.author_name || null,
        text: c.text,
        is_hidden: !!c.is_hidden,
        created_at: c.created_at
      })),
      record_comments: recordComments.map((c) => ({
        record_source_id: c.record_id,
        username_hint: c.username_hint || c.author_name || null,
        text: c.text,
        is_hidden: !!c.is_hidden,
        created_at: c.created_at
      })),
      channel_fans: channelFans.map((f) => ({
        channel_source_id: f.channel_id,
        username_hint: f.username_hint,
        created_at: f.created_at
      })),
      skipped
    } : {
      format: PERSONAL_FORMAT,
      exported_at: new Date().toISOString(),
      export_type: 'personal',
      purpose: 'personal_backup',
      note: 'Личный архив для себя. На другой инстанс через «Загрузить архив переноса» НЕ принимается.',
      user: {
        username: user.username,
        about: user.about || null,
        telegram: user.telegram || null,
        discord: user.discord || null,
        avatar_file: avatarFile
      },
      channels: channels.map((ch) => ({
        name: ch.name,
        shortname: ch.shortname,
        description: ch.description || null,
        files: (channelsPayload.find((c) => c.source_id === ch.id) || {}).files || {}
      })),
      records: records.map((r) => ({
        title: r.title,
        channel: (channelById[r.channel_id] && channelById[r.channel_id].name) || null,
        file: recordZip[r.id] || null,
        thumbnail: thumbMap[r.id] || null,
        duration: r.duration
      })),
      skipped
    };

    const readme = isTransfer
      ? [
          'ЭтоЯTV — АРХИВ ДЛЯ ПЕРЕНОСА',
          '============================',
          '',
          'Этот файл нужен, чтобы перенести профиль/каналы на ДРУГОЙ инстанс ЭтоЯTV.',
          '',
          'Как использовать:',
          '1. Скачайте этот zip.',
          '2. На другом инстансе откройте: Настройки → Перенос / архив → «Загрузить архив переноса».',
          '3. Дождитесь решения администрации (принять / отклонить, premium отдельно).',
          '',
          'Внутри: manifest.json + media/ (служебная структура для импорта).',
          'RTMP-ключи при импорте будут сгенерированы заново.',
          'Личный бэкап («Скачать моё») сюда загружать нельзя — другой формат.',
          ''
        ].join('\n')
      : [
          'ЭтоЯTV — ЛИЧНЫЙ АРХИВ',
          '=====================',
          '',
          'Это ваш личный бэкап: записи (MP4), оформление каналов, тексты.',
          'Откройте папку «Мои записи» — там ролики по каналам, можно просто смотреть.',
          '',
          'Этот архив НЕ для переноса на другой инстанс.',
          'Для переноса используйте кнопку «Архив для переноса» и загрузите тот zip',
          'на другом инстансе через «Загрузить архив переноса».',
          ''
        ].join('\n');

    await updateJob(connection, jobId, { status: 'zipping' });

    const token = crypto.randomBytes(16).toString('hex');
    const safeUser = String(user.username || 'user').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
    const zipName = `yatv-${exportType}-${safeUser}-${jobId}-${token.slice(0, 8)}.zip`;
    const zipAbs = path.join(EXPORTS_DIR, zipName);
    const zipUrl = `private/exports/${zipName}`;

    await new Promise((resolve, reject) => {
      const output = fs.createWriteStream(zipAbs);
      const archive = archiver('zip', { zlib: { level: 6 } });
      output.on('close', resolve);
      archive.on('error', reject);
      archive.pipe(output);

      archive.append(readme, { name: 'ПРОЧТИ_МЕНЯ.txt' });
      if (aboutText) archive.append(aboutText, { name: 'Профиль/о_себе.txt' });
      archive.append(JSON.stringify(manifest, null, 2), { name: isTransfer ? 'manifest.json' : 'список.json' });

      for (const [rel, abs] of Object.entries(fileMap)) {
        archive.file(abs, { name: rel });
      }
      for (const [rid, abs] of Object.entries(recordAbs)) {
        archive.file(abs, { name: recordZip[rid] });
      }
      archive.finalize();
    });

    const actualBytes = fs.statSync(zipAbs).size;
    await updateJob(connection, jobId, {
      status: 'ready',
      progress_current: records.length,
      progress_total: records.length,
      eta_seconds: 0,
      actual_bytes: actualBytes,
      zip_path: zipUrl,
      zip_token: token,
      expires_at: new Date(Date.now() + EXPORT_TTL_MS),
      skipped_json: JSON.stringify(skipped),
      error_text: null
    });
  } catch (err) {
    console.error('[profileExport] job failed', jobId, err);
    try {
      await updateJob(connection, jobId, {
        status: 'failed',
        error_text: (err && err.message) ? err.message.slice(0, 2000) : 'export_failed'
      });
    } catch (e) {}
  } finally {
    for (const f of cleanupFiles) {
      try { fs.unlinkSync(f); } catch (e) {}
    }
    if (tempDir) {
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (e) {}
    }
    connection.release();
  }
}

let workerBusy = false;

async function processNextExportJob() {
  if (workerBusy) return;
  workerBusy = true;
  try {
    const connection = await pool.getConnection();
    let nextId = null;
    try {
      const [expired] = await connection.query(
        `SELECT id, zip_path FROM profile_export_jobs WHERE status = 'ready' AND expires_at IS NOT NULL AND expires_at < NOW()`
      );
      for (const row of expired) {
        if (row.zip_path) {
          const abs = resolveExportZip(row.zip_path);
          if (abs && fs.existsSync(abs)) {
            try { fs.unlinkSync(abs); } catch (e) {}
          }
        }
        await connection.query(
          `UPDATE profile_export_jobs SET status = 'expired', zip_path = NULL, dl_token = NULL, dl_token_expires = NULL WHERE id = ?`,
          [row.id]
        );
      }

      const [next] = await connection.query(
        `SELECT j.id FROM profile_export_jobs j
         WHERE j.status = 'queued'
         AND NOT EXISTS (
           SELECT 1 FROM profile_export_jobs a
           WHERE a.user_id = j.user_id AND a.status IN ('processing','zipping')
         )
         ORDER BY j.id ASC
         LIMIT 1`
      );
      if (next.length) nextId = next[0].id;
    } finally {
      connection.release();
    }
    if (nextId) await buildExportArchive(nextId);
  } catch (err) {
    console.error('[profileExport] worker error', err);
  } finally {
    workerBusy = false;
  }
}

async function purgeExportJobFiles(row) {
  if (!row || !row.zip_path) return;
  const abs = resolveExportZip(row.zip_path);
  if (abs && fs.existsSync(abs)) {
    try { fs.unlinkSync(abs); } catch (e) {}
  }
}

/** Permanently remove previous archives of the same type (files + DB). No recovery. */
async function purgePreviousExportsOfType(connection, userId, exportType) {
  const [rows] = await connection.query(
    `SELECT id, zip_path FROM profile_export_jobs
     WHERE user_id = ? AND export_type = ?
       AND status IN ('ready','failed','expired')`,
    [userId, exportType]
  );
  for (const row of rows) {
    await purgeExportJobFiles(row);
    await connection.query(
      `UPDATE profile_export_jobs
       SET status = 'expired', zip_path = NULL, dl_token = NULL, dl_token_expires = NULL,
           error_text = 'replaced_by_new_export'
       WHERE id = ?`,
      [row.id]
    );
  }
}

async function createExportJob(userId, exportType) {
  ensureDirs();
  if (!['personal', 'transfer'].includes(exportType)) {
    throw new Error('invalid_type');
  }
  const connection = await pool.getConnection();
  try {
    // If same type already building — return it
    const [activeSame] = await connection.query(
      `SELECT id FROM profile_export_jobs
       WHERE user_id = ? AND export_type = ? AND status IN ('queued','processing','zipping')
       LIMIT 1`,
      [userId, exportType]
    );
    if (activeSame.length) {
      return { jobId: activeSame[0].id, existing: true };
    }

    // Another type still building — wait (one worker)
    const [activeOther] = await connection.query(
      `SELECT id, export_type FROM profile_export_jobs
       WHERE user_id = ? AND status IN ('queued','processing','zipping')
       LIMIT 1`,
      [userId]
    );
    if (activeOther.length) {
      const err = new Error('busy_other');
      err.code = 'busy_other';
      err.activeType = activeOther[0].export_type;
      throw err;
    }

    // Wipe previous archives of THIS type only (other type stays downloadable)
    await purgePreviousExportsOfType(connection, userId, exportType);

    const estimated = await estimateExportBytes(connection, userId);
    const total = await countExportRecords(connection, userId);
    const [result] = await connection.query(
      `INSERT INTO profile_export_jobs (user_id, export_type, status, progress_total, eta_seconds, estimated_bytes)
       VALUES (?, ?, 'queued', ?, ?, ?)`,
      [userId, exportType, total, total * SECONDS_PER_RECORD_ESTIMATE, estimated]
    );
    setImmediate(() => processNextExportJob());
    return { jobId: result.insertId, existing: false };
  } finally {
    connection.release();
  }
}

async function getExportJobForUser(jobId, userId) {
  const [rows] = await pool.query(
    'SELECT * FROM profile_export_jobs WHERE id = ? AND user_id = ?',
    [jobId, userId]
  );
  return rows[0] || null;
}

async function getLatestJobOfType(userId, exportType) {
  const [active] = await pool.query(
    `SELECT * FROM profile_export_jobs
     WHERE user_id = ? AND export_type = ? AND status IN ('queued','processing','zipping')
     ORDER BY id DESC LIMIT 1`,
    [userId, exportType]
  );
  if (active.length) return active[0];

  const [ready] = await pool.query(
    `SELECT * FROM profile_export_jobs
     WHERE user_id = ? AND export_type = ? AND status = 'ready'
       AND (expires_at IS NULL OR expires_at > NOW())
     ORDER BY id DESC LIMIT 1`,
    [userId, exportType]
  );
  return ready[0] || null;
}

/** Both types at once (personal + transfer) for UI. */
async function getExportJobsStateForUser(userId) {
  const personal = await getLatestJobOfType(userId, 'personal');
  const transfer = await getLatestJobOfType(userId, 'transfer');
  return { personal, transfer };
}

/** @deprecated prefer getExportJobsStateForUser */
async function getLatestExportJobForUser(userId) {
  const [active] = await pool.query(
    `SELECT * FROM profile_export_jobs
     WHERE user_id = ? AND status IN ('queued','processing','zipping')
     ORDER BY id DESC LIMIT 1`,
    [userId]
  );
  if (active.length) return active[0];

  const [ready] = await pool.query(
    `SELECT * FROM profile_export_jobs
     WHERE user_id = ? AND status = 'ready'
       AND (expires_at IS NULL OR expires_at > NOW())
     ORDER BY id DESC LIMIT 1`,
    [userId]
  );
  return ready[0] || null;
}

const DL_TOKEN_TTL_SEC = 60;

/** Issue a one-time download token (valid ~1 minute). Rotates each call. */
async function issueDownloadTicket(jobId, userId) {
  const job = await getExportJobForUser(jobId, userId);
  if (!job || job.status !== 'ready' || !job.zip_path) return null;
  if (job.expires_at && new Date(job.expires_at) < new Date()) return null;

  const token = crypto.randomBytes(24).toString('hex');
  const expires = new Date(Date.now() + DL_TOKEN_TTL_SEC * 1000);
  await pool.query(
    `UPDATE profile_export_jobs SET dl_token = ?, dl_token_expires = ? WHERE id = ? AND user_id = ?`,
    [token, expires, jobId, userId]
  );
  return {
    download_url: `/api/account/export/${jobId}/download?t=${token}`,
    expires_in: DL_TOKEN_TTL_SEC,
    expires_at: expires.toISOString()
  };
}

/** Validate and consume one-time token. Returns job or null. */
async function consumeDownloadTicket(jobId, userId, token) {
  if (!token || typeof token !== 'string' || token.length < 16) return null;
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.query(
      `SELECT * FROM profile_export_jobs WHERE id = ? AND user_id = ? AND status = 'ready' FOR UPDATE`,
      [jobId, userId]
    );
    const job = rows[0];
    if (!job || !job.zip_path) {
      await connection.rollback();
      return null;
    }
    if (job.expires_at && new Date(job.expires_at) < new Date()) {
      await connection.rollback();
      return null;
    }
    if (!job.dl_token || job.dl_token !== token) {
      await connection.rollback();
      return null;
    }
    if (!job.dl_token_expires || new Date(job.dl_token_expires) < new Date()) {
      await connection.rollback();
      return null;
    }
    // one-time: burn token
    await connection.query(
      `UPDATE profile_export_jobs SET dl_token = NULL, dl_token_expires = NULL WHERE id = ?`,
      [jobId]
    );
    await connection.commit();
    return job;
  } catch (e) {
    try { await connection.rollback(); } catch (x) {}
    throw e;
  } finally {
    connection.release();
  }
}

module.exports = {
  createExportJob,
  getExportJobForUser,
  getLatestExportJobForUser,
  getExportJobsStateForUser,
  getLatestJobOfType,
  issueDownloadTicket,
  consumeDownloadTicket,
  processNextExportJob,
  estimateExportBytes,
  SECONDS_PER_RECORD_ESTIMATE,
  EXPORT_TTL_MS,
  DL_TOKEN_TTL_SEC
};
