import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { WebSocket, type RawData } from "ws";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MobileGateway } from "../core/mobileGateway.js";
import { MobileTaskEngine } from "../core/mobileTaskEngine.js";

async function withGateway(run: (url: string) => Promise<void>, settings: { maxPayloadBytes?: number; rateLimit?: number } = {}) {
  const gateway = new MobileGateway({
    host: "127.0.0.1",
    port: 0,
    getManifest: () => ({ version: "test-1", tools: [] }),
    submitTask: async () => ({ taskId: "00000000-0000-4000-8000-000000000002" }),
    ...settings,
  });
  const server = gateway.createServer();
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try { await run(`ws://127.0.0.1:${address.port}`); }
  finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
}

function request(url: string, body: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.once("error", reject);
    socket.once("open", () => socket.send(body));
    socket.once("message", (raw: RawData) => {
      try { resolve(JSON.parse(raw.toString()) as Record<string, unknown>); }
      catch (error) { reject(error); }
      finally { socket.close(); }
    });
  });
}

test("responds to ping and syncs the current tool manifest", async () => {
  await withGateway(async (url) => {
    const ping = await request(url, JSON.stringify({ v: 1, id: "00000000-0000-4000-8000-000000000001", type: "ping", sentAt: 10 }));
    assert.equal(ping.type, "ping");
    const manifest = await request(url, JSON.stringify({ v: 1, id: "00000000-0000-4000-8000-000000000003", type: "manifest.sync", manifestVersion: "request", tools: [] }));
    assert.equal(manifest.type, "manifest.sync");
    assert.equal(manifest.manifestVersion, "test-1");
  });
});

test("rejects malformed JSON, unknown types and a spoofed phone tier", async () => {
  await withGateway(async (url) => {
    assert.equal((await request(url, "{")).code, "INVALID_MESSAGE");
    const unknown = await request(url, JSON.stringify({ v: 1, id: "00000000-0000-4000-8000-000000000004", type: "task.run" }));
    assert.equal(unknown.code, "UNKNOWN_MESSAGE_TYPE");
    const unsupported = await request(url, JSON.stringify({ v: 2, id: "00000000-0000-4000-8000-000000000004", type: "ping", sentAt: 10 }));
    assert.equal(unsupported.code, "UNSUPPORTED_VERSION");
    const spoofed = await request(url, JSON.stringify({ v: 1, id: "00000000-0000-4000-8000-000000000005", type: "task.submit", idempotencyKey: "phone:1", tool: "open_app", args: { app: "chrome" }, createdAt: 10, tier: 0 }));
    assert.equal(spoofed.code, "INVALID_MESSAGE");
  });
});

test("checks message size before JSON parsing and rate limits a device", async () => {
  await withGateway(async (url) => {
    const tooLarge = await request(url, "x".repeat(80));
    assert.equal(tooLarge.code, "PAYLOAD_TOO_LARGE");
  }, { maxPayloadBytes: 64 });

  await withGateway(async (url) => {
    const first = await request(url, JSON.stringify({ v: 1, id: "00000000-0000-4000-8000-000000000006", type: "ping", sentAt: 10 }));
    assert.equal(first.type, "ping");
    const second = await request(url, JSON.stringify({ v: 1, id: "00000000-0000-4000-8000-000000000007", type: "ping", sentAt: 10 }));
    assert.equal(second.code, "RATE_LIMITED");
  }, { rateLimit: 1 });
});

test("survives 1,000 malformed and unknown messages and remains responsive", async () => {
  await withGateway(async (url) => {
    const socket = new WebSocket(url);
    await once(socket, "open");
    let replies = 0;
    const errors: string[] = [];
    socket.on("message", (raw: RawData) => {
      replies++;
      try { errors.push((JSON.parse(raw.toString()) as { code?: string }).code ?? ""); } catch { errors.push("invalid-response"); }
    });
    for (let i = 0; i < 1000; i++) socket.send(i % 2 ? "{" : JSON.stringify({ type: `unknown-${i}`, data: i }));
    const deadline = Date.now() + 5000;
    while (replies < 1000 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(replies, 1000);
    assert.ok(errors.every((code) => code === "INVALID_MESSAGE" || code === "UNKNOWN_MESSAGE_TYPE"));
    socket.send(JSON.stringify({ v: 1, id: "00000000-0000-4000-8000-000000000011", type: "ping", sentAt: 10 }));
    while (replies < 1001 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(replies, 1001);
    socket.close();
  }, { rateLimit: 1500 });
});

test("gateway submits to the PC engine and streams its verified result", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vanessa-gateway-e2e-"));
  let gateway: MobileGateway;
  const engine = new MobileTaskEngine({ dbPath: path.join(dir, "tasks.db"), notify: ({ task, ephemeralResult }) => gateway?.publishTask({ ...task, ...(ephemeralResult !== undefined ? { ephemeralResult } : {}) }) });
  gateway = new MobileGateway({
    host: "127.0.0.1", port: 0, getManifest: () => engine.getManifest(),
    submitTask: (message, clientId) => engine.submit({ requestId: message.id, idempotencyKey: message.idempotencyKey, tool: message.tool, args: message.args, deviceId: clientId }),
    cancelTask: (taskId) => engine.cancel(taskId), confirmTask: (message) => engine.confirm(message),
  });
  const server = gateway.createServer();
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}`);
  await once(socket, "open");
  const messages: Array<Record<string, unknown>> = [];
  const waiters: Array<(message: Record<string, unknown>) => void> = [];
  socket.on("message", (raw: RawData) => {
    const message = JSON.parse(raw.toString()) as Record<string, unknown>;
    const waiter = waiters.shift();
    if (waiter) waiter(message); else messages.push(message);
  });
  const readMessage = () => messages.length ? Promise.resolve(messages.shift()!) : new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Gateway did not respond in time.")), 3000);
    waiters.push((message) => { clearTimeout(timer); resolve(message); });
  });
  try {
    socket.send(JSON.stringify({ v: 1, id: "00000000-0000-4000-8000-000000000020", type: "manifest.sync", manifestVersion: "client", tools: [] }));
    const manifest = await readMessage();
    assert.equal(manifest.type, "manifest.sync");
    const tools = manifest.tools as Array<{ name: string; tier: number }>;
    assert.ok(tools.some((tool) => tool.name === "system_status" && tool.tier === 0));
    socket.send(JSON.stringify({ v: 1, id: "00000000-0000-4000-8000-000000000021", type: "task.submit", idempotencyKey: "e2e:status-1", tool: "system_status", args: {}, createdAt: Date.now() }));
    const accepted = await readMessage();
    assert.equal(accepted.type, "task.accepted");
    const progressStates: string[] = [];
    let result = await readMessage();
    while (result.type === "task.progress") {
      progressStates.push(String(result.state));
      result = await readMessage();
    }
    assert.equal(result.type, "task.result", JSON.stringify(result));
    assert.ok(progressStates.includes("running"));
    assert.ok(progressStates.includes("verifying"));
    assert.equal((result.result as any)?.memory?.usedPercent >= 0, true);
    assert.ok(Number.isFinite((result.result as any)?.cpu?.usagePercent));
    const battery = (result.result as any)?.battery;
    assert.ok(battery === null || (battery.chargePercent >= 0 && battery.chargePercent <= 100));
    if (process.platform === "win32") {
      socket.send(JSON.stringify({ v: 1, id: "00000000-0000-4000-8000-000000000022", type: "task.submit", idempotencyKey: "e2e:screenshot-1", tool: "take_screenshot", args: {}, createdAt: Date.now() }));
      const screenshotAccepted = await readMessage();
      assert.equal(screenshotAccepted.type, "task.accepted");
      let screenshotResult = await readMessage();
      while (screenshotResult.type === "task.progress") screenshotResult = await readMessage();
      const screenshotTaskId = String(screenshotAccepted.taskId);
      assert.equal(engine.getTask(screenshotTaskId)?.result, undefined);
      if (screenshotResult.type === "task.result") {
        const image = screenshotResult.result as { mimeType?: string; data?: string; width?: number; height?: number };
        assert.equal(image.mimeType, "image/jpeg");
        assert.ok(image.data?.startsWith("/9j/"));
        assert.ok((image.data?.length ?? Infinity) <= 700_000);
        assert.equal(JSON.stringify(engine.recentAudit()).includes(image.data!), false);
      } else {
        assert.equal(screenshotResult.type, "task.error");
        assert.match(String(screenshotResult.message), /No interactive desktop capture is available/);
      }
    }
  } finally {
    socket.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    engine.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
