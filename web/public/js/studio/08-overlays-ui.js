/* === 08-overlays-ui.js (lines 1507-1812) === */
    // ----------------------------------------------------
    // Preview Switcher & Transition to Air
    // ----------------------------------------------------
    window.transitionPreviewToOnAir = () => {
        // Sync active preview config to Air
        const activeWin = getActiveWindow();
        const activeOnAir = getActiveOnAirOverlays();
        const copy = JSON.parse(JSON.stringify(activeWin.preview));
        
        activeOnAir.source = copy.source;
        activeOnAir.bumper = copy.bumper;
        activeOnAir.intro = copy.intro;
        activeOnAir.ticker = copy.ticker;
        
        // Expose new activation timestamps to trigger entrance animations
        activeOnAir.bumper.activatedAt = Date.now();
        
        syncFlatOnAirKeys(activeOnAir);
        
        if (state.isStreaming) {
            onairStatusText.textContent = getActiveSourceLabel(activeOnAir);
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

        const activeOnAir = getActiveOnAirOverlays();
        activeOnAir.bumper.text1 = document.getElementById('bumperText1').value;
        activeOnAir.bumper.text2 = document.getElementById('bumperText2').value;
        activeOnAir.bumper.color1 = document.getElementById('bumperColor1').value;
        activeOnAir.bumper.color2 = document.getElementById('bumperColor2').value;
        activeOnAir.bumper.bgColor1 = document.getElementById('bumperBgColor1').value;
        activeOnAir.bumper.bgColor2 = document.getElementById('bumperBgColor2').value;
        activeOnAir.bumper.style = document.getElementById('bumperStyle').value;
        activeOnAir.bumper.active = true;
        activeOnAir.bumper.activatedAt = Date.now();
        
        syncFlatOnAirKeys(activeOnAir);
        syncOverlaysToPlayer();
    };

    window.removeBumperFromAir = () => {
        const activeOnAir = getActiveOnAirOverlays();
        activeOnAir.bumper.active = false;
        syncFlatOnAirKeys(activeOnAir);
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

        const activeOnAir = getActiveOnAirOverlays();
        activeOnAir.intro.text1 = document.getElementById('introText1').value;
        activeOnAir.intro.text2 = document.getElementById('introText2').value;
        activeOnAir.intro.color1 = document.getElementById('introColor1').value;
        activeOnAir.intro.color2 = document.getElementById('introColor2').value;
        activeOnAir.intro.bgColor1 = document.getElementById('introBgColor1').value;
        activeOnAir.intro.bgColor2 = document.getElementById('introBgColor2').value;
        activeOnAir.intro.style = document.getElementById('introStyle').value;
        activeOnAir.source = 'intro';
        activeOnAir.intro.active = true;
        
        syncFlatOnAirKeys(activeOnAir);
        syncOverlaysToPlayer();
    };

    window.removeIntroFromAir = () => {
        const activeOnAir = getActiveOnAirOverlays();
        activeOnAir.intro.active = false;
        activeOnAir.source = 'webcam';
        syncFlatOnAirKeys(activeOnAir);
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

        const activeOnAir = getActiveOnAirOverlays();
        activeOnAir.ticker.text = document.getElementById('tickerText').value;
        activeOnAir.ticker.color = document.getElementById('tickerColor').value;
        activeOnAir.ticker.bgColor = document.getElementById('tickerBgColor').value;
        activeOnAir.ticker.style = document.getElementById('tickerStyle').value;
        activeOnAir.ticker.speed = parseInt(document.getElementById('tickerSpeed').value || 2);
        activeOnAir.ticker.active = true;
        activeOnAir.ticker.activatedAt = Date.now();
        
        syncFlatOnAirKeys(activeOnAir);
        syncOverlaysToPlayer();
    };

    window.removeTickerFromAir = () => {
        const activeOnAir = getActiveOnAirOverlays();
        activeOnAir.ticker.active = false;
        syncFlatOnAirKeys(activeOnAir);
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
        const labelSpan = document.createElement('span');
        labelSpan.className = 'applied-element-label';
        labelSpan.textContent = label;
        const removeSpan = document.createElement('span');
        removeSpan.className = 'applied-element-remove';
        removeSpan.textContent = '✕';
        removeSpan.style.cursor = 'pointer';
        removeSpan.addEventListener('click', () => window.removePreviewOverlay(type));
        div.appendChild(labelSpan);
        div.appendChild(removeSpan);
        previewOverlaysList.appendChild(div);
    }

