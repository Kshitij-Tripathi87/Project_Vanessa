import asyncio
import json
import av
import websockets

async def test_live_voice():
    print("1. Decoding test_audio.mp3 to 16kHz mono PCM...")
    container = av.open("test_audio.mp3")
    resampler = av.AudioResampler(format="s16", layout="mono", rate=16000)
    pcm_chunks = []
    for frame in container.decode(audio=0):
        for resampled in resampler.resample(frame):
            pcm_chunks.append(resampled.to_ndarray().tobytes())
    pcm_data = b"".join(pcm_chunks)
    print(f"   Decoded audio: {len(pcm_data)/32000:.2f} seconds ({len(pcm_data)} bytes)")

    print("2. Connecting to Vanessa Voice Agent at ws://127.0.0.1:4500/ws...")
    async with websockets.connect("ws://127.0.0.1:4500/ws") as ws:
        handshake = await ws.recv()
        print("   Handshake:", handshake)

        print("3. Streaming 20ms chunks (640 bytes) to Faster-Whisper...")
        CHUNK_SIZE = 640
        for i in range(0, len(pcm_data), CHUNK_SIZE):
            chunk = pcm_data[i:i+CHUNK_SIZE]
            if len(chunk) < CHUNK_SIZE:
                chunk += b"\x00" * (CHUNK_SIZE - len(chunk))
            await ws.send(chunk)
            await asyncio.sleep(0.015)

        print("4. Sending 800ms silence to trigger Turn Complete...")
        silence = b"\x00" * 640
        for _ in range(40):
            await ws.send(silence)
            await asyncio.sleep(0.015)

        print("5. Listening for Faster-Whisper transcript & Vanessa response...")
        for _ in range(15):
            try:
                resp = await asyncio.wait_for(ws.recv(), timeout=6.0)
                data = json.loads(resp)
                print(f"   [EVENT] {data.get('type')}: {data}")
                if data.get("type") == "hud_update" and data.get("transcript"):
                    print(f"\n>>> RECOGNIZED TEXT: \"{data.get('transcript')}\"")
                if data.get("type") == "tts_chunk":
                    print(f"\n>>> VANESSA SPOKEN REPLY: \"{data.get('text')}\"")
                    print(">>> SUCCESS: Real voice recognition & synthesis loop verified end-to-end!")
                    return
            except asyncio.TimeoutError:
                break

if __name__ == "__main__":
    asyncio.run(test_live_voice())
