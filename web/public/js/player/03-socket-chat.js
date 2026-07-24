/* === 03-socket-chat.js (lines 777-1168) === */
  // --- Socket.io Setup ---
  let lastUsersList = [];
  let lastTotalCount = 0;

  window.updateViewerCountsDisplay = function() {
    const chatTabIdx = currentSelectedChatStreamIndex; // null for general, 1/2/3 for cameras
    
    let displayCount = lastTotalCount;
    if (chatTabIdx !== null && lastUsersList && lastUsersList.length > 0) {
      const countForTab = lastUsersList.filter(u => {
        if (u.streamIndexes && Array.isArray(u.streamIndexes)) {
          return u.streamIndexes.includes(chatTabIdx);
        }
        const idx = u.streamIndex || 1;
        return idx === chatTabIdx;
      }).length;
      displayCount = countForTab;
    }

    const viewersCountEl = document.getElementById('viewers-count');
    const chatViewersCountEl = document.getElementById('chat-viewers-count');
    const viewersCountPlayerEl = document.getElementById('viewers-count-player');

    if (viewersCountEl) viewersCountEl.textContent = displayCount;
    if (chatViewersCountEl) {
      chatViewersCountEl.textContent = displayCount;
      const prefix = document.getElementById('chat-viewers-prefix');
      if (prefix) prefix.style.display = 'inline';
    }
    if (viewersCountPlayerEl) viewersCountPlayerEl.textContent = displayCount;
  };

  window.updateUsersListDisplay = function() {
    const list = document.getElementById('chat-users-list');
    if (!list) return;
    list.innerHTML = '';

    const chatTabIdx = currentSelectedChatStreamIndex; // null for general, 1/2/3 for cameras
    let filteredUsers = [...lastUsersList];
    if (chatTabIdx !== null) {
      filteredUsers = filteredUsers.filter(u => {
        if (u.streamIndexes && Array.isArray(u.streamIndexes)) {
          return u.streamIndexes.includes(chatTabIdx);
        }
        const idx = u.streamIndex || 1;
        return idx === chatTabIdx;
      });
    }

    filteredUsers.sort((a, b) => {
      const getWeight = (role) => {
        if (role === 'admin') return 1;
        if (role === 'mod') return 2;
        if (role === 'owner') return 3;
        if (role === 'alien') return 3.5;
        if (role === 'moderator') return 4;
        if (role === 'editor' || role === 'reporter') return 4.5;
        if (role === 'guest') return 6;
        return 5;
      };
      const weightA = getWeight(a.role);
      const weightB = getWeight(b.role);
      if (weightA !== weightB) return weightA - weightB;
      return a.username.localeCompare(b.username);
    });

    filteredUsers.forEach(u => {
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
      else if (u.role === 'editor' || u.role === 'reporter') icon = '<img src="/images/chat/staff.svg" style="width: 14px; height: 14px; vertical-align: text-bottom;">';
      else if (u.role === 'registered') icon = '<img src="/images/chat/user.svg" style="width: 14px; height: 14px; vertical-align: text-bottom;">';
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
      div.style.cssText = 'margin: 2px 0; font-weight: bold; cursor: pointer; display: flex; align-items: center; gap: 3px;';
      div.style.color = userColor;
      div.innerHTML = icon;
      const nameSpan = document.createElement('span');
      if (textStyle) nameSpan.style.cssText = textStyle;
      nameSpan.textContent = ' ' + u.username;
      div.appendChild(nameSpan);
      list.appendChild(div);
    });
  };

  socket.on('connect', () => {
    console.log('[SOCKET] Player connected, sending join_channel...');
    socket.emit('join_channel', {
      channelId: window.CHANNEL_ID,
      user: window.CURRENT_USER,
      userToken: window.CURRENT_USER_TOKEN,
      guestName: guestName,
      color: document.getElementById('chat-color-picker')?.value || '#3b9cd9',
      streamIndex: currentSelectedStreamIndex || 1
    });
  });

  socket.on('update_users', ({ count, users }) => {
    lastUsersList = users || [];
    lastTotalCount = count || 0;
    window.updateViewerCountsDisplay();
    window.updateUsersListDisplay();
  });

  socket.on('chat_cleared', () => {
    if (chatMessages) chatMessages.innerHTML = '';
    activePinnedMessages = {
      common: null,
      1: null,
      2: null,
      3: null
    };
    updatePinnedBoxDisplay();
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
    div.setAttribute('data-msg-id', msg.id);
    div.setAttribute('data-stream-index', msg.stream_index !== null && msg.stream_index !== undefined ? msg.stream_index : '');
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

    const timeSpan = document.createElement('span');
    timeSpan.style.color = '#666';
    timeSpan.textContent = timeStr + ' ';
    div.appendChild(timeSpan);

    const nameSpan = document.createElement('span');
    nameSpan.style.color = roleColor;
    nameSpan.style.fontWeight = 'bold';

    const senderUsernameSpan = document.createElement('span');
    senderUsernameSpan.className = 'chat-username';
    senderUsernameSpan.setAttribute('data-username', senderNick);
    senderUsernameSpan.setAttribute('data-color', roleColor);
    senderUsernameSpan.setAttribute('data-role', msg.role || 'guest');
    senderUsernameSpan.style.cursor = 'pointer';
    senderUsernameSpan.textContent = senderNick;
    nameSpan.appendChild(senderUsernameSpan);

    if (isReply) {
      const gtSpan = document.createElement('span');
      gtSpan.style.color = '#fff';
      gtSpan.textContent = '>';
      nameSpan.appendChild(gtSpan);

      const recipientColor = chatUserColors[replyTo.toLowerCase()] || '#3b9cd9';
      const recipientUsernameSpan = document.createElement('span');
      recipientUsernameSpan.className = 'chat-username';
      recipientUsernameSpan.setAttribute('data-username', replyTo);
      recipientUsernameSpan.setAttribute('data-color', recipientColor);
      recipientUsernameSpan.style.cursor = 'pointer';
      recipientUsernameSpan.textContent = replyTo;
      
      const recipientWrapperSpan = document.createElement('span');
      recipientWrapperSpan.style.color = recipientColor;
      recipientWrapperSpan.style.fontWeight = 'bold';
      recipientWrapperSpan.appendChild(recipientUsernameSpan);

      nameSpan.appendChild(recipientWrapperSpan);
      nameSpan.appendChild(document.createTextNode(', '));
      div.appendChild(nameSpan);
    } else {
      nameSpan.appendChild(document.createTextNode(': '));
      div.appendChild(nameSpan);
    }

    const msgSpan = document.createElement('span');
    msgSpan.className = 'chat-msg-text translatable-live';
    msgSpan.textContent = isReply ? restOfMsg : rawMsg;
    linkifyElement(msgSpan);
    div.appendChild(msgSpan);
    if (typeof window.translateElementLive === 'function') {
      window.translateElementLive(msgSpan);
    }

    if (window.IS_MODERATOR === true) {
      const controlsSpan = document.createElement('span');
      controlsSpan.innerHTML = ` <span class="btn-pin-message" data-msg-id="${msg.id}" title="Закрепить" style="display: inline-flex; align-items: center; justify-content: center; vertical-align: middle; margin-left: 5px;"><svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="17" x2="12" y2="22"></line><path d="M5 17h14v-1.76a2 2 0 0 0-.44-1.24l-2.78-3.5A2 2 0 0 1 15 9.24V5a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v4.24c0 .43-.15.85-.44 1.18L5.78 14a2 2 0 0 0-.44 1.24z"></path></svg></span>` +
                            ` <span class="btn-delete-message" data-msg-id="${msg.id}" title="Удалить" style="display: inline-flex; align-items: center; justify-content: center; vertical-align: middle; margin-left: 3px;"><svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg></span>`;
      div.appendChild(controlsSpan);
    }

    if (chatMessages) {
      chatMessages.appendChild(div);
      const isChatWidgetLocal = document.getElementById('chat-tabs-container') !== null;
      if (isChatWidgetLocal) {
        filterChatMessages();
      } else {
        scrollToBottom();
      }
    }
  });

  socket.on('message_pinned', (data) => {
    const streamKey = data.streamIndex || 'common';
    activePinnedMessages[streamKey] = {
      id: data.id,
      message: data.message,
      role: data.role,
      color: data.color,
      username: data.username
    };
    updatePinnedBoxDisplay();
  });

  socket.on('message_unpinned', (data) => {
    const streamKey = data && data.streamIndex;
    if (streamKey === 'all') {
      activePinnedMessages = {
        common: null,
        1: null,
        2: null,
        3: null
      };
    } else if (streamKey) {
      activePinnedMessages[streamKey] = null;
    } else {
      activePinnedMessages['common'] = null;
    }
    updatePinnedBoxDisplay();
  });

  socket.on('message_deleted', (data) => {
    const msgId = data.messageId;
    const row = document.querySelector(`.chat-message-row[data-msg-id="${msgId}"]`);
    if (row) {
      row.remove();
    }
  });

  window.openClearChatModal = function() {
    const overlay = document.getElementById('yatv-clear-chat-modal-overlay');
    if (overlay) overlay.style.display = 'flex';
  };

  window.closeClearChatModal = function() {
    const overlay = document.getElementById('yatv-clear-chat-modal-overlay');
    if (overlay) overlay.style.display = 'none';
  };

  window.submitClearChat = function() {
    socket.emit('clear_chat');
    window.closeClearChatModal();
  };

  function updateLiveBadgeVisibility() {
    const liveLabel = document.getElementById('player_live_label');
    if (liveLabel) {
      if (currentlyPlayingLive && !window.HIDE_LIVE_BADGE) {
        liveLabel.style.display = 'block';
      } else {
        liveLabel.style.display = 'none';
      }
    }
  }

  function updateChatPlaceholder() {
    const isBanned = window.USER_IS_BANNED || false;
    if (chatInput) {
      if (!window.CHAT_ENABLED) {
        chatInput.disabled = true;
        chatInput.placeholder = window.t('Чат выключен');
      } else {
        chatInput.disabled = isBanned;
        chatInput.placeholder = isBanned ? (window.BAN_TEXT || window.t('Вы заблокированы')) : window.t('Написать...');
      }
    }
  }

  socket.on('live_badge_toggled', (hide) => {
    window.HIDE_LIVE_BADGE = hide;
    updateLiveBadgeVisibility();
  });

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
      window.BAN_TEXT = window.t('Вы заблокированы до') + ` ${dd}.${mm}.${yyyy} ${HH}:${MM}`;
    } else {
      window.BAN_TEXT = window.t('Вы заблокированы');
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

