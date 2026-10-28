#!/usr/bin/env bash
# Local-dev MediaMTX using the existing video-test config (RTSP :8554 ingest,
# WHEP :8889 playback, any path allowed). Start this BEFORE the bot simulators
# and the UI. Requires Docker.
set -euo pipefail

VIDEO_TEST_DIR="${VIDEO_TEST_DIR:-$(cd "$(dirname "$0")/.." && pwd)/video-test}"

exec docker run --rm \
  -v "$VIDEO_TEST_DIR/mediamtx.yml:/mediamtx.yml" \
  -p 8554:8554 \
  -p 8889:8889 \
  -p 8189:8189/udp \
  bluenviron/mediamtx

