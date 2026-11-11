import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { VanessaGateway } from "./gateway.js";
import { MessageSigner } from "./messageSecurity.js";
import crypto from "crypto";

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

test("Gateway: verifies message signatures when verifier provided", async () => {
  const signer = new MessageSigner();
  const secret = "test-secret";

  // Create a verifier that checks signatures. Identity comes from the
  // connection-level device id, never from a field in the message body.
  const verifier = async (deviceId: string, message: any) => {
    if (!message.signature || !message.nonce) return null;
    const result = signer.verify({
      payload: message,
      signature: message.signature,
      timestamp: message.timestamp,
      nonce: message.nonce
    }, secret);
    return result.valid ? deviceId : null;
  };

  const gateway = new VanessaGateway({ port: 0 }, verifier);
  await gateway.start();

  const port = gateway.getActualPort();
  const WebSocket = (await import('ws')).default;

  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise<void>((resolve) => ws.on('open', resolve));

  let unauthorized = false;
  let accepted = false;

  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.type === "task.accepted") {
      accepted = true;
    } else if (msg.type === "task.error" && msg.code === "UNAUTHORIZED_DEVICE") {
      unauthorized = true;
    }
  });

  // Send a message with a garbage signature that still passes schema
  // validation (signature is a non-empty string). The verifier should
  // recompute the HMAC and reject it as UNAUTHORIZED_DEVICE.
  const badPayload = {
    v: 1,
    id: crypto.randomUUID(),
    timestamp: Date.now(),
    type: "task.submit",
    tool: "system_status",
    args: { metric: "all" },
    idempotencyKey: "test",
    nonce: crypto.randomBytes(16).toString('hex')
  };
  // Sign with wrong secret so the HMAC won't match
  const { payload, signature, nonce } = signer.sign(badPayload, "wrong-secret");
  ws.send(JSON.stringify({ ...payload, signature, nonce }));

  await new Promise<void>(resolve => setTimeout(resolve, 200));

  // Send a validly-signed message. No tool execution is wired up in the
  // bare gateway, so it is accepted by the verifier but produces no accept.
  const goodMessage = {
    v: 1,
    id: crypto.randomUUID(),
    timestamp: Date.now(),
    type: "task.submit",
    tool: "system_status",
    args: { metric: "all" },
    idempotencyKey: "test2"
  };
  const goodSigned = signer.sign(goodMessage, secret);
  ws.send(JSON.stringify({ ...goodSigned.payload, signature: goodSigned.signature, nonce: goodSigned.nonce }));

  await new Promise<void>(resolve => setTimeout(resolve, 200));

  assert.equal(unauthorized, true, 'Bad signature should be rejected with UNAUTHORIZED_DEVICE');
  assert.equal(accepted, false, 'Bare gateway has no tool execution wired up');

  ws.close();
  await gateway.stop();
});

test("MessageSigner: signs and verifies messages", () => {
  const signer = new MessageSigner();
  const secret = "test-secret";
  const payload = { type: "test", data: "hello" };

  const signed = signer.sign(payload, secret);
  assert.ok(signed.signature);
  assert.ok(signed.nonce);
  assert.ok(signed.timestamp);

  const result = signer.verify(signed, secret);
  assert.equal(result.valid, true);
});

test("MessageSigner: rejects tampered messages", () => {
  const signer = new MessageSigner();
  const secret = "test-secret";
  const payload = { type: "test", data: "hello" };

  const signed = signer.sign(payload, secret);

  // Tamper with the payload
  const tampered = { ...signed, payload: { ...payload, data: "tampered" } };
  const result = signer.verify(tampered, secret);
  assert.equal(result.valid, false);
  assert.equal(result.error, "invalid_signature");
});

test("MessageSigner: rejects replayed nonces", () => {
  const signer = new MessageSigner();
  const secret = "test-secret";
  const payload = { type: "test", data: "hello" };

  const signed = signer.sign(payload, secret);

  // First verification should succeed
  const result1 = signer.verify(signed, secret);
  assert.equal(result1.valid, true);

  // Second verification with same nonce should fail
  const result2 = signer.verify(signed, secret);
  assert.equal(result2.valid, false);
  assert.equal(result2.error, "replayed_message");
});

test("MessageSigner: rejects stale messages (>60s)", () => {
  const signer = new MessageSigner({ maxMessageAge: 60000 });
  const secret = "test-secret";
  const payload = { type: "test", data: "hello" };

  // Create a message from 70 seconds ago
  const oldTimestamp = Date.now() - 70000;
  const oldSigned = {
    payload,
    signature: signer.sign(payload, secret).signature,
    timestamp: oldTimestamp,
    nonce: signer.sign(payload, secret).nonce
  };

  const result = signer.verify(oldSigned, secret);
  assert.equal(result.valid, false);
  assert.equal(result.error, "stale_message");
});

test("MessageSigner: rejects future messages (>5s skew)", () => {
  const signer = new MessageSigner();
  const secret = "test-secret";
  const payload = { type: "test", data: "hello" };

  // Create a message from 10 seconds in the future
  const futureTimestamp = Date.now() + 10000;
  const futureSigned = {
    payload,
    signature: signer.sign(payload, secret).signature,
    timestamp: futureTimestamp,
    nonce: signer.sign(payload, secret).nonce
  };

  const result = signer.verify(futureSigned, secret);
  assert.equal(result.valid, false);
  assert.equal(result.error, "stale_message");
});