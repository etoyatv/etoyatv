/* === 04-chat-input.js (lines 1169-1507) === */
  // --- Chat Input & Color ---
  const chatColorPalette = document.getElementById('chat-color-palette');

  if (chatColorBtn && chatColorPalette) {
    const spectrumCanvas = chatColorPalette.querySelector('.chat-color-spectrum');
    const sliderCanvas = chatColorPalette.querySelector('.chat-color-slider');

    function rgbToHsv(r, g, b) {
      r /= 255; g /= 255; b /= 255;
      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      let h, s, v = max;
      const d = max - min;
      s = max === 0 ? 0 : d / max;
      if (max === min) {
        h = 0;
      } else {
        switch (max) {
          case r: h = (g - b) / d + (g < b ? 6 : 0); break;
          case g: h = (b - r) / d + 2; break;
          case b: h = (r - g) / d + 4; break;
        }
        h /= 6;
      }
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

    function makeColorReadable(hex) {
      if (!hex || typeof hex !== 'string') return '#3b9cd9';
      let cleanHex = hex.replace('#', '');
      if (cleanHex.length === 3) {
        cleanHex = cleanHex[0] + cleanHex[0] + cleanHex[1] + cleanHex[1] + cleanHex[2] + cleanHex[2];
      }
      if (cleanHex.length !== 6) return '#3b9cd9';
      let r = parseInt(cleanHex.substring(0, 2), 16);
      let g = parseInt(cleanHex.substring(2, 4), 16);
      let b = parseInt(cleanHex.substring(4, 6), 16);
      if (isNaN(r) || isNaN(g) || isNaN(b)) return '#3b9cd9';
      if (r === 0 && g === 0 && b === 0) {
        r = 100; g = 100; b = 100;
      }
      let brightness = 0.299 * r + 0.587 * g + 0.114 * b;
      let iterations = 0;
      while (brightness < 70 && iterations < 15) {
        r = Math.round(r + (255 - r) * 0.2);
        g = Math.round(g + (255 - g) * 0.2);
        b = Math.round(b + (255 - b) * 0.2);
        brightness = 0.299 * r + 0.587 * g + 0.114 * b;
        iterations++;
      }
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

    function render() {
      if (spectrumCanvas && sliderCanvas) {
        drawSpectrum(spectrumCanvas, hueVal, satVal);
        drawSlider(sliderCanvas, hueVal, satVal, valVal);
      }
    }

    function triggerChange() {
      const rgb = hsvToRgb(hueVal, satVal, valVal);
      let hex = rgbToHex(rgb[0], rgb[1], rgb[2]);
      hex = makeColorReadable(hex);
      if (chatColorPicker) chatColorPicker.value = hex;
      chatColorBtn.style.backgroundColor = hex;
      localStorage.setItem('etoyatv_chat_color', hex);
      socket.emit('update_chat_color', { color: hex });
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
      render();
      triggerChange();
    }

    function handleSliderMove(e) {
      if (!sliderCanvas) return;
      const rect = sliderCanvas.getBoundingClientRect();
      let y = e.clientY - rect.top;
      y = Math.max(0, Math.min(y, rect.height));
      valVal = 1 - (y / rect.height);
      render();
      triggerChange();
    }

    if (spectrumCanvas) {
      spectrumCanvas.addEventListener('mousedown', (e) => {
        isDraggingSpectrum = true;
        handleSpectrumMove(e);
      });
    }

    if (sliderCanvas) {
      sliderCanvas.addEventListener('mousedown', (e) => {
        isDraggingSlider = true;
        handleSliderMove(e);
      });
    }

    document.addEventListener('mousemove', (e) => {
      if (isDraggingSpectrum) handleSpectrumMove(e);
      if (isDraggingSlider) handleSliderMove(e);
    });

    document.addEventListener('mouseup', () => {
      isDraggingSpectrum = false;
      isDraggingSlider = false;
    });

    // Touch support
    function handleSpectrumTouch(e) {
      if (e.touches.length === 0 || !spectrumCanvas) return;
      const touch = e.touches[0];
      const rect = spectrumCanvas.getBoundingClientRect();
      let x = touch.clientX - rect.left;
      let y = touch.clientY - rect.top;
      x = Math.max(0, Math.min(x, rect.width));
      y = Math.max(0, Math.min(y, rect.height));
      hueVal = x / rect.width;
      satVal = 1 - (y / rect.height);
      render();
      triggerChange();
    }

    function handleSliderTouch(e) {
      if (e.touches.length === 0 || !sliderCanvas) return;
      const touch = e.touches[0];
      const rect = sliderCanvas.getBoundingClientRect();
      let y = touch.clientY - rect.top;
      y = Math.max(0, Math.min(y, rect.height));
      valVal = 1 - (y / rect.height);
      render();
      triggerChange();
    }

    if (spectrumCanvas) {
      spectrumCanvas.addEventListener('touchstart', (e) => {
        e.preventDefault();
        isDraggingSpectrum = true;
        handleSpectrumTouch(e);
      });
      spectrumCanvas.addEventListener('touchmove', (e) => {
        e.preventDefault();
        if (isDraggingSpectrum) handleSpectrumTouch(e);
      });
    }

    if (sliderCanvas) {
      sliderCanvas.addEventListener('touchstart', (e) => {
        e.preventDefault();
        isDraggingSlider = true;
        handleSliderTouch(e);
      });
      sliderCanvas.addEventListener('touchmove', (e) => {
        e.preventDefault();
        if (isDraggingSlider) handleSliderTouch(e);
      });
    }

    chatColorBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      chatColorPalette.style.display = chatColorPalette.style.display === 'none' ? 'flex' : 'none';
      if (chatColorPalette.style.display === 'flex') {
        const chatMenu = document.getElementById('chat-menu');
        if (chatMenu) chatMenu.style.display = 'none';
        const chatEmojiPanel = document.getElementById('chat-emoji-panel');
        if (chatEmojiPanel) chatEmojiPanel.style.display = 'none';
        if (chatColorPicker && chatColorPicker.value) {
          updateFromHex(chatColorPicker.value);
        }
        render();
      }
    });

    document.addEventListener('click', (e) => {
      if (!chatColorPalette.contains(e.target) && e.target !== chatColorBtn) {
        chatColorPalette.style.display = 'none';
      }
      const chatEmojiPanel = document.getElementById('chat-emoji-panel');
      const chatEmojiBtn = document.getElementById('chat-emoji-btn');
      if (chatEmojiPanel && chatEmojiPanel.style.display === 'flex' && !chatEmojiPanel.contains(e.target) && e.target !== chatEmojiBtn) {
        chatEmojiPanel.style.display = 'none';
      }
    });

    // Initialize values
    if (chatColorPicker && chatColorPicker.value) {
      updateFromHex(chatColorPicker.value);
    }
    render();
  }

  function sendChatMessage() {
    const message = chatInput.value.trim();
    if (message) {
      const chatColorPicker = document.getElementById('chat-color-picker');
      let color = chatColorPicker ? chatColorPicker.value : '#3b9cd9';
      if (!color.startsWith('#')) color = '#' + color;
      const isChatWidgetLocal = document.getElementById('chat-tabs-container') !== null;
      let payload = {
        channelId: window.CHANNEL_ID,
        message: message,
        color: color
      };
      if (isChatWidgetLocal && currentSelectedChatStreamIndex !== null) {
        payload.streamIndex = currentSelectedChatStreamIndex;
      }
      socket.emit('send_message', payload);
      chatInput.value = '';
    }
  }

  chatInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      sendChatMessage();
    }
  });

  const btnChatSubmit = document.getElementById('btn-chat-submit');
  if (btnChatSubmit) {
    btnChatSubmit.addEventListener('click', sendChatMessage);
  }



