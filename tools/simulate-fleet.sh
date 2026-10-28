#!/usr/bin/env bash
# Launch the 3-bot local fleet for the control-tower demo: TEST-VIN-001/2/3,
# each auto-mapped to its own mock video (mock_vehicle.mp4 / 2 / 3) in the
# in-repo video-test directory. Requires the backend stack, MediaMTX
# (tools/run-local-mediamtx.sh) and ffmpeg on PATH. Ctrl+C stops all three.
set -euo pipefail

cd "$(dirname "$0")/.."

npx tsx tools/bot-simulator.ts & p1=$!
BOT_VIN=TEST-VIN-002 BOT_MAC=00:11:22:33:44:66 npx tsx tools/bot-simulator.ts & p2=$!
BOT_VIN=TEST-VIN-003 BOT_MAC=00:11:22:33:44:77 npx tsx tools/bot-simulator.ts & p3=$!

trap 'kill "$p1" "$p2" "$p3" 2>/dev/null' EXIT
wait
