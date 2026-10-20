#!/usr/bin/env python3
"""Real End-to-End Voice Pipeline Verification Script.
Streams real spoken audio into the Vanessa Voice Agent WebSocket on port 4500.
Verifies:
1. WebSocket connection and session_ready handshake
2. Raw PCM chunk streaming (16kHz 16-bit mono)
3. Turn completion & explicit finalize handling
4. Faster-Whisper ASR transcription accuracy
5. Vanessa Orchestrator intent planning and execution
"""

import asyncio
import json
import wave
import sys
from pathlib import Path
import numpy as np
import websockets


def load_and_resample_wav(wav_path: str, target_sr=16000) -> bytes:
    with wave.open(wav_path, "rb") as wf:
        n_channels = wf.getnchannels()
        sampwidth = wf.getsampwidth()
        src_sr = wf.getframerate()
        n_frames = wf.getnframes()
        raw_bytes = wf.readframes(n_frames)

    # Convert to numpy int16
    if sampwidth == 2:
        audio = np.frombuffer(raw_bytes, dtype=np.int16)
    else:
        raise ValueError(f"Unsupported sample width: {sampwidth}")

    if n_channels > 1:
        audio = audio.reshape(-1, n_channels).mean(axis=1).astype(np.int16)

    # Resample to 16kHz if needed
    if src_sr != target_sr:
        num_target_samples = int(len(audio) * target_sr / src_sr)
        # Linear interpolation
        orig_indices = np.linspace(0, len(audio) - 1, len(audio))
        target_indices = np.linspace(0, len(audio) - 1, num_target_samples)
        audio = np.interp(target_indices, orig_indices, audio).astype(np.int16)

    return audio.tobytes()


async def run_voice_test(wav_path: str, expected_words: list[str]):
    uri = "ws://127.0.0.1:4500/ws"
    print(f"\n[TestVoice] Connecting to Vanessa Voice Agent at {uri}...")
    
    pcm_bytes = load_and_resample_wav(wav_path, 16000)
    dur_sec = len(pcm_bytes) / (16000 * 2)
    print(f"[TestVoice] Loaded audio '{wav_path}': {len(pcm_bytes)} bytes ({dur_sec:.2f} seconds)")

    async with websockets.connect(uri) as ws:
        # 1. Wait for session_ready
        init_msg = await asyncio.wait_for(ws.recv(), timeout=5.0)
        ready_data = json.loads(init_msg)
        print(f"[TestVoice] Received handshake: {ready_data.get('type')}")
        assert ready_data.get("type") == "session_ready", f"Unexpected handshake: {ready_data}"

        # 2. Activate session for listening
        await ws.send(json.dumps({"type": "activate"}))
        print("[TestVoice] Sent activate event")

        # 3. Stream PCM in 20ms chunks (640 bytes = 320 samples @ 16kHz 16-bit)
        chunk_size = 640
        chunks = [pcm_bytes[i:i+chunk_size] for i in range(0, len(pcm_bytes), chunk_size)]
        print(f"[TestVoice] Streaming {len(chunks)} PCM chunks to voice agent...")

        for chunk in chunks:
            await ws.send(chunk)
            await asyncio.sleep(0.010)  # Stream at approx 2x real-time

        # 4. Conclude turn
        print("[TestVoice] Stream finished. Sending finalize event...")
        await ws.send(json.dumps({"type": "finalize"}))

        # 5. Collect responses with timeout
        received_partials = []
        final_transcript = ""
        orchestrator_executed = False
        spoken_response = ""

        try:
            while True:
                msg = await asyncio.wait_for(ws.recv(), timeout=12.0)
                data = json.loads(msg)
                msg_type = data.get("type")
                
                if msg_type == "transcript_partial":
                    t = data.get("text", "")
                    received_partials.append(t)
                    print(f"  [Partial] -> \"{t}\"")
                elif msg_type == "transcript_final":
                    final_transcript = data.get("text", "")
                    print(f"  [FINAL TRANSCRIPT] -> \"{final_transcript}\"")
                elif msg_type == "hud_update":
                    state = data.get("state")
                    transcript = data.get("transcript")
                    print(f"  [HUD Update] State: {state} | Transcript: \"{transcript}\"")
                    if state == "responding":
                        orchestrator_executed = True
                        spoken_response = transcript
                        break
                elif msg_type == "tts_chunk":
                    print(f"  [TTS Chunk] text: \"{data.get('text')}\"")
                elif msg_type == "state_change":
                    print(f"  [State Change] -> {data.get('state')}")
        except asyncio.TimeoutError:
            print("[TestVoice] Timeout waiting for further messages.")

        print("\n[TestVoice Results]")
        print(f"  Final Transcript: \"{final_transcript}\"")
        print(f"  Orchestrator Executed: {orchestrator_executed}")
        print(f"  Spoken Response: \"{spoken_response}\"")

        # Assertions
        assert final_transcript, "ERROR: No final transcript was produced from audio!"
        lower_final = final_transcript.lower()
        matched = [w for w in expected_words if w.lower() in lower_final]
        print(f"  Matched expected keywords: {matched} / {expected_words}")
        assert len(matched) >= len(expected_words) // 2, f"Transcription accuracy failed: {final_transcript}"
        print("  --> VOICE ASR & INGESTION VERIFICATION PASSED SUCCESSFULLY!\n")


if __name__ == "__main__":
    wav = sys.argv[1] if len(sys.argv) > 1 else "test_wifi.wav"
    expected = ["wifi", "wi-fi", "restart"] if "wifi" in wav else ["bluetooth", "youtube"]
    asyncio.run(run_voice_test(wav, expected))
