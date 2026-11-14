import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { test } from "node:test";
import { WebSocket, type RawData } from "ws";
import { z } from "zod";

import {
  PRE_SESSION_ID,
  computeKeyId,
  createRemoteEnvelope,
  signRemoteEnvelope,
  verifyRemoteEnvelopeSignature,
  type RemoteEnvelope,
} from "@vanessa/protocol";
import { MobileTaskEngine } from "../core/mobileTaskEngine.js";
import type { MobileTool } from "../core/mobileToolRegistry.js";
import { RemotePairingRegistry } from "../remote/remotePairingRegistry.js";
import { RemoteTaskService } from "../remote/remoteTaskService.js";
import { RemoteV2Gateway } from "../remote/remoteV2Gateway.js";

async function getFreePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

function makeIdentity() {
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return {
    ...pair,
    keyId: computeKeyId(pair.publicKey),
    publicKeySpki: pair.publicKey.export({ type: "spki", format: "der" }).toString("base64url"),
  };
}

function makeTool(): MobileTool {
  const schema = z.object({}).strict();
  return {
    name: "system_status",
    description: "Read a compact PC status snapshot.",
    argsSchema: schema,
    manifestSchema: { type: "object", properties: {}, additionalProperties: false },
    tier: 0,
    timeoutMs: 1000,
    idempotent: true,
    queue: "read",
    handler: async () => ({ hostname: "vanessa-test-pc", cpuPercent: 12 }),
    verifier: async (_args, result) => typeof (result as any)?.hostname === "string",
  };
}

function createQueue(socket: WebSocket) {
  const queued: Record<string, any>[] = [];
  const waiters: Array<{ type?: string; resolve: (value: Record<string, any>) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }> = [];
  socket.on("message", (raw: RawData) => {
    let message: Record<string, any>;
    try { message = JSON.parse(raw.toString()) as Record<string, any>; }
    catch { return; }
    const index = waiters.findIndex((waiter) => !waiter.type || waiter.type === message.type);
    if (index >= 0) {
      const waiter = waiters.splice(index, 1)[0];
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    } else queued.push(message);
  });
  return {
    next(type?: string, timeoutMs = 4000): Promise<Record<string, any>> {
      const index = queued.findIndex((message) => !type || message.type === type);
      if (index >= 0) return Promise.resolve(queued.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const index = waiters.findIndex((waiter) => waiter.resolve === resolve);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error("Timed out waiting for remote v2 frame" + (type ? " " + type : "") + "."));
        }, timeoutMs);
        waiters.push({ type, resolve, reject, timer });
      });
    },
  };
}

test("authenticated v2 pairing, PC approval, session sync and remote task result work end to end", async () => {
  const directory = mkdtempSync(join(tmpdir(), "vanessa-remote-v2-e2e-"));
  const pc = makeIdentity();
  const phone = makeIdentity();
  const pairingRegistry = new RemotePairingRegistry({
    storePath: join(directory, "trusted-devices.json"),
  });
  await pairingRegistry.initialize();

  let gateway: RemoteV2Gateway | undefined;
  const engine = new MobileTaskEngine({
    dbPath: join(directory, "tasks.db"),
    tools: [makeTool()],
    notify: ({ task, deviceId, ephemeralResult }) => {
      gateway?.publishTask({ task, deviceId, ...(ephemeralResult !== undefined ? { ephemeralResult } : {}) });
    },
  });
  const taskService = new RemoteTaskService(engine, pairingRegistry);
  const port = await getFreePort();
  gateway = new RemoteV2Gateway({
    host: "127.0.0.1",
    port,
    pairings: pairingRegistry,
    tasks: taskService,
    signer: {
      keyId: pc.keyId,
      publicKeySpki: pc.publicKeySpki,
      sign: async (envelope: Omit<RemoteEnvelope, "auth">) => signRemoteEnvelope(pc.privateKey, envelope),
    },
  });

  let socket: WebSocket | undefined;
  try {
    await gateway.start();
    socket = new WebSocket("ws://127.0.0.1:" + port + "/remote/v2");
    await once(socket, "open");
    const frames = createQueue(socket);

    const serverChallenge = await frames.next("server.challenge");
    assert.equal(serverChallenge.sessionId, PRE_SESSION_ID);
    assert.equal(verifyRemoteEnvelopeSignature(pc.publicKey, serverChallenge as RemoteEnvelope).ok, true);

    const pairing = pairingRegistry.createPairingWindow();
    const clientNonce = randomBytes(24).toString("base64url");
    const claim = signRemoteEnvelope(phone.privateKey, createRemoteEnvelope({
      type: "pairing.claim",
      sessionId: PRE_SESSION_ID,
      keyId: phone.keyId,
      sequence: 0,
      sentAt: Date.now(),
      payload: {
        pairingId: pairing.pairingId,
        code: pairing.code,
        publicKey: phone.publicKeySpki,
        keyId: phone.keyId,
        deviceHint: "pixel-integration-test",
        platform: "android",
        appVersion: "test",
        clientNonce,
      },
    }));
    socket.send(JSON.stringify(claim));

    const pairingChallenge = await frames.next("pairing.challenge");
    assert.equal(verifyRemoteEnvelopeSignature(pc.publicKey, pairingChallenge as RemoteEnvelope).ok, true);
    const challengeNonce = pairingChallenge.payload.nonce as string;
    socket.send(JSON.stringify(signRemoteEnvelope(phone.privateKey, createRemoteEnvelope({
      type: "pairing.complete",
      sessionId: PRE_SESSION_ID,
      keyId: phone.keyId,
      sequence: 1,
      sentAt: Date.now(),
      payload: { pairingId: pairing.pairingId, challengeNonce },
    }))));

    const pending = await frames.next("pairing.pending");
    assert.equal(pending.payload.state, "awaiting_approval");

    // This method is the local-PC approval boundary used by the desktop IPC.
    await gateway.approvePairing(pairing.pairingId, ["system.read"]);
    const approved = await frames.next("pairing.approved");
    assert.deepEqual(approved.payload.grantedScopes, ["system.read"]);
    assert.equal(approved.payload.clientNonce, clientNonce);

    socket.send(JSON.stringify(signRemoteEnvelope(phone.privateKey, createRemoteEnvelope({
      type: "client.authenticate",
      sessionId: PRE_SESSION_ID,
      keyId: phone.keyId,
      sequence: 2,
      sentAt: Date.now(),
      payload: {
        serverNonce: challengeNonce,
        clientNonce,
        publicKey: phone.publicKeySpki,
        platform: "android",
        appVersion: "test",
      },
    }))));

    const ready = await frames.next("session.ready");
    const sessionId = ready.payload.sessionId as string;
    const deviceId = ready.payload.deviceId as string;
    assert.equal(ready.sessionId, sessionId);
    assert.deepEqual(ready.payload.grantedScopes, ["system.read"]);

    const seal = (type: string, payload: Record<string, unknown>, sequence: number) =>
      signRemoteEnvelope(phone.privateKey, createRemoteEnvelope({
        type,
        sessionId,
        keyId: phone.keyId,
        sequence,
        sentAt: Date.now(),
        payload,
      }));

    socket.send(JSON.stringify(seal("sync.resume", {
      lastEventSeq: 0,
      activeTaskIds: [],
      clientNonce: randomBytes(24).toString("base64url"),
    }, 1)));
    const snapshot = await frames.next("sync.snapshot");
    assert.equal(snapshot.payload.historyGap, true);
    assert.deepEqual(snapshot.payload.tasks, []);
    await frames.next("sync.complete");

    socket.send(JSON.stringify(seal("manifest.get", {}, 2)));
    const manifest = await frames.next("manifest.snapshot");
    assert.deepEqual(manifest.payload.capabilities.map((capability: any) => capability.name), ["system_status"]);

    const requestId = randomUUID();
    socket.send(JSON.stringify(seal("task.submit", {
      requestId,
      idempotencyKey: "remote-v2-integration-0001",
      capability: "system_status",
      canonicalArguments: {},
    }, 3)));

    const accepted = await frames.next("task.accepted");
    assert.equal(accepted.payload.requestId, requestId);
    const result = await frames.next("task.result");
    assert.equal(result.payload.status, "succeeded");
    assert.equal(result.payload.verification.status, "verified");
    assert.equal(result.payload.result.hostname, "vanessa-test-pc");
    assert.equal(engine.getTask(accepted.payload.taskId)?.state, "done");
    assert.equal(engine.recentAudit()[0]?.deviceId, deviceId);

    // A reconnect must be able to recover this completed task from the DB
    // without relying on an in-memory event buffer.
    const nextPair = await taskService.resumeSnapshot(phone.keyId, {
      lastEventSeq: 0,
      activeTaskIds: [],
      clientNonce: randomBytes(24).toString("base64url"),
    });
    assert.equal(nextPair.tasks.length, 1);
    assert.equal(nextPair.tasks[0].taskId, accepted.payload.taskId);
    assert.equal(nextPair.tasks[0].state, "succeeded");
  } finally {
    socket?.close();
    await gateway.stop().catch(() => undefined);
    engine.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
