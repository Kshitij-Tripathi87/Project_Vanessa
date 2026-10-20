---
name: folder-setup
description: Create directories within user-allowed workspace locations and verify existence
agent: system
---

# Folder Setup Skill

## Objective
Safely create directories and ensure permissions in authorized workspaces.

## Invariant
Only directories inside allowed paths (e.g., `Documents`, `Desktop`, project workspace) may be created. System folders (`C:\Windows`, `C:\Program Files`) are strictly prohibited.

## Steps
1. Normalize requested path against the workspace boundary.
2. Check if directory exists using `fs.existsSync` or PowerShell `Test-Path`.
3. If not, create directory with recursive parent creation: `New-Item -ItemType Directory -Path $dir -Force`.
4. Verify directory exists and is writable.
