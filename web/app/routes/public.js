const express = require('express');
const router = express.Router();
const { pool } = require('../../config/db');
const bcrypt = require('bcrypt');
const fs = require('fs');
const path = require('path');
const emailService = require('../../emailService');
const { requireAuth } = require('../../middlewares/auth');
const { panelMiddleware, recordUploadMiddleware, designUploadMiddleware } = require('../../middlewares/panel');

router.get('/', async (req, res) => {
  let hasChannel = false;
  let totalChannels = 0;
  let liveChannels = 0;
  let totalViewers = 0;
  let totalRecords = 0;
  let latestNews = [];
  let popularChannels = [];
  let newsCount = 0;

  try {
    const connection = await pool.getConnection();

    if (req.session.user) {
      const [channelsData] = await connection.query("SELECT id FROM channels WHERE user_id = ? AND status IN ('active', 'banned') LIMIT 1", [req.session.user.id]);
      if (channelsData.length > 0) hasChannel = true;
    }

    const [chRows] = await connection.query("SELECT COUNT(*) as count FROM channels WHERE status = 'active'");
    totalChannels = chRows[0].count;

    const [liveRows] = await connection.query("SELECT COUNT(*) as count, SUM(viewers) as vCount FROM channels WHERE is_live = TRUE AND status = 'active'");
    liveChannels = liveRows[0].count || 0;
    totalViewers = liveRows[0].vCount || 0;

    const [recRows] = await connection.query('SELECT COUNT(*) as count FROM records');
    totalRecords = recRows[0].count;

    try {
      const [popRows] = await connection.query(`
        SELECT c.*, u.username 
        FROM channels c 
        JOIN users u ON c.user_id = u.id 
        WHERE c.status = 'active' AND c.access_level != 'private' AND (c.is_live = 1 OR c.autopilot_enabled = 1)
        ORDER BY c.viewers DESC 
        LIMIT 10
      `);
      popularChannels = popRows;
    } catch (e) { console.error('Failed to fetch popular channels', e); }


    try {
      const [serviceRows] = await connection.query("SELECT setting_value FROM system_settings WHERE setting_key = 'service_channel_id'");
      if (serviceRows.length > 0 && serviceRows[0].setting_value) {
        const serviceChannelId = parseInt(serviceRows[0].setting_value);
        const [newsRows] = await connection.query(`
          SELECT n.id, n.title, n.announce, n.created_at, c.shortname 
          FROM channel_news n
          JOIN channels c ON n.channel_id = c.id
          WHERE n.channel_id = ? AND n.is_hidden = 0 
          ORDER BY n.created_at DESC LIMIT 5
        `, [serviceChannelId]);
        latestNews = newsRows.map(n => ({ ...n, is_channel_news: true }));
        const [newsCountRows] = await connection.query('SELECT COUNT(*) as count FROM channel_news WHERE channel_id = ? AND is_hidden = 0', [serviceChannelId]);
        newsCount = newsCountRows[0].count;
      } else {
        const [newsRows] = await connection.query('SELECT * FROM news ORDER BY created_at DESC LIMIT 5');
        latestNews = newsRows;
        const [newsCountRows] = await connection.query('SELECT COUNT(*) as count FROM news');
        newsCount = newsCountRows[0].count;
      }
    } catch (err) { console.error('Failed to fetch news', err); }


    connection.release();
  } catch (e) {
    console.error('Error fetching homepage stats:', e);
  }
  res.render('index', { pageTitle: 'Телевидение | ЭтоЯTV - Я есть телевидение!', hasChannel, totalChannels, liveChannels, totalViewers, totalRecords, latestNews, newsCount, popularChannels });
});

router.get('/ru/news,view,:id', async (req, res) => {
  try {
    const connection = await pool.getConnection();
    const [newsRows] = await connection.query('SELECT * FROM news WHERE id = ?', [req.params.id]);
    connection.release();

    if (newsRows.length === 0) {
      return res.status(404).render('404', { pageTitle: 'Новость не найдена | ЭтоЯTV' });
    }

    res.render('news_view', { pageTitle: newsRows[0].title + ' | ЭтоЯTV - Я есть телевидение!', newsItem: newsRows[0], channelName: 'ЭтоЯTV' });
  } catch (e) {
    console.error('Error fetching news item:', e);
    res.status(500).send('Database error');
  }
});

router.get('/ru/news', async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const perPage = 5;
  const offset = (page - 1) * perPage;
  const cat = req.query.cat;
  const itemId = req.query.item;

  try {
    const connection = await pool.getConnection();

    let countRows, news, channelName = 'ЭтоЯTV', shortname = null, channelObj = null, ownerObj = null;
    if (cat === 'channel' && itemId) {
      const [channelRows] = await connection.query('SELECT c.*, u.username as owner_username FROM channels c JOIN users u ON c.user_id = u.id WHERE c.id = ?', [itemId]);
      if (channelRows.length > 0) {
        channelName = channelRows[0].name;
        shortname = channelRows[0].shortname;
        channelObj = channelRows[0];
        ownerObj = { username: channelRows[0].owner_username };
      }

      let canSeeHiddenNews = false;
      if (req.session && req.session.user) {
        if (req.session.user.id === channelRows[0].user_id) canSeeHiddenNews = true;
        if (['admin', 'moderator', 'mod'].includes(req.session.user.staff_role)) canSeeHiddenNews = true;
        if (req.session.user.role === 'admin') canSeeHiddenNews = true;
      }
      const hiddenCondition = canSeeHiddenNews ? '' : ' AND is_hidden = 0';

      [countRows] = await connection.query(`SELECT COUNT(*) as count FROM channel_news WHERE channel_id = ?${hiddenCondition}`, [itemId]);
      [news] = await connection.query(`SELECT * FROM channel_news WHERE channel_id = ?${hiddenCondition} ORDER BY created_at DESC LIMIT ? OFFSET ?`, [itemId, perPage, offset]);

      // Map properties so the news.ejs template handles them the same way
      news = news.map(n => ({ ...n, content: n.announce }));
    } else {
      const [serviceRows] = await connection.query("SELECT setting_value FROM system_settings WHERE setting_key = 'service_channel_id'");
      if (serviceRows.length > 0 && serviceRows[0].setting_value) {
        const serviceChannelId = parseInt(serviceRows[0].setting_value);
        [countRows] = await connection.query('SELECT COUNT(*) as count FROM channel_news WHERE channel_id = ? AND is_hidden = 0', [serviceChannelId]);
        [news] = await connection.query(`
          SELECT n.id, n.title, n.announce, n.created_at, c.shortname 
          FROM channel_news n
          JOIN channels c ON n.channel_id = c.id
          WHERE n.channel_id = ? AND n.is_hidden = 0 
          ORDER BY n.created_at DESC LIMIT ? OFFSET ?
        `, [serviceChannelId, perPage, offset]);
        news = news.map(n => ({ ...n, is_channel_news: true }));
      } else {
        [countRows] = await connection.query('SELECT COUNT(*) as count FROM news');
        [news] = await connection.query('SELECT * FROM news ORDER BY created_at DESC LIMIT ? OFFSET ?', [perPage, offset]);
      }
    }

    const totalItems = countRows[0].count;
    const totalPages = Math.ceil(totalItems / perPage);

    connection.release();
    res.render('news', { pageTitle: `Новости ${cat === 'channel' ? 'телеканала ' + channelName : 'проекта ЭтоЯTV'} | ЭтоЯTV`, news, page, totalPages, channelName, cat, itemId, shortname, channel: channelObj, owner: ownerObj, activePage: 'news' });
  } catch (e) {
    console.error('Error fetching news:', e);
    res.status(500).send('Database error');
  }
});

router.get('/ru/eula', (req, res) => {
  res.render('eula', { pageTitle: 'Пользовательское соглашение | ЭтоЯTV' });
});

router.get('/ru/channel_eula', (req, res) => {
  res.render('channel_eula', { pageTitle: 'Соглашение для владельцев телеканалов | ЭтоЯTV' });
});

router.get('/ru/rules', (req, res) => {
  res.render('rules', { pageTitle: 'Правила размещения материалов на сайте | ЭтоЯTV' });
});

router.get('/ru/about', (req, res) => {
  res.render('about', { pageTitle: 'О проекте ЭтоЯTV' });
});

router.get('/ru/feedback', (req, res) => {
  res.render('feedback', { pageTitle: 'Контакты | ЭтоЯTV' });
});

module.exports = router;

