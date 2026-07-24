// Panel settings: broadcast, design, channel, access, moderation, team
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { pool } = require('../../../config/db');
const path = require('path');
const emailService = require('../../../emailService');
const { panelMiddleware, designUploadMiddleware } = require('../../../middlewares/panel');
const { logAction } = require('../../../utils/logger');
const wordFilter = require('../../../utils/wordFilter');
const { deletePublicFileIfExists } = require('../../../utils/safePath');

// ─── Channel Delete ────────────────────────────────────────────────────────────

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
    const rtmpAuth = { username: process.env.RTMP_API_USER, password: process.env.RTMP_API_PASS };
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

// ─── Broadcast ────────────────────────────────────────────────────────────────

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
      breadcrumbs: '<a href="/panel,dashboard">Панель управления</a> &gt; Настройки &gt; Трансляция'
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
    
    const shortname = res.locals.panelChannel.shortname;
    setTimeout(async () => {
      try {
        const { kickStream } = require('../../../utils/mediaServer');
        await kickStream(shortname);
        console.log(`[MediaMTX] Kicked all streams for ${shortname} 15s after key reset`);
      } catch (err) {
        console.error('[MediaMTX API] Error dropping stream after reset:', err.message);
      }
    }, 15000);
    
    res.redirect('/panel,settings,broadcast?reset=1');
  } catch (e) {
    console.error('Error resetting stream key:', e);
    res.status(500).send('Database error');
  }
});

router.post('/ru/panel,settings,broadcast,update_streams', panelMiddleware, async (req, res) => {
  const channelId = res.locals.panelChannel.id;
  const isPremium = res.locals.panelChannel.is_premium;
  const isVerified = res.locals.panelChannel.is_verified;
  const allowEveryone = res.locals.systemSettings && res.locals.systemSettings['allow_multistream_for_everyone'] === '1';
  
  if (!isPremium && !isVerified && !allowEveryone) {
    return res.status(403).send('Forbidden: Multi-stream is only available for Premium or Verified channels');
  }
  
  let maxStreams = parseInt(req.body.max_streams, 10) || 1;
  if (maxStreams < 1) maxStreams = 1;
  if (maxStreams > 3) maxStreams = 3;
  
  try {
    await pool.query('UPDATE channels SET max_streams = ? WHERE id = ?', [maxStreams, channelId]);
    res.redirect('/panel,settings,broadcast?success=1');
  } catch (e) {
    console.error('Error updating max streams:', e);
    res.status(500).send('Database error');
  }
});

// ─── Design ───────────────────────────────────────────────────────────────────

router.get('/ru/panel,settings,design', panelMiddleware, (req, res) => {
  res.render('panel/design', { activeMenu: 'settings', activeSubmenu: 'design', breadcrumbs: '<a href="/panel,dashboard">Панель управления</a> &gt; Настройки &gt; Дизайн' });
});

router.post('/ru/panel,settings,design', panelMiddleware, designUploadMiddleware, async (req, res) => {
  if (res.locals.panelChannel.design_disabled) {
    return res.redirect('/panel,settings,design?error=Изменение дизайна запрещено администрацией');
  }
  const { 
    bg_color, 
    text_color, 
    player_bg_color, 
    player_menu_color, 
    player_link_color, 
    player_bg_fit,
    bg_fit,
    logo_fit,
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
      deletePublicFileIfExists(url, path.join(__dirname, '../../../public'));
    }
  };

  if (bg_color) { updates.push('bg_color = ?'); params.push(bg_color); }
  if (text_color) { updates.push('text_color = ?'); params.push(text_color); }
  if (player_bg_color !== undefined) { updates.push('player_bg_color = ?'); params.push(player_bg_color || null); }
  if (player_menu_color !== undefined) { updates.push('player_menu_color = ?'); params.push(player_menu_color || null); }
  if (player_link_color !== undefined) { updates.push('player_link_color = ?'); params.push(player_link_color || null); }
  if (player_bg_fit !== undefined) { updates.push('player_bg_fit = ?'); params.push(player_bg_fit || 'stretch'); }
  if (bg_fit !== undefined) { updates.push('bg_fit = ?'); params.push(bg_fit || 'stretch'); }
  if (logo_fit !== undefined) { updates.push('logo_fit = ?'); params.push(logo_fit || 'cover'); }

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
      return res.redirect('/panel,settings,design?error=Server error');
    }
  }

  if (updates.length > 0) {
    const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
    logAction('team', req.session.user.username, 'Обновил оформление телеканала', userIp);
  }

  res.redirect('/panel,settings,design?success=1');
});

// ─── Channel settings ─────────────────────────────────────────────────────────

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
    console.error('Error in GET /panel,settings,channel:', e);
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
    return res.redirect('/panel,settings,channel?error=' + encodeURIComponent('Этот канал уже является кооперативным.'));
  }

  try {
    const connection = await pool.getConnection();
    const [cooperativeChannels] = await connection.query(
      "SELECT id FROM channels WHERE user_id = ? AND is_personal = FALSE AND status IN ('active', 'banned')",
      [req.session.user.id]
    );
    if (cooperativeChannels.length >= 3) {
      connection.release();
      return res.redirect('/panel,settings,channel?error=' + encodeURIComponent('Вы не можете иметь более 3 кооперативных каналов.'));
    }

    await connection.query('UPDATE channels SET is_personal = FALSE WHERE id = ?', [res.locals.panelChannel.id]);
    
    const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
    logAction('team', req.session.user.username, `Преобразовал телеканал ${res.locals.panelChannel.shortname} в кооперативный`, userIp);

    connection.release();
    res.redirect('/panel,settings,channel?success=1');
  } catch (e) {
    console.error('Error making channel cooperative:', e);
    res.redirect('/panel,settings,channel?error=' + encodeURIComponent('Ошибка базы данных.'));
  }
});

router.post('/ru/panel,settings,channel', panelMiddleware, async (req, res) => {
  if (res.locals.panelRole === 'reporter') {
    return res.status(403).send('У вас нет прав на редактирование настроек канала.');
  }

  const { name, description, shortname, hide_live_badge } = req.body;
  const channelId = res.locals.panelChannel.id;
  const hideLiveBadge = hide_live_badge === '1' ? 1 : 0;

  if (name && name.length > 77) {
    return res.redirect('/panel,settings,channel?error=' + encodeURIComponent('Название телеканала не должно превышать 77 символов.'));
  }

  if (description && description.length > 200) {
    return res.redirect('/panel,settings,channel?error=' + encodeURIComponent('Описание не может быть больше 200 символов.'));
  }
  
  if (shortname) {
    const restrictedSlugs = ['login', 'register', 'api', 'news', 'account', 'channels', 'admin', 'panel', 'tv', 'channel', 'messages', 'eula', 'channel_eula', 'rules', 'about', 'feedback', 'speedtest'];
    if (restrictedSlugs.includes(shortname.toLowerCase())) {
      return res.redirect('/panel,settings,channel?error=' + encodeURIComponent('Это короткое имя недоступно.'));
    }

    const slugRegex = /^[a-zA-Z0-9_-]+$/;
    if (!slugRegex.test(shortname)) {
      return res.redirect('/panel,settings,channel?error=' + encodeURIComponent('Короткое имя может содержать только латинские буквы, цифры, дефис и подчеркивание.'));
    }

    if (!req.session.user.staff_role && await wordFilter.containsBadWords(shortname)) {
      return res.redirect('/panel,settings,channel?error=' + encodeURIComponent('Данный URL адрес нельзя назвать.'));
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
            return res.redirect('/panel,settings,channel?error=' + encodeURIComponent('Изменять URL можно только раз в неделю. Следующее изменение будет доступно: ' + nextAvailableDate.toLocaleDateString('ru-RU')));
          }
        }
        // Check if shortname is unique
        const [existing] = await connection.query('SELECT id FROM channels WHERE shortname = ? AND id != ?', [shortname, channelId]);
        if (existing.length > 0) {
          connection.release();
          return res.redirect('/panel,settings,channel?error=' + encodeURIComponent('Короткое имя уже занято.'));
        }
        await connection.query('UPDATE channels SET name = ?, description = ?, shortname = ?, shortname_changed_at = NOW(), hide_live_badge = ? WHERE id = ?',
          [filteredName, filteredDescription, shortname.trim().toLowerCase(), hideLiveBadge, channelId]);
      } else {
        await connection.query('UPDATE channels SET name = ?, description = ?, hide_live_badge = ? WHERE id = ?',
          [filteredName, filteredDescription, hideLiveBadge, channelId]);
      }
    } else {
      await connection.query('UPDATE channels SET name = ?, description = ?, hide_live_badge = ? WHERE id = ?',
        [filteredName, filteredDescription, hideLiveBadge, channelId]);
    }
    const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
    if (res.locals.panelRole === 'owner' && shortname && shortname !== res.locals.panelChannel.shortname) {
      logAction('team', req.session.user.username, `Изменил настройки телеканала (в т.ч. URL с ${res.locals.panelChannel.shortname} на ${shortname.trim().toLowerCase()})`, userIp);
    } else {
      logAction('team', req.session.user.username, 'Изменил настройки телеканала', userIp);
    }

    const io = req.app.get('io');
    if (io) {
      io.to(`channel_${channelId}`).emit('live_badge_toggled', hideLiveBadge === 1);
    }
    
    connection.release();
    res.redirect('/panel,settings,channel?success=1');
  } catch (e) {
    console.error('Error updating channel:', e);
    res.redirect('/panel,settings,channel?error=' + encodeURIComponent('Ошибка базы данных.'));
  }
});

// ─── Access ───────────────────────────────────────────────────────────────────

router.get('/ru/panel,settings,access', panelMiddleware, (req, res) => {
  res.render('panel/access', { activeMenu: 'settings', activeSubmenu: 'access', breadcrumbs: '<a href="/panel,dashboard">Панель управления</a> &gt; Настройки &gt; Доступ' });
});

router.post('/ru/panel,settings,access', panelMiddleware, async (req, res) => {
  if (!['owner', 'coowner'].includes(res.locals.panelRole)) {
    return res.status(403).send('У вас нет прав на редактирование этих настроек.');
  }

  const channelId = res.locals.panelChannel.id;
  const { access_level, password, is_18_plus } = req.body;
  const is18Plus = is_18_plus === 'on' ? 1 : 0;
  const { hashChannelPassword } = require('../../../utils/channelPassword');

  try {
    const level = access_level === 'password' ? 'password' : 'public';
    let passwordValue = '';
    if (level === 'password') {
      if (password && String(password).trim()) {
        passwordValue = await hashChannelPassword(String(password).trim());
      } else if (res.locals.panelChannel.password) {
        // Keep existing hash/plaintext if form left password blank
        passwordValue = res.locals.panelChannel.password;
      } else {
        return res.redirect('/panel,settings,access?error=' + encodeURIComponent('Укажите пароль для закрытого канала'));
      }
    }
    await pool.query(
      'UPDATE channels SET access_level = ?, password = ?, is_18_plus = ? WHERE id = ?',
      [level, passwordValue, is18Plus, channelId]
    );
    res.redirect('/panel,settings,access?success=1');
  } catch (e) {
    console.error('Error updating access settings:', e);
    res.redirect('/panel,settings,access?error=Server error');
  }
});

// ─── Moderation ───────────────────────────────────────────────────────────────

router.get('/ru/panel,settings,moderation', panelMiddleware, async (req, res) => {
  if (!['owner', 'coowner', 'editor', 'staff'].includes(res.locals.panelRole)) {
    return res.status(403).send('Недостаточно прав.');
  }
  
  try {
    const channelId = res.locals.panelChannel.id;
    const [bans] = await pool.query(
      `SELECT b.*, u.avatar 
       FROM channel_bans b 
       LEFT JOIN users u ON b.user_id = u.id 
       WHERE b.channel_id = ? 
       ORDER BY b.banned_until DESC`,
      [channelId]
    );

    res.render('panel/moderation', {
      activeMenu: 'settings',
      activeSubmenu: 'moderation',
      breadcrumbs: '<a href="/panel,dashboard">Панель управления</a> &gt; Настройки &gt; Модерация',
      bans: bans,
      error: req.query.error,
      success: req.query.success
    });
  } catch (e) {
    console.error('Error fetching channel bans:', e);
    res.status(500).send('Database error');
  }
});

router.post('/ru/panel,settings,moderation,ban', panelMiddleware, async (req, res) => {
  if (!['owner', 'coowner', 'editor', 'staff'].includes(res.locals.panelRole)) {
    return res.status(403).send('Недостаточно прав.');
  }

  const channelId = res.locals.panelChannel.id;
  const { username, duration } = req.body;

  if (!username || !username.trim()) {
    return res.redirect('/panel,settings,moderation?error=Укажите имя пользователя');
  }

  try {
    const trimmedUsername = username.trim();
    // Check if user exists
    const [users] = await pool.query('SELECT id FROM users WHERE username = ?', [trimmedUsername]);
    let targetUserDbId = null;
    if (users.length > 0) {
      targetUserDbId = users[0].id;
    }

    let queryInterval = 'INTERVAL 1 HOUR';
    let msToAdd = 3600000;
    if (duration === '10') {
      queryInterval = 'INTERVAL 10 MINUTE';
      msToAdd = 10 * 60000;
    } else if (duration === '60') {
      queryInterval = 'INTERVAL 1 HOUR';
      msToAdd = 60 * 60000;
    } else if (duration === '1440') {
      queryInterval = 'INTERVAL 1 DAY';
      msToAdd = 1440 * 60000;
    } else if (duration === 'perm') {
      queryInterval = 'INTERVAL 100 YEAR';
      msToAdd = 100 * 365 * 24 * 60 * 60000;
    } else {
      return res.redirect('/panel,settings,moderation?error=Некорректная длительность');
    }

    // Add to channel_bans (delete old first if exists, to avoid duplicates)
    await pool.query('DELETE FROM channel_bans WHERE channel_id = ? AND username = ?', [channelId, trimmedUsername]);
    await pool.query(`INSERT INTO channel_bans (channel_id, user_id, username, banned_until) VALUES (?, ?, ?, DATE_ADD(NOW(), ${queryInterval}))`, [channelId, targetUserDbId, trimmedUsername]);

    // Emit live ban event
    const io = req.app.get('io');
    if (io && typeof io.banUser === 'function') {
      io.banUser(channelId, trimmedUsername, msToAdd);
    }

    // Log action
    const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
    logAction('team', req.session.user.username, `Заблокировал пользователя "${trimmedUsername}" на канале (ID: ${channelId})`, userIp);

    res.redirect('/panel,settings,moderation?success=Пользователь успешно заблокирован');
  } catch (e) {
    console.error('Error banning user from panel:', e);
    res.redirect('/panel,settings,moderation?error=Ошибка сервера');
  }
});

router.post('/ru/panel,settings,moderation,unban', panelMiddleware, async (req, res) => {
  if (!['owner', 'coowner', 'editor', 'staff'].includes(res.locals.panelRole)) {
    return res.status(403).send('Недостаточно прав.');
  }

  const channelId = res.locals.panelChannel.id;
  const { username } = req.body;

  if (!username) {
    return res.redirect('/panel,settings,moderation?error=Не указано имя пользователя');
  }

  try {
    await pool.query('DELETE FROM channel_bans WHERE channel_id = ? AND username = ?', [channelId, username]);

    // Emit live unban event
    const io = req.app.get('io');
    if (io && typeof io.unbanUser === 'function') {
      io.unbanUser(channelId, username);
    }

    // Log action
    const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
    logAction('team', req.session.user.username, `Разблокировал пользователя "${username}" на канале (ID: ${channelId})`, userIp);

    res.redirect('/panel,settings,moderation?success=Пользователь разблокирован');
  } catch (e) {
    console.error('Error unbanning user from panel:', e);
    res.redirect('/panel,settings,moderation?error=Ошибка сервера');
  }
});

// ─── Team ─────────────────────────────────────────────────────────────────────

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
      breadcrumbs: '<a href="/panel,dashboard">Панель управления</a> &gt; Настройки &gt; Команда',
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
    return res.redirect('/panel,settings,team?error=' + encodeURIComponent('Выберите хотя бы одну роль для пользователя'));
  }

  const channelId = res.locals.panelChannel.id;
  try {
    const [users] = await pool.query('SELECT id FROM users WHERE username = ?', [username]);
    if (users.length === 0) return res.redirect('/panel,settings,team?error=Пользователь не найден');
    const userId = users[0].id;
    if (userId === res.locals.panelChannel.user_id) return res.redirect('/panel,settings,team?error=' + encodeURIComponent('Нельзя добавить владельца канала в команду'));

    const [existing] = await pool.query('SELECT user_id FROM channel_team WHERE channel_id = ? AND user_id = ?', [channelId, userId]);
    if (existing.length > 0) return res.redirect('/panel,settings,team?error=' + encodeURIComponent('Пользователь уже находится в команде'));

    await pool.query(
      'INSERT INTO channel_team (channel_id, user_id, is_reporter, is_moderator, is_editor) VALUES (?, ?, ?, ?, ?)',
      [channelId, userId, is_reporter ? 1 : 0, is_moderator ? 1 : 0, is_editor ? 1 : 0]
    );
    const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
    logAction('team', req.session.user.username, `Добавил пользователя ${username} в команду канала`, userIp);
    res.redirect('/panel,settings,team?success=1');
  } catch (e) {
    res.redirect('/panel,settings,team?error=Ошибка сервера');
  }
});

router.post('/ru/panel,settings,team,update', panelMiddleware, async (req, res) => {
  const { user_id, is_reporter, is_moderator, is_editor, is_coowner } = req.body;
  const channelId = res.locals.panelChannel.id;
  const currentUserRole = res.locals.panelRole;

  try {
    const [targetRows] = await pool.query('SELECT is_coowner FROM channel_team WHERE channel_id = ? AND user_id = ?', [channelId, user_id]);
    if (targetRows.length === 0) {
      return res.redirect('/panel,settings,team?error=' + encodeURIComponent('Пользователь не найден в команде'));
    }
    const targetIsCoowner = targetRows[0].is_coowner === 1;
    const reqCoowner = (is_coowner && !res.locals.panelChannel.is_personal) ? 1 : 0;

    if (currentUserRole === 'coowner') {
      if (targetIsCoowner || (targetIsCoowner !== (reqCoowner === 1))) {
        return res.redirect('/panel,settings,team?error=' + encodeURIComponent('Действие запрещено. Совладельцы не могут изменять права совладельцев.'));
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
      return res.redirect('/panel,settings,team?error=' + encodeURIComponent('Выберите хотя бы одну роль для пользователя'));
    }

    await pool.query(
      'UPDATE channel_team SET is_reporter = ?, is_moderator = ?, is_editor = ?, is_coowner = ? WHERE channel_id = ? AND user_id = ?',
      [finalReporter, finalModerator, finalEditor, reqCoowner, channelId, user_id]
    );
    const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
    logAction('team', req.session.user.username, `Изменил права пользователя (ID: ${user_id}) в команде канала`, userIp);
    res.redirect('/panel,settings,team?success=1');
  } catch (e) {
    console.error('Error updating team member:', e);
    res.redirect('/panel,settings,team?error=Ошибка сервера');
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
        return res.redirect('/panel,settings,team?error=' + encodeURIComponent('Действие запрещено. Совладельцы не могут удалять совладельцев.'));
      }
    }
    await pool.query('DELETE FROM channel_team WHERE channel_id = ? AND user_id = ?', [channelId, user_id]);
    const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
    logAction('team', req.session.user.username, `Удалил пользователя (ID: ${user_id}) из команды канала`, userIp);
    res.redirect('/panel,settings,team?success=1');
  } catch (e) {
    res.redirect('/panel,settings,team?error=Ошибка сервера');
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
    return res.redirect('/panel,settings,team?error=' + encodeURIComponent('Не выбран пользователь для передачи прав'));
  }

  try {
    const connection = await pool.getConnection();

    const [teamCheck] = await connection.query('SELECT user_id FROM channel_team WHERE channel_id = ? AND user_id = ?', [channelId, target_user_id]);
    if (teamCheck.length === 0) {
      connection.release();
      return res.redirect('/panel,settings,team?error=' + encodeURIComponent('Пользователь должен быть членом команды канала'));
    }

    const token = crypto.randomBytes(32).toString('hex');

    await connection.query(
      'INSERT INTO pending_channel_transfers (channel_id, old_owner_id, new_owner_id, token) VALUES (?, ?, ?, ?)',
      [channelId, oldOwnerId, target_user_id, token]
    );

    const [ownerRows] = await connection.query('SELECT email, username FROM users WHERE id = ?', [oldOwnerId]);
    if (ownerRows.length === 0) {
      connection.release();
      return res.redirect('/panel,settings,team?error=' + encodeURIComponent('Не удалось найти данные владельца'));
    }
    const ownerEmail = ownerRows[0].email;
    const ownerUsername = ownerRows[0].username;

    const appUrl = process.env.APP_URL || 'http://localhost:3001';
    const transferLink = `${appUrl}/channels/transfer/confirm?token=${token}`;
    await emailService.sendChannelTransferEmail(ownerEmail, ownerUsername, res.locals.panelChannel.name, transferLink);

    connection.release();
    res.redirect('/panel,settings,team?success=' + encodeURIComponent('На вашу почту отправлено письмо для подтверждения передачи прав.'));
  } catch (e) {
    console.error('Error initiating transfer:', e);
    res.redirect('/panel,settings,team?error=' + encodeURIComponent('Ошибка сервера при инициализации передачи прав.'));
  }
});

module.exports = router;
