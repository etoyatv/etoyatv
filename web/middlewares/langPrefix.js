'use strict';

/**
 * Public URLs are language-neutral (no /ru/ prefix).
 * Language is cookie/session + Weblate.
 *
 * - /ru|/en|/uk|/be/...  → 301 to /...
 * - bare legacy paths     → internal rewrite to /ru/... so existing routes still match
 */

const LANG_PREFIX_RE = /^\/(ru|en|uk|be)(?=\/|$)/;

// Comma-style legacy paths (/account,profile/, /panel,dashboard, …) plus
 // slash-style ones that still live under /ru/* (/messages/, /news, …).
 // Do NOT rewrite /account/2fa/* — those routes are registered without /ru.
 const LEGACY_ROOT_RE = /^\/(?:account(?=,|$)|panel(?=,|$)|tv(?=,|$)|channel(?=,|$)|messages(?=\/|$)|news(?=[,/]|$)|eula(?=\/|$)|channel_eula(?=\/|$)|rules(?=\/|$)|about(?=\/|$)|feedback(?=\/|$)|speedtest(?=\/|$))/;

function langPrefixMiddleware(req, res, next) {
  // Never touch APIs / sockets / static-ish internals
  const pathOnly = (req.path || '').split('?')[0];
  if (
    pathOnly.startsWith('/api/') ||
    pathOnly.startsWith('/socket.io') ||
    pathOnly.startsWith('/css') ||
    pathOnly.startsWith('/js') ||
    pathOnly.startsWith('/images') ||
    pathOnly.startsWith('/uploads') ||
    pathOnly.startsWith('/tvsnapshots')
  ) {
    return next();
  }

  const m = pathOnly.match(LANG_PREFIX_RE);
  // Public URLs must not use /ru|en|… — middleware 301-strips them and turns POST into GET.
  if (m) {
    const restPath = pathOnly.replace(LANG_PREFIX_RE, '') || '/';
    // Preserve method for non-GET (308); GET stays 301 for caches/bookmarks
    const code = (req.method === 'GET' || req.method === 'HEAD') ? 301 : 308;
    const qIdx = (req.originalUrl || '').indexOf('?');
    const qs = qIdx >= 0 ? req.originalUrl.slice(qIdx) : '';
    return res.redirect(code, restPath + qs);
  }

  if (LEGACY_ROOT_RE.test(pathOnly)) {
    // Preserve query string in req.url
    const url = req.url || pathOnly;
    req.url = '/ru' + (url.startsWith('/') ? url : '/' + url);
  }

  next();
}

module.exports = { langPrefixMiddleware, LEGACY_ROOT_RE };
