param([string]$Compiler = 'ISCC.exe', [switch]$SkipBuild)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
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
node (Join-Path $PSScriptRoot 'bundle-licenses.js') (Join-Path (Split-Path -Parent $taskCompiler.Source) 'license.txt')
if ($LASTEXITCODE -ne 0) { throw 'Third-party license generation failed.' }
& $taskCompiler.Source (Join-Path $PSScriptRoot 'windows-installer.iss')
if ($LASTEXITCODE -ne 0) { throw 'Installer compilation failed.' }
$taskInstaller = Join-Path $taskRoot 'dist/LocalAmp-Setup-1.1.0.exe'
$taskInstallerHash = Get-FileHash -LiteralPath $taskInstaller -Algorithm SHA256
($taskInstallerHash.Hash.ToLowerInvariant() + '  ' + (Split-Path -Leaf $taskInstaller)) | Set-Content -LiteralPath (Join-Path $taskRoot 'dist/SHA256SUMS.txt') -Encoding ascii
$taskInstallerHash | Format-List
