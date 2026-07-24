const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');

const LOCALES_DIR = path.join(__dirname, '../locales');
let supportedLangs = ['ru', 'en', 'uk', 'be'];
let translations = { ru: {}, en: {}, uk: {}, be: {} };
const weblateKeysCache = {};

function loadTranslations() {
  console.log('Loading translations from locales directory:', LOCALES_DIR);
  
  // Dynamically detect languages from json files in locales folder
  let langs = ['ru']; // always support Russian
  try {
    if (fs.existsSync(LOCALES_DIR)) {
      const files = fs.readdirSync(LOCALES_DIR);
      for (const file of files) {
        if (file.endsWith('.json')) {
          const lang = file.slice(0, -5);
          if (!langs.includes(lang)) {
            langs.push(lang);
          }
        }
      }
    }
  } catch (err) {
    console.error('Failed to read locales directory:', err);
  }
  supportedLangs = langs;

  const newTranslations = {};
  for (const lang of supportedLangs) {
    newTranslations[lang] = {};
    const file = path.join(LOCALES_DIR, `${lang}.json`);
    if (fs.existsSync(file)) {
      try {
        newTranslations[lang] = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch (e) {
        console.error(`Failed to load translation file for lang ${lang}:`, e);
      }
    }
  }
  translations = newTranslations;
  // Drop phrase-cache so hot-reload picks up Weblate updates
  Object.keys(weblateKeysCache).forEach((k) => { delete weblateKeysCache[k]; });
  
  const statusStr = supportedLangs.map(l => `${l.toUpperCase()}=${Object.keys(translations[l] || {}).length}`).join(', ');
  console.log(`Translations loaded successfully: ${statusStr}`);
}

// Initial load
loadTranslations();

// Watch locales directory for changes to hot-reload translations in real-time
try {
  fs.watch(LOCALES_DIR, (eventType, filename) => {
    if (filename && filename.endsWith('.json')) {
      console.log(`Translation file ${filename} changed. Hot-reloading translations...`);
      loadTranslations();
    }
  });
} catch (e) {
  console.error('Failed to watch locales directory for changes:', e);
}

// Helper to get cookies from request headers
function getCookie(req, name) {
  if (!req.headers.cookie) return null;
  const match = req.headers.cookie.match(new RegExp('(^|; )' + name + '=([^;]*)'));
  return match ? decodeURIComponent(match[2]) : null;
}

// Detect language based on request properties
function detectLanguage(req) {
  // 1. Query parameter
  if (req.query.lang && supportedLangs.includes(req.query.lang)) {
    return req.query.lang;
  }

  // 2. Logged-in user language
  if (req.session && req.session.user && req.session.user.lang && supportedLangs.includes(req.session.user.lang)) {
    return req.session.user.lang;
  }

  // 3. Session lang
  if (req.session && req.session.lang && supportedLangs.includes(req.session.lang)) {
    return req.session.lang;
  }

  // 4. Cookies lang
  const cookieLang = getCookie(req, 'lang');
  if (cookieLang && supportedLangs.includes(cookieLang)) {
    return cookieLang;
  }

  // 5. Accept-Language header
  const acceptLanguage = req.headers['accept-language'];
  if (acceptLanguage) {
    const langs = acceptLanguage.split(',').map(lang => {
      const parts = lang.split(';');
      const code = parts[0].trim().toLowerCase().split('-')[0];
      const q = parts[1] ? parseFloat(parts[1].split('=')[1]) : 1.0;
      return { code, q };
    }).sort((a, b) => b.q - a.q);

    for (const l of langs) {
      if (supportedLangs.includes(l.code)) {
        return l.code;
      }
    }
  }

  return 'ru';
}

function normalizeText(text) {
  if (!text) return '';
  return text.replace(/\s+/g, ' ').trim();
}

function hasCyrillic(text) {
  return /[\u0400-\u04FF]/.test(text);
}

function getWeblateKeys(lang) {
  if (weblateKeysCache[lang]) return weblateKeysCache[lang];
  const dict = translations[lang] || {};
  // Prefer longer phrases; skip tiny tokens that would corrupt mixed strings
  const keys = Object.keys(dict)
    .filter((k) => hasCyrillic(k) && k.trim().length >= 3 && dict[k] && dict[k] !== k)
    .sort((a, b) => b.length - a.length);
  weblateKeysCache[lang] = keys;
  return keys;
}

/**
 * Apply Weblate (locales) first — never skip curated UI strings.
 * Exact match, then longest-phrase substitution inside mixed UI+UGC nodes.
 */
function applyWeblate(text, lang) {
  if (!text || lang === 'ru') return text;
  const dict = translations[lang];
  if (!dict) return text;

  // 1) existing exact / punctuation-aware lookup
  let out = translateString(text, lang);
  if (!hasCyrillic(out)) return out;

  // 2) replace known Weblate phrases inside leftover mixed strings
  //    e.g. "Телеканал: Путин..." → "Channel: Путин..." (UGC remains for MT)
  for (const key of getWeblateKeys(lang)) {
    if (out.indexOf(key) !== -1) {
      out = out.split(key).join(dict[key]);
    }
  }
  return normalizeBrandName(out, lang);
}

function normalizeBrandName(result, lang) {
  if (lang !== 'en') {
    return result.replace(/ЭтоЯTV|EtoYaTV|ЕтоЯTV|ЕТОЯTV|ГэтаЯTV|ЦеЯTV|ЕтоTV|ЦеЯТВ|ЭтоЯТВ|EtoYaТВ/gi, 'ЭтоЯTV');
  } else {
    return result.replace(/ЭтоЯTV|EtoYaTV|ЕтоЯTV|ЕТОЯTV|ГэтаЯTV|ЦеЯTV|ЕтоTV|ЦеЯТВ|ЭтоЯТВ|EtoYaТВ/gi, 'EtoYaTV');
  }
}

function translateStringPart(text, lang) {
  const dict = translations[lang];
  if (!dict) return text;
  
  // Extract leading/trailing whitespaces to preserve spacing in template literals
  const wsPrefixMatch = text.match(/^\s*/);
  const wsSuffixMatch = text.match(/\s*$/);
  const wsPrefix = wsPrefixMatch ? wsPrefixMatch[0] : '';
  const wsSuffix = wsSuffixMatch ? wsSuffixMatch[0] : '';
  
  const trimmedText = text.trim();
  if (!trimmedText) return text;
  
  const originalNormalized = normalizeText(trimmedText);
  if (!originalNormalized) return text;
  
  let translatedResult = '';
  let found = false;
  
  // 1. Direct match on the original untrimmed core
  if (dict[originalNormalized]) {
    translatedResult = normalizeBrandName(dict[originalNormalized], lang);
    found = true;
  } else {
    // Case-insensitive check on the original untrimmed core
    const lowerOriginal = originalNormalized.toLowerCase();
    for (const [key, val] of Object.entries(dict)) {
      if (key.toLowerCase() === lowerOriginal) {
        translatedResult = normalizeBrandName(val, lang);
        found = true;
        break;
      }
    }
  }
  
  // 2. Extract leading and trailing punctuation (non-letters) to look up core
  if (!found) {
    const prefixMatch = trimmedText.match(/^[^A-Za-z\u0400-\u04FF]*/);
    const suffixMatch = trimmedText.match(/[^A-Za-z\u0400-\u04FF]*$/);
    
    const prefix = prefixMatch ? prefixMatch[0] : '';
    const suffix = suffixMatch ? suffixMatch[0] : '';
    
    const core = trimmedText.substring(prefix.length, trimmedText.length - suffix.length);
    const normalizedCore = normalizeText(core);
    
    if (normalizedCore) {
      let result = core;
      let matchedWithSuffix = false;
      if (dict[normalizedCore]) {
        result = dict[normalizedCore];
      } else if (dict[normalizedCore + suffix]) {
        result = dict[normalizedCore + suffix];
        matchedWithSuffix = true;
      } else {
        const lowerCore = normalizedCore.toLowerCase();
        let lowerWithSuffix = (normalizedCore + suffix).toLowerCase();
        for (const [key, val] of Object.entries(dict)) {
          let lowerKey = key.toLowerCase();
          if (lowerKey === lowerCore) {
            result = val;
            break;
          } else if (lowerKey === lowerWithSuffix) {
            result = val;
            matchedWithSuffix = true;
            break;
          }
        }
      }
      
      if (matchedWithSuffix) {
        translatedResult = prefix + normalizeBrandName(result, lang);
      } else {
        translatedResult = prefix + normalizeBrandName(result, lang) + suffix;
      }
    } else {
      translatedResult = trimmedText;
    }
  }
  
  return wsPrefix + translatedResult + wsSuffix;
}

function translateString(text, lang) {
  const dict = translations[lang];
  if (!dict) return text;
  
  // If the text contains quote delimiters, split and translate parts individually
  // to preserve dynamic variables/names wrapped in quotes (e.g. Телеканал "Имя" не имеет...)
  if (text.includes('"') || text.includes("'")) {
    const delimiters = ['"', "'"];
    for (const delim of delimiters) {
      let parts = text.split(delim);
      
      if (parts.length > 1) {
        const translatedParts = parts.map(part => {
          const trimmed = part.trim();
          if (trimmed && hasCyrillic(trimmed) && trimmed.length > 1) {
            return translateStringPart(part, lang);
          }
          return part;
        });
        
        return translatedParts.join(delim);
      }
    }
  }
  
  return translateStringPart(text, lang);
}

// Main translation engine for rendered HTML
function translateHtml(html, lang) {
  // Hot reload translations cache in dev if needed (optional)
  if (process.env.NODE_ENV !== 'production') {
    loadTranslations();
  }
  
  try {
    const $ = cheerio.load(html, { decodeEntities: false });
    
    // 1. Translate text nodes
    $('*').each((i, el) => {
      if (el.name === 'script' || el.name === 'style') return;
      
      $(el).contents().each((j, child) => {
        if (child.type === 'text') {
          const originalText = $(child).text();
          const trimmed = originalText.trim();
          if (trimmed && hasCyrillic(trimmed) && trimmed.length > 1) {
            const translated = applyWeblate(trimmed, lang);
            // Replace text node content keeping the original whitespaces if any
            const prefix = originalText.match(/^\s*/)[0];
            const suffix = originalText.match(/\s*$/)[0];
            child.data = prefix + translated + suffix;
          }
        }
      });
      
      // 2. Translate attributes: placeholder, title, alt, value
      const placeholder = $(el).attr('placeholder');
      if (placeholder && hasCyrillic(placeholder)) {
        $(el).attr('placeholder', applyWeblate(placeholder, lang));
      }
      
      const title = $(el).attr('title');
      if (title && hasCyrillic(title)) {
        $(el).attr('title', applyWeblate(title, lang));
      }
      
      const alt = $(el).attr('alt');
      if (alt && hasCyrillic(alt)) {
        $(el).attr('alt', applyWeblate(alt, lang));
      }
      
      const value = $(el).attr('value');
      if (value && hasCyrillic(value) && (el.name === 'input' || el.name === 'button')) {
        $(el).attr('value', applyWeblate(value, lang));
      }
    });
    
    return $.html();
  } catch (err) {
    console.error('Error translating HTML output:', err);
    return html; // Return original html as fallback
  }
}

function shouldSkipMtNode($, el) {
  if (!el || !el.name) return true;
  if (el.name === 'script' || el.name === 'style' || el.name === 'noscript' || el.name === 'code' || el.name === 'pre') return true;
  const cls = ($(el).attr('class') || '') + ' ' + (($(el).attr('id') || ''));
  if (/\bno-translate\b|\busername\b|\blogin\b/i.test(cls)) return true;
  if ($(el).closest('.no-translate, [data-no-translate], script, style').length) return true;
  return false;
}

/**
 * Machine-translate ONLY explicit UGC (.translatable / data-ugc).
 * UI must come from Weblate — never MT over curated locale strings.
 */
async function translateHtmlMachine(html, lang) {
  if (!html || lang === 'ru') return html;
  let translateMany;
  try {
    ({ translateMany } = require('../utils/translator'));
  } catch (e) {
    console.warn('[i18n] translator unavailable:', e.message);
    return html;
  }

  try {
    const $ = cheerio.load(html, { decodeEntities: false });
    const jobs = [];
    const ugcSelector = '.translatable, .translatable-live, [data-ugc]';

    $(ugcSelector).each((i, el) => {
      if (shouldSkipMtNode($, el)) return;

      // Prefer translating the element's own text without nested ugc children duplication
      $(el).contents().each((j, child) => {
        if (child.type !== 'text') return;
        const originalText = child.data || '';
        const trimmed = originalText.trim();
        if (!trimmed || trimmed.length < 2 || trimmed.length > 1800) return;
        if (!hasCyrillic(trimmed)) return;
        const prefix = originalText.match(/^\s*/)[0];
        const suffix = originalText.match(/\s*$/)[0];
        jobs.push({ kind: 'text', child, prefix, suffix, text: trimmed });
      });

      ['title', 'alt', 'placeholder'].forEach((attr) => {
        const val = $(el).attr(attr);
        if (!val || !hasCyrillic(val) || val.length > 1800) return;
        jobs.push({ kind: 'attr', el, attr, text: val.trim() });
      });
    });

    if (!jobs.length) return $.html();

    const unique = [];
    const indexOf = new Map();
    jobs.forEach((job) => {
      // Never MT a string that is a known Weblate source key — force locale value
      const dict = translations[lang] || {};
      if (dict[job.text]) {
        job.forced = dict[job.text];
        return;
      }
      if (!indexOf.has(job.text)) {
        indexOf.set(job.text, unique.length);
        unique.push(job.text);
      }
    });

    const MAX_UNIQUE = 80;
    const slice = unique.slice(0, MAX_UNIQUE);
    const translated = slice.length ? await translateMany(slice, lang, 'ru') : [];
    const map = new Map();
    slice.forEach((src, i) => {
      map.set(src, translated[i] || src);
    });

    jobs.forEach((job) => {
      const tr = job.forced || map.get(job.text);
      if (!tr) return;
      if (job.kind === 'text') {
        job.child.data = job.prefix + tr + job.suffix;
      } else if (job.kind === 'attr') {
        $(job.el).attr(job.attr, tr);
      }
    });

    return $.html();
  } catch (err) {
    console.error('[i18n] machine translate failed:', err.message);
    return html;
  }
}

module.exports = function(req, res, next) {
  // Determine current language
  const currentLang = detectLanguage(req);
  req.lang = currentLang;
  req.supportedLangs = supportedLangs;
  res.locals.currentLang = currentLang;
  res.locals.supportedLangs = supportedLangs;
  res.locals.translations = translations;

  // Middleware translation helper (for manual usage if needed)
  res.locals.t = function(key) {
    return translateString(key, currentLang);
  };

  // Override res.render to intercept rendering and automatically translate
  const originalRender = res.render;
  res.render = function(view, options, callback) {
    originalRender.call(this, view, options, (err, html) => {
      if (err) {
        if (callback) return callback(err);
        return next(err);
      }

      (async () => {
        let translatedHtml = translateHtml(html, currentLang);
        if (currentLang !== 'ru') {
          translatedHtml = await translateHtmlMachine(translatedHtml, currentLang);
        }
        if (callback) {
          callback(null, translatedHtml);
        } else {
          res.send(translatedHtml);
        }
      })().catch((e) => {
        console.error('[i18n] render translate error:', e);
        if (callback) callback(null, html);
        else res.send(html);
      });
    });
  };

  next();
};
