#!/bin/sh

echo "[MediaMTX Hook] Stream started: $MTX_PATH from IP $MTX_CONN_IP"

# WEB_SERVER_IP: host reachable from this container (set in .env)
WEB_IP=${WEB_SERVER_IP:-127.0.0.1}

# Reject path values that could break shell/ffmpeg arguments
case "$MTX_PATH" in
  ''|*[!A-Za-z0-9/_-]*)
    echo "[MediaMTX Hook] Rejected unsafe MTX_PATH"
    exit 1
    ;;
esac

SAFE_NAME=$(printf '%s' "${MTX_PATH##*/}" | tr -cd 'A-Za-z0-9._-')
if [ -z "$SAFE_NAME" ]; then
  echo "[MediaMTX Hook] Rejected empty snapshot name"
  exit 1
fi

if [ -z "${RTMP_API_PASS:-}" ]; then
  echo "[MediaMTX Hook] WARNING: RTMP_API_PASS is empty — unpublish webhook will be rejected by web"
fi

# Write thumbnails to LOCAL tmp (not sshfs/CDN). Direct ffmpeg→sshfs I/O hangs
# leave zombie ffmpeg and can wedge MediaMTX so the API stops answering.
SNAP_DIR_LOCAL="/tmp/tvsnapshots"
SNAP_LOCAL="${SNAP_DIR_LOCAL}/${SAFE_NAME}.jpg"
SNAP_REMOTE="/public/tvsnapshots/${SAFE_NAME}.jpg"
mkdir -p "$SNAP_DIR_LOCAL"

# Continuous local jpeg; sync loop copies to CDN with a hard timeout
ffmpeg -hide_banner -loglevel error -y -skip_frame nokey \
  -i "rtmp://localhost:1935/${MTX_PATH}" \
  -vf "fps=1/30,scale=480:-1" -strict -2 -threads 1 -update 1 \
  "$SNAP_LOCAL" &
FFMPEG_PID=$!

# Periodic CDN sync — never block forever on a stuck fuse/sshfs mount
(
  while kill -0 "$FFMPEG_PID" 2>/dev/null; do
    if [ -f "$SNAP_LOCAL" ]; then
      if ! timeout 8 cp -f "$SNAP_LOCAL" "$SNAP_REMOTE" 2>/dev/null; then
        echo "[MediaMTX Hook] snapshot sync failed/timeout for ${SAFE_NAME} (CDN mount?)"
      fi
    fi
    sleep 30
  done
  if [ -f "$SNAP_LOCAL" ]; then
    timeout 8 cp -f "$SNAP_LOCAL" "$SNAP_REMOTE" 2>/dev/null || true
  fi
) &
SYNC_PID=$!

# Optional live ABR low ladder → CDN (fMP4). OFF by default: soft-encode does not scale to many concurrent lives.
# Re-enable with LIVE_ABR_ENABLED=1 when a non-CPU path exists (OBS multi-bitrate / external workers).
# Profile when enabled: 360p / 25fps / 1 thread.
ABR_PID=""
if [ "${LIVE_ABR_ENABLED:-0}" = "1" ]; then
  ABR_DIR="/public/live_abr/${SAFE_NAME}/low"
  # mkdir itself can hang on dead sshfs — bound it
  if timeout 10 mkdir -p "$ABR_DIR" 2>/dev/null; then
    ABR_THREADS="${LIVE_ABR_THREADS:-1}"
    echo "[MediaMTX Hook] Starting ABR ladder for ${SAFE_NAME} (360p25, threads=${ABR_THREADS})"
    ffmpeg -hide_banner -loglevel error -y \
      -i "rtmp://localhost:1935/${MTX_PATH}" \
      -threads "${ABR_THREADS}" \
      -preset ultrafast -tune zerolatency \
      -vf "fps=25,scale=640:-2" \
      -c:v libx264 -profile:v baseline \
      -g 50 -keyint_min 50 -sc_threshold 0 \
      -b:v 550k -maxrate 650k -bufsize 1100k \
      -c:a aac -b:a 96k -ar 44100 -ac 2 \
      -f hls -hls_time 2 -hls_list_size 12 \
      -hls_segment_type fmp4 \
      -hls_fmp4_init_filename init.mp4 \
      -hls_flags delete_segments+append_list+independent_segments \
      -hls_segment_filename "${ABR_DIR}/seg_%03d.m4s" \
      "${ABR_DIR}/index.m3u8" &
    ABR_PID=$!
  else
    echo "[MediaMTX Hook] ABR skipped — cannot create ${ABR_DIR} (CDN mount?)"
  fi
fi

kill_pid() {
  _pid="$1"
  [ -n "$_pid" ] || return 0
  kill -15 "$_pid" 2>/dev/null || true
  sleep 1
  kill -9 "$_pid" 2>/dev/null || true
  wait "$_pid" 2>/dev/null || true
}

# Define cleanup function on SIGINT/SIGTERM
cleanup() {
  echo "[MediaMTX Hook] Stream stopped: $MTX_PATH. Notifying web server..."

  # Send unpublish webhook (authenticated via shared RTMP_API_PASS); bound wait
  timeout 5 wget -q --post-data="{\"path\":\"${MTX_PATH}\",\"ip\":\"${MTX_CONN_IP}\"}" \
    --header="Content-Type: application/json" \
    --header="X-RTMP-Internal: ${RTMP_API_PASS}" \
    -O- "http://${WEB_IP}:3001/api/internal/rtmp/mediamtx_unpublish" || true

  kill_pid "$SYNC_PID"
  kill_pid "$FFMPEG_PID"
  kill_pid "$ABR_PID"
  rm -f "$SNAP_LOCAL" 2>/dev/null || true
  exit 0
}

# Trap signals
trap cleanup INT TERM

# Wait for FFmpeg to finish (which keeps this script running until kicked)
wait "$FFMPEG_PID" 2>/dev/null || true
# If thumbnail ffmpeg exits early, still wait for ABR so cleanup trap stays armed
if [ -n "$ABR_PID" ]; then
  wait "$ABR_PID" 2>/dev/null || true
fi
# Final sync + reap sync loop
kill_pid "$SYNC_PID"
if [ -f "$SNAP_LOCAL" ]; then
  timeout 8 cp -f "$SNAP_LOCAL" "$SNAP_REMOTE" 2>/dev/null || true
fi
