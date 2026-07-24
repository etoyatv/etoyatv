/* === 12-startup-recording.js (lines 2411-2582) === */
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
        
        const maxLimitSeconds = (window.CHANNEL_IS_VERIFIED || window.CHANNEL_IS_PREMIUM) ? 3600 : 300;
        const maxLimitMinutesText = maxLimitSeconds === 3600 ? '1 час' : '5 минут';

        if (recTimerInterval) clearInterval(recTimerInterval);
        recTimerInterval = setInterval(() => {
            recSecondsElapsed++;
            updateRecTimerDisplay();
            if (recSecondsElapsed >= maxLimitSeconds) {
                stopLocalRecTimer();
                showToast(`Запись завершена автоматически (лимит ${maxLimitMinutesText})`, 'success');
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
                        const maxLimitSeconds = (window.CHANNEL_IS_VERIFIED || window.CHANNEL_IS_PREMIUM) ? 3600 : 300;
                        const maxLimitMinutesText = maxLimitSeconds === 3600 ? '1 час' : '5 минут';
                        startLocalRecTimer(0);
                        showToast(`Запись эфира запущена (максимум ${maxLimitMinutesText})`, 'success');
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
