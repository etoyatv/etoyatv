const { uploadRecord, uploadDesign } = require('../config/upload');
const { pool } = require('../config/db');

const panelMiddleware = async (req, res, next) => {
  if (!req.session.user) {
    return res.redirect('/login');
  }

  // Skip middleware restrictions for the selection routes
  if (req.path === '/ru/panel,select' || req.path === '/ru/panel,set_channel') {
    return next();
  }

  try {
    const connection = await pool.getConnection();

    const [ownedChannels] = await connection.query("SELECT c.*, 'owner' as panel_role FROM channels c WHERE c.user_id = ? AND c.status IN ('active', 'banned')", [req.session.user.id]);

    const [teamChannels] = await connection.query("SELECT c.*, t.is_editor, t.is_reporter FROM channels c JOIN channel_team t ON c.id = t.channel_id WHERE t.user_id = ? AND c.status IN ('active', 'banned') AND (t.is_editor = 1 OR t.is_reporter = 1)", [req.session.user.id]);

    let availableChannels = [...ownedChannels, ...teamChannels.map(c => {
      let role = 'reporter';
      if (c.is_editor) role = 'editor';
      return { ...c, panel_role: role };
    })];

    const isStaff = req.session.user.staff_role && req.session.user.mask_mode !== 'user_mask';

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
      return res.redirect('/ru/panel,select');
    }

    let selectedChannelId = req.session.panel_channel_id;
    if (!selectedChannelId) {
      return res.redirect('/ru/panel,select');
    }

    let selectedChannel = availableChannels.find(c => c.id == selectedChannelId);

    if (!selectedChannel) {
      delete req.session.panel_channel_id;
      return res.redirect('/ru/panel,select');
    }

    const channelId = selectedChannel.id;

    // Fetch pinned message details if set
    const pinnedMsgId = selectedChannel.pinned_message_id;
    selectedChannel.pinned_message = null;
    selectedChannel.pinned_message_id = null;
    if (pinnedMsgId) {
      try {
        const [pinnedRows] = await pool.query(`
          SELECT pm.id, pm.message, pm.guest_name, u.username, pm.role, pm.color
          FROM chat_messages pm
          LEFT JOIN users u ON pm.user_id = u.id
          WHERE pm.id = ?
        `, [pinnedMsgId]);
        if (pinnedRows.length > 0) {
          selectedChannel.pinned_message = pinnedRows[0].message;
          selectedChannel.pinned_guest_name = pinnedRows[0].guest_name;
          selectedChannel.pinned_username = pinnedRows[0].username;
          selectedChannel.pinned_role = pinnedRows[0].role;
          selectedChannel.pinned_color = pinnedRows[0].color;
          selectedChannel.pinned_message_id = pinnedRows[0].id;
        }
      } catch (e) {
        console.error('Error loading pinned message in panelMiddleware:', e);
      }
    }
    const [stats] = await pool.query(`
      SELECT 
        (SELECT COUNT(*) FROM records WHERE channel_id = ?) as total_records,
        (SELECT COUNT(*) FROM records WHERE channel_id = ? AND hls_url IS NULL) as processing_records,
        (SELECT COUNT(*) FROM albums WHERE channel_id = ?) as total_albums,
        (SELECT SUM(size_bytes) FROM records WHERE channel_id = ?) as total_size
    `, [channelId, channelId, channelId, channelId]);

    res.locals.panelChannel = selectedChannel;
    res.locals.panelRole = selectedChannel.panel_role;
    res.locals.availableChannels = availableChannels;
    res.locals.panelStats = {
      totalRecords: stats[0].total_records,
      processingRecords: stats[0].processing_records,
      totalAlbums: stats[0].total_albums,
      totalSize: parseInt(stats[0].total_size || 0)
    };
    res.locals.query = req.query;

    const path = req.path;
    const role = selectedChannel.panel_role;

    if (role === 'reporter' && !path.endsWith(',dashboard') && !path.includes('news') && !path.includes('records') && !path.includes('broadcast') && path !== '/ru/panel,settings,channel') {
      return res.redirect('/ru/panel,dashboard');
    }

    if (selectedChannel.status === 'banned') {
      if (path !== '/ru/panel,dashboard' && path !== '/ru/panel,select' && path !== '/ru/panel,set_channel') {
        return res.redirect('/ru/panel,dashboard?error=' + encodeURIComponent('Данный телеканал заблокирован администрацией и весь функционал канала не доступен.'));
      }
      if (req.method !== 'GET') {
         return res.status(403).send('Действие запрещено. Канал заблокирован администрацией.');
      }
    }

    if (role === 'editor' && (path.includes('team') || path.includes('access'))) {
      return res.redirect('/ru/panel,dashboard');
    }

    next();
  } catch (e) {
    console.error('Error in panelMiddleware:', e);
    res.status(500).send('Database error');
  }
};

const recordUploadMiddleware = (req, res, next) => {
  uploadRecord.single('record_file')(req, res, function(err) {
    if (err) {
      let errMsg = 'Ошибка загрузки файла.';
      if (err.code === 'LIMIT_FILE_SIZE') {
        errMsg = 'Размер видео слишком велик.';
      }
      if (req.xhr || (req.headers.accept && req.headers.accept.includes('json'))) {
        return res.status(400).json({ error: errMsg });
      }
      return res.redirect('/ru/panel,records,upload?error=' + encodeURIComponent(errMsg));
    }
    next();
  });
};

const designUploadMiddleware = (req, res, next) => {
  uploadDesign.fields([{ name: 'logo', maxCount: 1 }, { name: 'banner', maxCount: 1 }, { name: 'background', maxCount: 1 }])(req, res, function(err) {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.redirect('/ru/panel,settings,design?error=' + encodeURIComponent('Размер файла превышает лимит 4 МБ.'));
      }
      if (err.code === 'LIMIT_UNEXPECTED_FILE') {
        return res.redirect('/ru/panel,settings,design?error=' + encodeURIComponent('Разрешена загрузка только изображений (jpeg, png, gif, webp).'));
      }
      return res.redirect('/ru/panel,settings,design?error=' + encodeURIComponent('Ошибка загрузки файла.'));
    }
    next();
  });
};

module.exports = { panelMiddleware, recordUploadMiddleware, designUploadMiddleware };
