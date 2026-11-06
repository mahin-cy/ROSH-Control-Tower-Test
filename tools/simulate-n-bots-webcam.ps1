param(
  [int]$Count = 5,
  [int]$StartOffset = 1,
  [string]$CameraName = "Integrated Camera"
)

$ErrorActionPreference = 'Stop'
Set-Location (Resolve-Path "$PSScriptRoot\..").Path
$repoRoot = (Get-Location).Path

# 1. Load connection defaults from .env.loadtest if present
$envFile = Join-Path $repoRoot '.env.loadtest'
if (Test-Path $envFile) {
  Get-Content $envFile | ForEach-Object {
    $line = $_.Trim()
    if ($line -and -not $line.StartsWith('#')) {
      $idx = $line.IndexOf('=')
      if ($idx -gt 0) {
        $k = $line.Substring(0, $idx).Trim()
        $v = $line.Substring($idx + 1).Trim().Trim('"').Trim("'")
        if ($v -and -not [System.Environment]::GetEnvironmentVariable($k)) {
          [System.Environment]::SetEnvironmentVariable($k, $v)
        }
      }
    }
  }
}

# Auto-derive endpoints
$tailnetHost = $env:TAILNET_HOST
$brokerUrl  = if ($env:MQTT_BROKER_URL)  { $env:MQTT_BROKER_URL }  elseif ($tailnetHost) { "wss://$tailnetHost/mqtt" } else { "mqtt://localhost:1883" }
$backendUrl = if ($env:BACKEND_HTTP_URL) { $env:BACKEND_HTTP_URL } elseif ($tailnetHost) { "https://$tailnetHost" }   else { "http://localhost:3000" }
$rtspBase   = if ($env:RTSP_PUBLISH_BASE){ $env:RTSP_PUBLISH_BASE }elseif ($tailnetHost) { "rtsp://$tailnetHost:8554" }else { "rtsp://localhost:8554" }

$maxVin = $StartOffset + $Count - 1
if ($maxVin -gt 99) {
  Write-Error "max VIN index $maxVin > 99 not supported (VIN scheme is TEST-VIN-0NN)"
  exit 1
}

$vins = ($StartOffset..$maxVin) | ForEach-Object { "TEST-VIN-{0:D3}" -f $_ }
Write-Host "================================================================================" -ForegroundColor Cyan
Write-Host " Launching $Count Bots with Live Webcam Feed: $($vins[0]) to $($vins[-1])" -ForegroundColor Cyan
Write-Host " Camera: $CameraName"
Write-Host " Broker: $brokerUrl"
Write-Host " RTSP Base: $rtspBase"
Write-Host "================================================================================" -ForegroundColor Cyan

# 2. Build FFmpeg tee output string across all N bot streams
$teeOutputs = ($vins | ForEach-Object { "[f=rtsp:rtsp_transport=tcp]$rtspBase/$_" }) -join '|'

Write-Host "Starting master webcam stream (single encode -> $Count duplicated streams)..." -ForegroundColor Yellow
$ffmpegArgs = "-hide_banner -loglevel warning -rtbufsize 256M -f dshow -video_size 1280x720 -framerate 30 -pixel_format nv12 -i video=`"$CameraName`" -c:v libx264 -preset ultrafast -tune zerolatency -b:v 1500k -pix_fmt yuv420p -f tee -map 0:v `"$teeOutputs`""

$ffmpegPsi = [System.Diagnostics.ProcessStartInfo]::new()
$ffmpegPsi.FileName = "ffmpeg"
$ffmpegPsi.Arguments = $ffmpegArgs
$ffmpegPsi.UseShellExecute = $false
$ffmpegProc = [System.Diagnostics.Process]::Start($ffmpegPsi)

Start-Sleep -Seconds 2
if ($ffmpegProc.HasExited) {
  Write-Error "FFmpeg exited unexpectedly. Check your camera name or server connectivity."
  exit 1
}

# 3. Launch N Bot Simulators (MQTT telemetry & handshakes)
$nodeExe = (Get-Command node -CommandType Application).Source
$npxCli = Join-Path (Split-Path $nodeExe) 'node_modules\npm\bin\npx-cli.js'
$botProcs = @()

try {
  for ($i = $StartOffset; $i -le $maxVin; $i++) {
    $vin = "TEST-VIN-{0:D3}" -f $i
    $mac = "00:11:22:33:44:{0:X2}" -f $i

    $psi = [System.Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = $nodeExe
    $psi.Arguments = "`"$npxCli`" tsx tools/bot-simulator.ts"
    $psi.WorkingDirectory = $repoRoot
    $psi.UseShellExecute = $false
    $psi.EnvironmentVariables['BOT_VIN'] = $vin
    $psi.EnvironmentVariables['BOT_MAC'] = $mac
    $psi.EnvironmentVariables['BOT_EXTERNAL_VIDEO'] = 'true'
    $psi.EnvironmentVariables['MQTT_BROKER_URL'] = $brokerUrl
    $psi.EnvironmentVariables['BACKEND_HTTP_URL'] = $backendUrl
    $psi.EnvironmentVariables['RTSP_PUBLISH_BASE'] = $rtspBase

    Write-Host "Starting Bot: $vin ($mac)"
    $botProcs += [System.Diagnostics.Process]::Start($psi)
  }

  Write-Host "`nAll $Count bots running with live webcam stream! Press Ctrl+C to stop all." -ForegroundColor Green
  Wait-Process -InputObject $botProcs
}
finally {
  Write-Host "`nStopping all bots and webcam stream..." -ForegroundColor Yellow
  if ($ffmpegProc -and -not $ffmpegProc.HasExited) { $ffmpegProc.Kill() }
  foreach ($p in $botProcs) {
    if ($p -and -not $p.HasExited) { $p.Kill() }
  }
}
