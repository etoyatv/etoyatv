'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Resolve a stored public URL/path under a root directory.
 * Rejects path traversal (`..`) and absolute escapes.
 * @param {string} fileUrl
 * @param {string} [publicRoot] absolute path to public root
 * @returns {string|null} absolute path inside root, or null if unsafe/missing input
 */
function safeResolvePublic(fileUrl, publicRoot) {
  if (!fileUrl || typeof fileUrl !== 'string') return null;
  const root = path.resolve(publicRoot || path.join(__dirname, '..', 'public'));
  let relative = fileUrl.trim();
  if (/^https?:\/\//i.test(relative)) {
    try {
      const u = new URL(relative);
      relative = u.pathname || '';
    } catch (e) {
      return null;
    }
  }
  relative = relative.replace(/^\/+/, '');
  if (!relative || relative.includes('\0')) return null;
  const absolute = path.resolve(root, relative);
  if (absolute !== root && !absolute.startsWith(root + path.sep)) return null;
  return absolute;
}

function deletePublicFileIfExists(fileUrl, publicRoot, opts = {}) {
  if (!fileUrl) return false;
  if (opts.ignoreDefaults !== false) {
    if (fileUrl.includes('default_channel_logo') || fileUrl.includes('default_bg')) {
      return false;
    }
  }
  const absolutePath = safeResolvePublic(fileUrl, publicRoot);
  if (!absolutePath) return false;
  if (!fs.existsSync(absolutePath)) return false;
  try {
    fs.unlinkSync(absolutePath);
    return true;
  } catch (e) {
    console.error('[safePath] unlink failed:', absolutePath, e.message);
    return false;
  }
}

/**
 * Only allow same-app relative redirects (block open redirects).
 * @param {string|undefined} raw
 * @param {string} fallback
 */
function safeRedirectPath(raw, fallback = '/') {
  if (!raw || typeof raw !== 'string') return fallback;
  const s = raw.trim();
  if (!s.startsWith('/') || s.startsWith('//') || s.includes('\\')) return fallback;
  if (/[\r\n\0]/.test(s)) return fallback;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(s)) return fallback;
  return s;
}

/**
 * Resolve a relative path strictly under rootDir (zip extract / manifest paths).
 * Rejects absolute paths, NUL, escapes, and symlink targets outside the root.
 * @returns {string|null} absolute path inside root
 */
function safeResolveUnder(rootDir, relativePath) {
  if (!rootDir || !relativePath || typeof relativePath !== 'string') return null;
  const rel = relativePath.trim().replace(/\\/g, '/');
  if (!rel || rel.includes('\0')) return null;
  if (path.isAbsolute(rel) || /^[a-zA-Z]:[\\/]/.test(rel) || rel.startsWith('//')) return null;
  const root = path.resolve(rootDir);
  const absolute = path.resolve(root, rel);
  if (absolute !== root && !absolute.startsWith(root + path.sep)) return null;
  try {
    if (fs.existsSync(absolute)) {
      const st = fs.lstatSync(absolute);
      if (st.isSymbolicLink()) return null;
      const real = fs.realpathSync(absolute);
      if (real !== root && !real.startsWith(root + path.sep)) return null;
      return real;
    }
  } catch (e) {
    return null;
  }
  return absolute;
}

module.exports = {
  safeResolvePublic,
  deletePublicFileIfExists,
  safeRedirectPath,
  safeResolveUnder
};
