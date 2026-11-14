import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  REMOTE_MESSAGE_DIRECTIONS,
  createRemoteEnvelope,
  parseRemotePayload,
  signRemoteEnvelope,
  type RemoteMessageType,
} from "@vanessa/protocol";
import { RemotePcIdentityStore } from "./remotePcIdentityStore.js";
import { ElectronPcIdentityEncryption } from "./electronRemoteIdentityStore.js";

type SignRequest = {
  type: RemoteMessageType;
  payload: Record<string, unknown>;
  sessionId: string;
  sequence: number;
};

export type RemoteIdentitySignerHandle = {
  url: string;
  token: string;
  stop(): Promise<void>;
};

const MAX_BODY_BYTES = 64 * 1024;

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(value));
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_BODY_BYTES) throw new Error("Request body too large.");
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/**
 * A loopback-only signing oracle. The DPAPI/safeStorage-protected PC private
 * key remains in Electron's main process; the orchestrator can request only
 * schema-valid, server-to-client v2 envelopes using an ephemeral bearer token.
 */
export async function startRemoteIdentitySignerServer(userDataPath: string): Promise<RemoteIdentitySignerHandle> {
  const identityStore = new RemotePcIdentityStore(
    userDataPath + "/remote_pc_identity.json",
    new ElectronPcIdentityEncryption(),
  );
  const identity = await identityStore.loadOrCreate();
  const token = randomBytes(32).toString("base64url");

  const server: Server = createServer(async (request, response) => {
    if (request.socket.remoteAddress !== "127.0.0.1" && request.socket.remoteAddress !== "::1" &&
        request.socket.remoteAddress !== "::ffff:127.0.0.1") {
      sendJson(response, 403, { error: "loopback_only" });
      return;
    }
    const authorization = request.headers.authorization ?? "";
    if (!safeEqual(authorization, "Bearer " + token)) {
      sendJson(response, 401, { error: "unauthorized" });
      return;
    }

    if (request.method === "GET" && request.url === "/identity") {
      sendJson(response, 200, {
        keyId: identity.keyId,
        publicKeySpki: identity.publicKeySpki,
        fingerprint: identity.fingerprint,
        pcId: "pc_" + identity.keyId.slice(0, 16),
        pcName: process.env.COMPUTERNAME || process.env.HOSTNAME || "Vanessa PC",
      });
      return;
    }

    if (request.method !== "POST" || request.url !== "/sign") {
      sendJson(response, 404, { error: "not_found" });
      return;
    }

    try {
      const raw = await readJson(request);
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        sendJson(response, 400, { error: "invalid_request" });
        return;
      }
      const input = raw as Partial<SignRequest>;
      if (typeof input.type !== "string" || typeof input.sessionId !== "string" ||
          !Number.isInteger(input.sequence) || (input.sequence ?? -1) < 0 ||
          !input.payload || typeof input.payload !== "object" || Array.isArray(input.payload)) {
        sendJson(response, 400, { error: "invalid_request" });
        return;
      }
      const type = input.type as RemoteMessageType;
      const direction = REMOTE_MESSAGE_DIRECTIONS[type];
      if (!direction || (direction !== "server_to_client" && direction !== "bidirectional")) {
        sendJson(response, 403, { error: "message_direction_forbidden" });
        return;
      }
      const payload = parseRemotePayload(type, input.payload);
      const envelope = createRemoteEnvelope({
        type,
        payload: payload as Record<string, unknown>,
        keyId: identity.keyId,
        sessionId: input.sessionId,
        sequence: input.sequence!,
      });
      const signed = signRemoteEnvelope(identity.privateKey, envelope);
      sendJson(response, 200, signed);
    } catch {
      sendJson(response, 400, { error: "invalid_signing_request" });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not determine signer endpoint.");
  return {
    url: "http://127.0.0.1:" + address.port,
    token,
    stop: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}
