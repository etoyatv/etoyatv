/* === 05-video-controls.js (lines 1508-1634) === */
  // --- Video Controls ---
  function playOrResume() {
    enableAutoplay = true; // User interacted
    if (video && video.paused) {
      if (currentlyPlayingLive) {
        if (lastAutopilotData && lastAutopilotData.rtmp_url) {
          let streamUrl = getStreamUrl(lastAutopilotData.rtmp_url, currentSelectedStreamIndex, lastAutopilotData.shortname);
          loadStream(streamUrl, true);
        } else {
          video.play().catch(e => { console.log('Synchronous play failed, retrying:', e); });
        }
      } else {
        video.play().catch(e => { console.log('Play failed:', e); });
      }
      btnPlayPause.innerHTML = svgPause;
      if (window.CHANNEL_ID && typeof fetchAutopilotStatus === 'function') {
        setTimeout(() => fetchAutopilotStatus(false), 500);
      }
    } else if (video) {
      video.pause();
      btnPlayPause.innerHTML = svgPlay;
    }
  }

  // Click video to play/pause
  if (video) {
    video.addEventListener('click', playOrResume);
    video.addEventListener('play', () => btnPlayPause.innerHTML = svgPause);
    video.addEventListener('pause', () => btnPlayPause.innerHTML = svgPlay);
  }

  btnPlayPause.addEventListener('click', playOrResume);

  // Volume control
  const volumeSlider = document.getElementById('volume-slider');

  let savedVolume = localStorage.getItem('etoyatv_volume');
  let savedMuted = localStorage.getItem('etoyatv_muted') === 'true';

  const initVol = savedVolume !== null ? parseFloat(savedVolume) : 1;
  if (video) {
    video.volume = initVol;
    video.muted = savedMuted;
  }

  if (btnVolume) btnVolume.innerHTML = savedMuted ? svgMuted : svgVolume;
  if (volumeSlider) {
    volumeSlider.value = savedMuted ? 0 : initVol;
  }

  if (volumeSlider) {
    volumeSlider.addEventListener('input', (e) => {
      const vol = parseFloat(e.target.value);
      const muted = vol === 0;
      if (video) { 
        video.volume = vol; 
        video.muted = muted; 
      }
      if (btnVolume) btnVolume.innerHTML = muted ? svgMuted : svgVolume;
      localStorage.setItem('etoyatv_volume', vol);
      localStorage.setItem('etoyatv_muted', muted);
    });
  }

  if (btnVolume) {
    btnVolume.addEventListener('click', () => {
      const isMuted = video && !video.muted;
      let vol = parseFloat(localStorage.getItem('etoyatv_volume'));
      if (isNaN(vol) || vol === 0) {
        vol = 1; // Default to max if we're unmuting from a 0-volume state
      }

      if (video) {
        video.muted = isMuted;
        video.volume = isMuted ? 0 : vol;
      }

      btnVolume.innerHTML = isMuted ? svgMuted : svgVolume;
      if (volumeSlider) {
        volumeSlider.value = isMuted ? 0 : vol;
      }
      localStorage.setItem('etoyatv_muted', isMuted);
      if (!isMuted) {
        localStorage.setItem('etoyatv_volume', vol);
      }
    });
  }

  // Hotkeys for volume (ArrowUp / ArrowDown)
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      if (!video) return;

      let vol = video.volume;
      if (e.key === 'ArrowUp') {
        vol = Math.min(1, vol + 0.1);
      } else {
        vol = Math.max(0, vol - 0.1);
      }

      video.volume = vol;
      video.muted = vol === 0;

      if (btnVolume) btnVolume.innerHTML = video.muted ? svgMuted : svgVolume;
      if (volumeSlider) volumeSlider.value = vol;

      localStorage.setItem('etoyatv_volume', vol);
      localStorage.setItem('etoyatv_muted', video.muted);
    }
  });

  if (btnFullscreen) {
    btnFullscreen.addEventListener('click', () => {
      const playerContainerFs = document.getElementById('container_swf');
      if (!document.fullscreenElement) {
        playerContainerFs.requestFullscreen().catch(err => {
          alert(`Error attempting to enable fullscreen: ${err.message}`);
        });
      } else {
        document.exitFullscreen();
      }
    });
  }

