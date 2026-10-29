# ==============================================================================
# ROSH Control Tower — Combined Load Test & WebRTC Quality Orchestrator
# ==============================================================================
# Coordinates run-load-test.mjs (10 simulated bots pushing RTSP) and Playwright
# (10 parallel browser sessions measuring WebRTC quality) for a full duration
# (default: 10 users for 10 minutes), ensuring bot connections remain active
# until Playwright finishes, then cleanly shuts down and generates both reports.
#
# Usage:
#   .\tools\run-combined-test.ps1                         # 10 bots, 600s (10 min), 10 workers
#   .\tools\run-combined-test.ps1 -DurationSeconds 120    # Quick 2-min verification
#   .\tools\run-combined-test.ps1 -Count 5 -Workers 5     # 5 bots, 5 workers
#   .\tools\run-combined-test.ps1 -SkipPreflight          # Bypass connectivity checks
# ==============================================================================
param(
  [int]$Count = 10,
  [int]$DurationSeconds = 600,
  [int]$Workers = 10,
  [switch]$SkipPreflight = $false
)

$ErrorActionPreference = 'Stop'
Set-Location (Resolve-Path "$PSScriptRoot\..").Path
$repoRoot = (Get-Location).Path

Write-Host "================================================================================" -ForegroundColor Cyan
Write-Host " ROSH Control Tower: Combined Load Test & Video Quality Orchestrator" -ForegroundColor Cyan
Write-Host "================================================================================" -ForegroundColor Cyan
Write-Host " Vehicles / Users : $Count"
Write-Host " Duration         : $DurationSeconds seconds ($([math]::Round($DurationSeconds / 60, 1)) minutes)"
Write-Host " Playwright Workers: $Workers"
Write-Host " Working Directory: $repoRoot"
Write-Host ""

# ------------------------------------------------------------------------------
# 1. Environment Configuration (.env.loadtest)
# ------------------------------------------------------------------------------
function Parse-EnvFile([string]$path) {
  $envMap = @{}
  if (Test-Path $path) {
    Get-Content $path | ForEach-Object {
      $line = $_.Trim()
      if ($line -and -not $line.StartsWith('#')) {
        $idx = $line.IndexOf('=')
        if ($idx -gt 0) {
          $k = $line.Substring(0, $idx).Trim()
          $v = $line.Substring($idx + 1).Trim().Trim('"').Trim("'")
          if ($v) { $envMap[$k] = $v }
        }
      }
    }
  }
  return $envMap
}

$envLoadTest = Parse-EnvFile (Join-Path $repoRoot '.env.loadtest')
$targetEnv = if ($envLoadTest['LOAD_TEST_ENV']) { $envLoadTest['LOAD_TEST_ENV'].ToLower() } else { 'local' }
$tailnetHost = if ($envLoadTest['TAILNET_HOST']) { $envLoadTest['TAILNET_HOST'] } else { '' }

$backendUrl = if ($targetEnv -eq 'dev' -and $tailnetHost) { "https://$tailnetHost" } else { 'http://localhost:3000' }
$brokerUrl = if ($targetEnv -eq 'dev' -and $tailnetHost) { "wss://$tailnetHost/mqtt" } else { 'mqtt://localhost:1883' }
$rtspBase = if ($targetEnv -eq 'dev' -and $tailnetHost) { "rtsp://${tailnetHost}:8554" } else { 'rtsp://localhost:8554' }
$whepBase = if ($targetEnv -eq 'dev' -and $tailnetHost) { "https://$tailnetHost/webrtc" } else { 'http://localhost:8889' }

Write-Host "Target Environment : $targetEnv"
Write-Host "Backend URL        : $backendUrl"
Write-Host "MQTT Broker        : $brokerUrl"
Write-Host "RTSP Ingest Base   : $rtspBase"
Write-Host "WHEP Playback Base : $whepBase"
Write-Host ""

# ------------------------------------------------------------------------------
# 2. Preflight Connectivity Checks
# ------------------------------------------------------------------------------
function Test-TcpPort([string]$hostName, [int]$port, [int]$timeoutMs = 3000) {
  try {
    $client = [System.Net.Sockets.TcpClient]::new()
    $asyncResult = $client.BeginConnect($hostName, $port, $null, $null)
    $success = $asyncResult.AsyncWaitHandle.WaitOne($timeoutMs, $false)
    if ($success) {
      $client.EndConnect($asyncResult)
      $client.Close()
      return $true
    }
    $client.Close()
    return $false
  } catch {
    return $false
  }
}

if (-not $SkipPreflight) {
  Write-Host "--- Performing Preflight Checks ---" -ForegroundColor Yellow
  
  # Check backend HTTP /health
  try {
    $res = Invoke-RestMethod -Uri "$backendUrl/health" -Method Get -TimeoutSec 5 -ErrorAction Stop
    Write-Host " [OK] Backend /health reachable ($backendUrl)" -ForegroundColor Green
  } catch {
    Write-Error "Backend /health failed ($backendUrl): $_`nPlease ensure Docker / backend service is running."
    exit 1
  }

  # Check MediaMTX ports (if local)
  if ($targetEnv -eq 'local') {
    if (Test-TcpPort '127.0.0.1' 8554) {
      Write-Host " [OK] MediaMTX RTSP port 8554 open" -ForegroundColor Green
    } else {
      Write-Error "MediaMTX RTSP port 8554 is closed. Start MediaMTX using 'bash tools/run-local-mediamtx.sh' or docker compose."
      exit 1
    }

    if (Test-TcpPort '127.0.0.1' 8889) {
      Write-Host " [OK] MediaMTX WHEP port 8889 open" -ForegroundColor Green
    } else {
      Write-Warning "MediaMTX WHEP port 8889 not responding on localhost (may be routed via Traefik)."
    }
  }

  Write-Host ""
}

# ------------------------------------------------------------------------------
# 3. Prepare Environment Variables for Child Processes
# ------------------------------------------------------------------------------
$vins = 1..$Count | ForEach-Object { 'TEST-VIN-{0:d3}' -f $_ }
$vinsCsv = $vins -join ','

$env:TEST_BOT_COUNT = "$Count"
$env:TEST_DURATION = "$DurationSeconds"
$env:TEST_VINS = "$vinsCsv"

$nodeExe = (Get-Command node -CommandType Application).Source
$npxCmd = (Get-Command npx.cmd -CommandType Application -ErrorAction SilentlyContinue)
if (-not $npxCmd) {
  $npxCmd = (Get-Command npx -CommandType Application).Source
} else {
  $npxCmd = $npxCmd.Source
}

# ------------------------------------------------------------------------------
# 4. Launch Load-Test Harness in Background
# ------------------------------------------------------------------------------
Write-Host "--- Step 1: Starting Load Test Harness (Spawning $Count Bots) ---" -ForegroundColor Yellow

# Buffer duration ensures bots do not shut down before Playwright completes
$harnessDuration = [int]$DurationSeconds + 600

$logFile = Join-Path $repoRoot "load-test-live.log"
$errFile = Join-Path $repoRoot "load-test-live.err"
$stopFile = Join-Path $repoRoot ".stop-load-test"
if (Test-Path $logFile) { Remove-Item $logFile -Force -ErrorAction SilentlyContinue }
if (Test-Path $errFile) { Remove-Item $errFile -Force -ErrorAction SilentlyContinue }
if (Test-Path $stopFile) { Remove-Item $stopFile -Force -ErrorAction SilentlyContinue }

$loadTestArgs = "tools/load-test/run-load-test.mjs --count $Count --duration $harnessDuration --video"

$loadTestProc = Start-Process -FilePath $nodeExe `
  -ArgumentList $loadTestArgs `
  -WorkingDirectory $repoRoot `
  -RedirectStandardOutput $logFile `
  -RedirectStandardError $errFile `
  -PassThru

$playwrightExitCode = 1

try {
  Write-Host "Waiting for all $Count bot video streams to report STREAMING..." -ForegroundColor Cyan

  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $isReady = $false

  while ($sw.Elapsed.TotalSeconds -lt 180 -and -not $loadTestProc.HasExited) {
    if (Test-Path $logFile) {
      $raw = Get-Content -Path $logFile -Raw -ErrorAction SilentlyContinue
      if ($raw) {
        if ($raw -match 'STREAMS READY:\s*(\d+)/(\d+)\s*streaming') {
          $isReady = $true
          Write-Host "[load-test] $matches[0]"
          break
        }
        $latest = ($raw -split "`r?`n" | Where-Object { $_ -match 'spawned|connected|handshake|streaming' } | Select-Object -Last 1)
        if ($latest) {
          Write-Host "[status: $([math]::Round($sw.Elapsed.TotalSeconds))s] $latest"
        }
      }
    }
    Start-Sleep -Seconds 1
  }

  if (-not $isReady) {
    if (Test-Path $logFile) { Get-Content $logFile -Tail 30 | ForEach-Object { Write-Host "[load-test:err] $_" -ForegroundColor Yellow } }
    Write-Error "Timed out waiting for STREAMS READY from load-test harness. Aborting."
    exit 1
  }

  Write-Host ""
  Write-Host ">>> All $Count streams are active on MediaMTX! <<<" -ForegroundColor Green
  Write-Host ""

  # ----------------------------------------------------------------------------
  # 5. Launch Playwright WebRTC Quality Test
  # ----------------------------------------------------------------------------
  Write-Host "--- Step 2: Launching Playwright WebRTC Quality Measurement ---" -ForegroundColor Yellow
  Write-Host "Measuring $Count streams concurrently for $DurationSeconds s with $Workers workers..."
  Write-Host ""

  $env:TEST_BOT_COUNT = "$Count"
  $env:TEST_DURATION = "$DurationSeconds"
  $env:TEST_VINS = "$vinsCsv"

  $projectArgs = @()
  foreach ($v in $vins) {
    $projectArgs += '--project'
    $projectArgs += "chromium-$($v.ToLower())"
  }

  # Run Playwright directly from repo root using root node_modules/playwright with explicit config
  $pwCli = Join-Path $repoRoot 'node_modules\@playwright\test\cli.js'
  & node $pwCli test webrtc-quality.spec.ts --config video-quality/playwright.config.ts @projectArgs --workers $Workers
  $playwrightExitCode = $LASTEXITCODE

  Write-Host ""
  if ($playwrightExitCode -eq 0) {
    Write-Host " [OK] Playwright live measurement completed successfully!" -ForegroundColor Green
  } else {
    Write-Warning "Playwright tests finished with exit code $playwrightExitCode (some checks may have flagged warnings)."
  }

} finally {
  # ----------------------------------------------------------------------------
  # 6. Synchronized Teardown of Load Test Bots
  # ----------------------------------------------------------------------------
  Write-Host ""
  Write-Host "--- Step 3: Playwright finished. Tearing down bot connections... ---" -ForegroundColor Yellow

  if ($loadTestProc -and -not $loadTestProc.HasExited) {
    try {
      # Drop stop signal file
      New-Item -Path $stopFile -ItemType File -Force -ErrorAction SilentlyContinue | Out-Null
    } catch {}

    # Wait up to 45 seconds for graceful teardown (STOP video + session-end + report writing)
    $graceful = $loadTestProc.WaitForExit(45000)
    if (-not $graceful) {
      Write-Warning "Harness did not exit within 45s. Forcing termination..."
      Stop-Process -Id $loadTestProc.Id -Force -ErrorAction SilentlyContinue
    }
  }
  if (Test-Path $stopFile) { Remove-Item $stopFile -Force -ErrorAction SilentlyContinue }
}

# ------------------------------------------------------------------------------
# 7. Generate Post-Run Reports
# ------------------------------------------------------------------------------
Write-Host ""
Write-Host "--- Step 4: Generating HTML Reports ---" -ForegroundColor Yellow

$videoQualityDir = Join-Path $repoRoot 'video-quality'
Push-Location $videoQualityDir
try {
  Write-Host "Building WebRTC interactive quality report (quality-report.html)..."
  & $nodeExe generate-report.mjs
} catch {
  Write-Warning "Failed to generate quality-report.html: $_"
} finally {
  Pop-Location
}

# Generate Unified Combined Report
try {
  Write-Host "Building Unified Combined Test Report (combined-test-report.html)..."
  & $nodeExe tools/generate-combined-report.mjs
} catch {
  Write-Warning "Failed to generate combined-test-report.html: $_"
}

# ------------------------------------------------------------------------------
# 8. Final Report Locations Summary
# ------------------------------------------------------------------------------
$combinedHtml = Join-Path $repoRoot 'combined-test-report.html'
$loadTestHtml = Join-Path $repoRoot 'load-test-report.html'
$loadTestJson = Join-Path $repoRoot 'load-test-report.json'
$webrtcReport = Join-Path $repoRoot 'video-quality\quality-report.html'
$pwReportIndex = Join-Path $repoRoot 'video-quality\playwright-report\index.html'

Write-Host ""
Write-Host "================================================================================" -ForegroundColor Green
Write-Host " TEST EXECUTION COMPLETE" -ForegroundColor Green
Write-Host "================================================================================" -ForegroundColor Green
Write-Host " ★ UNIFIED COMBINED REPORT: $combinedHtml" -ForegroundColor Yellow
Write-Host " ------------------------------------------------------------------------------"
Write-Host " Protocol Load Test (HTML): $loadTestHtml"
Write-Host " Protocol Load Test (JSON): $loadTestJson"
Write-Host " WebRTC Live Quality (HTML): $webrtcReport"
Write-Host " Playwright Test Run (HTML): $pwReportIndex"
Write-Host "================================================================================" -ForegroundColor Green
Write-Host ""
Write-Host "Open combined-test-report.html in any browser for the complete unified view!" -ForegroundColor Cyan

exit $playwrightExitCode
