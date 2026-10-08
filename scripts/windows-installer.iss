#ifndef AppVersion
  #define AppVersion "1.1.0"
#endif
[Setup]
AppId={{E5C7E521-FDF8-4E8E-9B74-E28043F95F19}
AppName=Local Amp
AppVersion={#AppVersion}
AppPublisher=Local Amp contributors
DefaultDirName={localappdata}\Programs\Local Amp
DefaultGroupName=Local Amp
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=..\dist
OutputBaseFilename=LocalAmp-Setup-{#AppVersion}
LicenseFile=..\LICENSE
InfoBeforeFile=..\docs\windows-install.txt
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
CloseApplications=yes
RestartApplications=no
UninstallDisplayName=Local Amp

[Files]
Source: "..\backend\target\x86_64-pc-windows-msvc\release\backend.exe"; DestDir: "{app}"; DestName: "LocalAmp.exe"; Flags: ignoreversion
Source: "Launch-LocalAmp.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\LICENSE"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\README.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\THIRD_PARTY_NOTICES.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\dist\THIRD_PARTY_LICENSES.txt"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\dist\RUST_STDLIB_LICENSES.html"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\Local Amp"; Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""{app}\Launch-LocalAmp.ps1"""; WorkingDir: "{app}"
Name: "{group}\Uninstall Local Amp"; Filename: "{uninstallexe}"

[Run]
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""{app}\Launch-LocalAmp.ps1"""; Description: "Open Local Amp"; Flags: postinstall nowait skipifsilent

; Per-user library data lives outside {app}. Uninstall intentionally retains it.
