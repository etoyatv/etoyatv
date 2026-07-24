'use strict';

const express = require('express');
const router = express.Router();
const fs = require('fs');
const { pool } = require('../config/db');
const { logAction } = require('../utils/logger');
const { importTransferArchive } = require('../utils/profileTransfer/importTransfer');
const { resolveTransferZip } = require('../utils/profileTransfer/paths');
const sendSystemMessage = require('../utils/systemMessage');

function canAcceptTransfers(user) {
  if (!user) return false;
  if (user.is_superadmin) return true;
  return user.staff_role === 'admin';
}

function formatDateLabel(value) {
  try {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return String(value || '');
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch (e) {
    return String(value || '');
  }
}

function enrichTransferRow(row) {
  try {
    row.manifest_preview = row.manifest_json ? JSON.parse(row.manifest_json) : null;
  } catch (e) {
    row.manifest_preview = null;
  }
  row.created_label = formatDateLabel(row.created_at);
  row.reviewed_label = row.reviewed_at ? formatDateLabel(row.reviewed_at) : '';
  if (row.manifest_preview && Array.isArray(row.manifest_preview.records)) {
    row.records_count = row.manifest_preview.records.length;
  } else if (row.manifest_preview && row.manifest_preview.records_count != null) {
    row.records_count = row.manifest_preview.records_count;
  } else {
    row.records_count = '—';
  }
}

router.get('/', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = 20;
    const offset = (page - 1) * limit;
    const connection = await pool.getConnection();
    try {
      const [[{ total }]] = await connection.query(
        `SELECT COUNT(*) AS total FROM profile_transfer_requests WHERE status = 'pending'`
      );
      const [rows] = await connection.query(
        `SELECT r.*, u.username AS submitter_name
         FROM profile_transfer_requests r
         LEFT JOIN users u ON u.id = r.submitter_user_id
         WHERE r.status = 'pending'
         ORDER BY r.created_at ASC
         LIMIT ? OFFSET ?`,
        [limit, offset]
      );
      for (const row of rows) enrichTransferRow(row);
      res.render('transfers', {
        pageTitle: 'Заявки на перенос | Админ-панель',
        currentPath: '/transfers',
        requests: rows,
        page,
        totalPages: Math.ceil(total / limit) || 1,
        totalPending: total,
        user: req.user || req.session.user
      });
    } finally {
      connection.release();
    }
  } catch (err) {
    console.error(err);
    res.status(500).send('Ошибка');
  }
});

router.get('/archive', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = 20;
    const offset = (page - 1) * limit;
    const statusFilter = ['accepted', 'rejected'].includes(req.query.status) ? req.query.status : null;
    const connection = await pool.getConnection();
    try {
      const where = statusFilter
        ? `WHERE r.status = ?`
        : `WHERE r.status IN ('accepted', 'rejected')`;
      const params = statusFilter ? [statusFilter] : [];

      const [[{ total }]] = await connection.query(
        `SELECT COUNT(*) AS total FROM profile_transfer_requests r ${where}`,
        params
      );
      const [rows] = await connection.query(
        `SELECT r.*,
                u.username AS submitter_name,
                rev.username AS reviewer_name
         FROM profile_transfer_requests r
         LEFT JOIN users u ON u.id = r.submitter_user_id
         LEFT JOIN users rev ON rev.id = r.reviewed_by
         ${where}
         ORDER BY COALESCE(r.reviewed_at, r.updated_at, r.created_at) DESC
         LIMIT ? OFFSET ?`,
        [...params, limit, offset]
      );
      for (const row of rows) enrichTransferRow(row);

      res.render('transfers-archive', {
        pageTitle: 'Архив заявок на перенос | Админ-панель',
        currentPath: '/transfers/archive',
        requests: rows,
        page,
        totalPages: Math.ceil(total / limit) || 1,
        totalArchived: total,
        statusFilter,
        user: req.user || req.session.user
      });
    } finally {
      connection.release();
    }
  } catch (err) {
    console.error(err);
    res.status(500).send('Ошибка');
  }
});

router.post('/:id/reject', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const connection = await pool.getConnection();
  try {
    const [rows] = await connection.query('SELECT * FROM profile_transfer_requests WHERE id = ? AND status = ?', [id, 'pending']);
    if (!rows.length) return res.redirect('/transfers');
    const row = rows[0];
    if (row.zip_path) {
      const abs = resolveTransferZip(row.zip_path);
      if (abs && fs.existsSync(abs)) {
        try { fs.unlinkSync(abs); } catch (e) {}
      }
    }
    await connection.query(
      `UPDATE profile_transfer_requests SET status = 'rejected', reviewed_by = ?, reviewed_at = NOW(), admin_note = ?, zip_path = NULL WHERE id = ?`,
      [req.session.user.id, (req.body.note || '').slice(0, 1000), id]
    );
    if (row.submitter_user_id) {
      try {
        await sendSystemMessage(row.submitter_user_id, 'Заявка на перенос профиля отклонена администрацией.');
      } catch (e) {}
    }
    await logAction('admin', req.session.user.username, `Отклонил заявку на перенос #${id}`, req.ip);
    res.redirect('/transfers');
  } catch (err) {
    console.error(err);
    res.status(500).send('Ошибка');
  } finally {
    connection.release();
  }
});

router.post('/:id/accept', async (req, res) => {
  if (!canAcceptTransfers(req.user)) {
    return res.status(403).send('Принимать переносы могут только администраторы');
  }
  const id = parseInt(req.params.id, 10);
  // Moderators cannot grant; only admins — and only if source claimed the flag
  const grantPremium = canAcceptTransfers(req.user) && (req.body.grant_premium === '1' || req.body.grant_premium === 'on');
  const grantVerified = canAcceptTransfers(req.user) && (req.body.grant_verified === '1' || req.body.grant_verified === 'on');
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.query(
      'SELECT * FROM profile_transfer_requests WHERE id = ? AND status = ? FOR UPDATE',
      [id, 'pending']
    );
    if (!rows.length) {
      await connection.rollback();
      return res.redirect('/transfers');
    }
    const row = rows[0];
    if (!row.submitter_user_id) {
      await connection.rollback();
      return res.status(400).send('Нет пользователя-заявителя');
    }
    const abs = resolveTransferZip(row.zip_path);
    if (!abs || !fs.existsSync(abs)) {
      await connection.query(
        `UPDATE profile_transfer_requests SET error_text = ? WHERE id = ?`,
        ['zip_missing', id]
      );
      await connection.commit();
      return res.status(400).send('Архив не найден на диске');
    }

    const result = await importTransferArchive(connection, {
      zipAbs: abs,
      targetUserId: row.submitter_user_id,
      grantPremium: grantPremium && !!row.was_premium,
      grantVerified: grantVerified && !!row.was_verified
    });

    try { fs.unlinkSync(abs); } catch (e) {}

    await connection.query(
      `UPDATE profile_transfer_requests SET
        status = 'accepted', reviewed_by = ?, reviewed_at = NOW(),
        grant_premium = ?, grant_verified = ?, zip_path = NULL, error_text = NULL
       WHERE id = ?`,
      [req.session.user.id, grantPremium ? 1 : 0, grantVerified ? 1 : 0, id]
    );
    await connection.commit();

    try {
      await sendSystemMessage(
        row.submitter_user_id,
        `Заявка на перенос принята. Импортировано каналов: ${result.channels_created}, записей: ${result.records_created}. RTMP-ключи сгенерированы заново.`
      );
    } catch (e) {}

    await logAction(
      'admin',
      req.session.user.username,
      `Принял перенос #${id} (каналов ${result.channels_created}, записей ${result.records_created}, premium=${grantPremium ? 1 : 0})`,
      req.ip
    );
    res.redirect('/transfers');
  } catch (err) {
    console.error(err);
    try { await connection.rollback(); } catch (e) {}
    try {
      await pool.query(
        `UPDATE profile_transfer_requests SET error_text = ? WHERE id = ?`,
        [(err.message || 'import_failed').slice(0, 2000), id]
      );
    } catch (e) {}
    res.status(500).send('Ошибка импорта: ' + (err.message || ''));
  } finally {
    connection.release();
  }
});

module.exports = router;
