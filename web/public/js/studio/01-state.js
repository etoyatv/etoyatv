/* === 01-state.js (lines 1-243) === */
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

    let lastAutopilotData = null;

    const state = {
        videoDevices: [],
        audioDevices: [],
        localStream: null,
        audioContext: null,
        audioDest: null,
        micGainNode: null,
        videoGainNode: null,
        mediaRecorder: null,
        peerConnection: null,
        whipResourceUrl: null,
        publishId: 0,
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
            ticker: { active: false, text: '', color: '#ffffff', bgColor: '#007af5', style: 'standard', speed: 2, offset: 1280 },
            common: defaultPreviewState(),
            1: defaultPreviewState(),
            2: defaultPreviewState(),
            3: defaultPreviewState()
        }
    };

    function getActiveWindow() {
        return state.windows.find(w => w.id === state.activeWindowId) || state.windows[0];
    }

    function defaultOverlaysObj() {
        return defaultPreviewState();
    }

    function getActiveOnAirOverlays() {
        const activeStreams = (lastAutopilotData && lastAutopilotData.is_live) ? (lastAutopilotData.active_streams || []) : [];
        if (activeStreams.length <= 1) {
            return state.onAir.common || state.onAir;
        } else {
            const idx = currentSelectedStudioStreamIndex || 1;
            if (!state.onAir[idx]) {
                state.onAir[idx] = defaultOverlaysObj();
            }
            return state.onAir[idx];
        }
    }

    function syncFlatOnAirKeys(activeOnAir) {
        state.onAir.source = activeOnAir.source;
        state.onAir.bumper = activeOnAir.bumper;
        state.onAir.intro = activeOnAir.intro;
        state.onAir.ticker = activeOnAir.ticker;
    }

    function updateStudioOverlayInputs() {
        const activeOnAir = getActiveOnAirOverlays();
        
        // Ticker
        const tickerTextEl = document.getElementById('tickerText');
        const tickerColorEl = document.getElementById('tickerColor');
        const tickerBgColorEl = document.getElementById('tickerBgColor');
        const tickerStyleEl = document.getElementById('tickerStyle');
        const tickerSpeedEl = document.getElementById('tickerSpeed');
        
        if (tickerTextEl) tickerTextEl.value = activeOnAir.ticker.text || '';
        if (tickerColorEl) {
            tickerColorEl.value = activeOnAir.ticker.color || '#ffffff';
            if (window.updateCtrlColorInputStyle) window.updateCtrlColorInputStyle(tickerColorEl);
        }
        if (tickerBgColorEl) {
            tickerBgColorEl.value = activeOnAir.ticker.bgColor || '#007af5';
            if (window.updateCtrlColorInputStyle) window.updateCtrlColorInputStyle(tickerBgColorEl);
        }
        if (tickerStyleEl) tickerStyleEl.value = activeOnAir.ticker.style || 'standard';
        if (tickerSpeedEl) tickerSpeedEl.value = activeOnAir.ticker.speed || 2;
        
        // Bumper
        const bumperText1El = document.getElementById('bumperText1');
        const bumperText2El = document.getElementById('bumperText2');
        const bumperColor1El = document.getElementById('bumperColor1');
        const bumperColor2El = document.getElementById('bumperColor2');
        const bumperBgColor1El = document.getElementById('bumperBgColor1');
        const bumperBgColor2El = document.getElementById('bumperBgColor2');
        const bumperStyleEl = document.getElementById('bumperStyle');
        
        if (bumperText1El) bumperText1El.value = activeOnAir.bumper.text1 || '';
        if (bumperText2El) bumperText2El.value = activeOnAir.bumper.text2 || '';
        if (bumperColor1El) {
            bumperColor1El.value = activeOnAir.bumper.color1 || '#ffffff';
            if (window.updateCtrlColorInputStyle) window.updateCtrlColorInputStyle(bumperColor1El);
        }
        if (bumperColor2El) {
            bumperColor2El.value = activeOnAir.bumper.color2 || '#6fdeee';
            if (window.updateCtrlColorInputStyle) window.updateCtrlColorInputStyle(bumperColor2El);
        }
        if (bumperBgColor1El) {
            bumperBgColor1El.value = activeOnAir.bumper.bgColor1 || '#ff3b30';
            if (window.updateCtrlColorInputStyle) window.updateCtrlColorInputStyle(bumperBgColor1El);
        }
        if (bumperBgColor2El) {
            bumperBgColor2El.value = activeOnAir.bumper.bgColor2 || '#007af5';
            if (window.updateCtrlColorInputStyle) window.updateCtrlColorInputStyle(bumperBgColor2El);
        }
        if (bumperStyleEl) bumperStyleEl.value = activeOnAir.bumper.style || 'standard';

        // Intro
        const introText1El = document.getElementById('introText1');
        const introText2El = document.getElementById('introText2');
        const introColor1El = document.getElementById('introColor1');
        const introColor2El = document.getElementById('introColor2');
        const introBgColor1El = document.getElementById('introBgColor1');
        const introBgColor2El = document.getElementById('introBgColor2');
        const introStyleEl = document.getElementById('introStyle');
        
        if (introText1El) introText1El.value = activeOnAir.intro.text1 || '';
        if (introText2El) introText2El.value = activeOnAir.intro.text2 || '';
        if (introColor1El) {
            introColor1El.value = activeOnAir.intro.color1 || '#ffffff';
            if (window.updateCtrlColorInputStyle) window.updateCtrlColorInputStyle(introColor1El);
        }
        if (introColor2El) {
            introColor2El.value = activeOnAir.intro.color2 || '#6fdeee';
            if (window.updateCtrlColorInputStyle) window.updateCtrlColorInputStyle(introColor2El);
        }
        if (introBgColor1El) {
            introBgColor1El.value = activeOnAir.intro.bgColor1 || '#1f1c2c';
            if (window.updateCtrlColorInputStyle) window.updateCtrlColorInputStyle(introBgColor1El);
        }
        if (introBgColor2El) {
            introBgColor2El.value = activeOnAir.intro.bgColor2 || '#928dab';
            if (window.updateCtrlColorInputStyle) window.updateCtrlColorInputStyle(introBgColor2El);
        }
        if (introStyleEl) introStyleEl.value = activeOnAir.intro.style || 'gradient-pulse';
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

