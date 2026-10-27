const fs = require("node:fs");
const { launcherConfig } = require("./launcher-config.cjs");

/**
 * Share the launcher's provider defaults with the readiness probe. Keeping
 * this projection in one place prevents diagnostics from reporting stale
 * Fish/Gemini defaults when the install is actually configured for local mode.
 */
function buildReadinessConfig(env = process.env, root = process.cwd(), exists = fs.existsSync) {
  const selected = launcherConfig(env, [], root, exists);
  return {
    asrProvider: selected.asr,
    ttsProvider: selected.tts,
    plannerProvider: selected.planner,
    conversationProvider: selected.conversation,
    usesLocalAsr: Boolean(selected.localAsr),
    localAsrUrl: selected.localAsr?.url || env.VOICE_URL || env.WHISPER_URL || "ws://127.0.0.1:4505",
    ttsFallback: selected.ttsFallback,
    missing: selected.missing,
  };
}

module.exports = { buildReadinessConfig };
