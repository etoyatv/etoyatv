/* === 05-archive.js (lines 1054-1090) === */
    // ----------------------------------------------------
    // Media Archive VOD loading
    // ----------------------------------------------------
    window.loadArchiveVideo = (hlsUrl, id, element) => {
        document.querySelectorAll('.archive-item').forEach(item => item.classList.remove('active'));
        if (element) element.classList.add('active');
        
        archiveVideo.muted = true;
        if (window.Hls && Hls.isSupported() && hlsUrl.endsWith('.m3u8')) {
            if (archiveHls) {
                try { archiveHls.destroy(); } catch(e){}
            }
            archiveHls = new Hls({
                debug: false,
                enableWorker: true
            });
            archiveHls.loadSource(hlsUrl);
            archiveHls.attachMedia(archiveVideo);
            archiveHls.on(Hls.Events.MANIFEST_PARSED, () => {
                archiveVideo.muted = true;
                archiveVideo.play().catch(() => {});
            });
        } else {
            archiveVideo.src = hlsUrl;
            archiveVideo.crossOrigin = 'anonymous';
            archiveVideo.muted = true;
            archiveVideo.load();
            archiveVideo.play().catch(() => {});
        }
        
        const activeWin = getActiveWindow();
        activeWin.preview.source = 'archive';
        activeWin.preview.archiveId = id;
        
        updatePreviewOverlaysList();
    };

