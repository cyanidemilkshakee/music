param([switch]$NoBrowser, [string]$DataDirectory, [ValidateRange(1,65535)][int]$Port = 1111)
$ErrorActionPreference = 'Stop'
$taskAppDirectory = $PSScriptRoot
$taskDataDirectory = if ($DataDirectory) { [System.IO.Path]::GetFullPath($DataDirectory) } else { Join-Path $env:LOCALAPPDATA 'LocalAmp' }
New-Item -ItemType Directory -Path $taskDataDirectory -Force | Out-Null
$taskUrl = "http://127.0.0.1:$Port"
$taskReady = $false
try {
    $taskSession = Invoke-RestMethod -Uri "$taskUrl/api/session" -TimeoutSec 2
    $taskReady = $taskSession.app -eq 'LocalAmp' -and [bool]$taskSession.token
} catch { }
if (-not $taskReady) {
    $taskAppExecutable = Join-Path $taskAppDirectory 'LocalAmp.exe'
    if (-not (Test-Path -LiteralPath $taskAppExecutable)) { throw 'LocalAmp.exe is missing. Reinstall Local Amp.' }
    $env:DATA_DIR = $taskDataDirectory
    $env:HOST = '127.0.0.1'
    $env:PORT = [string]$Port
    $taskBundledFfmpeg = Join-Path $taskAppDirectory 'ffmpeg.exe'
    if (Test-Path -LiteralPath $taskBundledFfmpeg) {
        $env:FFMPEG_PATH = $taskBundledFfmpeg
        $env:FFPROBE_PATH = Join-Path $taskAppDirectory 'ffprobe.exe'
    }
    $taskServer = Start-Process -FilePath $taskAppExecutable -WorkingDirectory $taskAppDirectory -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $taskDataDirectory 'server.log') -RedirectStandardError (Join-Path $taskDataDirectory 'server-error.log')
    for ($taskAttempt = 0; $taskAttempt -lt 60; $taskAttempt++) {
        if ($taskServer.HasExited) { throw "Local Amp could not start. See $taskDataDirectory\server-error.log." }
        try {
            $taskSession = Invoke-RestMethod -Uri "$taskUrl/api/session" -TimeoutSec 1
            if ($taskSession.app -eq 'LocalAmp' -and $taskSession.token) { $taskReady = $true; break }
        } catch { }
        Start-Sleep -Milliseconds 250
    }
}
if (-not $taskReady) { throw "Local Amp did not start. See $taskDataDirectory\server-error.log." }
if (-not $NoBrowser) { Start-Process $taskUrl }
