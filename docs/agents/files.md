# Files and Workspace Agent

**ID:** files. Supports scoped search/read/write, folder creation, rename, archive and approved Drive upload.

## Rules
- Enforce canonical source/destination allowlists; reject path traversal and symlink escapes.
- Return real paths and verify state after mutation.
- Don't create unrelated marker files when asked only to create a folder.
- Confirm destructive overwrites/deletes and external uploads as policy requires.
- Local file existence is not proof of Drive upload; verify remote file ID/link.
- Redact sensitive names/content in logs and speech.

## Tests
Create/read/rename/archive, out-of-root rejection, symlink escape, overwrite confirmation, missing source, archive integrity and remote upload confirmation.