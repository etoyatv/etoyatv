/* === 09-overlays.js (lines 2742-3109) === */
    // --- Overlays Rendering ---
    const overlaysCanvas = document.getElementById('etoyatv-overlays-canvas');
    if (overlaysCanvas) {
      if (window.etoyatvOverlaysLoopRunning) {
        return;
      }
      window.etoyatvOverlaysLoopRunning = true;

      const overlaysCtx = overlaysCanvas.getContext('2d');
      let overlaysState = {
        source: 'webcam',
        bumper: { active: false },
        intro: { active: false },
        ticker: { active: false }
      };
      let tickerOffset = 1280;

      let rawOverlaysData = null;

      function resolveCurrentOverlays() {
        if (!rawOverlaysData) return overlaysState;
        const isNested = rawOverlaysData.common !== undefined || (rawOverlaysData.bumper === undefined && rawOverlaysData.ticker === undefined);
        if (isNested) {
          const activeStreams = (lastAutopilotData && lastAutopilotData.is_live) ? (lastAutopilotData.active_streams || []) : [];
          if (activeStreams.length <= 1) {
            return rawOverlaysData.common || rawOverlaysData['1'] || overlaysState;
          } else {
            const streamIdx = currentSelectedStreamIndex || 1;
            return rawOverlaysData[streamIdx] || rawOverlaysData.common || overlaysState;
          }
        }
        return rawOverlaysData;
      }

      socket.on('player_update_overlays', (data) => {
        rawOverlaysData = data;
        window.updateActiveOverlayState();
      });

      window.updateActiveOverlayState = function() {
        const resolved = resolveCurrentOverlays();
        if (resolved) {
          const oldTickerActive = overlaysState.ticker?.active;
          overlaysState = resolved;

          if (overlaysState.ticker && overlaysState.ticker.active && !oldTickerActive) {
            tickerOffset = 1280;
          }
          if (overlaysState.bumper?.active || overlaysState.ticker?.active || overlaysState.source === 'intro') {
            overlaysCanvas.style.display = 'block';
          } else {
            overlaysCanvas.style.display = 'none';
            overlaysCtx.clearRect(0, 0, overlaysCanvas.width, overlaysCanvas.height);
          }
        }
      };

      function drawPlayerOverlays() {
        requestAnimationFrame(drawPlayerOverlays);

        const hasActiveOverlays = overlaysState.bumper?.active || overlaysState.ticker?.active || overlaysState.source === 'intro';
        if (!hasActiveOverlays) {
          return;
        }

        // Dynamic resolution mapping for crisp high-DPI rendering
        const rect = overlaysCanvas.getBoundingClientRect();
        const displayWidth = rect.width || 1280;
        const displayHeight = rect.height || 720;
        const dpr = window.devicePixelRatio || 1;
        const targetWidth = Math.round(displayWidth * dpr);
        const targetHeight = Math.round(displayHeight * dpr);

        if (overlaysCanvas.width !== targetWidth || overlaysCanvas.height !== targetHeight) {
          overlaysCanvas.width = targetWidth;
          overlaysCanvas.height = targetHeight;
        }

        const ctx = overlaysCtx;
        const time = Date.now() / 1000;

        ctx.clearRect(0, 0, overlaysCanvas.width, overlaysCanvas.height);

        // Map drawing coordinate system to virtual 1280x720 space
        ctx.save();
        ctx.scale(overlaysCanvas.width / 1280, overlaysCanvas.height / 720);

        if (overlaysState.source === 'intro' && overlaysState.intro?.active) {
          drawPlayerAnimatedIntro(ctx, overlaysState.intro, time);
        }

        if (overlaysState.bumper?.active) {
          drawPlayerBumperOverlay(ctx, overlaysState.bumper, time);
        }

        if (overlaysState.ticker?.active) {
          drawPlayerTickerOverlay(ctx, overlaysState.ticker, time);
        }

        ctx.restore();
      }

      function drawPlayerAnimatedIntro(ctx, intro, time) {
        const width = 1280;
        const height = 720;

        if (intro.style === 'gradient-pulse') {
          const angleShift = time * 0.4;
          const x1 = width / 2 + Math.cos(angleShift) * width / 2;
          const y1 = height / 2 + Math.sin(angleShift) * height / 2;
          const x2 = width / 2 - Math.cos(angleShift) * width / 2;
          const y2 = height / 2 - Math.sin(angleShift) * height / 2;
          
          const grad = ctx.createLinearGradient(x1, y1, x2, y2);
          grad.addColorStop(0, intro.bgColor1 || '#1f1c2c');
          grad.addColorStop(1, intro.bgColor2 || '#928dab');
          ctx.fillStyle = grad;
          ctx.fillRect(0, 0, width, height);
          
        } else if (intro.style === 'cosmic-glow') {
          ctx.fillStyle = '#0f0c1b';
          ctx.fillRect(0, 0, width, height);
          
          ctx.save();
          ctx.globalCompositeOperation = 'screen';
          for (let i = 0; i < 6; i++) {
              const px = (width / 2) + Math.cos(time * 0.35 + i) * (width * 0.35);
              const py = (height / 2) + Math.sin(time * 0.45 + i * 2) * (height * 0.32);
              const size = 180 + Math.sin(time * 0.6 + i) * 60;
              
              const bubbleGrad = ctx.createRadialGradient(px, py, 0, px, py, size);
              bubbleGrad.addColorStop(0, (intro.bgColor1 || '#1f1c2c') + '66');
              bubbleGrad.addColorStop(0.5, (intro.bgColor2 || '#928dab') + '22');
              bubbleGrad.addColorStop(1, 'transparent');
              
              ctx.fillStyle = bubbleGrad;
              ctx.beginPath();
              ctx.arc(px, py, size, 0, Math.PI * 2);
              ctx.fill();
          }
          ctx.restore();
          
        } else if (intro.style === 'retro-wave') {
          const skyGrad = ctx.createLinearGradient(0, 0, 0, height);
          skyGrad.addColorStop(0, '#0c021f');
          skyGrad.addColorStop(0.5, intro.bgColor1 || '#1f1c2c');
          skyGrad.addColorStop(1, intro.bgColor2 || '#928dab');
          ctx.fillStyle = skyGrad;
          ctx.fillRect(0, 0, width, height);
          
          ctx.save();
          ctx.strokeStyle = 'rgba(255, 0, 127, 0.25)';
          ctx.lineWidth = 2;
          const horizon = height * 0.58;
          
          const gridSpeed = (time * 60) % 30;
          for (let y = horizon; y < height; y += 15) {
              const dy = y + gridSpeed * ((y - horizon) / (height - horizon));
              ctx.beginPath();
              ctx.moveTo(0, dy);
              ctx.lineTo(width, dy);
              ctx.stroke();
          }
          for (let x = -width; x < width * 2; x += 80) {
              ctx.beginPath();
              ctx.moveTo(width / 2, horizon);
              ctx.lineTo(x, height);
              ctx.stroke();
          }
          ctx.restore();
          
        } else {
          const grad = ctx.createLinearGradient(0, 0, width, height);
          grad.addColorStop(0, intro.bgColor1 || '#1f1c2c');
          grad.addColorStop(1, intro.bgColor2 || '#928dab');
          ctx.fillStyle = grad;
          ctx.fillRect(0, 0, width, height);
        }

        const floatY = Math.sin(time * 2.5) * 8;
        
        ctx.save();
        ctx.fillStyle = intro.color1 || '#ffffff';
        ctx.font = 'bold 54px Tahoma, Arial';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.shadowColor = intro.color1 || '#ffffff';
        ctx.shadowBlur = 15;
        ctx.fillText(intro.text1 || '', width / 2, height / 2 - 35 + floatY);
        ctx.restore();
        
        ctx.save();
        ctx.fillStyle = intro.color2 || '#6fdeee';
        ctx.font = 'bold 22px Tahoma, Arial';
        ctx.textAlign = 'center';
        ctx.shadowColor = intro.color2 || '#6fdeee';
        ctx.shadowBlur = 5;
        ctx.fillText(intro.text2 || '', width / 2, height / 2 + 35);
        ctx.restore();
      }

      function drawPlayerBumperOverlay(ctx, bumper, time) {
        const h = 80;
        const y = 550;
        
        let progress = 1;
        if (bumper.activatedAt) {
            const elapsed = (Date.now() - bumper.activatedAt) / 1000;
            progress = Math.min(1, elapsed / 0.4);
            progress = 1 - Math.pow(1 - progress, 3);
        }
        
        const x = -500 + (500 + 50) * progress;
        
        ctx.save();
        
        if (bumper.style === 'glass') {
            ctx.fillStyle = 'rgba(20, 20, 20, 0.75)';
            ctx.strokeStyle = bumper.bgColor1 || '#ff3b30';
            ctx.lineWidth = 3;
            ctx.shadowColor = bumper.bgColor1 || '#ff3b30';
            ctx.shadowBlur = 10;
            
            ctx.beginPath();
            if (typeof ctx.roundRect === 'function') {
                ctx.roundRect(x, y, 480, h, 8);
            } else {
                ctx.rect(x, y, 480, h);
            }
            ctx.fill();
            ctx.stroke();
            ctx.shadowBlur = 0;
            
        } else if (bumper.style === 'shine') {
            drawPlayerClassicRibbons(ctx, x, y, h, bumper.bgColor1 || '#ff3b30', bumper.bgColor2 || '#007af5');
            
            const cycle = (time * 0.7) % 1;
            const sweepX = x + cycle * 520 - 50;
            
            ctx.save();
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
            
        } else {
            drawPlayerClassicRibbons(ctx, x, y, h, bumper.bgColor1 || '#ff3b30', bumper.bgColor2 || '#007af5');
        }

        ctx.fillStyle = bumper.color1 || '#ffffff';
        ctx.font = 'bold 22px Arial, sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText(bumper.text1 || '', x + 25, y + 14);
        
        ctx.fillStyle = bumper.color2 || '#6fdeee';
        ctx.font = '14px Arial, sans-serif';
        ctx.fillText(bumper.text2 || '', x + 25, y + 46);
        
        ctx.restore();
      }

      function drawPlayerClassicRibbons(ctx, x, y, h, bg1, bg2) {
        ctx.fillStyle = bg1;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + 500, y);
        ctx.lineTo(x + 470, y + h);
        ctx.lineTo(x, y + h);
        ctx.closePath();
        ctx.fill();
        
        ctx.fillStyle = bg2;
        ctx.beginPath();
        ctx.moveTo(x + 5, y + 5);
        ctx.lineTo(x + 490, y + 5);
        ctx.lineTo(x + 465, y + h - 5);
        ctx.lineTo(x + 5, y + h - 5);
        ctx.closePath();
        ctx.fill();
      }

      function drawPlayerTickerOverlay(ctx, ticker, time) {
        const h = 40;
        const y = 680;
        const speed = parseInt(ticker.speed || 2);
        
        ctx.save();
        
        ctx.fillStyle = ticker.bgColor || '#007af5';
        ctx.fillRect(0, y, 1280, h);
        
        ctx.font = 'bold 16px Arial, sans-serif';
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'left';
        
        if (ticker.style === 'pulse-color') {
            const hue = (time * 120) % 360;
            ctx.fillStyle = `hsl(${hue}, 100%, 75%)`;
        } else {
            ctx.fillStyle = ticker.color || '#ffffff';
        }
        
        const textStr = ticker.text || '';
        const textWidth = ctx.measureText(textStr).width;
        
        // Scroll speed calculation based on elapsed time to be frame-rate independent
        const activatedAt = ticker.activatedAt || 0;
        const elapsed = (Date.now() - activatedAt) / 1000;
        const pixelsPerSecond = speed * 60; 
        const totalDistance = 1280 + textWidth;
        const currentDistance = (elapsed * pixelsPerSecond) % totalDistance;
        const offset = 1280 - currentDistance;
        
        ctx.fillText(textStr, offset, y + h / 2);
        
        if (ticker.style === 'gradient-fade') {
            const leftFade = ctx.createLinearGradient(0, y, 80, y);
            leftFade.addColorStop(0, ticker.bgColor || '#007af5');
            leftFade.addColorStop(1, 'transparent');
            ctx.fillStyle = leftFade;
            ctx.fillRect(0, y, 80, h);
            
            const rightFade = ctx.createLinearGradient(1200, y, 1280, y);
            rightFade.addColorStop(0, 'transparent');
            rightFade.addColorStop(1, ticker.bgColor || '#007af5');
            ctx.fillStyle = rightFade;
            ctx.fillRect(1200, y, 80, h);
        }
        
        ctx.restore();
      }

      drawPlayerOverlays();
    }
  }
});

window.bookmark = function (link) {
  const url = window.location.href;
  const title = document.title;
  if (window.sidebar && window.sidebar.addPanel) {
    window.sidebar.addPanel(title, url, "");
  } else if (window.external && ('AddFavorite' in window.external)) {
    window.external.AddFavorite(url, title);
  } else if (window.opera && window.print) {
    link.setAttribute('rel', 'sidebar');
    link.setAttribute('href', url);
    link.setAttribute('title', title);
    return true;
  } else {
    alert('Нажмите ' + (navigator.userAgent.toLowerCase().indexOf('mac') != -1 ? 'Cmd' : 'Ctrl') + '+D чтобы добавить страницу в закладки.');
  }
  return false;
};

// User context menu logic
