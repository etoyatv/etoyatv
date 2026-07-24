'use strict';

const multer = require('multer');
const path = require('path');
const fs = require('fs');

const storageRoot = path.join(__dirname, '..', 'public');

const IMAGE_EXT_BY_MIME = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/apng': '.apng'
};
const ALLOWED_IMAGE_MIMES = Object.keys(IMAGE_EXT_BY_MIME);
const ALLOWED_VIDEO_EXTS = ['.mp4', '.mkv', '.avi', '.mov', '.flv', '.webm', '.wmv', '.m4v', '.ts', '.mpeg', '.mpg'];

const avatarsDir = path.join(storageRoot, 'images', 'avatars');
if (!fs.existsSync(avatarsDir)) {
  fs.mkdirSync(avatarsDir, { recursive: true });
}

const imageFilter = (req, file, cb) => {
  if (ALLOWED_IMAGE_MIMES.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', 'Invalid file type'));
  }
};

const videoFilter = (req, file, cb) => {
  const ext = path.extname(file.originalname).toLowerCase();
  if (file.mimetype.startsWith('video/') || file.mimetype === 'application/x-flash-video' || ALLOWED_VIDEO_EXTS.includes(ext)) {
    cb(null, true);
  } else {
    cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', 'Invalid video type'));
  }
};

function safeImageExt(file) {
  return IMAGE_EXT_BY_MIME[file.mimetype] || '.png';
}

function safeVideoExt(originalname) {
  const raw = path.extname(originalname || '').toLowerCase().replace(/[^a-z0-9.]/g, '');
  return ALLOWED_VIDEO_EXTS.includes(raw) ? raw : '.mp4';
}

const storage = multer.diskStorage({
  destination: function (req, file, cb) { cb(null, avatarsDir); },
  filename: function (req, file, cb) {
    cb(null, 'avatar_' + req.session.user.id + '_' + Date.now() + safeImageExt(file));
  }
});
const upload = multer({
  storage,
  fileFilter: imageFilter,
  limits: { fileSize: 4 * 1024 * 1024 }
});

const designDir = path.join(storageRoot, 'images', 'design');
if (!fs.existsSync(designDir)) {
  fs.mkdirSync(designDir, { recursive: true });
}
const designStorage = multer.diskStorage({
  destination: function (req, file, cb) { cb(null, designDir); },
  filename: function (req, file, cb) {
    cb(null, file.fieldname + '_' + req.session.user.id + '_' + Date.now() + safeImageExt(file));
  }
});
const uploadDesign = multer({
  storage: designStorage,
  fileFilter: imageFilter,
  limits: { fileSize: 4 * 1024 * 1024 }
});

const recordsDir = path.join(storageRoot, 'uploads', 'records');
if (!fs.existsSync(recordsDir)) {
  fs.mkdirSync(recordsDir, { recursive: true });
}
const recordsStorage = multer.diskStorage({
  destination: function (req, file, cb) { cb(null, recordsDir); },
  filename: function (req, file, cb) {
    cb(null, 'record_' + req.session.user.id + '_' + Date.now() + safeVideoExt(file.originalname));
  }
});
const uploadRecord = multer({
  storage: recordsStorage,
  fileFilter: videoFilter,
  limits: { fileSize: 256 * 1024 * 1024 }
});

module.exports = { upload, uploadDesign, uploadRecord, recordsStorage, videoFilter, ALLOWED_IMAGE_MIMES };
