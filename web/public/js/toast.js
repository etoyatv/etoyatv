'use strict';

/**
 * Client UGC auto-translate.
 * UI strings must come from Weblate (server i18n + window.t).
 * Machine translate ONLY elements marked .translatable / .translatable-live / [data-ugc].
 */
(function() {
  const style = document.createElement('style');
  style.innerHTML = `
    #toast-container {
      position: fixed;
      top: 20px;
      right: 20px;
      z-index: 999999;
      display: flex;
      flex-direction: column;
      gap: 10px;
      pointer-events: none;
    }
    
    .yatv-toast {
      background: #2a2e33;
      color: #e0e6ed;
      padding: 16px 24px;
      border-radius: 8px;
      box-shadow: 0 8px 24px rgba(0,0,0,0.4), 0 2px 8px rgba(0,0,0,0.2);
      font-family: 'Inter', 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      font-size: 14px;
      font-weight: 500;
      opacity: 0;
      transform: translateY(-20px) scale(0.95);
      transition: all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275);
      pointer-events: auto;
      border-left: 4px solid #6fdeee;
      display: flex;
      align-items: center;
      gap: 12px;
      max-width: 350px;
      word-wrap: break-word;
    }

    .yatv-toast.toast-error { border-left-color: #ff4d4d; }
    .yatv-toast.toast-success { border-left-color: #39b54a; }
    .yatv-toast.show { opacity: 1; transform: translateY(0) scale(1); }
    .yatv-toast.hide {
      opacity: 0;
      transform: translateY(-20px) scale(0.95);
      transition: all 0.3s ease-in;
    }
    .yatv-toast-icon { font-size: 18px; }
  `;
  document.head.appendChild(style);

  window.showToast = function(message, type = 'info') {
    if (typeof window.t === 'function') {
      message = window.t(message);
    }
    let container = document.getElementById('toast-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'toast-container';
      document.body.appendChild(container);
    }

    const toast = document.createElement('div');
    toast.className = 'yatv-toast';
    
    let icon = 'ℹ️';
    if (message.toLowerCase().includes('ошибка') || type === 'error') {
      toast.classList.add('toast-error');
      icon = '❌';
    } else if (message.toLowerCase().includes('успешно') || message.toLowerCase().includes('скопирована') || type === 'success') {
      toast.classList.add('toast-success');
      icon = '✅';
    }

    const iconSpan = document.createElement('span');
    iconSpan.className = 'yatv-toast-icon';
    iconSpan.textContent = icon;
    const msgSpan = document.createElement('span');
    msgSpan.textContent = message;
    toast.appendChild(iconSpan);
    toast.appendChild(document.createTextNode(' '));
    toast.appendChild(msgSpan);
    container.appendChild(toast);

    void toast.offsetWidth;
    toast.classList.add('show');

    setTimeout(() => {
      toast.classList.remove('show');
      toast.classList.add('hide');
      setTimeout(() => {
        if (toast.parentNode) toast.parentNode.removeChild(toast);
      }, 300);
    }, 3000);
  };

  window.alert = function(message) {
    window.showToast(message);
  };

  window.translateTextClient = async function(text, toLang) {
    if (!text || !String(text).trim()) return text;
    try {
      const res = await fetch('/api/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: String(text), to: toLang, from: 'ru' })
      });
      const data = await res.json();
      if (data && data.success && data.text) return data.text;
    } catch (e) {}
    return text;
  };

  window.autoTranslatePage = async function() {
    const currentLang = (window.xE_lang && window.xE_lang['LANG']) || (typeof xE_lang !== 'undefined' && xE_lang['LANG']) || 'ru';
    if (currentLang === 'ru') return;

    // UGC only — do NOT walk all Cyrillic (that bypasses Weblate UI strings)
    const els = Array.from(document.querySelectorAll('.translatable, .translatable-live, [data-ugc]'));
    if (!els.length) return;

    const payloads = [];
    const targets = [];
    els.forEach((el) => {
      if (!el.dataset.originalText) el.dataset.originalText = el.innerText;
      const original = el.dataset.originalText;
      if (!original || !original.trim()) return;
      if (el.dataset.translatedLang === currentLang) return;
      if (!/[\u0400-\u04FF]/.test(original)) return;
      payloads.push(original);
      targets.push(el);
    });
    if (!payloads.length) return;

    for (let offset = 0; offset < payloads.length; offset += 40) {
      const chunk = payloads.slice(offset, offset + 40);
      const chunkTargets = targets.slice(offset, offset + 40);
      try {
        const res = await fetch('/api/translate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ texts: chunk, to: currentLang, from: 'ru' })
        });
        const data = await res.json();
        if (data && data.success && Array.isArray(data.texts)) {
          data.texts.forEach((tr, j) => {
            const el = chunkTargets[j];
            if (!el || !tr) return;
            el.innerText = tr;
            el.dataset.translatedLang = currentLang;
          });
        }
      } catch (err) {
        console.warn('autoTranslatePage chunk failed', err);
      }
    }
  };

  window.translateElementLive = async function(el) {
    if (!el) return;
    const currentLang = (window.xE_lang && window.xE_lang['LANG']) || 'ru';
    if (currentLang === 'ru') return;
    if (!el.dataset.originalText) el.dataset.originalText = el.textContent || '';
    const original = el.dataset.originalText;
    if (!original.trim() || !/[\u0400-\u04FF]/.test(original)) return;
    if (el.dataset.translatedLang === currentLang) return;
    const tr = await window.translateTextClient(original, currentLang);
    if (tr && tr !== original) {
      el.textContent = tr;
      el.dataset.translatedLang = currentLang;
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      window.autoTranslatePage();
      setTimeout(() => window.autoTranslatePage(), 1500);
    });
  } else {
    window.autoTranslatePage();
    setTimeout(() => window.autoTranslatePage(), 1500);
  }
})();
