document.addEventListener('DOMContentLoaded', () => {
  const socket = io();
  const svgPlay = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle;"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>`;
  const svgPause = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle;"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg>`;

  const urlParams = new URLSearchParams(window.location.search);
  const autoplayParam = urlParams.get('autoplay');
  let enableAutoplay = autoplayParam !== '0' && autoplayParam !== 'false';

  // Elements
  const video = document.getElementById('etoyatv-video');
  const btnPlayPause = document.getElementById('btn-play-pause');
  const btnVolume = document.getElementById('btn-volume');
  const btnFullscreen = document.getElementById('btn-fullscreen');
  const spinner = document.getElementById('etoyatv-spinner');
  const viewersCount = document.getElementById('viewers-count');
  const chatViewersCount = document.getElementById('chat-viewers-count');
  const chatMessages = document.getElementById('chat_text_field');
  const chatInput = document.getElementById('chat-input');
  const btnChatMenu = document.getElementById('btn-chat-menu');
  const chatMenu = document.getElementById('chat-menu');
  const chatUsersList = document.getElementById('chat-users-list');

  if (video) {
    video.addEventListener('loadstart', () => { if (spinner) spinner.style.display = 'block'; });
    video.addEventListener('waiting', () => { if (spinner) spinner.style.display = 'block'; });
    video.addEventListener('playing', () => { if (spinner) spinner.style.display = 'none'; });
    video.addEventListener('canplay', () => { if (spinner) spinner.style.display = 'none'; });
  }

  let guestName = localStorage.getItem('etoyatv_guest_name');
  if (!window.CURRENT_USER && !guestName) {
    guestName = 'Гость_' + Math.floor(Math.random() * 10000);
    localStorage.setItem('etoyatv_guest_name', guestName);
  }

  const chatColorBtn = document.getElementById('chat-color-btn');
  const chatColorPicker = document.getElementById('chat-color-picker');

  let savedColor = localStorage.getItem('etoyatv_chat_color');
  if (!savedColor && window.CURRENT_USER && window.CURRENT_USER.chat_color) {
    savedColor = window.CURRENT_USER.chat_color;
    localStorage.setItem('etoyatv_chat_color', savedColor);
  }
  if (savedColor) {
    if (chatColorPicker) {
      chatColorPicker.value = savedColor;
    }
    if (chatColorBtn) {
      chatColorBtn.style.backgroundColor = savedColor;
    }
  }

  // --- Active Chat Users Colors & Reply Verification ---
  const chatUserColors = {};

  function registerUserColor(username, color) {
    if (!username) return;
    chatUserColors[username.toLowerCase()] = color || '#3b9cd9';
  }

  function initUserColorsMap() {
    document.querySelectorAll('.chat-username').forEach(el => {
      const username = el.getAttribute('data-username');
      const color = el.getAttribute('data-color') || el.style.color;
      registerUserColor(username, color);
    });
  }

  // Initialize colors from existing elements on load
  initUserColorsMap();

  // --- Socket.io Setup ---
  socket.on('connect', () => {
    console.log('[SOCKET] Player connected, sending join_channel...');
    socket.emit('join_channel', {
      channelId: window.CHANNEL_ID,
      user: window.CURRENT_USER,
      userToken: window.CURRENT_USER_TOKEN,
      guestName: guestName,
      color: document.getElementById('chat-color-picker')?.value || '#3b9cd9'
    });
  });

  socket.on('update_users', ({ count, users }) => {
    if (viewersCount) viewersCount.textContent = count;
    if (chatViewersCount) {
      chatViewersCount.textContent = count;
      const prefix = document.getElementById('chat-viewers-prefix');
      if (prefix) prefix.style.display = 'inline';
    }
    const viewersCountPlayer = document.getElementById('viewers-count-player');
    if (viewersCountPlayer) viewersCountPlayer.textContent = count;

    const list = document.getElementById('chat-users-list');
    if (list) {
      list.innerHTML = '';

      users.sort((a, b) => {
        const getWeight = (role) => {
          if (role === 'admin') return 1;
          if (role === 'mod') return 2;
          if (role === 'owner') return 3;
          if (role === 'alien') return 3.5; // less than owner, more than moderator
          if (role === 'moderator') return 4; // channel moderator
          if (role === 'guest') return 6;
          return 5; // user / registered
        };
        const weightA = getWeight(a.role);
        const weightB = getWeight(b.role);
        if (weightA !== weightB) return weightA - weightB;
        return a.username.localeCompare(b.username);
      });

      users.forEach(u => {
        registerUserColor(u.username, u.color);

        const div = document.createElement('div');
        div.style.marginTop = '5px';
        div.style.color = u.color || '#fff';
        div.style.fontWeight = 'bold';
        div.style.display = 'flex';
        div.style.alignItems = 'center';
        div.style.gap = '3px';

        let icon = '<img src="/images/chat/user.svg" style="width: 14px; height: 14px; vertical-align: text-bottom;">';
        if (u.role === 'owner') icon = '<img src="/images/chat/owner.svg" style="width: 14px; height: 14px; vertical-align: text-bottom;">';
        else if (u.role === 'alien') icon = '<img src="/images/chat/admin.svg" style="width: 14px; height: 14px; vertical-align: text-bottom;">';
        else if (u.role === 'admin') icon = '<img src="/images/chat/admin.svg" style="width: 14px; height: 14px; vertical-align: text-bottom;">';
        else if (u.role === 'mod' || u.role === 'moderator') icon = '<img src="/images/chat/moderator.svg" style="width: 14px; height: 14px; vertical-align: text-bottom;">';
        else if (u.role === 'registered' || u.role === 'editor' || u.role === 'reporter') icon = '<img src="/images/chat/user.svg" style="width: 14px; height: 14px; vertical-align: text-bottom;">';
        else if (u.role === 'guest') {
          icon = '<img src="/images/chat/guest.svg" style="width: 14px; height: 14px; vertical-align: text-bottom;">';
        }

        if (u.isBanned) {
          icon = '<img src="/images/chat/banned.svg" style="width: 14px; height: 14px; vertical-align: text-bottom;">';
        }

        const textStyle = u.isBanned ? 'text-decoration: line-through; color: #888;' : '';

        let userColor = u.color || '#fff';

        div.className = 'chat-username';
        div.setAttribute('data-username', u.username);
        div.setAttribute('data-role', u.role);
        div.setAttribute('data-color', userColor);
        div.setAttribute('data-banned', u.isBanned ? 'true' : 'false');
        div.style.cssText = `margin: 2px 0; color: ${userColor}; font-weight: bold; cursor: pointer; display: flex; align-items: center; gap: 3px;`;

        div.innerHTML = `${icon} <span style="${textStyle}">${escapeHTML(u.username)}</span>`;
        list.appendChild(div);
      });
    }
  });

  socket.on('chat_cleared', () => {
    if (chatMessages) chatMessages.innerHTML = '';
    const pinnedBox = document.getElementById('chat_pinned_box');
    if (pinnedBox) {
      pinnedBox.style.display = 'none';
      const pinnedContent = document.getElementById('chat_pinned_content');
      if (pinnedContent) pinnedContent.innerHTML = '';
    }
  });

  socket.on('guests_toggled', (allowed) => {
    if (!window.CURRENT_USER) {
      const inputsDiv = document.querySelector('.inputs');
      const loginDiv = document.querySelector('.login');
      if (allowed) {
        if (inputsDiv) inputsDiv.style.display = 'flex';
        if (loginDiv) loginDiv.style.display = 'none';
      } else {
        if (inputsDiv) inputsDiv.style.display = 'none';
        if (loginDiv) loginDiv.style.display = 'flex';
        // Add text indicating guests are banned
        if (loginDiv && !loginDiv.innerHTML.includes('запретили')) {
          loginDiv.innerHTML = 'Гостям запрещено писать. <a href="/login" target="_blank" style="color: #F2FFF9; margin-left: 4px; text-decoration: underline;">Войти</a>';
        }
      }
    }
  });

  socket.on('new_message', (msg) => {
    registerUserColor(msg.username || msg.guest_name, msg.color);

    const div = document.createElement('div');
    div.className = 'chat-message-row';
    div.style.font = '11px Verdana, Geneva, sans-serif';
    div.style.color = '#fff';
    div.style.margin = '1px';
    div.style.wordWrap = 'break-word';
    div.style.overflowWrap = 'break-word';
    div.style.whiteSpace = 'pre-wrap';

    let roleColor = msg.color || '#3b9cd9'; // Use custom color if present, else fallback

    const now = new Date();
    let timeStr = '';
    try {
      timeStr = new Intl.DateTimeFormat('ru-RU', {
        hour: '2-digit',
        minute: '2-digit',
        timeZone: window.USER_TIMEZONE || 'Europe/Moscow'
      }).format(now);
    } catch (e) {
      timeStr = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
    }

    const senderNick = msg.username || msg.guest_name || 'Гость';
    const escapedUser = escapeHTML(senderNick);
    const escapedRole = escapeHTML(msg.role || 'guest');

    let pinButtonHtml = '';
    if (window.IS_MODERATOR === true) {
      pinButtonHtml = ` <span class="btn-pin-message" data-msg-id="${msg.id}" title="Закрепить">📌</span>`;
    }

    let rawMsg = msg.message || '';
    let isReply = false;
    let replyTo = '';
    let restOfMsg = rawMsg;

    const replyMatch = rawMsg.match(/^([a-zA-Z0-9_\-\u0400-\u04FF\.]{2,25}),\s*(.*)$/);
    if (replyMatch) {
      const potentialRecipient = replyMatch[1];
      if (chatUserColors[potentialRecipient.toLowerCase()] && potentialRecipient.toLowerCase() !== senderNick.toLowerCase()) {
        isReply = true;
        replyTo = potentialRecipient;
        restOfMsg = replyMatch[2];
      }
    }

    let nameHtml = '';
    if (isReply) {
      const recipientColor = chatUserColors[replyTo.toLowerCase()] || '#3b9cd9';
      const escapedRecipient = escapeHTML(replyTo);
      nameHtml = `<span style="color: ${roleColor}; font-weight: bold;"><span class="chat-username" data-username="${escapedUser}" data-color="${roleColor}" data-role="${escapedRole}" style="cursor: pointer;">${escapedUser}</span></span><span style="color: #fff;">&gt;</span><span style="color: ${recipientColor}; font-weight: bold;"><span class="chat-username" data-username="${escapedRecipient}" data-color="${recipientColor}" style="cursor: pointer;">${escapedRecipient}</span>,</span>`;
    } else {
      nameHtml = `<span style="color: ${roleColor}; font-weight: bold;"><span class="chat-username" data-username="${escapedUser}" data-color="${roleColor}" data-role="${escapedRole}" style="cursor: pointer;">${escapedUser}</span>:</span>`;
    }

    div.innerHTML = `<span style="color: #666;">${timeStr}</span> ${nameHtml} ${escapeHTML(isReply ? restOfMsg : rawMsg)}${pinButtonHtml}`;

    if (chatMessages) {
      chatMessages.appendChild(div);
      scrollToBottom();
    }
  });

  socket.on('message_pinned', (data) => {
    const pinnedBox = document.getElementById('chat_pinned_box');
    const pinnedContent = document.getElementById('chat_pinned_content');
    if (pinnedBox && pinnedContent) {
      const username = data.username || data.guest_name || 'Гость';
      const color = data.color || '#3b9cd9';
      const msgText = data.message || '';
      pinnedContent.innerHTML = `<span style="color: ${color}; font-weight: bold;">${escapeHTML(username)}</span>: ${escapeHTML(msgText)}`;
      pinnedBox.style.display = 'flex';
    }
  });

  socket.on('message_unpinned', () => {
    const pinnedBox = document.getElementById('chat_pinned_box');
    if (pinnedBox) {
      pinnedBox.style.display = 'none';
      const pinnedContent = document.getElementById('chat_pinned_content');
      if (pinnedContent) pinnedContent.innerHTML = '';
    }
  });

  function updateChatPlaceholder() {
    const isBanned = window.USER_IS_BANNED || false;
    if (chatInput) {
      if (!window.CHAT_ENABLED) {
        chatInput.disabled = true;
        chatInput.placeholder = 'Чат выключен';
      } else {
        chatInput.disabled = isBanned;
        chatInput.placeholder = isBanned ? (window.BAN_TEXT || 'Вы заблокированы') : 'Написать...';
      }
    }
  }

  socket.on('chat_toggled', (enabled) => {
    window.CHAT_ENABLED = enabled;
    updateChatPlaceholder();
    const chatDisabledMsg = document.getElementById('chat_disabled_msg');
    if (chatMessages) {
      chatMessages.style.display = enabled ? 'flex' : 'none';
      if (enabled) {
        scrollToBottom();
      }
    }
    if (chatDisabledMsg) {
      chatDisabledMsg.style.display = enabled ? 'none' : 'flex';
    }
  });

  socket.on('user_banned_state', (data) => {
    window.USER_IS_BANNED = data.isBanned;
    if (data.isBanned && data.banned_until) {
      const d = new Date(data.banned_until);
      const dd = String(d.getDate()).padStart(2, '0');
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const yyyy = d.getFullYear();
      const HH = String(d.getHours()).padStart(2, '0');
      const MM = String(d.getMinutes()).padStart(2, '0');
      window.BAN_TEXT = `Вы заблокированы до ${dd}.${mm}.${yyyy} ${HH}:${MM}`;
    } else {
      window.BAN_TEXT = 'Вы заблокированы';
    }
    updateChatPlaceholder();
  });

  socket.on('guest_name_changed', (data) => {
    guestName = data.name;
    localStorage.setItem('etoyatv_guest_name', guestName);
  });

  socket.on('guest_name_error', (data) => {
    alert(data.error || 'Ошибка смены никнейма');
  });

  // --- Chat Input & Color ---
  const chatColorPalette = document.getElementById('chat-color-palette');

  if (chatColorBtn && chatColorPalette) {
    const spectrumCanvas = chatColorPalette.querySelector('.chat-color-spectrum');
    const sliderCanvas = chatColorPalette.querySelector('.chat-color-slider');

    function rgbToHsv(r, g, b) {
      r /= 255; g /= 255; b /= 255;
      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      let h, s, v = max;
      const d = max - min;
      s = max === 0 ? 0 : d / max;
      if (max === min) {
        h = 0;
      } else {
        switch (max) {
          case r: h = (g - b) / d + (g < b ? 6 : 0); break;
          case g: h = (b - r) / d + 2; break;
          case b: h = (r - g) / d + 4; break;
        }
        h /= 6;
      }
      return [h, s, v];
    }

    function hsvToRgb(h, s, v) {
      let r, g, b;
      const i = Math.floor(h * 6);
      const f = h * 6 - i;
      const p = v * (1 - s);
      const q = v * (1 - f * s);
      const t = v * (1 - (1 - f) * s);
      switch (i % 6) {
        case 0: r = v; g = t; b = p; break;
        case 1: r = q; g = v; b = p; break;
        case 2: r = p; g = v; b = t; break;
        case 3: r = p; g = q; b = v; break;
        case 4: r = t; g = p; b = v; break;
        case 5: r = v; g = p; b = q; break;
      }
      return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
    }

    function rgbToHex(r, g, b) {
      const toHex = (c) => {
        const hex = c.toString(16);
        return hex.length === 1 ? '0' + hex : hex;
      };
      return '#' + toHex(r) + toHex(g) + toHex(b);
    }

    function makeColorReadable(hex) {
      if (!hex || typeof hex !== 'string') return '#3b9cd9';
      let cleanHex = hex.replace('#', '');
      if (cleanHex.length === 3) {
        cleanHex = cleanHex[0] + cleanHex[0] + cleanHex[1] + cleanHex[1] + cleanHex[2] + cleanHex[2];
      }
      if (cleanHex.length !== 6) return '#3b9cd9';
      let r = parseInt(cleanHex.substring(0, 2), 16);
      let g = parseInt(cleanHex.substring(2, 4), 16);
      let b = parseInt(cleanHex.substring(4, 6), 16);
      if (isNaN(r) || isNaN(g) || isNaN(b)) return '#3b9cd9';
      if (r === 0 && g === 0 && b === 0) {
        r = 100; g = 100; b = 100;
      }
      let brightness = 0.299 * r + 0.587 * g + 0.114 * b;
      let iterations = 0;
      while (brightness < 70 && iterations < 15) {
        r = Math.round(r + (255 - r) * 0.2);
        g = Math.round(g + (255 - g) * 0.2);
        b = Math.round(b + (255 - b) * 0.2);
        brightness = 0.299 * r + 0.587 * g + 0.114 * b;
        iterations++;
      }
      const toHex = (c) => {
        const hex = c.toString(16);
        return hex.length === 1 ? '0' + hex : hex;
      };
      return '#' + toHex(r) + toHex(g) + toHex(b);
    }

    function drawSpectrum(canvas, hSelected, sSelected) {
      const ctx = canvas.getContext('2d');
      const w = canvas.width;
      const h = canvas.height;
      const hueGrad = ctx.createLinearGradient(0, 0, w, 0);
      hueGrad.addColorStop(0, '#ff0000');
      hueGrad.addColorStop(0.17, '#ffff00');
      hueGrad.addColorStop(0.33, '#00ff00');
      hueGrad.addColorStop(0.5, '#00ffff');
      hueGrad.addColorStop(0.67, '#0000ff');
      hueGrad.addColorStop(0.83, '#ff00ff');
      hueGrad.addColorStop(1, '#ff0000');
      ctx.fillStyle = hueGrad;
      ctx.fillRect(0, 0, w, h);

      const satGrad = ctx.createLinearGradient(0, 0, 0, h);
      satGrad.addColorStop(0, 'rgba(255, 255, 255, 0)');
      satGrad.addColorStop(1, 'rgba(255, 255, 255, 1)');
      ctx.fillStyle = satGrad;
      ctx.fillRect(0, 0, w, h);

      const cx = hSelected * w;
      const cy = (1 - sSelected) * h;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(cx - 5, cy); ctx.lineTo(cx + 5, cy);
      ctx.moveTo(cx, cy - 5); ctx.lineTo(cx, cy + 5);
      ctx.stroke();

      ctx.strokeStyle = '#000000';
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.moveTo(cx - 5, cy); ctx.lineTo(cx - 2, cy);
      ctx.moveTo(cx + 2, cy); ctx.lineTo(cx + 5, cy);
      ctx.moveTo(cx, cy - 5); ctx.lineTo(cx, cy - 2);
      ctx.moveTo(cx, cy + 2); ctx.lineTo(cx, cy + 5);
      ctx.stroke();
    }

    function drawSlider(canvas, hSelected, sSelected, vSelected) {
      const ctx = canvas.getContext('2d');
      const w = canvas.width;
      const h = canvas.height;
      const rgbBase = hsvToRgb(hSelected, sSelected, 1);
      const baseColor = `rgb(${rgbBase[0]}, ${rgbBase[1]}, ${rgbBase[2]})`;
      const valGrad = ctx.createLinearGradient(0, 0, 0, h);
      valGrad.addColorStop(0, baseColor);
      valGrad.addColorStop(1, '#000000');
      ctx.fillStyle = valGrad;
      ctx.fillRect(0, 0, w, h);

      const cy = (1 - vSelected) * h;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.strokeRect(0, cy - 1, w, 2);
      ctx.strokeStyle = '#000000';
      ctx.lineWidth = 1;
      ctx.strokeRect(-1, cy - 2, w + 2, 4);
    }

    let hueVal = 0, satVal = 1, valVal = 1;

    function updateFromHex(hex) {
      if (!hex.startsWith('#')) hex = '#' + hex;
      const r = parseInt(hex.slice(1, 3), 16) || 0;
      const g = parseInt(hex.slice(3, 5), 16) || 0;
      const b = parseInt(hex.slice(5, 7), 16) || 0;
      const hsv = rgbToHsv(r, g, b);
      hueVal = hsv[0];
      satVal = hsv[1];
      valVal = hsv[2];
    }

    function render() {
      if (spectrumCanvas && sliderCanvas) {
        drawSpectrum(spectrumCanvas, hueVal, satVal);
        drawSlider(sliderCanvas, hueVal, satVal, valVal);
      }
    }

    function triggerChange() {
      const rgb = hsvToRgb(hueVal, satVal, valVal);
      let hex = rgbToHex(rgb[0], rgb[1], rgb[2]);
      hex = makeColorReadable(hex);
      if (chatColorPicker) chatColorPicker.value = hex;
      chatColorBtn.style.backgroundColor = hex;
      localStorage.setItem('etoyatv_chat_color', hex);
      socket.emit('update_chat_color', { color: hex });
    }

    let isDraggingSpectrum = false;
    let isDraggingSlider = false;

    function handleSpectrumMove(e) {
      if (!spectrumCanvas) return;
      const rect = spectrumCanvas.getBoundingClientRect();
      let x = e.clientX - rect.left;
      let y = e.clientY - rect.top;
      x = Math.max(0, Math.min(x, rect.width));
      y = Math.max(0, Math.min(y, rect.height));
      hueVal = x / rect.width;
      satVal = 1 - (y / rect.height);
      render();
      triggerChange();
    }

    function handleSliderMove(e) {
      if (!sliderCanvas) return;
      const rect = sliderCanvas.getBoundingClientRect();
      let y = e.clientY - rect.top;
      y = Math.max(0, Math.min(y, rect.height));
      valVal = 1 - (y / rect.height);
      render();
      triggerChange();
    }

    if (spectrumCanvas) {
      spectrumCanvas.addEventListener('mousedown', (e) => {
        isDraggingSpectrum = true;
        handleSpectrumMove(e);
      });
    }

    if (sliderCanvas) {
      sliderCanvas.addEventListener('mousedown', (e) => {
        isDraggingSlider = true;
        handleSliderMove(e);
      });
    }

    document.addEventListener('mousemove', (e) => {
      if (isDraggingSpectrum) handleSpectrumMove(e);
      if (isDraggingSlider) handleSliderMove(e);
    });

    document.addEventListener('mouseup', () => {
      isDraggingSpectrum = false;
      isDraggingSlider = false;
    });

    // Touch support
    function handleSpectrumTouch(e) {
      if (e.touches.length === 0 || !spectrumCanvas) return;
      const touch = e.touches[0];
      const rect = spectrumCanvas.getBoundingClientRect();
      let x = touch.clientX - rect.left;
      let y = touch.clientY - rect.top;
      x = Math.max(0, Math.min(x, rect.width));
      y = Math.max(0, Math.min(y, rect.height));
      hueVal = x / rect.width;
      satVal = 1 - (y / rect.height);
      render();
      triggerChange();
    }

    function handleSliderTouch(e) {
      if (e.touches.length === 0 || !sliderCanvas) return;
      const touch = e.touches[0];
      const rect = sliderCanvas.getBoundingClientRect();
      let y = touch.clientY - rect.top;
      y = Math.max(0, Math.min(y, rect.height));
      valVal = 1 - (y / rect.height);
      render();
      triggerChange();
    }

    if (spectrumCanvas) {
      spectrumCanvas.addEventListener('touchstart', (e) => {
        e.preventDefault();
        isDraggingSpectrum = true;
        handleSpectrumTouch(e);
      });
      spectrumCanvas.addEventListener('touchmove', (e) => {
        e.preventDefault();
        if (isDraggingSpectrum) handleSpectrumTouch(e);
      });
    }

    if (sliderCanvas) {
      sliderCanvas.addEventListener('touchstart', (e) => {
        e.preventDefault();
        isDraggingSlider = true;
        handleSliderTouch(e);
      });
      sliderCanvas.addEventListener('touchmove', (e) => {
        e.preventDefault();
        if (isDraggingSlider) handleSliderTouch(e);
      });
    }

    chatColorBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      chatColorPalette.style.display = chatColorPalette.style.display === 'none' ? 'flex' : 'none';
      if (chatColorPalette.style.display === 'flex') {
        const chatMenu = document.getElementById('chat-menu');
        if (chatMenu) chatMenu.style.display = 'none';
        if (chatColorPicker && chatColorPicker.value) {
          updateFromHex(chatColorPicker.value);
        }
        render();
      }
    });

    document.addEventListener('click', (e) => {
      if (!chatColorPalette.contains(e.target) && e.target !== chatColorBtn) {
        chatColorPalette.style.display = 'none';
      }
    });

    // Initialize values
    if (chatColorPicker && chatColorPicker.value) {
      updateFromHex(chatColorPicker.value);
    }
    render();
  }

  function sendChatMessage() {
    const message = chatInput.value.trim();
    if (message) {
      const chatColorPicker = document.getElementById('chat-color-picker');
      let color = chatColorPicker ? chatColorPicker.value : '#3b9cd9';
      if (!color.startsWith('#')) color = '#' + color;
      socket.emit('send_message', {
        channelId: window.CHANNEL_ID,
        message: message,
        color: color
      });
      chatInput.value = '';
    }
  }

  chatInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      sendChatMessage();
    }
  });

  const btnChatSubmit = document.getElementById('btn-chat-submit');
  if (btnChatSubmit) {
    btnChatSubmit.addEventListener('click', sendChatMessage);
  }

  // --- Video Controls ---
  // Click video to play/pause
  if (video) {
    video.addEventListener('click', () => {
      enableAutoplay = true; // User interacted
      if (video && video.paused) {
        video.play().catch(e => { }); // Prime for user gesture
        if (window.CHANNEL_ID && typeof fetchAutopilotStatus === 'function') {
          fetchAutopilotStatus(true);
        } else {
          video.play();
        }
      } else if (video) {
        video.pause();
      }
    });
    video.addEventListener('play', () => btnPlayPause.innerHTML = svgPause);
    video.addEventListener('pause', () => btnPlayPause.innerHTML = svgPlay);
  }

  btnPlayPause.addEventListener('click', () => {
    enableAutoplay = true; // User interacted
    if (video && video.paused) {
      video.play().catch(e => { }); // Prime for user gesture
      if (window.CHANNEL_ID && typeof fetchAutopilotStatus === 'function') {
        fetchAutopilotStatus(true);
      } else {
        video.play();
      }
      btnPlayPause.innerHTML = svgPause;
    } else if (video) {
      video.pause();
      btnPlayPause.innerHTML = svgPlay;
    }
  });

  // Volume control
  const volumeSlider = document.getElementById('volume-slider');

  let savedVolume = localStorage.getItem('etoyatv_volume');
  let savedMuted = localStorage.getItem('etoyatv_muted') === 'true';

  const initVol = savedVolume !== null ? parseFloat(savedVolume) : 1;
  if (video) {
    video.volume = initVol;
    video.muted = savedMuted;
  }

  if (btnVolume) btnVolume.textContent = savedMuted ? '🔇' : '🔊';
  if (volumeSlider) {
    volumeSlider.value = savedMuted ? 0 : initVol;
  }

  if (volumeSlider) {
    volumeSlider.addEventListener('input', (e) => {
      const vol = parseFloat(e.target.value);
      const muted = vol === 0;
      if (video) { 
        video.volume = vol; 
        video.muted = muted; 
      }
      if (btnVolume) btnVolume.textContent = muted ? '🔇' : '🔊';
      localStorage.setItem('etoyatv_volume', vol);
      localStorage.setItem('etoyatv_muted', muted);
    });
  }

  if (btnVolume) {
    btnVolume.addEventListener('click', () => {
      const isMuted = video && !video.muted;
      let vol = parseFloat(localStorage.getItem('etoyatv_volume'));
      if (isNaN(vol) || vol === 0) {
        vol = 1; // Default to max if we're unmuting from a 0-volume state
      }

      if (video) {
        video.muted = isMuted;
        video.volume = isMuted ? 0 : vol;
      }

      btnVolume.textContent = isMuted ? '🔇' : '🔊';
      if (volumeSlider) {
        volumeSlider.value = isMuted ? 0 : vol;
      }
      localStorage.setItem('etoyatv_muted', isMuted);
      if (!isMuted) {
        localStorage.setItem('etoyatv_volume', vol);
      }
    });
  }

  // Hotkeys for volume (ArrowUp / ArrowDown)
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      if (!video) return;

      let vol = video.volume;
      if (e.key === 'ArrowUp') {
        vol = Math.min(1, vol + 0.1);
      } else {
        vol = Math.max(0, vol - 0.1);
      }

      video.volume = vol;
      video.muted = vol === 0;

      if (btnVolume) btnVolume.textContent = video.muted ? '🔇' : '🔊';
      if (volumeSlider) volumeSlider.value = vol;

      localStorage.setItem('etoyatv_volume', vol);
      localStorage.setItem('etoyatv_muted', video.muted);
    }
  });

  btnFullscreen.addEventListener('click', () => {
    const playerContainer = document.getElementById('container_swf');
    if (!document.fullscreenElement) {
      playerContainer.requestFullscreen().catch(err => {
        alert(`Error attempting to enable fullscreen: ${err.message}`);
      });
    } else {
      document.exitFullscreen();
    }
  });

  // Auto-hide player controls
  const playerContainer = document.getElementById('container_swf');
  if (playerContainer) {
    const uiElements = playerContainer.querySelectorAll('.player-ui');
    let hideTimeout;

    function showControls() {
      uiElements.forEach(el => el.style.opacity = '1');
      const liveIdle = document.getElementById('player_live_idle');
      if (liveIdle) liveIdle.style.opacity = '0';
      clearTimeout(hideTimeout);
      hideTimeout = setTimeout(() => {
        if (video && !video.paused) { // only hide if playing
          uiElements.forEach(el => el.style.opacity = '0');
          if (liveIdle) liveIdle.style.opacity = '1';
        }
      }, 3000);
    }

    playerContainer.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (!video) return;

      let vol = video.volume;
      if (e.deltaY < 0) {
        vol = Math.min(1, vol + 0.05);
      } else {
        vol = Math.max(0, vol - 0.05);
      }

      video.volume = vol;
      video.muted = vol === 0;

      if (btnVolume) btnVolume.textContent = video.muted ? '🔇' : '🔊';
      if (volumeSlider) volumeSlider.value = vol;

      localStorage.setItem('etoyatv_volume', vol);
      localStorage.setItem('etoyatv_muted', video.muted);
    });

    playerContainer.addEventListener('mousemove', showControls);
    playerContainer.addEventListener('mouseenter', showControls);
    playerContainer.addEventListener('mouseleave', () => {
      clearTimeout(hideTimeout);
      if (video && !video.paused) {
        uiElements.forEach(el => el.style.opacity = '0');
        const liveIdle = document.getElementById('player_live_idle');
        if (liveIdle) liveIdle.style.opacity = '1';
      }
    });

    if (video) {
      video.addEventListener('play', showControls);
      video.addEventListener('pause', () => {
        uiElements.forEach(el => el.style.opacity = '1');
        clearTimeout(hideTimeout);
      });
    }

    // Show initially
    showControls();
  }

  // Toggle Action Menu
  if (btnChatMenu && chatMenu) {
    btnChatMenu.addEventListener('click', (e) => {
      e.stopPropagation();
      chatMenu.style.display = chatMenu.style.display === 'none' ? 'block' : 'none';
      if (chatMenu.style.display === 'block') {
        const chatColorPalette = document.getElementById('chat-color-palette');
        if (chatColorPalette) chatColorPalette.style.display = 'none';
      }
    });

    document.addEventListener('click', (e) => {
      if (!chatMenu.contains(e.target) && e.target !== btnChatMenu) {
        chatMenu.style.display = 'none';
      }
    });

    // Moderation events
    const btnClearChat = document.getElementById('btn-clear-chat');
    if (btnClearChat) {
      btnClearChat.addEventListener('click', () => {
        socket.emit('clear_chat');
        chatMenu.style.display = 'none';
      });
    }

    const btnBanGuests = document.getElementById('btn-ban-guests');
    if (btnBanGuests) {
      btnBanGuests.addEventListener('click', () => {
        const isBanning = btnBanGuests.textContent.includes('Запретить');
        socket.emit('toggle_guests', { allowed: !isBanning });
        btnBanGuests.textContent = isBanning ? 'Разрешить гостей' : 'Запретить гостей';
        chatMenu.style.display = 'none';
      });
    }

    const btnToggleChat = document.getElementById('btn-toggle-chat');
    if (btnToggleChat) {
      btnToggleChat.addEventListener('click', () => {
        const isDisabling = btnToggleChat.textContent.includes('Выключить');
        socket.emit('toggle_chat', { enabled: !isDisabling });
        btnToggleChat.textContent = isDisabling ? 'Включить чат' : 'Выключить чат';
        chatMenu.style.display = 'none';
      });
    }

    const btnChangeGuestNick = document.getElementById('btn-change-guest-nick');
    if (btnChangeGuestNick) {
      btnChangeGuestNick.addEventListener('click', () => {
        if (window.USER_IS_BANNED) {
          alert('Вы не можете сменить никнейм, так как ваш IP-адрес заблокирован.');
          chatMenu.style.display = 'none';
          return;
        }
        const newNick = prompt('Введите новый никнейм (максимум 13 символов):', guestName);
        if (newNick && newNick.trim()) {
          let trimmedNick = newNick.trim();
          if (trimmedNick.length > 13) {
            alert('Никнейм не должен превышать 13 символов!');
            return;
          }
          socket.emit('change_guest_name', { newName: trimmedNick });
        }
        chatMenu.style.display = 'none';
      });
    }
  }

  // --- Chat Context Menu & Bans ---
  const userContextMenu = document.getElementById('user-context-menu');
  let contextMenuTargetUser = null;

  document.addEventListener('click', (e) => {
    // Pin message click delegation
    const pinBtn = e.target.closest('.btn-pin-message');
    if (pinBtn) {
      const messageId = pinBtn.getAttribute('data-msg-id');
      if (messageId) {
        socket.emit('pin_message', { messageId: parseInt(messageId) });
      }
      return;
    }

    // Unpin message click delegation
    const unpinBtn = e.target.closest('#btn-chat-unpin');
    if (unpinBtn) {
      socket.emit('unpin_message');
      return;
    }

    // Hide context menu if clicking outside
    if (userContextMenu && !userContextMenu.contains(e.target)) {
      userContextMenu.style.display = 'none';
    }

    // Check if clicked on a username
    const usernameEl = e.target.closest('.chat-username');
    if (usernameEl && userContextMenu) {
      e.stopPropagation();
      contextMenuTargetUser = usernameEl.getAttribute('data-username');

      const inMessages = usernameEl.closest('#chat_text_field');
      if (inMessages) {
        const chatInput = document.getElementById('chat-input');
        if (chatInput && !chatInput.disabled) {
          if (chatInput.value.trim() === '') {
            chatInput.value += `${contextMenuTargetUser}, `;
            chatInput.focus();
          }
        }
        return; // Do not show context menu when clicking in chat history
      }

      const targetRole = usernameEl.getAttribute('data-role');
      const isTargetBanned = usernameEl.getAttribute('data-banned') === 'true';

      const getRoleWeight = (role) => {
        if (role === 'admin') return 1;
        if (role === 'mod') return 2;
        if (role === 'owner') return 3;
        if (role === 'alien') return 3.5;
        if (role === 'moderator') return 4;
        if (role === 'guest') return 6;
        return 5;
      };

      let clickerRole = 'guest';
      if (window.CURRENT_USER) {
        clickerRole = window.CURRENT_USER.role || 'registered';
        if (window.CURRENT_USER.id === window.CHANNEL_OWNER_ID && clickerRole !== 'admin' && clickerRole !== 'mod') {
          clickerRole = 'owner';
        }
      }

      const clickerWeight = getRoleWeight(clickerRole);
      const targetWeight = getRoleWeight(targetRole);

      let menuHtml = '';
      if (targetRole !== 'guest') {
        menuHtml += `<div class="menu-item ctx-profile" style="padding: 5px 10px; color: #fff; cursor: pointer;">Профиль</div>`;
      }

      const canBan = clickerWeight <= 4 && clickerWeight < targetWeight;

      if (canBan) {
        if (isTargetBanned) {
          menuHtml += `<div class="menu-item ctx-unban" style="padding: 5px 10px; color: #00ff00; cursor: pointer;">Разблокировать</div>`;
        } else {
          menuHtml += `<div class="menu-item ctx-ban" data-duration="10" style="padding: 5px 10px; color: #ff0000; cursor: pointer;">Заблокировать (10 м.)</div>`;
          menuHtml += `<div class="menu-item ctx-ban" data-duration="60" style="padding: 5px 10px; color: #ff0000; cursor: pointer;">Заблокировать (1 ч.)</div>`;
          menuHtml += `<div class="menu-item ctx-ban" data-duration="1440" style="padding: 5px 10px; color: #ff0000; cursor: pointer;">Заблокировать (1 дн.)</div>`;
          menuHtml += `<div class="menu-item ctx-ban" data-duration="perm" style="padding: 5px 10px; color: #ff0000; cursor: pointer;">Заблокировать (Навсегда)</div>`;
        }
      }

      if (menuHtml === '') return;

      userContextMenu.innerHTML = menuHtml;
      userContextMenu.style.left = `${e.pageX}px`;
      userContextMenu.style.top = `${e.pageY}px`;
      userContextMenu.style.display = 'block';

      // Attach context menu actions
      const btnProfile = userContextMenu.querySelector('.ctx-profile');
      if (btnProfile) {
        btnProfile.addEventListener('click', () => {
          window.open('/ru/account,userinfo/?username=' + encodeURIComponent(contextMenuTargetUser), '_blank');
          userContextMenu.style.display = 'none';
        });
      }

      const btnBans = userContextMenu.querySelectorAll('.ctx-ban');
      btnBans.forEach(btnBan => {
        btnBan.addEventListener('click', (e) => {
          const duration = e.currentTarget.getAttribute('data-duration');
          socket.emit('ban_user', { targetUsername: contextMenuTargetUser, duration: duration });
          userContextMenu.style.display = 'none';
        });
      });

      const btnUnban = userContextMenu.querySelector('.ctx-unban');
      if (btnUnban) {
        btnUnban.addEventListener('click', () => {
          socket.emit('unban_user', { targetUsername: contextMenuTargetUser });
          userContextMenu.style.display = 'none';
        });
      }
    }
  });

  // Auto-scroll chat initially
  scrollToBottom();

  function scrollToBottom() {
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  function escapeHTML(str) {
    return str.replace(/[&<>'"]/g,
      tag => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        "'": '&#39;',
        '"': '&quot;'
      }[tag] || tag)
    );
  }

  // --- Autopilot Logic ---
  const offlineOverlay = document.getElementById('etoyatv-offline-overlay');
  let autopilotTimer = null;
  let crossfadeTimer = null;
  let activeHls = null;
  let inactiveHls = null;

  let hlsInstance = null;
  let isInitialAutopilotLoad = true;
  let currentlyPlayingLive = false;

  async function fetchAutopilotStatus(force = false) {
    try {
      const res = await fetch(`/api/channels/${window.CHANNEL_ID}/autopilot_status`);
      const data = await res.json();

      if (autopilotTimer) {
        clearTimeout(autopilotTimer);
        autopilotTimer = null;
      }

      if (!data.active) {
        // Offline
        if (offlineOverlay) offlineOverlay.style.display = 'flex';
        const recordBtn = document.getElementById('btn-record-stream');
        if (recordBtn) recordBtn.style.display = 'none';
        
        const scheduleLiveItem = document.getElementById('schedule_live_item');
        const scheduleEmptyMsg = document.getElementById('schedule_empty_msg');
        if (scheduleLiveItem) scheduleLiveItem.style.display = 'none';
        if (scheduleEmptyMsg) scheduleEmptyMsg.style.display = 'table';
        
        const progCountEl = document.getElementById('program_count');
        if (progCountEl) {
          progCountEl.innerText = (data.totalPrograms !== undefined ? data.totalPrograms : 0) + (data.is_live ? 1 : 0);
        }

        video.pause();
        video.removeAttribute('src');
        video.load();
        if (hlsInstance) { hlsInstance.destroy(); hlsInstance = null; }

        // Schedule a retry to check if stream or autopilot comes back
        autopilotTimer = setTimeout(() => fetchAutopilotStatus(false), 30000); // 30s poll if offline
        return;
      }

      const isInitial = isInitialAutopilotLoad;
      isInitialAutopilotLoad = false;

      // If already playing live and we are checking status, do not interrupt
      if (data.is_live && currentlyPlayingLive && !force) {
        let nextPoll = 30000;
        autopilotTimer = setTimeout(() => fetchAutopilotStatus(false), nextPoll);
        return;
      }

      if (!force && !isInitial && video && video.paused && !video.ended) {
        // User has manually paused. Do not interrupt with a new video.
        // Keep polling so that when they press play, it snaps to live.
        let nextPoll = 30000;
        if (!data.is_live && data.nextUpdateIn !== undefined) {
          nextPoll = data.nextUpdateIn * 1000 + 500;
        }
        if (isNaN(nextPoll) || nextPoll < 5000) nextPoll = 5000;
        autopilotTimer = setTimeout(() => fetchAutopilotStatus(false), nextPoll);
        return;
      }

      // Active!
      // Active!
      if (offlineOverlay) offlineOverlay.style.display = 'none';

      const transitionCanvas = document.getElementById('etoyatv-transition-canvas');
      if (transitionCanvas && video.readyState >= 2 && !video.paused) {
        transitionCanvas.width = video.videoWidth || 640;
        transitionCanvas.height = video.videoHeight || 360;
        const ctx = transitionCanvas.getContext('2d');
        ctx.drawImage(video, 0, 0, transitionCanvas.width, transitionCanvas.height);
        transitionCanvas.style.transition = 'none';
        transitionCanvas.style.opacity = '1';
        transitionCanvas.style.display = 'block';
      }

      function onNewVideoPlaying() {
        if (transitionCanvas) {
          // Force reflow
          void transitionCanvas.offsetWidth;
          transitionCanvas.style.transition = 'opacity 0.8s ease-out';
          transitionCanvas.style.opacity = '0';
          setTimeout(() => {
            if (transitionCanvas.style.opacity === '0') {
              transitionCanvas.style.display = 'none';
            }
          }, 800);
        }
        video.removeEventListener('playing', onNewVideoPlaying);
      }
      video.addEventListener('playing', onNewVideoPlaying);

      if (hlsInstance) { hlsInstance.destroy(); hlsInstance = null; }

      let savedVol = localStorage.getItem('etoyatv_volume');
      let savedMuted = localStorage.getItem('etoyatv_muted') === 'true';
      let currentVol = savedVol !== null ? parseFloat(savedVol) : 1;

      video.muted = savedMuted;
      video.volume = currentVol;

      if (data.is_live) {
        currentlyPlayingLive = true;

        const liveDateObj = data.live_started_at ? new Date(data.live_started_at) : new Date();
        const userTz = window.USER_TIMEZONE || 'Europe/Moscow';
        let formattedDateStr = '';
        try {
          formattedDateStr = liveDateObj.toLocaleString('ru-RU', { timeZone: userTz, day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'});
        } catch (e) {
          formattedDateStr = liveDateObj.toLocaleString('ru-RU', { day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'});
        }
        const titleText = data.live_title || `Передача от ${formattedDateStr}`;

        // Show live label and update program title
        const liveLabel = document.getElementById('player_live_label');
        if (liveLabel) liveLabel.style.display = 'block';
        const recordBtn = document.getElementById('btn-record-stream');
        if (recordBtn) recordBtn.style.display = 'flex';
        const progTitle = document.getElementById('channel_program_title');
        if (progTitle) {
          let editBtn = '';
          if (data.is_owner && data.shortname) {
             editBtn = ` <button onclick="editLiveTitle('${data.shortname}')" title="Изменить название передачи" style="background:none;border:none;cursor:pointer;font-size:12px;">✏️</button>`;
          }
          progTitle.innerHTML = `→ <span class="blue" id="current_live_title_span">${titleText}</span>${editBtn}`;
        }

        const scheduleLiveItem = document.getElementById('schedule_live_item');
        const scheduleEmptyMsg = document.getElementById('schedule_empty_msg');
        if (scheduleLiveItem) {
           scheduleLiveItem.style.display = 'block';
           const liveTitleEl = document.getElementById('schedule_live_title');
           if (liveTitleEl) liveTitleEl.innerText = titleText;
           
           const scheduleThumb = scheduleLiveItem.querySelector('.thumb');
           if (scheduleThumb && data.shortname) {
               scheduleThumb.style.background = `#000 url('/tvsnapshots/${data.shortname}.jpg?t=${Date.now()}') no-repeat center center`;
               scheduleThumb.style.backgroundSize = 'cover';
           }

           const viewersCountEl = document.getElementById('schedule_viewers_count');
           if (viewersCountEl && data.viewers !== undefined) {
               viewersCountEl.innerText = `${data.viewers} зрителей`;
           }

           if (scheduleEmptyMsg) scheduleEmptyMsg.style.display = 'none';
        }
        
        const progCountEl = document.getElementById('program_count');
        if (progCountEl) {
          progCountEl.innerText = (data.totalPrograms !== undefined ? data.totalPrograms : 0) + (data.is_live ? 1 : 0);
        }

        // Play LIVE stream
        video.pause();
        video.removeAttribute('src');
        video.load();

        if (window.Hls && Hls.isSupported()) {
          hlsInstance = new Hls({
            debug: false,
            enableWorker: true
          });
          hlsInstance.loadSource(data.rtmp_url);
          hlsInstance.attachMedia(video);
          hlsInstance.on(Hls.Events.MANIFEST_PARSED, function () {
            if (enableAutoplay) video.play().catch(e => console.log('Autoplay prevented:', e));
          });
          hlsInstance.on(Hls.Events.ERROR, function (event, errData) {
            if (errData.fatal) {
              switch (errData.type) {
                case Hls.ErrorTypes.NETWORK_ERROR:
                  console.log('fatal network error encountered, try to recover');
                  hlsInstance.startLoad();
                  break;
                case Hls.ErrorTypes.MEDIA_ERROR:
                  console.log('fatal media error encountered, try to recover');
                  hlsInstance.recoverMediaError();
                  break;
                default:
                  hlsInstance.destroy();
                  break;
              }
            }
          });
        } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
          video.src = data.rtmp_url;
          if (enableAutoplay) video.play().catch(e => console.log('Autoplay prevented:', e));
        }
      } else {
        currentlyPlayingLive = false;

        const liveLabel = document.getElementById('player_live_label');
        if (liveLabel) liveLabel.style.display = 'none';
        const recordBtn = document.getElementById('btn-record-stream');
        if (recordBtn) recordBtn.style.display = 'none';
        const progTitle = document.getElementById('channel_program_title');
        if (progTitle) {
          progTitle.innerHTML = `→ <span class="blue">Автопилот</span>`;
        }

        const scheduleLiveItem = document.getElementById('schedule_live_item');
        const scheduleEmptyMsg = document.getElementById('schedule_empty_msg');
        if (scheduleLiveItem) scheduleLiveItem.style.display = 'none';
        if (scheduleEmptyMsg) scheduleEmptyMsg.style.display = 'table';

        const progCountEl = document.getElementById('program_count');
        if (progCountEl) {
          progCountEl.innerText = (data.totalPrograms !== undefined ? data.totalPrograms : 0) + (data.is_live ? 1 : 0);
        }

        // Play AUTOPILOT VOD
        video.pause();
        video.removeAttribute('src');
        video.load();

        const v = data.video;
        const offset = data.offset;

        if (v.hls_url && window.Hls && Hls.isSupported()) {
          hlsInstance = new Hls({ startPosition: offset });
          hlsInstance.loadSource(v.hls_url);
          hlsInstance.attachMedia(video);
          hlsInstance.on(Hls.Events.MANIFEST_PARSED, function () {
            if (enableAutoplay) video.play().catch(e => console.log('Autoplay prevented:', e));
          });
        } else if (v.video_url) {
          video.src = v.video_url + '#t=' + offset;
          if (enableAutoplay) video.play().catch(e => console.log('Autoplay prevented:', e));
        } else {
          if (v.hls_url && video.canPlayType('application/vnd.apple.mpegurl')) {
            video.src = v.hls_url + '#t=' + offset;
            if (enableAutoplay) video.play().catch(e => console.log('Autoplay prevented:', e));
          }
        }
      }

      // Schedule next fetch
      let nextPoll = 30000;
      if (!data.is_live && data.nextUpdateIn !== undefined) {
        nextPoll = data.nextUpdateIn * 1000 + 500; // plus 0.5 sec buffer
      }
      if (isNaN(nextPoll) || nextPoll < 5000) nextPoll = 5000; // minimum poll 5 seconds
      autopilotTimer = setTimeout(() => fetchAutopilotStatus(false), nextPoll);

    } catch (e) {
      console.error('Error fetching autopilot status:', e);
      autopilotTimer = setTimeout(() => fetchAutopilotStatus(false), 15000);
    }
  }

  if (window.CHANNEL_ID) {
    fetchAutopilotStatus();

    if (video) {
      video.addEventListener('ended', () => {
        console.log('[Player] Video ended naturally, advancing to next autopilot video...');
        fetchAutopilotStatus(true);
      });
    }

    socket.on('autopilot_update', () => {
      fetchAutopilotStatus();
    });

    socket.on('stream_started', () => {
      fetchAutopilotStatus();
    });

    socket.on('stream_ended', () => {
      fetchAutopilotStatus();
    });

    // --- Overlays Rendering ---
    const overlaysCanvas = document.getElementById('etoyatv-overlays-canvas');
    if (overlaysCanvas) {
      if (window.etoyatvOverlaysLoopRunning) {
        return;
      }
      window.etoyatvOverlaysLoopRunning = true;

      const overlaysCtx = overlaysCanvas.getContext('2d');
      let overlaysState = {
        source: 'webcam',
        bumper: { active: false },
        intro: { active: false },
        ticker: { active: false }
      };
      let tickerOffset = 1280;

      socket.on('player_update_overlays', (data) => {
        overlaysState = data || overlaysState;
        if (overlaysState.ticker && overlaysState.ticker.active) {
          tickerOffset = 1280;
        }
        if (overlaysState.bumper?.active || overlaysState.ticker?.active || overlaysState.source === 'intro') {
          overlaysCanvas.style.display = 'block';
        } else {
          overlaysCanvas.style.display = 'none';
          overlaysCtx.clearRect(0, 0, overlaysCanvas.width, overlaysCanvas.height);
        }
      });

      function drawPlayerOverlays() {
        requestAnimationFrame(drawPlayerOverlays);

        const hasActiveOverlays = overlaysState.bumper?.active || overlaysState.ticker?.active || overlaysState.source === 'intro';
        if (!hasActiveOverlays) {
          return;
        }

        // Dynamic resolution mapping for crisp high-DPI rendering
        const rect = overlaysCanvas.getBoundingClientRect();
        const displayWidth = rect.width || 1280;
        const displayHeight = rect.height || 720;
        const dpr = window.devicePixelRatio || 1;
        const targetWidth = Math.round(displayWidth * dpr);
        const targetHeight = Math.round(displayHeight * dpr);

        if (overlaysCanvas.width !== targetWidth || overlaysCanvas.height !== targetHeight) {
          overlaysCanvas.width = targetWidth;
          overlaysCanvas.height = targetHeight;
        }

        const ctx = overlaysCtx;
        const time = Date.now() / 1000;

        ctx.clearRect(0, 0, overlaysCanvas.width, overlaysCanvas.height);

        // Map drawing coordinate system to virtual 1280x720 space
        ctx.save();
        ctx.scale(overlaysCanvas.width / 1280, overlaysCanvas.height / 720);

        if (overlaysState.source === 'intro' && overlaysState.intro?.active) {
          drawPlayerAnimatedIntro(ctx, overlaysState.intro, time);
        }

        if (overlaysState.bumper?.active) {
          drawPlayerBumperOverlay(ctx, overlaysState.bumper, time);
        }

        if (overlaysState.ticker?.active) {
          drawPlayerTickerOverlay(ctx, overlaysState.ticker, time);
        }

        ctx.restore();
      }

      function drawPlayerAnimatedIntro(ctx, intro, time) {
        const width = 1280;
        const height = 720;

        if (intro.style === 'gradient-pulse') {
          const angleShift = time * 0.4;
          const x1 = width / 2 + Math.cos(angleShift) * width / 2;
          const y1 = height / 2 + Math.sin(angleShift) * height / 2;
          const x2 = width / 2 - Math.cos(angleShift) * width / 2;
          const y2 = height / 2 - Math.sin(angleShift) * height / 2;
          
          const grad = ctx.createLinearGradient(x1, y1, x2, y2);
          grad.addColorStop(0, intro.bgColor1 || '#1f1c2c');
          grad.addColorStop(1, intro.bgColor2 || '#928dab');
          ctx.fillStyle = grad;
          ctx.fillRect(0, 0, width, height);
          
        } else if (intro.style === 'cosmic-glow') {
          ctx.fillStyle = '#0f0c1b';
          ctx.fillRect(0, 0, width, height);
          
          ctx.save();
          ctx.globalCompositeOperation = 'screen';
          for (let i = 0; i < 6; i++) {
              const px = (width / 2) + Math.cos(time * 0.35 + i) * (width * 0.35);
              const py = (height / 2) + Math.sin(time * 0.45 + i * 2) * (height * 0.32);
              const size = 180 + Math.sin(time * 0.6 + i) * 60;
              
              const bubbleGrad = ctx.createRadialGradient(px, py, 0, px, py, size);
              bubbleGrad.addColorStop(0, (intro.bgColor1 || '#1f1c2c') + '66');
              bubbleGrad.addColorStop(0.5, (intro.bgColor2 || '#928dab') + '22');
              bubbleGrad.addColorStop(1, 'transparent');
              
              ctx.fillStyle = bubbleGrad;
              ctx.beginPath();
              ctx.arc(px, py, size, 0, Math.PI * 2);
              ctx.fill();
          }
          ctx.restore();
          
        } else if (intro.style === 'retro-wave') {
          const skyGrad = ctx.createLinearGradient(0, 0, 0, height);
          skyGrad.addColorStop(0, '#0c021f');
          skyGrad.addColorStop(0.5, intro.bgColor1 || '#1f1c2c');
          skyGrad.addColorStop(1, intro.bgColor2 || '#928dab');
          ctx.fillStyle = skyGrad;
          ctx.fillRect(0, 0, width, height);
          
          ctx.save();
          ctx.strokeStyle = 'rgba(255, 0, 127, 0.25)';
          ctx.lineWidth = 2;
          const horizon = height * 0.58;
          
          const gridSpeed = (time * 60) % 30;
          for (let y = horizon; y < height; y += 15) {
              const dy = y + gridSpeed * ((y - horizon) / (height - horizon));
              ctx.beginPath();
              ctx.moveTo(0, dy);
              ctx.lineTo(width, dy);
              ctx.stroke();
          }
          for (let x = -width; x < width * 2; x += 80) {
              ctx.beginPath();
              ctx.moveTo(width / 2, horizon);
              ctx.lineTo(x, height);
              ctx.stroke();
          }
          ctx.restore();
          
        } else {
          const grad = ctx.createLinearGradient(0, 0, width, height);
          grad.addColorStop(0, intro.bgColor1 || '#1f1c2c');
          grad.addColorStop(1, intro.bgColor2 || '#928dab');
          ctx.fillStyle = grad;
          ctx.fillRect(0, 0, width, height);
        }

        const floatY = Math.sin(time * 2.5) * 8;
        
        ctx.save();
        ctx.fillStyle = intro.color1 || '#ffffff';
        ctx.font = 'bold 54px Tahoma, Arial';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.shadowColor = intro.color1 || '#ffffff';
        ctx.shadowBlur = 15;
        ctx.fillText(intro.text1 || '', width / 2, height / 2 - 35 + floatY);
        ctx.restore();
        
        ctx.save();
        ctx.fillStyle = intro.color2 || '#6fdeee';
        ctx.font = 'bold 22px Tahoma, Arial';
        ctx.textAlign = 'center';
        ctx.shadowColor = intro.color2 || '#6fdeee';
        ctx.shadowBlur = 5;
        ctx.fillText(intro.text2 || '', width / 2, height / 2 + 35);
        ctx.restore();
      }

      function drawPlayerBumperOverlay(ctx, bumper, time) {
        const h = 80;
        const y = 550;
        
        let progress = 1;
        if (bumper.activatedAt) {
            const elapsed = (Date.now() - bumper.activatedAt) / 1000;
            progress = Math.min(1, elapsed / 0.4);
            progress = 1 - Math.pow(1 - progress, 3);
        }
        
        const x = -500 + (500 + 50) * progress;
        
        ctx.save();
        
        if (bumper.style === 'glass') {
            ctx.fillStyle = 'rgba(20, 20, 20, 0.75)';
            ctx.strokeStyle = bumper.bgColor1 || '#ff3b30';
            ctx.lineWidth = 3;
            ctx.shadowColor = bumper.bgColor1 || '#ff3b30';
            ctx.shadowBlur = 10;
            
            ctx.beginPath();
            if (typeof ctx.roundRect === 'function') {
                ctx.roundRect(x, y, 480, h, 8);
            } else {
                ctx.rect(x, y, 480, h);
            }
            ctx.fill();
            ctx.stroke();
            ctx.shadowBlur = 0;
            
        } else if (bumper.style === 'shine') {
            drawPlayerClassicRibbons(ctx, x, y, h, bumper.bgColor1 || '#ff3b30', bumper.bgColor2 || '#007af5');
            
            const cycle = (time * 0.7) % 1;
            const sweepX = x + cycle * 520 - 50;
            
            ctx.save();
            ctx.beginPath();
            ctx.moveTo(x, y);
            ctx.lineTo(x + 500, y);
            ctx.lineTo(x + 470, y + h);
            ctx.lineTo(x, y + h);
            ctx.closePath();
            ctx.clip();
            
            const shineGrad = ctx.createLinearGradient(sweepX - 40, y, sweepX + 40, y);
            shineGrad.addColorStop(0, 'transparent');
            shineGrad.addColorStop(0.5, 'rgba(255, 255, 255, 0.45)');
            shineGrad.addColorStop(1, 'transparent');
            ctx.fillStyle = shineGrad;
            ctx.fillRect(x, y, 480, h);
            ctx.restore();
            
        } else {
            drawPlayerClassicRibbons(ctx, x, y, h, bumper.bgColor1 || '#ff3b30', bumper.bgColor2 || '#007af5');
        }

        ctx.fillStyle = bumper.color1 || '#ffffff';
        ctx.font = 'bold 22px Arial, sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText(bumper.text1 || '', x + 25, y + 14);
        
        ctx.fillStyle = bumper.color2 || '#6fdeee';
        ctx.font = '14px Arial, sans-serif';
        ctx.fillText(bumper.text2 || '', x + 25, y + 46);
        
        ctx.restore();
      }

      function drawPlayerClassicRibbons(ctx, x, y, h, bg1, bg2) {
        ctx.fillStyle = bg1;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + 500, y);
        ctx.lineTo(x + 470, y + h);
        ctx.lineTo(x, y + h);
        ctx.closePath();
        ctx.fill();
        
        ctx.fillStyle = bg2;
        ctx.beginPath();
        ctx.moveTo(x + 5, y + 5);
        ctx.lineTo(x + 490, y + 5);
        ctx.lineTo(x + 465, y + h - 5);
        ctx.lineTo(x + 5, y + h - 5);
        ctx.closePath();
        ctx.fill();
      }

      function drawPlayerTickerOverlay(ctx, ticker, time) {
        const h = 40;
        const y = 680;
        const speed = parseInt(ticker.speed || 2);
        
        ctx.save();
        
        ctx.fillStyle = ticker.bgColor || '#007af5';
        ctx.fillRect(0, y, 1280, h);
        
        ctx.font = 'bold 16px Arial, sans-serif';
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'left';
        
        if (ticker.style === 'pulse-color') {
            const hue = (time * 120) % 360;
            ctx.fillStyle = `hsl(${hue}, 100%, 75%)`;
        } else {
            ctx.fillStyle = ticker.color || '#ffffff';
        }
        
        const textStr = ticker.text || '';
        const textWidth = ctx.measureText(textStr).width;
        
        // Scroll speed calculation based on elapsed time to be frame-rate independent
        const activatedAt = ticker.activatedAt || 0;
        const elapsed = (Date.now() - activatedAt) / 1000;
        const pixelsPerSecond = speed * 60; 
        const totalDistance = 1280 + textWidth;
        const currentDistance = (elapsed * pixelsPerSecond) % totalDistance;
        const offset = 1280 - currentDistance;
        
        ctx.fillText(textStr, offset, y + h / 2);
        
        if (ticker.style === 'gradient-fade') {
            const leftFade = ctx.createLinearGradient(0, y, 80, y);
            leftFade.addColorStop(0, ticker.bgColor || '#007af5');
            leftFade.addColorStop(1, 'transparent');
            ctx.fillStyle = leftFade;
            ctx.fillRect(0, y, 80, h);
            
            const rightFade = ctx.createLinearGradient(1200, y, 1280, y);
            rightFade.addColorStop(0, 'transparent');
            rightFade.addColorStop(1, ticker.bgColor || '#007af5');
            ctx.fillStyle = rightFade;
            ctx.fillRect(1200, y, 80, h);
        }
        
        ctx.restore();
      }

      drawPlayerOverlays();
    }
  }
});

window.bookmark = function (link) {
  const url = window.location.href;
  const title = document.title;
  if (window.sidebar && window.sidebar.addPanel) {
    window.sidebar.addPanel(title, url, "");
  } else if (window.external && ('AddFavorite' in window.external)) {
    window.external.AddFavorite(url, title);
  } else if (window.opera && window.print) {
    link.setAttribute('rel', 'sidebar');
    link.setAttribute('href', url);
    link.setAttribute('title', title);
    return true;
  } else {
    alert('Нажмите ' + (navigator.userAgent.toLowerCase().indexOf('mac') != -1 ? 'Cmd' : 'Ctrl') + '+D чтобы добавить страницу в закладки.');
  }
  return false;
};

// User context menu logic
document.addEventListener('DOMContentLoaded', () => {
  const userContextMenu = document.getElementById('user-context-menu');
  const chatMessages = document.getElementById('chat_text_field');
  const socket = io(); // Use the existing or new socket for these actions
  if (userContextMenu && chatMessages) {
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.chat-username') && !e.target.closest('#user-context-menu')) {
        if (userContextMenu) userContextMenu.style.display = 'none';
      }
    });
  }
});

window.copyShareLink = function(shortname) {
  if (!shortname) return;
  const link = window.location.origin + '/' + shortname;
  
  function fallbackCopyTextToClipboard(text) {
    const textArea = document.createElement("textarea");
    textArea.value = text;
    textArea.style.top = "0";
    textArea.style.left = "0";
    textArea.style.position = "fixed";
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    try {
      const successful = document.execCommand('copy');
      if (successful) {
        alert('Ссылка скопирована в буфер обмена!');
      } else {
        prompt("Скопируйте ссылку на канал:", text);
      }
    } catch (err) {
      prompt("Скопируйте ссылку на канал:", text);
    }
    document.body.removeChild(textArea);
  }

  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(link).then(() => {
      alert('Ссылка скопирована в буфер обмена!');
    }).catch(() => fallbackCopyTextToClipboard(link));
  } else {
    fallbackCopyTextToClipboard(link);
  }
};

window.editLiveTitle = function(shortname) {
  const newTitle = prompt('Введите новое название для текущей передачи:');
  if (newTitle !== null) {
    if (!newTitle.trim()) {
      alert('Название не может быть пустым');
      return;
    }
    fetch('/api/channel/live_title', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shortname, title: newTitle.trim() })
    })
    .then(res => res.json())
    .then(data => {
      if (data.success) {
        const span = document.getElementById('current_live_title_span');
        if (span) span.innerText = newTitle.trim();
      } else {
        alert('Ошибка при сохранении: ' + (data.error || 'Неизвестная ошибка'));
      }
    })
    .catch(e => {
      console.error('Error editing live title:', e);
      alert('Ошибка соединения сервера');
    });
  }
};
