# Focused Windows MVP checklist

- [x] Read applicable instructions (no AGENTS.md in repository/parent paths).
- [x] Fetch origin; feature baseline remains 04ad5ee572e136994709fae2b17ac01facd532f2.
- [x] Preserve original D:/projects/Project_Vanessa checkout unchanged, including local expansion and .idea. Capture status and hashes for final comparison.
- [x] Create attached worktree at C:/Users/Lenovo/.codex/worktrees/windows-agent-mvp/Project_Vanessa on feature/anshika-windows-agent-mvp.
- [x] Inspect baseline audio/executor/agent/permissions; keep generic executor, speaker audio, files/apps and Wi-Fi baseline untouched.
- [x] Add only verified brightness and Bluetooth radio helpers, selectively reusing prior fixes.
- [x] Replace baseline Bluetooth synthetic-success path; add focused aliases/approvals without planner/voice routing changes.
- [x] Add focused handoff, 11 expanded command examples and individual manual CLI, with explicit opt-in capture/restore tests.
- [x] Build/test from fresh real executor, dist-only, without shell-policy reliance: effective Restricted; read-only audio/display/radio passed.
- [x] Verify all 30 original work hashes/status unchanged and document test/deployment limits.

Automated results: 25 passed, 0 failed/skipped. User-supplied manual output later
verified persistent brightness at 40%, an already-On Bluetooth request and audio
readback. Radio transitions, audio mutations and full voice/planner integration
remain manual/unverified. No automated hardware or policy changes.

The user subsequently authorized commit/push and PR publication. No policy changes,
automated hardware mutations, merges, force-push or destructive cleanup.
