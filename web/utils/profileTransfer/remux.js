'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { safeResolvePublic } = require('../safePath');
const { publicRoot } = require('./paths');

function findHlsPlaylist(hlsUrl) {
  const root = publicRoot();
  const masterPath = safeResolvePublic(hlsUrl, root);
  if (!masterPath || !fs.existsSync(masterPath)) return null;

  const dir = path.dirname(masterPath);
  const candidates = [
    path.join(dir, 'high', 'prog_index.m3u8'),
    path.join(dir, 'sd', 'prog_index.m3u8'),
    path.join(dir, 'low', 'prog_index.m3u8'),
    masterPath
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function remuxHlsToMp4(playlistPath, outPath) {
  return new Promise((resolve, reject) => {
    const args = [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-i', playlistPath,
      '-c', 'copy',
      '-bsf:a', 'aac_adtstoasc',
      outPath
    ];
    const proc = spawn('ffmpeg', args);
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0 || !fs.existsSync(outPath) || fs.statSync(outPath).size === 0) {
        return reject(new Error(stderr.trim() || `ffmpeg exit ${code}`));
      }
      resolve(outPath);
    });
  });
}

/**
 * Resolve a record to a local MP4 path for packing.
 * Prefers existing video_url; otherwise remuxes HLS high → temp MP4.
 * @returns {{ filePath: string, cleanup: boolean }|null}
 */
async function resolveRecordMp4(record, tempDir) {
  const root = publicRoot();
  if (record.video_url) {
    const existing = safeResolvePublic(record.video_url, root);
    if (existing && fs.existsSync(existing) && fs.statSync(existing).size > 0) {
      return { filePath: existing, cleanup: false };
    }
  }
  if (!record.hls_url) return null;
  const playlist = findHlsPlaylist(record.hls_url);
  if (!playlist) return null;

  fs.mkdirSync(tempDir, { recursive: true });
  const outPath = path.join(tempDir, `record_${record.id}.mp4`);
  await remuxHlsToMp4(playlist, outPath);
  return { filePath: outPath, cleanup: true };
}

module.exports = {
  findHlsPlaylist,
  remuxHlsToMp4,
  resolveRecordMp4
};
