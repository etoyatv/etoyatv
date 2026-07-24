/* === 09-whip.js (lines 1813-1952) === */
    // ----------------------------------------------------
    // Broadcast via WHIP → MediaMTX (browser encodes, server remux only)
    // ----------------------------------------------------
    window.toggleBroadcast = async () => {
        // Stop if connecting, publishing, or UI still shows live
        if (state.isConnecting || state.isStreaming || btnToggleBroadcast.classList.contains('streaming')) {
            await stopBroadcast();
            return;
        }

        if (!window.STREAM_KEY || !window.CHANNEL_SHORTNAME) {
            alert('Нет ключа трансляции. Обновите страницу.');
            return;
        }

        const publishId = ++state.publishId;
        state.isConnecting = true;
        state.isStreaming = false;
        btnToggleBroadcast.textContent = 'Установка соединения...';
        btnToggleBroadcast.classList.remove('streaming');
        btnToggleBroadcast.classList.add('connecting');
        btnToggleBroadcast.disabled = true;

        if (state.connectionTimeout) clearTimeout(state.connectionTimeout);
        state.connectionTimeout = setTimeout(() => {
            if (state.publishId !== publishId) return;
            if (state.isConnecting) {
                console.error('[STUDIO] WHIP connection timeout');
                showToast('Таймаут подключения к эфиру', 'error');
                stopBroadcast();
            }
        }, 20000);

        try {
            await startWhipPublish();
            if (state.publishId !== publishId) {
                await stopWhipPublish();
                return;
            }

            // MediaMTX auth emits stream_started; fallback UI if socket is slow
            setTimeout(() => {
                if (state.publishId !== publishId) return;
                if (!state.peerConnection) return;
                if (state.isStreaming) return;

                state.isConnecting = false;
                if (state.connectionTimeout) {
                    clearTimeout(state.connectionTimeout);
                    state.connectionTimeout = null;
                }
                state.isStreaming = true;
                btnToggleBroadcast.disabled = false;
                btnToggleBroadcast.classList.remove('connecting');
                btnToggleBroadcast.classList.add('streaming');
                btnToggleBroadcast.textContent = 'ОСТАНОВИТЬ ТРАНСЛЯЦИЮ';
                onairDot.classList.add('live');
                onairStatusText.textContent = getActiveSourceLabel(getActiveOnAirOverlays());
                onairStatusText.style.color = '#ff4d4d';
                const titleContainer = document.getElementById('studio-live-title-container');
                if (titleContainer) titleContainer.style.display = 'inline-flex';
                const recordBtn = document.getElementById('btn-record-stream');
                if (recordBtn) recordBtn.style.display = 'inline-block';
            }, 2500);
        } catch (e) {
            if (state.publishId !== publishId) return;
            console.error('[STUDIO] WHIP publish failed:', e);
            showToast('Не удалось начать эфир: ' + (e.message || e), 'error');
            await stopBroadcast();
        }
    };

    async function stopBroadcast() {
        state.publishId += 1;

        if (state.chunkInterval) {
            clearInterval(state.chunkInterval);
            state.chunkInterval = null;
        }

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

        await stopWhipPublish();
        
        // Remove active overlays from air and sync to viewers
        const keysToReset = ['common', '1', '2', '3'];
        keysToReset.forEach(k => {
            if (state.onAir[k]) {
                state.onAir[k].bumper.active = false;
                state.onAir[k].intro.active = false;
                state.onAir[k].ticker.active = false;
                state.onAir[k].source = 'webcam';
            }
        });
        state.onAir.bumper.active = false;
        state.onAir.intro.active = false;
        state.onAir.ticker.active = false;
        state.onAir.source = 'webcam';
        syncOverlaysToPlayer();
        
        // Re-trigger/play autopilot stream monitor
        setTimeout(checkAutopilotStatus, 1500);
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

