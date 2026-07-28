/* === 08-autopilot.js (lines 2425-2741) === */
  // --- Autopilot Logic ---
  const offlineOverlay = document.getElementById('etoyatv-offline-overlay');
  let autopilotTimer = null;
  let crossfadeTimer = null;
  let activeHls = null;
  let inactiveHls = null;

  let isInitialAutopilotLoad = true;

  async function fetchAutopilotStatus(force = false) {
    if (autopilotFetchInFlight && !force) return;
    autopilotFetchInFlight = true;
    try {
      const res = await fetch(`/api/channels/${window.CHANNEL_ID}/autopilot_status`);
      const data = await res.json();

      lastAutopilotData = data;

      if (autopilotTimer) {
        clearTimeout(autopilotTimer);
        autopilotTimer = null;
      }

      if (data.hide_live_badge !== undefined) {
        window.HIDE_LIVE_BADGE = data.hide_live_badge;
      }

      if (!data.active) {
        // Offline
        hideNoSignal();
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

        currentlyPlayingLive = false;
        lastLoadedLiveUrl = null;
        updateLiveBadgeVisibility();

        if (isChatWidget) {
          renderChatTabs([]);
        } else {
          isSwitchingAutopilotVOD = false;
          video.pause();
          video.removeAttribute('src');
          video.load();
          if (hlsInstance) { hlsInstance.destroy(); hlsInstance = null; }
          const container = document.getElementById('stream-selector-container');
          if (container) container.style.display = 'none';
          const chatTabsEl = document.getElementById('chat-tabs-container');
          if (chatTabsEl) {
            renderChatTabs([]);
          }
        }

        // Schedule a retry to check if stream or autopilot comes back
        autopilotTimer = setTimeout(() => fetchAutopilotStatus(false), 30000); // 30s poll if offline
        return;
      }

      const isInitial = isInitialAutopilotLoad;
      isInitialAutopilotLoad = false;

      // If already playing live and we are checking status, do not interrupt
      if (data.is_live && currentlyPlayingLive && !force) {
        if (isChatWidget) {
          renderChatTabs(data.active_streams);
        } else {
          renderStreamButtons(data.active_streams);
          const chatTabsEl = document.getElementById('chat-tabs-container');
          if (chatTabsEl) {
            renderChatTabs(data.active_streams);
          }
        }
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
      if (offlineOverlay) offlineOverlay.style.display = 'none';

      if (isChatWidget) {
        currentlyPlayingLive = !!data.is_live;
        updateLiveBadgeVisibility();
        
        renderChatTabs(data.is_live ? data.active_streams : []);
        
        let nextPoll = 30000;
        if (!data.is_live && data.nextUpdateIn !== undefined) {
          nextPoll = data.nextUpdateIn * 1000 + 500;
        }
        if (isNaN(nextPoll) || nextPoll < 5000) nextPoll = 5000;
        autopilotTimer = setTimeout(() => fetchAutopilotStatus(false), nextPoll);
        return;
      }

      const transitionCanvas = document.getElementById('etoyatv-transition-canvas');
      if (transitionCanvas && video.readyState >= 2 && (video.currentTime > 0 || !video.paused)) {
        transitionCanvas.width = video.videoWidth || 640;
        transitionCanvas.height = video.videoHeight || 360;
        const ctx = transitionCanvas.getContext('2d');
        ctx.drawImage(video, 0, 0, transitionCanvas.width, transitionCanvas.height);
        transitionCanvas.style.transition = 'none';
        transitionCanvas.style.opacity = '1';
        transitionCanvas.style.display = 'block';
      }

      function onNewVideoPlaying() {
        isSwitchingAutopilotVOD = false;
        if (transitionSafetyTimer) {
          clearTimeout(transitionSafetyTimer);
          transitionSafetyTimer = null;
        }

        // Restore volume and muted state to override any browser/load resets
        let savedVol = localStorage.getItem('etoyatv_volume');
        let savedMuted = localStorage.getItem('etoyatv_muted') === 'true';
        if (video) {
          video.muted = savedMuted;
          video.volume = savedVol !== null ? parseFloat(savedVol) : 1;
        }

        if (transitionCanvas) {
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
      // If 'playing' never fires (live stall), don't leave a frozen frame forever
      let transitionSafetyTimer = setTimeout(() => {
        transitionSafetyTimer = null;
        video.removeEventListener('playing', onNewVideoPlaying);
        isSwitchingAutopilotVOD = false;
        if (transitionCanvas) {
          transitionCanvas.style.transition = 'none';
          transitionCanvas.style.opacity = '0';
          transitionCanvas.style.display = 'none';
        }
      }, 4000);

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
        updateLiveBadgeVisibility();
        const recordBtn = document.getElementById('btn-record-stream');
        if (recordBtn) recordBtn.style.display = 'flex';
        const progTitle = document.getElementById('channel_program_title');
        if (progTitle) {
          progTitle.textContent = '→ ';
          const titleSpan = document.createElement('span');
          titleSpan.className = 'blue';
          titleSpan.id = 'current_live_title_span';
          titleSpan.textContent = titleText;
          progTitle.appendChild(titleSpan);
          if (data.is_owner && data.shortname) {
            const editBtn = document.createElement('button');
            editBtn.title = 'Изменить название передачи';
            editBtn.style.cssText = 'background:none;border:none;cursor:pointer;font-size:12px;';
            editBtn.textContent = '✏️';
            editBtn.addEventListener('click', () => window.editLiveTitle(data.shortname));
            progTitle.appendChild(document.createTextNode(' '));
            progTitle.appendChild(editBtn);
          }
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

        let activeStreams = data.active_streams || [1];
        if (!activeStreams.includes(currentSelectedStreamIndex)) {
          currentSelectedStreamIndex = activeStreams[0] || 1;
        }

        renderStreamButtons(activeStreams);
        const chatTabsEl = document.getElementById('chat-tabs-container');
        if (chatTabsEl) {
          renderChatTabs(activeStreams);
        }

        let streamUrl = getStreamUrl(data.rtmp_url, currentSelectedStreamIndex, data.shortname);
        loadStream(streamUrl, true);
      } else {
        currentlyPlayingLive = false;

        const liveLabel = document.getElementById('player_live_label');
        if (liveLabel) liveLabel.style.display = 'none';
        const recordBtn = document.getElementById('btn-record-stream');
        if (recordBtn) recordBtn.style.display = 'none';
        const progTitle = document.getElementById('channel_program_title');
        if (progTitle) {
          progTitle.innerHTML = `→ <span class="blue">${typeof window.t === 'function' ? window.t('Автопилот') : 'Автопилот'}</span>`;
        }

        const scheduleLiveItem = document.getElementById('schedule_live_item');
        const scheduleEmptyMsg = document.getElementById('schedule_empty_msg');
        if (scheduleLiveItem) scheduleLiveItem.style.display = 'none';
        if (scheduleEmptyMsg) scheduleEmptyMsg.style.display = 'table';

        const progCountEl = document.getElementById('program_count');
        if (progCountEl) {
          progCountEl.innerText = (data.totalPrograms !== undefined ? data.totalPrograms : 0) + (data.is_live ? 1 : 0);
        }

        const container = document.getElementById('stream-selector-container');
        if (container) container.style.display = 'none';
        const chatTabsEl = document.getElementById('chat-tabs-container');
        if (chatTabsEl) {
          renderChatTabs([]);
        }

        const v = data.video;
        const offset = data.offset;
        let streamUrl = v.hls_url || v.video_url;
        loadStream(streamUrl, false, offset);
      }

      // Schedule next fetch
      let nextPoll = 30000;
      if (!data.is_live && data.nextUpdateIn !== undefined) {
        nextPoll = data.nextUpdateIn * 1000 + 500;
      }
      if (isNaN(nextPoll) || nextPoll < 5000) nextPoll = 5000;
      autopilotTimer = setTimeout(() => fetchAutopilotStatus(false), nextPoll);

    } catch (e) {
      console.error('Error fetching autopilot status:', e);
      isSwitchingAutopilotVOD = false;
      autopilotTimer = setTimeout(() => fetchAutopilotStatus(false), 15000);
    } finally {
      autopilotFetchInFlight = false;
    }
  }

  if (window.CHANNEL_ID) {
    fetchAutopilotStatus();

    if (video) {
      video.addEventListener('ended', () => {
        console.log('[Player] Video ended naturally, advancing to next autopilot video...');
        isSwitchingAutopilotVOD = true;
        fetchAutopilotStatus(true);
      });
    }

    socket.on('autopilot_update', () => {
      fetchAutopilotStatus();
    });

    socket.on('stream_started', () => {
      fetchAutopilotStatus();
    });

    socket.on('stream_updated', () => {
      fetchAutopilotStatus();
    });

    socket.on('stream_ended', () => {
      fetchAutopilotStatus();
    });

