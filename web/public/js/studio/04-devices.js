/* === 04-devices.js (lines 598-1053) === */
    // ----------------------------------------------------
    // Device Enumerate & Camera Stream Capture
    // ----------------------------------------------------
    async function initDevices() {
        try {
            // Permission first so device labels are available
            const warm = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
            warm.getTracks().forEach(t => t.stop());
        } catch (e) {
            console.warn('[STUDIO] Camera/mic permission denied or unavailable:', e);
            showToast('Разрешите доступ к камере и микрофону', 'error');
            return;
        }

        try {
            const devices = await navigator.mediaDevices.enumerateDevices();
            state.videoDevices = devices.filter(d => d.kind === 'videoinput');
            state.audioDevices = devices.filter(d => d.kind === 'audioinput');

            videoSelect.innerHTML = '';
            state.videoDevices.forEach((d, i) => {
                const opt = document.createElement('option');
                opt.value = d.deviceId;
                opt.textContent = d.label || `Камера ${i + 1}`;
                videoSelect.appendChild(opt);
            });

            audioSelect.innerHTML = '';
            state.audioDevices.forEach((d, i) => {
                const opt = document.createElement('option');
                opt.value = d.deviceId;
                opt.textContent = d.label || `Микрофон ${i + 1}`;
                audioSelect.appendChild(opt);
            });

            videoSelect.onchange = () => startCameraStream();
            audioSelect.onchange = () => startCameraStream();

            const micSlider = document.getElementById('micVolumeSlider');
            if (micSlider) {
                micSlider.oninput = () => window.updateMicVolume(micSlider.value);
            }

            await startCameraStream();
        } catch (e) {
            console.error('[STUDIO] initDevices failed:', e);
        }
    }

    async function startCameraStream() {
        try {
            if (state.localStream) {
                state.localStream.getTracks().forEach(t => t.stop());
                state.localStream = null;
            }

            const videoId = videoSelect && videoSelect.value;
            const audioId = audioSelect && audioSelect.value;

            state.localStream = await navigator.mediaDevices.getUserMedia({
                video: {
                    deviceId: videoId ? { exact: videoId } : undefined,
                    width: { ideal: 1280, max: 1280 },
                    height: { ideal: 720, max: 720 },
                    frameRate: { ideal: 30, max: 30 }
                },
                audio: {
                    deviceId: audioId ? { exact: audioId } : undefined,
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true
                }
            });

            if (localVideo) {
                localVideo.srcObject = state.localStream;
                localVideo.muted = true;
                localVideo.play().catch(() => {});
            }

            initAudioMixing();

            // If already live via WHIP, swap tracks without full reconnect when possible
            if (state.peerConnection && state.isStreaming) {
                await replaceWhipTracks();
            }
        } catch (e) {
            console.error('[STUDIO] startCameraStream failed:', e);
            showToast('Не удалось открыть камеру/микрофон: ' + (e.message || e), 'error');
        }
    }

    function waitIceGatheringComplete(pc, timeoutMs = 4000) {
        if (pc.iceGatheringState === 'complete') return Promise.resolve();
        return new Promise((resolve) => {
            const done = () => {
                pc.removeEventListener('icegatheringstatechange', onChange);
                resolve();
            };
            const onChange = () => {
                if (pc.iceGatheringState === 'complete') done();
            };
            pc.addEventListener('icegatheringstatechange', onChange);
            setTimeout(done, timeoutMs);
        });
    }

    function buildWhipUrl() {
        const short = String(window.CHANNEL_SHORTNAME || '').toLowerCase();
        const key = encodeURIComponent(window.STREAM_KEY || '');
        // same-origin proxy avoids CORS NetworkError
        return `/whip-ingest/live/${short}/whip?key=${key}`;
    }

    function resolveWhipLocation(locationHeader, whipUrl) {
        if (!locationHeader) return null;
        let u;
        try {
            u = new URL(locationHeader, window.location.origin);
        } catch (e) {
            return null;
        }
        // If MediaMTX points at /live/.../whip/..., route through our proxy
        if (u.pathname.includes('/whip')) {
            return `${window.location.origin}/whip-ingest${u.pathname}${u.search}`;
        }
        return u.toString();
    }

    async function getPublishStream() {
        if (!state.localStream) {
            await startCameraStream();
        }
        if (!state.localStream) {
            throw new Error('Камера не готова');
        }
        initAudioMixing();

        const videoTrack = state.localStream.getVideoTracks()[0];
        if (!videoTrack) throw new Error('Нет видеодорожки');

        // Prefer mixed mic (gain slider); fall back to raw mic
        let audioTrack = null;
        if (state.audioDest && state.audioDest.stream.getAudioTracks().length > 0) {
            audioTrack = state.audioDest.stream.getAudioTracks()[0];
        } else if (state.localStream.getAudioTracks().length > 0) {
            audioTrack = state.localStream.getAudioTracks()[0];
        }

        const tracks = audioTrack ? [videoTrack, audioTrack] : [videoTrack];
        return new MediaStream(tracks);
    }

    async function replaceWhipTracks() {
        if (!state.peerConnection) return;
        const publishStream = await getPublishStream();
        const senders = state.peerConnection.getSenders();
        for (const track of publishStream.getTracks()) {
            const sender = senders.find(s => s.track && s.track.kind === track.kind);
            if (sender) {
                await sender.replaceTrack(track);
            }
        }
    }

    function getH264VideoCodecCapabilities() {
        const caps = (window.RTCRtpSender && RTCRtpSender.getCapabilities)
            ? RTCRtpSender.getCapabilities('video')
            : null;
        if (!caps || !caps.codecs || !caps.codecs.length) {
            throw new Error('Браузер не отдаёт список видеокодеков. Откройте студию в Chrome или Edge.');
        }

        const h264 = caps.codecs.filter(c => /H264/i.test(c.mimeType));
        if (!h264.length) {
            throw new Error('Браузер не умеет кодировать H.264. Попробуйте Chrome/Edge или обновите Firefox (OpenH264).');
        }

        // Prefer packetization-mode=1 (Baseline/Constrained often remux cleanly to HLS)
        h264.sort((a, b) => {
            const aPm1 = (a.sdpFmtpLine || '').includes('packetization-mode=1') ? 0 : 1;
            const bPm1 = (b.sdpFmtpLine || '').includes('packetization-mode=1') ? 0 : 1;
            return aPm1 - bPm1;
        });

        const h264Pts = new Set(h264.map(c => c.preferredPayloadType).filter(v => v != null));
        const rtx = caps.codecs.filter(c => {
            if (!/rtx/i.test(c.mimeType)) return false;
            const m = (c.sdpFmtpLine || '').match(/apt=(\d+)/);
            return m && h264Pts.has(Number(m[1]));
        });

        return [...h264, ...rtx];
    }

    /** Keep only H.264 (+ matching rtx) payload types in the video m-section. */
    function forceH264InOfferSdp(sdp) {
        const lines = sdp.split(/\r?\n/);
        const h264Pts = new Set();
        const rtxApt = new Map(); // rtxPt -> apt
        let inVideo = false;

        for (const line of lines) {
            if (line.startsWith('m=')) {
                inVideo = line.startsWith('m=video');
                continue;
            }
            if (!inVideo) continue;

            const rtp = line.match(/^a=rtpmap:(\d+)\s+([^\s/]+)\//i);
            if (rtp) {
                const pt = rtp[1];
                const name = rtp[2];
                if (/^H264$/i.test(name)) h264Pts.add(pt);
                if (/^rtx$/i.test(name)) rtxApt.set(pt, null);
                continue;
            }
            const fmtp = line.match(/^a=fmtp:(\d+)\s+(.+)/i);
            if (fmtp && rtxApt.has(fmtp[1])) {
                const apt = (fmtp[2].match(/apt=(\d+)/) || [])[1];
                if (apt) rtxApt.set(fmtp[1], apt);
            }
        }

        if (!h264Pts.size) {
            throw new Error('В SDP нет H.264. Откройте студию в Chrome/Edge и повторите.');
        }

        const keep = new Set(h264Pts);
        for (const [rtxPt, apt] of rtxApt.entries()) {
            if (apt && h264Pts.has(apt)) keep.add(rtxPt);
        }

        inVideo = false;
        const out = [];
        for (let line of lines) {
            if (line.startsWith('m=')) {
                inVideo = line.startsWith('m=video');
                if (inVideo) {
                    const parts = line.split(' ');
                    const kept = parts.slice(3).filter(pt => keep.has(pt));
                    if (!kept.length) {
                        throw new Error('Не удалось оставить H.264 в SDP. Смените браузер на Chrome/Edge.');
                    }
                    line = [...parts.slice(0, 3), ...kept].join(' ');
                }
                out.push(line);
                continue;
            }
            if (inVideo) {
                const m = line.match(/^a=(?:rtpmap|fmtp|rtcp-fb):(\d+)/);
                if (m && !keep.has(m[1])) continue;
            }
            out.push(line);
        }

        const result = out.join('\r\n');
        assertOfferIsH264(result);
        return result;
    }

    function assertOfferIsH264(sdp) {
        const videoSection = sdp.split(/^m=/m).find(s => s.startsWith('video'));
        if (!videoSection) {
            throw new Error('В SDP нет видео — камера не попала в эфир.');
        }
        if (/rtpmap:\d+\s+VP8\//i.test(videoSection) || /rtpmap:\d+\s+VP9\//i.test(videoSection)) {
            throw new Error('Браузер всё ещё предлагает VP8/VP9. Нужен Chrome/Edge с H.264 (обновите страницу Ctrl+F5).');
        }
        if (!/rtpmap:\d+\s+H264\//i.test(videoSection)) {
            throw new Error('В SDP нет H.264 — эфир без картинки. Откройте Chrome/Edge.');
        }
    }

    async function startWhipPublish() {
        const publishStream = await getPublishStream();
        const videoTrack = publishStream.getVideoTracks()[0];
        const audioTrack = publishStream.getAudioTracks()[0];
        if (!videoTrack) {
            throw new Error('Нет видеотрека с камеры');
        }

        const preferredVideoCodecs = getH264VideoCodecCapabilities();

        const pc = new RTCPeerConnection({
            iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
        });
        state.peerConnection = pc;
        state.whipResourceUrl = null;

        // Transceiver-first so setCodecPreferences applies before the offer
        const videoTransceiver = pc.addTransceiver(videoTrack, { direction: 'sendonly' });
        if (typeof videoTransceiver.setCodecPreferences === 'function') {
            videoTransceiver.setCodecPreferences(preferredVideoCodecs);
        } else {
            console.warn('[STUDIO] setCodecPreferences unavailable; SDP filter only');
        }

        if (audioTrack) {
            pc.addTransceiver(audioTrack, { direction: 'sendonly' });
        }

        // Cap bitrate so browser encoder stays light
        try {
            const params = videoTransceiver.sender.getParameters();
            if (!params.encodings || !params.encodings.length) {
                params.encodings = [{}];
            }
            params.encodings[0].maxBitrate = 2_500_000;
            params.encodings[0].maxFramerate = 30;
            await videoTransceiver.sender.setParameters(params);
        } catch (e) {
            console.warn('[STUDIO] setParameters skipped:', e);
        }

        const offer = await pc.createOffer();
        const h264Sdp = forceH264InOfferSdp(offer.sdp);
        await pc.setLocalDescription({ type: 'offer', sdp: h264Sdp });
        await waitIceGatheringComplete(pc);

        // Re-filter after ICE candidates are appended
        const finalSdp = forceH264InOfferSdp(pc.localDescription.sdp);
        console.log('[STUDIO] Offer video codecs:', (finalSdp.match(/a=rtpmap:\d+ \w+/g) || []).filter(l => /H264|VP8|VP9|rtx/i.test(l)).join(', '));

        const whipUrl = buildWhipUrl();
        console.log('[STUDIO] WHIP POST', whipUrl.replace(/key=[^&]+/, 'key=***'));

        const res = await fetch(whipUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/sdp',
                'Accept': 'application/sdp'
            },
            body: finalSdp
        });

        if (!res.ok) {
            const errText = await res.text().catch(() => '');
            throw new Error(`WHIP ${res.status}: ${errText || res.statusText}`);
        }

        state.whipResourceUrl = resolveWhipLocation(res.headers.get('Location'), whipUrl);
        const answerSdp = await res.text();
        await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });

        pc.onconnectionstatechange = () => {
            console.log('[STUDIO] WebRTC state:', pc.connectionState);
            if (pc !== state.peerConnection) return;
            if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
                if (state.isStreaming && !state.isConnecting) {
                    showToast('Соединение с эфиром потеряно', 'error');
                    stopBroadcast();
                }
            }
        };
    }

    async function stopWhipPublish() {
        const pc = state.peerConnection;
        const resource = state.whipResourceUrl;
        state.whipResourceUrl = null;
        state.peerConnection = null;

        if (pc) {
            try { pc.onconnectionstatechange = null; } catch (e) {}
        }

        if (resource) {
            try {
                await fetch(resource, { method: 'DELETE' });
            } catch (e) {
                console.warn('[STUDIO] WHIP DELETE failed:', e);
            }
        }
        if (pc) {
            try {
                pc.getSenders().forEach(s => {
                    try { /* keep camera tracks alive for preview */ } catch (e) {}
                });
                pc.close();
            } catch (e) {}
        }
    }

    let archiveVideoSourceNode = null;

    function initAudioMixing() {
        if (!state.audioContext) {
            const AudioContextClass = window.AudioContext || window.webkitAudioContext;
            state.audioContext = new AudioContextClass();
            state.audioDest = state.audioContext.createMediaStreamDestination();

            // Silent clock so MediaStreamDestination stays active
            try {
                const osc = state.audioContext.createOscillator();
                const silentGain = state.audioContext.createGain();
                silentGain.gain.value = 0;
                osc.connect(silentGain);
                silentGain.connect(state.audioDest);
                osc.start();
            } catch (e) {
                console.warn('[STUDIO] Failed to start silent clock oscillator:', e);
            }
        }
        
        if (state.audioContext.state === 'suspended') {
            state.audioContext.resume().catch(() => {});
        }
        
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
        
        if (!archiveVideoSourceNode) {
            try {
                archiveVideoSourceNode = state.audioContext.createMediaElementSource(archiveVideo);
                state.videoGainNode = state.audioContext.createGain();
                const webSlider = document.getElementById('webVolumeSlider');
                state.videoGainNode.gain.value = webSlider ? parseFloat(webSlider.value || 0.8) : 0.8;
                
                archiveVideoSourceNode.connect(state.videoGainNode);
                state.videoGainNode.connect(state.audioDest);
            } catch(e) {
                console.warn('VOD audio element connection warning:', e);
            }
        }
    }

    window.updateMicVolume = (val) => {
        if (state.micGainNode && state.audioContext) {
            state.micGainNode.gain.setValueAtTime(parseFloat(val), state.audioContext.currentTime);
        }
        const el = document.getElementById('micVolumeVal');
        if (el) el.textContent = Math.round(val * 100) + '%';
    };

    window.updateWebcamVolume = (val) => {
        const el = document.getElementById('webVolumeVal');
        if (el) el.textContent = Math.round(val * 100) + '%';
    };

