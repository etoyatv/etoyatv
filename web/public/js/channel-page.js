/* Channel page interactions (favorites, comments, bookmarks). CDN via window.YATV_CDN_BASE. */
(function () {
  const cdnBase = (typeof window.YATV_CDN_BASE === 'string') ? window.YATV_CDN_BASE : '';

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function safeCssUrl(u) {
    const t = String(u || '').trim();
    if (!t || /["'()\\\s<>]/.test(t)) return cdnBase + '/images/default_user_avatar.png';
    if (/^https?:\/\//i.test(t) || t.startsWith('/')) return t;
    return cdnBase + (t.startsWith('/') ? t : '/' + t);
  }

  window.toggleFavorite = async function (channelId) {
    try {
      const res = await fetch(`/api/channels/${channelId}/favorite`, { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        const btn = document.getElementById('fan_button_' + channelId);
        const icon = btn && btn.querySelector('.block-head-icon-heart');
        if (icon) {
          if (data.isFan) icon.classList.add('active');
          else icon.classList.remove('active');
        }
        const countEl = document.getElementById('fans_count');
        if (countEl) countEl.innerText = data.count;

        const container = document.getElementById('fans_list_container');
        if (container && data.fans) {
          if (data.fans.length > 0) {
            let html = '<div class="users" style="display: flex; flex-wrap: wrap; gap: 15px 7px;">';
            data.fans.forEach(fan => {
              const onlineClass = fan.is_online ? 'green' : '';
              const rawAvatar = fan.avatar || '/images/default_user_avatar.png';
              const avatarUrl = safeCssUrl(rawAvatar.startsWith('http') ? rawAvatar : (cdnBase + rawAvatar));
              const uname = esc(fan.username);
              const unameEnc = encodeURIComponent(fan.username || '');
              html += `
                      <div class="item" style="margin-right: 0;">
                        <a class="logo" href="/account,userinfo/?username=${unameEnc}"
                          style="background: url('${esc(avatarUrl)}') no-repeat center center; background-size: cover; width: 100px; height: 100px; display: block;"><span
                            class="border_logo"></span></a>
                        <a href="/account,userinfo/?username=${unameEnc}"
                          class="${onlineClass}"
                          style="font-size: 11px; display: block; word-break: break-all; margin-top: 5px;">
                          ${uname}
                        </a>
                      </div>
                    `;
            });
            html += '</div>';
            container.innerHTML = html;
          } else {
            container.innerHTML = '<p style="color: #c0c0b2;">Нет фанатов</p>';
          }
        }
      } else {
        alert(data.error || 'Ошибка');
      }
    } catch (e) {
      alert('Ошибка соединения');
    }
  };

  window.refreshChannelCommentsCount = async function (shortname) {
    try {
      const res = await fetch(`/api/channels/${shortname}/comments_count`);
      const data = await res.json();
      if (data.success && document.getElementById('comments_count')) {
        document.getElementById('comments_count').innerText = data.count;
      }
    } catch (e) { }
  };

  window.loadChannelComments = async function (event, shortname, page) {
    if (event) event.preventDefault();
    try {
      const res = await fetch(`/api/channels/${shortname}/comments_html?cpage=${page}`);
      const html = await res.text();
      document.getElementById('channel_comments_container').innerHTML = html;
    } catch (e) {
      console.error('Error loading comments', e);
    }
  };

  window.addChannelComment = async function (event, shortname) {
    event.preventDefault();
    const textInput = document.getElementById('channelCommentText');
    const text = textInput.value;
    if (!text.trim()) return;
    try {
      const res = await fetch(`/api/channels/${shortname}/comment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text })
      });
      const data = await res.json();
      if (data.success) {
        textInput.value = '';
        window.loadChannelComments(null, shortname, 1);
        window.refreshChannelCommentsCount(shortname);
      } else {
        alert(data.error || 'Ошибка при добавлении комментария');
      }
    } catch (e) {
      alert('Ошибка соединения');
    }
  };

  window.deleteChannelComment = async function (shortname, commentId) {
    yatvConfirm('Вы уверены, что хотите удалить комментарий?', async () => {
      try {
        const res = await fetch(`/api/channels/${shortname}/comment/${commentId}`, {
          method: 'DELETE'
        });
        const data = await res.json();
        if (data.success) {
          window.loadChannelComments(null, shortname, 1);
          window.refreshChannelCommentsCount(shortname);
        } else {
          alert(data.error || 'Ошибка при удалении комментария');
        }
      } catch (e) {
        alert('Ошибка соединения');
      }
    });
  };

  window.toggleFavoriteRecord = async function (recordId) {
    try {
      const res = await fetch(`/api/records/${recordId}/favorite`, { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        const countEl = document.getElementById('record_fans_count_' + recordId);
        const iconEl = document.getElementById('record_fan_icon_' + recordId);
        if (countEl) countEl.innerText = data.count;
        if (iconEl) {
          if (data.isFan) iconEl.classList.add('active');
          else iconEl.classList.remove('active');
        }
      } else {
        alert(data.error || 'Ошибка');
      }
    } catch (e) {
      alert('Ошибка соединения');
    }
  };

  window.toggleBookmark = async function (programId) {
    try {
      const res = await fetch(`/api/programs/${programId}/bookmark`, { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        const countEl = document.getElementById('program_bookmarks_count_' + programId);
        const iconEl = document.getElementById('program_bookmark_icon_' + programId);
        if (countEl) {
          let cur = parseInt(countEl.innerText) || 0;
          countEl.innerText = data.action === 'added' ? cur + 1 : Math.max(0, cur - 1);
        }
        if (iconEl) {
          if (data.action === 'added') iconEl.classList.add('active');
          else iconEl.classList.remove('active');
        }
      } else {
        alert(data.error || 'Ошибка');
      }
    } catch (e) {
      alert('Ошибка сети');
    }
  };
})();
