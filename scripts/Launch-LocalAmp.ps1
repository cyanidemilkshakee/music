param(
    [switch]$NoBrowser,
    [string]$DataDirectory,
    [string]$Executable = (Join-Path $PSScriptRoot 'LocalAmp.exe'),
    [ValidateRange(1,65535)][int]$Port = 1111
)
$ErrorActionPreference = 'Stop'
function Resolve-LocalAmpPath([string]$taskPath, [switch]$AllowMissing) {
    # Reject remote/device namespaces before Test-Path can contact them.
    if ($taskPath -notmatch '^[A-Za-z]:[\\/]' -or $taskPath -match '[\x00-\x1f]' -or
        $taskPath.Substring(2).Contains(':') -or @($taskPath -split '[\\/]' | Where-Object { $_ -eq '..' }).Count) {
        throw 'Local Amp paths must use an absolute local drive path without device names, streams or parent traversal.'
    }
    $taskFullPath = [IO.Path]::GetFullPath($taskPath)
    $taskDrive = [IO.DriveInfo]::new([IO.Path]::GetPathRoot($taskFullPath))
    if ($taskDrive.DriveType -notin @([IO.DriveType]::Fixed, [IO.DriveType]::Removable, [IO.DriveType]::CDRom, [IO.DriveType]::Ram)) {
        throw 'Local Amp paths cannot use a network or unavailable drive.'
    }
    $taskComponents = $taskFullPath.Substring(3) -split '[\\/]'
    $taskCurrentPath = [IO.Path]::GetPathRoot($taskFullPath)
    foreach ($taskComponent in $taskComponents) {
        if (-not $taskComponent) { continue }
        if ($taskComponent.TrimEnd(' ', '.').Split('.')[0] -match '^(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$' -or $taskComponent -match '[ .]$') {
            throw 'Local Amp paths cannot contain Windows device names or ambiguous trailing characters.'
        }
        $taskCurrentPath = Join-Path $taskCurrentPath $taskComponent
        $taskPathItem = Get-Item -LiteralPath $taskCurrentPath -Force -ErrorAction SilentlyContinue
        if (-not $taskPathItem) {
            if ($AllowMissing) { continue }
            throw 'Local Amp path was not found.'
        }
        if (($taskPathItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw 'Local Amp paths cannot traverse symbolic links or junctions.'
        }
    }
    return $taskFullPath
}

$taskAppExecutable = Resolve-LocalAmpPath $Executable
if (-not (Test-Path -LiteralPath $taskAppExecutable -PathType Leaf)) { throw 'Local Amp executable is missing. Reinstall Local Amp or build the project.' }
$taskAppDirectory = Split-Path -Parent $taskAppExecutable
$taskDataDirectory = Resolve-LocalAmpPath $(if ($DataDirectory) { $DataDirectory } else { Join-Path $env:LOCALAPPDATA 'LocalAmp' }) -AllowMissing
New-Item -ItemType Directory -Path $taskDataDirectory -Force | Out-Null
$taskUrl = "http://127.0.0.1:$Port"
$taskOwnerSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value

function Get-VerifiedLocalAmpListener {
    $taskListeners = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
    if (-not $taskListeners.Count) { return $null }
    $taskListenerIds = @($taskListeners.OwningProcess | Select-Object -Unique)
    if ($taskListenerIds.Count -ne 1 -or @($taskListeners | Where-Object { $_.LocalAddress -ne '127.0.0.1' }).Count) {
        throw "Port $Port is already used by another service. Choose an unused Local Amp port."
    }
    $taskListenerProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$($taskListenerIds[0])"
    if (-not $taskListenerProcess -or -not $taskListenerProcess.ExecutablePath -or
        -not [StringComparer]::OrdinalIgnoreCase.Equals([IO.Path]::GetFullPath($taskListenerProcess.ExecutablePath), $taskAppExecutable)) {
        throw "Port $Port is already used by a different executable. Local Amp will not connect to it."
    }
    $taskProcessOwner = Invoke-CimMethod -InputObject $taskListenerProcess -MethodName GetOwnerSid
    if ($taskProcessOwner.ReturnValue -ne 0 -or $taskProcessOwner.Sid -ne $taskOwnerSid) {
        throw "Port $Port is owned by a different Windows user. Local Amp will not connect to it."
    }
    return [int]$taskListenerIds[0]
}

function Read-VerifiedLaunchCredential([int]$taskExpectedProcessId) {
    $taskCredentialPath = Join-Path $taskDataDirectory 'launch.json'
    if (-not (Test-Path -LiteralPath $taskCredentialPath -PathType Leaf)) { return $null }
    $taskCredentialFile = Get-Item -LiteralPath $taskCredentialPath
    if (($taskCredentialFile.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $taskCredentialFile.Length -gt 4096) {
        throw 'Local Amp launch credentials must be a regular private file.'
    }
    $taskCredential = Get-Content -LiteralPath $taskCredentialPath -Raw | ConvertFrom-Json
    if ($taskCredential.app -ne 'LocalAmp' -or [int]$taskCredential.processId -ne $taskExpectedProcessId -or [int]$taskCredential.port -ne $Port) {
        # A newly bound server can still be replacing the previous launch files.
        return $null
    }
    if ($taskCredential.bootstrapToken -isnot [string] -or $taskCredential.bootstrapToken -notmatch '^[a-f0-9]{64}$') {
        throw 'Local Amp launch credentials are invalid. Restart Local Amp.'
    }
    $taskLaunchPage = Join-Path $taskDataDirectory 'launch.html'
    if (-not (Test-Path -LiteralPath $taskLaunchPage -PathType Leaf)) { return $null }
    $taskLaunchFile = Get-Item -LiteralPath $taskLaunchPage
    if (($taskLaunchFile.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $taskLaunchFile.Length -gt 4096) {
        throw 'Local Amp launch page must be a regular private file.'
    }
    if (-not (Get-Content -LiteralPath $taskLaunchPage -Raw).Contains("url=http://127.0.0.1:$Port/#local-amp=$($taskCredential.bootstrapToken)")) { return $null }
    return $taskCredential
}

function Resolve-LocalAmpTool([string]$taskToolName, [string]$taskConfiguredPath) {
    if ($taskConfiguredPath) {
        $taskToolPath = Resolve-LocalAmpPath $taskConfiguredPath
        if (-not (Test-Path -LiteralPath $taskToolPath -PathType Leaf)) { throw "$taskToolName executable was not found." }
        return $taskToolPath
    }
    $taskBundledTool = Join-Path $taskAppDirectory ($taskToolName + '.exe')
    if (Test-Path -LiteralPath $taskBundledTool -PathType Leaf) { return Resolve-LocalAmpPath $taskBundledTool }
    # Never resolve executables from the current directory or a relative PATH entry.
    foreach ($taskPathEntry in ([string]$env:PATH).Split(';')) {
        $taskPathDirectory = $taskPathEntry.Trim(' ', '"')
        if (-not $taskPathDirectory) { continue }
        try { $taskPathDirectory = Resolve-LocalAmpPath $taskPathDirectory }
        catch { continue }
        if ([StringComparer]::OrdinalIgnoreCase.Equals($taskPathDirectory.TrimEnd('\\'), [IO.Path]::GetFullPath((Get-Location).Path).TrimEnd('\\'))) { continue }
        $taskCandidate = Join-Path $taskPathDirectory ($taskToolName + '.exe')
        if (Test-Path -LiteralPath $taskCandidate -PathType Leaf) {
            try { return Resolve-LocalAmpPath $taskCandidate }
            catch { continue }
        }
    }
    return $null
}

$taskListenerId = Get-VerifiedLocalAmpListener
if (-not $taskListenerId) {
    $env:DATA_DIR = $taskDataDirectory
    $env:HOST = '127.0.0.1'
    $env:PORT = [string]$Port
    $taskFfmpegPath = Resolve-LocalAmpTool 'ffmpeg' $env:FFMPEG_PATH
    $taskFfprobePath = Resolve-LocalAmpTool 'ffprobe' $env:FFPROBE_PATH
    if ($taskFfmpegPath) { $env:FFMPEG_PATH = $taskFfmpegPath }
    if ($taskFfprobePath) { $env:FFPROBE_PATH = $taskFfprobePath }
    $taskServer = Start-Process -FilePath $taskAppExecutable -WorkingDirectory $taskAppDirectory -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $taskDataDirectory 'server.log') -RedirectStandardError (Join-Path $taskDataDirectory 'server-error.log')
    for ($taskAttempt = 0; $taskAttempt -lt 60; $taskAttempt++) {
        if ($taskServer.HasExited) { throw "Local Amp could not start. See $taskDataDirectory\server-error.log." }
        $taskListenerId = Get-VerifiedLocalAmpListener
        if ($taskListenerId) {
            if ($taskListenerId -ne $taskServer.Id) { throw 'The listening process does not match the Local Amp process just started.' }
            break
        }
        Start-Sleep -Milliseconds 250
    }
}
if (-not $taskListenerId) { throw "Local Amp did not start. See $taskDataDirectory\server-error.log." }
$taskLaunchCredential = $null
for ($taskAttempt = 0; $taskAttempt -lt 60; $taskAttempt++) {
    if ((Get-VerifiedLocalAmpListener) -ne $taskListenerId) { throw 'Local Amp stopped before its launch credentials were ready.' }
    $taskLaunchCredential = Read-VerifiedLaunchCredential $taskListenerId
    if ($taskLaunchCredential) { break }
    Start-Sleep -Milliseconds 250
}
if (-not $taskLaunchCredential) { throw 'Local Amp private launch files are missing or do not match this server. Check the selected data directory and restart Local Amp.' }
if (-not $NoBrowser) {
    # Opening a private file keeps the credential out of browser process arguments.
    # Its redirect uses a fragment, which the interface immediately strips.
    $taskLaunchPage = Join-Path $taskDataDirectory 'launch.html'
    if (-not (Test-Path -LiteralPath $taskLaunchPage -PathType Leaf) -or
        ((Get-Item -LiteralPath $taskLaunchPage).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Local Amp private launch page is missing or invalid.' }
    Start-Process -FilePath $taskLaunchPage
}
