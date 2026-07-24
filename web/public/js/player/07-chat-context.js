/* === 07-chat-context.js (lines 2199-2424) === */
  // --- Chat Context Menu & Bans ---
  const userContextMenu = document.getElementById('user-context-menu');
  let contextMenuTargetUser = null;

  document.addEventListener('click', (e) => {
    // Pin message click delegation
    const pinBtn = e.target.closest('.btn-pin-message');
    if (pinBtn) {
      const messageId = pinBtn.getAttribute('data-msg-id');
      if (messageId) {
        socket.emit('pin_message', {
          messageId: parseInt(messageId),
          streamIndex: currentSelectedChatStreamIndex || 'common'
        });
      }
      return;
    }

    // Delete message click delegation
    const deleteBtn = e.target.closest('.btn-delete-message');
    if (deleteBtn) {
      const messageId = deleteBtn.getAttribute('data-msg-id');
      if (messageId) {
        socket.emit('delete_message', { messageId: parseInt(messageId) });
      }
      return;
    }

    // Unpin message click delegation
    const unpinBtn = e.target.closest('#btn-chat-unpin');
    if (unpinBtn) {
      socket.emit('unpin_message', {
        streamIndex: currentSelectedChatStreamIndex || 'common'
      });
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
      userContextMenu.style.left = `${e.clientX}px`;
      userContextMenu.style.top = `${e.clientY}px`;
      userContextMenu.style.display = 'block';

      // Attach context menu actions
      const btnProfile = userContextMenu.querySelector('.ctx-profile');
      if (btnProfile) {
        btnProfile.addEventListener('click', () => {
          window.open('/account,userinfo/?username=' + encodeURIComponent(contextMenuTargetUser), '_blank');
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

  // Linkify existing chat messages
  if (chatMessages) {
    chatMessages.querySelectorAll('.chat-message-row').forEach(linkifyElement);
  }
  // Initialize pinned message box display
  updatePinnedBoxDisplay();

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

