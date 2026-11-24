// Preload before application imports: deterministic tests never load local keys
// or use the user's persistent memory. Fixtures use explicit loopback endpoints.
process.env.VANESSA_SKIP_DOTENV = "true";
process.env.VANESSA_MEMORY_DB = ":memory:";
process.env.VOICE_STRICT_CONFIG = "false";
process.env.FAKE = "1";
// Tests start with the same deny-by-default local routing as the application.
// A fixture that exercises hosted transport must inject its own explicit policy.
process.env.PLANNER_PROVIDER = "ollama";
process.env.CONVERSATION_PROVIDER = "ollama";
delete process.env.SARVAM_CHAT_PROVIDER;
process.env.VOICE_ASR_PROVIDER = "whisper";
process.env.VOICE_TTS_PROVIDER = "browser";
delete process.env.VOICE_PROVIDER;
process.env.VOICE_URL = "ws://127.0.0.1:9";
for (const key of Object.keys(process.env)) {
  if (/KEY|TOKEN|SECRET|PASSWORD/.test(key)) delete process.env[key];
}
process.env.SARVAM_API_KEY = "test-only-key";
process.env.SARVAM_ASR_MODEL = "saaras:v3-realtime";
process.env.SARVAM_TTS_MODEL = "bulbul:v4-flash";
process.env.SARVAM_TTS_SPEAKER = "test-speaker";
process.env.SARVAM_CHAT_MODEL = "test-chat-model";
process.env.SARVAM_CHAT_URL = "http://127.0.0.1:9/not-a-provider";
process.env.SARVAM_ASR_URL = "ws://127.0.0.1:9/not-a-provider";
process.env.SARVAM_TTS_URL = "ws://127.0.0.1:9/not-a-provider";
process.env.VOICE_BUDGET_CAP_INR = "0";
process.env.VOICE_BUDGET_PER_USER_CAP_INR = "0";
