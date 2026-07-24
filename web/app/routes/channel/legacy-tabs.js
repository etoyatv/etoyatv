// Legacy tab-style channel sub-pages: news item, channel,records, channel,programs, channel,friends
const express = require('express');
const router = express.Router();
const { pool } = require('../../../config/db');

router.get('/channels/:shortname/news/:id', async (req, res) => {
  try {
    const connection = await pool.getConnection();
    const [channelRows] = await connection.query('SELECT id, name, user_id FROM channels WHERE shortname = ?', [req.params.shortname]);
    if (channelRows.length === 0) {
      connection.release();
      return res.status(404).render('404', { pageTitle: 'Канал не найден | ЭтоЯTV' });
    }

    let canSeeHiddenNews = false;
    if (req.session && req.session.user) {
      if (req.session.user.id === channelRows[0].user_id) canSeeHiddenNews = true;
      if (['admin', 'moderator', 'mod'].includes(req.session.user.staff_role)) canSeeHiddenNews = true;
      if (req.session.user.role === 'admin') canSeeHiddenNews = true;
    }

    const newsCondition = canSeeHiddenNews ? '' : ' AND is_hidden = 0';
    const [newsRows] = await connection.query(`SELECT * FROM channel_news WHERE id = ? AND channel_id = ?${newsCondition}`, [req.params.id, channelRows[0].id]);
    connection.release();

    if (newsRows.length === 0) {
      return res.status(404).render('404', { pageTitle: 'Новость не найдена | ЭтоЯTV' });
    }

    res.render('news_view', { pageTitle: newsRows[0].title + ' | ЭтоЯTV - Я есть телевидение!', newsItem: newsRows[0], channelName: channelRows[0].name });
  } catch (e) {
    console.error('Error fetching channel news item:', e);
    res.status(500).send('Database error');
  }
});

router.get('/ru/channel,programs', async (req, res) => {
  const shortname = req.query.shortname;
  if (!shortname) return res.redirect('/');
  try {
    const connection = await pool.getConnection();
    const [chRows] = await connection.query(`
      SELECT c.*, u.username as owner_username 
      FROM channels c 
      JOIN users u ON c.user_id = u.id 
      WHERE c.shortname = ?
    `, [shortname]);
    if (chRows.length === 0) {
      connection.release();
      return res.status(404).send('Channel not found');
    }
    if (chRows[0].status === 'deleted' || chRows[0].status === 'banned') {
      connection.release();
      const isAdminOrMod = req.session.user && ['admin', 'moderator', 'mod'].includes(req.session.user.staff_role);
      if (!isAdminOrMod) return res.status(403).render('deleted_channel', { pageTitle: 'Канал удален | ЭтоЯTV', channel: chRows[0] });
    }
    const channel = chRows[0];
    const limit = 5;
    const page = parseInt(req.query.page) || 1;

    let dbLimit = limit;
    let dbOffset = (page - 1) * limit;

    if (channel.is_live) {
      if (page === 1) {
        dbLimit = limit - 1;
        dbOffset = 0;
      } else {
        dbLimit = limit;
        dbOffset = (page - 1) * limit - 1;
      }
    }

    const [countRows] = await connection.query(`
      SELECT COUNT(*) as count FROM programs WHERE channel_id = ? AND start_time >= NOW() - INTERVAL 2 HOUR AND (is_hidden = 0 OR is_hidden IS NULL)
    `, [channel.id]);
    
    const totalDisplayItems = countRows[0].count + (channel.is_live ? 1 : 0);
    const totalPages = Math.ceil(totalDisplayItems / limit);

    const query = `
      SELECT p.*, 
             (SELECT COUNT(*) FROM personal_schedules ps WHERE ps.program_id = p.id) as bookmarks_count
             ${req.session.user ? `, (SELECT COUNT(*) FROM personal_schedules ps WHERE ps.program_id = p.id AND ps.user_id = ${Number(req.session.user.id)}) > 0 as is_bookmarked` : ', 0 as is_bookmarked'}
      FROM programs p
      WHERE p.channel_id = ? AND p.start_time >= NOW() - INTERVAL 2 HOUR AND (p.is_hidden = 0 OR p.is_hidden IS NULL)
      ORDER BY p.start_time ASC
      LIMIT ? OFFSET ?
    `;
    const [progRows] = await connection.query(query, [channel.id, dbLimit, dbOffset]);
    connection.release();

    res.render('channel_programs', {
      pageTitle: `Расписание телеканала ${channel.name} | ЭтоЯTV`,
      channel: channel,
      owner: { username: channel.owner_username },
      programs: progRows,
      user: req.session.user,
      page: page,
      totalPages: totalPages
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Database error');
  }
});

router.get('/ru/channel,records', async (req, res, next) => {
  const shortname = req.query.shortname;
  if (!shortname) return next();

  try {
    const [channels] = await pool.query('SELECT c.*, u.username as owner_username FROM channels c JOIN users u ON c.user_id = u.id WHERE c.shortname = ?', [shortname]);
    if (channels.length === 0) return next();
    if (channels[0].status === 'deleted' || channels[0].status === 'banned') {
      const isAdminOrMod = req.session.user && ['admin', 'moderator', 'mod'].includes(req.session.user.staff_role);
      if (!isAdminOrMod) return res.status(403).render('deleted_channel', { pageTitle: 'Канал удален | ЭтоЯTV', channel: channels[0] });
    }
    const channel = channels[0];
    const owner = { username: channel.owner_username };

    const isOwnerOrStaff = req.session.user && (req.session.user.id === channel.user_id || ['admin', 'moderator'].includes(req.session.user.staff_role));
    const accessFilter = isOwnerOrStaff ? '' : " AND access_level = 'public'";

    const [records] = await pool.query(`
      SELECT id, title, duration, views, thumbnail_url, created_at, is_18_plus,
             (SELECT COUNT(*) FROM record_favorites rf WHERE rf.record_id = records.id) as fans_count
             ${req.session.user ? `, (SELECT COUNT(*) FROM record_favorites rf WHERE rf.record_id = records.id AND rf.user_id = ${Number(req.session.user.id)}) > 0 as is_fan` : ', 0 as is_fan'}
      FROM records 
      WHERE channel_id = ? AND status NOT IN ('deleted', 'banned')${accessFilter}
      ORDER BY created_at DESC
    `, [channel.id]);

    res.render('channel_records', {
      pageTitle: 'Записи телеканала ' + channel.name + ' | ЭтоЯTV',
      channel,
      owner,
      records,
      user: req.session.user
    });
  } catch (e) {
    console.error(e);
    res.status(500).send('Server Error');
  }
});

router.get('/ru/channel,programs', async (req, res, next) => {
  const shortname = req.query.shortname;
  if (!shortname) return next();

  try {
    const [channels] = await pool.query('SELECT c.*, u.username as owner_username FROM channels c JOIN users u ON c.user_id = u.id WHERE c.shortname = ?', [shortname]);
    if (channels.length === 0) return next();
    if (channels[0].status === 'deleted' || channels[0].status === 'banned') {
      const isAdminOrMod = req.session.user && ['admin', 'moderator', 'mod'].includes(req.session.user.staff_role);
      if (!isAdminOrMod) return res.status(403).render('deleted_channel', { pageTitle: 'Канал удален | ЭтоЯTV', channel: channels[0] });
    }
    const channel = channels[0];
    const owner = { username: channel.owner_username };

    const page = parseInt(req.query.page) || 1;
    const limit = 10;
    const offset = (page - 1) * limit;

    const [countRows] = await pool.query('SELECT COUNT(*) as cnt FROM programs WHERE channel_id = ? AND start_time >= NOW() - INTERVAL 2 HOUR AND (is_hidden = 0 OR is_hidden IS NULL)', [channel.id]);
    const totalProgramsCount = countRows[0].cnt;
    const totalPages = Math.ceil(totalProgramsCount / limit) || 1;

    const query = `
      SELECT p.*, 
             (SELECT COUNT(*) FROM personal_schedules ps WHERE ps.program_id = p.id) as bookmarks_count
             ${req.session.user ? `, (SELECT COUNT(*) FROM personal_schedules ps WHERE ps.program_id = p.id AND ps.user_id = ${Number(req.session.user.id)}) > 0 as is_bookmarked` : ', 0 as is_bookmarked'}
      FROM programs p
      WHERE p.channel_id = ? AND p.start_time >= NOW() - INTERVAL 2 HOUR AND (p.is_hidden = 0 OR p.is_hidden IS NULL)
      ORDER BY p.start_time ASC
      LIMIT ? OFFSET ?
    `;
    const [programs] = await pool.query(query, [channel.id, limit, offset]);

    res.render('channel_programs', {
      pageTitle: 'Расписание телеканала ' + channel.name + ' | ЭтоЯTV',
      channel,
      owner,
      programs,
      user: req.session.user,
      page,
      totalPages
    });
  } catch (e) {
    console.error(e);
    res.status(500).send('Server Error');
  }
});

router.get('/ru/channel,friends', async (req, res, next) => {
  const shortname = req.query.shortname;
  if (!shortname) return next();

  try {
    const [channels] = await pool.query('SELECT c.*, u.username FROM channels c JOIN users u ON c.user_id = u.id WHERE c.shortname = ?', [shortname]);

    if (channels.length === 0) {
      return next();
    }
    if (channels[0].status === 'deleted' || channels[0].status === 'banned') {
      const isAdminOrMod = req.session.user && ['admin', 'moderator', 'mod'].includes(req.session.user.staff_role);
      if (!isAdminOrMod) return res.status(403).render('deleted_channel', { pageTitle: 'Канал удален | ЭтоЯTV', channel: channels[0] });
    }

    const channelId = channels[0].id;
    const [fans] = await pool.query(`
      SELECT f.user_id, u.username, u.avatar, u.last_active 
      FROM channel_fans f 
      JOIN users u ON f.user_id = u.id 
      WHERE f.channel_id = ? 
      ORDER BY f.created_at DESC
    `, [channelId]);

    res.render('channel_friends', {
      pageTitle: 'Фанаты телеканала ' + channels[0].name + ' | ЭтоЯTV',
      channel: channels[0],
      owner: { username: channels[0].username },
      fans
    });
  } catch (e) {
    console.error('Error fetching friends:', e);
    next();
  }
});

module.exports = router;
