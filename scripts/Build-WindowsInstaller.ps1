param(
    [string]$Compiler = 'ISCC.exe',
    [switch]$SkipBuild,
    [switch]$AllowUnsigned,
    [switch]$RequireSignature,
    [string]$CertificateThumbprint = $env:LOCAL_AMP_SIGNING_THUMBPRINT,
    [string]$SignTool,
    [string]$TimestampServer = 'http://timestamp.digicert.com'
)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
if ($AllowUnsigned -and $RequireSignature) { throw '-AllowUnsigned cannot be combined with -RequireSignature.' }
if (-not $CertificateThumbprint -and -not $AllowUnsigned) { throw 'Release packaging requires a trusted code-signing certificate. Supply -CertificateThumbprint, or use -AllowUnsigned only for a local development installer.' }
if ($CertificateThumbprint -and $CertificateThumbprint -notmatch '^[A-Fa-f0-9]{40}$') { throw 'Use the 40-digit certificate thumbprint from Cert:\CurrentUser\My.' }
if (-not $SkipBuild) {
    Push-Location (Join-Path $taskRoot 'backend')
    try { node (Join-Path $PSScriptRoot 'build.js'); if ($LASTEXITCODE -ne 0) { throw 'Rust release build failed.' } }
    finally { Pop-Location }
}
node (Join-Path $PSScriptRoot 'check-windows-runtime.js')
if ($LASTEXITCODE -ne 0) { throw 'Windows executable runtime check failed.' }
$taskCompiler = Get-Command $Compiler -ErrorAction SilentlyContinue
if (-not $taskCompiler -and $Compiler -eq 'ISCC.exe') {
    foreach ($taskInnoRoot in @(${env:ProgramFiles}, ${env:ProgramFiles(x86)}, $env:LOCALAPPDATA)) {
        if (-not $taskInnoRoot) { continue }
        foreach ($taskInnoVersion in @(7, 6)) {
            $taskCandidate = Join-Path $taskInnoRoot "Inno Setup $taskInnoVersion/ISCC.exe"
            if (Test-Path -LiteralPath $taskCandidate) { $taskCompiler = Get-Command $taskCandidate; break }
        }
        if ($taskCompiler) { break }
    }
}
if (-not $taskCompiler) { throw 'Install the signed Inno Setup compiler from https://jrsoftware.org/isdl.php or supply -Compiler with its ISCC.exe path.' }
if ($taskCompiler.Source.StartsWith('\\')) { throw 'Use a local Inno Setup compiler executable.' }
$taskCompilerSignature = Get-AuthenticodeSignature -LiteralPath $taskCompiler.Source
if ($taskCompilerSignature.Status -ne 'Valid' -or $taskCompilerSignature.SignerCertificate.Subject -notmatch 'Pyrsys B\.V\.') { throw 'The Inno Setup compiler must have its valid official Pyrsys B.V. Authenticode signature.' }
# The official ISCC.exe has a 0.0.0.0 Windows version resource. Its verified
# engine reports the release version through the supported --version option.
$taskCompilerVersion = (& $taskCompiler.Source --version | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $taskCompilerVersion -ne '7.1.0') { throw "Use the verified Inno Setup 7.1.0 compiler; found $taskCompilerVersion." }
if ($CertificateThumbprint) {
    if (-not $SignTool) {
        $taskSdkRoot = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits/10/bin'
        if (Test-Path -LiteralPath $taskSdkRoot) {
            $taskSignToolCandidate = Get-ChildItem -LiteralPath $taskSdkRoot -Directory | Sort-Object Name -Descending | ForEach-Object { Join-Path $_.FullName 'x64/signtool.exe' } | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
            $SignTool = $taskSignToolCandidate
        }
    }
    if (-not $SignTool -or -not [IO.Path]::IsPathRooted($SignTool) -or $SignTool.StartsWith('\\')) { throw 'Supply an absolute local -SignTool path from the installed Windows SDK.' }
    $taskSignToolSignature = Get-AuthenticodeSignature -LiteralPath $SignTool
    if ($taskSignToolSignature.Status -ne 'Valid' -or $taskSignToolSignature.SignerCertificate.Subject -notmatch 'Microsoft Corporation') { throw 'Windows SDK SignTool must have a valid Microsoft signature.' }
}
node (Join-Path $PSScriptRoot 'bundle-licenses.js') (Join-Path (Split-Path -Parent $taskCompiler.Source) 'license.txt')
if ($LASTEXITCODE -ne 0) { throw 'Third-party license generation failed.' }
$taskStagingDirectory = Join-Path $taskRoot 'dist/packaging'
New-Item -ItemType Directory -Path $taskStagingDirectory -Force | Out-Null
$taskLauncher = Join-Path $taskStagingDirectory 'Launch-LocalAmp.ps1'
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'Launch-LocalAmp.ps1') -Destination $taskLauncher -Force
$taskCompilerArguments = @()
if ($CertificateThumbprint) {
    $taskSigner = Join-Path $PSScriptRoot 'Sign-WindowsArtifact.ps1'
    & $taskSigner -Path (Join-Path $taskRoot 'backend/target/x86_64-pc-windows-msvc/release/backend.exe') -CertificateThumbprint $CertificateThumbprint -SignTool $SignTool -TimestampServer $TimestampServer
    & $taskSigner -Path $taskLauncher -CertificateThumbprint $CertificateThumbprint -SignTool $SignTool -TimestampServer $TimestampServer
    $taskPowerShell = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
    if (@($taskPowerShell, $taskSigner, $SignTool, $TimestampServer) | Where-Object { $_ -match '["$\r\n]' }) { throw 'Signing command paths and timestamp URL contain unsupported command characters.' }
    $taskSigningCommand = '$q' + $taskPowerShell + '$q -NoProfile -ExecutionPolicy Bypass -File $q' + $taskSigner + '$q -Path $f -CertificateThumbprint ' + $CertificateThumbprint + ' -SignTool $q' + $SignTool + '$q -TimestampServer $q' + $TimestampServer + '$q'
    $taskCompilerArguments += '/DSignLocalAmp=1', ('/SLocalAmpVerifiedSign=' + $taskSigningCommand)
} else { Write-Warning 'Creating an unsigned local development installer. Do not publish this artifact.' }
$taskCompilerArguments += (Join-Path $PSScriptRoot 'windows-installer.iss')
& $taskCompiler.Source @taskCompilerArguments
if ($LASTEXITCODE -ne 0) { throw 'Installer compilation failed.' }
$taskInstaller = Join-Path $taskRoot 'dist/LocalAmp-Setup-1.1.0.exe'
if ($CertificateThumbprint) {
    $taskInstallerSignature = Get-AuthenticodeSignature -LiteralPath $taskInstaller
    if ($taskInstallerSignature.Status -ne 'Valid' -or $taskInstallerSignature.SignerCertificate.Thumbprint -ne $CertificateThumbprint -or -not $taskInstallerSignature.TimeStamperCertificate) { throw 'Release installer signature verification failed.' }
}
$taskInstallerHash = Get-FileHash -LiteralPath $taskInstaller -Algorithm SHA256
($taskInstallerHash.Hash.ToLowerInvariant() + '  ' + (Split-Path -Leaf $taskInstaller)) | Set-Content -LiteralPath (Join-Path $taskRoot 'dist/SHA256SUMS.txt') -Encoding ascii
$taskInstallerHash | Format-List
