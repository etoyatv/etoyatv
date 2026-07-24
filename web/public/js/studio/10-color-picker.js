/* === 10-color-picker.js (lines 1953-2246) === */
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

