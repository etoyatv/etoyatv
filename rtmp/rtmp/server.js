const NodeMediaServer = require('node-media-server');
const axios = require('axios');

const config = {
  rtmp: {
    port: 1935,
    chunk_size: 60000,
    gop_cache: true,
    ping: 30,
    ping_timeout: 60
  },
  http: {
    port: 8000,
    allow_origin: '*',
    mediaroot: './media'
  },
  auth: {
    api: true,
    api_user: process.env.RTMP_API_USER || 'admin',
    api_pass: process.env.RTMP_API_PASS || 'admin'
  }
};

const nms = new NodeMediaServer(config);

nms.on('prePublish', async (id, StreamPath, args) => {
  console.log('[NodeEvent on prePublish]', `id=${id} StreamPath=${StreamPath} args=${JSON.stringify(args)}`);

  const streamKey = args.key;
  const channelShortname = StreamPath.split('/')[2]; // /live/testoviy -> ['', 'live', 'testoviy']
  const session = nms.getSession(id);
  
  let ip = session && session.socket ? session.socket.remoteAddress : null;
  if (ip && ip.startsWith('::ffff:')) {
    ip = ip.substring(7);
  }
  if (ip === '::1') {
    ip = '127.0.0.1';
  }

  if (id) {
    global.publishIps = global.publishIps || {};
    global.publishIps[id] = ip;
  }

  if (!channelShortname || !streamKey) {
    console.log('[RTMP] Rejected: missing channel or key');
    if (session) session.reject();
    return;
  }

  try {
    const response = await axios.post(`http://192.168.90.4:3001/api/internal/rtmp/on_publish`, {
      shortname: channelShortname,
      key: streamKey,
      streamId: id,
      ip: ip
    });

    if (response.status !== 200) {
      console.log(`[RTMP] Rejected publish for ${channelShortname}`);
      session.reject();
    } else {
      console.log(`[RTMP] Authorized publish for ${channelShortname}`);
    }
  } catch (err) {
    console.error(`[RTMP] Error validating stream:`, err.response?.data || err.message);
    session.reject();
  }
});

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const cleanupTimers = {};

nms.on('postPublish', (id, StreamPath, args) => {
  const session = nms.getSession(id);
  if (!session) return;

  const mediaPath = path.join(__dirname, 'media', StreamPath.toLowerCase());

  session.spawnTimer = setTimeout(() => {
    const currentSession = nms.getSession(id);
    if (!currentSession) return;

    let isReconnection = false;
    if (cleanupTimers[StreamPath]) {
      clearTimeout(cleanupTimers[StreamPath]);
      delete cleanupTimers[StreamPath];
      isReconnection = true;
      console.log(`[RTMP] Reconnection detected within grace period for ${StreamPath}. Preserving HLS directory.`);
    }

    if (!isReconnection) {
      if (fs.existsSync(mediaPath)) {
        fs.rmSync(mediaPath, { recursive: true, force: true });
      }
      fs.mkdirSync(mediaPath, { recursive: true });
    }

    const hlsFlags = isReconnection ? 'delete_segments+append_list' : 'delete_segments';

    // Choose video codec: copy if H264, transcode if H265/HEVC
    let videoCodec = 'copy';
    const detectedCodec = currentSession.videoCodecName;
    console.log(`[RTMP] Detected video codec for ${StreamPath}: ${detectedCodec}`);
    if (detectedCodec && (detectedCodec.toLowerCase() === 'hevc' || detectedCodec.toLowerCase() === 'h265')) {
      console.log(`[RTMP] Stream ${StreamPath} is H.265/HEVC. Transcoding to H.264 on the fly!`);
      videoCodec = 'libx264';
    }

    const ffmpegArgs = [
      '-y',
      '-fflags', 'nobuffer+genpts',
      '-analyzeduration', '5000000',
      '-probesize', '5000000',
      '-i', `rtmp://127.0.0.1:1935${StreamPath}`,
    ];

    if (videoCodec === 'libx264') {
      ffmpegArgs.push(
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-tune', 'zerolatency',
        '-crf', '23',
        '-maxrate', '2500k',
        '-bufsize', '5000k',
        '-pix_fmt', 'yuv420p'
      );
    } else {
      ffmpegArgs.push('-c:v', 'copy');
    }

    ffmpegArgs.push(
      '-c:a', 'copy',
      '-max_muxing_queue_size', '1024',
      '-f', 'hls',
      '-hls_time', '4',
      '-hls_list_size', '6',
      '-hls_flags', hlsFlags,
      '-strftime', '1',
      '-hls_segment_filename', `${mediaPath}/%s.ts`,
      `${mediaPath}/index.m3u8`
    );

    const ffmpeg = spawn('/usr/bin/ffmpeg', ffmpegArgs);

    ffmpeg.stderr.on('data', (data) => {
      const str = data.toString();
      if (str.includes('Error') || str.includes('Too many packets') || str.includes('Non-monotonic')) {
        console.log(`[FFMPEG HLS] ${str.trim()}`);
      }
    });

    ffmpeg.on('close', (code) => {
      console.log(`[FFMPEG] ${StreamPath} exited with code ${code}`);
    });

    currentSession.ffmpeg = ffmpeg;

    const channelShortname = StreamPath.split('/')[2].toLowerCase();
    const tvsnapshotsPath = path.join(__dirname, '../public/tvsnapshots');
    if (!fs.existsSync(tvsnapshotsPath)) {
      fs.mkdirSync(tvsnapshotsPath, { recursive: true });
    }
    const publicThumbPath = path.join(tvsnapshotsPath, `${channelShortname}.jpg`);

    console.log(`[FFMPEG] Starting thumbnail generation for ${StreamPath}`);
    const ffmpegThumb = spawn('/usr/bin/ffmpeg', [
      '-y',
      '-i', `rtmp://127.0.0.1:1935${StreamPath}`,
      '-vf', 'fps=1/30',
      '-update', '1',
      publicThumbPath
    ]);

    ffmpegThumb.on('close', (code) => {
      console.log(`[FFMPEG Thumb] ${StreamPath} exited with code ${code}`);
    });

    currentSession.ffmpegThumb = ffmpegThumb;
  }, 2000);

  // Add periodic check for resolution and bitrate
  session.checkInterval = setInterval(() => {
    if (!session || session.isRejected) {
      clearInterval(session.checkInterval);
      return;
    }

    // Check resolution (limit to 1080p)
    if (session.videoWidth > 1920 || session.videoHeight > 1080) {
      console.log(`[RTMP] Rejecting stream: resolution ${session.videoWidth}x${session.videoHeight} exceeds 1080p limit.`);
      session.reject();
      clearInterval(session.checkInterval);
      return;
    }

    // Check bitrate (allow up to 5500 kbps to account for VBR/CBR spikes, nominal 3000 kbps)
    if (session.bitrate > 5500) {
      console.log(`[RTMP] Rejecting stream: bitrate ${session.bitrate} kbps exceeds 3000 kbps limit.`);
      session.reject();
      clearInterval(session.checkInterval);
      return;
    }
  }, 5000);
});

nms.on('donePublish', async (id, StreamPath, args) => {
  console.log('[NodeEvent on donePublish]', `id=${id} StreamPath=${StreamPath} args=${JSON.stringify(args)}`);

  const session = nms.getSession(id);
  
  global.publishIps = global.publishIps || {};
  let ip = global.publishIps[id];
  delete global.publishIps[id];

  if (session) {
    if (!ip && session.socket) {
      ip = session.socket.remoteAddress;
      if (ip && ip.startsWith('::ffff:')) {
        ip = ip.substring(7);
      }
      if (ip === '::1') {
        ip = '127.0.0.1';
      }
    }
    if (session.spawnTimer) {
      clearTimeout(session.spawnTimer);
    }
    if (session.ffmpeg) {
      console.log(`[FFMPEG] Killing transmux for ${StreamPath}`);
      session.ffmpeg.kill('SIGKILL');
    }
    if (session.ffmpegThumb) {
      console.log(`[FFMPEG Thumb] Killing thumbnail generation for ${StreamPath}`);
      session.ffmpegThumb.kill('SIGKILL');
    }
    if (session.checkInterval) {
      clearInterval(session.checkInterval);
    }
  }

  const channelShortname = StreamPath.split('/')[2].toLowerCase();
  try {
    await axios.post(`http://192.168.90.4:3001/api/internal/rtmp/on_done`, {
      shortname: channelShortname,
      streamId: id,
      ip: ip
    });
  } catch (err) {
    console.error(`[RTMP] Error notifying done:`, err.message);
  }

  // Schedule cleanup of leftover HLS files and thumbnail
  const mediaPath = path.join(__dirname, 'media', StreamPath.toLowerCase());
  const publicThumbPath = path.join(__dirname, '../public/tvsnapshots', `${channelShortname}.jpg`);

  cleanupTimers[StreamPath] = setTimeout(() => {
    try {
      if (fs.existsSync(mediaPath)) {
        fs.rmSync(mediaPath, { recursive: true, force: true });
      }
      if (fs.existsSync(publicThumbPath)) {
        fs.unlinkSync(publicThumbPath);
      }
      console.log(`[CLEANUP] Deleted leftover HLS files and thumbnail for ${channelShortname}`);
    } catch (err) {
      console.error(`[CLEANUP] Failed to delete leftover files for ${channelShortname}:`, err.message);
    }
    delete cleanupTimers[StreamPath];
  }, 15000); // 15 seconds delay to let clients fetch final segments
});

nms.run();

// Endpoint to force drop a stream
const express = require('express');
const apiApp = express();
apiApp.use(express.json());

apiApp.delete('/api/drop/:streamId', (req, res) => {
  const streamId = req.params.streamId;
  const session = nms.getSession(streamId);
  if (session) {
    session.reject();
    res.json({ success: true });
  } else {
    res.status(404).json({ success: false, error: 'Session not found' });
  }
});
