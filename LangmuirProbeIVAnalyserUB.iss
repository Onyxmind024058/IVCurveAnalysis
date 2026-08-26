[Setup]
AppName=Langmuir_Probe_IV_Analyser_UB
AppVersion=1.1.2
AppPublisher=Universität Basel/ Paul Hiret
AppPublisherURL=mailto:paul.hiret@unibas.ch
DefaultDirName={pf}\Langmuir Probe IV Analyser UB
DefaultGroupName=Langmuir Probe IV Analyser UB
DisableProgramGroupPage=yes
OutputDir=installer
OutputBaseFilename=Langmuir_Probe_IV_Analyser_UB_setup
SetupIconFile=icon.ico
Compression=lzma
SolidCompression=yes
WizardStyle=modern

[Files]
Source: "dist\Langmuir_Probe_IV_Analyser_UB.exe"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs

[Icons]
Name: "{group}\Langmuir_Probe_IV_Analyser_UB"; Filename: "{app}\Langmuir_Probe_IV_Analyser_UB.exe"
Name: "{commondesktop}\Langmuir_Probe_IV_Analyser_UB"; Filename: "{app}\Langmuir_Probe_IV_Analyser_UB.exe"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "Create a desktop icon"; GroupDescription: "Additional icons:"

[Run]
Filename: "{app}\Langmuir_Probe_IV_Analyser_UB.exe"; Description: "Launch Langmuir Probe IV Analyser UB"; Flags: nowait postinstall skipifsilent
