import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { WebSocket } from "ws";
import { z } from "zod";
import {
  PRE_SESSION_ID,
  computeKeyId,
  createRemoteEnvelope,
  parseRemoteEnvelope,
  signRemoteEnvelope,
  verifyRemoteEnvelopeSignature,
  type RemoteEnvelope,
} from "@vanessa/protocol";
import { MobileTaskEngine } from "../core/mobileTaskEngine.js";
import type { MobileTool } from "../core/mobileToolRegistry.js";
import { RemotePairingRegistry } from "./remotePairingRegistry.js";
import { RemoteTaskService } from "./remoteTaskService.js";
import { RemoteWebSocketGateway } from "./remoteWebSocketGateway.js";

function makeIdentity() {
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const publicKeySpki = pair.publicKey.export({ format: "der", type: "spki" }).toString("base64url");
  return { ...pair, publicKeySpki, keyId: computeKeyId(pair.publicKey) };
}

function systemStatusTool(): MobileTool {
  const argsSchema = z.object({
    metric: z.enum(["battery", "cpu", "all"]).default("all"),
  }).strict();
  return {
    name: "system_status",
    description: "Read synthetic system status for a gateway integration test.",
    argsSchema,
    manifestSchema: {
      type: "object",
      properties: { metric: { type: "string", enum: ["battery", "cpu", "all"], default: "all" } },
      additionalProperties: false,
    },
    tier: 0,
    timeoutMs: 2_000,
    idempotent: true,
    queue: "read",
    handler: async ({ metric }: { metric: string }) => ({ metric, hostname: "integration-test-pc" }),
    verifier: async (_args: unknown, result: unknown) =>
      (result as { hostname?: unknown })?.hostname === "integration-test-pc",
  };
}

async function nextEnvelope(
  queue: RemoteEnvelope[],
  waiters: Array<(value: RemoteEnvelope) => void>,
  timeoutMs = 4_000,
): Promise<RemoteEnvelope> {
  const queued = queue.shift();
  if (queued) return queued;
  return new Promise<RemoteEnvelope>((resolve, reject) => {
    const timer = setTimeout(() => {
      const index = waiters.indexOf(onValue);
      if (index >= 0) waiters.splice(index, 1);
      reject(new Error("Timed out waiting for a signed remote-v2 envelope."));
    }, timeoutMs);
    const onValue = (value: RemoteEnvelope) => {
      clearTimeout(timer);
      resolve(value);
    };
    waiters.push(onValue);
  });
}

test("authenticated v2 WebSocket executes a PC task, returns verified output, and rejects replay", { timeout: 15_000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vanessa-remote-gateway-"));
  const phone = makeIdentity();
  const pc = makeIdentity();
  const now = Date.now();
  const registry = new RemotePairingRegistry({
    storePath: path.join(directory, "trusted-devices.json"),
    now: () => now,
  });
  await registry.initialize();

  let gateway: RemoteWebSocketGateway | undefined;
  const engine = new MobileTaskEngine({
    dbPath: path.join(directory, "tasks.db"),
    tools: [systemStatusTool()],
    notify: ({ task, deviceId, ephemeralResult }) => {
      gateway?.publishTask({ task, deviceId, ephemeralResult });
    },
  });

  const signer = {
    getIdentity: async () => ({
      keyId: pc.keyId,
      publicKeySpki: pc.publicKeySpki,
      pcId: "pc_integration_test",
      pcName: "Integration Test PC",
    }),
    sign: async (input: { type: any; payload: Record<string, unknown>; sessionId: string; sequence: number }) =>
      signRemoteEnvelope(pc.privateKey, createRemoteEnvelope({
        type: input.type,
        payload: input.payload,
        keyId: pc.keyId,
        sessionId: input.sessionId,
        sequence: input.sequence,
      })),
  };

  const pairingWindow = registry.createPairingWindow(now);
  const phoneClientNonce = randomBytes(24).toString("base64url");
  const claim = signRemoteEnvelope(phone.privateKey, createRemoteEnvelope({
    type: "pairing.claim",
    sessionId: PRE_SESSION_ID,
    keyId: phone.keyId,
    sequence: 0,
    sentAt: now,
    payload: {
      pairingId: pairingWindow.pairingId,
      code: pairingWindow.code,
      publicKey: phone.publicKeySpki,
      keyId: phone.keyId,
      deviceHint: "test-android",
      platform: "android",
      appVersion: "0.1.0",
      clientNonce: phoneClientNonce,
    },
  }));
  const pairChallenge = registry.claim(claim, now);
  const complete = signRemoteEnvelope(phone.privateKey, createRemoteEnvelope({
    type: "pairing.complete",
    sessionId: PRE_SESSION_ID,
    keyId: phone.keyId,
    sequence: 1,
    sentAt: now + 1,
    payload: {
      pairingId: pairingWindow.pairingId,
      challengeNonce: pairChallenge.nonce,
    },
  }));
  registry.complete(complete, now + 1);
  await registry.approve(pairingWindow.pairingId, ["system.read"], now + 2);

  const taskService = new RemoteTaskService(engine, registry);
  gateway = new RemoteWebSocketGateway({
    host: "127.0.0.1",
    port: 0,
    signer,
    pairings: registry,
    tasks: taskService,
  });

  try {
    await gateway.start();
    const socket = new WebSocket(`ws://127.0.0.1:${gateway.getActualPort()}/remote-v2`);
    const queue: RemoteEnvelope[] = [];
    const waiters: Array<(value: RemoteEnvelope) => void> = [];
    socket.on("message", (data) => {
      const envelope = parseRemoteEnvelope(JSON.parse(data.toString()));
      const waiter = waiters.shift();
      if (waiter) waiter(envelope);
      else queue.push(envelope);
    });

    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("open", resolve);
        socket.once("error", reject);
      });

      const challenge = await nextEnvelope(queue, waiters);
      assert.equal(challenge.type, "server.challenge");
      assert.equal(verifyRemoteEnvelopeSignature(pc.publicKey, challenge).ok, true);
      const serverNonce = String(challenge.payload.serverNonce);
      const clientNonce = randomBytes(24).toString("base64url");
      const authenticate = signRemoteEnvelope(phone.privateKey, createRemoteEnvelope({
        type: "client.authenticate",
        sessionId: PRE_SESSION_ID,
        keyId: phone.keyId,
        sequence: 0,
        payload: {
          serverNonce,
          clientNonce,
          publicKey: phone.publicKeySpki,
          deviceHint: "test-android",
          platform: "android",
          appVersion: "0.1.0",
        },
      }));
      socket.send(JSON.stringify(authenticate));

      const ready = await nextEnvelope(queue, waiters);
      assert.equal(ready.type, "session.ready");
      assert.equal(ready.sessionId, ready.payload.sessionId);
      assert.equal(ready.payload.serverNonce, serverNonce);
      assert.equal(ready.payload.clientNonce, clientNonce);
      assert.equal(verifyRemoteEnvelopeSignature(pc.publicKey, ready).ok, true);
      const sessionId = ready.sessionId;

      const manifestRequest = signRemoteEnvelope(phone.privateKey, createRemoteEnvelope({
        type: "manifest.get",
        sessionId,
        keyId: phone.keyId,
        sequence: 0,
        payload: {},
      }));
      socket.send(JSON.stringify(manifestRequest));
      const manifest = await nextEnvelope(queue, waiters);
      assert.equal(manifest.type, "manifest.snapshot");
      assert.equal(verifyRemoteEnvelopeSignature(pc.publicKey, manifest).ok, true);
      assert.ok((manifest.payload.capabilities as Array<{ name: string }>).some((item) => item.name === "system_status"));

      const requestId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      const taskRequest = signRemoteEnvelope(phone.privateKey, createRemoteEnvelope({
        type: "task.submit",
        sessionId,
        keyId: phone.keyId,
        sequence: 1,
        payload: {
          requestId,
          idempotencyKey: "gateway-integration-test-001",
          capability: "system_status",
          canonicalArguments: { metric: "cpu" },
          intent: "Check the test PC CPU status.",
        },
      }));
      socket.send(JSON.stringify(taskRequest));

      let accepted = false;
      let result: RemoteEnvelope | undefined;
      const deadline = Date.now() + 5_000;
      while (!result && Date.now() < deadline) {
        const next = await nextEnvelope(queue, waiters, Math.max(50, deadline - Date.now()));
        assert.equal(verifyRemoteEnvelopeSignature(pc.publicKey, next).ok, true);
        if (next.type === "task.accepted") accepted = true;
        if (next.type === "task.result") result = next;
        if (next.type === "protocol.error") {
          assert.fail(`Task submit was rejected: ${String(next.payload.code)}`);
        }
      }
      assert.ok(accepted, "PC should acknowledge the submitted task");
      assert.ok(result, "PC should return a completed task result");
      assert.equal(result!.payload.status, "succeeded");
      assert.equal((result!.payload.result as { metric?: string }).metric, "cpu");
      assert.equal((result!.payload.result as { hostname?: string }).hostname, "integration-test-pc");
      assert.equal((result!.payload.verification as { status?: string }).status, "verified");

      // Re-send sequence 0 after sequences 0 and 1 were accepted. The PC must
      // reject it, rather than executing or acknowledging it as a fresh request.
      socket.send(JSON.stringify(manifestRequest));
      let replayError: RemoteEnvelope | undefined;
      const replayDeadline = Date.now() + 2_000;
      while (!replayError && Date.now() < replayDeadline) {
        const next = await nextEnvelope(queue, waiters, Math.max(50, replayDeadline - Date.now()));
        if (next.type === "protocol.error") replayError = next;
      }
      assert.ok(replayError);
      assert.equal(replayError!.payload.code, "SEQUENCE_OUT_OF_ORDER");
    } finally {
      socket.close();
      await new Promise<void>((resolve) => {
        if (socket.readyState === WebSocket.CLOSED) resolve();
        else socket.once("close", () => resolve());
      });
    }
  } finally {
    await gateway.stop();
    engine.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
