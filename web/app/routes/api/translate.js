const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const { translateText, translateMany, getProviderInfo, SUPPORTED } = require('../../../utils/translator');

const MAX_TEXT_LEN = 2000;
const MAX_BATCH = 40;

// Guests may translate UGC via toast.js; require an established session (CSRF creates one) + tight rate limit.
const translateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests' }
});

function requireSession(req, res, next) {
  if (!req.session) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

router.post('/api/translate', translateLimiter, requireSession, async (req, res) => {
  const { text, texts, to, from } = req.body || {};
  const target = typeof to === 'string' ? to.toLowerCase().trim() : '';
  if (!SUPPORTED.has(target)) {
    return res.status(400).json({ error: 'Unsupported target language' });
  }
  const source = (typeof from === 'string' && from) ? from.toLowerCase().trim() : 'auto';

  try {
    if (Array.isArray(texts)) {
      if (texts.length === 0) return res.status(400).json({ error: 'texts required' });
      if (texts.length > MAX_BATCH) {
        return res.status(400).json({ error: `Max ${MAX_BATCH} texts per request` });
      }
      const cleaned = texts.map((t) => String(t == null ? '' : t).slice(0, MAX_TEXT_LEN));
      const translated = await translateMany(cleaned, target, source);
      return res.json({ success: true, texts: translated, provider: getProviderInfo().provider });
    }

    if (!text || typeof text !== 'string') {
      return res.status(400).json({ error: 'Text and target language are required' });
    }
    const translated = await translateText(text.slice(0, MAX_TEXT_LEN), target, source);
    res.json({ success: true, text: translated, provider: getProviderInfo().provider });
  } catch (err) {
    console.error('[api/translate]', err.message);
    res.status(500).json({ error: 'Translation failed' });
  }
});

module.exports = router;
