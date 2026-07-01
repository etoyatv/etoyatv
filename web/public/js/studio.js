// Client-side Broadcast Studio controller for ЭтоЯTV with Enhanced Animations & Autopilot Monitor

document.addEventListener('DOMContentLoaded', () => {
    // ----------------------------------------------------
    // State & Animations Initialization
    // ----------------------------------------------------
    const defaultPreviewState = () => ({
        source: 'webcam', // 'webcam', 'archive', 'intro'
        bumper: { active: false, text1: '', text2: '', color1: '#ffffff', color2: '#6fdeee', bgColor1: '#ff3b30', bgColor2: '#007af5', style: 'standard', activatedAt: 0 },
        intro: { active: false, text1: '', text2: '', color1: '#ffffff', color2: '#6fdeee', bgColor1: '#1f1c2c', bgColor2: '#928dab', style: 'gradient-pulse' },
        ticker: { active: false, text: '', color: '#ffffff', bgColor: '#007af5', style: 'standard', speed: 2, offset: 1280 }
    });

    const state = {
        videoDevices: [],
        audioDevices: [],
        localStream: null,
        audioContext: null,
        audioDest: null,
        micGainNode: null,
        videoGainNode: null,
        mediaRecorder: null,
        isStreaming: false,
        isConnecting: false,
        connectionTimeout: null,
        chunkInterval: null,
        timerInterval: null,
        streamStartTime: 0,
        windows: [
            { id: 1, name: 'Окно 1', preview: defaultPreviewState() }
        ],
        activeWindowId: 1,
        nextWindowId: 2,
        
        onAir: {
            source: 'webcam',
            bumper: { active: false, text1: '', text2: '', color1: '#ffffff', color2: '#6fdeee', bgColor1: '#ff3b30', bgColor2: '#007af5', style: 'standard', activatedAt: 0 },
            intro: { active: false, text1: '', text2: '', color1: '#ffffff', color2: '#6fdeee', bgColor1: '#1f1c2c', bgColor2: '#928dab', style: 'gradient-pulse' },
            ticker: { active: false, text: '', color: '#ffffff', bgColor: '#007af5', style: 'standard', speed: 2, offset: 1280 }
        }
    };

    function getActiveWindow() {
        return state.windows.find(w => w.id === state.activeWindowId) || state.windows[0];
    }

    // Socket Connection
    const socket = io();

    // Forward client logs to server for remote diagnostics
    const originalLog = console.log;
    const originalWarn = console.warn;
    const originalError = console.error;

    function sendLogToServer(level, args) {
        try {
            const message = Array.from(args).map(arg => {
                if (arg instanceof Error) {
                    return `${arg.name}: ${arg.message}\n${arg.stack}`;
                } else if (typeof arg === 'object') {
                    try { return JSON.stringify(arg); } catch(e) { return String(arg); }
                }
                return String(arg);
            }).join(' ');
            
            socket.emit('studio_client_log', {
                channelId: window.CHANNEL_ID,
                level: level,
                message: message
            });
        } catch (e) {}
    }

    console.log = function() {
        originalLog.apply(console, arguments);
        sendLogToServer('log', arguments);
    };
    console.warn = function() {
        originalWarn.apply(console, arguments);
        sendLogToServer('warn', arguments);
    };
    console.error = function() {
        originalError.apply(console, arguments);
        sendLogToServer('error', arguments);
    };

    // Canvas Elements
    const previewCanvas = document.getElementById('previewCanvas');
    const onAirCanvas = document.getElementById('onAirCanvas');
    const previewCtx = previewCanvas.getContext('2d');
    const onAirCtx = onAirCanvas.getContext('2d');
    
    // Video elements
    const localVideo = document.getElementById('localWebcamVideo');
    const archiveVideo = document.getElementById('archiveVideoPlayer');
    const autopilotVideo = document.getElementById('autopilotVideoPlayer');
    
    // Ensure autopilot monitor is completely muted
    autopilotVideo.muted = true;
    
    // UI selects
    const videoSelect = document.getElementById('videoSourceSelect');
    const audioSelect = document.getElementById('audioSourceSelect');
    
    // Broadcast controls
    const btnToggleBroadcast = document.getElementById('btn-toggle-broadcast');
    const broadcastTimer = document.getElementById('studio-broadcast-timer');
    const viewersCount = document.getElementById('studio-viewers-count');
    const onairDot = document.getElementById('onair-dot');
    const onairStatusText = document.getElementById('onair-status-text');
    
    // Studio Session Timer (Timer starts on entering the studio)
    const studioPageLoadTime = Date.now();
    function updateStudioSessionTimer() {
        const diffMs = Date.now() - studioPageLoadTime;
        const totalSecs = Math.floor(diffMs / 1000);
        const hrs = String(Math.floor(totalSecs / 3600)).padStart(2, '0');
        const mins = String(Math.floor((totalSecs % 3600) / 60)).padStart(2, '0');
        const secs = String(totalSecs % 60).padStart(2, '0');
        if (broadcastTimer) {
            broadcastTimer.textContent = `${hrs}:${mins}:${secs}`;
        }
    }
    setInterval(updateStudioSessionTimer, 1000);
    updateStudioSessionTimer();
    
    // Preview applied overlays layout
    const previewOverlaysList = document.getElementById('preview-overlays-list');

    // ----------------------------------------------------
    // Autopilot Live Stream & Video Sync Player
    // ----------------------------------------------------
    let autopilotHls = null;
    let currentAutopilotVideoUrl = null;
    let archiveHls = null;

    async function checkAutopilotStatus() {
        try {
            const res = await fetch(`/api/channels/${window.CHANNEL_ID}/autopilot_status`);
            const data = await res.json();
            
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

                btnToggleBroadcast.textContent = 'ОСТАНОВИТЬ ТРАНСЛЯЦИЮ';
                btnToggleBroadcast.classList.add('streaming');
                onairDot.className = 'onair-status-indicator live';
                onairDot.style.background = '';
                onairDot.style.boxShadow = '';
                onairStatusText.textContent = '🔴 В эфире';
                onairStatusText.style.color = '#ff4d4d';

                const titleContainer = document.getElementById('studio-live-title-container');
                if (titleContainer) titleContainer.style.display = 'inline-flex';

                const recordBtn = document.getElementById('btn-record-stream');
                if (recordBtn) recordBtn.style.display = 'inline-block';
                
                // If we are not locally streaming, we should play the live stream in the autopilot monitor
                if (!state.isStreaming) {
                    const baseUrl = window.RTMP_STREAM_URL || 'https://kctv.etoyatv.top/live';
                    const streamUrl = `${baseUrl}/${window.CHANNEL_SHORTNAME}/index.m3u8`;
                    if (currentAutopilotVideoUrl !== streamUrl) {
                        currentAutopilotVideoUrl = streamUrl;
                        loadAutopilotStream(streamUrl, 0);
                    }
                } else {
                    stopAutopilotPlayer();
                }
            } else {
                // If not live
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
                    onairStatusText.textContent = getActiveSourceLabel(state.onAir);
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
                enableWorker: true
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
    
    // ----------------------------------------------------
    // Studio Connection & State Synchronization
    // ----------------------------------------------------
    socket.on('connect', () => {
        console.log('[SOCKET] Connected to server, sending join_channel...');
        socket.emit('join_channel', {
            channelId: window.CHANNEL_ID,
            user: window.CURRENT_USER,
            userToken: window.CURRENT_USER_TOKEN,
            guestName: window.CURRENT_USER.username,
            color: window.CURRENT_USER.chat_color || '#ffc107',
            isStudio: true
        });
        // Auto-sync active studio overlays upon reconnection
        syncOverlaysToPlayer();

        // If we were broadcasting before disconnect, restart the session dynamically
        if (state.isStreaming) {
            console.log('[STUDIO] Reconnected while streaming. Re-initializing MediaRecorder.');
            restartBroadcastOnReconnect();
        }
    });

    async function restartBroadcastOnReconnect() {
        try {
            if (state.mediaRecorder && state.mediaRecorder.state !== 'inactive') {
                try { state.mediaRecorder.stop(); } catch(e){}
            }
            await new Promise(resolve => setTimeout(resolve, 300));
            
            if (state.combinedStream) {
                const recorderOptions = {
                    videoBitsPerSecond: 1500000,
                    audioBitsPerSecond: 128000
                };
                if (state.mimeType) {
                    recorderOptions.mimeType = state.mimeType;
                }
                
                state.mediaRecorder = new MediaRecorder(state.combinedStream, recorderOptions);
                state.mediaRecorder.ondataavailable = async (e) => {
                    if (e.data && e.data.size > 0) {
                        try {
                            const buffer = await e.data.arrayBuffer();
                            const bytes = new Uint8Array(buffer);
                            let binary = '';
                            const chunkSize = 8192;
                            for (let i = 0; i < bytes.length; i += chunkSize) {
                                binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
                            }
                            const base64 = btoa(binary);

                            socket.emit('studio_chunk', {
                                channelId: window.CHANNEL_ID,
                                chunk: base64,
                                isBase64: true
                            });
                        } catch (err) {
                            console.error('Ошибка преобразования Blob в Base64 на реконнекте:', err);
                        }
                    }
                };
                
                socket.emit('studio_start_stream', {
                    channelId: window.CHANNEL_ID,
                    streamKey: window.STREAM_KEY
                });
                
                state.mediaRecorder.start(1000);
                console.log('[STUDIO] MediaRecorder restarted successfully on reconnect.');
            }
        } catch (err) {
            console.error('[STUDIO] Failed to restart broadcast on reconnect:', err);
        }
    }

    socket.on('stream_started', () => {
        if (state.isConnecting) {
            console.log('[STUDIO] Received stream_started! Transitioning connection state to streaming.');
            state.isConnecting = false;
            if (state.connectionTimeout) {
                clearTimeout(state.connectionTimeout);
                state.connectionTimeout = null;
            }
            btnToggleBroadcast.disabled = false;
            btnToggleBroadcast.classList.remove('connecting');
            btnToggleBroadcast.classList.add('streaming');
            btnToggleBroadcast.textContent = 'ОСТАНОВИТЬ ТРАНСЛЯЦИЮ';
            
            state.isStreaming = true;
            onairDot.classList.add('live');
            onairStatusText.textContent = getActiveSourceLabel(state.onAir);
            onairStatusText.style.color = '#ff4d4d';

            const titleContainer = document.getElementById('studio-live-title-container');
            if (titleContainer) titleContainer.style.display = 'inline-flex';

            const recordBtn = document.getElementById('btn-record-stream');
            if (recordBtn) recordBtn.style.display = 'inline-block';
        }
    });

    socket.on('update_users', ({ count, users }) => {
        if (viewersCount) viewersCount.textContent = count;
    });

    // ----------------------------------------------------
    // Device Enumerate & Camera Stream Capture
    // ----------------------------------------------------
    async function initDevices() {
        try {
            const devices = await navigator.mediaDevices.enumerateDevices();
            state.videoDevices = devices.filter(d => d.kind === 'videoinput');
            state.audioDevices = devices.filter(d => d.kind === 'audioinput');
            
            videoSelect.innerHTML = '';
            state.videoDevices.forEach(d => {
                const opt = document.createElement('option');
                opt.value = d.deviceId;
                opt.textContent = d.label || `Камера ${videoSelect.length + 1}`;
                videoSelect.appendChild(opt);
            });
            
            audioSelect.innerHTML = '';
            state.audioDevices.forEach(d => {
                const opt = document.createElement('option');
                opt.value = d.deviceId;
                opt.textContent = d.label || `Микрофон ${audioSelect.length + 1}`;
                audioSelect.appendChild(opt);
            });
            
            // Trigger stream loading
            if (state.videoDevices.length > 0) {
                startCameraStream();
            }
        } catch (e) {
            console.error('Failed to init multimedia devices:', e);
        }
    }

    async function startCameraStream() {
        if (state.localStream) {
            state.localStream.getTracks().forEach(t => t.stop());
        }
        
        const vidId = videoSelect.value;
        const audId = audioSelect.value;
        
        const constraints = {
            video: vidId ? { deviceId: { exact: vidId }, width: 1280, height: 720 } : true,
            audio: audId ? { deviceId: { exact: audId } } : true
        };
        
        try {
            const stream = await navigator.mediaDevices.getUserMedia(constraints);
            state.localStream = stream;
            localVideo.srcObject = stream;
            
            // Initialize Web Audio Nodes
            initAudioMixing();
        } catch (e) {
            console.error('getUserMedia failed:', e);
        }
    }

    let archiveVideoSourceNode = null;

    function initAudioMixing() {
        if (!state.audioContext) {
            const AudioContextClass = window.AudioContext || window.webkitAudioContext;
            state.audioContext = new AudioContextClass();
            state.audioDest = state.audioContext.createMediaStreamDestination();

            // Keep a permanent silent oscillator running to provide a clock reference for MediaRecorder in Chrome
            try {
                const osc = state.audioContext.createOscillator();
                const silentGain = state.audioContext.createGain();
                silentGain.gain.value = 0; // Silent, but provides an active clock signal
                osc.connect(silentGain);
                silentGain.connect(state.audioDest);
                osc.start();
                console.log('[STUDIO] Permanent silent clock oscillator started.');
            } catch (e) {
                console.warn('[STUDIO] Failed to start silent clock oscillator:', e);
            }
        }
        
        // Resume if suspended (user interaction trigger)
        if (state.audioContext.state === 'suspended') {
            state.audioContext.resume().catch(() => {});
        }
        
        // 1. Webcam Mic Source (Recreate node if stream changed)
        if (state.localStream && state.localStream.getAudioTracks().length > 0) {
            if (state.micSourceNode) {
                try { state.micSourceNode.disconnect(); } catch(e){}
            }
            try {
                state.micSourceNode = state.audioContext.createMediaStreamSource(state.localStream);
                if (!state.micGainNode) {
                    state.micGainNode = state.audioContext.createGain();
                }
                const micSlider = document.getElementById('micVolumeSlider');
                state.micGainNode.gain.value = micSlider ? parseFloat(micSlider.value || 0.8) : 0.8;
                
                state.micSourceNode.connect(state.micGainNode);
                state.micGainNode.connect(state.audioDest);
            } catch(e) {
                console.warn('Mic source connection warning:', e);
            }
        }
        
        // 2. Media Archive Video Source (Initialize once to prevent DOM exception)
        if (!archiveVideoSourceNode) {
            try {
                archiveVideoSourceNode = state.audioContext.createMediaElementSource(archiveVideo);
                state.videoGainNode = state.audioContext.createGain();
                const webSlider = document.getElementById('webVolumeSlider');
                state.videoGainNode.gain.value = webSlider ? parseFloat(webSlider.value || 0.8) : 0.8;
                
                archiveVideoSourceNode.connect(state.videoGainNode);
                state.videoGainNode.connect(state.audioDest);
                
                // Disabled routing to local speakers to prevent local audio loop/echo
                // state.videoGainNode.connect(state.audioContext.destination);
            } catch(e) {
                console.warn('VOD audio element connection warning:', e);
            }
        }
    }

    window.updateMicVolume = (val) => {
        if (state.micGainNode && state.audioContext) {
            state.micGainNode.gain.setValueAtTime(parseFloat(val), state.audioContext.currentTime);
        }
        document.getElementById('micVolumeVal').textContent = Math.round(val * 100) + '%';
    };

    window.updateWebcamVolume = (val) => {
        // Mock handler
        document.getElementById('webVolumeVal').textContent = Math.round(val * 100) + '%';
    };

    // ----------------------------------------------------
    // Media Archive VOD loading
    // ----------------------------------------------------
    window.loadArchiveVideo = (hlsUrl, id, element) => {
        document.querySelectorAll('.archive-item').forEach(item => item.classList.remove('active'));
        if (element) element.classList.add('active');
        
        archiveVideo.muted = true;
        if (window.Hls && Hls.isSupported() && hlsUrl.endsWith('.m3u8')) {
            if (archiveHls) {
                try { archiveHls.destroy(); } catch(e){}
            }
            archiveHls = new Hls({
                debug: false,
                enableWorker: true
            });
            archiveHls.loadSource(hlsUrl);
            archiveHls.attachMedia(archiveVideo);
            archiveHls.on(Hls.Events.MANIFEST_PARSED, () => {
                archiveVideo.muted = true;
                archiveVideo.play().catch(() => {});
            });
        } else {
            archiveVideo.src = hlsUrl;
            archiveVideo.crossOrigin = 'anonymous';
            archiveVideo.muted = true;
            archiveVideo.load();
            archiveVideo.play().catch(() => {});
        }
        
        const activeWin = getActiveWindow();
        activeWin.preview.source = 'archive';
        activeWin.preview.archiveId = id;
        
        updatePreviewOverlaysList();
    };

    // ----------------------------------------------------
    // Canvas Mixer loop (30 FPS)
    // ----------------------------------------------------
    function drawStudioCanvas() {
        requestAnimationFrame(drawStudioCanvas);
        
        const time = Date.now() / 1000;
        
        // 1. Draw Preview Stage
        const activeWin = getActiveWindow();
        renderStage(previewCtx, activeWin.preview, time);
        
        // 2. Draw On-Air Stage (Draw Autopilot/Black Screen if not broadcasting)
        if (!state.isStreaming) {
            if (state.onAir.source === 'intro' && state.onAir.intro && state.onAir.intro.active) {
                drawAnimatedIntro(onAirCtx, state.onAir.intro, time);
            } else {
                drawAutopilotOnAir(onAirCtx);
            }
            // Draw overlays on top of autopilot/intro
            if (state.onAir.bumper && state.onAir.bumper.active) {
                drawBumperOverlay(onAirCtx, state.onAir.bumper, time);
            }
            if (state.onAir.ticker && state.onAir.ticker.active) {
                drawTickerOverlay(onAirCtx, state.onAir.ticker, time);
            }
        } else {
            renderStage(onAirCtx, state.onAir, time);
        }
    }

    // Displays the actual stream in the On-Air monitor
    function drawAutopilotOnAir(ctx) {
        const width = 1280;
        const height = 720;
        
        if (autopilotVideo.readyState >= 2 && !autopilotVideo.paused) {
            ctx.drawImage(autopilotVideo, 0, 0, width, height);
        } else {
            // Draw clean black screen fallback
            ctx.fillStyle = '#000000';
            ctx.fillRect(0, 0, width, height);
            
            // Modern pulsing dot layout with glowing outer ring
            const pulse = 0.5 + Math.sin(Date.now() / 400) * 0.4;
            
            // Outer glowing ring
            ctx.save();
            ctx.strokeStyle = `rgba(255, 77, 77, ${1 - pulse})`;
            ctx.lineWidth = 3;
            ctx.beginPath();
            ctx.arc(width / 2, height / 2 - 40, 14 + pulse * 24, 0, Math.PI * 2);
            ctx.stroke();
            
            // Inner solid pulsing circle
            ctx.fillStyle = 'rgba(255, 77, 77, 0.9)';
            ctx.beginPath();
            ctx.arc(width / 2, height / 2 - 40, 14, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
            
            // Legible centered text
            ctx.fillStyle = '#ffffff';
            ctx.font = '24px Arial';
            ctx.textAlign = 'center';
            ctx.fillText('Студия ожидает трансляции', width / 2, height / 2 + 40);
        }
    }

    function renderStage(ctx, stage, time) {
        const width = 1280;
        const height = 720;
        
        // Clear canvas
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, width, height);
        
        // Draw primary source
        if (stage.source === 'webcam') {
            if (localVideo.readyState >= 2) {
                ctx.drawImage(localVideo, 0, 0, width, height);
            } else {
                ctx.fillStyle = '#1c1c1c';
                ctx.fillRect(0, 0, width, height);
                ctx.fillStyle = '#555';
                ctx.font = '24px Arial';
                ctx.textAlign = 'center';
                ctx.fillText('Камера не готова', width / 2, height / 2);
            }
        } else if (stage.source === 'archive') {
            if (archiveVideo.readyState >= 2) {
                ctx.drawImage(archiveVideo, 0, 0, width, height);
            } else {
                ctx.fillStyle = '#1c1c1c';
                ctx.fillRect(0, 0, width, height);
                ctx.fillStyle = '#555';
                ctx.font = '24px Arial';
                ctx.textAlign = 'center';
                ctx.fillText('Загрузка видео из архива...', width / 2, height / 2);
            }
        } else if (stage.source === 'intro') {
            drawAnimatedIntro(ctx, stage.intro, time);
        }
        
        // Draw Bumper overlay
        if (stage.bumper.active) {
            drawBumperOverlay(ctx, stage.bumper, time);
        }
        
        // Draw Ticker overlay
        if (stage.ticker.active) {
            drawTickerOverlay(ctx, stage.ticker, time);
        }
    }

    // ----------------------------------------------------
    // Intro (Заставка) Animations & Styles
    // ----------------------------------------------------
    function drawAnimatedIntro(ctx, intro, time) {
        const width = 1280;
        const height = 720;

        if (intro.style === 'gradient-pulse') {
            // Animating shifting gradient angle
            const angleShift = time * 0.4;
            const x1 = width / 2 + Math.cos(angleShift) * width / 2;
            const y1 = height / 2 + Math.sin(angleShift) * height / 2;
            const x2 = width / 2 - Math.cos(angleShift) * width / 2;
            const y2 = height / 2 - Math.sin(angleShift) * height / 2;
            
            const grad = ctx.createLinearGradient(x1, y1, x2, y2);
            grad.addColorStop(0, intro.bgColor1);
            grad.addColorStop(1, intro.bgColor2);
            ctx.fillStyle = grad;
            ctx.fillRect(0, 0, width, height);
            
        } else if (intro.style === 'cosmic-glow') {
            // Draw dark background
            ctx.fillStyle = '#0f0c1b';
            ctx.fillRect(0, 0, width, height);
            
            // Draw floating glowing cosmic orbs
            ctx.save();
            ctx.globalCompositeOperation = 'screen';
            for (let i = 0; i < 6; i++) {
                const px = (width / 2) + Math.cos(time * 0.35 + i) * (width * 0.35);
                const py = (height / 2) + Math.sin(time * 0.45 + i * 2) * (height * 0.32);
                const size = 180 + Math.sin(time * 0.6 + i) * 60;
                
                const bubbleGrad = ctx.createRadialGradient(px, py, 0, px, py, size);
                bubbleGrad.addColorStop(0, intro.bgColor1 + '66'); // Semi-transparent color
                bubbleGrad.addColorStop(0.5, intro.bgColor2 + '22');
                bubbleGrad.addColorStop(1, 'transparent');
                
                ctx.fillStyle = bubbleGrad;
                ctx.beginPath();
                ctx.arc(px, py, size, 0, Math.PI * 2);
                ctx.fill();
            }
            ctx.restore();
            
        } else if (intro.style === 'retro-wave') {
            // Draw sunset synthwave sky gradient
            const skyGrad = ctx.createLinearGradient(0, 0, 0, height);
            skyGrad.addColorStop(0, '#0c021f');
            skyGrad.addColorStop(0.5, intro.bgColor1);
            skyGrad.addColorStop(1, intro.bgColor2);
            ctx.fillStyle = skyGrad;
            ctx.fillRect(0, 0, width, height);
            
            // Receding grid lines animation
            ctx.save();
            ctx.strokeStyle = 'rgba(255, 0, 127, 0.25)';
            ctx.lineWidth = 2;
            const horizon = height * 0.58;
            
            // Receding horizontal lines
            const gridSpeed = (time * 60) % 30;
            for (let y = horizon; y < height; y += 15) {
                const dy = y + gridSpeed * ((y - horizon) / (height - horizon));
                ctx.beginPath();
                ctx.moveTo(0, dy);
                ctx.lineTo(width, dy);
                ctx.stroke();
            }
            // Radiating vertical lines
            for (let x = -width; x < width * 2; x += 80) {
                ctx.beginPath();
                ctx.moveTo(width / 2, horizon);
                ctx.lineTo(x, height);
                ctx.stroke();
            }
            ctx.restore();
            
        } else {
            // Minimal simple gradient
            const grad = ctx.createLinearGradient(0, 0, width, height);
            grad.addColorStop(0, intro.bgColor1);
            grad.addColorStop(1, intro.bgColor2);
            ctx.fillStyle = grad;
            ctx.fillRect(0, 0, width, height);
        }

        // Draw animated texts (Pulsing float y offset)
        const floatY = Math.sin(time * 2.5) * 8;
        
        // Text 1
        ctx.save();
        ctx.fillStyle = intro.color1;
        ctx.font = 'bold 54px Tahoma, Arial';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.shadowColor = intro.color1;
        ctx.shadowBlur = 15;
        ctx.fillText(intro.text1, width / 2, height / 2 - 35 + floatY);
        ctx.restore();
        
        // Text 2
        ctx.save();
        ctx.fillStyle = intro.color2;
        ctx.font = 'bold 22px Tahoma, Arial';
        ctx.textAlign = 'center';
        ctx.shadowColor = intro.color2;
        ctx.shadowBlur = 5;
        ctx.fillText(intro.text2, width / 2, height / 2 + 35);
        ctx.restore();
    }

    // ----------------------------------------------------
    // Bumper (Отбивка) Animations & Styles
    // ----------------------------------------------------
    function drawBumperOverlay(ctx, bumper, time) {
        const h = 80;
        const y = 550;
        
        // Calculate slide-in transition offset
        let progress = 1;
        if (bumper.activatedAt) {
            const elapsed = (Date.now() - bumper.activatedAt) / 1000;
            progress = Math.min(1, elapsed / 0.4); // 0.4 seconds animation
            progress = 1 - Math.pow(1 - progress, 3); // Cubic ease-out
        }
        
        const x = -500 + (500 + 50) * progress; // Slide from -500 to 50
        
        ctx.save();
        
        if (bumper.style === 'glass') {
            // Glassmorphic panel with neon border
            ctx.fillStyle = 'rgba(20, 20, 20, 0.75)';
            ctx.strokeStyle = bumper.bgColor1;
            ctx.lineWidth = 3;
            ctx.shadowColor = bumper.bgColor1;
            ctx.shadowBlur = 10;
            
            ctx.beginPath();
            ctx.roundRect(x, y, 480, h, 8);
            ctx.fill();
            ctx.stroke();
            ctx.shadowBlur = 0; // Reset shadows
            
        } else if (bumper.style === 'shine') {
            // Standard ribbons
            drawClassicRibbons(ctx, x, y, h, bumper.bgColor1, bumper.bgColor2);
            
            // Sweep laser light effect
            const cycle = (time * 0.7) % 1; // 1 sweep every 1.4 seconds
            const sweepX = x + cycle * 520 - 50;
            
            ctx.save();
            // Clip to ribbon zone
            ctx.beginPath();
            ctx.moveTo(x, y);
            ctx.lineTo(x + 500, y);
            ctx.lineTo(x + 470, y + h);
            ctx.lineTo(x, y + h);
            ctx.closePath();
            ctx.clip();
            
            const shineGrad = ctx.createLinearGradient(sweepX - 40, y, sweepX + 40, y);
            shineGrad.addColorStop(0, 'transparent');
            shineGrad.addColorStop(0.5, 'rgba(255, 255, 255, 0.45)');
            shineGrad.addColorStop(1, 'transparent');
            ctx.fillStyle = shineGrad;
            ctx.fillRect(x, y, 480, h);
            ctx.restore();
            
        } else if (bumper.style === 'slide') {
            // Standard Ribbons with simple entry slide
            drawClassicRibbons(ctx, x, y, h, bumper.bgColor1, bumper.bgColor2);
        } else {
            // Standard - standard ribbons with no special effects
            drawClassicRibbons(ctx, x, y, h, bumper.bgColor1, bumper.bgColor2);
        }

        // Draw Texts
        ctx.fillStyle = bumper.color1;
        ctx.font = 'bold 22px Arial, sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText(bumper.text1, x + 25, y + 14);
        
        ctx.fillStyle = bumper.color2;
        ctx.font = '14px Arial, sans-serif';
        ctx.fillText(bumper.text2, x + 25, y + 46);
        
        ctx.restore();
    }

    function drawClassicRibbons(ctx, x, y, h, bg1, bg2) {
        // Ribbon 1 (Background)
        ctx.fillStyle = bg1;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + 500, y);
        ctx.lineTo(x + 470, y + h);
        ctx.lineTo(x, y + h);
        ctx.closePath();
        ctx.fill();
        
        // Ribbon 2 (Accent)
        ctx.fillStyle = bg2;
        ctx.beginPath();
        ctx.moveTo(x + 5, y + 5);
        ctx.lineTo(x + 490, y + 5);
        ctx.lineTo(x + 465, y + h - 5);
        ctx.lineTo(x + 5, y + h - 5);
        ctx.closePath();
        ctx.fill();
    }

    // ----------------------------------------------------
    // Ticker (Бегущая строка) Animations & Styles
    // ----------------------------------------------------
    function drawTickerOverlay(ctx, ticker, time) {
        const h = 40;
        const y = 680;
        const speed = parseInt(ticker.speed || 2);
        
        ctx.save();
        
        // Background banner
        ctx.fillStyle = ticker.bgColor;
        ctx.fillRect(0, y, 1280, h);
        
        // Ticker Text Style
        ctx.font = 'bold 16px Arial, sans-serif';
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'left';
        
        if (ticker.style === 'pulse-color') {
            // Pulse hues dynamically
            const hue = (time * 120) % 360;
            ctx.fillStyle = `hsl(${hue}, 100%, 75%)`;
        } else {
            ctx.fillStyle = ticker.color;
        }
        
        // Measure text width
        const textWidth = ctx.measureText(ticker.text).width;
        
        // Scroll speed calculation based on elapsed time to be frame-rate independent
        const activatedAt = ticker.activatedAt || 0;
        const elapsed = (Date.now() - activatedAt) / 1000;
        const pixelsPerSecond = speed * 60; 
        const totalDistance = 1280 + textWidth;
        const currentDistance = (elapsed * pixelsPerSecond) % totalDistance;
        const offset = 1280 - currentDistance;
        
        // Draw main scrolling text
        ctx.fillText(ticker.text, offset, y + h / 2);
        
        // If gradient fade is enabled, overlay edge transparency gradients
        if (ticker.style === 'gradient-fade') {
            // Left fade gradient
            const leftFade = ctx.createLinearGradient(0, y, 80, y);
            leftFade.addColorStop(0, ticker.bgColor);
            leftFade.addColorStop(1, 'transparent');
            ctx.fillStyle = leftFade;
            ctx.fillRect(0, y, 80, h);
            
            // Right fade gradient
            const rightFade = ctx.createLinearGradient(1200, y, 1280, y);
            rightFade.addColorStop(0, 'transparent');
            rightFade.addColorStop(1, ticker.bgColor);
            ctx.fillStyle = rightFade;
            ctx.fillRect(1200, y, 80, h);
        }
        
        ctx.restore();
    }

    // ----------------------------------------------------
    // Preview Switcher & Transition to Air
    // ----------------------------------------------------
    window.transitionPreviewToOnAir = () => {
        // Sync active preview config to Air
        const activeWin = getActiveWindow();
        state.onAir = JSON.parse(JSON.stringify(activeWin.preview));
        
        // Expose new activation timestamps to trigger entrance animations
        state.onAir.bumper.activatedAt = Date.now();
        
        if (state.isStreaming) {
            onairStatusText.textContent = getActiveSourceLabel(state.onAir);
        }
        
        syncOverlaysToPlayer();
    };
    
    function getActiveSourceLabel(stage) {
        if (stage.source === 'webcam') return 'Прямой эфир: Веб-камера';
        if (stage.source === 'archive') {
            const activeArchive = document.querySelector('.archive-item.active');
            const title = activeArchive ? activeArchive.querySelector('.archive-item-title').textContent : 'Архивное видео';
            return `Прямой эфир: ${title}`;
        }
        if (stage.source === 'intro') return 'Прямой эфир: Заставка';
        return 'Прямой эфир';
    }

    // ----------------------------------------------------
    // Tab Control Switches
    // ----------------------------------------------------
    window.switchSidebarTab = (tab) => {
        document.getElementById('tab-sources-btn').classList.remove('active');
        document.getElementById('tab-archive-btn').classList.remove('active');
        document.getElementById('pane-sources').style.display = 'none';
        document.getElementById('pane-archive').style.display = 'none';
        
        if (tab === 'sources') {
            document.getElementById('tab-sources-btn').classList.add('active');
            document.getElementById('pane-sources').style.display = 'block';
            getActiveWindow().preview.source = 'webcam';
        } else {
            document.getElementById('tab-archive-btn').classList.add('active');
            document.getElementById('pane-archive').style.display = 'block';
            getActiveWindow().preview.source = 'archive';
        }
        updatePreviewOverlaysList();
    };

    window.switchControlTab = (tab) => {
        document.querySelectorAll('.control-tab').forEach(btn => btn.classList.remove('active'));
        document.querySelectorAll('.control-panel-pane').forEach(pane => pane.classList.remove('active'));
        
        document.getElementById(`tab-${tab}-btn`).classList.add('active');
        document.getElementById(`panel-${tab}`).classList.add('active');
    };

    // ----------------------------------------------------
    // Bumper Overlay Action Triggers
    // ----------------------------------------------------
    window.toggleBumperPreview = () => {
        const eyeBtn = document.getElementById('bumper-preview-eye');
        const text1 = document.getElementById('bumperText1').value.trim();
        
        const activeWin = getActiveWindow();
        if (!activeWin.preview.bumper.active && !text1) {
            showToast("Введите текст отбивки!", "error");
            return;
        }

        activeWin.preview.bumper.text1 = document.getElementById('bumperText1').value;
        activeWin.preview.bumper.text2 = document.getElementById('bumperText2').value;
        activeWin.preview.bumper.color1 = document.getElementById('bumperColor1').value;
        activeWin.preview.bumper.color2 = document.getElementById('bumperColor2').value;
        activeWin.preview.bumper.bgColor1 = document.getElementById('bumperBgColor1').value;
        activeWin.preview.bumper.bgColor2 = document.getElementById('bumperBgColor2').value;
        activeWin.preview.bumper.style = document.getElementById('bumperStyle').value;
        
        activeWin.preview.bumper.active = !activeWin.preview.bumper.active;
        activeWin.preview.bumper.activatedAt = Date.now();
        eyeBtn.classList.toggle('active', activeWin.preview.bumper.active);
        
        updatePreviewOverlaysList();
    };

    window.applyBumperToAir = () => {
        const text1 = document.getElementById('bumperText1').value.trim();
        if (!text1) {
            showToast("Введите текст отбивки!", "error");
            return;
        }

        state.onAir.bumper.text1 = document.getElementById('bumperText1').value;
        state.onAir.bumper.text2 = document.getElementById('bumperText2').value;
        state.onAir.bumper.color1 = document.getElementById('bumperColor1').value;
        state.onAir.bumper.color2 = document.getElementById('bumperColor2').value;
        state.onAir.bumper.bgColor1 = document.getElementById('bumperBgColor1').value;
        state.onAir.bumper.bgColor2 = document.getElementById('bumperBgColor2').value;
        state.onAir.bumper.style = document.getElementById('bumperStyle').value;
        state.onAir.bumper.active = true;
        state.onAir.bumper.activatedAt = Date.now();
        syncOverlaysToPlayer();
    };

    window.removeBumperFromAir = () => {
        state.onAir.bumper.active = false;
        syncOverlaysToPlayer();
    };

    // ----------------------------------------------------
    // Intro Overlay Action Triggers
    // ----------------------------------------------------
    window.toggleIntroPreview = () => {
        const eyeBtn = document.getElementById('intro-preview-eye');
        const text1 = document.getElementById('introText1').value.trim();

        const activeWin = getActiveWindow();
        if (!activeWin.preview.intro.active && !text1) {
            showToast("Введите текст заставки!", "error");
            return;
        }

        activeWin.preview.intro.text1 = document.getElementById('introText1').value;
        activeWin.preview.intro.text2 = document.getElementById('introText2').value;
        activeWin.preview.intro.color1 = document.getElementById('introColor1').value;
        activeWin.preview.intro.color2 = document.getElementById('introColor2').value;
        activeWin.preview.intro.bgColor1 = document.getElementById('introBgColor1').value;
        activeWin.preview.intro.bgColor2 = document.getElementById('introBgColor2').value;
        activeWin.preview.intro.style = document.getElementById('introStyle').value;
        
        activeWin.preview.source = 'intro';
        activeWin.preview.intro.active = !activeWin.preview.intro.active;
        eyeBtn.classList.toggle('active', activeWin.preview.intro.active);
        
        if (!activeWin.preview.intro.active) {
            activeWin.preview.source = 'webcam';
        }
        
        updatePreviewOverlaysList();
    };

    window.applyIntroToAir = () => {
        const text1 = document.getElementById('introText1').value.trim();
        if (!text1) {
            showToast("Введите текст заставки!", "error");
            return;
        }

        state.onAir.intro.text1 = document.getElementById('introText1').value;
        state.onAir.intro.text2 = document.getElementById('introText2').value;
        state.onAir.intro.color1 = document.getElementById('introColor1').value;
        state.onAir.intro.color2 = document.getElementById('introColor2').value;
        state.onAir.intro.bgColor1 = document.getElementById('introBgColor1').value;
        state.onAir.intro.bgColor2 = document.getElementById('introBgColor2').value;
        state.onAir.intro.style = document.getElementById('introStyle').value;
        state.onAir.source = 'intro';
        state.onAir.intro.active = true;
        syncOverlaysToPlayer();
    };

    window.removeIntroFromAir = () => {
        state.onAir.intro.active = false;
        state.onAir.source = 'webcam';
        syncOverlaysToPlayer();
    };

    // ----------------------------------------------------
    // Ticker Overlay Action Triggers
    // ----------------------------------------------------
    window.toggleTickerPreview = () => {
        const eyeBtn = document.getElementById('ticker-preview-eye');
        const text = document.getElementById('tickerText').value.trim();

        const activeWin = getActiveWindow();
        if (!activeWin.preview.ticker.active && !text) {
            showToast("Введите текст бегущей строки!", "error");
            return;
        }

        activeWin.preview.ticker.text = document.getElementById('tickerText').value;
        activeWin.preview.ticker.color = document.getElementById('tickerColor').value;
        activeWin.preview.ticker.bgColor = document.getElementById('tickerBgColor').value;
        activeWin.preview.ticker.style = document.getElementById('tickerStyle').value;
        activeWin.preview.ticker.speed = parseInt(document.getElementById('tickerSpeed').value || 2);
        
        activeWin.preview.ticker.active = !activeWin.preview.ticker.active;
        eyeBtn.classList.toggle('active', activeWin.preview.ticker.active);
        
        if (activeWin.preview.ticker.active) {
            activeWin.preview.ticker.activatedAt = Date.now();
        }
        
        updatePreviewOverlaysList();
    };

    window.applyTickerToAir = () => {
        const text = document.getElementById('tickerText').value.trim();
        if (!text) {
            showToast("Введите текст бегущей строки!", "error");
            return;
        }

        state.onAir.ticker.text = document.getElementById('tickerText').value;
        state.onAir.ticker.color = document.getElementById('tickerColor').value;
        state.onAir.ticker.bgColor = document.getElementById('tickerBgColor').value;
        state.onAir.ticker.style = document.getElementById('tickerStyle').value;
        state.onAir.ticker.speed = parseInt(document.getElementById('tickerSpeed').value || 2);
        state.onAir.ticker.active = true;
        state.onAir.ticker.activatedAt = Date.now();
        syncOverlaysToPlayer();
    };

    window.removeTickerFromAir = () => {
        state.onAir.ticker.active = false;
        syncOverlaysToPlayer();
    };



    function syncOverlaysToPlayer() {
        socket.emit('studio_update_overlays', {
            channelId: window.CHANNEL_ID,
            overlays: state.onAir
        });
    }

    // Remove specific overlay items
    window.removePreviewOverlay = (type) => {
        const activeWin = getActiveWindow();
        if (type === 'bumper') {
            activeWin.preview.bumper.active = false;
            document.getElementById('bumper-preview-eye').classList.remove('active');
        } else if (type === 'ticker') {
            activeWin.preview.ticker.active = false;
            document.getElementById('ticker-preview-eye').classList.remove('active');
        } else if (type === 'intro') {
            activeWin.preview.intro.active = false;
            document.getElementById('intro-preview-eye').classList.remove('active');
            activeWin.preview.source = 'webcam';
        }
        updatePreviewOverlaysList();
    };

    function updatePreviewOverlaysList() {
        previewOverlaysList.innerHTML = '';
        let count = 0;
        
        const activeWin = getActiveWindow();
        if (activeWin.preview.bumper.active) {
            addOverlayRow('bumper', `ABC/abc Отбивка: "${activeWin.preview.bumper.text1}"`);
            count++;
        }
        if (activeWin.preview.ticker.active) {
            addOverlayRow('ticker', `➔ Бегущая строка: "${activeWin.preview.ticker.text}"`);
            count++;
        }
        if (activeWin.preview.source === 'intro') {
            addOverlayRow('intro', `📺 Заставка: "${activeWin.preview.intro.text1}"`);
            count++;
        }
        
        if (count === 0) {
            previewOverlaysList.innerHTML = '<div style="color: #777; text-align: center; margin-top: 15px; font-size: 10px;">Нет активных элементов на предпросмотре</div>';
        }
    }
    
    function addOverlayRow(type, label) {
        const div = document.createElement('div');
        div.className = 'applied-element-row';
        div.innerHTML = `
            <span class="applied-element-label">${label}</span>
            <span class="applied-element-remove" onclick="removePreviewOverlay('${type}')">✕</span>
        `;
        previewOverlaysList.appendChild(div);
    }

    // ----------------------------------------------------
    // Stream Broadcasting Loop (MediaRecorder -> WebSockets)
    // ----------------------------------------------------
    window.toggleBroadcast = async () => {
        if (state.isConnecting) return;
        const isLiveOnServer = btnToggleBroadcast.textContent === 'ОСТАНОВИТЬ ТРАНСЛЯЦИЮ' || state.isStreaming;
        if (isLiveOnServer) {
            stopBroadcast();
        } else {
            await startBroadcast();
        }
    };

    async function startBroadcast() {
        try {
            console.log('[STUDIO] Initializing startBroadcast...');
            // Mute local Autopilot background player to prevent audio loops
            try { autopilotVideo.pause(); } catch(e){}
            
            initAudioMixing();
            
            // Force AudioContext to resume in Chrome to prevent MediaRecorder stalling
            if (state.audioContext && state.audioContext.state === 'suspended') {
                console.log('[STUDIO] AudioContext is suspended. Attempting to resume...');
                try {
                    await state.audioContext.resume();
                    console.log('[STUDIO] AudioContext resumed. Current state:', state.audioContext.state);
                } catch (e) {
                    console.error('[STUDIO] Failed to resume AudioContext:', e);
                }
            } else {
                console.log('[STUDIO] AudioContext state is:', state.audioContext ? state.audioContext.state : 'null');
            }
            
            state.isConnecting = true;
            btnToggleBroadcast.textContent = 'Установка соединения...';
            btnToggleBroadcast.classList.add('connecting');
            btnToggleBroadcast.disabled = true;
            
            onairDot.className = 'onair-status-indicator';
            onairDot.style.background = '#f0ad4e';
            onairDot.style.boxShadow = '0 0 8px #f0ad4e';
            onairStatusText.textContent = 'Установка соединения...';
            onairStatusText.style.color = '#f0ad4e';

            state.connectionTimeout = setTimeout(() => {
                if (state.isConnecting) {
                    console.warn('[STUDIO] Connection timeout, stopping stream.');
                    alert('Превышено время ожидания подключения к серверу. Пожалуйста, попробуйте снова.');
                    stopBroadcast();
                }
            }, 20000);

            socket.emit('studio_start_stream', {
                channelId: window.CHANNEL_ID,
                streamKey: window.STREAM_KEY
            });
            
            // Combined Canvas + Audio Destination node output stream
            const videoTrack = onAirCanvas.captureStream(30).getVideoTracks()[0];
            let audioTrack = state.audioDest && state.audioDest.stream ? state.audioDest.stream.getAudioTracks()[0] : null;
            
            console.log('[STUDIO] Video track state:', videoTrack ? videoTrack.readyState : 'null');
            console.log('[STUDIO] Initial Audio track retrieved:', audioTrack ? audioTrack.label : 'null');

            if (!audioTrack) {
                // Try to create a silent audio track as fallback to prevent throwing exceptions when mic/audio context is missing or denied
                try {
                    console.log('[STUDIO] Creating fallback silent audio track...');
                    const ctx = state.audioContext || new (window.AudioContext || window.webkitAudioContext)();
                    const osc = ctx.createOscillator();
                    const gainNode = ctx.createGain();
                    gainNode.gain.value = 0;
                    const silentDest = ctx.createMediaStreamDestination();
                    osc.connect(gainNode);
                    gainNode.connect(silentDest);
                    osc.start();
                    audioTrack = silentDest.stream.getAudioTracks()[0];
                    console.log('[STUDIO] Fallback silent audio track created:', audioTrack ? audioTrack.label : 'null');
                } catch (e) {
                    console.warn('Не удалось создать резервную тихую аудиодорожку:', e);
                }
            }
            
            if (!audioTrack) {
                throw new Error('Не найден микрофон или источник звука, и не удалось инициализировать резервный звук.');
            }
            
            const combinedStream = new MediaStream([videoTrack, audioTrack]);
            
            let mimeType = '';
            const mimeCandidates = [
                'video/webm;codecs=vp8,opus',
                'video/webm;codecs=h264,opus',
                'video/webm',
                'video/mp4;codecs=avc1,mp4a.40.2',
                'video/mp4;codecs=h264,aac',
                'video/mp4'
            ];
            for (const type of mimeCandidates) {
                try {
                    if (typeof MediaRecorder.isTypeSupported === 'function' && MediaRecorder.isTypeSupported(type)) {
                        mimeType = type;
                        break;
                    }
                } catch (e) {}
            }
            
            const recorderOptions = {
                videoBitsPerSecond: 1500000,
                audioBitsPerSecond: 128000
            };
            if (mimeType) {
                recorderOptions.mimeType = mimeType;
                console.log('[STUDIO] Using supported MIME type:', mimeType);
            } else {
                console.log('[STUDIO] No candidate MIME type is explicitly supported, falling back to browser default.');
            }
            
            state.combinedStream = combinedStream;
            state.mimeType = mimeType;
            state.mediaRecorder = new MediaRecorder(combinedStream, recorderOptions);
            
            state.mediaRecorder.ondataavailable = async (e) => {
                if (e.data && e.data.size > 0) {
                    try {
                        const buffer = await e.data.arrayBuffer();
                        console.log('[STUDIO] Chunk size generated:', buffer.byteLength);
                        
                        const bytes = new Uint8Array(buffer);
                        let binary = '';
                        const chunkSize = 8192;
                        for (let i = 0; i < bytes.length; i += chunkSize) {
                            binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
                        }
                        const base64 = btoa(binary);

                        socket.emit('studio_chunk', {
                            channelId: window.CHANNEL_ID,
                            chunk: base64,
                            isBase64: true
                        });
                    } catch (err) {
                        console.error('Ошибка преобразования Blob в Base64:', err);
                    }
                } else {
                    console.log('[STUDIO] ondataavailable fired with empty or missing data. Size:', e.data ? e.data.size : 'null');
                }
            };
            
            state.mediaRecorder.start(1000);
            console.log('[STUDIO] MediaRecorder started, state:', state.mediaRecorder.state);
            
        } catch (err) {
            console.error('Ошибка старта вещания:', err);
            try {
                socket.emit('studio_client_error', {
                    channelId: window.CHANNEL_ID,
                    error: {
                        message: err.message,
                        stack: err.stack,
                        name: err.name
                    }
                });
            } catch (e) {}
            alert('Не удалось запустить трансляцию: ' + err.message);
            stopBroadcast();
        }
    }

    function stopBroadcast() {
        if (state.chunkInterval) {
            clearInterval(state.chunkInterval);
            state.chunkInterval = null;
        }

        if (state.mediaRecorder && state.mediaRecorder.state !== 'inactive') {
            try { state.mediaRecorder.stop(); } catch(e){}
        }
        
        socket.emit('studio_stop_stream', {
            channelId: window.CHANNEL_ID
        });
        
        state.isStreaming = false;
        state.isConnecting = false;
        if (state.connectionTimeout) {
            clearTimeout(state.connectionTimeout);
            state.connectionTimeout = null;
        }
        
        btnToggleBroadcast.disabled = false;
        btnToggleBroadcast.textContent = 'Начать трансляцию';
        btnToggleBroadcast.classList.remove('streaming');
        btnToggleBroadcast.classList.remove('connecting');
        
        onairDot.classList.remove('live');
        onairDot.style.background = '';
        onairDot.style.boxShadow = '';
        onairStatusText.textContent = '✈️ Автопилот';
        onairStatusText.style.color = '#888';

        const titleContainer = document.getElementById('studio-live-title-container');
        if (titleContainer) titleContainer.style.display = 'none';

        const recordBtn = document.getElementById('btn-record-stream');
        if (recordBtn) recordBtn.style.display = 'none';
        
        // Remove active overlays from air and sync to viewers
        state.onAir.bumper.active = false;
        state.onAir.intro.active = false;
        state.onAir.ticker.active = false;
        state.onAir.source = 'webcam';
        syncOverlaysToPlayer();
        
        // Re-trigger/play autopilot stream monitor
        setTimeout(checkAutopilotStatus, 1000);
    }

    // Escape tags string utility
    function escapeHtml(str) {
        if (!str) return '';
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

    // ----------------------------------------------------
    // Custom Color Picker implementation (matching Chat)
    // ----------------------------------------------------
    const studioColorPalette = document.getElementById('studio-color-palette');
    let activeColorInput = null;

    if (studioColorPalette) {
        const spectrumCanvas = studioColorPalette.querySelector('.studio-color-spectrum');
        const sliderCanvas = studioColorPalette.querySelector('.studio-color-slider');

        function rgbToHsv(r, g, b) {
            r /= 255; g /= 255; b /= 255;
            const max = Math.max(r, g, b), min = Math.min(r, g, b);
            let h, s, v = max;
            const d = max - min;
            s = max === 0 ? 0 : d / max;
            if (max === min) {
                h = 0;
            } else if (max === r) {
                h = (g - b) / d + (g < b ? 6 : 0);
            } else if (max === g) {
                h = (b - r) / d + 2;
            } else {
                h = (r - g) / d + 4;
            }
            h /= 6;
            return [h, s, v];
        }

        function hsvToRgb(h, s, v) {
            let r, g, b;
            const i = Math.floor(h * 6);
            const f = h * 6 - i;
            const p = v * (1 - s);
            const q = v * (1 - f * s);
            const t = v * (1 - (1 - f) * s);
            switch (i % 6) {
                case 0: r = v; g = t; b = p; break;
                case 1: r = q; g = v; b = p; break;
                case 2: r = p; g = v; b = t; break;
                case 3: r = p; g = q; b = v; break;
                case 4: r = t; g = p; b = v; break;
                case 5: r = v; g = p; b = q; break;
            }
            return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
        }

        function rgbToHex(r, g, b) {
            const toHex = (c) => {
                const hex = c.toString(16);
                return hex.length === 1 ? '0' + hex : hex;
            };
            return '#' + toHex(r) + toHex(g) + toHex(b);
        }

        function drawSpectrum(canvas, hSelected, sSelected) {
            const ctx = canvas.getContext('2d');
            const w = canvas.width;
            const h = canvas.height;
            const hueGrad = ctx.createLinearGradient(0, 0, w, 0);
            hueGrad.addColorStop(0, '#ff0000');
            hueGrad.addColorStop(0.17, '#ffff00');
            hueGrad.addColorStop(0.33, '#00ff00');
            hueGrad.addColorStop(0.5, '#00ffff');
            hueGrad.addColorStop(0.67, '#0000ff');
            hueGrad.addColorStop(0.83, '#ff00ff');
            hueGrad.addColorStop(1, '#ff0000');
            ctx.fillStyle = hueGrad;
            ctx.fillRect(0, 0, w, h);

            const satGrad = ctx.createLinearGradient(0, 0, 0, h);
            satGrad.addColorStop(0, 'rgba(255, 255, 255, 0)');
            satGrad.addColorStop(1, 'rgba(255, 255, 255, 1)');
            ctx.fillStyle = satGrad;
            ctx.fillRect(0, 0, w, h);

            const cx = hSelected * w;
            const cy = (1 - sSelected) * h;
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.moveTo(cx - 5, cy); ctx.lineTo(cx + 5, cy);
            ctx.moveTo(cx, cy - 5); ctx.lineTo(cx, cy + 5);
            ctx.stroke();

            ctx.strokeStyle = '#000000';
            ctx.lineWidth = 0.5;
            ctx.beginPath();
            ctx.moveTo(cx - 5, cy); ctx.lineTo(cx - 2, cy);
            ctx.moveTo(cx + 2, cy); ctx.lineTo(cx + 5, cy);
            ctx.moveTo(cx, cy - 5); ctx.lineTo(cx, cy - 2);
            ctx.moveTo(cx, cy + 2); ctx.lineTo(cx, cy + 5);
            ctx.stroke();
        }

        function drawSlider(canvas, hSelected, sSelected, vSelected) {
            const ctx = canvas.getContext('2d');
            const w = canvas.width;
            const h = canvas.height;
            const rgbBase = hsvToRgb(hSelected, sSelected, 1);
            const baseColor = `rgb(${rgbBase[0]}, ${rgbBase[1]}, ${rgbBase[2]})`;
            const valGrad = ctx.createLinearGradient(0, 0, 0, h);
            valGrad.addColorStop(0, baseColor);
            valGrad.addColorStop(1, '#000000');
            ctx.fillStyle = valGrad;
            ctx.fillRect(0, 0, w, h);

            const cy = (1 - vSelected) * h;
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 2;
            ctx.strokeRect(0, cy - 1, w, 2);
            ctx.strokeStyle = '#000000';
            ctx.lineWidth = 1;
            ctx.strokeRect(-1, cy - 2, w + 2, 4);
        }

        let hueVal = 0, satVal = 1, valVal = 1;

        function updateFromHex(hex) {
            if (!hex.startsWith('#')) hex = '#' + hex;
            const r = parseInt(hex.slice(1, 3), 16) || 0;
            const g = parseInt(hex.slice(3, 5), 16) || 0;
            const b = parseInt(hex.slice(5, 7), 16) || 0;
            const hsv = rgbToHsv(r, g, b);
            hueVal = hsv[0];
            satVal = hsv[1];
            valVal = hsv[2];
        }

        function renderPalette() {
            if (spectrumCanvas && sliderCanvas) {
                drawSpectrum(spectrumCanvas, hueVal, satVal);
                drawSlider(sliderCanvas, hueVal, satVal, valVal);
            }
        }

        function triggerPaletteChange() {
            if (!activeColorInput) return;
            const rgb = hsvToRgb(hueVal, satVal, valVal);
            const hex = rgbToHex(rgb[0], rgb[1], rgb[2]);
            activeColorInput.value = hex;
            updateCtrlColorInputStyle(activeColorInput);

            // Dynamically update active preview/onAir state color values
            const id = activeColorInput.id;
            const activeWin = getActiveWindow();
            if (id === 'bumperColor1') activeWin.preview.bumper.color1 = hex;
            else if (id === 'bumperColor2') activeWin.preview.bumper.color2 = hex;
            else if (id === 'bumperBgColor1') activeWin.preview.bumper.bgColor1 = hex;
            else if (id === 'bumperBgColor2') activeWin.preview.bumper.bgColor2 = hex;
            else if (id === 'introColor1') activeWin.preview.intro.color1 = hex;
            else if (id === 'introColor2') activeWin.preview.intro.color2 = hex;
            else if (id === 'introBgColor1') activeWin.preview.intro.bgColor1 = hex;
            else if (id === 'introBgColor2') activeWin.preview.intro.bgColor2 = hex;
            else if (id === 'tickerColor') activeWin.preview.ticker.color = hex;
            else if (id === 'tickerBgColor') activeWin.preview.ticker.bgColor = hex;

            activeColorInput.dispatchEvent(new Event('input', { bubbles: true }));
            activeColorInput.dispatchEvent(new Event('change', { bubbles: true }));
        }

        let isDraggingSpectrum = false;
        let isDraggingSlider = false;

        function handleSpectrumMove(e) {
            if (!spectrumCanvas) return;
            const rect = spectrumCanvas.getBoundingClientRect();
            let x = e.clientX - rect.left;
            let y = e.clientY - rect.top;
            x = Math.max(0, Math.min(x, rect.width));
            y = Math.max(0, Math.min(y, rect.height));
            hueVal = x / rect.width;
            satVal = 1 - (y / rect.height);
            renderPalette();
            triggerPaletteChange();
        }

        function handleSliderMove(e) {
            if (!sliderCanvas) return;
            const rect = sliderCanvas.getBoundingClientRect();
            let y = e.clientY - rect.top;
            y = Math.max(0, Math.min(y, rect.height));
            valVal = 1 - (y / rect.height);
            renderPalette();
            triggerPaletteChange();
        }

        if (spectrumCanvas) {
            spectrumCanvas.addEventListener('mousedown', (e) => {
                isDraggingSpectrum = true;
                handleSpectrumMove(e);
            });
            
            spectrumCanvas.addEventListener('touchstart', (e) => {
                isDraggingSpectrum = true;
                if (e.touches.length > 0) handleSpectrumMove(e.touches[0]);
                e.preventDefault();
            }, { passive: false });
        }

        if (sliderCanvas) {
            sliderCanvas.addEventListener('mousedown', (e) => {
                isDraggingSlider = true;
                handleSliderMove(e);
            });
            
            sliderCanvas.addEventListener('touchstart', (e) => {
                isDraggingSlider = true;
                if (e.touches.length > 0) handleSliderMove(e.touches[0]);
                e.preventDefault();
            }, { passive: false });
        }

        document.addEventListener('mousemove', (e) => {
            if (isDraggingSpectrum) handleSpectrumMove(e);
            if (isDraggingSlider) handleSliderMove(e);
        });

        document.addEventListener('touchmove', (e) => {
            if (e.touches.length > 0) {
                if (isDraggingSpectrum) handleSpectrumMove(e.touches[0]);
                if (isDraggingSlider) handleSliderMove(e.touches[0]);
            }
        });

        document.addEventListener('mouseup', () => {
            isDraggingSpectrum = false;
            isDraggingSlider = false;
        });

        document.addEventListener('touchend', () => {
            isDraggingSpectrum = false;
            isDraggingSlider = false;
        });

        // Click outside to close
        document.addEventListener('click', (e) => {
            if (!studioColorPalette) return;
            if (activeColorInput && !studioColorPalette.contains(e.target) && e.target !== activeColorInput) {
                studioColorPalette.style.display = 'none';
                activeColorInput = null;
            }
        });

        // Initialize click logic on color fields
        window.initColorFields = () => {
            document.querySelectorAll('.ctrl-color').forEach(input => {
                // Initial styling
                updateCtrlColorInputStyle(input);

                input.addEventListener('click', (e) => {
                    e.stopPropagation();
                    input.blur();
                    activeColorInput = input;
                    updateFromHex(input.value);
                    
                    const rect = input.getBoundingClientRect();
                    
                    // Compute absolute position on document
                    const topPos = rect.top + window.scrollY - 105; // 80px height + padding/borders
                    
                    // Constrain leftPos to prevent right-edge viewport overflow
                    let leftPos = rect.left + window.scrollX;
                    const popoverWidth = 195; // studio-color-palette width
                    const viewportWidth = window.innerWidth;
                    if (rect.left + popoverWidth > viewportWidth) {
                        leftPos = viewportWidth + window.scrollX - popoverWidth - 15; // 15px safe margin
                    }
                    if (leftPos < 0) leftPos = window.scrollX + 10;
                    
                    studioColorPalette.style.top = `${topPos}px`;
                    studioColorPalette.style.left = `${leftPos}px`;
                    studioColorPalette.style.display = 'flex';
                    
                    renderPalette();
                });
            });
        };

        window.updateCtrlColorInputStyle = (input) => {
            const hex = input.value;
            input.style.backgroundColor = hex;
            // Calculate brightness
            let r = parseInt(hex.slice(1, 3), 16) || 0;
            let g = parseInt(hex.slice(3, 5), 16) || 0;
            let b = parseInt(hex.slice(5, 7), 16) || 0;
            const brightness = 0.299 * r + 0.587 * g + 0.114 * b;
            input.style.color = brightness > 128 ? '#000000' : '#ffffff';
        };

        // Call initColorFields immediately
        initColorFields();
    }

    // ----------------------------------------------------
    // Window Presets Management Logic
    // ----------------------------------------------------
    window.renderWindowTabs = () => {
        const container = document.getElementById('window-tabs-container');
        if (!container) return;
        
        container.innerHTML = '';
        state.windows.forEach(win => {
            const tab = document.createElement('button');
            tab.className = `window-tab${win.id === state.activeWindowId ? ' active' : ''}`;
            tab.onclick = () => selectWindow(win.id);
            
            const label = document.createElement('span');
            label.textContent = win.name;
            tab.appendChild(label);
            
            if (state.windows.length > 1) {
                const closeBtn = document.createElement('span');
                closeBtn.className = 'window-tab-close';
                closeBtn.textContent = '×';
                closeBtn.onclick = (e) => {
                    e.stopPropagation();
                    deleteWindow(win.id);
                };
                tab.appendChild(closeBtn);
            }
            
            container.appendChild(tab);
        });
    };

    window.addNewWindow = () => {
        const id = state.nextWindowId++;
        const name = `Окно ${id}`;
        
        // Copy current window preview state
        const currentActiveWin = getActiveWindow();
        const copiedPreview = JSON.parse(JSON.stringify(currentActiveWin.preview));
        
        copiedPreview.bumper.active = false;
        copiedPreview.intro.active = false;
        copiedPreview.ticker.active = false;
        
        state.windows.push({
            id,
            name,
            preview: copiedPreview
        });
        
        selectWindow(id);
    };

    window.selectWindow = (id) => {
        state.activeWindowId = id;
        renderWindowTabs();
        
        const activeWin = getActiveWindow();
        
        // Restore input values
        document.getElementById('bumperText1').value = activeWin.preview.bumper.text1 || '';
        document.getElementById('bumperText2').value = activeWin.preview.bumper.text2 || '';
        document.getElementById('bumperColor1').value = activeWin.preview.bumper.color1 || '#ffffff';
        document.getElementById('bumperColor2').value = activeWin.preview.bumper.color2 || '#6fdeee';
        document.getElementById('bumperBgColor1').value = activeWin.preview.bumper.bgColor1 || '#ff3b30';
        document.getElementById('bumperBgColor2').value = activeWin.preview.bumper.bgColor2 || '#007af5';
        document.getElementById('bumperStyle').value = activeWin.preview.bumper.style || 'standard';
        
        document.getElementById('introText1').value = activeWin.preview.intro.text1 || '';
        document.getElementById('introText2').value = activeWin.preview.intro.text2 || '';
        document.getElementById('introColor1').value = activeWin.preview.intro.color1 || '#ffffff';
        document.getElementById('introColor2').value = activeWin.preview.intro.color2 || '#6fdeee';
        document.getElementById('introBgColor1').value = activeWin.preview.intro.bgColor1 || '#1f1c2c';
        document.getElementById('introBgColor2').value = activeWin.preview.intro.bgColor2 || '#928dab';
        document.getElementById('introStyle').value = activeWin.preview.intro.style || 'gradient-pulse';
        
        document.getElementById('tickerText').value = activeWin.preview.ticker.text || '';
        document.getElementById('tickerColor').value = activeWin.preview.ticker.color || '#ffffff';
        document.getElementById('tickerBgColor').value = activeWin.preview.ticker.bgColor || '#007af5';
        document.getElementById('tickerStyle').value = activeWin.preview.ticker.style || 'standard';
        document.getElementById('tickerSpeed').value = activeWin.preview.ticker.speed || 2;
        
        // Update picker background styles
        document.querySelectorAll('.ctrl-color').forEach(input => {
            updateCtrlColorInputStyle(input);
        });
        
        // Sync preview buttons
        document.getElementById('bumper-preview-eye').classList.toggle('active', activeWin.preview.bumper.active);
        document.getElementById('intro-preview-eye').classList.toggle('active', activeWin.preview.intro.active);
        document.getElementById('ticker-preview-eye').classList.toggle('active', activeWin.preview.ticker.active);
        
        // Highlight active source in sidebar
        document.querySelectorAll('.archive-item').forEach(item => item.classList.remove('active'));
        if (activeWin.preview.source === 'archive' && activeWin.preview.archiveId) {
            const item = document.querySelector(`.archive-item[onclick*="${activeWin.preview.archiveId}"]`);
            if (item) item.classList.add('active');
        }
        
        // Sync active side tab classes
        document.getElementById('tab-sources-btn').classList.toggle('active', activeWin.preview.source === 'webcam');
        document.getElementById('tab-archive-btn').classList.toggle('active', activeWin.preview.source === 'archive');
        document.getElementById('pane-sources').style.display = activeWin.preview.source === 'webcam' ? 'block' : 'none';
        document.getElementById('pane-archive').style.display = activeWin.preview.source === 'archive' ? 'block' : 'none';

        updatePreviewOverlaysList();
    };

    window.deleteWindow = (id) => {
        if (state.windows.length <= 1) return;
        const index = state.windows.findIndex(w => w.id === id);
        if (index === -1) return;
        
        state.windows.splice(index, 1);
        
        if (state.activeWindowId === id) {
            const newActiveId = state.windows[Math.min(index, state.windows.length - 1)].id;
            selectWindow(newActiveId);
        } else {
            renderWindowTabs();
        }
    };

    function setupInputSync() {
        const inputs = [
            { id: 'bumperText1', path: 'bumper.text1' },
            { id: 'bumperText2', path: 'bumper.text2' },
            { id: 'bumperColor1', path: 'bumper.color1' },
            { id: 'bumperColor2', path: 'bumper.color2' },
            { id: 'bumperBgColor1', path: 'bumper.bgColor1' },
            { id: 'bumperBgColor2', path: 'bumper.bgColor2' },
            { id: 'bumperStyle', path: 'bumper.style' },
            
            { id: 'introText1', path: 'intro.text1' },
            { id: 'introText2', path: 'intro.text2' },
            { id: 'introColor1', path: 'intro.color1' },
            { id: 'introColor2', path: 'intro.color2' },
            { id: 'introBgColor1', path: 'intro.bgColor1' },
            { id: 'introBgColor2', path: 'intro.bgColor2' },
            { id: 'introStyle', path: 'intro.style' },
            
            { id: 'tickerText', path: 'ticker.text' },
            { id: 'tickerColor', path: 'ticker.color' },
            { id: 'tickerBgColor', path: 'ticker.bgColor' },
            { id: 'tickerStyle', path: 'ticker.style' },
            { id: 'tickerSpeed', path: 'ticker.speed', parse: parseInt }
        ];

        inputs.forEach(item => {
            const el = document.getElementById(item.id);
            if (!el) return;
            const handler = () => {
                const activeWin = getActiveWindow();
                let val = el.value;
                if (item.parse) val = item.parse(val) || 0;
                
                const parts = item.path.split('.');
                activeWin.preview[parts[0]][parts[1]] = val;
            };
            el.addEventListener('input', handler);
            el.addEventListener('change', handler);
        });
    }

    // ----------------------------------------------------
    // Startup
    // ----------------------------------------------------
    initDevices();
    drawStudioCanvas();
    
    // Initialize dynamic tabs and sync listeners
    renderWindowTabs();
    setupInputSync();

    // ----------------------------------------------------
    // Broadcast Recording Logic (Moved from Dashboard)
    // ----------------------------------------------------
    const recordBtn = document.getElementById('btn-record-stream');
    const recordIndicator = document.getElementById('studio_record_indicator');
    const recordTimer = document.getElementById('studio_record_timer');
    let recTimerInterval = null;
    let recSecondsElapsed = 0;

    function checkRecordStatus() {
        fetch('/api/panel/records/record/status')
            .then(res => res.json())
            .then(data => {
                if (data.success && data.recording) {
                    startLocalRecTimer(data.elapsed);
                } else {
                    if (recTimerInterval && !data.recording) {
                        stopLocalRecTimer();
                    }
                }
            })
            .catch(err => console.error('Error checking recording status:', err));
    }

    function startLocalRecTimer(initialSeconds = 0) {
        recSecondsElapsed = initialSeconds;
        updateRecTimerDisplay();
        
        if (recordIndicator) recordIndicator.style.display = 'flex';
        if (recordBtn) {
            recordBtn.innerHTML = '⏹️ Остановить запись';
            recordBtn.classList.add('recording');
            recordBtn.title = 'Остановить запись';
        }
        
        if (recTimerInterval) clearInterval(recTimerInterval);
        recTimerInterval = setInterval(() => {
            recSecondsElapsed++;
            updateRecTimerDisplay();
            if (recSecondsElapsed >= 300) { // 5 min max
                stopLocalRecTimer();
                showToast('Запись завершена автоматически (лимит 5 минут)', 'success');
            }
        }, 1000);
    }

    function stopLocalRecTimer() {
        if (recTimerInterval) {
            clearInterval(recTimerInterval);
            recTimerInterval = null;
        }
        if (recordIndicator) recordIndicator.style.display = 'none';
        if (recordBtn) {
            recordBtn.innerHTML = '⏺️ Начать запись';
            recordBtn.classList.remove('recording');
            recordBtn.title = 'Начать запись';
        }
    }

    function updateRecTimerDisplay() {
        if (!recordTimer) return;
        const mins = Math.floor(recSecondsElapsed / 60).toString().padStart(2, '0');
        const secs = (recSecondsElapsed % 60).toString().padStart(2, '0');
        recordTimer.innerText = mins + ':' + secs;
    }

    window.toggleRecordStream = function() {
        const isCurrentlyRecording = !!recTimerInterval;
        const url = isCurrentlyRecording ? '/api/panel/records/record/stop' : '/api/panel/records/record/start';
        
        if (recordBtn) recordBtn.disabled = true;
        fetch(url, { method: 'POST' })
            .then(res => res.json())
            .then(data => {
                if (recordBtn) recordBtn.disabled = false;
                if (data.success) {
                    if (isCurrentlyRecording) {
                        stopLocalRecTimer();
                        showToast('Запись эфира успешно остановлена и добавлена в Медиа-архив на обработку!', 'success');
                    } else {
                        startLocalRecTimer(0);
                        showToast('Запись эфира запущена (максимум 5 минут)', 'success');
                    }
                } else {
                    showToast(data.error || 'Ошибка при изменении статуса записи', 'error');
                }
            })
            .catch(err => {
                if (recordBtn) recordBtn.disabled = false;
                console.error(err);
                showToast('Ошибка сети при отправке запроса', 'error');
            });
    };

    // Initial check
    if (recordBtn) {
        checkRecordStatus();
        setInterval(checkRecordStatus, 15000);
    }

    // ----------------------------------------------------
    // Edit Broadcast Title Logic
    // ----------------------------------------------------
    window.editStudioLiveTitle = function() {
        const shortname = window.CHANNEL_SHORTNAME;
        const currentTitleSpan = document.getElementById('studio-live-title-span');
        const oldTitle = currentTitleSpan ? currentTitleSpan.innerText : '';
        const newTitle = prompt('Введите новое название для текущей передачи:', oldTitle);
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
            .then(async res => {
                const isJson = res.headers.get('content-type')?.includes('application/json');
                const data = isJson ? await res.json() : null;
                if (!res.ok) {
                    throw new Error(data?.error || `HTTP ${res.status}`);
                }
                return data;
            })
            .then(data => {
                if (data && data.success) {
                    if (currentTitleSpan) currentTitleSpan.innerText = newTitle.trim();
                    showToast('Название передачи успешно изменено!', 'success');
                } else {
                    alert('Ошибка при сохранении: ' + (data?.error || 'Неизвестная ошибка'));
                }
            })
            .catch(e => {
                console.error('Error editing live title:', e);
                alert('Ошибка при изменении названия: ' + e.message);
            });
        }
    };

    // ----------------------------------------------------
    // Confirm Unload/Refresh Dialog
    // ----------------------------------------------------
    window.addEventListener('beforeunload', (event) => {
        if (state.isStreaming || state.isConnecting) {
            event.preventDefault();
            const message = 'Вы действительно хотите обновить или закрыть эфирную студию? Весь прогресс и трансляция прекратится.';
            event.returnValue = message;
            return message;
        }
    });

    // Check autopilot status immediately and then every 8 seconds
    checkAutopilotStatus();
    setInterval(checkAutopilotStatus, 8000);
});
