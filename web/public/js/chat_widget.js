(function() {
  function escapeHTML(str) {
    if (!str) return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  const lang = (window.xE_lang && window.xE_lang['LANG']) || 'ru';
  const clientDict = {
    en: { guest: 'Guest', guestPrefix: 'Guest_', pin: 'Pin', delete: 'Delete' },
    uk: { guest: 'Гість', guestPrefix: 'Гість_', pin: 'Закріпити', delete: 'Видалити' },
    be: { guest: 'Госць', guestPrefix: 'Госць_', pin: 'Замацаваць', delete: 'Выдаліць' },
    ru: { guest: 'Гость', guestPrefix: 'Гость_', pin: 'Закрепить', delete: 'Удалить' }
  };
  const tClient = function(key) {
    return (clientDict[lang] && clientDict[lang][key]) || clientDict['ru'][key];
  };

  function linkify(text) {
    const urlRegex = /(https?:\/\/[^\s<>"]+)/g;
    return text.replace(urlRegex, function(url) {
      let cleanUrl = url;
      let trailing = '';
      const match = url.match(/[.,;?!)]+$/);
      if (match) {
        cleanUrl = url.substring(0, url.length - match[0].length);
        trailing = match[0];
      }
      return `<a href="${cleanUrl}" target="_blank" style="color: #54c5ff; text-decoration: underline;" rel="noopener noreferrer">${cleanUrl}</a>` + trailing;
    });
  }

  function linkifyElement(element) {
    if (!element) return;
    const children = Array.from(element.childNodes);
    children.forEach(node => {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent;
        const urlRegex = /(https?:\/\/[^\s<>"]+)/g;
        let lastIndex = 0;
        let match;
        const fragments = document.createDocumentFragment();
        let hasMatches = false;

        while ((match = urlRegex.exec(text)) !== null) {
          hasMatches = true;
          if (match.index > lastIndex) {
            fragments.appendChild(document.createTextNode(text.substring(lastIndex, match.index)));
          }
          let url = match[0];
          let cleanUrl = url;
          let trailing = '';
          const trailingMatch = url.match(/[.,;?!)]+$/);
          if (trailingMatch) {
            cleanUrl = url.substring(0, url.length - trailingMatch[0].length);
            trailing = trailingMatch[0];
          }
          const a = document.createElement('a');
          a.href = cleanUrl;
          a.target = '_blank';
          a.style.color = '#54c5ff';
          a.style.textDecoration = 'underline';
          a.setAttribute('rel', 'noopener noreferrer');
          a.textContent = cleanUrl;
          fragments.appendChild(a);
          if (trailing) {
            fragments.appendChild(document.createTextNode(trailing));
          }
          lastIndex = urlRegex.lastIndex;
        }

        if (hasMatches) {
          if (lastIndex < text.length) {
            fragments.appendChild(document.createTextNode(text.substring(lastIndex)));
          }
          node.replaceWith(fragments);
        }
      }
    });
  }

  const chatMessages = document.getElementById('chat_text_field');
  const chatInput = document.getElementById('chat-input');
  const btnChatSubmit = document.getElementById('btn-chat-submit');

  function scrollToBottom() {
    if (chatMessages) {
      chatMessages.scrollTop = chatMessages.scrollHeight;
    }
  }

  // Auto-scroll on initial load
  scrollToBottom();

  const socket = io();
  let guestName = localStorage.getItem('etoyatv_guest_name');
  if (!window.CURRENT_USER && !guestName) {
    guestName = tClient('guestPrefix') + Math.floor(Math.random() * 10000);
    localStorage.setItem('etoyatv_guest_name', guestName);
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
    document.querySelectorAll('.chat-message-row').forEach(linkifyElement);
    const pinnedContent = document.getElementById('chat_pinned_content');
    if (pinnedContent) {
      linkifyElement(pinnedContent);
    }
  }

  // Initialize on load
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initUserColorsMap);
  } else {
    initUserColorsMap();
  }

  socket.on('connect', () => {
    socket.emit('join_channel', {
      channelId: window.CHANNEL_ID,
      user: window.CURRENT_USER,
      userToken: window.CURRENT_USER_TOKEN,
      guestName: guestName,
      color: document.getElementById('chat-color-picker')?.value || '#3b9cd9'
    });
  });

  socket.on('guest_name_changed', (data) => {
    guestName = data.name;
    localStorage.setItem('etoyatv_guest_name', guestName);
  });

  socket.on('update_users', ({ count, users }) => {
    const viewersCount = document.getElementById('chat-viewers-count');
    if (viewersCount) {
      viewersCount.textContent = count;
      const prefix = document.getElementById('chat-viewers-prefix');
      if (prefix) prefix.style.display = 'inline';
    }
    if (users && Array.isArray(users)) {
      users.forEach(u => {
        registerUserColor(u.username, u.color);
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

  socket.on('new_message', (msg) => {
    registerUserColor(msg.username || msg.guest_name, msg.color);

    const div = document.createElement('div');
    div.className = 'chat-message-row';
    div.setAttribute('data-msg-id', msg.id);
    div.style.font = '11px Verdana, Geneva, sans-serif';
    div.style.color = '#fff';
    div.style.margin = '1px';
    div.style.wordWrap = 'break-word';
    div.style.overflowWrap = 'break-word';
    div.style.whiteSpace = 'pre-wrap';

    let roleColor = msg.color || '#3b9cd9';

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

    const senderNick = msg.username || msg.guest_name || tClient('guest');

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
    msgSpan.textContent = isReply ? restOfMsg : rawMsg;
    linkifyElement(msgSpan);
    div.appendChild(msgSpan);

    if (window.IS_MODERATOR === true) {
      const controlsSpan = document.createElement('span');
      controlsSpan.innerHTML = ` <span class="btn-pin-message" data-msg-id="${msg.id}" title="${tClient('pin')}" style="display: inline-flex; align-items: center; justify-content: center; vertical-align: middle; margin-left: 5px;"><svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="17" x2="12" y2="22"></line><path d="M5 17h14v-1.76a2 2 0 0 0-.44-1.24l-2.78-3.5A2 2 0 0 1 15 9.24V5a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v4.24c0 .43-.15.85-.44 1.18L5.78 14a2 2 0 0 0-.44 1.24z"></path></svg></span>` +
                            ` <span class="btn-delete-message" data-msg-id="${msg.id}" title="${tClient('delete')}" style="display: inline-flex; align-items: center; justify-content: center; vertical-align: middle; margin-left: 3px;"><svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg></span>`;
      div.appendChild(controlsSpan);
    }

    if (chatMessages) {
      chatMessages.appendChild(div);
      scrollToBottom();
    }
  });

  socket.on('message_pinned', (data) => {
    const pinnedBox = document.getElementById('chat_pinned_box');
    const pinnedContent = document.getElementById('chat_pinned_content');
    if (pinnedBox && pinnedContent) {
      const username = data.username || data.guest_name || tClient('guest');
      const color = data.color || '#3b9cd9';
      const msgText = data.message || '';
      pinnedContent.innerHTML = '';
      const nameSpan = document.createElement('span');
      nameSpan.style.color = color;
      nameSpan.style.fontWeight = 'bold';
      nameSpan.textContent = username;
      pinnedContent.appendChild(nameSpan);
      pinnedContent.appendChild(document.createTextNode(': '));
      const msgSpan = document.createElement('span');
      msgSpan.textContent = msgText;
      linkifyElement(msgSpan);
      pinnedContent.appendChild(msgSpan);
      pinnedBox.style.display = 'flex';
      scrollToBottom();
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

  function sendChatMessage() {
    if (!chatInput) return;
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

  if (chatInput) {
    chatInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        sendChatMessage();
      }
    });
  }

  if (btnChatSubmit) {
    btnChatSubmit.addEventListener('click', sendChatMessage);
  }



  document.addEventListener('click', (e) => {
    // Click on username to mention
    const usernameEl = e.target.closest('.chat-username');
    if (usernameEl && chatInput && !chatInput.disabled) {
      if (chatInput.value.trim() === '') {
        const user = usernameEl.getAttribute('data-username');
        chatInput.value += `${user}, `;
        chatInput.focus();
      }
    }

    // Hide emoji panel if clicked outside
    if (chatEmojiPanel && chatEmojiPanel.style.display === 'flex' && !chatEmojiPanel.contains(e.target) && e.target !== chatEmojiBtn) {
      chatEmojiPanel.style.display = 'none';
    }

    // Pin message click delegation
    const pinBtn = e.target.closest('.btn-pin-message');
    if (pinBtn) {
      const messageId = pinBtn.getAttribute('data-msg-id');
      if (messageId) {
        socket.emit('pin_message', { messageId: parseInt(messageId) });
      }
    }

    // Delete message click delegation
    // Delete message click delegation
    const deleteBtn = e.target.closest('.btn-delete-message');
    if (deleteBtn) {
      const messageId = deleteBtn.getAttribute('data-msg-id');
      if (messageId) {
        socket.emit('delete_message', { messageId: parseInt(messageId) });
      }
    }

    // Unpin message click delegation
    const unpinBtn = e.target.closest('#btn-chat-unpin');
    if (unpinBtn) {
      socket.emit('unpin_message');
    }
  });
})();
