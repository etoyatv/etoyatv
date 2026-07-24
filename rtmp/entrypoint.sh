#!/bin/sh
set -e

WEB_IP=${AUTH_WEB_IP:-${WEB_SERVER_IP:-127.0.0.1}}
PASS=${RTMP_API_PASS:-}

if [ -z "$PASS" ]; then
  echo "[entrypoint] ERROR: RTMP_API_PASS is required for MediaMTX authHTTPAddress"
  exit 1
fi

# URL-encode secret for query string (minimal: encode reserved chars)
ENC_PASS=$(printf '%s' "$PASS" | sed \
  -e 's/%/%25/g' -e 's/ /%20/g' -e 's/!/%21/g' -e 's/"/%22/g' \
  -e 's/#/%23/g' -e 's/\$/%24/g' -e 's/&/%26/g' -e 's/'\''/%27/g' \
  -e 's/(/%28/g' -e 's/)/%29/g' -e 's/\*/%2A/g' -e 's/+/%2B/g' \
  -e 's/,/%2C/g' -e 's/\//%2F/g' -e 's/:/%3A/g' -e 's/;/%3B/g' \
  -e 's/=/%3D/g' -e 's/?/%3F/g' -e 's/@/%40/g' -e 's/\[/%5B/g' \
  -e 's/\]/%5D/g')

AUTH_URL="http://${WEB_IP}:3001/api/internal/rtmp/mediamtx_auth?internal=${ENC_PASS}"

sed "s|__AUTH_HTTP_ADDRESS__|${AUTH_URL}|g" /mediamtx.yml.template > /tmp/mediamtx.yml

# Run MediaMTX under a watchdog: if the process is alive but the API stops
# answering (wedged on sshfs/ffmpeg zombies), kill it so Docker restarts us.
# Requires compose `init: true` so orphans/zombies are reaped by tini.
/mediamtx /tmp/mediamtx.yml &
MTX_PID=$!

WATCH_FAILS=0
WATCH_INTERVAL="${MTX_WATCHDOG_INTERVAL:-20}"
WATCH_TIMEOUT="${MTX_WATCHDOG_TIMEOUT:-3}"
WATCH_MAX_FAILS="${MTX_WATCHDOG_MAX_FAILS:-3}"

while kill -0 "$MTX_PID" 2>/dev/null; do
  sleep "$WATCH_INTERVAL"
  if ! kill -0 "$MTX_PID" 2>/dev/null; then
    break
  fi
  if timeout "$WATCH_TIMEOUT" wget -q -O /dev/null "http://127.0.0.1:9997/v3/config/global/get" 2>/dev/null \
     || timeout "$WATCH_TIMEOUT" wget -q -O /dev/null "http://127.0.0.1:9997/v3/paths/list" 2>/dev/null; then
    WATCH_FAILS=0
  else
    WATCH_FAILS=$((WATCH_FAILS + 1))
    echo "[entrypoint] MediaMTX API health check failed (${WATCH_FAILS}/${WATCH_MAX_FAILS})"
    if [ "$WATCH_FAILS" -ge "$WATCH_MAX_FAILS" ]; then
      echo "[entrypoint] MediaMTX appears wedged — killing pid ${MTX_PID} for Docker restart"
      kill -TERM "$MTX_PID" 2>/dev/null || true
      sleep 2
      kill -KILL "$MTX_PID" 2>/dev/null || true
      wait "$MTX_PID" 2>/dev/null || true
      exit 1
    fi
  fi
done

wait "$MTX_PID"
exit $?
