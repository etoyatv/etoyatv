const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const ffmpeg = require('fluent-ffmpeg');

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'db',
  user: process.env.DB_USER || 'yatv_user',
  password: process.env.DB_PASSWORD || 'yatv_pass',
  database: process.env.DB_NAME || 'yatv_db',
  waitForConnections: true,
  connectionLimit: 5,
  queueLimit: 0,
  charset: 'utf8mb4'
});

async function logSystem(actionText) {
  try {
    await pool.query('INSERT INTO system_logs (log_type, username, action_text, ip_address) VALUES (?, ?, ?, ?)', ['system', 'Система', actionText, '127.0.0.1']);
  } catch (err) {
    console.error('Failed to log system action:', err);
  }
}

async function processRecord(record) {
  console.log(`Starting HLS conversion for record ${record.id}: ${record.title}`);
  await logSystem(`Начата конвертация HLS для записи "${record.title}" (ID: ${record.id})`);
  
  const videoPath = path.join('/app/public', record.video_url);
  const recordId = record.id;
  
  // Destination paths
  const destinationDir = path.dirname(videoPath);
  const timestamp = Date.now();
  const recordDir = path.join(destinationDir, `hls_${recordId}_${timestamp}`);
  
  try {
    if (!fs.existsSync(videoPath)) {
      throw new Error(`Video file not found at ${videoPath}`);
    }

    // Extract duration, width, height, and audio presence
    const { duration, width, height, hasAudio } = await new Promise((resolve) => {
      ffmpeg.ffprobe(videoPath, (err, metadata) => {
        if (err || !metadata || !metadata.format) return resolve({ duration: 0, width: 0, height: 0, hasAudio: false });
        const videoStream = metadata.streams ? metadata.streams.find(s => s.codec_type === 'video') : null;
        const audioStream = metadata.streams ? metadata.streams.find(s => s.codec_type === 'audio') : null;
        resolve({
          duration: Math.floor(metadata.format.duration || 0),
          width: videoStream ? videoStream.width : 0,
          height: videoStream ? videoStream.height : 0,
          hasAudio: !!audioStream
        });
      });
    });

    const thumbnailFilename = 'thumb_' + path.parse(videoPath).name + '.jpg';
    
    // Extract thumbnail
    await new Promise((resolve) => {
      ffmpeg(videoPath)
        .on('end', () => resolve())
        .on('error', () => resolve())
        .screenshots({
          count: 1,
          timestamps: ['20%'],
          folder: destinationDir,
          filename: thumbnailFilename
        });
    });

    await pool.query('UPDATE records SET duration = ? WHERE id = ?', [duration, recordId]);

    let ffmpegArgs = [];
    const minRes = Math.min(width, height);
    
    if (minRes > 0 && minRes < 720) {
      // Only SD for lower resolutions
      fs.mkdirSync(path.join(recordDir, 'sd'), { recursive: true });
      ffmpegArgs = [
        '-y', '-i', videoPath,
        '-preset', 'veryfast', '-g', '48', '-sc_threshold', '0',
        '-map', '0:v:0', '-map', '0:a?',
        '-c:v', 'libx264', '-c:a', 'aac', '-ar', '48000',
        '-crf:v:0', '28', '-maxrate:v:0', '1500k', '-bufsize:v:0', '3000k',
        '-var_stream_map', hasAudio ? 'v:0,a:0,name:sd' : 'v:0,name:sd',
        '-f', 'hls', '-hls_time', '6', '-hls_list_size', '0',
        '-hls_segment_filename', `${recordDir}/%v/segment_%03d.ts`,
        '-master_pl_name', 'master.m3u8',
        `${recordDir}/%v/prog_index.m3u8`
      ];
    } else {
      // High and low streams for >= 720p or unknown
      fs.mkdirSync(path.join(recordDir, 'high'), { recursive: true });
      fs.mkdirSync(path.join(recordDir, 'low'), { recursive: true });
      ffmpegArgs = [
        '-y', '-i', videoPath,
        '-preset', 'veryfast', '-g', '48', '-sc_threshold', '0',
        '-map', '0:v:0', '-map', '0:a?', '-map', '0:v:0', '-map', '0:a?',
        '-c:v', 'libx264', '-c:a', 'aac', '-ar', '48000',
        '-filter:v:0', 'scale=-2:\'min(1080,ih)\'', '-crf:v:0', '28', '-maxrate:v:0', '2000k', '-bufsize:v:0', '4000k',
        '-filter:v:1', 'scale=-2:\'min(540,ih)\'', '-crf:v:1', '32', '-maxrate:v:1', '800k', '-bufsize:v:1', '1600k',
        '-var_stream_map', hasAudio ? 'v:0,a:0,name:high v:1,a:1,name:low' : 'v:0,name:high v:1,name:low',
        '-f', 'hls', '-hls_time', '6', '-hls_list_size', '0',
        '-hls_segment_filename', `${recordDir}/%v/segment_%03d.ts`,
        '-master_pl_name', 'master.m3u8',
        `${recordDir}/%v/prog_index.m3u8`
      ];
    }

    console.log(`Executing FFMPEG for record ${recordId}...`);
    
    await new Promise((resolve, reject) => {
      const proc = spawn('/usr/bin/ffmpeg', ffmpegArgs);
      
      let stderr = '';
      proc.stderr.on('data', data => stderr += data);
      
      proc.on('close', code => {
        if (code !== 0) {
          console.error(`FFMPEG error for record ${recordId}. Code: ${code}`);
          console.error('FFMPEG stderr:', stderr);
          return reject(new Error('FFMPEG failed'));
        }
        resolve();
      });
      proc.on('error', err => reject(err));
    });

    const hlsUrl = `/uploads/records/hls_${recordId}_${timestamp}/master.m3u8`;
    await pool.query('UPDATE records SET hls_url = ?, processing_status = ? WHERE id = ?', [hlsUrl, 'completed', recordId]);

    fs.unlink(videoPath, (err) => {
      if (err) console.error(`Error deleting MP4 after HLS for record ${recordId}:`, err);
      else console.log(`Deleted original MP4 for record ${recordId}`);
    });

    console.log(`Successfully completed HLS conversion for record ${recordId}`);
    await logSystem(`Успешно завершена HLS-конвертация для записи (ID: ${recordId})`);
  } catch (err) {
    console.error(`Failed to process record ${recordId}:`, err.message);
    await logSystem(`Ошибка конвертации HLS для записи (ID: ${recordId}): ${err.message}`);
    await pool.query('UPDATE records SET processing_status = ? WHERE id = ?', ['error', recordId]);
  }
}

async function loop() {
  console.log('Worker started, polling for pending records...');
  await logSystem('Worker (HLS конвертер) запущен');
  
  // Reset any stuck processing records back to pending (e.g., after a container restart)
  try {
    const [result] = await pool.query("UPDATE records SET processing_status = 'pending' WHERE processing_status = 'processing'");
    if (result.affectedRows > 0) {
      console.log(`Reset ${result.affectedRows} stuck processing records back to pending.`);
    }
  } catch (err) {
    console.error('Failed to reset stuck records:', err);
  }

  while (true) {
    try {
      const [rows] = await pool.query("SELECT * FROM records WHERE processing_status = 'pending' AND hls_url IS NULL ORDER BY created_at ASC LIMIT 1");
      if (rows.length > 0) {
        const record = rows[0];
        // Mark as processing
        await pool.query("UPDATE records SET processing_status = 'processing' WHERE id = ?", [record.id]);
        
        await processRecord(record);
      } else {
        // Wait 5 seconds before polling again
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    } catch (err) {
      console.error('Error in worker loop:', err);
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
}

// Start loop
loop().catch(err => {
  console.error('Fatal worker error:', err);
  process.exit(1);
});
