'use strict';

const fs = require('fs');
const path = require('path');

/** App-local public root (avatars/design/records mounts). */
const PUBLIC_ROOT = path.join(__dirname, '..', '..', 'public');

/**
 * Private export/transfer zips — NOT under express.static / CDN /uploads.
 * Mounted to MEDIA/private/... in docker-compose.
 */
const STORAGE_ROOT = path.join(__dirname, '..', '..', 'storage');
const EXPORTS_DIR = path.join(STORAGE_ROOT, 'exports');
const TRANSFERS_DIR = path.join(STORAGE_ROOT, 'transfers');
const EXPORT_TMP_DIR = path.join(STORAGE_ROOT, 'exports', 'tmp');

function ensureDirs() {
  for (const dir of [EXPORTS_DIR, TRANSFERS_DIR, EXPORT_TMP_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function publicRoot() {
  return PUBLIC_ROOT;
}

function storageRoot() {
  return STORAGE_ROOT;
}

/** Resolve zip_path from DB: private storage filename or legacy /uploads/exports/... */
function resolveExportZip(zipPath) {
  if (!zipPath || typeof zipPath !== 'string') return null;
  const name = path.basename(zipPath);
  if (!name || name === '.' || name === '..') return null;

  const privateAbs = path.resolve(EXPORTS_DIR, name);
  if (!privateAbs.startsWith(EXPORTS_DIR + path.sep) && privateAbs !== EXPORTS_DIR) return null;
  if (fs.existsSync(privateAbs)) return privateAbs;

  // Legacy location (pre-hardening)
  const legacy = path.resolve(PUBLIC_ROOT, 'uploads', 'exports', name);
  const legacyRoot = path.resolve(PUBLIC_ROOT, 'uploads', 'exports');
  if (legacy.startsWith(legacyRoot + path.sep) && fs.existsSync(legacy)) return legacy;

  return null;
}

function resolveTransferZip(zipPath) {
  if (!zipPath || typeof zipPath !== 'string') return null;
  const name = path.basename(zipPath);
  if (!name || name === '.' || name === '..') return null;

  const privateAbs = path.resolve(TRANSFERS_DIR, name);
  if (!privateAbs.startsWith(TRANSFERS_DIR + path.sep) && privateAbs !== TRANSFERS_DIR) return null;
  if (fs.existsSync(privateAbs)) return privateAbs;

  const legacy = path.resolve(PUBLIC_ROOT, 'uploads', 'transfers', name);
  const legacyRoot = path.resolve(PUBLIC_ROOT, 'uploads', 'transfers');
  if (legacy.startsWith(legacyRoot + path.sep) && fs.existsSync(legacy)) return legacy;

  return null;
}

module.exports = {
  PUBLIC_ROOT,
  STORAGE_ROOT,
  EXPORTS_DIR,
  TRANSFERS_DIR,
  EXPORT_TMP_DIR,
  ensureDirs,
  publicRoot,
  storageRoot,
  resolveExportZip,
  resolveTransferZip
};
