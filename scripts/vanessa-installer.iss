#ifndef RepoRoot
  #define RepoRoot ".."
#endif
#ifndef PayloadRoot
  #define PayloadRoot "{#RepoRoot}\artifacts\windows-installer-payload\Vanessa"
#endif
#ifndef OutputDirectory
  #define OutputDirectory "{#RepoRoot}\artifacts\windows-installer"
#endif
#define AppVersion "0.1.0"
[Setup]
AppId={{5F1F2ED0-77B1-442B-9C27-59D253BD15A9}
AppName=Vanessa
AppVersion={#AppVersion}
AppPublisher=Vanessa
AppComments=Voice-first desktop assistant
DefaultDirName={localappdata}\Programs\Vanessa
DefaultGroupName=Vanessa
PrivilegesRequired=lowest
ArchitecturesAllowed=x64
ArchitecturesInstallIn64BitMode=x64
MinVersion=10.0.22000
WizardStyle=modern
Compression=lzma2/ultra64
SolidCompression=yes
OutputDir={#OutputDirectory}
OutputBaseFilename=Vanessa-Setup-x64
SetupIconFile={#PayloadRoot}\apps\desktop\assets\vanessa.ico
UninstallDisplayIcon={app}\apps\desktop\assets\vanessa.ico
Uninstallable=yes
DisableProgramGroupPage=yes
CloseApplications=no
[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Additional shortcuts:"; Flags: unchecked
Name: "autostart"; Description: "Start Vanessa when I sign in (keeps wake-word listening available)"; GroupDescription: "Additional options:"; Flags: unchecked
[Files]
Source: "{#PayloadRoot}\.env.example"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#PayloadRoot}\*"; DestDir: "{app}"; Excludes: ".env.example"; Flags: ignoreversion recursesubdirs createallsubdirs
[Icons]
Name: "{autoprograms}\Vanessa"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\scripts\Launch-Vanessa-Installed.vbs"""; WorkingDir: "{app}"; IconFilename: "{app}\apps\desktop\assets\vanessa.ico"
Name: "{autodesktop}\Vanessa"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\scripts\Launch-Vanessa-Installed.vbs"""; WorkingDir: "{app}"; IconFilename: "{app}\apps\desktop\assets\vanessa.ico"; Tasks: desktopicon
Name: "{userstartup}\Vanessa"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\scripts\Launch-Vanessa-Installed.vbs"""; WorkingDir: "{app}"; IconFilename: "{app}\apps\desktop\assets\vanessa.ico"; Tasks: autostart
[Run]
Filename: "{sys}\wscript.exe"; Parameters: """{app}\scripts\Launch-Vanessa-Installed.vbs"""; Description: "Launch Vanessa"; Flags: postinstall nowait skipifsilent
[UninstallDelete]
; Per-user settings, logs and user-managed keys in AppData survive uninstall.
