import asyncio
import json
import logging
import os
import sys
import numpy as np
import websockets  # type: ignore
from faster_whisper import WhisperModel  # type: ignore

logging.basicConfig(
    level=logging.INFO,
    format="[%(asctime)s] [VoiceServer] %(levelname)s: %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("VoiceServer")

HOST = os.getenv("VOICE_HOST", os.getenv("WHISPER_HOST", "127.0.0.1"))
PORT = int(os.getenv("VOICE_PORT", os.getenv("WHISPER_PORT", "4505")))
MODEL_SIZE = os.getenv("VOICE_MODEL", os.getenv("WHISPER_MODEL", "tiny.en"))
DEVICE = os.getenv("VOICE_DEVICE", os.getenv("WHISPER_DEVICE", "cpu"))
COMPUTE_TYPE = os.getenv("VOICE_COMPUTE_TYPE", os.getenv("WHISPER_COMPUTE_TYPE", "int8"))

logger.info(f"Loading voice ASR model '{MODEL_SIZE}' on {DEVICE} ({COMPUTE_TYPE})...")
model = WhisperModel(MODEL_SIZE, device=DEVICE, compute_type=COMPUTE_TYPE)
logger.info("Voice ASR model loaded successfully and ready.")

SAMPLE_RATE = 16000
MIN_TRANSCRIBE_SAMPLES = int(0.4 * SAMPLE_RATE)  # at least 400ms to transcribe

async def handle_client(websocket):
    client_ip = websocket.remote_address
    logger.info(f"New client connected: {client_ip}")

    audio_buffer = np.zeros(0, dtype=np.float32)
    last_partial_time = asyncio.get_event_loop().time()
    last_speech_time = asyncio.get_event_loop().time()
    last_emitted_text = ""
    transcribe_lock = asyncio.Lock()

    try:
        async for message in websocket:
            now = asyncio.get_event_loop().time()

            if isinstance(message, bytes):
                # Incoming 16-bit 16kHz PCM audio chunk
                if len(message) % 2 != 0:
                    message = message[:-1]
                if len(message) > 0:
                    pcm_chunk = np.frombuffer(message, dtype=np.int16).astype(np.float32) / 32768.0
                    audio_buffer = np.concatenate((audio_buffer, pcm_chunk))

                    # Track active speech using RMS energy and peak amplitude
                    rms = float(np.sqrt(np.mean(pcm_chunk ** 2))) if len(pcm_chunk) > 0 else 0.0
                    peak = float(np.max(np.abs(pcm_chunk))) if len(pcm_chunk) > 0 else 0.0
                    is_active_speech = rms >= 0.003 or peak >= 0.008
                    if is_active_speech:
                        last_speech_time = now

                    # Cap maximum buffer to 12 seconds
                    if len(audio_buffer) > 12 * SAMPLE_RATE:
                        audio_buffer = audio_buffer[-12 * SAMPLE_RATE:]

                # Periodically transcribe partial audio when speech is detected
                has_enough = len(audio_buffer) >= int(0.4 * SAMPLE_RATE)
                is_recent_speech = (now - last_speech_time) < 0.80
                if has_enough and is_recent_speech and (now - last_partial_time) > 0.60 and not transcribe_lock.locked():
                    async with transcribe_lock:
                        try:
                            segments, info = model.transcribe(
                                audio_buffer,
                                beam_size=1,
                                language="en",
                                condition_on_previous_text=False,
                                vad_filter=False,
                            )
                            text = " ".join([seg.text.strip() for seg in segments]).strip()
                            if text and text != last_emitted_text:
                                last_emitted_text = text
                                logger.info(f"Partial Transcript: '{text}'")
                                await websocket.send(json.dumps({
                                    "text": text,
                                    "is_final": False,
                                    "language": info.language,
                                    "confidence": 0.9,
                                }))
                        except Exception as err:
                            logger.debug(f"Partial transcription error: {err}")
                        finally:
                            last_partial_time = asyncio.get_event_loop().time()

                # Auto-finalize turn if user spoke and then paused for > 850ms
                if last_emitted_text and (now - last_speech_time) > 0.85 and not transcribe_lock.locked():
                    async with transcribe_lock:
                        try:
                            # Final pass over full buffer for completeness
                            segments, info = model.transcribe(
                                audio_buffer,
                                beam_size=2,
                                language="en",
                                condition_on_previous_text=False,
                                vad_filter=False,
                            )
                            full_text = " ".join([seg.text.strip() for seg in segments]).strip()
                            out_text = full_text or last_emitted_text
                            logger.info(f"Silence detected. Auto-finalizing turn: '{out_text}'")
                            await websocket.send(json.dumps({
                                "text": out_text,
                                "is_final": True,
                                "language": "en",
                                "confidence": 0.95,
                            }))
                        except Exception as err:
                            logger.error(f"Error during auto-finalize: {err}")
                        finally:
                            audio_buffer = np.zeros(0, dtype=np.float32)
                            last_emitted_text = ""

                # Clear buffer if idle silence for > 3.0s and no transcript
                if len(audio_buffer) > 0 and (now - last_speech_time) > 3.0 and not last_emitted_text:
                    audio_buffer = np.zeros(0, dtype=np.float32)

            elif isinstance(message, str):
                try:
                    data = json.loads(message)
                    msg_type = data.get("type")

                    if msg_type in ("finalize", "final"):
                        dur = len(audio_buffer) / SAMPLE_RATE
                        logger.info(f"Explicit finalize received. Buffer duration: {dur:.2f}s")
                        if dur < 0.25 and not last_emitted_text:
                            # Skip truly empty buffer
                            audio_buffer = np.zeros(0, dtype=np.float32)
                            last_emitted_text = ""
                            continue

                        final_text = ""
                        async with transcribe_lock:
                            try:
                                if len(audio_buffer) >= int(0.25 * SAMPLE_RATE):
                                    segments, info = model.transcribe(
                                        audio_buffer,
                                        beam_size=2,
                                        language="en",
                                        condition_on_previous_text=False,
                                        vad_filter=False,
                                    )
                                    final_text = " ".join([seg.text.strip() for seg in segments]).strip()
                                else:
                                    final_text = last_emitted_text
                            except Exception as err:
                                logger.error(f"Transcribe error on finalize: {err}")
                                final_text = last_emitted_text

                            out_text = final_text or last_emitted_text
                            logger.info(f"Final Transcript Result: '{out_text}'")
                            if out_text:
                                await websocket.send(json.dumps({
                                    "text": out_text,
                                    "is_final": True,
                                    "language": "en",
                                    "confidence": 0.95,
                                }))
                        audio_buffer = np.zeros(0, dtype=np.float32)
                        last_emitted_text = ""

                    elif msg_type in ("reset", "activate"):
                        logger.info("Session reset/activate received.")
                        audio_buffer = np.zeros(0, dtype=np.float32)
                        last_emitted_text = ""

                except json.JSONDecodeError:
                    pass

    except websockets.exceptions.ConnectionClosed:
        logger.info(f"Client disconnected: {client_ip}")
    except Exception as e:
        logger.error(f"Error handling client {client_ip}: {e}")

async def main():
    logger.info(f"Starting Voice ASR WebSocket server on ws://{HOST}:{PORT}")
    while True:
        try:
            async with websockets.serve(handle_client, HOST, PORT, max_size=10 * 1024 * 1024):
                await asyncio.Future()  # run forever
        except Exception as e:
            logger.error(f"WebSocket server error: {e}, restarting in 2 seconds...")
            await asyncio.sleep(2)

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        logger.info("Voice server stopped by user.")
    except Exception as err:
        logger.error(f"Fatal error in voice server: {err}")
