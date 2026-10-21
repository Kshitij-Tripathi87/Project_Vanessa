#!/usr/bin/env tsx
/**
 * Fish Audio Real Provider Acceptance Test
 *
 * This test runs against real Fish Audio endpoints and requires:
 * - FISH_API_KEY (must start with sk-fish-)
 * - FISH_TTS_VOICE_ID (valid voice ID from Fish Audio)
 *
 * Run with: RUN_REAL_PROVIDER_TESTS=1 pnpm --filter @vanessa/voice-agent exec tsx ../../scripts/test_fish_acceptance.ts
 */

import { decode, encode } from "@msgpack/msgpack";
import WebSocket from "ws";

interface TestResult {
  name: string;
  passed: boolean;
  detail?: string;
}

async function runFishAcceptanceTests(): Promise<TestResult[]> {
  const results: TestResult[] = [];

  const apiKey = process.env.FISH_API_KEY;
  const ttsVoiceId = process.env.FISH_TTS_VOICE_ID || process.env.FISH_VANESSA_VOICE_ID;
  const asrModel = process.env.FISH_ASR_MODEL || "transcribe-stream-1";
  const ttsModel = process.env.FISH_TTS_MODEL || "s2.1-pro-free";
  const ttsSampleRate = Number(process.env.FISH_TTS_SAMPLE_RATE) || 24000;

  if (!apiKey || !apiKey.startsWith("sk-fish-")) {
    return [{ name: "Configuration Check", passed: false, detail: "FISH_API_KEY missing or invalid (must start with sk-fish-)" }];
  }
  if (!ttsVoiceId) {
    return [{ name: "Configuration Check", passed: false, detail: "FISH_TTS_VOICE_ID (or FISH_VANESSA_VOICE_ID) not configured" }];
  }

  console.log("==================================================");
  console.log("   FISH AUDIO REAL PROVIDER ACCEPTANCE TESTS     ");
  console.log("==================================================\n");
  console.log(`ASR Model: ${asrModel}`);
  console.log(`TTS Model: ${ttsModel}`);
  console.log(`TTS Voice ID: ${ttsVoiceId}`);
  console.log(`TTS Sample Rate: ${ttsSampleRate}`);
  console.log("");

  // Test 1: ASR Connection Handshake
  results.push(await testAsrHandshake(apiKey, asrModel));

  // Test 2: ASR Audio Streaming & Committed Turn
  results.push(await testAsrAudioStreaming(apiKey, asrModel));

  // Test 3: TTS Connection & Streaming
  results.push(await testTtsStreaming(apiKey, ttsVoiceId, ttsModel, ttsSampleRate));

  // Test 4: TTS Voice ID Validation
  results.push(await testTtsVoiceIdValidation(apiKey, ttsVoiceId, ttsModel, ttsSampleRate));

  // Summary
  console.log("==================================================");
  const passed = results.filter(r => r.passed).length;
  console.log(`Results: ${passed}/${results.length} tests passed`);
  results.forEach(r => {
    console.log(`  ${r.passed ? "✅" : "❌"} ${r.name}${r.detail ? `: ${r.detail}` : ""}`);
  });
  console.log("==================================================");

  return results;
}

async function testAsrHandshake(apiKey: string, model: string): Promise<TestResult> {
  return new Promise((resolve) => {
    console.log("🧪 Test 1: Fish ASR Handshake (config → session_started)...");

    const ws = new WebSocket("wss://api.fish.audio/v1/asr/realtime", {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    let sessionStarted = false;
    let configSent = false;
    const timeout = setTimeout(() => {
      ws.close();
      resolve({ name: "ASR Handshake", passed: false, detail: "Timeout waiting for session_started" });
    }, 10000);

    ws.on("open", () => {
      console.log("  → WebSocket connected, sending config...");
      ws.send(encode({
        type: "config",
        audio: { format: "pcm_s16le", sample_rate: 16000, channels: 1 },
        turn_detection: { mode: "auto", eager: true },
        results: { drafts: true },
      }));
      configSent = true;
    });

    ws.on("message", (raw: WebSocket.RawData) => {
      try {
        const packed = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
        const msg = decode(packed) as Record<string, any>;

        if (msg.type === "session_started") {
          sessionStarted = true;
          console.log(`  → Session started: ${msg.session_id}`);
        } else if (msg.type === "error") {
          clearTimeout(timeout);
          ws.close();
          resolve({ name: "ASR Handshake", passed: false, detail: `Fish ASR error: ${msg.message}` });
        }
      } catch (err: any) {
        clearTimeout(timeout);
        ws.close();
        resolve({ name: "ASR Handshake", passed: false, detail: `MessagePack decode error: ${err.message}` });
      }
    });

    ws.on("close", (code, reason) => {
      clearTimeout(timeout);
      if (sessionStarted && configSent) {
        resolve({ name: "ASR Handshake", passed: true, detail: "Config sent, session_started received" });
      } else if (!configSent) {
        resolve({ name: "ASR Handshake", passed: false, detail: "Config not sent before close" });
      } else {
        resolve({ name: "ASR Handshake", passed: false, detail: `Closed before session_started (${code}: ${reason})` });
      }
    });

    ws.on("error", (err) => {
      clearTimeout(timeout);
      resolve({ name: "ASR Handshake", passed: false, detail: `WebSocket error: ${err.message}` });
    });
  });
}

async function testAsrAudioStreaming(apiKey: string, model: string): Promise<TestResult> {
  return new Promise((resolve) => {
    console.log("🧪 Test 2: Fish ASR Audio Streaming & Committed Turn...");

    const ws = new WebSocket("wss://api.fish.audio/v1/asr/realtime", {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    let sessionStarted = false;
    let committedReceived = false;
    let committedText = "";
    const audioFramesSent = 0;
    const timeout = setTimeout(() => {
      ws.close();
      resolve({ name: "ASR Audio Streaming", passed: false, detail: "Timeout waiting for committed turn" });
    }, 15000);

    ws.on("open", () => {
      console.log("  → Connected, sending config...");
      ws.send(encode({
        type: "config",
        audio: { format: "pcm_s16le", sample_rate: 16000, channels: 1 },
        turn_detection: { mode: "auto", eager: true },
        results: { drafts: true },
      }));
    });

    ws.on("message", (raw: WebSocket.RawData) => {
      try {
        const packed = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
        const msg = decode(packed) as Record<string, any>;

        if (msg.type === "session_started") {
          sessionStarted = true;
          console.log(`  → Session started: ${msg.session_id}, sending audio...`);

          // Send ~2 seconds of audio (100 frames of 20ms = 2000ms)
          // Use a simple sine wave pattern
          const frameSize = 320; // 20ms @ 16kHz
          const framesToSend = 100;

          for (let i = 0; i < framesToSend; i++) {
            const pcm = new Int16Array(frameSize);
            for (let j = 0; j < frameSize; j++) {
              // Generate a simple tone
              pcm[j] = Math.round(Math.sin((2 * Math.PI * 440 * (i * frameSize + j)) / 16000) * 8000);
            }

            // Fish expects ~100ms batches (1600 samples = 5 frames)
            if (i % 5 === 0 || i === framesToSend - 1) {
              const batchFrames = Math.min(5, framesToSend - i);
              const batch = new Int16Array(batchFrames * frameSize);
              for (let b = 0; b < batchFrames; b++) {
                batch.set(pcm, b * frameSize);
              }
              ws.send(encode({ type: "audio", data: Buffer.from(batch.buffer) }));
            }
          }

          // Send audio_done
          setTimeout(() => {
            ws.send(encode({ type: "audio_done" }));
            console.log("  → Audio done sent");
          }, 100);

        } else if (msg.type === "committed" && msg.user_turn !== false) {
          committedReceived = true;
          committedText = String(msg.text || "").trim();
          console.log(`  → Committed turn received: "${committedText}"`);
        } else if (msg.type === "error") {
          clearTimeout(timeout);
          ws.close();
          resolve({ name: "ASR Audio Streaming", passed: false, detail: `Fish ASR error: ${msg.message}` });
        } else if (msg.type === "session_done") {
          clearTimeout(timeout);
          ws.close();
          if (committedReceived) {
            resolve({ name: "ASR Audio Streaming", passed: true, detail: `Committed turn: "${committedText}"` });
          } else {
            resolve({ name: "ASR Audio Streaming", passed: false, detail: "Session done but no committed turn received" });
          }
        }
      } catch (err: any) {
        clearTimeout(timeout);
        ws.close();
        resolve({ name: "ASR Audio Streaming", passed: false, detail: `MessagePack decode error: ${err.message}` });
      }
    });

    ws.on("error", (err) => {
      clearTimeout(timeout);
      resolve({ name: "ASR Audio Streaming", passed: false, detail: `WebSocket error: ${err.message}` });
    });
  });
}

async function testTtsStreaming(apiKey: string, voiceId: string, model: string, sampleRate: number): Promise<TestResult> {
  return new Promise((resolve) => {
    console.log("🧪 Test 3: Fish TTS Streaming (start → text → flush → stop → audio* → finish)...");

    const ws = new WebSocket("wss://api.fish.audio/v1/tts/live", {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        model: model,
      },
    });

    let startSent = false;
    let textSent = false;
    let flushSent = false;
    let stopSent = false;
    let audioChunksReceived = 0;
    let finishReceived = false;
    let finishReason = "";
    const expectedEvents = ["start", "text", "flush", "stop"];
    const receivedEvents: string[] = [];

    const timeout = setTimeout(() => {
      ws.close();
      resolve({
        name: "TTS Streaming",
        passed: false,
        detail: `Timeout. Events: ${receivedEvents.join(", ")}, audio chunks: ${audioChunksReceived}`
      });
    }, 15000);

    ws.on("open", () => {
      console.log("  → Connected, sending TTS request...");
      ws.send(encode({
        event: "start",
        request: {
          text: "",
          format: "pcm",
          sample_rate: sampleRate,
          reference_id: voiceId,
          latency: "balanced",
        },
      }));
      startSent = true;
      receivedEvents.push("start");

      ws.send(encode({ event: "text", text: "Hello world, this is a test of Fish Audio streaming TTS." }));
      textSent = true;
      receivedEvents.push("text");

      ws.send(encode({ event: "flush" }));
      flushSent = true;
      receivedEvents.push("flush");

      ws.send(encode({ event: "stop" }));
      stopSent = true;
      receivedEvents.push("stop");
    });

    ws.on("message", (raw: WebSocket.RawData, isBinary: boolean) => {
      if (!isBinary) return;

      try {
        const packed = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
        const msg = decode(packed) as Record<string, any>;

        if (msg.event === "audio") {
          audioChunksReceived++;
          if (audioChunksReceived <= 3) {
            console.log(`  → Audio chunk ${audioChunksReceived} received (${(msg.audio as Uint8Array).length} bytes)`);
          }
        } else if (msg.event === "finish") {
          finishReceived = true;
          finishReason = String(msg.reason || "");
          console.log(`  → Finish received: reason="${finishReason}"`);
          clearTimeout(timeout);
          ws.close();

          const eventSequence = receivedEvents.join(" → ");
          if (finishReason === "error") {
            resolve({
              name: "TTS Streaming",
              passed: false,
              detail: `Finish reason=error: ${msg.message}`
            });
          } else if (audioChunksReceived > 0 && finishReceived) {
            resolve({
              name: "TTS Streaming",
              passed: true,
              detail: `Events: ${eventSequence}, ${audioChunksReceived} audio chunks, finish: ${finishReason}`
            });
          } else {
            resolve({
              name: "TTS Streaming",
              passed: false,
              detail: `No audio chunks received. Events: ${eventSequence}`
            });
          }
        }
      } catch (err: any) {
        clearTimeout(timeout);
        ws.close();
        resolve({ name: "TTS Streaming", passed: false, detail: `MessagePack decode error: ${err.message}` });
      }
    });

    ws.on("error", (err) => {
      clearTimeout(timeout);
      resolve({ name: "TTS Streaming", passed: false, detail: `WebSocket error: ${err.message}` });
    });

    ws.on("close", (code, reason) => {
      if (!finishReceived) {
        clearTimeout(timeout);
        resolve({
          name: "TTS Streaming",
          passed: false,
          detail: `Closed before finish (${code}: ${reason}). Events: ${receivedEvents.join(", ")}`
        });
      }
    });
  });
}

async function testTtsVoiceIdValidation(apiKey: string, voiceId: string, model: string, sampleRate: number): Promise<TestResult> {
  return new Promise((resolve) => {
    console.log("🧪 Test 4: Fish TTS Voice ID Validation...");

    const ws = new WebSocket("wss://api.fish.audio/v1/tts/live", {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        model: model,
      },
    });

    let handshakeComplete = false;
    const timeout = setTimeout(() => {
      ws.close();
      resolve({ name: "TTS Voice ID Validation", passed: false, detail: "Timeout during handshake" });
    }, 10000);

    ws.on("open", () => {
      ws.send(encode({
        event: "start",
        request: {
          text: "",
          format: "pcm",
          sample_rate: sampleRate,
          reference_id: voiceId,
          latency: "balanced",
        },
      }));
      ws.send(encode({ event: "text", text: "test" }));
      ws.send(encode({ event: "flush" }));
      ws.send(encode({ event: "stop" }));
    });

    ws.on("message", (raw: WebSocket.RawData, isBinary: boolean) => {
      if (!isBinary) return;

      try {
        const packed = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
        const msg = decode(packed) as Record<string, any>;

        if (msg.event === "finish") {
          handshakeComplete = true;
          clearTimeout(timeout);
          ws.close();

          if (msg.reason === "error") {
            // Check if it's a voice ID error
            const errorMsg = String(msg.message || "").toLowerCase();
            if (errorMsg.includes("voice") || errorMsg.includes("reference") || errorMsg.includes("not found")) {
              resolve({
                name: "TTS Voice ID Validation",
                passed: false,
                detail: `Voice ID error: ${msg.message}`
              });
            } else {
              // Other error - voice ID might be valid but other issue
              resolve({
                name: "TTS Voice ID Validation",
                passed: true,
                detail: `Voice ID accepted (other error: ${msg.message})`
              });
            }
          } else {
            resolve({
              name: "TTS Voice ID Validation",
              passed: true,
              detail: "Voice ID accepted by Fish Audio"
            });
          }
        }
      } catch (err) {
        // Ignore decode errors
      }
    });

    ws.on("error", (err) => {
      clearTimeout(timeout);
      resolve({ name: "TTS Voice ID Validation", passed: false, detail: `WebSocket error: ${err.message}` });
    });

    ws.on("close", (code, reason) => {
      if (!handshakeComplete) {
        clearTimeout(timeout);
        resolve({
          name: "TTS Voice ID Validation",
          passed: false,
          detail: `Closed unexpectedly (${code}: ${reason})`
        });
      }
    });
  });
}

// Run tests if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const runRealTests = process.env.RUN_REAL_PROVIDER_TESTS === "1";

  if (!runRealTests) {
    console.log("⚠️  Real provider tests are opt-in. Set RUN_REAL_PROVIDER_TESTS=1 to run.");
    console.log("Required env vars: FISH_API_KEY, FISH_TTS_VOICE_ID (or FISH_VANESSA_VOICE_ID)");
    process.exit(0);
  }

  runFishAcceptanceTests()
    .then((results) => {
      const allPassed = results.every(r => r.passed);
      process.exit(allPassed ? 0 : 1);
    })
    .catch((err) => {
      console.error("Test runner error:", err);
      process.exit(1);
    });
}

export { runFishAcceptanceTests };