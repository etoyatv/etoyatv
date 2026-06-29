const multer = require('multer');
const path = require('path');
const fs = require('fs');

const storageRoot = path.join(__dirname, '..', 'public');

const avatarsDir = path.join(storageRoot, 'images', 'avatars');
if (!fs.existsSync(avatarsDir)) {
  fs.mkdirSync(avatarsDir, { recursive: true });
}
const imageFilter = (req, file, cb) => {
  const allowedMimes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
  if (allowedMimes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', 'Invalid file type'));
  }
};

const videoFilter = (req, file, cb) => {
  const ext = path.extname(file.originalname).toLowerCase();
  const allowedExtensions = ['.mp4', '.mkv', '.avi', '.mov', '.flv', '.webm', '.wmv', '.m4v', '.ts', '.mpeg', '.mpg'];
  
  if (file.mimetype.startsWith('video/') || file.mimetype === 'application/x-flash-video' || allowedExtensions.includes(ext)) {
    cb(null, true);
  } else {
    cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', 'Invalid video type'));
  }
};

const storage = multer.diskStorage({
  destination: function (req, file, cb) { cb(null, avatarsDir) },
  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname) || '.png';
    cb(null, 'avatar_' + req.session.user.id + '_' + Date.now() + ext)
  }
});
const upload = multer({
  storage: storage,
  fileFilter: imageFilter,
  limits: { fileSize: 4 * 1024 * 1024 } // 4MB limit
});

const designDir = path.join(storageRoot, 'images', 'design');
if (!fs.existsSync(designDir)) {
  fs.mkdirSync(designDir, { recursive: true });
}
const designStorage = multer.diskStorage({
  destination: function (req, file, cb) { cb(null, designDir) },
  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname) || '.png';
    cb(null, file.fieldname + '_' + req.session.user.id + '_' + Date.now() + ext)
  }
});
const uploadDesign = multer({
  storage: designStorage,
  fileFilter: imageFilter,
  limits: { fileSize: 4 * 1024 * 1024 } // 10MB limit for backgrounds/banners
});

const recordsDir = path.join(storageRoot, 'uploads', 'records');
if (!fs.existsSync(recordsDir)) {
  fs.mkdirSync(recordsDir, { recursive: true });
}
const recordsStorage = multer.diskStorage({
  destination: function (req, file, cb) { cb(null, recordsDir) },
  filename: function (req, file, cb) {
    const rawExt = path.extname(file.originalname) || '.mp4';
    const ext = rawExt.replace(/[^a-zA-Z0-9.]/g, ''); // Sanitize to prevent command injection
    cb(null, 'record_' + req.session.user.id + '_' + Date.now() + (ext || '.mp4'))
  }
});
const uploadRecord = multer({
  storage: recordsStorage,
  fileFilter: videoFilter,
  limits: { fileSize: 200 * 1024 * 1024 } // 200MB limit for video records
});

module.exports = { upload, uploadDesign, uploadRecord };
