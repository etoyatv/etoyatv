'use strict';

/**
 * Only allow same-site relative redirects (open-redirect hardening).
 */
function safeRedirectPath(raw, fallback = '/') {
  if (!raw || typeof raw !== 'string') return fallback;
  const trimmed = raw.trim();
  if (!trimmed.startsWith('/')) return fallback;
  if (trimmed.startsWith('//')) return fallback;
  if (trimmed.includes('\\')) return fallback;
  if (/[\r\n]/.test(trimmed)) return fallback;
  return trimmed;
}

function redirectBack(req, res, fallback = '/') {
  const ref = req.get('Referer') || '';
  let path = fallback;
  try {
    if (ref) {
      const u = new URL(ref, `${req.protocol}://${req.get('host') || 'localhost'}`);
      const host = (req.get('host') || '').toLowerCase();
      if (u.host.toLowerCase() === host) {
        path = safeRedirectPath(u.pathname + u.search, fallback);
      }
    }
  } catch (_) {
    path = fallback;
  }
  return res.redirect(path);
}

module.exports = { safeRedirectPath, redirectBack };
