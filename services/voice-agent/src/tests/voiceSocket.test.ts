import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { WebSocket } from "ws";
import { createVoiceAgentServer } from "../server.js";
import { VanessaVoiceSession } from "../session/voiceSession.js";

test("text Buffer control frames activate/finalize; only binary frames reach audio", async () => {
  const calls: string[] = [];
  const prototype = VanessaVoiceSession.prototype;
  const original = {
    activateSession: prototype.activateSession,
    finalizeTurn: prototype.finalizeTurn,
    processAudioChunk: prototype.processAudioChunk,
  };
  prototype.activateSession = async () => { calls.push("activate"); };
  prototype.finalizeTurn = () => { calls.push("finalize"); };
  prototype.processAudioChunk = async () => { calls.push("audio"); };
  const app = await createVoiceAgentServer();
  try {
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    assert(address && typeof address !== "string");
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws`, {
      origin: "http://127.0.0.1:5173",
    });
    await once(socket, "open");
    socket.send(JSON.stringify({ type: "activate" }));
    socket.send(JSON.stringify({ type: "finalize" }));
    socket.send(Buffer.alloc(640), { binary: true });
    const deadline = Date.now() + 1000;
    while (calls.length < 3 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.deepEqual(calls, ["activate", "finalize", "audio"]);
    const closed = once(socket, "close");
    socket.close();
    await closed;
  } finally {
    await app.close();
    Object.assign(prototype, original);
  }
});
