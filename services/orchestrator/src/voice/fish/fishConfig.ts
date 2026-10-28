export const fishConfig = {
  asr: {
    model: "transcribe-1-pro",
    language: "auto",
  },
  tts: {
    model: "s2.1-pro",
    voiceId: process.env.FISH_VANESSA_VOICE_ID || "vanessa-female-v1",
    format: "mp3",
    latency: "balanced",
  },
  planner: {
    provider: process.env.PLANNER_PROVIDER || "openai",
    model: process.env.PLANNER_MODEL || "gpt-4o-mini",
    temperature: 0.1,
  },
};
