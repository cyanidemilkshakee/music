param([Parameter(Mandatory)][string]$Executable)
$ErrorActionPreference = 'Stop'
$taskExecutable = [IO.Path]::GetFullPath($Executable)
if (-not (Test-Path -LiteralPath $taskExecutable -PathType Leaf)) { throw 'Supply an existing Local Amp executable.' }
$taskTempRoot = [IO.Path]::GetFullPath($env:TEMP)
$taskTestDirectory = Join-Path $taskTempRoot ('LocalAmpLauncherQA-' + [Guid]::NewGuid().ToString('N'))
if (-not ([IO.Path]::GetFullPath($taskTestDirectory).StartsWith($taskTempRoot.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase))) { throw 'Launcher test directory must remain under TEMP.' }
New-Item -ItemType Directory -Path $taskTestDirectory | Out-Null
$taskLauncher = Join-Path $PSScriptRoot 'Launch-LocalAmp.ps1'
try {
    foreach ($taskBadPath in @('\\localhost\missing\backend.exe', '\\?\C:\missing\backend.exe', 'C:\missing\backend.exe:stream', 'backend.exe', 'C:\missing\..\backend.exe', 'C:\NUL.exe')) {
        $taskRejected = $false
        try { & $taskLauncher -NoBrowser -Executable $taskBadPath -DataDirectory $taskTestDirectory -Port 1 }
        catch {
            if ($_.Exception.Message -notmatch 'absolute local|device names|path was not found') { throw }
            $taskRejected = $true
        }
        if (-not $taskRejected) { throw 'Launcher accepted a remote, device, relative or alternate-stream executable path.' }
    }
    $taskLinkedDirectory = Join-Path $taskTestDirectory 'linked-executable-directory'
    New-Item -ItemType Junction -Path $taskLinkedDirectory -Target (Split-Path -Parent $taskExecutable) | Out-Null
    try {
        $taskRejected = $false
        try { & $taskLauncher -NoBrowser -Executable (Join-Path $taskLinkedDirectory (Split-Path -Leaf $taskExecutable)) -DataDirectory $taskTestDirectory -Port 1 }
        catch {
            if ($_.Exception.Message -notmatch 'symbolic links or junctions') { throw }
            $taskRejected = $true
        }
        if (-not $taskRejected) { throw 'Launcher followed a reparse-point executable ancestor.' }
    } finally { Remove-Item -LiteralPath $taskLinkedDirectory -Force }
    foreach ($taskAddress in @([Net.IPAddress]::Loopback, [Net.IPAddress]::Any)) {
        $taskListener = [Net.Sockets.TcpListener]::new($taskAddress, 0)
        $taskListener.Start()
        try {
            $taskRejected = $false
            try { & $taskLauncher -NoBrowser -Executable $taskExecutable -DataDirectory $taskTestDirectory -Port $taskListener.LocalEndpoint.Port }
            catch {
                if ($_.Exception.Message -notmatch 'another service|different executable') { throw }
                $taskRejected = $true
            }
            if (-not $taskRejected) { throw 'Launcher trusted a port owned by a different executable.' }
            if ($taskListener.Pending()) { throw 'Launcher connected to an untrusted service before checking the owning process.' }
        } finally { $taskListener.Stop() }
    }
    foreach ($taskArguments in @(@{SkipBuild=$true;RequireSignature=$true}, @{SkipBuild=$true;RequireSignature=$true;AllowUnsigned=$true})) {
        $taskRejected = $false
        try { & (Join-Path $PSScriptRoot 'Build-WindowsInstaller.ps1') @taskArguments -CertificateThumbprint '' }
        catch {
            if ($_.Exception.Message -notmatch 'requires a trusted|cannot be combined') { throw }
            $taskRejected = $true
        }
        if (-not $taskRejected) { throw 'Release packaging accepted a missing signing credential or conflicting unsigned option.' }
    }
    # Keep a known process listening while its credentials and launch page appear
    # later. No HTTP connection is needed to establish the process identity.
    $taskWorkerPath = Join-Path $taskTestDirectory 'delayed-launch-files.ps1'
    @'
param([string]$DataDirectory)
$ErrorActionPreference = 'Stop'
$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
$listener.Start()
try {
    $port = $listener.LocalEndpoint.Port
    $token = 'f' * 64
    @{processId=$PID;port=$port} | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $DataDirectory 'fixture-ready.json')
    @{app='LocalAmp';processId=0;port=$port;bootstrapToken=$token} | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $DataDirectory 'launch.json')
    Start-Sleep -Milliseconds 2500
    @{app='LocalAmp';processId=$PID;port=$port;bootstrapToken=$token} | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $DataDirectory 'launch.json')
    Start-Sleep -Milliseconds 2500
    '<meta http-equiv="refresh" content="0;url=http://127.0.0.1:' + $port + '/#local-amp=' + $token + '">' | Set-Content -LiteralPath (Join-Path $DataDirectory 'launch.html')
    while (-not (Test-Path -LiteralPath (Join-Path $DataDirectory 'fixture-stop'))) { Start-Sleep -Milliseconds 100 }
    if ($listener.Pending()) { throw 'Launcher contacted the fixture over HTTP.' }
} finally { $listener.Stop() }
'@ | Set-Content -LiteralPath $taskWorkerPath -Encoding UTF8
    $taskPowerShell = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
    $taskWorkerError = Join-Path $taskTestDirectory 'fixture-error.log'
    $taskWorker = Start-Process -FilePath $taskPowerShell -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',('"' + $taskWorkerPath + '"'),'-DataDirectory',('"' + $taskTestDirectory + '"')) -WindowStyle Hidden -PassThru -RedirectStandardError $taskWorkerError -RedirectStandardOutput (Join-Path $taskTestDirectory 'fixture.log')
    try {
        $taskFixtureReady = Join-Path $taskTestDirectory 'fixture-ready.json'
        for ($taskAttempt = 0; $taskAttempt -lt 200 -and -not (Test-Path -LiteralPath $taskFixtureReady); $taskAttempt++) {
            if ($taskWorker.HasExited) { throw ('Delayed-launch fixture exited: ' + (Get-Content -LiteralPath $taskWorkerError -Raw)) }
            Start-Sleep -Milliseconds 100
        }
        if (-not (Test-Path -LiteralPath $taskFixtureReady)) { throw 'Delayed-launch fixture did not start.' }
        $taskFixture = Get-Content -LiteralPath $taskFixtureReady -Raw | ConvertFrom-Json
        if ([int]$taskFixture.processId -ne $taskWorker.Id) { throw 'Wrong delayed-launch fixture process.' }
        & $taskLauncher -NoBrowser -Executable $taskPowerShell -DataDirectory $taskTestDirectory -Port $taskFixture.port
        if (-not (Test-Path -LiteralPath (Join-Path $taskTestDirectory 'launch.html'))) { throw 'Launcher finished before its matching launch page was ready.' }
        New-Item -ItemType File -Path (Join-Path $taskTestDirectory 'fixture-stop') | Out-Null
        if (-not $taskWorker.WaitForExit(5000) -or $taskWorker.ExitCode -ne 0) { throw 'Delayed-launch fixture failed.' }
    } finally {
        if (-not $taskWorker.HasExited) { $taskWorker | Stop-Process -Force }
    }
    $taskRealDataDirectory = Join-Path $taskTestDirectory 'real-data'
    $taskPortProbe = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    $taskPortProbe.Start()
    $taskRealPort = $taskPortProbe.LocalEndpoint.Port
    $taskPortProbe.Stop()
    $taskRealProcessId = 0
    try {
        & $taskLauncher -NoBrowser -Executable $taskExecutable -DataDirectory $taskRealDataDirectory -Port $taskRealPort
        $taskRealCredential = Get-Content -LiteralPath (Join-Path $taskRealDataDirectory 'launch.json') -Raw | ConvertFrom-Json
        $taskRealProcessId = [int]$taskRealCredential.processId
        $taskRealHeaders = @{'x-local-amp-token'=$taskRealCredential.bootstrapToken}
        $taskRealUrl = 'http://127.0.0.1:' + $taskRealPort
        $taskSession = Invoke-RestMethod ($taskRealUrl + '/api/session') -Headers $taskRealHeaders
        if ($taskSession.app -ne 'LocalAmp') { throw 'Real fixture authentication failed.' }
        foreach ($taskPrivatePath in @($taskRealDataDirectory, (Join-Path $taskRealDataDirectory 'launch.json'), (Join-Path $taskRealDataDirectory 'launch.html'))) {
            $taskAcl = Get-Acl -LiteralPath $taskPrivatePath
            if (-not $taskAcl.AreAccessRulesProtected) { throw 'Private launch data still inherits access rules.' }
            foreach ($taskRule in $taskAcl.Access) {
                if ($taskRule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -notin @('S-1-5-18', 'S-1-3-4')) {
                    throw 'Private launch data grants access outside SYSTEM and owner rights.'
                }
            }
        }
        & $taskLauncher -NoBrowser -Executable $taskExecutable -DataDirectory $taskRealDataDirectory -Port $taskRealPort
        $taskRelaunchCredential = Get-Content -LiteralPath (Join-Path $taskRealDataDirectory 'launch.json') -Raw | ConvertFrom-Json
        if ([int]$taskRelaunchCredential.processId -ne $taskRealProcessId) { throw 'Relaunch replaced the running fixture process.' }
        Invoke-RestMethod ($taskRealUrl + '/api/shutdown') -Method Post -Headers $taskRealHeaders | Out-Null
        $taskRealProcess = Get-Process -Id $taskRealProcessId -ErrorAction SilentlyContinue
        if ($taskRealProcess -and -not $taskRealProcess.WaitForExit(10000)) { throw 'Real fixture did not shut down gracefully.' }
    } finally {
        if (-not $taskRealProcessId) {
            $taskFixtureListeners = @(Get-NetTCPConnection -LocalPort $taskRealPort -State Listen -ErrorAction SilentlyContinue)
            if ($taskFixtureListeners.Count -eq 1) { $taskRealProcessId = $taskFixtureListeners[0].OwningProcess }
        }
        if ($taskRealProcessId) {
            $taskRealProcess = Get-Process -Id $taskRealProcessId -ErrorAction SilentlyContinue
            if ($taskRealProcess -and [StringComparer]::OrdinalIgnoreCase.Equals($taskRealProcess.Path, $taskExecutable)) { $taskRealProcess | Stop-Process -Force }
        }
    }
    Write-Output 'PASS: invalid paths and foreign listeners rejected before HTTP access; delayed launch files awaited; real server authentication, private ACLs, relaunch and graceful shutdown; unsigned release packaging rejected.'
} finally {
    $taskResolvedTestDirectory = [IO.Path]::GetFullPath($taskTestDirectory)
    if (-not $taskResolvedTestDirectory.StartsWith($taskTempRoot.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe launcher test cleanup path.' }
    Remove-Item -LiteralPath $taskResolvedTestDirectory -Recurse -Force
}
