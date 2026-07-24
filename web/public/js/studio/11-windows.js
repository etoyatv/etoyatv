/* === 11-windows.js (lines 2247-2410) === */
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

