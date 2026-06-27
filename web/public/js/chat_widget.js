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
    guestName = 'Гость_' + Math.floor(Math.random() * 10000);
    localStorage.setItem('etoyatv_guest_name', guestName);
  }

  socket.emit('join_channel', {
    channelId: window.CHANNEL_ID,
    user: window.CURRENT_USER,
    guestName: guestName,
    color: document.getElementById('chat-color-picker')?.value || '#3b9cd9'
  });

  socket.on('update_users', ({ count }) => {
    const viewersCount = document.getElementById('chat-viewers-count');
    if (viewersCount) viewersCount.textContent = count;
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
    const div = document.createElement('div');
    div.className = 'chat-message-row';
    div.style.font = '11px Verdana, Geneva, sans-serif';
    div.style.color = '#fff';
    div.style.margin = '1px';
    div.style.wordWrap = 'break-word';
    div.style.overflowWrap = 'break-word';
    div.style.wordBreak = 'break-all';
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
      const user = usernameEl.getAttribute('data-username');
      chatInput.value += `${user}, `;
      chatInput.focus();
    }

    // Pin message click delegation
    const pinBtn = e.target.closest('.btn-pin-message');
    if (pinBtn) {
      const messageId = pinBtn.getAttribute('data-msg-id');
      if (messageId) {
        socket.emit('pin_message', { messageId: parseInt(messageId) });
      }
    }

    // Unpin message click delegation
    const unpinBtn = e.target.closest('#btn-chat-unpin');
    if (unpinBtn) {
      socket.emit('unpin_message');
    }
  });
})();
