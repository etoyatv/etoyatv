document.addEventListener('DOMContentLoaded', () => {
  const socket = io();

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

  // --- Socket.io Setup ---
  socket.emit('join_channel', {
    channelId: window.CHANNEL_ID,
    user: window.CURRENT_USER,
    guestName: guestName,
    color: document.getElementById('chat-color-picker')?.value || '#3b9cd9'
  });

  socket.on('update_users', ({ count, users }) => {
    if (viewersCount) viewersCount.textContent = count;
    if (chatViewersCount) chatViewersCount.textContent = count;
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
        const div = document.createElement('div');
        div.style.marginTop = '5px';
        div.style.color = u.color || '#fff';
        div.style.fontWeight = 'bold';
        div.style.display = 'flex';
        div.style.alignItems = 'center';
        div.style.gap = '3px';

        let icon = '👤';
        if (u.role === 'owner') icon = '👑';
        else if (u.role === 'alien') icon = '👽';
        else if (u.role === 'admin') icon = '👽';
        else if (u.role === 'mod' || u.role === 'moderator') icon = '🛡️';
        else if (u.role === 'registered' || u.role === 'editor' || u.role === 'reporter') icon = '👤';

        if (u.isBanned) {
          icon = '🚫';
        }

        const textStyle = u.isBanned ? 'text-decoration: line-through; color: #888;' : '';

        let userColor = u.color || '#fff';

        div.className = 'chat-username';
        div.setAttribute('data-username', u.username);
        div.setAttribute('data-role', u.role);
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

  // chat_toggled handler moved below

  socket.on('new_message', (msg) => {
    const div = document.createElement('div');
    div.className = 'chat-message-row';
    div.style.font = '11px Verdana, Geneva, sans-serif';
    div.style.color = '#fff';
    div.style.margin = '1px';
    div.style.wordWrap = 'break-word';
    div.style.overflowWrap = 'break-word';
    div.style.wordBreak = 'break-all';
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

    const escapedUser = escapeHTML(msg.username);
    const escapedRole = escapeHTML(msg.role || 'guest');

    let pinButtonHtml = '';
    if (window.IS_MODERATOR === true) {
      pinButtonHtml = ` <span class="btn-pin-message" data-msg-id="${msg.id}" title="Закрепить">📌</span>`;
    }

    div.innerHTML = `<span style="color: #666;">${timeStr}</span> <span style="color: ${roleColor}; font-weight: bold;"><span class="chat-username" data-username="${escapedUser}" data-role="${escapedRole}" style="cursor: pointer;">${escapedUser}</span>:</span> ${escapeHTML(msg.message)}${pinButtonHtml}`;

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

  // --- Chat Input & Color ---
  const chatColorPalette = document.getElementById('chat-color-palette');

  if (chatColorBtn && chatColorPalette) {
    chatColorBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      chatColorPalette.style.display = chatColorPalette.style.display === 'none' ? 'flex' : 'none';
    });

    document.addEventListener('click', (e) => {
      if (!chatColorPalette.contains(e.target) && e.target !== chatColorBtn) {
        chatColorPalette.style.display = 'none';
      }
    });

    const swatches = document.querySelectorAll('.color-swatch');
    swatches.forEach(swatch => {
      swatch.addEventListener('click', () => {
        let c = swatch.getAttribute('data-color');
        chatColorPicker.value = c;
        chatColorBtn.style.backgroundColor = c;
        chatColorPalette.style.display = 'none';
        localStorage.setItem('etoyatv_chat_color', c);
        socket.emit('update_chat_color', { color: c });
      });
    });
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
    video.addEventListener('play', () => btnPlayPause.textContent = '⏸');
    video.addEventListener('pause', () => btnPlayPause.textContent = '⏵');
  }

  btnPlayPause.addEventListener('click', () => {
    if (video && video.paused) {
      video.play().catch(e => { }); // Prime for user gesture
      if (window.CHANNEL_ID && typeof fetchAutopilotStatus === 'function') {
        fetchAutopilotStatus(true);
      } else {
        video.play();
      }
      btnPlayPause.textContent = '⏸';
    } else if (video) {
      video.pause();
      btnPlayPause.textContent = '⏵';
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
        if (!muted && video.paused) {
          video.play().catch(err => {});
        }
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
        if (!isMuted && video.paused) {
          video.play().catch(err => {});
        }
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

      if (!video.muted && video.paused) {
        video.play().catch(err => {});
      }

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
  const uiElements = playerContainer.querySelectorAll('.player-ui');
  let hideTimeout;

  function showControls() {
    uiElements.forEach(el => el.style.opacity = '1');
    clearTimeout(hideTimeout);
    hideTimeout = setTimeout(() => {
      if (video && !video.paused) { // only hide if playing
        uiElements.forEach(el => el.style.opacity = '0');
      }
    }, 3000);
  }

  if (playerContainer) {
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

      if (!video.muted && video.paused) {
        video.play().catch(err => {});
      }

      if (btnVolume) btnVolume.textContent = video.muted ? '🔇' : '🔊';
      if (volumeSlider) volumeSlider.value = vol;

      localStorage.setItem('etoyatv_volume', vol);
      localStorage.setItem('etoyatv_muted', video.muted);
    });

    playerContainer.addEventListener('mousemove', showControls);
    playerContainer.addEventListener('mouseenter', showControls);
    playerContainer.addEventListener('mouseleave', () => {
      if (video && !video.paused) uiElements.forEach(el => el.style.opacity = '0');
    });
  }

  if (video) {
    video.addEventListener('play', showControls);
    video.addEventListener('pause', () => {
      uiElements.forEach(el => el.style.opacity = '1');
      clearTimeout(hideTimeout);
    });
  }

  // Show initially
  showControls();

  // Toggle Action Menu
  if (btnChatMenu && chatMenu) {
    btnChatMenu.addEventListener('click', (e) => {
      e.stopPropagation();
      chatMenu.style.display = chatMenu.style.display === 'none' ? 'block' : 'none';
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
          chatInput.value += `${contextMenuTargetUser}, `;
          chatInput.focus();
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

      if (!force && !isInitial && video && video.paused) {
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
            video.play().catch(e => console.log('Autoplay prevented:', e));
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
          video.play().catch(e => console.log('Autoplay prevented:', e));
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
            video.play().catch(e => console.log('Autoplay prevented:', e));
          });
        } else if (v.video_url) {
          video.src = v.video_url + '#t=' + offset;
          video.play().catch(e => console.log('Autoplay prevented:', e));
        } else {
          if (v.hls_url && video.canPlayType('application/vnd.apple.mpegurl')) {
            video.src = v.hls_url + '#t=' + offset;
            video.play().catch(e => console.log('Autoplay prevented:', e));
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

    socket.on('autopilot_update', () => {
      fetchAutopilotStatus();
    });

    socket.on('stream_started', () => {
      fetchAutopilotStatus();
    });

    socket.on('stream_ended', () => {
      fetchAutopilotStatus();
    });
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
