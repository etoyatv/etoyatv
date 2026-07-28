/* === 01-core-hls.js (lines 1-757) === */
document.addEventListener('DOMContentLoaded', () => {
  const socket = io();

  // Multi-stream & Camera Chat Tab State variables
  let currentSelectedStreamIndex = 1;
  let currentSelectedChatStreamIndex = null; // null represents the Common Chat
  let lastActiveStreams = [];
  let lastAutopilotData = null;
  let hlsInstance = null;
  let currentlyPlayingLive = false;
  let wasPausedLive = false;
  let userPauseGuardUntil = 0;

  let activePinnedMessages = window.PINNED_MESSAGES || {
    common: null,
    1: null,
    2: null,
    3: null
  };

  function updatePinnedBoxDisplay() {
    const pinnedBox = document.getElementById('chat_pinned_box');
    const pinnedContent = document.getElementById('chat_pinned_content');
    if (!pinnedBox || !pinnedContent) return;

    const chatTabKey = currentSelectedChatStreamIndex === null ? 'common' : String(currentSelectedChatStreamIndex);
    let activePin = activePinnedMessages[chatTabKey];
    
    // Fallback: if camera tab is selected but has no local pinned message, show the Common Chat pin.
    if (!activePin && chatTabKey !== 'common') {
      activePin = activePinnedMessages['common'];
    }

    if (activePin) {
      const username = activePin.username || activePin.guest_name || 'Гость';
      const color = activePin.color || '#3b9cd9';
      const msgText = activePin.message || '';
      pinnedContent.innerHTML = '';
      const nameSpan = document.createElement('span');
      nameSpan.style.color = color;
      nameSpan.style.fontWeight = 'bold';
      nameSpan.textContent = username;
      pinnedContent.appendChild(nameSpan);
      pinnedContent.appendChild(document.createTextNode(': '));
      const msgSpan = document.createElement('span');
      msgSpan.className = 'translatable-live';
      msgSpan.textContent = msgText;
      linkifyElement(msgSpan);
      pinnedContent.appendChild(msgSpan);
      if (typeof window.translateElementLive === 'function') {
        window.translateElementLive(msgSpan);
      }
      pinnedBox.style.display = 'flex';
    } else {
      pinnedBox.style.display = 'none';
      pinnedContent.innerHTML = '';
    }
  }

  const isChatWidget = document.getElementById('chat-tabs-container') !== null && 
                       document.getElementById('etoyatv-video') && 
                       document.getElementById('etoyatv-video').parentElement && 
                       document.getElementById('etoyatv-video').parentElement.style.display === 'none';

  function getStreamUrl(baseRtmpUrl, streamIndex, shortname) {
    if (streamIndex === 1) return baseRtmpUrl;
    const lowerShort = shortname.toLowerCase();
    // Master ABR playlist is per-channel; secondary cameras keep direct MediaMTX URLs.
    if (/live_master\.m3u8/i.test(baseRtmpUrl)) {
      const highBase = (window.RTMP_STREAM_URL || '').replace(/\/$/, '');
      if (highBase) {
        return `${highBase}/${lowerShort}_${streamIndex}/index.m3u8`;
      }
    }
    const regex = new RegExp(`/${lowerShort}/index\\.m3u8`, 'i');
    return baseRtmpUrl.replace(regex, `/${lowerShort}_${streamIndex}/index.m3u8`);
  }

  // Live ABR quality preference: auto | high | low
  let preferredLiveQuality = localStorage.getItem('etoyatv_live_quality') || 'auto';
  if (!['auto', 'high', 'low'].includes(preferredLiveQuality)) preferredLiveQuality = 'auto';

  function ensureQualitySelectorUI() {
    let container = document.getElementById('quality-selector-container');
    if (container) return container;
    const btnFs = document.getElementById('btn-fullscreen');
    if (!btnFs || !btnFs.parentElement) return null;

    container = document.createElement('div');
    container.id = 'quality-selector-container';
    container.style.cssText = 'display:none;position:relative;align-items:center;margin:0;padding:0;flex:0 0 auto;';

    // Compact badge like VOD HD/SD toggle — fits icon bar
    const btn = document.createElement('button');
    btn.id = 'btn-quality';
    btn.type = 'button';
    btn.title = 'Качество';
    btn.style.cssText = 'background:transparent;border:none;color:#fff;font-size:11px;font-weight:bold;cursor:pointer;outline:none;padding:0 2px;margin:0;letter-spacing:0;line-height:1;width:auto;min-width:0;text-align:center;';
    btn.textContent = 'АВТО';

    const menu = document.createElement('div');
    menu.id = 'quality-menu';
    menu.style.cssText = 'display:none;position:absolute;bottom:28px;right:0;background:rgba(0,0,0,0.88);border-radius:3px;padding:4px 0;z-index:30;min-width:72px;box-sizing:border-box;';

    const options = [
      { id: 'auto', label: 'Авто' },
      { id: 'high', label: 'HQ' },
      { id: 'low', label: 'LQ' }
    ];
    options.forEach((opt) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.dataset.quality = opt.id;
      item.style.cssText = 'display:flex;align-items:center;gap:6px;width:100%;background:transparent;border:none;color:#eee;font-size:11px;text-align:left;padding:7px 12px;cursor:pointer;white-space:nowrap;';

      const mark = document.createElement('span');
      mark.className = 'q-mark';
      mark.style.cssText = 'display:inline-block;width:10px;font-size:10px;color:#6fdeee;';
      mark.textContent = '';

      const label = document.createElement('span');
      label.className = 'q-label';
      label.textContent = opt.label;

      item.appendChild(mark);
      item.appendChild(label);
      item.addEventListener('mouseenter', () => { item.style.background = 'rgba(255,255,255,0.1)'; });
      item.addEventListener('mouseleave', () => { item.style.background = 'transparent'; });
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        setLiveQualityPreference(opt.id);
        menu.style.display = 'none';
      });
      menu.appendChild(item);
    });

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
    });
    document.addEventListener('click', () => { menu.style.display = 'none'; });

    container.appendChild(btn);
    container.appendChild(menu);
    btnFs.parentElement.insertBefore(container, btnFs);
    return container;
  }

  function qualityBadge(mode) {
    if (mode === 'high') return 'HQ';
    if (mode === 'low') return 'LQ';
    return 'АВТО';
  }

  function findHighLowLevels(levels) {
    if (!levels || levels.length === 0) return { highIdx: -1, lowIdx: -1 };
    let highIdx = 0;
    let lowIdx = 0;
    for (let i = 1; i < levels.length; i++) {
      const cur = levels[i];
      const high = levels[highIdx];
      const low = levels[lowIdx];
      const curScore = (cur.height || 0) * 1000000 + (cur.bitrate || 0);
      const highScore = (high.height || 0) * 1000000 + (high.bitrate || 0);
      const lowScore = (low.height || 0) * 1000000 + (low.bitrate || 0);
      if (curScore > highScore) highIdx = i;
      if (curScore < lowScore) lowIdx = i;
    }
    return { highIdx, lowIdx };
  }

  function applyLiveQualityPreference() {
    if (!hlsInstance || !hlsInstance.levels || hlsInstance.levels.length < 2) return;
    const { highIdx, lowIdx } = findHighLowLevels(hlsInstance.levels);
    if (preferredLiveQuality === 'high') {
      hlsInstance.currentLevel = highIdx;
      hlsInstance.nextLevel = highIdx;
      hlsInstance.loadLevel = highIdx;
    } else if (preferredLiveQuality === 'low') {
      hlsInstance.currentLevel = lowIdx;
      hlsInstance.nextLevel = lowIdx;
      hlsInstance.loadLevel = lowIdx;
    } else {
      hlsInstance.currentLevel = -1;
      hlsInstance.nextLevel = -1;
      hlsInstance.loadLevel = -1;
    }
    updateQualitySelectorUI();
  }

  function setLiveQualityPreference(mode) {
    if (!['auto', 'high', 'low'].includes(mode)) mode = 'auto';
    preferredLiveQuality = mode;
    localStorage.setItem('etoyatv_live_quality', mode);
    applyLiveQualityPreference();
  }

  function updateQualitySelectorUI(forceHide) {
    const container = ensureQualitySelectorUI();
    if (!container) return;
    const btn = document.getElementById('btn-quality');
    const menu = document.getElementById('quality-menu');
    const hasAbr = !forceHide && hlsInstance && hlsInstance.levels && hlsInstance.levels.length > 1;
    container.style.display = hasAbr ? 'flex' : 'none';
    if (!hasAbr) return;
    if (btn) {
      btn.textContent = qualityBadge(preferredLiveQuality);
      btn.title = preferredLiveQuality === 'high' ? 'Качество: HQ'
        : preferredLiveQuality === 'low' ? 'Качество: LQ'
        : 'Качество: авто';
    }
    if (menu) {
      menu.querySelectorAll('button[data-quality]').forEach((item) => {
        const active = item.dataset.quality === preferredLiveQuality;
        const mark = item.querySelector('.q-mark');
        const label = item.querySelector('.q-label');
        if (mark) mark.textContent = active ? '✓' : '';
        if (label) {
          if (item.dataset.quality === 'high') label.textContent = 'HQ';
          else if (item.dataset.quality === 'low') label.textContent = 'LQ';
        }
        item.style.color = active ? '#fff' : '#ccc';
        item.style.fontWeight = active ? 'bold' : 'normal';
      });
    }
  }

  let lastLoadedLiveUrl = null;
  let lastLoadedStreamUrl = null;
  let autopilotFetchInFlight = false;
  let castReloadIfActive = function () {};

  function clearStuckTransitionFrameSafe() {
    const tc = document.getElementById('etoyatv-transition-canvas');
    if (!tc) return;
    tc.style.transition = 'none';
    tc.style.opacity = '0';
    tc.style.display = 'none';
  }

  function loadStream(url, isLive, offset = 0) {
    // Don't tear down an already-playing live session for the same URL
    if (isLive && currentlyPlayingLive && lastLoadedLiveUrl === url && hlsInstance) {
      // Resume path: previous click paused the <video> but left HLS attached.
      // Returning without play() left the UI stuck until PiP forced play().
      if (video && video.paused) {
        wasPausedLive = false;
        try { hlsInstance.startLoad(); } catch (e) {}
        clearStuckTransitionFrameSafe();
        video.play().catch(e => console.log('Resume play failed:', e));
      }
      return;
    }

    isSwitchingAutopilotVOD = true;
    currentlyPlayingLive = !!isLive;
    lastLoadedLiveUrl = isLive ? url : null;
    lastLoadedStreamUrl = url || null;
    castReloadIfActive(url);
    clearStuckTransitionFrameSafe();
    if (video) {
      video.pause();
      video.removeAttribute('src');
      video.load();
    }
    if (hlsInstance) {
      hlsInstance.destroy();
      hlsInstance = null;
    }
    updateQualitySelectorUI(true);

    const isHls = url.toLowerCase().includes('.m3u8');

    if (isHls && window.Hls && Hls.isSupported()) {
      // Restore pre-regression live config (fMP4 worked with these settings)
      const hlsConfig = isLive ? {
        debug: false,
        enableWorker: true,
        lowLatencyMode: false,
        progressive: false,
        backBufferLength: 15,
        liveSyncDuration: 6.0,
        liveMaxLatencyDuration: 15,
        maxBufferLength: 15,
        liveBackBufferLength: 10,
        startLevel: -1,
        abrEwmaDefaultEstimate: 800000,
        abrBandWidthFactor: 0.9,
        abrBandWidthUpFactor: 0.7,
        maxStarvationDelay: 4,
        maxLoadingDelay: 4
      } : {
        startPosition: offset,
        debug: false,
        enableWorker: true,
        maxBufferLength: 15,
        backBufferLength: 15,
        startLevel: -1
      };

      hlsInstance = new Hls(hlsConfig);
      hlsInstance.loadSource(url);
      hlsInstance.attachMedia(video);
      hlsInstance.on(Hls.Events.MANIFEST_PARSED, function () {
        if (isLive || (hlsInstance.levels && hlsInstance.levels.length > 1)) {
          applyLiveQualityPreference();
          updateQualitySelectorUI();
        } else {
          updateQualitySelectorUI(true);
        }
        if (enableAutoplay) {
          video.play().catch(e => {
            console.log('Autoplay prevented:', e);
            isSwitchingAutopilotVOD = false;
            showControls();
            clearTimeout(noSignalTimeout);
            noSignalTimeout = null;
            if (spinner) spinner.style.display = 'none';
          });
        } else {
          isSwitchingAutopilotVOD = false;
          showControls();
          clearTimeout(noSignalTimeout);
          noSignalTimeout = null;
          if (spinner) spinner.style.display = 'none';
        }
      });
      if (isLive) {
        hlsInstance.on(Hls.Events.ERROR, function (event, errData) {
          if (errData.fatal) {
            switch (errData.type) {
              case Hls.ErrorTypes.NETWORK_ERROR:
                console.log('fatal network error encountered, try to recover');
                if (video && !video.paused) {
                  hlsInstance.startLoad();
                }
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
      }
    } else if (video) {
      const srcUrl = isLive ? url : (url + (url.includes('#') ? '' : '#t=' + offset));
      video.src = srcUrl;
      if (enableAutoplay) {
        video.play().catch(e => {
          console.log('Autoplay prevented:', e);
          isSwitchingAutopilotVOD = false;
          showControls();
          clearTimeout(noSignalTimeout);
          noSignalTimeout = null;
          if (spinner) spinner.style.display = 'none';
        });
      } else {
        isSwitchingAutopilotVOD = false;
        showControls();
        clearTimeout(noSignalTimeout);
        noSignalTimeout = null;
        if (spinner) spinner.style.display = 'none';
      }
    }
  }

  function switchStream(idx) {
    currentSelectedStreamIndex = idx;
    if (socket && socket.connected) {
      socket.emit('change_stream', { streamIndex: idx });
    }
    if (lastAutopilotData && lastAutopilotData.active_streams) {
      renderStreamButtons(lastAutopilotData.active_streams);
    }
    if (lastAutopilotData && lastAutopilotData.rtmp_url) {
      let streamUrl = getStreamUrl(lastAutopilotData.rtmp_url, idx, lastAutopilotData.shortname);
      loadStream(streamUrl, true);
    }
    const hasTabs = document.getElementById('chat-tabs-container') !== null;
    if (hasTabs) {
      switchChatTab(idx);
    } else {
      window.parent.postMessage({ type: 'etoyatv_stream_changed', index: idx }, '*');
    }
    if (typeof window.updateActiveOverlayState === 'function') {
      window.updateActiveOverlayState();
    }
  }

  function renderStreamButtons(activeStreams) {
    const container = document.getElementById('stream-selector-container');
    const buttonsDiv = document.getElementById('stream-buttons');
    if (!container || !buttonsDiv) return;

    if (!activeStreams || activeStreams.length <= 1) {
      container.style.display = 'none';
      buttonsDiv.innerHTML = '';
      return;
    }

    container.style.display = 'flex';
    buttonsDiv.innerHTML = '';

    activeStreams.forEach(idx => {
      const btn = document.createElement('button');
      btn.innerText = idx;
      btn.style.width = '20px';
      btn.style.height = '20px';
      btn.style.borderRadius = '50%';
      btn.style.fontSize = '11px';
      btn.style.fontFamily = 'Tahoma, sans-serif';
      btn.style.display = 'flex';
      btn.style.alignItems = 'center';
      btn.style.justifyContent = 'center';
      btn.style.fontWeight = 'bold';
      btn.style.border = '1px solid rgba(255,255,255,0.4)';
      btn.style.cursor = 'pointer';
      btn.style.padding = '0';
      btn.style.margin = '0';
      btn.style.transition = 'all 0.2s';
      btn.style.outline = 'none';

      const color = window.PLAYER_COLOR || '#00A3E0';

      if (idx === currentSelectedStreamIndex) {
        btn.style.setProperty('background-color', color, 'important');
        btn.style.setProperty('color', '#000', 'important');
        btn.style.setProperty('border-color', color, 'important');
      } else {
        btn.style.setProperty('background-color', '#fff', 'important');
        btn.style.setProperty('color', '#000', 'important');
        btn.style.setProperty('border-color', '#fff', 'important');
      }

      btn.addEventListener('click', () => {
        if (idx === currentSelectedStreamIndex) return;
        switchStream(idx);
      });

      btn.addEventListener('mouseenter', () => {
        if (idx !== currentSelectedStreamIndex) {
          btn.style.setProperty('background-color', color, 'important');
          btn.style.setProperty('border-color', color, 'important');
          btn.style.setProperty('color', '#000', 'important');
        }
      });
      btn.addEventListener('mouseleave', () => {
        if (idx !== currentSelectedStreamIndex) {
          btn.style.setProperty('background-color', '#fff', 'important');
          btn.style.setProperty('border-color', '#fff', 'important');
          btn.style.setProperty('color', '#000', 'important');
        }
      });

      buttonsDiv.appendChild(btn);
    });
  }

  let hasInitializedChatTab = false;

  function renderChatTabs(activeStreams) {
    const tabsContainer = document.getElementById('chat-tabs-container');
    if (!tabsContainer) return;

    if (!activeStreams || activeStreams.length <= 1) {
      tabsContainer.style.display = 'none';
      tabsContainer.innerHTML = '';
      hasInitializedChatTab = false;
      filterChatMessages();
      return;
    }

    if (!hasInitializedChatTab) {
      currentSelectedChatStreamIndex = activeStreams[0] || 1;
      hasInitializedChatTab = true;
    }

    tabsContainer.style.display = 'flex';
    tabsContainer.innerHTML = '';

    if (currentSelectedChatStreamIndex !== null && !activeStreams.includes(currentSelectedChatStreamIndex)) {
      currentSelectedChatStreamIndex = null;
    }

    const isObs = window.location.search.includes('obs=') || navigator.userAgent.indexOf('OBS') !== -1;
    const tabs = [null, ...activeStreams];
    tabs.forEach(tabIdx => {
      if (!isObs && tabIdx !== null && tabIdx !== currentSelectedStreamIndex) {
        return;
      }
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.style.padding = '4px 10px';
      btn.style.fontSize = '11px';
      btn.style.fontFamily = 'Tahoma, sans-serif';
      btn.style.border = 'none';
      btn.style.cursor = 'pointer';
      btn.style.borderRadius = '3px';
      btn.style.fontWeight = 'bold';
      btn.style.transition = 'background-color 0.2s, color 0.2s';
      btn.style.outline = 'none';

      if (tabIdx === null) {
        btn.innerText = window.t('Общий');
      } else {
        btn.innerText = window.t('Камера') + ' ' + tabIdx;
      }

      const isActive = currentSelectedChatStreamIndex === tabIdx;
      if (isActive) {
        btn.style.background = window.PLAYER_COLOR || '#326CBA';
        btn.style.color = '#fff';
      } else {
        btn.style.background = '#222';
        btn.style.color = '#ccc';
      }

      btn.addEventListener('click', () => {
        switchChatTab(tabIdx);
      });

      tabsContainer.appendChild(btn);
    });

    filterChatMessages();
  }

  function switchChatTab(idx) {
    currentSelectedChatStreamIndex = idx;
    if (idx !== null && currentSelectedStreamIndex !== idx) {
      currentSelectedStreamIndex = idx;
      if (socket && socket.connected) {
        socket.emit('change_stream', { streamIndex: idx });
      }
    }
    if (lastAutopilotData && lastAutopilotData.active_streams) {
      renderChatTabs(lastAutopilotData.active_streams);
    } else {
      renderChatTabs([]);
    }
    if (typeof window.updateViewerCountsDisplay === 'function') {
      window.updateViewerCountsDisplay();
    }
    if (typeof window.updateUsersListDisplay === 'function') {
      window.updateUsersListDisplay();
    }
    updatePinnedBoxDisplay();
    if (typeof window.updateActiveOverlayState === 'function') {
      window.updateActiveOverlayState();
    }
  }

  function filterChatMessages() {
    const chatContainer = document.getElementById('chat_text_field');
    if (!chatContainer) return;

    const rows = chatContainer.getElementsByClassName('chat-message-row');
    const activeStreams = (lastAutopilotData && lastAutopilotData.is_live) ? (lastAutopilotData.active_streams || []) : [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const msgStreamIdxStr = row.getAttribute('data-stream-index');
      
      if (activeStreams.length <= 1) {
        row.style.display = 'block';
        continue;
      }

      if (currentSelectedChatStreamIndex === null) {
        if (!msgStreamIdxStr) {
          row.style.display = 'block';
        } else {
          row.style.display = 'none';
        }
      } else {
        if (msgStreamIdxStr === String(currentSelectedChatStreamIndex)) {
          row.style.display = 'block';
        } else {
          row.style.display = 'none';
        }
      }
    }
    
    scrollToBottom();
  }

  window.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'etoyatv_stream_changed') {
      const idx = e.data.index;
      switchChatTab(idx);
    }
  });
  const svgPlay = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle;"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>`;
  const svgPause = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle;"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg>`;
  const svgVolume = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle;"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path></svg>`;
  const svgMuted = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle;"><path d="M11 5L6 9H2v6h4l5 4V5z"></path><line x1="1.5" y1="20.5" x2="16.5" y2="5.5" stroke="#ff3b30" stroke-width="2.5"></line></svg>`;
  const urlParams = new URLSearchParams(window.location.search);
  const autoplayParam = urlParams.get('autoplay');
  let enableAutoplay = autoplayParam !== '0' && autoplayParam !== 'false';
  let isSwitchingAutopilotVOD = false;
  let spinnerTimeout;
  let noSignalTimeout = null;

  function showNoSignal() {
    const nosignalOverlay = document.getElementById('etoyatv-nosignal-overlay');
    if (nosignalOverlay) {
      nosignalOverlay.style.display = 'flex';
    }
    const spinner = document.getElementById('etoyatv-spinner');
    if (spinner) {
      spinner.style.display = 'none';
    }
  }

  function hideNoSignal() {
    const nosignalOverlay = document.getElementById('etoyatv-nosignal-overlay');
    if (nosignalOverlay) {
      nosignalOverlay.style.display = 'none';
    }
    clearTimeout(noSignalTimeout);
    noSignalTimeout = null;
  }

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
    video.addEventListener('loadstart', () => {
      clearTimeout(spinnerTimeout);
      const nosignalOverlay = document.getElementById('etoyatv-nosignal-overlay');
      const isNoSignalVisible = nosignalOverlay && nosignalOverlay.style.display === 'flex';
      
      if (!isNoSignalVisible) {
        if (isSwitchingAutopilotVOD) {
          spinnerTimeout = setTimeout(() => {
            if (spinner) spinner.style.display = 'block';
          }, 1500);
        } else {
          if (spinner) spinner.style.display = 'block';
        }
      }
      if (currentlyPlayingLive && !video.paused) {
        if (!noSignalTimeout) {
          noSignalTimeout = setTimeout(showNoSignal, 15000);
        }
      }
    });
    video.addEventListener('waiting', () => {
      clearTimeout(spinnerTimeout);
      const nosignalOverlay = document.getElementById('etoyatv-nosignal-overlay');
      const isNoSignalVisible = nosignalOverlay && nosignalOverlay.style.display === 'flex';
      
      if (!isNoSignalVisible) {
        if (isSwitchingAutopilotVOD) {
          spinnerTimeout = setTimeout(() => {
            if (spinner) spinner.style.display = 'block';
          }, 1500);
        } else {
          if (spinner) spinner.style.display = 'block';
        }
      }
      if (currentlyPlayingLive && !video.paused) {
        if (!noSignalTimeout) {
          noSignalTimeout = setTimeout(showNoSignal, 15000);
        }
      }
    });
    video.addEventListener('playing', () => {
      clearTimeout(spinnerTimeout);
      if (spinner) spinner.style.display = 'none';
      hideNoSignal();
    });
    video.addEventListener('canplay', () => {
      clearTimeout(spinnerTimeout);
      if (spinner) spinner.style.display = 'none';
      hideNoSignal();
    });

    // Live fMP4/MSE can stall visually while hls.js still fetches segments.
    // Entering/leaving PiP recovers via play() — mirror that automatically.
    let lastProgressMediaTime = -1;
    let lastProgressAt = 0;
    let freezeRecoveryUntil = 0;
    const clearStuckTransitionFrame = () => {
      const tc = document.getElementById('etoyatv-transition-canvas');
      if (!tc) return;
      tc.style.transition = 'none';
      tc.style.opacity = '0';
      tc.style.display = 'none';
    };
    const kickFrozenPlayback = (reason) => {
      if (!video || !currentlyPlayingLive) return;
      // Always drop a stuck freeze-frame overlay (even during PiP transitions)
      clearStuckTransitionFrame();
      // Never fight an intentional user pause (center click / pause button)
      if (wasPausedLive || Date.now() < userPauseGuardUntil) return;
      if (pipIgnoreMediaEvents) return;
      if (video.paused) return;
      if (Date.now() < freezeRecoveryUntil) return;
      freezeRecoveryUntil = Date.now() + 2500;
      console.warn('[PLAYER] Frozen live recovery:', reason, {
        paused: video.paused,
        currentTime: video.currentTime,
        readyState: video.readyState,
        pip: document.pictureInPictureElement === video
      });
      try {
        if (hlsInstance) {
          try { hlsInstance.startLoad(); } catch (e) {}
          try { hlsInstance.recoverMediaError(); } catch (e) {}
        }
        // Nudge decoder without a visible seek jump when possible
        const t = video.currentTime;
        try {
          if (Number.isFinite(t) && t > 0.25) video.currentTime = t;
        } catch (e) {}
        video.play().catch(() => {});
      } catch (e) {
        console.warn('[PLAYER] freeze recovery failed:', e);
      }
    };
    video.addEventListener('timeupdate', () => {
      lastProgressMediaTime = video.currentTime;
      lastProgressAt = Date.now();
    });
    setInterval(() => {
      if (!video || !currentlyPlayingLive || video.ended) return;
      // Stuck freeze-frame overlay covering a live video underneath
      const tc = document.getElementById('etoyatv-transition-canvas');
      if (tc && tc.style.display !== 'none' && parseFloat(tc.style.opacity || '0') > 0.4) {
        clearStuckTransitionFrame();
      }
      if (wasPausedLive || video.paused || pipIgnoreMediaEvents) return;
      if (Date.now() < userPauseGuardUntil) return;
      if (!lastProgressAt) return;
      if (Date.now() - lastProgressAt < 2800) return;
      // currentTime not advancing while "playing" — decoder/UI stall
      if (video.currentTime === lastProgressMediaTime || Date.now() - lastProgressAt >= 2800) {
        kickFrozenPlayback('timeupdate stalled');
      }
    }, 1000);
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

