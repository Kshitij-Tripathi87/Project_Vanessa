---
name: drive-upload
description: Compress target workspace directory into a zip archive and upload to Google Drive via Drive API
agent: files
---

# Drive Upload Skill

## Objective
Zip a project folder and upload it securely to Google Drive, returning a shareable link.

## Steps
1. Require user approval before uploading external files (Ask-First Gate).
2. Archive the directory excluding `.git` and `node_modules`.
3. Upload archive through Drive API.
4. Verify response contains valid `fileId` and `webViewLink`.
