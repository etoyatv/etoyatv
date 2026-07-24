/* === 07-overlays-draw.js (lines 1230-1506) === */
    // ----------------------------------------------------
    // Intro (Заставка) Animations & Styles
    // ----------------------------------------------------
    function drawAnimatedIntro(ctx, intro, time) {
        const width = 1280;
        const height = 720;

        if (intro.style === 'gradient-pulse') {
            // Animating shifting gradient angle
            const angleShift = time * 0.4;
            const x1 = width / 2 + Math.cos(angleShift) * width / 2;
            const y1 = height / 2 + Math.sin(angleShift) * height / 2;
            const x2 = width / 2 - Math.cos(angleShift) * width / 2;
            const y2 = height / 2 - Math.sin(angleShift) * height / 2;
            
            const grad = ctx.createLinearGradient(x1, y1, x2, y2);
            grad.addColorStop(0, intro.bgColor1);
            grad.addColorStop(1, intro.bgColor2);
            ctx.fillStyle = grad;
            ctx.fillRect(0, 0, width, height);
            
        } else if (intro.style === 'cosmic-glow') {
            // Draw dark background
            ctx.fillStyle = '#0f0c1b';
            ctx.fillRect(0, 0, width, height);
            
            // Draw floating glowing cosmic orbs
            ctx.save();
            ctx.globalCompositeOperation = 'screen';
            for (let i = 0; i < 6; i++) {
                const px = (width / 2) + Math.cos(time * 0.35 + i) * (width * 0.35);
                const py = (height / 2) + Math.sin(time * 0.45 + i * 2) * (height * 0.32);
                const size = 180 + Math.sin(time * 0.6 + i) * 60;
                
                const bubbleGrad = ctx.createRadialGradient(px, py, 0, px, py, size);
                bubbleGrad.addColorStop(0, intro.bgColor1 + '66'); // Semi-transparent color
                bubbleGrad.addColorStop(0.5, intro.bgColor2 + '22');
                bubbleGrad.addColorStop(1, 'transparent');
                
                ctx.fillStyle = bubbleGrad;
                ctx.beginPath();
                ctx.arc(px, py, size, 0, Math.PI * 2);
                ctx.fill();
            }
            ctx.restore();
            
        } else if (intro.style === 'retro-wave') {
            // Draw sunset synthwave sky gradient
            const skyGrad = ctx.createLinearGradient(0, 0, 0, height);
            skyGrad.addColorStop(0, '#0c021f');
            skyGrad.addColorStop(0.5, intro.bgColor1);
            skyGrad.addColorStop(1, intro.bgColor2);
            ctx.fillStyle = skyGrad;
            ctx.fillRect(0, 0, width, height);
            
            // Receding grid lines animation
            ctx.save();
            ctx.strokeStyle = 'rgba(255, 0, 127, 0.25)';
            ctx.lineWidth = 2;
            const horizon = height * 0.58;
            
            // Receding horizontal lines
            const gridSpeed = (time * 60) % 30;
            for (let y = horizon; y < height; y += 15) {
                const dy = y + gridSpeed * ((y - horizon) / (height - horizon));
                ctx.beginPath();
                ctx.moveTo(0, dy);
                ctx.lineTo(width, dy);
                ctx.stroke();
            }
            // Radiating vertical lines
            for (let x = -width; x < width * 2; x += 80) {
                ctx.beginPath();
                ctx.moveTo(width / 2, horizon);
                ctx.lineTo(x, height);
                ctx.stroke();
            }
            ctx.restore();
            
        } else {
            // Minimal simple gradient
            const grad = ctx.createLinearGradient(0, 0, width, height);
            grad.addColorStop(0, intro.bgColor1);
            grad.addColorStop(1, intro.bgColor2);
            ctx.fillStyle = grad;
            ctx.fillRect(0, 0, width, height);
        }

        // Draw animated texts (Pulsing float y offset)
        const floatY = Math.sin(time * 2.5) * 8;
        
        // Text 1
        ctx.save();
        ctx.fillStyle = intro.color1;
        ctx.font = 'bold 54px Tahoma, Arial';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.shadowColor = intro.color1;
        ctx.shadowBlur = 15;
        ctx.fillText(intro.text1, width / 2, height / 2 - 35 + floatY);
        ctx.restore();
        
        // Text 2
        ctx.save();
        ctx.fillStyle = intro.color2;
        ctx.font = 'bold 22px Tahoma, Arial';
        ctx.textAlign = 'center';
        ctx.shadowColor = intro.color2;
        ctx.shadowBlur = 5;
        ctx.fillText(intro.text2, width / 2, height / 2 + 35);
        ctx.restore();
    }

    // ----------------------------------------------------
    // Bumper (Отбивка) Animations & Styles
    // ----------------------------------------------------
    function drawBumperOverlay(ctx, bumper, time) {
        const h = 80;
        const y = 550;
        
        // Calculate slide-in transition offset
        let progress = 1;
        if (bumper.activatedAt) {
            const elapsed = (Date.now() - bumper.activatedAt) / 1000;
            progress = Math.min(1, elapsed / 0.4); // 0.4 seconds animation
            progress = 1 - Math.pow(1 - progress, 3); // Cubic ease-out
        }
        
        const x = -500 + (500 + 50) * progress; // Slide from -500 to 50
        
        ctx.save();
        
        if (bumper.style === 'glass') {
            // Glassmorphic panel with neon border
            ctx.fillStyle = 'rgba(20, 20, 20, 0.75)';
            ctx.strokeStyle = bumper.bgColor1;
            ctx.lineWidth = 3;
            ctx.shadowColor = bumper.bgColor1;
            ctx.shadowBlur = 10;
            
            ctx.beginPath();
            ctx.roundRect(x, y, 480, h, 8);
            ctx.fill();
            ctx.stroke();
            ctx.shadowBlur = 0; // Reset shadows
            
        } else if (bumper.style === 'shine') {
            // Standard ribbons
            drawClassicRibbons(ctx, x, y, h, bumper.bgColor1, bumper.bgColor2);
            
            // Sweep laser light effect
            const cycle = (time * 0.7) % 1; // 1 sweep every 1.4 seconds
            const sweepX = x + cycle * 520 - 50;
            
            ctx.save();
            // Clip to ribbon zone
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
            
        } else if (bumper.style === 'slide') {
            // Standard Ribbons with simple entry slide
            drawClassicRibbons(ctx, x, y, h, bumper.bgColor1, bumper.bgColor2);
        } else {
            // Standard - standard ribbons with no special effects
            drawClassicRibbons(ctx, x, y, h, bumper.bgColor1, bumper.bgColor2);
        }

        // Draw Texts
        ctx.fillStyle = bumper.color1;
        ctx.font = 'bold 22px Arial, sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText(bumper.text1, x + 25, y + 14);
        
        ctx.fillStyle = bumper.color2;
        ctx.font = '14px Arial, sans-serif';
        ctx.fillText(bumper.text2, x + 25, y + 46);
        
        ctx.restore();
    }

    function drawClassicRibbons(ctx, x, y, h, bg1, bg2) {
        // Ribbon 1 (Background)
        ctx.fillStyle = bg1;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + 500, y);
        ctx.lineTo(x + 470, y + h);
        ctx.lineTo(x, y + h);
        ctx.closePath();
        ctx.fill();
        
        // Ribbon 2 (Accent)
        ctx.fillStyle = bg2;
        ctx.beginPath();
        ctx.moveTo(x + 5, y + 5);
        ctx.lineTo(x + 490, y + 5);
        ctx.lineTo(x + 465, y + h - 5);
        ctx.lineTo(x + 5, y + h - 5);
        ctx.closePath();
        ctx.fill();
    }

    // ----------------------------------------------------
    // Ticker (Бегущая строка) Animations & Styles
    // ----------------------------------------------------
    function drawTickerOverlay(ctx, ticker, time) {
        const h = 40;
        const y = 680;
        const speed = parseInt(ticker.speed || 2);
        
        ctx.save();
        
        // Background banner
        ctx.fillStyle = ticker.bgColor;
        ctx.fillRect(0, y, 1280, h);
        
        // Ticker Text Style
        ctx.font = 'bold 16px Arial, sans-serif';
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'left';
        
        if (ticker.style === 'pulse-color') {
            // Pulse hues dynamically
            const hue = (time * 120) % 360;
            ctx.fillStyle = `hsl(${hue}, 100%, 75%)`;
        } else {
            ctx.fillStyle = ticker.color;
        }
        
        // Measure text width
        const textWidth = ctx.measureText(ticker.text).width;
        
        // Scroll speed calculation based on elapsed time to be frame-rate independent
        const activatedAt = ticker.activatedAt || 0;
        const elapsed = (Date.now() - activatedAt) / 1000;
        const pixelsPerSecond = speed * 60; 
        const totalDistance = 1280 + textWidth;
        const currentDistance = (elapsed * pixelsPerSecond) % totalDistance;
        const offset = 1280 - currentDistance;
        
        // Draw main scrolling text
        ctx.fillText(ticker.text, offset, y + h / 2);
        
        // If gradient fade is enabled, overlay edge transparency gradients
        if (ticker.style === 'gradient-fade') {
            // Left fade gradient
            const leftFade = ctx.createLinearGradient(0, y, 80, y);
            leftFade.addColorStop(0, ticker.bgColor);
            leftFade.addColorStop(1, 'transparent');
            ctx.fillStyle = leftFade;
            ctx.fillRect(0, y, 80, h);
            
            // Right fade gradient
            const rightFade = ctx.createLinearGradient(1200, y, 1280, y);
            rightFade.addColorStop(0, 'transparent');
            rightFade.addColorStop(1, ticker.bgColor);
            ctx.fillStyle = rightFade;
            ctx.fillRect(1200, y, 80, h);
        }
        
        ctx.restore();
    }

