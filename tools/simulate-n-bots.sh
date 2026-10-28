#!/usr/bin/env bash
# Launch N parallel bot-simulator instances (N asked interactively), like
# simulate-fleet.sh but with a user-supplied count. Each instance gets its
# own TEST-VIN-00N identity and MAC (00:11:22:33:44:NN), so they show up as
# distinct vehicles. Each bot gets a mock video picked at random from the
# mock_vehicle*.mp4 files present in video-test/ (via BOT_VIDEO), so any
# count works with however many videos exist — with fewer videos than bots,
# videos are reused across bots. Requires the backend stack, MediaMTX
# (tools/run-local-mediamtx.sh) and ffmpeg on PATH. Ctrl+C stops all.
set -euo pipefail

cd "$(dirname "$0")/.."

# `|| true`: read returns non-zero on EOF-without-newline (e.g. a piped
# string); the variable is still populated, and validation below rejects
# empties — but a bare `read` under `set -e` would kill the script first.
read -r -p "count: " count || true

# Tolerate CRLF and a UTF-8 BOM on piped stdin (PowerShell pipes to native
# commands with a BOM by default, which otherwise corrupts the number).
count="${count#$'\xef\xbb\xbf'}"
count="${count%$'\r'}"

if ! [[ "$count" =~ ^[0-9]+$ ]] || [ "$count" -lt 1 ]; then
  echo "error: count must be a positive integer, got '$count'" >&2
  exit 1
fi

if [ "$count" -gt 99 ]; then
  echo "error: count > 99 not supported (VIN scheme is TEST-VIN-0NN)" >&2
  exit 1
fi

# Available mock videos — the bot's own VIN-digit mapping only covers 1-3,
# so for N bots we assign explicitly, at random, reusing files as needed.
shopt -s nullglob
videos=(video-test/mock_vehicle*.mp4)
shopt -u nullglob
if [ "${#videos[@]}" -eq 0 ]; then
  echo "warning: no mock_vehicle*.mp4 found in video-test/ — bots will start without video" >&2
fi

pids=()
for i in $(seq 1 "$count"); do
  vin=$(printf 'TEST-VIN-%03d' "$i")
  mac=$(printf '00:11:22:33:44:%02X' "$i")
  video=""
  if [ "${#videos[@]}" -gt 0 ]; then
    video="${videos[$((RANDOM % ${#videos[@]}))]}"
  fi
  echo "starting bot $i/$count: $vin ($mac)${video:+ video=$video}"
  # `env` (not a bare ${var:+ASSIGN=...} prefix — that expands after
  # assignment-prefix parsing and gets treated as a command name).
  env BOT_VIN="$vin" BOT_MAC="$mac" ${video:+BOT_VIDEO="$video"} npx tsx tools/bot-simulator.ts &
  pids+=($!)
done

trap 'kill "${pids[@]}" 2>/dev/null' EXIT
wait
