/* === 03-socket.js (lines 546-597) === */
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

        // WebRTC stream is independent of Socket.io signaling state.
        if (state.isStreaming) {
            console.log('[STUDIO] Reconnected socket.io. WebRTC stream continues unaffected.');
        }
    });

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
            onairStatusText.textContent = getActiveSourceLabel(getActiveOnAirOverlays());
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

