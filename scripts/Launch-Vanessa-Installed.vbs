Option Explicit

Dim fso, shell, scriptsRoot, appRoot, configRoot, workspaceRoot
Dim verifyCommand, exitCode, showWindow
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
scriptsRoot = fso.GetParentFolderName(WScript.ScriptFullName)
appRoot = fso.GetParentFolderName(scriptsRoot)
configRoot = shell.ExpandEnvironmentStrings("%APPDATA%") & "\Vanessa"
workspaceRoot = shell.ExpandEnvironmentStrings("%USERPROFILE%") & "\Documents\Vanessa"
EnsureFolder configRoot
EnsureFolder workspaceRoot
With shell.Environment("PROCESS")
  .Item("VANESSA_CONFIG_HOME") = configRoot
  .Item("VANESSA_INSTALLED_MODE") = "1"
  .Item("VANESSA_WORKSPACE_ROOT") = workspaceRoot
End With
verifyCommand = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File " & Quote(appRoot & "\scripts\verify-local-setup.ps1")
exitCode = shell.Run(verifyCommand, 0, True)
showWindow = 0
If exitCode <> 0 Then showWindow = 1
shell.Run Quote(appRoot & "\Launch-Vanessa.bat"), showWindow, False
Function Quote(value)
  Quote = Chr(34) & value & Chr(34)
End Function
Sub EnsureFolder(folderPath)
  Dim parentPath
  If fso.FolderExists(folderPath) Then Exit Sub
  parentPath = fso.GetParentFolderName(folderPath)
  If Len(parentPath) > 0 And Not fso.FolderExists(parentPath) Then EnsureFolder parentPath
  If Not fso.FolderExists(folderPath) Then fso.CreateFolder folderPath
End Sub
