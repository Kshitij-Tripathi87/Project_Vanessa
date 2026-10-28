import { UsageBudget } from "@vanessa/shared";

let sharedVoiceBudget: UsageBudget | undefined;

/**
 * Keep ASR and TTS reservations in one trusted-process ledger so a hard cap
 * cannot be bypassed by opening both providers independently.
 */
export function getVoiceUsageBudget(): UsageBudget {
  if (!sharedVoiceBudget) {
    sharedVoiceBudget = new UsageBudget({
      capInr: Number(process.env.VOICE_BUDGET_CAP_INR || 0),
      perUserCapInr: Number(process.env.VOICE_BUDGET_PER_USER_CAP_INR || 0),
    });
  }
  return sharedVoiceBudget;
}

export function resetVoiceUsageBudgetForTests(): void {
  sharedVoiceBudget = undefined;
}
