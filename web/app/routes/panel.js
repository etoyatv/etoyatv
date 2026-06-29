const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { pool } = require('../../config/db');
const bcrypt = require('bcrypt');
const fs = require('fs');
const path = require('path');
const emailService = require('../../emailService');
const { requireAuth } = require('../../middlewares/auth');
const { panelMiddleware, recordUploadMiddleware, designUploadMiddleware } = require('../../middlewares/panel');
const { logAction } = require('../../utils/logger');
const wordFilter = require('../../utils/wordFilter');

router.get('/dashboard', requireAuth, (req, res) => {
  res.redirect('/ru/panel,dashboard');
});

router.get('/ru/panel,select', async (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  try {
    const connection = await pool.getConnection();
    const isStaff = req.session.user.staff_role && req.session.user.mask_mode !== 'user_mask';

    // If channel_id query param is provided and user is staff, set it in session and redirect to dashboard
    if (req.query.channel_id && isStaff) {
      const [ch] = await connection.query("SELECT id FROM channels WHERE id = ? AND status IN ('active', 'banned')", [req.query.channel_id]);
      if (ch.length > 0) {
        req.session.panel_channel_id = ch[0].id;
        connection.release();
        return res.redirect('/ru/panel,dashboard');
      }
    }

    const [ownedChannels] = await connection.query("SELECT c.*, 'owner' as panel_role FROM channels c WHERE c.user_id = ? AND c.status IN ('active', 'banned')", [req.session.user.id]);
    const [teamChannels] = await connection.query("SELECT c.*, t.is_editor, t.is_reporter, t.is_coowner FROM channels c JOIN channel_team t ON c.id = t.channel_id WHERE t.user_id = ? AND c.status IN ('active', 'banned') AND (t.is_editor = 1 OR t.is_reporter = 1 OR t.is_coowner = 1)", [req.session.user.id]);

    let availableChannels = [...ownedChannels, ...teamChannels.map(c => {
      let role = 'reporter';
      if (c.is_coowner) role = 'coowner';
      else if (c.is_editor) role = 'editor';
      return { ...c, panel_role: role };
    })];

    // If user is staff, and they have panel_channel_id in session that is not in availableChannels, load it too
    if (isStaff && req.session.panel_channel_id) {
      const isAlreadyAvailable = availableChannels.some(c => c.id == req.session.panel_channel_id);
      if (!isAlreadyAvailable) {
        const [staffSelectedChannel] = await connection.query("SELECT c.*, 'owner' as panel_role FROM channels c WHERE c.id = ? AND c.status IN ('active', 'banned')", [req.session.panel_channel_id]);
        if (staffSelectedChannel.length > 0) {
          availableChannels.push(staffSelectedChannel[0]);
        }
      }
    }

    const [pendingTransfers] = await connection.query(`
      SELECT t.id as transfer_id, t.created_at, c.name as channel_name, c.shortname, u.username as old_owner_username
      FROM pending_channel_transfers t
      JOIN channels c ON t.channel_id = c.id
      JOIN users u ON t.old_owner_id = u.id
      WHERE t.new_owner_id = ? AND t.email_confirmed = TRUE
    `, [req.session.user.id]);

    connection.release();

    if (availableChannels.length === 1 && !isStaff && pendingTransfers.length === 0 && req.query.to !== 'channel') {
      req.session.panel_channel_id = availableChannels[0].id;
      return res.redirect('/ru/panel,dashboard');
    }

    const to = req.query.to || '';
    const pageTitle = to === 'channel' ? 'Мои каналы | ЭтоЯTV' : 'Выбор телеканала | Панель управления | ЭтоЯTV';
    res.render('panel/select', { pageTitle, availableChannels, pendingTransfers, to });
  } catch (e) {
    console.error('Error loading channels:', e);
    res.status(500).send('Server Error');
  }
});

router.post('/ru/panel,set_channel', async (req, res) => {
  const { channel_id } = req.body;
  const to = req.query.to || req.body.to;
  if (channel_id) {
    req.session.panel_channel_id = channel_id;
    if (to === 'channel') {
      try {
        const connection = await pool.getConnection();
        const [ch] = await connection.query("SELECT shortname FROM channels WHERE id = ?", [channel_id]);
        connection.release();
        if (ch.length > 0) {
          return res.redirect('/' + ch[0].shortname);
        }
      } catch (err) {
        console.error(err);
      }
    }
  }
  res.redirect('/ru/panel,dashboard');
});

router.get('/ru/panel,dashboard', panelMiddleware, async (req, res) => {
  try {
    const channelId = res.locals.panelChannel.id;
    const [chatRows] = await pool.query(`
      SELECT m.id, m.user_id, m.guest_name, u.username, m.message, m.role, m.created_at, m.color
      FROM chat_messages m
      LEFT JOIN users u ON m.user_id = u.id
      WHERE m.channel_id = ?
      ORDER BY m.created_at ASC
      LIMIT 100
    `, [channelId]);
    res.render('panel/dashboard', { 
      activeMenu: 'dashboard', 
      activeSubmenu: '', 
      breadcrumbs: 'Панель управления',
      chatMessages: chatRows
    });
  } catch (e) {
    console.error(e);
    res.status(500).send('Server Error');
  }
});

async function renderRecordsPage(req, res, activeSubmenu, title, extraCondition = '') {
  try {
    const channelId = res.locals.panelChannel.id;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = 10;
    const offset = (page - 1) * limit;
    const searchQuery = req.query.q ? req.query.q.trim() : '';

    let searchCondition = '';
    let queryParamsCount = [channelId];
    let queryParamsData = [channelId];

    if (searchQuery) {
      searchCondition = ' AND title LIKE ?';
      queryParamsCount.push(`%${searchQuery}%`);
      queryParamsData.push(`%${searchQuery}%`);
    }

    const countQuery = `SELECT COUNT(*) as count FROM records WHERE channel_id = ? ${extraCondition} ${searchCondition}`;
    const [countRows] = await pool.query(countQuery, queryParamsCount);
    const totalRecords = countRows[0].count;
    const totalPages = Math.ceil(totalRecords / limit) || 1;

    queryParamsData.push(limit, offset);
    const dataQuery = `SELECT * FROM records WHERE channel_id = ? ${extraCondition} ${searchCondition} ORDER BY created_at DESC LIMIT ? OFFSET ?`;
    const [records] = await pool.query(dataQuery, queryParamsData);

    res.render('panel/records', {
      activeMenu: 'records',
      activeSubmenu: activeSubmenu,
      breadcrumbs: `<a href="/ru/panel,dashboard">Панель управления</a> &gt; <a href="/ru/panel,records">Медиа-архив</a> &gt; ${title}`,
      records,
      currentPage: page,
      totalPages: totalPages,
      searchQuery
    });
  } catch (e) {
    console.error(e);
    res.status(500).send('Server Error: ' + e.message + '\n' + e.stack);
  }
}

router.get('/ru/panel,records', panelMiddleware, async (req, res) => {
  await renderRecordsPage(req, res, 'all', 'Все записи');
});

router.get('/ru/panel,records,processing', panelMiddleware, async (req, res) => {
  await renderRecordsPage(req, res, 'processing', 'В обработке', 'AND hls_url IS NULL');
});

router.get('/ru/panel,albums', panelMiddleware, async (req, res) => {
  try {
    const channelId = res.locals.panelChannel.id;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = 5;
    const offset = (page - 1) * limit;

    const [totalRows] = await pool.query('SELECT COUNT(*) as count FROM albums WHERE channel_id = ?', [channelId]);
    const totalAlbums = totalRows[0].count;
    const totalPages = Math.ceil(totalAlbums / limit) || 1;

    const [albums] = await pool.query('SELECT * FROM albums WHERE channel_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?', [channelId, limit, offset]);

    res.render('panel/albums', {
      activeMenu: 'records',
      activeSubmenu: 'albums',
      breadcrumbs: '<a href="/ru/panel,dashboard">Панель управления</a> &gt; <a href="/ru/panel,records">Медиа-архив</a> &gt; Альбомы',
      albums,
      currentPage: page,
      totalPages: totalPages
    });
  } catch (e) {
    console.error(e);
    res.status(500).send('Server Error: ' + e.message + '\\n' + e.stack);
  }
});

router.post('/ru/panel,albums,bulk_delete', panelMiddleware, async (req, res) => {
  try {
    const channelId = res.locals.panelChannel.id;
    let albumIds = req.body.album_ids;
    if (!albumIds) {
      return res.redirect('/ru/panel,albums');
    }
    if (!Array.isArray(albumIds)) {
      albumIds = [albumIds];
    }
    if (albumIds.length > 0) {
      await pool.query('DELETE FROM albums WHERE id IN (?) AND channel_id = ?', [albumIds, channelId]);
    }

    res.redirect('/ru/panel,albums');
  } catch (e) {
    console.error('Error bulk deleting albums:', e);
    res.status(500).send('Server Error');
  }
});

router.get('/ru/panel,albums,create', panelMiddleware, (req, res) => {
  res.render('panel/albums_create', {
    activeMenu: 'records',
    activeSubmenu: 'albums',
    breadcrumbs: '<a href="/ru/panel,dashboard">Панель управления</a> &gt; <a href="/ru/panel,albums">Альбомы</a> &gt; Создать альбом'
  });
});

router.post('/ru/panel,albums,create', panelMiddleware, async (req, res) => {
  try {
    const channelId = res.locals.panelChannel.id;
    const { title, description } = req.body;
    if (!title) {
      return res.redirect('/ru/panel,albums,create?error=' + encodeURIComponent('Название обязательно'));
    }
    await pool.query('INSERT INTO albums (channel_id, title, description) VALUES (?, ?, ?)', [channelId, title, description || '']);
    res.redirect('/ru/panel,albums');
  } catch (e) {
    console.error(e);
    res.status(500).send('Server Error POST: ' + String(e.stack || e));
  }
});

router.get('/ru/panel,albums,edit', panelMiddleware, async (req, res) => {
  try {
    const channelId = res.locals.panelChannel.id;
    const albumId = req.query.id;
    if (!albumId) return res.redirect('/ru/panel,albums');

    const [albums] = await pool.query('SELECT * FROM albums WHERE id = ? AND channel_id = ?', [albumId, channelId]);
    if (albums.length === 0) return res.redirect('/ru/panel,albums');
    const album = albums[0];

    const [albumRecords] = await pool.query(`
      SELECT r.*, ar.id as album_record_id, ar.order_index 
      FROM album_records ar 
      JOIN records r ON ar.record_id = r.id 
      WHERE ar.album_id = ? 
      ORDER BY ar.order_index ASC, ar.created_at DESC`, [albumId]);

    const [allRecords] = await pool.query(`
      SELECT id, title 
      FROM records 
      WHERE channel_id = ? 
      ORDER BY created_at DESC`, [channelId]);

    res.render('panel/albums_edit', {
      activeMenu: 'records',
      activeSubmenu: 'albums',
      breadcrumbs: `<a href="/ru/panel,dashboard">Панель управления</a> &gt; <a href="/ru/panel,albums">Альбомы</a> &gt; Редактирование: ${album.title}`,
      album,
      albumRecords,
      allRecords
    });
  } catch (e) {
    console.error(e);
    res.status(500).send('Server Error');
  }
});

router.post('/ru/panel,albums,edit', panelMiddleware, async (req, res) => {
  try {
    const channelId = res.locals.panelChannel.id;
    const { id, title, description } = req.body;
    if (!id || !title) return res.redirect('/ru/panel,albums');

    await pool.query('UPDATE albums SET title = ?, description = ? WHERE id = ? AND channel_id = ?', [title, description || '', id, channelId]);
    res.redirect('/ru/panel,albums,edit?id=' + id);
  } catch (e) {
    console.error(e);
    res.status(500).send('Server Error');
  }
});

router.post('/ru/panel,albums,delete', panelMiddleware, async (req, res) => {
  try {
    const channelId = res.locals.panelChannel.id;
    const { id } = req.body;
    if (!id) return res.redirect('/ru/panel,albums');

    await pool.query('DELETE FROM album_records WHERE album_id = ?', [id]);
    await pool.query('DELETE FROM albums WHERE id = ? AND channel_id = ?', [id, channelId]);

    res.redirect('/ru/panel,albums');
  } catch (e) {
    console.error(e);
    res.status(500).send('Server Error');
  }
});

router.post('/ru/panel,albums,add_record', panelMiddleware, async (req, res) => {
  try {
    const channelId = res.locals.panelChannel.id;
    const { album_id, record_id } = req.body;
    if (!album_id || !record_id) return res.redirect('/ru/panel,albums');

    const [albums] = await pool.query('SELECT id FROM albums WHERE id = ? AND channel_id = ?', [album_id, channelId]);
    const [records] = await pool.query('SELECT id, is_18_plus FROM records WHERE id = ? AND channel_id = ?', [record_id, channelId]);

    if (albums.length > 0 && records.length > 0) {
      if (records[0].is_18_plus) {
        return res.redirect('/ru/panel,albums,edit?id=' + album_id + '&error=' + encodeURIComponent('Нельзя добавлять 18+ контент в альбомы!'));
      }
      const [orderRows] = await pool.query('SELECT COALESCE(MAX(order_index), 0) + 1 as next_order FROM album_records WHERE album_id = ?', [album_id]);
      const nextOrder = orderRows[0].next_order;
      await pool.query('INSERT INTO album_records (album_id, record_id, order_index) VALUES (?, ?, ?)', [album_id, record_id, nextOrder]);

      await pool.query('UPDATE channels SET autopilot_start_time = NOW() WHERE autopilot_album_id = ? AND autopilot_enabled = 1', [album_id]);
      const [channelsUsing] = await pool.query('SELECT id FROM channels WHERE autopilot_album_id = ? AND autopilot_enabled = 1', [album_id]);
      for (const ch of channelsUsing) {
        req.app.get('io').to(`channel_${ch.id}`).emit('autopilot_update');
      }
    }

    res.redirect('/ru/panel,albums,edit?id=' + album_id);
  } catch (e) {
    console.error(e);
    res.status(500).send('Server Error');
  }
});

router.post('/ru/panel,albums,remove_record', panelMiddleware, async (req, res) => {
  try {
    const channelId = res.locals.panelChannel.id;
    const { album_id, album_record_id } = req.body;
    if (!album_id || !album_record_id) return res.redirect('/ru/panel,albums');

    const [albums] = await pool.query('SELECT id FROM albums WHERE id = ? AND channel_id = ?', [album_id, channelId]);
    if (albums.length > 0) {
      await pool.query('DELETE FROM album_records WHERE id = ? AND album_id = ?', [album_record_id, album_id]);

      await pool.query('UPDATE channels SET autopilot_start_time = NOW() WHERE autopilot_album_id = ? AND autopilot_enabled = 1', [album_id]);
      const [channelsUsing] = await pool.query('SELECT id FROM channels WHERE autopilot_album_id = ? AND autopilot_enabled = 1', [album_id]);
      for (const ch of channelsUsing) {
        req.app.get('io').to(`channel_${ch.id}`).emit('autopilot_update');
      }
    }

    res.redirect('/ru/panel,albums,edit?id=' + album_id);
  } catch (e) {
    console.error(e);
    res.status(500).send('Server Error');
  }
});

router.post('/ru/panel,albums,move_record', panelMiddleware, async (req, res) => {
  try {
    const channelId = res.locals.panelChannel.id;
    const { album_id, album_record_id, direction } = req.body;
    if (!album_id || !album_record_id || !direction) return res.redirect('/ru/panel,albums');

    const [albums] = await pool.query('SELECT id FROM albums WHERE id = ? AND channel_id = ?', [album_id, channelId]);
    if (albums.length > 0) {
      const [records] = await pool.query('SELECT id, order_index FROM album_records WHERE album_id = ? ORDER BY order_index ASC, created_at DESC', [album_id]);
      
      const currentIndex = records.findIndex(r => r.id == album_record_id);
      if (currentIndex !== -1) {
        let targetIndex = -1;
        if (direction === 'up' && currentIndex > 0) {
          targetIndex = currentIndex - 1;
        } else if (direction === 'down' && currentIndex < records.length - 1) {
          targetIndex = currentIndex + 1;
        }

        if (targetIndex !== -1) {
          const newRecords = [...records];
          const temp = newRecords[currentIndex];
          newRecords[currentIndex] = newRecords[targetIndex];
          newRecords[targetIndex] = temp;

          for (let i = 0; i < newRecords.length; i++) {
            await pool.query('UPDATE album_records SET order_index = ? WHERE id = ?', [i + 1, newRecords[i].id]);
          }

          await pool.query('UPDATE channels SET autopilot_start_time = NOW() WHERE autopilot_album_id = ? AND autopilot_enabled = 1', [album_id]);
          const [channelsUsing] = await pool.query('SELECT id FROM channels WHERE autopilot_album_id = ? AND autopilot_enabled = 1', [album_id]);
          for (const ch of channelsUsing) {
            req.app.get('io').to(`channel_${ch.id}`).emit('autopilot_update');
          }
        }
      }
    }

    res.redirect('/ru/panel,albums,edit?id=' + album_id);
  } catch (e) {
    console.error(e);
    res.status(500).send('Server Error');
  }
});

router.get('/ru/panel,autopilot', panelMiddleware, async (req, res) => {
  try {
    const channelId = res.locals.panelChannel.id;

    const [channels] = await pool.query('SELECT autopilot_enabled, autopilot_album_id, autopilot_disabled FROM channels WHERE id = ?', [channelId]);
    const channel = channels[0];

    const [albums] = await pool.query('SELECT id, title FROM albums WHERE channel_id = ? ORDER BY title ASC', [channelId]);

    res.render('panel/autopilot', {
      activeMenu: 'autopilot',
      activeSubmenu: '',
      breadcrumbs: '<a href="/ru/panel,dashboard">Панель управления</a> &gt; Автопилот',
      channel,
      albums
    });
  } catch (e) {
    console.error(e);
    res.status(500).send('Server Error');
  }
});

router.post('/ru/panel,autopilot', panelMiddleware, async (req, res) => {
  try {
    const channelId = res.locals.panelChannel.id;
    if (res.locals.panelChannel.autopilot_disabled) {
      return res.redirect('/ru/panel,autopilot?error=Автопилот запрещен администрацией');
    }
    const { autopilot_enabled, autopilot_album_id } = req.body;

    const enabled = autopilot_enabled === 'on' ? 1 : 0;
    const albumId = (enabled && autopilot_album_id) ? parseInt(autopilot_album_id) : null;

    await pool.query(
      'UPDATE channels SET autopilot_enabled = ?, autopilot_album_id = ?, autopilot_start_time = NOW() WHERE id = ?',
      [enabled, albumId, channelId]
    );

    const io = req.app.get('io');
    if (io) {
      io.to('channel_' + channelId).emit('autopilot_update');
    }

    res.redirect('/ru/panel,autopilot?success=1');
  } catch (e) {
    console.error(e);
    res.status(500).send('Server Error');
  }
});

router.get('/ru/panel,records,upload', panelMiddleware, (req, res) => {
  res.render('panel/upload', { activeMenu: 'records', activeSubmenu: 'upload', breadcrumbs: '<a href="/ru/panel,dashboard">Панель управления</a> &gt; <a href="/ru/panel,records">Медиа-архив</a> &gt; Загрузить видео' });
});

router.post('/ru/panel,records,delete', panelMiddleware, async (req, res) => {
  const { id } = req.body;
  const channelId = res.locals.panelChannel.id;
  try {
    const [rows] = await pool.query('SELECT video_url, thumbnail_url, hls_url FROM records WHERE id = ? AND channel_id = ?', [id, channelId]);
    if (rows.length > 0) {
      const record = rows[0];

      if (record.video_url) {
        const videoPath = path.join(__dirname, '../../public', record.video_url);
        if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
      }
      if (record.thumbnail_url) {
        const thumbPath = path.join(__dirname, '../../public', record.thumbnail_url);
        if (fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath);
      }
      if (record.hls_url) {
        const hlsDir = path.join(__dirname, '../../public', path.dirname(record.hls_url));
        if (fs.existsSync(hlsDir)) fs.rmSync(hlsDir, { recursive: true, force: true });
      }
    }

    await pool.query('DELETE FROM records WHERE id = ? AND channel_id = ?', [id, channelId]);
    const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
    logAction('team', req.session.user.username, `Удалил запись (ID: ${id}) с канала ${res.locals.panelChannel.shortname}`, userIp);
    res.redirect('/ru/panel,records');
  } catch (e) {
    console.error(e);
    res.status(500).send('Server Error');
  }
});

router.post('/ru/panel,records,bulk_delete', panelMiddleware, async (req, res) => {
  const { record_ids } = req.body;
  if (!record_ids) return res.redirect('/ru/panel,records');
  const ids = Array.isArray(record_ids) ? record_ids : [record_ids];
  const channelId = res.locals.panelChannel.id;

  try {
    for (const id of ids) {
      const [rows] = await pool.query('SELECT video_url, thumbnail_url, hls_url FROM records WHERE id = ? AND channel_id = ?', [id, channelId]);
      if (rows.length > 0) {
        const record = rows[0];

        if (record.video_url) {
          const videoPath = path.join(__dirname, '../../public', record.video_url);
          if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
        }
        if (record.thumbnail_url) {
          const thumbPath = path.join(__dirname, '../../public', record.thumbnail_url);
          if (fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath);
        }
        if (record.hls_url) {
          const hlsDir = path.join(__dirname, '../../public', path.dirname(record.hls_url));
          if (fs.existsSync(hlsDir)) fs.rmSync(hlsDir, { recursive: true, force: true });
        }
        await pool.query('DELETE FROM records WHERE id = ? AND channel_id = ?', [id, channelId]);
        const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
        logAction('team', req.session.user.username, `Удалил запись (ID: ${id}) с канала ${res.locals.panelChannel.shortname}`, userIp);
      }
    }
    res.redirect('/ru/panel,records');
  } catch (e) {
    console.error(e);
    res.status(500).send('Server Error');
  }
});

router.post('/ru/panel,records,upload', panelMiddleware, recordUploadMiddleware, async (req, res) => {
  if (!req.file) {
    if (req.xhr || (req.headers.accept && req.headers.accept.includes('json'))) {
      return res.status(400).json({ error: 'Файл не загружен.' });
    }
    return res.status(400).send('No file uploaded.');
  }

  let { title, description } = req.body;
  if (description && description.length > 200) description = description.substring(0, 200);

  const filteredTitle = req.session.user.staff_role ? title.trim() : await wordFilter.filter(title.trim());
  const filteredDesc = req.session.user.staff_role ? (description || '') : await wordFilter.filter(description || '');

  const channelId = res.locals.panelChannel.id;
  const videoUrl = '/uploads/records/' + req.file.filename;
  const videoPath = req.file.path;
  const videoSize = req.file.size || 0;
  
  const path = require('path');
  const thumbnailFilename = 'thumb_' + path.parse(req.file.filename).name + '.jpg';
  const thumbnailUrl = '/uploads/records/' + thumbnailFilename;

  try {
    const [channelRows] = await pool.query('SELECT cdn_quota_mb FROM channels WHERE id = ?', [channelId]);
    const quotaMB = channelRows.length > 0 && channelRows[0].cdn_quota_mb ? channelRows[0].cdn_quota_mb : 2048;
    const QUOTA_LIMIT = quotaMB * 1024 * 1024; // Convert MB to bytes

    const [rows] = await pool.query('SELECT SUM(size_bytes) as totalSize FROM records WHERE channel_id = ?', [channelId]);
    const currentTotal = parseInt(rows[0].totalSize || 0);
    if (currentTotal + videoSize > QUOTA_LIMIT) {
      const fs = require('fs');
      if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
      const errMsg = `Превышена квота ${Math.floor(quotaMB / 1024 * 100) / 100} ГБ. Свободно только ${Math.max(0, (QUOTA_LIMIT - currentTotal) / 1024 / 1024).toFixed(2)} MB, а вы пытаетесь загрузить ${(videoSize / 1024 / 1024).toFixed(2)} MB. Пожалуйста, удалите старые видеозаписи в Медиа-архиве.`;
      if (req.xhr || (req.headers.accept && req.headers.accept.includes('json'))) {
        return res.status(400).json({ error: errMsg });
      }
      return res.status(400).send(errMsg);
    }

    const [result] = await pool.query(
      'INSERT INTO records (channel_id, title, description, video_url, thumbnail_url, duration, size_bytes, processing_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [channelId, filteredTitle, filteredDesc, videoUrl, thumbnailUrl, 0, req.file.size, 'pending']
    );

    const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
    logAction('team', req.session.user.username, `Создал новую запись (ID: ${result.insertId}, Название: "${title.trim()}") на канале ${res.locals.panelChannel.shortname}`, userIp);

    if (req.xhr || (req.headers.accept && req.headers.accept.includes('json'))) {
      return res.json({ success: true, redirect: '/ru/panel,records' });
    }
    res.redirect('/ru/panel,records');
  } catch (err) {
    console.error('Error uploading record:', err);
    if (req.xhr || (req.headers.accept && req.headers.accept.includes('json'))) {
      return res.status(500).json({ error: 'Внутренняя ошибка сервера при сохранении записи.' });
    }
    res.status(500).send('Internal Server Error');
  }
});

router.get('/ru/panel,records,edit', panelMiddleware, async (req, res) => {
  const channelId = res.locals.panelChannel.id;
  const recordId = req.query.id;
  if (!recordId) return res.redirect('/ru/panel,records');

  try {
    const [records] = await pool.query('SELECT * FROM records WHERE id = ? AND channel_id = ?', [recordId, channelId]);
    if (records.length === 0) return res.redirect('/ru/panel,records');

    res.render('panel/edit', {
      record: records[0]
    });
  } catch (e) {
    console.error('Error fetching record for edit:', e);
    res.status(500).send('Server Error');
  }
});

router.post('/ru/panel,records,edit', panelMiddleware, async (req, res) => {
  const channelId = res.locals.panelChannel.id;
  const { id, title, description, is_18_plus } = req.body;
  if (!id || !title) return res.redirect('/ru/panel,records');

  const is18Plus = is_18_plus === 'on' ? 1 : 0;

  try {
    const filteredTitle = req.session.user.staff_role ? title.trim() : await wordFilter.filter(title.trim());
    const filteredDesc = req.session.user.staff_role ? (description ? description.trim() : '') : await wordFilter.filter(description ? description.trim() : '');

    await pool.query('UPDATE records SET title = ?, description = ?, is_18_plus = ? WHERE id = ? AND channel_id = ?', 
      [filteredTitle, filteredDesc, is18Plus, id, channelId]);
    
    const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
    logAction('team', req.session.user.username, `Изменил данные видеозаписи (ID: ${id})`, userIp);

    res.redirect('/ru/panel,records');
  } catch (e) {
    console.error('Error updating record:', e);
    res.status(500).send('Server Error');
  }
});

router.post('/ru/panel,settings,channel,delete', panelMiddleware, async (req, res) => {
  if (res.locals.panelRole !== 'owner') {
    return res.status(403).send('Только владелец может удалить телеканал.');
  }
  const channelId = res.locals.panelChannel.id;
  const shortname = res.locals.panelChannel.shortname;
  try {
    const connection = await pool.getConnection();
    await connection.query("UPDATE channels SET status = 'deleted', deleted_at = NOW(), rtmp_disabled = 1 WHERE id = ?", [channelId]);
    connection.release();
    const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
    logAction('team', req.session.user.username, `Удалил телеканал (URL: ${shortname}, ID: ${channelId})`, userIp);
    const axios = require('axios');
    const rtmpApiUrl = process.env.RTMP_API_URL || 'http://localhost:8080';
    const rtmpAuth = { username: process.env.RTMP_API_USER || 'admin', password: process.env.RTMP_API_PASS || 'admin' };
    try { await axios.delete(`${rtmpApiUrl}/api/streams/live/${shortname}`, { auth: rtmpAuth }); } catch(e) {}
    if (req.session.channel && req.session.channel.id === channelId) {
      req.session.channel = null;
    }
    res.redirect('/?deleted=1');
  } catch (e) {
    console.error('Error deleting channel:', e);
    res.status(500).send('Database error');
  }
});

router.get('/ru/panel,settings,broadcast', panelMiddleware, async (req, res) => {
  const channelId = res.locals.panelChannel.id;
  const userId = req.session.user.id;
  try {
    let [keys] = await pool.query('SELECT stream_key FROM stream_keys WHERE channel_id = ? AND user_id = ?', [channelId, userId]);
    let streamKey = '';
    if (keys.length === 0) {
      streamKey = 'sk_live_' + crypto.randomBytes(16).toString('hex');
      await pool.query('INSERT INTO stream_keys (channel_id, user_id, stream_key) VALUES (?, ?, ?)', [channelId, userId, streamKey]);
    } else {
      streamKey = keys[0].stream_key;
    }
    
    const rtmpServer = process.env.RTMP_INGEST_URL || ('rtmp://' + req.hostname + '/live');
    

    res.render('panel/broadcast', { 
      activeMenu: 'settings', 
      activeSubmenu: 'broadcast', 
      streamKey, 
      rtmpServer,
      breadcrumbs: '<a href="/ru/panel,dashboard">Панель управления</a> &gt; Настройки &gt; Трансляция'
    });
  } catch (e) {
    console.error('Error fetching stream key:', e);
    res.status(500).send('Database error');
  }
});

router.post('/ru/panel,settings,broadcast,reset', panelMiddleware, async (req, res) => {
  const channelId = res.locals.panelChannel.id;
  const userId = req.session.user.id;
  try {
    const newKey = 'sk_live_' + crypto.randomBytes(16).toString('hex');
    await pool.query('UPDATE stream_keys SET stream_key = ? WHERE channel_id = ? AND user_id = ?', [newKey, channelId, userId]);
    
    const resetTime = new Date();
    const shortname = res.locals.panelChannel.shortname;
    setTimeout(async () => {
      try {
        const axios = require('axios');
        const rtmpApiUrl = process.env.RTMP_API_URL || 'http://localhost:8080';
        const rtmpAuth = { username: process.env.RTMP_API_USER || 'admin', password: process.env.RTMP_API_PASS || 'admin' };
        const response = await axios.get(`${rtmpApiUrl}/api/streams`, { auth: rtmpAuth });
        const liveStreams = response.data.live;
        if (liveStreams && liveStreams[shortname] && liveStreams[shortname].publisher) {
          const connectCreated = new Date(liveStreams[shortname].publisher.connectCreated);
          if (connectCreated < resetTime) {
            await axios.delete(`${rtmpApiUrl}/api/streams/live/${shortname}`, { auth: rtmpAuth });
            console.log(`[RTMP] Dropped old stream for ${shortname} 15s after key reset`);
          } else {
            console.log(`[RTMP] Stream for ${shortname} is newer than reset, not dropping`);
          }
        }
      } catch (err) {
        console.error('[RTMP API] Error dropping stream:', err.message);
      }
    }, 15000);
    
    res.redirect('/ru/panel,settings,broadcast?reset=1');
  } catch (e) {
    console.error('Error resetting stream key:', e);
    res.status(500).send('Database error');
  }
});

router.get('/ru/panel,settings,design', panelMiddleware, (req, res) => {
  res.render('panel/design', { activeMenu: 'settings', activeSubmenu: 'design', breadcrumbs: '<a href="/ru/panel,dashboard">Панель управления</a> &gt; Настройки &gt; Дизайн' });
});

router.post('/ru/panel,settings,design', panelMiddleware, designUploadMiddleware, async (req, res) => {
  if (res.locals.panelChannel.design_disabled) {
    return res.redirect('/ru/panel,settings,design?error=Изменение дизайна запрещено администрацией');
  }
  const { 
    bg_color, 
    text_color, 
    player_bg_color, 
    player_menu_color, 
    player_link_color, 
    player_bg_fit,
    bg_fit,
    delete_logo, 
    delete_banner, 
    delete_background,
    delete_player_background
  } = req.body;
  const channelId = res.locals.panelChannel.id;

  let updates = [];
  let params = [];
  
  let oldDesign = {};
  try {
    const [oldRows] = await pool.query('SELECT logo_url, banner_url, bg_url, player_bg_url FROM channels WHERE id = ?', [channelId]);
    if (oldRows.length > 0) oldDesign = oldRows[0];
  } catch(e) {}

  const deleteOldFile = (url) => {
    if (url && typeof url === 'string' && url.startsWith('/images/design/')) {
      const fs = require('fs');
      const path = require('path');
      const filepath = path.join(__dirname, '../../public', url);
      fs.unlink(filepath, (err) => { if (err) console.error('Failed to delete old file:', filepath); });
    }
  };

  if (bg_color) { updates.push('bg_color = ?'); params.push(bg_color); }
  if (text_color) { updates.push('text_color = ?'); params.push(text_color); }
  if (player_bg_color !== undefined) { updates.push('player_bg_color = ?'); params.push(player_bg_color || null); }
  if (player_menu_color !== undefined) { updates.push('player_menu_color = ?'); params.push(player_menu_color || null); }
  if (player_link_color !== undefined) { updates.push('player_link_color = ?'); params.push(player_link_color || null); }
  if (player_bg_fit !== undefined) { updates.push('player_bg_fit = ?'); params.push(player_bg_fit || 'stretch'); }
  if (bg_fit !== undefined) { updates.push('bg_fit = ?'); params.push(bg_fit || 'stretch'); }

  if (delete_logo) {
    updates.push('logo_url = "/images/default_channel_logo.png"');
    deleteOldFile(oldDesign.logo_url);
  } else if (req.files && req.files.logo && req.files.logo[0]) {
    updates.push('logo_url = ?');
    params.push('/images/design/' + req.files.logo[0].filename);
    deleteOldFile(oldDesign.logo_url);
  }

  if (delete_banner) {
    updates.push('banner_url = NULL');
    deleteOldFile(oldDesign.banner_url);
  } else if (req.files && req.files.banner && req.files.banner[0]) {
    const sharp = require('sharp');
    const fs = require('fs');
    const path = require('path');
    const bannerFile = req.files.banner[0];
    const oldPath = bannerFile.path;
    const ext = path.extname(bannerFile.originalname) || '.png';
    const newFilename = 'banner_resized_' + Date.now() + ext;
    const newPath = path.join(bannerFile.destination, newFilename);

    try {
      await sharp(oldPath)
        .resize(970, 303, { fit: 'inside' })
        .toFile(newPath);
      
      fs.unlink(oldPath, (err) => { if (err) console.error('Failed to delete original banner:', err); });

      updates.push('banner_url = ?');
      params.push('/images/design/' + newFilename);
      deleteOldFile(oldDesign.banner_url);
    } catch (err) {
      console.error('Error resizing banner:', err);
      updates.push('banner_url = ?');
      params.push('/images/design/' + bannerFile.filename);
      deleteOldFile(oldDesign.banner_url);
    }
  }

  if (delete_background) {
    updates.push('bg_url = NULL');
    deleteOldFile(oldDesign.bg_url);
  } else if (req.files && req.files.background && req.files.background[0]) {
    updates.push('bg_url = ?');
    params.push('/images/design/' + req.files.background[0].filename);
    deleteOldFile(oldDesign.bg_url);
  }

  if (delete_player_background) {
    updates.push('player_bg_url = NULL');
    deleteOldFile(oldDesign.player_bg_url);
  } else if (req.files && req.files.player_background && req.files.player_background[0]) {
    updates.push('player_bg_url = ?');
    params.push('/images/design/' + req.files.player_background[0].filename);
    deleteOldFile(oldDesign.player_bg_url);
  }

  if (updates.length > 0) {
    params.push(channelId);
    try {
      const connection = await pool.getConnection();
      await connection.query('UPDATE channels SET ' + updates.join(', ') + ' WHERE id = ?', params);
      connection.release();
    } catch (e) {
      console.error('Error updating design:', e);
      return res.redirect('/ru/panel,settings,design?error=Server error');
    }
  }

  if (updates.length > 0) {
    const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
    logAction('team', req.session.user.username, 'Обновил оформление телеканала', userIp);
  }

  res.redirect('/ru/panel,settings,design?success=1');
});

router.get('/ru/panel,settings,channel', panelMiddleware, async (req, res) => {
  try {
    const connection = await pool.getConnection();
    const [cooperativeChannels] = await connection.query(
      "SELECT id FROM channels WHERE user_id = ? AND is_personal = FALSE AND status IN ('active', 'banned')",
      [req.session.user.id]
    );
    connection.release();
    res.render('panel/channel', {
      activeMenu: 'settings',
      activeSubmenu: 'channel',
      query: req.query,
      cooperativeCount: cooperativeChannels.length
    });
  } catch (e) {
    console.error('Error in GET /ru/panel,settings,channel:', e);
    res.render('panel/channel', {
      activeMenu: 'settings',
      activeSubmenu: 'channel',
      query: req.query,
      cooperativeCount: 0
    });
  }
});

router.post('/ru/panel,settings,channel,make_cooperative', panelMiddleware, async (req, res) => {
  if (res.locals.panelRole !== 'owner') {
    return res.status(403).send('Только владелец канала может менять его тип.');
  }
  if (!res.locals.panelChannel.is_personal) {
    return res.redirect('/ru/panel,settings,channel?error=' + encodeURIComponent('Этот канал уже является кооперативным.'));
  }

  try {
    const connection = await pool.getConnection();
    const [cooperativeChannels] = await connection.query(
      "SELECT id FROM channels WHERE user_id = ? AND is_personal = FALSE AND status IN ('active', 'banned')",
      [req.session.user.id]
    );
    if (cooperativeChannels.length >= 3) {
      connection.release();
      return res.redirect('/ru/panel,settings,channel?error=' + encodeURIComponent('Вы не можете иметь более 3 кооперативных каналов.'));
    }

    await connection.query('UPDATE channels SET is_personal = FALSE WHERE id = ?', [res.locals.panelChannel.id]);
    
    const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
    logAction('team', req.session.user.username, `Преобразовал телеканал ${res.locals.panelChannel.shortname} в кооперативный`, userIp);

    connection.release();
    res.redirect('/ru/panel,settings,channel?success=1');
  } catch (e) {
    console.error('Error making channel cooperative:', e);
    res.redirect('/ru/panel,settings,channel?error=' + encodeURIComponent('Ошибка базы данных.'));
  }
});

router.post('/ru/panel,settings,channel', panelMiddleware, async (req, res) => {
  if (res.locals.panelRole === 'reporter') {
    return res.status(403).send('У вас нет прав на редактирование настроек канала.');
  }

  const { name, description, shortname } = req.body;
  const channelId = res.locals.panelChannel.id;

  if (name && name.length > 77) {
    return res.redirect('/ru/panel,settings,channel?error=' + encodeURIComponent('Название телеканала не должно превышать 77 символов.'));
  }

  if (description && description.length > 200) {
    return res.redirect('/ru/panel,settings,channel?error=' + encodeURIComponent('Описание не может быть больше 200 символов.'));
  }
  
  if (shortname) {
    const restrictedSlugs = ['login', 'register', 'api', 'news', 'account', 'channels', 'admin', 'panel'];
    if (restrictedSlugs.includes(shortname.toLowerCase())) {
      return res.redirect('/ru/panel,settings,channel?error=' + encodeURIComponent('Это короткое имя недоступно.'));
    }

    const slugRegex = /^[a-zA-Z0-9_-]+$/;
    if (!slugRegex.test(shortname)) {
      return res.redirect('/ru/panel,settings,channel?error=' + encodeURIComponent('Короткое имя может содержать только латинские буквы, цифры, дефис и подчеркивание.'));
    }

    if (!req.session.user.staff_role && await wordFilter.containsBadWords(shortname)) {
      return res.redirect('/ru/panel,settings,channel?error=' + encodeURIComponent('Данный URL адрес нельзя назвать.'));
    }
  }

  try {
    const connection = await pool.getConnection();

    const filteredName = req.session.user.staff_role ? name.trim() : await wordFilter.filter(name.trim());
    const filteredDescription = req.session.user.staff_role ? description.trim() : await wordFilter.filter(description.trim());

    if (res.locals.panelRole === 'owner' && shortname) {
      if (shortname !== res.locals.panelChannel.shortname) {
        if (res.locals.panelChannel.shortname_changed_at) {
          const lastChange = new Date(res.locals.panelChannel.shortname_changed_at);
          const daysSinceChange = (Date.now() - lastChange.getTime()) / (1000 * 60 * 60 * 24);
          if (daysSinceChange < 7) {
            connection.release();
            const nextAvailableDate = new Date(lastChange.getTime() + 7 * 24 * 60 * 60 * 1000);
            return res.redirect('/ru/panel,settings,channel?error=' + encodeURIComponent('Изменять URL можно только раз в неделю. Следующее изменение будет доступно: ' + nextAvailableDate.toLocaleDateString('ru-RU')));
          }
        }
        // Check if shortname is unique
        const [existing] = await connection.query('SELECT id FROM channels WHERE shortname = ? AND id != ?', [shortname, channelId]);
        if (existing.length > 0) {
          connection.release();
          return res.redirect('/ru/panel,settings,channel?error=' + encodeURIComponent('Короткое имя уже занято.'));
        }
        await connection.query('UPDATE channels SET name = ?, description = ?, shortname = ?, shortname_changed_at = NOW() WHERE id = ?',
          [filteredName, filteredDescription, shortname.trim().toLowerCase(), channelId]);
      } else {
        await connection.query('UPDATE channels SET name = ?, description = ? WHERE id = ?',
          [filteredName, filteredDescription, channelId]);
      }
    } else {
      await connection.query('UPDATE channels SET name = ?, description = ? WHERE id = ?',
        [filteredName, filteredDescription, channelId]);
    }
    const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
    if (res.locals.panelRole === 'owner' && shortname && shortname !== res.locals.panelChannel.shortname) {
      logAction('team', req.session.user.username, `Изменил настройки телеканала (в т.ч. URL с ${res.locals.panelChannel.shortname} на ${shortname.trim().toLowerCase()})`, userIp);
    } else {
      logAction('team', req.session.user.username, 'Изменил настройки телеканала', userIp);
    }
    
    connection.release();
    res.redirect('/ru/panel,settings,channel?success=1');
  } catch (e) {
    console.error('Error updating channel:', e);
    res.redirect('/ru/panel,settings,channel?error=' + encodeURIComponent('Ошибка базы данных.'));
  }
});

router.get('/ru/panel,settings,access', panelMiddleware, (req, res) => {
  res.render('panel/access', { activeMenu: 'settings', activeSubmenu: 'access', breadcrumbs: '<a href="/ru/panel,dashboard">Панель управления</a> &gt; Настройки &gt; Доступ' });
});

router.post('/ru/panel,settings,access', panelMiddleware, async (req, res) => {
  if (res.locals.panelRole === 'reporter') {
    return res.status(403).send('У вас нет прав на редактирование этих настроек.');
  }

  const channelId = res.locals.panelChannel.id;
  const { access_level, password, is_18_plus } = req.body;
  const is18Plus = is_18_plus === 'on' ? 1 : 0;
  
  try {
    await pool.query(
      'UPDATE channels SET access_level = ?, password = ?, is_18_plus = ? WHERE id = ?',
      [access_level === 'password' ? 'password' : 'public', password || '', is18Plus, channelId]
    );
    res.redirect('/ru/panel,settings,access?success=1');
  } catch (e) {
    console.error('Error updating access settings:', e);
    res.redirect('/ru/panel,settings,access?error=Server error');
  }
});

router.get('/ru/panel,settings,team', panelMiddleware, async (req, res) => {
  try {
    const [team] = await pool.query(`
      SELECT t.*, u.username, u.avatar 
      FROM channel_team t
      JOIN users u ON t.user_id = u.id
      WHERE t.channel_id = ?
      ORDER BY t.order_index ASC, t.id ASC
    `, [res.locals.panelChannel.id]);

    res.render('panel/team', {
      activeMenu: 'settings',
      activeSubmenu: 'team',
      breadcrumbs: '<a href="/ru/panel,dashboard">Панель управления</a> &gt; Настройки &gt; Команда',
      teamMembers: team,
      error: req.query.error,
      success: req.query.success
    });
  } catch (e) {
    res.status(500).send('DB error');
  }
});

router.post('/ru/panel,settings,team,add', panelMiddleware, async (req, res) => {
  const { username, is_reporter, is_moderator, is_editor } = req.body;

  if (!is_reporter && !is_moderator && !is_editor) {
    return res.redirect('/ru/panel,settings,team?error=' + encodeURIComponent('Выберите хотя бы одну роль для пользователя'));
  }

  const channelId = res.locals.panelChannel.id;
  try {
    const [users] = await pool.query('SELECT id FROM users WHERE username = ?', [username]);
    if (users.length === 0) return res.redirect('/ru/panel,settings,team?error=Пользователь не найден');
    const userId = users[0].id;
    if (userId === res.locals.panelChannel.user_id) return res.redirect('/ru/panel,settings,team?error=' + encodeURIComponent('Нельзя добавить владельца канала в команду'));

    const [existing] = await pool.query('SELECT user_id FROM channel_team WHERE channel_id = ? AND user_id = ?', [channelId, userId]);
    if (existing.length > 0) return res.redirect('/ru/panel,settings,team?error=' + encodeURIComponent('Пользователь уже находится в команде'));

    await pool.query(
      'INSERT INTO channel_team (channel_id, user_id, is_reporter, is_moderator, is_editor) VALUES (?, ?, ?, ?, ?)',
      [channelId, userId, is_reporter ? 1 : 0, is_moderator ? 1 : 0, is_editor ? 1 : 0]
    );
    const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
    logAction('team', req.session.user.username, `Добавил пользователя ${username} в команду канала`, userIp);
    res.redirect('/ru/panel,settings,team?success=1');
  } catch (e) {
    res.redirect('/ru/panel,settings,team?error=Ошибка сервера');
  }
});

router.post('/ru/panel,settings,team,update', panelMiddleware, async (req, res) => {
  const { user_id, is_reporter, is_moderator, is_editor, is_coowner } = req.body;
  const channelId = res.locals.panelChannel.id;
  const currentUserRole = res.locals.panelRole;

  try {
    const [targetRows] = await pool.query('SELECT is_coowner FROM channel_team WHERE channel_id = ? AND user_id = ?', [channelId, user_id]);
    if (targetRows.length === 0) {
      return res.redirect('/ru/panel,settings,team?error=' + encodeURIComponent('Пользователь не найден в команде'));
    }
    const targetIsCoowner = targetRows[0].is_coowner === 1;
    const reqCoowner = (is_coowner && !res.locals.panelChannel.is_personal) ? 1 : 0;

    if (currentUserRole === 'coowner') {
      if (targetIsCoowner || (targetIsCoowner !== (reqCoowner === 1))) {
        return res.redirect('/ru/panel,settings,team?error=' + encodeURIComponent('Действие запрещено. Совладельцы не могут изменять права совладельцев.'));
      }
    }

    let finalReporter = is_reporter ? 1 : 0;
    let finalModerator = is_moderator ? 1 : 0;
    let finalEditor = is_editor ? 1 : 0;
    if (reqCoowner === 1) {
      finalReporter = 1;
      finalModerator = 1;
      finalEditor = 1;
    }

    if (!finalReporter && !finalModerator && !finalEditor) {
      return res.redirect('/ru/panel,settings,team?error=' + encodeURIComponent('Выберите хотя бы одну роль для пользователя'));
    }

    await pool.query(
      'UPDATE channel_team SET is_reporter = ?, is_moderator = ?, is_editor = ?, is_coowner = ? WHERE channel_id = ? AND user_id = ?',
      [finalReporter, finalModerator, finalEditor, reqCoowner, channelId, user_id]
    );
    const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
    logAction('team', req.session.user.username, `Изменил права пользователя (ID: ${user_id}) в команде канала`, userIp);
    res.redirect('/ru/panel,settings,team?success=1');
  } catch (e) {
    console.error('Error updating team member:', e);
    res.redirect('/ru/panel,settings,team?error=Ошибка сервера');
  }
});

router.post('/ru/panel,settings,team,remove', panelMiddleware, async (req, res) => {
  const { user_id } = req.body;
  const channelId = res.locals.panelChannel.id;
  const currentUserRole = res.locals.panelRole;
  try {
    if (currentUserRole === 'coowner') {
      const [targetRows] = await pool.query('SELECT is_coowner FROM channel_team WHERE channel_id = ? AND user_id = ?', [channelId, user_id]);
      if (targetRows.length > 0 && targetRows[0].is_coowner === 1) {
        return res.redirect('/ru/panel,settings,team?error=' + encodeURIComponent('Действие запрещено. Совладельцы не могут удалять совладельцев.'));
      }
    }
    await pool.query('DELETE FROM channel_team WHERE channel_id = ? AND user_id = ?', [channelId, user_id]);
    const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
    logAction('team', req.session.user.username, `Удалил пользователя (ID: ${user_id}) из команды канала`, userIp);
    res.redirect('/ru/panel,settings,team?success=1');
  } catch (e) {
    res.redirect('/ru/panel,settings,team?error=Ошибка сервера');
  }
});

router.post('/ru/panel,settings,team,reorder', panelMiddleware, async (req, res) => {
  const { user_ids } = req.body;
  const channelId = res.locals.panelChannel.id;

  if (!Array.isArray(user_ids)) {
    return res.status(400).json({ error: 'Invalid user IDs' });
  }

  try {
    const connection = await pool.getConnection();
    await connection.beginTransaction();
    for (let i = 0; i < user_ids.length; i++) {
      await connection.query(
        'UPDATE channel_team SET order_index = ? WHERE channel_id = ? AND user_id = ?',
        [i, channelId, user_ids[i]]
      );
    }
    await connection.commit();
    connection.release();

    const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
    logAction('team', req.session.user.username, 'Изменил порядок сортировки участников команды', userIp);

    res.json({ success: true });
  } catch (e) {
    console.error('Error reordering team:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/ru/panel,settings,team,transfer', panelMiddleware, async (req, res) => {
  if (res.locals.panelRole !== 'owner') {
    return res.status(403).send('Только владелец канала может передавать права.');
  }

  if (res.locals.panelChannel.is_personal) {
    return res.status(403).send('Передача владения личным телеканалом запрещена.');
  }

  const { target_user_id } = req.body;
  const channelId = res.locals.panelChannel.id;
  const oldOwnerId = req.session.user.id;

  if (!target_user_id) {
    return res.redirect('/ru/panel,settings,team?error=' + encodeURIComponent('Не выбран пользователь для передачи прав'));
  }

  try {
    const connection = await pool.getConnection();

    const [teamCheck] = await connection.query('SELECT user_id FROM channel_team WHERE channel_id = ? AND user_id = ?', [channelId, target_user_id]);
    if (teamCheck.length === 0) {
      connection.release();
      return res.redirect('/ru/panel,settings,team?error=' + encodeURIComponent('Пользователь должен быть членом команды канала'));
    }

    const token = crypto.randomBytes(32).toString('hex');

    await connection.query(
      'INSERT INTO pending_channel_transfers (channel_id, old_owner_id, new_owner_id, token) VALUES (?, ?, ?, ?)',
      [channelId, oldOwnerId, target_user_id, token]
    );

    const [ownerRows] = await connection.query('SELECT email, username FROM users WHERE id = ?', [oldOwnerId]);
    if (ownerRows.length === 0) {
      connection.release();
      return res.redirect('/ru/panel,settings,team?error=' + encodeURIComponent('Не удалось найти данные владельца'));
    }
    const ownerEmail = ownerRows[0].email;
    const ownerUsername = ownerRows[0].username;

    const appUrl = process.env.APP_URL || 'http://localhost:3001';
    const transferLink = `${appUrl}/channels/transfer/confirm?token=${token}`;
    await emailService.sendChannelTransferEmail(ownerEmail, ownerUsername, res.locals.panelChannel.name, transferLink);

    connection.release();
    res.redirect('/ru/panel,settings,team?success=' + encodeURIComponent('На вашу почту отправлено письмо для подтверждения передачи прав.'));
  } catch (e) {
    console.error('Error initiating transfer:', e);
    res.redirect('/ru/panel,settings,team?error=' + encodeURIComponent('Ошибка сервера при инициализации передачи прав.'));
  }
});

router.get('/ru/panel,announces', panelMiddleware, async (req, res) => {
  const channelId = res.locals.panelChannel.id;
  try {
    const [programs] = await pool.query('SELECT * FROM programs WHERE channel_id = ? ORDER BY start_time ASC', [channelId]);
    res.render('panel/announces', { activeMenu: 'announces', activeSubmenu: '', breadcrumbs: '<a href="/ru/panel,dashboard">Панель управления</a> &gt; Анонсы', programs });
  } catch (err) {
    console.error('Error fetching programs:', err);
    res.status(500).send('Database error');
  }
});

router.get('/ru/panel,news', panelMiddleware, async (req, res) => {
  const channelId = res.locals.panelChannel.id;
  try {
    const connection = await pool.getConnection();
    const [news] = await connection.query('SELECT * FROM channel_news WHERE channel_id = ? ORDER BY created_at DESC', [channelId]);
    connection.release();
    res.render('panel/news', { activeMenu: 'news', activeSubmenu: '', breadcrumbs: '<a href="/ru/panel,dashboard">Панель управления</a> &gt; Новости', newsList: news });
  } catch (e) {
    console.error('Error fetching news for panel:', e);
    res.status(500).send('Database error');
  }
});

router.post('/ru/panel,news,add', panelMiddleware, async (req, res) => {
  const { title, announce, content } = req.body;
  if (announce && announce.length > 100) {
    return res.redirect('/ru/panel,news?error=' + encodeURIComponent('Анонс не должен превышать 100 символов'));
  }
  if (content && content.length > 200) {
    return res.redirect('/ru/panel,news?error=' + encodeURIComponent('Полный текст не должен превышать 200 символов'));
  }
  const channelId = res.locals.panelChannel.id;
  try {
    const filteredTitle = req.session.user.staff_role ? title.trim() : await wordFilter.filter(title.trim());
    const filteredAnnounce = req.session.user.staff_role ? (announce ? announce.trim() : null) : await wordFilter.filter(announce ? announce.trim() : null);
    const filteredContent = req.session.user.staff_role ? (content ? content.trim() : null) : await wordFilter.filter(content ? content.trim() : null);

    const connection = await pool.getConnection();
    await connection.query('INSERT INTO channel_news (channel_id, title, announce, content, author_id) VALUES (?, ?, ?, ?, ?)',
      [channelId, filteredTitle, filteredAnnounce, filteredContent, req.session.user.id]);
    connection.release();
    const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
    logAction('team', req.session.user.username, `Добавил новость "${title.trim()}" на канал ${res.locals.panelChannel.shortname}`, userIp);
    res.redirect('/ru/panel,news?success=1');
  } catch (e) {
    console.error('Error adding channel news:', e);
    res.redirect('/ru/panel,news?error=Server Error');
  }
});

router.post('/ru/panel,news,delete/:id', panelMiddleware, async (req, res) => {
  const { id } = req.params;
  const channelId = res.locals.panelChannel.id;
  try {
    const connection = await pool.getConnection();
    await connection.query('DELETE FROM channel_news WHERE id = ? AND channel_id = ?', [id, channelId]);
    connection.release();
    const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
    logAction('team', req.session.user.username, `Удалил новость (ID: ${id}) с канала ${res.locals.panelChannel.shortname}`, userIp);
    res.redirect('/ru/panel,news?deleted=1');
  } catch (e) {
    console.error('Error deleting news:', e);
    res.redirect('/ru/panel,news?error=1');
  }
});

router.get('/ru/panel,stat,viewers', panelMiddleware, (req, res) => {
  res.render('panel/stat_viewers', { activeMenu: 'stat', activeSubmenu: 'viewers', breadcrumbs: '<a href="/ru/panel,dashboard">Панель управления</a> &gt; Статистика &gt; Одновременные зрители' });
});

router.get('/ru/panel,stat,audience', panelMiddleware, (req, res) => {
  res.render('panel/stat_audience', { activeMenu: 'stat', activeSubmenu: 'audience', breadcrumbs: '<a href="/ru/panel,dashboard">Панель управления</a> &gt; Статистика &gt; Аудитория' });
});

router.get('/ru/panel,stat,records', panelMiddleware, (req, res) => {
  res.render('panel/stat_records', { activeMenu: 'stat', activeSubmenu: 'records_stat', breadcrumbs: '<a href="/ru/panel,dashboard">Панель управления</a> &gt; Статистика &gt; Статистика всех записей' });
});

router.get('/ru/tv,studio', async (req, res) => {
  if (!req.session.user) return res.redirect('/login');

  const userId = req.session.user.id;
  const allowEveryone = res.locals.systemSettings && res.locals.systemSettings['allow_features_for_everyone'] === '1';
  try {
    const connection = await pool.getConnection();

    // 1. Get all channels owned by the user or where the user is a team member
    const [ownedChannels] = await connection.query("SELECT c.*, 'owner' as panel_role FROM channels c WHERE c.user_id = ? AND c.status IN ('active', 'banned')", [userId]);
    const [teamChannels] = await connection.query("SELECT c.*, t.is_editor, t.is_reporter, t.is_coowner FROM channels c JOIN channel_team t ON c.id = t.channel_id WHERE t.user_id = ? AND c.status IN ('active', 'banned') AND (t.is_editor = 1 OR t.is_reporter = 1 OR t.is_coowner = 1)", [userId]);

    let availableChannels = [...ownedChannels, ...teamChannels.map(c => {
      let role = 'reporter';
      if (c.is_coowner) role = 'coowner';
      else if (c.is_editor) role = 'editor';
      return { ...c, panel_role: role };
    })];

    const isStaff = req.session.user.staff_role && req.session.user.mask_mode !== 'user_mask';
    // If staff, load other channels if session.panel_channel_id exists
    if (isStaff && req.session.panel_channel_id) {
      const isAlreadyAvailable = availableChannels.some(c => c.id == req.session.panel_channel_id);
      if (!isAlreadyAvailable) {
        const [staffSelectedChannel] = await connection.query("SELECT c.*, 'owner' as panel_role FROM channels c WHERE c.id = ? AND c.status IN ('active', 'banned')", [req.session.panel_channel_id]);
        if (staffSelectedChannel.length > 0) {
          availableChannels.push(staffSelectedChannel[0]);
        }
      }
    }

    connection.release();

    if (availableChannels.length === 0) {
      return res.render('panel/studio_select', { availableChannels: [], error: 'У вас нет телеканалов для вещания.', allowEveryone });
    }

    // 2. Determine target channel
    let selectedChannelId = req.query.channel_id || req.session.panel_channel_id;
    let selectedChannel = availableChannels.find(c => c.id == selectedChannelId);

    if (selectedChannelId && selectedChannel) {
      req.session.panel_channel_id = selectedChannel.id;
    }

    if (!selectedChannel) {
      return res.render('panel/studio_select', { availableChannels, error: null, allowEveryone });
    }

    if (!selectedChannel.is_premium && !allowEveryone) {
      return res.render('panel/studio_select', { 
        availableChannels, 
        error: `Телеканал "${selectedChannel.name}" не имеет активного Premium статуса. Эфирная студия доступна только для премиум-каналов.`,
        allowEveryone
      });
    }

    req.session.panel_channel_id = selectedChannel.id;

    let [keys] = await pool.query('SELECT stream_key FROM stream_keys WHERE channel_id = ? AND user_id = ?', [selectedChannel.id, userId]);
    let streamKey = '';
    if (keys.length === 0) {
      streamKey = 'sk_live_' + crypto.randomBytes(16).toString('hex');
      await pool.query('INSERT INTO stream_keys (channel_id, user_id, stream_key) VALUES (?, ?, ?)', [selectedChannel.id, userId, streamKey]);
    } else {
      streamKey = keys[0].stream_key;
    }

    const [records] = await pool.query(
      'SELECT id, title, video_url, hls_url, duration, thumbnail_url FROM records WHERE channel_id = ? AND hls_url IS NOT NULL ORDER BY created_at DESC',
      [selectedChannel.id]
    );

    res.render('panel/studio', {
      activeMenu: 'studio',
      activeSubmenu: '',
      panelChannel: selectedChannel,
      panelRole: selectedChannel.panel_role,
      records,
      streamKey,
      breadcrumbs: '<a href="/ru/panel,dashboard">Панель управления</a> &gt; Эфирная студия'
    });
  } catch (e) {
    console.error('Error rendering Broadcast Studio:', e);
    res.status(500).send('Server Error');
  }
});

module.exports = router;
