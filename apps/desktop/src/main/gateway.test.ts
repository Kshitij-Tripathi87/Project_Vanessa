import assert from "node:assert/strict";
import { test } from "node:test";
import { VanessaGateway, SignatureVerifier, PairingRedeemer } from "./gateway.js";
import { MessageSigner, canonicalJson, computeSignature } from "./messageSecurity.js";
import crypto from "crypto";

/** Build a protocol-valid task.submit message. */
function taskSubmit(overrides: Record<string, unknown> = {}) {
  return {
    v: 1 as const,
    id: crypto.randomUUID(),
    timestamp: Date.now(),
    type: "task.submit" as const,
    tool: "system_status",
    args: { metric: "all" },
    idempotencyKey: crypto.randomUUID(),
    nonce: crypto.randomBytes(16).toString("hex"),
    ...overrides,
  };
}

test("Gateway: starts and stops cleanly", async () => {
  const gateway = new VanessaGateway({ port: 0 }); // Use port 0 for auto-assignment
  await gateway.start();

  // Should be running
  assert.equal(gateway.getDeviceCount(), 0);

  await gateway.stop();
  // Should be stopped
});

test("Gateway: rejects connections over max limit", async () => {
  const gateway = new VanessaGateway({ port: 0, maxConnections: 1 });
  await gateway.start();

  const port = gateway.getActualPort();
  const WebSocket = (await import('ws')).default;

  const ws1 = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise<void>((resolve) => ws1.on('open', resolve));

  const ws2 = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise<void>((resolve) => ws2.on('close', resolve));

  assert.equal(ws2.readyState, WebSocket.CLOSED);

  ws1.close();
  await gateway.stop();
});

test("Gateway: handles ping/pong keepalive", async () => {
  const gateway = new VanessaGateway({ port: 0, pingInterval: 100 });
  await gateway.start();

  const port = gateway.getActualPort();
  const WebSocket = (await import('ws')).default;

  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise<void>((resolve) => ws.on('open', resolve));

  // Wait for a ping cycle
  await new Promise<void>(resolve => setTimeout(resolve, 200));

  ws.close();
  await gateway.stop();
});

test("Gateway: rejects oversized messages (1MB frame limit)", async () => {
  const gateway = new VanessaGateway({ port: 0 });
  await gateway.start();

  const port = gateway.getActualPort();
  const WebSocket = (await import('ws')).default;

  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise<void>((resolve) => ws.on('open', resolve));

  // Send a binary frame larger than the 1MB maxPayload. The ws library
  // enforces maxPayload at the frame layer and closes with 1009, before the
  // gateway ever parses the payload. This is the enforced size check — the
  // plan forbids parsing before checking size.
  ws.send(Buffer.alloc(2 * 1024 * 1024));

  let closedWith1009 = false;
  ws.on('close', (code) => {
    if (code === 1009) closedWith1009 = true;
  });

  await new Promise<void>((resolve) => ws.on('close', resolve));

  assert.equal(closedWith1009, true, 'Oversized frame should be rejected with 1009');

  await gateway.stop();
});

test("Gateway: rate limits messages per device", async () => {
  const gateway = new VanessaGateway({
    port: 0,
    maxMessagesPerSecond: 5
  });
  await gateway.start();

  const port = gateway.getActualPort();
  const WebSocket = (await import('ws')).default;

  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise<void>((resolve) => ws.on('open', resolve));

  let rateLimitedCount = 0;
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.type === "task.error" && msg.code === "RATE_LIMITED") {
      rateLimitedCount++;
    }
  });

  // Send 10 messages quickly
  for (let i = 0; i < 10; i++) {
    const message = JSON.stringify({
      v: 1,
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      type: "ping",
      sentAt: Date.now()
    });
    ws.send(message);
  }

  await new Promise<void>(resolve => setTimeout(resolve, 500));

  assert.ok(rateLimitedCount > 0, "Should have rate limited some messages");

  ws.close();
  await gateway.stop();
});

test("Gateway: verifies signatures against the paired device the socket claims", async () => {
  const signer = new MessageSigner();
  const secrets = new Map<string, string>([
    ["device_paired", "paired-secret"],
    ["device_other", "other-secret"],
  ]);

  const verifier: SignatureVerifier = async (deviceId, message) => {
    const secret = secrets.get(deviceId);
    if (!secret) return null;
    return signer.verify(message, secret).valid ? deviceId : null;
  };

  const gateway = new VanessaGateway({ port: 0 }, verifier);
  await gateway.start();

  const accepted: string[] = [];
  gateway.on("task-submit", ({ deviceId }: { deviceId: string }) => accepted.push(deviceId));

  const port = gateway.getActualPort();
  const WebSocket = (await import('ws')).default;

  const errors: string[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${port}/?device=device_paired`);
  await new Promise<void>((resolve) => ws.on('open', resolve));
  ws.on("message", (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.type === "task.error") errors.push(msg.code);
  });

  // 1. A message with no signature field fails schema validation outright:
  //    `signature` is required by task.submit, so it never reaches the verifier.
  ws.send(JSON.stringify(taskSubmit()));
  await new Promise<void>(resolve => setTimeout(resolve, 100));

  // 2. Signed with the wrong device's secret is rejected.
  const wrong = signer.sign(taskSubmit(), "other-secret");
  ws.send(JSON.stringify(wrong));
  await new Promise<void>(resolve => setTimeout(resolve, 100));

  // 3. Signed with this device's secret is accepted by the verifier and
  //    reaches the task handler. This is the behaviour the old contract made
  //    impossible: the signature is computed over the message minus
  //    `signature`, so verification can reproduce it.
  const good = signer.sign(taskSubmit(), "paired-secret");
  ws.send(JSON.stringify(good));
  await new Promise<void>(resolve => setTimeout(resolve, 100));

  assert.deepEqual(errors, ["INVALID_MESSAGE", "UNAUTHORIZED_DEVICE"]);
  assert.equal(accepted.length, 1, "Validly signed message should reach task handling");

  // 4. Replaying the same signed message is rejected.
  ws.send(JSON.stringify(good));
  await new Promise<void>(resolve => setTimeout(resolve, 100));
  assert.equal(errors.length, 3);
  assert.equal(errors[2], "UNAUTHORIZED_DEVICE");
  assert.equal(accepted.length, 1, "Replayed message must not be executed");

  ws.close();
  await gateway.stop();
});

test("Gateway: rejects signed messages when the socket claims no device", async () => {
  const signer = new MessageSigner();
  const verifier: SignatureVerifier = async (deviceId, message) =>
    signer.verify(message, "paired-secret").valid ? deviceId : null;

  const gateway = new VanessaGateway({ port: 0 }, verifier);
  await gateway.start();

  const port = gateway.getActualPort();
  const WebSocket = (await import('ws')).default;

  const errors: string[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise<void>((resolve) => ws.on('open', resolve));
  ws.on("message", (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.type === "task.error") errors.push(msg.code);
  });

  ws.send(JSON.stringify(signer.sign(taskSubmit(), "paired-secret")));
  await new Promise<void>(resolve => setTimeout(resolve, 150));

  assert.deepEqual(errors, ["UNAUTHORIZED_DEVICE"]);

  ws.close();
  await gateway.stop();
});

test("Gateway: POST /pair redeems a pairing code exactly once", async () => {
  const codes = new Map<string, { deviceId: string; secret: string }>([
    ["ABCD-1234", { deviceId: "device_new", secret: "fresh-secret" }],
  ]);

  let seenDeviceName: string | undefined;
  const redeemer: PairingRedeemer = async ({ pairingCode, deviceName }) => {
    seenDeviceName = deviceName;
    const grant = codes.get(pairingCode);
    if (!grant) return null;
    codes.delete(pairingCode); // single use
    return { ...grant, pcName: "Test-PC" };
  };

  const gateway = new VanessaGateway({ port: 0 }, undefined, redeemer);
  await gateway.start();
  const base = `http://127.0.0.1:${gateway.getActualPort()}`;

  const ok = await fetch(`${base}/pair`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pairingCode: "ABCD-1234", deviceName: "Pixel" }),
  });
  assert.equal(ok.status, 200);
  const grant = await ok.json() as { deviceId: string; secret: string; pcName?: string };
  assert.equal(grant.deviceId, "device_new");
  assert.equal(grant.secret, "fresh-secret");
  assert.equal(grant.pcName, "Test-PC");
  assert.equal(seenDeviceName, "Pixel");
  assert.equal(ok.headers.get("cache-control"), "no-store");

  // The same code cannot be redeemed twice.
  const reuse = await fetch(`${base}/pair`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pairingCode: "ABCD-1234" }),
  });
  assert.equal(reuse.status, 401);
  assert.deepEqual(await reuse.json(), { error: "invalid_or_expired_pairing_code" });

  // Unknown code looks identical to an expired one.
  const unknown = await fetch(`${base}/pair`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pairingCode: "ZZZZ-0000" }),
  });
  assert.equal(unknown.status, 401);

  // Malformed requests are rejected without reaching the redeemer.
  const badJson = await fetch(`${base}/pair`, { method: "POST", body: "{" });
  assert.equal(badJson.status, 400);
  const emptyCode = await fetch(`${base}/pair`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pairingCode: "   " }),
  });
  assert.equal(emptyCode.status, 400);

  // Only POST is accepted.
  const wrongMethod = await fetch(`${base}/pair`, { method: "GET" });
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get("allow"), "POST");

  await gateway.stop();
});

test("Gateway: /pair is unavailable without a pairing redeemer", async () => {
  const gateway = new VanessaGateway({ port: 0 });
  await gateway.start();
  const base = `http://127.0.0.1:${gateway.getActualPort()}`;

  const res = await fetch(`${base}/pair`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pairingCode: "ANY-CODE" }),
  });
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: "pairing_unavailable" });

  const health = await fetch(`${base}/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json() as any).pairing, "disabled");

  await gateway.stop();
});

test("Gateway: rate limits pairing attempts per address", async () => {
  const redeemer: PairingRedeemer = async () => null;
  const gateway = new VanessaGateway({ port: 0, pairingAttemptsPerMinute: 2 }, undefined, redeemer);
  await gateway.start();
  const base = `http://127.0.0.1:${gateway.getActualPort()}`;

  const attempt = () => fetch(`${base}/pair`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pairingCode: "WRONG" }),
  });

  assert.equal((await attempt()).status, 401);
  assert.equal((await attempt()).status, 401);
  const limited = await attempt();
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "60");

  await gateway.stop();
});

test("canonicalJson: key order does not change the signed bytes", () => {
  const a = { type: "test", timestamp: 1, nested: { b: 2, a: 1 }, list: [{ z: 1, y: 2 }] };
  const b = { list: [{ y: 2, z: 1 }], nested: { a: 1, b: 2 }, timestamp: 1, type: "test" };

  assert.equal(canonicalJson(a), canonicalJson(b));
  assert.equal(computeSignature(a, "secret"), computeSignature(b, "secret"));
  assert.equal(
    canonicalJson(a),
    '{"list":[{"y":2,"z":1}],"nested":{"a":1,"b":2},"timestamp":1,"type":"test"}'
  );
});

test("MessageSigner: signs and verifies messages", () => {
  const signer = new MessageSigner();
  const message = taskSubmit();

  const signed = signer.sign(message, "test-secret");
  assert.ok(signed.signature);
  assert.match(signed.signature, /^[0-9a-f]{64}$/);

  const result = signer.verify(signed, "test-secret");
  assert.equal(result.valid, true);
});

test("MessageSigner: does not sign over its own signature field", () => {
  const signer = new MessageSigner();
  const message = taskSubmit();

  const again = signer.sign({ ...message, signature: "ignored-value" }, "test-secret");
  assert.equal(again.signature, signer.sign(message, "test-secret").signature);
  assert.equal(signer.verify(again, "test-secret").valid, true);
});

test("MessageSigner: rejects tampered messages", () => {
  const signer = new MessageSigner();
  const message = taskSubmit();

  const signed = signer.sign(message, "test-secret");
  const tampered = { ...signed, tool: "shutdown_pc" };

  const result = signer.verify(tampered, "test-secret");
  assert.equal(result.valid, false);
  assert.equal(result.error, "invalid_signature");
});

test("MessageSigner: rejects messages signed with another secret", () => {
  const signer = new MessageSigner();
  const signed = signer.sign(taskSubmit(), "test-secret");

  const result = signer.verify(signed, "different-secret");
  assert.equal(result.valid, false);
  assert.equal(result.error, "invalid_signature");
});

test("MessageSigner: rejects replayed nonces", () => {
  const signer = new MessageSigner();
  const signed = signer.sign(taskSubmit(), "test-secret");

  assert.equal(signer.verify(signed, "test-secret").valid, true);

  const result2 = signer.verify(signed, "test-secret");
  assert.equal(result2.valid, false);
  assert.equal(result2.error, "replayed_message");
});

test("MessageSigner: rejects stale messages (>60s)", () => {
  const signer = new MessageSigner({ maxMessageAge: 60000 });
  const signed = signer.sign(taskSubmit({ timestamp: Date.now() - 70000 }), "test-secret");

  const result = signer.verify(signed, "test-secret");
  assert.equal(result.valid, false);
  assert.equal(result.error, "stale_message");
});

test("MessageSigner: rejects future messages (>5s skew)", () => {
  const signer = new MessageSigner();
  const signed = signer.sign(taskSubmit({ timestamp: Date.now() + 10000 }), "test-secret");

  const result = signer.verify(signed, "test-secret");
  assert.equal(result.valid, false);
  assert.equal(result.error, "stale_message");
});

test("MessageSigner: rejects messages without a timestamp", () => {
  const signer = new MessageSigner();
  const message = { type: "test" };
  const result = signer.verify({ ...message, signature: computeSignature(message, "s") }, "s");
  assert.equal(result.valid, false);
  assert.equal(result.error, "missing_timestamp");
});
