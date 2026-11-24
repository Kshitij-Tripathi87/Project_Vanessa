import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { WebSocket, type RawData } from "ws";
import { createVoiceAgentServer } from "../server.js";
import { VanessaVoiceSession } from "../session/voiceSession.js";

test("text Buffer control frames activate/finalize; only binary frames reach audio", async () => {
  const calls: string[] = [];
  const prototype = VanessaVoiceSession.prototype;
  const original = {
    activateSession: prototype.activateSession,
    finalizeTurn: prototype.finalizeTurn,
    processAudioChunk: prototype.processAudioChunk,
    handleFinalUtterance: prototype.handleFinalUtterance,
  };
  prototype.activateSession = async () => { calls.push("activate"); };
  prototype.finalizeTurn = () => { calls.push("finalize"); };
  prototype.processAudioChunk = async () => { calls.push("audio"); };
  prototype.handleFinalUtterance = async (text, language, turnId, alreadyAccepted) => {
    calls.push(`text:${text}:${language}:${turnId}:${alreadyAccepted}`);
  };
  const app = await createVoiceAgentServer();
  try {
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    assert(address && typeof address !== "string");
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws`, {
      origin: "vanessa://desktop",
    });
    await once(socket, "open");
    socket.send(JSON.stringify({ type: "activate" }));
    socket.send(JSON.stringify({ type: "finalize" }));
    socket.send(Buffer.alloc(640), { binary: true });
    socket.send(JSON.stringify({ type: "transcript_final", text: "open the project folder", language: "en", turnId: "desktop-test-turn" }));
    const deadline = Date.now() + 1000;
    while (calls.length < 4 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.deepEqual(calls, ["activate", "finalize", "audio", "text:open the project folder:en:desktop-test-turn:true"]);
    const closed = once(socket, "close");
    socket.close();
    await closed;
  } finally {
    await app.close();
    Object.assign(prototype, original);
  }
});


test("voice WebSocket accepts bounded shared conversation context before capture", async () => {
  const app = await createVoiceAgentServer();
  let socket: WebSocket | undefined;
  try {
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    assert(address && typeof address !== "string");
    socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws`, {
      origin: "vanessa://desktop",
    });
    await once(socket, "open");

    const waitForType = (type: string) => new Promise<Record<string, unknown>>((resolve, reject) => {
      const timeout = setTimeout(() => {
        socket?.off("message", onMessage);
        reject(new Error(`Timed out waiting for ${type}`));
      }, 1500);
      const onMessage = (data: RawData) => {
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(data.toString()) as Record<string, unknown>;
        } catch {
          return;
        }
        if (message.type !== type) return;
        clearTimeout(timeout);
        socket?.off("message", onMessage);
        resolve(message);
      };
      socket?.on("message", onMessage);
    });

    const validAck = waitForType("conversation_context_ready");
    socket.send(JSON.stringify({
      type: "conversation_context",
      turns: [
        { role: "user", content: "Previous question" },
        { role: "assistant", content: "Previous answer" },
      ],
    }));
    assert.equal((await validAck).type, "conversation_context_ready");

    const invalidAck = waitForType("conversation_context_rejected");
    socket.send(JSON.stringify({
      type: "conversation_context",
      turns: [{ role: "system", content: "not a valid conversation turn" }],
    }));
    const rejection = await invalidAck;
    assert.equal(rejection.type, "conversation_context_rejected");

    const closed = once(socket, "close");
    socket.close();
    await closed;
  } finally {
    if (socket && socket.readyState === WebSocket.OPEN) socket.close();
    await app.close();
  }
});

test("built application origin can connect to voice but unrelated origins are rejected", async () => {
  const previousDevMode = process.env.VANESSA_DEV_MODE;
  delete process.env.VANESSA_DEV_MODE;
  const app = await createVoiceAgentServer();
  try {
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    assert(address && typeof address !== "string");
    const url = `ws://127.0.0.1:${address.port}/ws`;
    const allowed = new WebSocket(url, { origin: "vanessa://desktop" });
    const ready = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Application-origin voice session did not become ready.")), 1500);
      allowed.on("message", (data) => {
        if (JSON.parse(data.toString()).type === "session_ready") { clearTimeout(timeout); resolve(); }
      });
    });
    await once(allowed, "open");
    await ready;
    const closed = once(allowed, "close");
    allowed.close();
    await closed;

    for (const origin of ["vanessa://desktop.evil", "http://example.invalid", "http://127.0.0.1:5173", "http://localhost:5173", "null"]) {
      const denied = new WebSocket(url, { origin });
      const closing = once(denied, "close");
      const [code] = await closing;
      assert.equal(code, 1008, origin);
    }
  } finally {
    await app.close();
    if (previousDevMode === undefined) delete process.env.VANESSA_DEV_MODE;
    else process.env.VANESSA_DEV_MODE = previousDevMode;
  }
});

test("wake-word pause is acknowledged with its request ID and never uses task cancellation", async () => {
  const prototype = VanessaVoiceSession.prototype;
  const originalPause = prototype.pauseWakeWordMonitor;
  let pauses = 0;
  prototype.pauseWakeWordMonitor = () => { pauses++; return true; };
  const app = await createVoiceAgentServer();
  let socket: WebSocket | undefined;
  try {
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    assert(address && typeof address !== "string");
    socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws`, { origin: "vanessa://desktop" });
    const id = "11111111-1111-4111-8111-111111111111";
    const ack = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("wake-word pause acknowledgement timed out")), 1500);
      socket!.on("message", (data) => {
        const message = JSON.parse(data.toString()) as Record<string, unknown>;
        if (message.type === "wake_word_paused") { clearTimeout(timeout); resolve(message); }
      });
    });
    await once(socket, "open");
    socket.send(JSON.stringify({ type: "pause_wake_word", requestId: "invalid" }));
    socket.send(JSON.stringify({ type: "pause_wake_word", requestId: id }));
    assert.deepEqual(await ack, { type: "wake_word_paused", requestId: id, ok: true });
    assert.equal(pauses, 1);
    const closed = once(socket, "close");
    socket.close();
    await closed;
  } finally {
    if (socket && socket.readyState === WebSocket.OPEN) socket.close();
    await app.close();
    prototype.pauseWakeWordMonitor = originalPause;
  }
});

test("development voice origin is allowed only when explicitly enabled", async () => {
  const before = process.env.VANESSA_DEV_MODE;
  process.env.VANESSA_DEV_MODE = "1";
  const app = await createVoiceAgentServer();
  try {
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    assert(address && typeof address !== "string");
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws`, { origin: "http://127.0.0.1:5173" });
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Development voice session did not become ready.")), 1500);
      socket.on("message", (data) => {
        if (JSON.parse(data.toString()).type === "session_ready") { clearTimeout(timer); resolve(); }
      });
    });
    await once(socket, "open");
    await ready;
    const closed = once(socket, "close");
    socket.close();
    await closed;
  } finally {
    await app.close();
    if (before === undefined) delete process.env.VANESSA_DEV_MODE;
    else process.env.VANESSA_DEV_MODE = before;
  }
});
