# Launch N parallel bot-simulator instances (N asked interactively, or via
# -Count), like simulate-fleet.sh / simulate-n-bots.sh but native
# PowerShell — no bash, so no WSL/Git-Bash ambiguity and env vars always
# reach the bot processes. Each instance gets its own TEST-VIN-00N identity
# and MAC (00:11:22:33:44:NN), so they show up as distinct vehicles. Each
# bot gets a mock video picked at random from the mock_vehicle*.mp4 files
# present in video-test/ (via BOT_VIDEO), so any count works with however
# many videos exist — with fewer videos than bots, videos are reused.
# Requires the backend stack, MediaMTX (tools/run-local-mediamtx.sh) and
# ffmpeg on PATH. Ctrl+C stops all bots.
#
# Usage:
#   .\tools\simulate-n-bots.ps1          # prompts "count:"
#   .\tools\simulate-n-bots.ps1 -Count 5
# If execution policy blocks it:
#   powershell -ExecutionPolicy Bypass -File tools\simulate-n-bots.ps1 -Count 5
param(
  [string]$Count = ''
)

$ErrorActionPreference = 'Stop'
Set-Location (Resolve-Path "$PSScriptRoot\..").Path

if (-not $Count) { $Count = Read-Host 'count' }
$Count = $Count.Trim() -replace '[^\d]', ''
if (-not $Count -or [int]$Count -lt 1) {
  Write-Error "count must be a positive integer, got '$($args[0])'"
  exit 1
}
if ([int]$Count -gt 99) {
  Write-Error 'count > 99 not supported (VIN scheme is TEST-VIN-0NN)'
  exit 1
}

# Available mock videos — the bot's own VIN-digit mapping only covers 1-3,
# so for N bots we assign explicitly, at random, reusing files as needed.
$videos = @(Get-ChildItem 'video-test/mock_vehicle*.mp4' | ForEach-Object FullName)
if ($videos.Count -eq 0) {
  Write-Warning 'no mock_vehicle*.mp4 found in video-test/ - bots will start without video'
}

# Spawn node.exe directly with npm's npx-cli.js — `Process.Start` can't
# execute `npx` (a .cmd shim needs a shell), and UseShellExecute=$false is
# required anyway: it lets us set per-bot env vars directly and inherits
# this console so all bots' logs interleave here.
$nodeExe = (Get-Command node -CommandType Application).Source
$npxCli = Join-Path (Split-Path $nodeExe) 'node_modules\npm\bin\npx-cli.js'
if (-not (Test-Path $npxCli)) { Write-Error "npx-cli.js not found at $npxCli"; exit 1 }

$procs = @()
try {
  for ($i = 1; $i -le [int]$Count; $i++) {
    $vin = 'TEST-VIN-{0:d3}' -f $i
    $mac = '00:11:22:33:44:{0:X2}' -f $i
    $video = if ($videos.Count -gt 0) { $videos | Get-Random } else { '' }

    $psi = [System.Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = $nodeExe
    $psi.Arguments = '"' + $npxCli + '" tsx tools/bot-simulator.ts'
    $psi.WorkingDirectory = (Get-Location).Path
    $psi.UseShellExecute = $false
    $psi.EnvironmentVariables['BOT_VIN'] = $vin
    $psi.EnvironmentVariables['BOT_MAC'] = $mac
    if ($video) { $psi.EnvironmentVariables['BOT_VIDEO'] = $video }
    if ($env:BOT_AUTO_START_VIDEO) { $psi.EnvironmentVariables['BOT_AUTO_START_VIDEO'] = $env:BOT_AUTO_START_VIDEO }
    if ($env:RTSP_PUBLISH_BASE) { $psi.EnvironmentVariables['RTSP_PUBLISH_BASE'] = $env:RTSP_PUBLISH_BASE }
    if ($env:MQTT_BROKER_URL) { $psi.EnvironmentVariables['MQTT_BROKER_URL'] = $env:MQTT_BROKER_URL }
    if ($env:BACKEND_HTTP_URL) { $psi.EnvironmentVariables['BACKEND_HTTP_URL'] = $env:BACKEND_HTTP_URL }
    if ($env:NODE_TLS_REJECT_UNAUTHORIZED) { $psi.EnvironmentVariables['NODE_TLS_REJECT_UNAUTHORIZED'] = $env:NODE_TLS_REJECT_UNAUTHORIZED }

    Write-Host "starting bot $i/$Count`: $vin ($mac)$(if ($video) { " video=$video" })"
    $procs += [System.Diagnostics.Process]::Start($psi)
  }

  Write-Host 'Ctrl+C stops all bots'
  Wait-Process -InputObject $procs
}
finally {
  foreach ($p in $procs) {
    if (-not $p.HasExited) { $p.Kill() }
  }
}
