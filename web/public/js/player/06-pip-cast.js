/* === 06-pip-cast.js (lines 1635-2198) === */
  // ----------------------------------------------------
  // Picture-in-Picture (YouTube-style) + Chromecast
  // ----------------------------------------------------
  const btnPopout = document.getElementById('btn-popout');
  const btnCast = document.getElementById('btn-cast');
  const pipOverlay = document.getElementById('etoyatv-pip-overlay');
  const btnPipReturn = document.getElementById('btn-pip-return');
  let castIsActive = false;
  let castMutedBefore = false;
  let pipIgnoreMediaEvents = false;

  function getChannelShortname() {
    if (window.CHANNEL_SHORTNAME) return String(window.CHANNEL_SHORTNAME);
    if (lastAutopilotData && lastAutopilotData.shortname) return String(lastAutopilotData.shortname);
    const m = window.location.pathname.match(/\/widget\/player\/([^/?#]+)/);
    if (m) return decodeURIComponent(m[1]);
    const path = window.location.pathname.replace(/\/+$/, '');
    const parts = path.split('/').filter(Boolean);
    if (parts.length === 1 && !parts[0].startsWith('ru')) return parts[0];
    return '';
  }

  function getActiveStreamUrl() {
    let url = lastLoadedStreamUrl || lastLoadedLiveUrl || (video && video.currentSrc) || null;
    if (!url) return null;
    try {
      // Chromecast requires an absolute https URL
      url = new URL(url, window.location.href).href;
    } catch (e) {}
    return url;
  }

  function buildCastMediaInfo(streamUrl) {
    const mediaInfo = new window.chrome.cast.media.MediaInfo(streamUrl, 'application/x-mpegURL');
    mediaInfo.streamType = currentlyPlayingLive
      ? window.chrome.cast.media.StreamType.LIVE
      : window.chrome.cast.media.StreamType.BUFFERED;
    mediaInfo.metadata = new window.chrome.cast.media.GenericMediaMetadata();
    mediaInfo.metadata.metadataType = window.chrome.cast.media.MetadataType.GENERIC;
    mediaInfo.metadata.title = (window.CHANNEL_SHORTNAME || 'ЭтоЯTV') + (currentlyPlayingLive ? ' — эфир' : '');
    // Live MediaMTX HLS is fMP4 — Default Receiver needs these hints
    try {
      if (window.chrome.cast.media.HlsSegmentFormat) {
        mediaInfo.hlsSegmentFormat = window.chrome.cast.media.HlsSegmentFormat.FMP4;
      }
      if (window.chrome.cast.media.HlsVideoSegmentFormat) {
        mediaInfo.hlsVideoSegmentFormat = window.chrome.cast.media.HlsVideoSegmentFormat.FMP4;
      }
    } catch (e) {}
    return mediaInfo;
  }

  function isPipSupported() {
    return !!(video && document.pictureInPictureEnabled && typeof video.requestPictureInPicture === 'function');
  }

  function setPipOverlayVisible(visible) {
    if (!pipOverlay) return;
    pipOverlay.style.display = visible ? 'flex' : 'none';
  }

  function syncPipUi() {
    const active = !!(document.pictureInPictureElement && document.pictureInPictureElement === video);
    setPipOverlayVisible(active);
    if (btnPopout) {
      btnPopout.title = active ? 'Вернуть плеер' : 'Мини-плеер';
      btnPopout.style.opacity = active ? '1' : '';
    }
  }

  async function exitPlayerPip() {
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      }
    } catch (e) {
      console.warn('[PiP] exit failed:', e);
    }
    syncPipUi();
  }

  function waitForVideoMetadata(timeoutMs) {
    return new Promise((resolve, reject) => {
      if (!video) {
        reject(new Error('no video'));
        return;
      }
      if (video.readyState >= 1 && video.videoWidth > 0) {
        resolve();
        return;
      }

      let settled = false;
      let timer = null;
      let poll = null;
      const done = (err) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (poll) clearInterval(poll);
        video.removeEventListener('loadedmetadata', onReady);
        video.removeEventListener('loadeddata', onReady);
        video.removeEventListener('playing', onReady);
        video.removeEventListener('canplay', onReady);
        if (err) reject(err);
        else resolve();
      };
      const onReady = () => {
        if (video.readyState >= 1 && (video.videoWidth > 0 || video.readyState >= 2)) done();
      };
      timer = setTimeout(() => {
        done(new Error('Метаданные видео ещё не загружены. Дождитесь начала воспроизведения.'));
      }, Math.min(timeoutMs || 2500, 2500));

      video.addEventListener('loadedmetadata', onReady);
      video.addEventListener('loadeddata', onReady);
      video.addEventListener('playing', onReady);
      video.addEventListener('canplay', onReady);
      poll = setInterval(onReady, 100);
      onReady();
    });
  }

  function recoverHlsAfterPipAttempt() {
    try {
      setPipOverlayVisible(false);
      if (hlsInstance && typeof hlsInstance.startLoad === 'function') {
        hlsInstance.startLoad();
      }
      if (video && video.paused) {
        video.play().catch(() => {});
      }
    } catch (e) {}
  }

  async function togglePlayerPip() {
    if (!video) return;

    if (document.pictureInPictureElement === video) {
      await exitPlayerPip();
      return;
    }

    if (!isPipSupported()) {
      // Fallback: separate browser window with widget player
      const short = getChannelShortname();
      if (!short) {
        alert('Мини-плеер в этом браузере недоступен.');
        return;
      }
      const url = `/widget/player/${encodeURIComponent(short)}?autoplay=1`;
      const w = 960;
      const h = 540;
      const left = Math.max(0, Math.round((window.screen.width - w) / 2));
      const top = Math.max(0, Math.round((window.screen.height - h) / 2));
      const features = `popup=yes,width=${w},height=${h},left=${left},top=${top},menubar=no,toolbar=no,location=no,status=no,resizable=yes,scrollbars=no`;
      const win = window.open(url, 'etoyatv_player_popout', features);
      if (!win) {
        alert('Разрешите всплывающие окна или используйте Chrome/Edge для мини-плеера.');
        return;
      }
      try {
        video.pause();
        video.muted = true;
      } catch (e) {}
      return;
    }

    // Only open PiP when video already has frames — avoids hanging play()/metadata waits
    if (video.readyState < 1 || video.videoWidth === 0) {
      if (video.paused) {
        try { await Promise.race([video.play(), new Promise((r) => setTimeout(r, 800))]); } catch (e) {}
      }
      if (video.readyState < 1 || video.videoWidth === 0) {
        try { await waitForVideoMetadata(2000); } catch (e) {}
      }
      if (video.readyState < 1 || video.videoWidth === 0) {
        alert('Дождитесь начала воспроизведения, затем снова нажмите «Мини-плеер».');
        recoverHlsAfterPipAttempt();
        return;
      }
    }

    pipIgnoreMediaEvents = true;
    try {
      await video.requestPictureInPicture();
    } catch (e) {
      console.error('[PiP] request failed:', e);
      recoverHlsAfterPipAttempt();
      const msg = (e && e.message) ? String(e.message) : String(e);
      if (/Metadata|метаданн|user.?gesture|NotAllowed/i.test(msg)) {
        alert('Дождитесь начала воспроизведения, затем снова нажмите «Мини-плеер».');
      } else {
        alert('Не удалось открыть мини-плеер: ' + msg);
      }
    } finally {
      // Keep ignoring brief pause/play that Chromium emits around PiP enter
      setTimeout(() => { pipIgnoreMediaEvents = false; }, 750);
    }
  }

  if (video) {
    video.addEventListener('enterpictureinpicture', () => {
      pipIgnoreMediaEvents = true;
      syncPipUi();
      try {
        if (hlsInstance && typeof hlsInstance.startLoad === 'function') hlsInstance.startLoad();
        video.play().catch(() => {});
      } catch (e) {}
      setTimeout(() => { pipIgnoreMediaEvents = false; }, 750);
    });
    video.addEventListener('leavepictureinpicture', () => {
      pipIgnoreMediaEvents = true;
      syncPipUi();
      try {
        const tc = document.getElementById('etoyatv-transition-canvas');
        if (tc) {
          tc.style.transition = 'none';
          tc.style.opacity = '0';
          tc.style.display = 'none';
        }
        if (hlsInstance && typeof hlsInstance.startLoad === 'function') hlsInstance.startLoad();
        video.play().catch(() => {});
      } catch (e) {}
      setTimeout(() => { pipIgnoreMediaEvents = false; }, 750);
    });
  }

  if (btnPipReturn) {
    btnPipReturn.addEventListener('click', (e) => {
      e.preventDefault();
      exitPlayerPip();
    });
  }

  if (btnPopout) {
    if (!isPipSupported() && /\/widget\/player\//.test(window.location.pathname)) {
      // Widget + no PiP: hide (would only open another widget)
      btnPopout.style.display = 'none';
    } else {
      btnPopout.addEventListener('click', (e) => {
        e.preventDefault();
        togglePlayerPip();
      });
    }
  }

  syncPipUi();

  function initChromecast() {
    if (!btnCast) return;

    const loadCastMedia = (session, streamUrl) => {
      if (!session || !streamUrl) return;
      try {
        const request = new window.chrome.cast.media.LoadRequest(buildCastMediaInfo(streamUrl));
        session.loadMedia(request).then(
          () => {
            castIsActive = true;
            btnCast.style.opacity = '1';
            btnCast.title = 'Остановить Cast';
            if (video) {
              castMutedBefore = video.muted;
              video.muted = true;
              try { video.pause(); } catch (e) {}
            }
          },
          (err) => {
            console.error('[Cast] loadMedia failed:', err, streamUrl);
            castIsActive = false;
            alert('Chromecast не смог открыть поток. Проверьте, что ТВ в той же сети Wi‑Fi.');
          }
        );
      } catch (e) {
        console.error('[Cast] loadMedia error:', e);
      }
    };

    castReloadIfActive = function (url) {
      if (!castIsActive || !url) return;
      try {
        const ctx = window.cast.framework.CastContext.getInstance();
        const session = ctx.getCurrentSession();
        if (session) loadCastMedia(session, url);
      } catch (e) {}
    };

    const onCastApiAvailable = (isAvailable) => {
      if (!isAvailable || !window.cast || !window.cast.framework) {
        btnCast.style.display = 'none';
        return;
      }

      try {
        const context = window.cast.framework.CastContext.getInstance();
        context.setOptions({
          receiverApplicationId: window.chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
          autoJoinPolicy: window.chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED
        });

        const syncCastButtonVisibility = () => {
          try {
            const state = context.getCastState();
            const CastState = window.cast.framework.CastState;
            // Hide when no receivers on the LAN; show when devices exist (even if not yet casting)
            const hasDevices = state && state !== CastState.NO_DEVICES_AVAILABLE;
            btnCast.style.display = hasDevices ? 'flex' : 'none';
          } catch (e) {
            btnCast.style.display = 'none';
          }
        };

        context.addEventListener(
          window.cast.framework.CastContextEventType.CAST_STATE_CHANGED,
          () => { syncCastButtonVisibility(); }
        );

        context.addEventListener(
          window.cast.framework.CastContextEventType.SESSION_STATE_CHANGED,
          (event) => {
            const state = event.sessionState;
            if (state === window.cast.framework.SessionState.SESSION_STARTED ||
                state === window.cast.framework.SessionState.SESSION_RESUMED) {
              loadCastMedia(event.session, getActiveStreamUrl());
            } else if (state === window.cast.framework.SessionState.SESSION_ENDED) {
              castIsActive = false;
              btnCast.title = 'Chromecast';
              btnCast.style.opacity = '0.9';
              if (video) {
                video.muted = castMutedBefore;
              }
            }
            syncCastButtonVisibility();
          }
        );

        btnCast.style.opacity = '0.9';
        syncCastButtonVisibility();

        btnCast.addEventListener('click', async (e) => {
          e.preventDefault();
          const castContext = window.cast.framework.CastContext.getInstance();
          if (castIsActive) {
            try {
              await castContext.endCurrentSession(true);
            } catch (err) {
              console.error('[Cast] end session:', err);
            }
            return;
          }
          const streamUrl = getActiveStreamUrl();
          if (!streamUrl) {
            alert('Сейчас нечего транслировать на ТВ — дождитесь загрузки эфира.');
            return;
          }
          try {
            await castContext.requestSession();
          } catch (err) {
            // User cancelled picker — ignore
            if (err && String(err).indexOf('cancel') === -1) {
              console.warn('[Cast] requestSession:', err);
            }
          }
        });
      } catch (e) {
        console.warn('[Cast] init failed:', e);
        btnCast.style.display = 'none';
      }
    };

    if (window.cast && window.cast.framework) {
      onCastApiAvailable(true);
      return;
    }

    window['__onGCastApiAvailable'] = function (isAvailable) {
      onCastApiAvailable(!!isAvailable);
    };

    if (!document.querySelector('script[data-etoyatv-cast]')) {
      const script = document.createElement('script');
      script.src = 'https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1';
      script.async = true;
      script.setAttribute('data-etoyatv-cast', '1');
      document.head.appendChild(script);
    }
  }

  initChromecast();

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

      if (btnVolume) btnVolume.innerHTML = video.muted ? svgMuted : svgVolume;
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
      video.addEventListener('play', () => {
        if (isSwitchingAutopilotVOD) return;
        if (pipIgnoreMediaEvents || document.pictureInPictureElement === video) {
          // PiP enter/leave briefly toggles play; keep HLS loading, don't force live reload
          if (hlsInstance && typeof hlsInstance.startLoad === 'function') {
            try { hlsInstance.startLoad(); } catch (e) {}
          }
          showControls();
          return;
        }
        showControls();

        if (hlsInstance) {
          if (currentlyPlayingLive && wasPausedLive) {
            wasPausedLive = false;
            // Do NOT force-reload the whole live session — that paints transition-canvas
            // and often leaves a frozen frame until PiP nudges play(). Just resume HLS.
            console.log('[PLAYER] Resumed live stream. Keeping session, starting load.');
            clearStuckTransitionFrameSafe();
            try { hlsInstance.startLoad(); } catch (e) {}
            try {
              if (Number.isFinite(hlsInstance.liveSyncPosition)) {
                video.currentTime = hlsInstance.liveSyncPosition;
              }
            } catch (e) {}
          } else {
            console.log('[PLAYER] Resumed. Resuming Hls.js loading.');
            hlsInstance.startLoad();
          }
        }
      });
      video.addEventListener('pause', () => {
        clearTimeout(noSignalTimeout);
        noSignalTimeout = null;
        if (spinner) spinner.style.display = 'none';

        if (isSwitchingAutopilotVOD || video.ended) return;
        // Chromium emits pause around Picture-in-Picture; stopping HLS here freezes live
        if (pipIgnoreMediaEvents || document.pictureInPictureElement === video) {
          return;
        }
        uiElements.forEach(el => el.style.opacity = '1');
        clearTimeout(hideTimeout);

        if (hlsInstance) {
          // Live: never stopLoad on pause — race with PiP/brief pauses freezes the picture.
          // Mark wasPausedLive so play() snaps back to the live edge.
          if (currentlyPlayingLive) {
            wasPausedLive = true;
            console.log('[PLAYER] Paused live. Keeping Hls.js loading; will reload on resume.');
          } else {
            console.log('[PLAYER] Paused. Stopping Hls.js loading.');
            hlsInstance.stopLoad();
          }
        }
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
        const chatEmojiPanel = document.getElementById('chat-emoji-panel');
        if (chatEmojiPanel) chatEmojiPanel.style.display = 'none';
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
        window.openClearChatModal();
        chatMenu.style.display = 'none';
      });
    }

    const btnBanGuests = document.getElementById('btn-ban-guests');
    if (btnBanGuests) {
      btnBanGuests.addEventListener('click', () => {
        const text = btnBanGuests.textContent;
        const isBanning = !text.includes('Разрешить') && !text.includes('Allow') && !text.includes('Дозволити') && !text.includes('Дазволіць');
        socket.emit('toggle_guests', { allowed: !isBanning });
        btnBanGuests.textContent = isBanning ? window.t('Разрешить гостей') : window.t('Запретить гостей');
        chatMenu.style.display = 'none';
      });
    }

    const btnToggleChat = document.getElementById('btn-toggle-chat');
    if (btnToggleChat) {
      btnToggleChat.addEventListener('click', () => {
        const text = btnToggleChat.textContent;
        const isDisabling = !text.includes('Включить') && !text.includes('Enable') && !text.includes('Увімкнути') && !text.includes('Уключыць');
        socket.emit('toggle_chat', { enabled: !isDisabling });
        btnToggleChat.textContent = isDisabling ? window.t('Включить чат') : window.t('Выключить чат');
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
        const newNick = prompt(window.t('Введите новый никнейм (максимум 13 символов):'), guestName);
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

