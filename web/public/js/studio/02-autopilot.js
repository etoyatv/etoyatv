/* === 02-autopilot.js (lines 244-545) === */
    // ----------------------------------------------------
    // Autopilot Live Stream & Video Sync Player
    // ----------------------------------------------------
    let autopilotHls = null;
    let currentAutopilotVideoUrl = null;
    let archiveHls = null;

    let currentSelectedStudioStreamIndex = 1;

    function renderStudioStreamSelector(activeStreams) {
        const container = document.getElementById('studio-stream-selector-container');
        const buttonsDiv = document.getElementById('studio-stream-buttons');
        if (!container || !buttonsDiv) return;

        if (!activeStreams || activeStreams.length <= 1) {
            container.style.display = 'none';
            buttonsDiv.innerHTML = '';
            return;
        }

        container.style.display = 'inline-flex';
        buttonsDiv.innerHTML = '';

        activeStreams.forEach(idx => {
            const btn = document.createElement('button');
            btn.innerText = idx;
            btn.style.width = '18px';
            btn.style.height = '18px';
            btn.style.borderRadius = '50%';
            btn.style.border = 'none';
            btn.style.fontSize = '9px';
            btn.style.fontWeight = 'bold';
            btn.style.cursor = 'pointer';
            btn.style.display = 'inline-flex';
            btn.style.alignItems = 'center';
            btn.style.justifyContent = 'center';
            btn.style.padding = '0';
            btn.style.margin = '0 2px';
            btn.style.transition = 'background 0.2s, color 0.2s';

            if (idx === currentSelectedStudioStreamIndex) {
                btn.style.background = '#00a0e3';
                btn.style.color = '#fff';
            } else {
                btn.style.background = '#fff';
                btn.style.color = '#000';
            }

            btn.addEventListener('click', () => {
                if (idx === currentSelectedStudioStreamIndex) return;
                currentSelectedStudioStreamIndex = idx;
                
                const baseUrl = window.RTMP_STREAM_URL || 'https://kctv.etoyatv.top/live';
                let streamUrl = `${baseUrl}/${window.CHANNEL_SHORTNAME.toLowerCase()}/index.m3u8`;
                if (idx > 1) {
                    streamUrl = `${baseUrl}/${window.CHANNEL_SHORTNAME.toLowerCase()}_${idx}/index.m3u8`;
                }
                currentAutopilotVideoUrl = streamUrl;
                loadAutopilotStream(streamUrl, 0);
                
                renderStudioStreamSelector(activeStreams);

                // Notify chat iframe about the stream change
                const chatIframe = document.getElementById('studio-chat-iframe');
                if (chatIframe && chatIframe.contentWindow) {
                    chatIframe.contentWindow.postMessage({ type: 'etoyatv_stream_changed', index: idx }, '*');
                }

                // Load overlays inputs for the newly selected camera stream
                updateStudioOverlayInputs();
            });

            buttonsDiv.appendChild(btn);
        });
        updateStudioOverlayInputs();
    }

    function hideStudioStreamSelector() {
        const container = document.getElementById('studio-stream-selector-container');
        if (container) {
            container.style.display = 'none';
        }
    }

    async function checkAutopilotStatus() {
        try {
            const res = await fetch(`/api/channels/${window.CHANNEL_ID}/autopilot_status`);
            const data = await res.json();
            lastAutopilotData = data;
            
            if (data.is_live) {
                // If stream is active on NMS (either from studio or OBS)
                if (state.isConnecting) {
                    console.log('[STUDIO] Live detected during polling. Transitioning connection state to streaming.');
                    state.isConnecting = false;
                    if (state.connectionTimeout) {
                        clearTimeout(state.connectionTimeout);
                        state.connectionTimeout = null;
                    }
                    btnToggleBroadcast.disabled = false;
                    btnToggleBroadcast.classList.remove('connecting');
                }

                // Only show STOP when this studio tab is actually publishing.
                // Otherwise after local stop, lingering is_live flips the button back and feels like a reconnect.
                if (state.isStreaming || state.isConnecting) {
                    btnToggleBroadcast.textContent = 'ОСТАНОВИТЬ ТРАНСЛЯЦИЮ';
                    btnToggleBroadcast.classList.add('streaming');
                    btnToggleBroadcast.classList.remove('connecting');
                    btnToggleBroadcast.disabled = false;

                    onairDot.className = 'onair-status-indicator live';
                    onairDot.style.background = '';
                    onairDot.style.boxShadow = '';
                    onairStatusText.textContent = '🔴 В эфире';
                    onairStatusText.style.color = '#ff4d4d';

                    const titleContainer = document.getElementById('studio-live-title-container');
                    if (titleContainer) titleContainer.style.display = 'inline-flex';

                    const recordBtn = document.getElementById('btn-record-stream');
                    if (recordBtn) recordBtn.style.display = 'inline-block';
                } else {
                    btnToggleBroadcast.textContent = 'Начать трансляцию';
                    btnToggleBroadcast.classList.remove('streaming');
                    btnToggleBroadcast.classList.remove('connecting');
                    btnToggleBroadcast.disabled = false;

                    onairDot.className = 'onair-status-indicator live';
                    onairDot.style.background = '';
                    onairDot.style.boxShadow = '';
                    onairStatusText.textContent = '🔴 Эфир (не из этой студии)';
                    onairStatusText.style.color = '#ff4d4d';

                    const titleContainer = document.getElementById('studio-live-title-container');
                    if (titleContainer) titleContainer.style.display = 'inline-flex';

                    const recordBtn = document.getElementById('btn-record-stream');
                    if (recordBtn) recordBtn.style.display = 'inline-block';
                }
                
                // If we are not locally streaming, we should play the live stream in the autopilot monitor
                if (!state.isStreaming) {
                    const baseUrl = window.RTMP_STREAM_URL || 'https://kctv.etoyatv.top/live';
                    let streamUrl = `${baseUrl}/${window.CHANNEL_SHORTNAME.toLowerCase()}/index.m3u8`;
                    if (currentSelectedStudioStreamIndex > 1) {
                        const lowerShort = window.CHANNEL_SHORTNAME.toLowerCase();
                        streamUrl = `${baseUrl}/${lowerShort}_${currentSelectedStudioStreamIndex}/index.m3u8`;
                    }
                    if (currentAutopilotVideoUrl !== streamUrl) {
                        currentAutopilotVideoUrl = streamUrl;
                        loadAutopilotStream(streamUrl, 0);

                        // Sync initial/current stream index to chat iframe
                        const chatIframe = document.getElementById('studio-chat-iframe');
                        if (chatIframe && chatIframe.contentWindow) {
                            setTimeout(() => {
                                chatIframe.contentWindow.postMessage({ type: 'etoyatv_stream_changed', index: currentSelectedStudioStreamIndex }, '*');
                            }, 1000);
                        }
                    }
                    renderStudioStreamSelector(data.active_streams || []);
                } else {
                    stopAutopilotPlayer();
                    hideStudioStreamSelector();
                }
            } else {
                // If not live
                hideStudioStreamSelector();
                if (state.isConnecting) {
                    // We are connecting, preserve the connection warning UI state
                    btnToggleBroadcast.textContent = 'Установка соединения...';
                    btnToggleBroadcast.classList.remove('streaming');
                    btnToggleBroadcast.classList.add('connecting');
                    btnToggleBroadcast.disabled = true;
                    
                    onairDot.className = 'onair-status-indicator';
                    onairDot.style.background = '#f0ad4e';
                    onairDot.style.boxShadow = '0 0 8px #f0ad4e';
                    onairStatusText.textContent = 'Установка соединения...';
                    onairStatusText.style.color = '#f0ad4e';
                    
                    const titleContainer = document.getElementById('studio-live-title-container');
                    if (titleContainer) titleContainer.style.display = 'none';

                    const recordBtn = document.getElementById('btn-record-stream');
                    if (recordBtn) recordBtn.style.display = 'none';
                } else if (state.isStreaming) {
                    // Locally it is streaming but server doesn't report it live yet? 
                    // Keep the local live state UI active.
                    onairDot.className = 'onair-status-indicator live';
                    onairStatusText.textContent = getActiveSourceLabel(getActiveOnAirOverlays());
                    onairStatusText.style.color = '#ff4d4d';

                    const titleContainer = document.getElementById('studio-live-title-container');
                    if (titleContainer) titleContainer.style.display = 'inline-flex';

                    const recordBtn = document.getElementById('btn-record-stream');
                    if (recordBtn) recordBtn.style.display = 'inline-block';
                } else {
                    // Not streaming locally, and not live on server
                    btnToggleBroadcast.textContent = 'Начать трансляцию';
                    btnToggleBroadcast.classList.remove('streaming');
                    btnToggleBroadcast.classList.remove('connecting');
                    btnToggleBroadcast.disabled = false;

                    const titleContainer = document.getElementById('studio-live-title-container');
                    if (titleContainer) titleContainer.style.display = 'none';

                    const recordBtn = document.getElementById('btn-record-stream');
                    if (recordBtn) recordBtn.style.display = 'none';
                    
                    if (data.active && data.autopilot_enabled) {
                        // Autopilot is active
                        onairDot.className = 'onair-status-indicator';
                        onairDot.style.background = '#4cae4c';
                        onairDot.style.boxShadow = '0 0 8px #4cae4c';
                        onairStatusText.textContent = '✈️ Автопилот (активен)';
                        onairStatusText.style.color = '#4cae4c';
                        
                        if (data.video) {
                            const streamUrl = data.video.hls_url || data.video.video_url;
                            const seekOffset = data.offset || 0;
                            if (streamUrl) {
                                if (currentAutopilotVideoUrl !== streamUrl) {
                                    currentAutopilotVideoUrl = streamUrl;
                                    loadAutopilotStream(streamUrl, seekOffset);
                                } else {
                                    if (Math.abs(autopilotVideo.currentTime - seekOffset) > 3) {
                                        autopilotVideo.currentTime = seekOffset;
                                    }
                                }
                            } else {
                                stopAutopilotPlayer();
                            }
                        } else {
                            stopAutopilotPlayer();
                        }
                    } else {
                        // Autopilot is disabled or empty
                        onairDot.className = 'onair-status-indicator';
                        onairDot.style.background = '#555';
                        onairDot.style.boxShadow = 'none';
                        onairStatusText.textContent = '🔴 Стрим отключен (автопилот выключен)';
                        onairStatusText.style.color = '#888';
                        stopAutopilotPlayer();
                    }
                }
            }
        } catch (e) {
            console.error('Ошибка проверки статуса автопилота:', e);
        }
    }

    function loadAutopilotStream(url, offset) {
        if (window.Hls && Hls.isSupported() && url.endsWith('.m3u8')) {
            if (autopilotHls) {
                try { autopilotHls.destroy(); } catch(e){}
            }
            autopilotHls = new Hls({
                debug: false,
                enableWorker: true,
                lowLatencyMode: true,
                progressive: false,
                backBufferLength: 15,
                liveSyncDuration: 5.0,
                liveMaxLatencyDuration: 10,
                maxBufferLength: 15,
                liveBackBufferLength: 10
            });
            autopilotHls.loadSource(url);
            autopilotHls.attachMedia(autopilotVideo);
            autopilotHls.on(Hls.Events.MANIFEST_PARSED, () => {
                autopilotVideo.play().then(() => {
                    if (offset > 0) autopilotVideo.currentTime = offset;
                }).catch(() => {});
            });
            autopilotHls.on(Hls.Events.ERROR, (event, data) => {
                if (data.fatal) {
                    currentAutopilotVideoUrl = null;
                }
            });
        } else {
            // HTML5 direct stream or MP4 video fallback
            autopilotVideo.src = url;
            autopilotVideo.load();
            autopilotVideo.play().then(() => {
                if (offset > 0) autopilotVideo.currentTime = offset;
            }).catch(() => {});
        }
    }

    function stopAutopilotPlayer() {
        currentAutopilotVideoUrl = null;
        autopilotVideo.pause();
        autopilotVideo.removeAttribute('src');
        if (autopilotHls) {
            try { autopilotHls.destroy(); } catch(e){}
            autopilotHls = null;
        }
    }
    
