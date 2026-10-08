param([string]$Installer = (Join-Path (Split-Path -Parent $PSScriptRoot) 'dist/LocalAmp-Setup-1.1.0.exe'))
$ErrorActionPreference = 'Stop'
$taskRegistry = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\{E5C7E521-FDF8-4E8E-9B74-E28043F95F19}_is1'
if (Test-Path -LiteralPath $taskRegistry) { throw 'A Local Amp installation already exists. Run this smoke test in a disposable Windows profile.' }
$taskTempRoot = [IO.Path]::GetFullPath($env:TEMP)
$taskTestRoot = Join-Path $taskTempRoot ('LocalAmpInstallerQA-' + [Guid]::NewGuid().ToString('N'))
$taskAppDirectory = Join-Path $taskTestRoot 'app with spaces'
$taskDataDirectory = Join-Path $taskTestRoot 'data'
if (-not ([IO.Path]::GetFullPath($taskTestRoot).StartsWith($taskTempRoot + '\', [StringComparison]::OrdinalIgnoreCase))) { throw 'Test directory must remain under TEMP.' }
New-Item -ItemType Directory -Path $taskTestRoot -Force | Out-Null
$taskListener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
$taskListener.Start()
$taskPort = $taskListener.LocalEndpoint.Port
$taskListener.Stop()
$taskUrl = "http://127.0.0.1:$taskPort"
$taskInstaller = [IO.Path]::GetFullPath($Installer)
function Install-TestApplication {
    $taskSetup = Start-Process -FilePath $taskInstaller -ArgumentList @('/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART','/NOICONS',('/DIR="' + $taskAppDirectory + '"'),('/GROUP="LocalAmp QA Temporary"'),('/LOG="' + (Join-Path $taskTestRoot 'install.log') + '"')) -WindowStyle Hidden -Wait -PassThru
    if ($taskSetup.ExitCode -ne 0) { throw "Installer failed with exit $($taskSetup.ExitCode). See $taskTestRoot." }
}
function Start-TestApplication {
    # Invoke in this host: Windows PowerShell waits for descendants of native
    # powershell.exe calls, which would also wait for the background server.
    & (Join-Path $taskAppDirectory 'Launch-LocalAmp.ps1') -NoBrowser -DataDirectory $taskDataDirectory -Port $taskPort
    $taskSession = Invoke-RestMethod "$taskUrl/api/session"
    if ($taskSession.app -ne 'LocalAmp' -or $taskSession.version -ne '1.1.0') { throw 'Wrong application/version responded.' }
    return $taskSession
}
function Stop-TestApplication {
    try {
        $taskSession = Invoke-RestMethod "$taskUrl/api/session" -TimeoutSec 2
        Invoke-RestMethod "$taskUrl/api/shutdown" -Method Post -Headers @{'x-local-amp-token'=$taskSession.token} -TimeoutSec 3 | Out-Null
    } catch { }
    $taskExecutable = Join-Path $taskAppDirectory 'LocalAmp.exe'
    for ($taskAttempt = 0; $taskAttempt -lt 100; $taskAttempt++) {
        $taskProcesses = @(Get-Process -Name LocalAmp -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $taskExecutable })
        if (-not $taskProcesses.Count) { return }
        Start-Sleep -Milliseconds 100
    }
    throw 'Installed server did not stop.'
}
try {
    Install-TestApplication
    foreach ($taskFile in @('LocalAmp.exe','Launch-LocalAmp.ps1','LICENSE','README.md','THIRD_PARTY_NOTICES.md','THIRD_PARTY_LICENSES.txt','RUST_STDLIB_LICENSES.html')) {
        if (-not (Test-Path -LiteralPath (Join-Path $taskAppDirectory $taskFile))) { throw "Missing installed file: $taskFile" }
    }
    $taskSession = Start-TestApplication
    $taskPage = Invoke-WebRequest "$taskUrl/" -UseBasicParsing
    if ($taskPage.Content -notmatch '<title>Local Amp') { throw 'Embedded frontend was not served.' }
    $taskCreated = Invoke-RestMethod "$taskUrl/api/playlists" -Method Post -ContentType 'application/json' -Headers @{'x-local-amp-token'=$taskSession.token} -Body '{"name":"Installer QA"}'
    if (-not $taskCreated.playlist.id) { throw 'Could not create test library data.' }
    Stop-TestApplication
    Install-TestApplication
    $taskSession = Start-TestApplication
    $taskState = Invoke-RestMethod "$taskUrl/api/state"
    if ($taskState.playlists.Count -ne 1 -or $taskState.playlists[0].name -ne 'Installer QA') { throw 'Upgrade lost test playlist data.' }
    $taskPidBefore = @(Get-Process -Name LocalAmp | Where-Object { $_.Path -eq (Join-Path $taskAppDirectory 'LocalAmp.exe') })[0].Id
    $null = Start-TestApplication
    $taskPidAfter = @(Get-Process -Name LocalAmp | Where-Object { $_.Path -eq (Join-Path $taskAppDirectory 'LocalAmp.exe') })[0].Id
    if ($taskPidBefore -ne $taskPidAfter) { throw 'Relaunch unexpectedly replaced the running server.' }
    Stop-TestApplication
    $taskDataHash = (Get-FileHash -LiteralPath (Join-Path $taskDataDirectory 'local-amp.db') -Algorithm SHA256).Hash
    $taskUninstaller = Join-Path $taskAppDirectory 'unins000.exe'
    $taskUninstall = Start-Process -FilePath $taskUninstaller -ArgumentList @('/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART') -WindowStyle Hidden -Wait -PassThru
    if ($taskUninstall.ExitCode -ne 0) { throw 'Uninstall failed.' }
    if (Test-Path -LiteralPath (Join-Path $taskAppDirectory 'LocalAmp.exe')) { throw 'Uninstall left application executable.' }
    if ((Get-FileHash -LiteralPath (Join-Path $taskDataDirectory 'local-amp.db') -Algorithm SHA256).Hash -ne $taskDataHash) { throw 'Uninstall changed test library data.' }
    if (Test-Path -LiteralPath $taskRegistry) { throw 'Uninstall left application registration.' }
    Write-Output "PASS: install, embedded frontend, data write, upgrade, relaunch, graceful shutdown, uninstall and data retention. Test data: $taskTestRoot"
} finally {
    Stop-TestApplication
}
