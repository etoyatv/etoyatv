// Panel albums and autopilot management
const express = require('express');
const router = express.Router();
const { pool } = require('../../../config/db');
const { panelMiddleware } = require('../../../middlewares/panel');

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
      breadcrumbs: '<a href="/panel,dashboard">Панель управления</a> &gt; <a href="/panel,records">Медиа-архив</a> &gt; Альбомы',
      albums,
      currentPage: page,
      totalPages: totalPages
    });
  } catch (e) {
    console.error(e);
    res.status(500).send('Server Error');
  }
});

router.post('/ru/panel,albums,bulk_delete', panelMiddleware, async (req, res) => {
  try {
    const channelId = res.locals.panelChannel.id;
    let albumIds = req.body.album_ids;
    if (!albumIds) {
      return res.redirect('/panel,albums');
    }
    if (!Array.isArray(albumIds)) {
      albumIds = [albumIds];
    }
    if (albumIds.length > 0) {
      await pool.query('DELETE FROM albums WHERE id IN (?) AND channel_id = ?', [albumIds, channelId]);
    }

    res.redirect('/panel,albums');
  } catch (e) {
    console.error('Error bulk deleting albums:', e);
    res.status(500).send('Server Error');
  }
});

router.get('/ru/panel,albums,create', panelMiddleware, (req, res) => {
  res.render('panel/albums_create', {
    activeMenu: 'records',
    activeSubmenu: 'albums',
    breadcrumbs: '<a href="/panel,dashboard">Панель управления</a> &gt; <a href="/panel,albums">Альбомы</a> &gt; Создать альбом'
  });
});

router.post('/ru/panel,albums,create', panelMiddleware, async (req, res) => {
  try {
    const channelId = res.locals.panelChannel.id;
    const { title, description } = req.body;
    if (!title) {
      return res.redirect('/panel,albums,create?error=' + encodeURIComponent('Название обязательно'));
    }
    await pool.query('INSERT INTO albums (channel_id, title, description) VALUES (?, ?, ?)', [channelId, title, description || '']);
    res.redirect('/panel,albums');
  } catch (e) {
    console.error(e);
    res.status(500).send('Server Error');
  }
});

router.get('/ru/panel,albums,edit', panelMiddleware, async (req, res) => {
  try {
    const channelId = res.locals.panelChannel.id;
    const albumId = req.query.id;
    if (!albumId) return res.redirect('/panel,albums');

    const [albums] = await pool.query('SELECT * FROM albums WHERE id = ? AND channel_id = ?', [albumId, channelId]);
    if (albums.length === 0) return res.redirect('/panel,albums');
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
      breadcrumbs: `<a href="/panel,dashboard">Панель управления</a> &gt; <a href="/panel,albums">Альбомы</a> &gt; Редактирование: ${album.title}`,
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
    if (!id || !title) return res.redirect('/panel,albums');

    await pool.query('UPDATE albums SET title = ?, description = ? WHERE id = ? AND channel_id = ?', [title, description || '', id, channelId]);
    res.redirect('/panel,albums,edit?id=' + id);
  } catch (e) {
    console.error(e);
    res.status(500).send('Server Error');
  }
});

router.post('/ru/panel,albums,delete', panelMiddleware, async (req, res) => {
  try {
    const channelId = res.locals.panelChannel.id;
    const { id } = req.body;
    if (!id) return res.redirect('/panel,albums');

    await pool.query('DELETE FROM album_records WHERE album_id = ?', [id]);
    await pool.query('DELETE FROM albums WHERE id = ? AND channel_id = ?', [id, channelId]);

    res.redirect('/panel,albums');
  } catch (e) {
    console.error(e);
    res.status(500).send('Server Error');
  }
});

router.post('/ru/panel,albums,add_record', panelMiddleware, async (req, res) => {
  try {
    const channelId = res.locals.panelChannel.id;
    const { album_id, record_id } = req.body;
    if (!album_id || !record_id) return res.redirect('/panel,albums');

    const [albums] = await pool.query('SELECT id FROM albums WHERE id = ? AND channel_id = ?', [album_id, channelId]);
    const [records] = await pool.query('SELECT id, is_18_plus FROM records WHERE id = ? AND channel_id = ?', [record_id, channelId]);

    if (albums.length > 0 && records.length > 0) {
      if (records[0].is_18_plus) {
        return res.redirect('/panel,albums,edit?id=' + album_id + '&error=' + encodeURIComponent('Нельзя добавлять 18+ контент в альбомы!'));
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

    res.redirect('/panel,albums,edit?id=' + album_id);
  } catch (e) {
    console.error(e);
    res.status(500).send('Server Error');
  }
});

router.post('/ru/panel,albums,remove_record', panelMiddleware, async (req, res) => {
  try {
    const channelId = res.locals.panelChannel.id;
    const { album_id, album_record_id } = req.body;
    if (!album_id || !album_record_id) return res.redirect('/panel,albums');

    const [albums] = await pool.query('SELECT id FROM albums WHERE id = ? AND channel_id = ?', [album_id, channelId]);
    if (albums.length > 0) {
      await pool.query('DELETE FROM album_records WHERE id = ? AND album_id = ?', [album_record_id, album_id]);

      await pool.query('UPDATE channels SET autopilot_start_time = NOW() WHERE autopilot_album_id = ? AND autopilot_enabled = 1', [album_id]);
      const [channelsUsing] = await pool.query('SELECT id FROM channels WHERE autopilot_album_id = ? AND autopilot_enabled = 1', [album_id]);
      for (const ch of channelsUsing) {
        req.app.get('io').to(`channel_${ch.id}`).emit('autopilot_update');
      }
    }

    res.redirect('/panel,albums,edit?id=' + album_id);
  } catch (e) {
    console.error(e);
    res.status(500).send('Server Error');
  }
});

router.post('/ru/panel,albums,move_record', panelMiddleware, async (req, res) => {
  try {
    const channelId = res.locals.panelChannel.id;
    const { album_id, album_record_id, direction } = req.body;
    if (!album_id || !album_record_id || !direction) return res.redirect('/panel,albums');

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

    res.redirect('/panel,albums,edit?id=' + album_id);
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
      breadcrumbs: '<a href="/panel,dashboard">Панель управления</a> &gt; Автопилот',
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
      return res.redirect('/panel,autopilot?error=Автопилот запрещен администрацией');
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

    res.redirect('/panel,autopilot?success=1');
  } catch (e) {
    console.error(e);
    res.status(500).send('Server Error');
  }
});

module.exports = router;
