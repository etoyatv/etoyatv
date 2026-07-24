'use strict';

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { requireAuth } = require('../../../middlewares/auth');
const { createExportJob, getExportJobForUser, getExportJobsStateForUser, issueDownloadTicket, consumeDownloadTicket } = require('../../../utils/profileTransfer/exportJob');
const { ensureDirs, TRANSFERS_DIR, resolveExportZip, resolveTransferZip } = require('../../../utils/profileTransfer/paths');
const { TRANSFER_FORMAT } = require('../../../utils/profileTransfer/manifest');
const { pool } = require('../../../config/db');
const { spawn } = require('child_process');

function formatBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return v + ' Б';
  if (v < 1024 * 1024) return (v / 1024).toFixed(1) + ' КБ';
  if (v < 1024 * 1024 * 1024) return (v / (1024 * 1024)).toFixed(1) + ' МБ';
  return (v / (1024 * 1024 * 1024)).toFixed(2) + ' ГБ';
}

function formatEta(sec) {
  const s = Math.max(0, Number(sec) || 0);
  if (s < 60) return `~${s} сек`;
  if (s < 3600) return `~${Math.ceil(s / 60)} мин`;
  const h = Math.floor(s / 3600);
  const m = Math.ceil((s % 3600) / 60);
  return `~${h} ч ${m} мин`;
}

function formatExpiresAt(dt) {
  if (!dt) return null;
  const d = new Date(dt);
  if (Number.isNaN(d.getTime())) return null;
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatRemainingUntil(dt) {
  if (!dt) return null;
  const d = new Date(dt);
  if (Number.isNaN(d.getTime())) return null;
  let sec = Math.max(0, Math.floor((d.getTime() - Date.now()) / 1000));
  if (sec <= 0) return 'срок истёк';
  const days = Math.floor(sec / 86400);
  sec %= 86400;
  const hours = Math.floor(sec / 3600);
  sec %= 3600;
  const mins = Math.floor(sec / 60);
  if (days > 0) return `осталось ~${days} дн. ${hours} ч`;
  if (hours > 0) return `осталось ~${hours} ч ${mins} мин`;
  return `осталось ~${Math.max(1, mins)} мин`;
}

function typeLabel(type) {
  return type === 'transfer' ? 'Архив для переноса' : 'Личный архив';
}

function jobPayload(job) {
  if (!job) return null;
  let skipped = [];
  try { skipped = job.skipped_json ? JSON.parse(job.skipped_json) : []; } catch (e) {}
  const estimated = job.estimated_bytes != null ? Number(job.estimated_bytes) : null;
  const actual = job.actual_bytes != null ? Number(job.actual_bytes) : null;
  const expiresLabel = formatExpiresAt(job.expires_at);
  const remainingLabel = formatRemainingUntil(job.expires_at);
  return {
    id: job.id,
    type: job.export_type,
    type_label: typeLabel(job.export_type),
    status: job.status,
    progress_current: job.progress_current,
    progress_total: job.progress_total,
    eta_seconds: job.eta_seconds,
    eta_label: formatEta(job.eta_seconds),
    estimated_bytes: estimated,
    estimated_label: estimated != null ? '~' + formatBytes(estimated) : null,
    actual_bytes: actual,
    actual_label: actual != null ? formatBytes(actual) : null,
    expires_at: job.expires_at,
    expires_label: expiresLabel,
    remaining_label: remainingLabel,
    error_text: job.error_text,
    skipped,
    // Ticket is issued on demand — never a bare static URL
    can_download: job.status === 'ready' && !!job.zip_path,
    ticket_url: (job.status === 'ready' && job.zip_path)
      ? `/api/account/export/${job.id}/ticket`
      : null
  };
}

router.post('/api/account/export', requireAuth, async (req, res) => {
  try {
    const type = (req.body && req.body.type) || req.query.type;
    const result = await createExportJob(req.session.user.id, type);
    const job = await getExportJobForUser(result.jobId, req.session.user.id);
    res.json({ ok: true, existing: result.existing, replaced: !result.existing, job: jobPayload(job) });
  } catch (err) {
    if (err && err.code === 'busy_other') {
      const label = err.activeType === 'transfer' ? 'архив для переноса' : 'личный архив';
      return res.status(409).json({
        ok: false,
        error: 'busy_other',
        message: `Сейчас собирается ${label}. Дождитесь окончания, затем запустите второй тип.`
      });
    }
    console.error(err);
    res.status(400).json({ ok: false, error: err.message || 'export_failed' });
  }
});

// Must be registered before /:jobId
router.get('/api/account/export/latest', requireAuth, async (req, res) => {
  try {
    const state = await getExportJobsStateForUser(req.session.user.id);
    res.json({
      ok: true,
      personal: jobPayload(state.personal),
      transfer: jobPayload(state.transfer)
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

router.post('/api/account/export/:jobId/ticket', requireAuth, async (req, res) => {
  try {
    const jobId = parseInt(req.params.jobId, 10);
    const ticket = await issueDownloadTicket(jobId, req.session.user.id);
    if (!ticket) return res.status(404).json({ ok: false, error: 'unavailable' });
    res.json({ ok: true, ...ticket });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

router.get('/api/account/export/:jobId', requireAuth, async (req, res) => {
  try {
    const job = await getExportJobForUser(parseInt(req.params.jobId, 10), req.session.user.id);
    if (!job) return res.status(404).json({ ok: false, error: 'not_found' });
    res.json({ ok: true, job: jobPayload(job) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

router.get('/api/account/export/:jobId/download', requireAuth, async (req, res) => {
  try {
    const jobId = parseInt(req.params.jobId, 10);
    const token = req.query.t;
    const job = await consumeDownloadTicket(jobId, req.session.user.id, token);
    if (!job) {
      return res.status(403).send('Ссылка недействительна или уже использована. Вернитесь в настройки и нажмите «Скачать» снова.');
    }
    const abs = resolveExportZip(job.zip_path);
    if (!abs || !fs.existsSync(abs)) {
      return res.status(404).send('Файл не найден');
    }
    res.download(abs, path.basename(abs));
  } catch (err) {
    console.error(err);
    res.status(500).send('Ошибка скачивания');
  }
});

// --- Transfer upload (submit request) ---
ensureDirs();
const transferUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      ensureDirs();
      cb(null, TRANSFERS_DIR);
    },
    filename: (req, file, cb) => {
      cb(null, `upload_${Date.now()}_${Math.random().toString(16).slice(2)}.zip`);
    }
  }),
  limits: { fileSize: 5 * 1024 * 1024 * 1024 }, // 5GB
  fileFilter: (req, file, cb) => {
    if (!file.originalname.toLowerCase().endsWith('.zip')) {
      return cb(new Error('only_zip'));
    }
    cb(null, true);
  }
});

function peekManifest(zipAbs) {
  return new Promise((resolve, reject) => {
    const proc = spawn('unzip', ['-p', zipAbs, 'manifest.json']);
    let out = '';
    let err = '';
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.stderr.on('data', (d) => { err += d.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(err || 'unzip_failed'));
      try {
        resolve(JSON.parse(out));
      } catch (e) {
        reject(new Error('bad_manifest'));
      }
    });
  });
}

router.get('/ru/account,transfer/', requireAuth, (req, res) => {
  res.render('transfer-import', {
    pageTitle: 'Перенос с другого инстанса | ЭтоЯTV',
    error: null,
    success: null
  });
});

router.post('/ru/account,transfer/', requireAuth, (req, res) => {
  transferUpload.single('archive')(req, res, async (err) => {
    if (err) {
      const tooBig = err.code === 'LIMIT_FILE_SIZE';
      return res.render('transfer-import', {
        pageTitle: 'Перенос с другого инстанса | ЭтоЯTV',
        error: tooBig
          ? 'Файл слишком большой (макс. 5 ГБ).'
          : 'Не удалось загрузить файл. Нужен .zip архива переноса.',
        success: null
      });
    }
    if (!req.file) {
      return res.render('transfer-import', {
        pageTitle: 'Перенос с другого инстанса | ЭтоЯTV',
        error: 'Выберите файл архива.',
        success: null
      });
    }

    const zipAbs = req.file.path;
    const zipUrl = `private/transfers/${path.basename(zipAbs)}`;
    try {
      const [pending] = await pool.query(
        `SELECT COUNT(*) AS c FROM profile_transfer_requests
         WHERE submitter_user_id = ? AND status = 'pending'`,
        [req.session.user.id]
      );
      if (pending[0].c >= 1) {
        try { fs.unlinkSync(zipAbs); } catch (e) {}
        return res.render('transfer-import', {
          pageTitle: 'Перенос с другого инстанса | ЭтоЯTV',
          error: 'У вас уже есть заявка в очереди. Дождитесь решения администрации.',
          success: null
        });
      }

      const manifest = await peekManifest(zipAbs);
      if (manifest.format !== TRANSFER_FORMAT) {
        try { fs.unlinkSync(zipAbs); } catch (e) {}
        return res.render('transfer-import', {
          pageTitle: 'Перенос с другого инстанса | ЭтоЯTV',
          error: 'Это не архив для переноса (нужен «Архив для переноса», не личный бэкап).',
          success: null
        });
      }

      await pool.query(
        `INSERT INTO profile_transfer_requests
          (submitter_user_id, source_username, source_email, zip_path, manifest_json, status, was_premium, was_verified)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
        [
          req.session.user.id,
          (manifest.user && manifest.user.username) || null,
          (manifest.user && manifest.user.email) || null,
          zipUrl,
          JSON.stringify({
            format: manifest.format,
            exported_at: manifest.exported_at,
            channels: (manifest.channels || []).map((c) => ({
              name: c.name, shortname: c.shortname, ownership: c.ownership,
              was_premium: c.was_premium, was_verified: c.was_verified
            })),
            records_count: (manifest.records || []).length,
            was_premium: !!manifest.was_premium,
            was_verified: !!manifest.was_verified
          }),
          manifest.was_premium ? 1 : 0,
          manifest.was_verified ? 1 : 0
        ]
      );

      return res.render('transfer-import', {
        pageTitle: 'Перенос с другого инстанса | ЭтоЯTV',
        error: null,
        success: 'Заявка отправлена. Ожидайте решения администрации.'
      });
    } catch (e) {
      console.error(e);
      try { fs.unlinkSync(zipAbs); } catch (x) {}
      return res.render('transfer-import', {
        pageTitle: 'Перенос с другого инстанса | ЭтоЯTV',
        error: 'Не удалось прочитать архив. Проверьте, что это корректный файл переноса.',
        success: null
      });
    }
  });
});

module.exports = router;
