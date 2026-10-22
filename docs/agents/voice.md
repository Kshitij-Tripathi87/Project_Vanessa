# Voice Agent Contract

**ID:** voice/session service. Fish Audio is the intended ASR/TTS provider.

## Pipeline
Microphone → VAD/turn manager → wake/session gate → Fish real-time ASR → partial transcript UI → committed utterance → contextualizer → planner/orchestrator → task progress → response composer → Fish streaming TTS → playback queue.

## Rules
- Draft/partial ASR updates UI only. Only committed turns can dispatch tasks.
- Correlate session, utterance, request, plan, task and spoken result IDs.
- Fish credentials stay in service/backend, never renderer/mobile bundles.
- Barge-in stops playback and clears queued audio; it does not automatically cancel task execution.
- Explicit task cancel and emergency stop use separate command paths.
- Preserve audio chunk ordering and clean sessions on interruption/reconnect.
- Provider failures must be visible; use only configured tested fallbacks.
- Always-listening mode needs clear UI state and privacy disclosure.

## Recovery
Bounded reconnect/backoff, circuit breaker, session deadline, TTS queue purge, push-to-talk fallback if wake detector fails. Never replay the last committed utterance automatically after reconnect.

## Tests
Draft vs commit, malformed frame, Fish disconnect, timeout, false turn, barge-in while task continues, actual cancellation, emergency stop, queue purge, provider status and opt-in live Fish acceptance.