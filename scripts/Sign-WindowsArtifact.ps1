param(
    [Parameter(Mandatory)][string]$Path,
    [Parameter(Mandatory)][ValidatePattern('^[A-Fa-f0-9]{40}$')][string]$CertificateThumbprint,
    [Parameter(Mandatory)][string]$SignTool,
    [string]$TimestampServer = 'http://timestamp.digicert.com'
)
$ErrorActionPreference = 'Stop'
$taskArtifact = [IO.Path]::GetFullPath($Path)
$taskSignTool = [IO.Path]::GetFullPath($SignTool)
if (-not (Test-Path -LiteralPath $taskArtifact -PathType Leaf) -or -not (Test-Path -LiteralPath $taskSignTool -PathType Leaf)) { throw 'Signing artifact or Windows SDK SignTool is missing.' }
$taskTimestampUri = [Uri]$TimestampServer
if (-not $taskTimestampUri.IsAbsoluteUri -or $taskTimestampUri.Scheme -notin @('http','https') -or $TimestampServer -match '[\s"$]') { throw 'Use an absolute HTTP(S) timestamp service URL.' }
$taskCertificate = Get-Item -LiteralPath (Join-Path 'Cert:\CurrentUser\My' $CertificateThumbprint)
if (-not $taskCertificate.HasPrivateKey -or $taskCertificate.Subject -eq $taskCertificate.Issuer -or $taskCertificate.NotBefore -gt (Get-Date) -or $taskCertificate.NotAfter -le (Get-Date) -or
    -not @($taskCertificate.EnhancedKeyUsageList | Where-Object { $_.ObjectId -eq '1.3.6.1.5.5.7.3.3' }).Count) {
    throw 'A current code-signing certificate with its private key is required. Self-signed development certificates are not accepted for release.'
}
$taskChain = [Security.Cryptography.X509Certificates.X509Chain]::new()
try {
    $taskChain.ChainPolicy.RevocationMode = [Security.Cryptography.X509Certificates.X509RevocationMode]::Online
    if (-not $taskChain.Build($taskCertificate)) { throw 'The signing certificate must chain to a trusted issuer and pass revocation verification.' }
} finally { $taskChain.Dispose() }
if ([IO.Path]::GetExtension($taskArtifact) -eq '.ps1') {
    $taskSignature = Set-AuthenticodeSignature -LiteralPath $taskArtifact -Certificate $taskCertificate -HashAlgorithm SHA256 -TimestampServer $TimestampServer
    if ($taskSignature.Status -ne 'Valid') { throw 'PowerShell launcher signing failed.' }
} else {
    & $taskSignTool sign /sha1 $CertificateThumbprint /fd SHA256 /tr $TimestampServer /td SHA256 $taskArtifact
    if ($LASTEXITCODE -ne 0) { throw 'Authenticode signing or timestamping failed.' }
}
& $taskSignTool verify /pa /all /tw $taskArtifact
if ($LASTEXITCODE -ne 0) { throw 'Authenticode signature or timestamp verification failed.' }
$taskVerifiedSignature = Get-AuthenticodeSignature -LiteralPath $taskArtifact
if ($taskVerifiedSignature.Status -ne 'Valid' -or $taskVerifiedSignature.SignerCertificate.Thumbprint -ne $CertificateThumbprint -or -not $taskVerifiedSignature.TimeStamperCertificate) {
    throw 'The artifact must have a trusted timestamped signature from the requested certificate.'
}
