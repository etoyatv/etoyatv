'use strict';

const bcrypt = require('bcrypt');

const BCRYPT_ROUNDS = 10;

function looksLikeBcryptHash(value) {
  return typeof value === 'string' && /^\$2[aby]?\$\d{2}\$/.test(value);
}

async function hashChannelPassword(plain) {
  if (!plain) return '';
  return bcrypt.hash(String(plain), BCRYPT_ROUNDS);
}

/**
 * Verify channel password. Supports legacy plaintext until re-saved.
 * @returns {{ ok: boolean, needsRehash: boolean }}
 */
async function verifyChannelPassword(stored, plain) {
  if (!stored && !plain) return { ok: true, needsRehash: false };
  if (!stored || plain == null || plain === '') return { ok: false, needsRehash: false };

  if (looksLikeBcryptHash(stored)) {
    const ok = await bcrypt.compare(String(plain), stored);
    return { ok, needsRehash: false };
  }

  // Legacy plaintext
  const ok = String(stored) === String(plain);
  return { ok, needsRehash: ok };
}

module.exports = {
  hashChannelPassword,
  verifyChannelPassword,
  looksLikeBcryptHash
};
