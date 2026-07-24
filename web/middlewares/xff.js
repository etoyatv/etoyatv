'use strict';

/** First-hop X-Forwarded-For sanitizer (avoid spoofed multi-IP lists). */
function xffSanitizer(req, res, next) {
  let ipHeader = req.headers['x-forwarded-for'];
  if (ipHeader) {
    if (Array.isArray(ipHeader)) {
      ipHeader = ipHeader[0];
    }
    if (typeof ipHeader === 'string') {
      req.headers['x-forwarded-for'] = ipHeader.split(',')[0].trim();
    }
  }
  next();
}

module.exports = { xffSanitizer };
