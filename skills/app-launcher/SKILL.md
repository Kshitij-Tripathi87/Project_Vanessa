---
name: app-launcher
description: Resolve application names, launch Windows GUI processes in user session, and verify window presence
agent: system
---

# App Launcher Skill

## Objective
Launch applications by common name (e.g., Chrome, VS Code, Notepad) in the active user session.

## Steps
1. Match application name against registered paths or PATH environment.
2. Launch executable using `Start-Process`.
3. Wait up to 3 seconds and verify process ID exists in `Get-Process`.
4. Return launch confirmation and window state.
