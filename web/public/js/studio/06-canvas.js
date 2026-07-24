/* === 06-canvas.js (lines 1091-1229) === */
    // ----------------------------------------------------
    // Canvas Mixer loop (30 FPS)
    // ----------------------------------------------------
    function drawStudioCanvas() {
        if (!document.hidden) {
            requestAnimationFrame(drawStudioCanvas);
        }
        tickStudioCanvas();
    }

    function tickStudioCanvas() {
        const time = Date.now() / 1000;
        
        // 1. Draw Preview Stage
        const activeWin = getActiveWindow();
        renderStage(previewCtx, activeWin.preview, time);
        
        // 2. Draw On-Air Stage (Draw Autopilot/Black Screen if not broadcasting)
        const activeOnAir = getActiveOnAirOverlays();
        if (!state.isStreaming) {
            if (activeOnAir.source === 'intro' && activeOnAir.intro && activeOnAir.intro.active) {
                drawAnimatedIntro(onAirCtx, activeOnAir.intro, time);
            } else {
                drawAutopilotOnAir(onAirCtx);
            }
            // Draw overlays on top of autopilot/intro
            if (activeOnAir.bumper && activeOnAir.bumper.active) {
                drawBumperOverlay(onAirCtx, activeOnAir.bumper, time);
            }
            if (activeOnAir.ticker && activeOnAir.ticker.active) {
                drawTickerOverlay(onAirCtx, activeOnAir.ticker, time);
            }
        } else {
            renderStage(onAirCtx, activeOnAir, time);
        }
    }

    // Background rendering interval to prevent browser throttling from freezing the stream
    let backgroundRenderInterval = null;
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            console.log('[STUDIO] Tab hidden. Enabling background canvas rendering...');
            if (!backgroundRenderInterval) {
                backgroundRenderInterval = setInterval(tickStudioCanvas, 100); // 10 FPS is enough to keep track alive
            }
        } else {
            console.log('[STUDIO] Tab visible. Restoring requestAnimationFrame loop...');
            if (backgroundRenderInterval) {
                clearInterval(backgroundRenderInterval);
                backgroundRenderInterval = null;
            }
            requestAnimationFrame(drawStudioCanvas);
        }
    });

    // Displays the actual stream in the On-Air monitor
    function drawAutopilotOnAir(ctx) {
        const width = 1280;
        const height = 720;
        
        if (autopilotVideo.readyState >= 2 && !autopilotVideo.paused) {
            ctx.drawImage(autopilotVideo, 0, 0, width, height);
        } else {
            // Draw clean black screen fallback
            ctx.fillStyle = '#000000';
            ctx.fillRect(0, 0, width, height);
            
            // Modern pulsing dot layout with glowing outer ring
            const pulse = 0.5 + Math.sin(Date.now() / 400) * 0.4;
            
            // Outer glowing ring
            ctx.save();
            ctx.strokeStyle = `rgba(255, 77, 77, ${1 - pulse})`;
            ctx.lineWidth = 3;
            ctx.beginPath();
            ctx.arc(width / 2, height / 2 - 40, 14 + pulse * 24, 0, Math.PI * 2);
            ctx.stroke();
            
            // Inner solid pulsing circle
            ctx.fillStyle = 'rgba(255, 77, 77, 0.9)';
            ctx.beginPath();
            ctx.arc(width / 2, height / 2 - 40, 14, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
            
            // Legible centered text
            ctx.fillStyle = '#ffffff';
            ctx.font = '24px Arial';
            ctx.textAlign = 'center';
            ctx.fillText('Студия ожидает трансляции', width / 2, height / 2 + 40);
        }
    }

    function renderStage(ctx, stage, time) {
        const width = 1280;
        const height = 720;
        
        // Clear canvas
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, width, height);
        
        // Draw primary source
        if (stage.source === 'webcam') {
            if (localVideo.readyState >= 2) {
                ctx.drawImage(localVideo, 0, 0, width, height);
            } else {
                ctx.fillStyle = '#1c1c1c';
                ctx.fillRect(0, 0, width, height);
                ctx.fillStyle = '#555';
                ctx.font = '24px Arial';
                ctx.textAlign = 'center';
                ctx.fillText('Камера не готова', width / 2, height / 2);
            }
        } else if (stage.source === 'archive') {
            if (archiveVideo.readyState >= 2) {
                ctx.drawImage(archiveVideo, 0, 0, width, height);
            } else {
                ctx.fillStyle = '#1c1c1c';
                ctx.fillRect(0, 0, width, height);
                ctx.fillStyle = '#555';
                ctx.font = '24px Arial';
                ctx.textAlign = 'center';
                ctx.fillText('Загрузка видео из архива...', width / 2, height / 2);
            }
        } else if (stage.source === 'intro') {
            drawAnimatedIntro(ctx, stage.intro, time);
        }
        
        // Draw Bumper overlay
        if (stage.bumper.active) {
            drawBumperOverlay(ctx, stage.bumper, time);
        }
        
        // Draw Ticker overlay
        if (stage.ticker.active) {
            drawTickerOverlay(ctx, stage.ticker, time);
        }
    }

