import { createServer, type IncomingMessage, type Server } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  REMOTE_MESSAGE_DIRECTIONS,
  safeParseRemoteEnvelope,
  safeParseRemotePayload,
  signRemoteEnvelope,
  type RemoteEnvelope,
} from "@vanessa/protocol";
import type { RemotePcIdentityStore } from "./remotePcIdentityStore.js";

const MAX_BODY_BYTES = 64 * 1024;
const PLACEHOLDER_SIGNATURE = "AAAAAAAAAAAAAAAAAAAA";

export type RemoteSigningBrokerHandle = {
  url: string;
  token: string;
  keyId: string;
  publicKeySpki: string;
  close(): Promise<void>;
};

function matchesToken(supplied: string | undefined, expected: string): boolean {
  if (!supplied?.startsWith("Bearer ")) return false;
  const left = Buffer.from(supplied.slice(7), "utf8");
  const right = Buffer.from(expected, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error("Request body is too large."), { statusCode: 413 });
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("Request body is not valid JSON."), { statusCode: 400 });
  }
}

/**
 * In-process Electron-main signing broker. The OS-protected private identity
 * never crosses into the orchestrator child process; that process receives
 * only a loopback URL and a per-launch random bearer capability.
 */
export async function createRemoteSigningBroker(
  identityStore: RemotePcIdentityStore,
): Promise<RemoteSigningBrokerHandle> {
  const identity = await identityStore.loadOrCreate();
  const token = randomBytes(32).toString("base64url");
  const server: Server = createServer(async (request, response) => {
    response.setHeader("cache-control", "no-store");
    response.setHeader("content-type", "application/json");
    if (request.socket.remoteAddress !== "127.0.0.1" && request.socket.remoteAddress !== "::ffff:127.0.0.1" && request.socket.remoteAddress !== "::1") {
      response.writeHead(403).end(JSON.stringify({ error: "LOCAL_ONLY" }));
      return;
    }
    if (!matchesToken(request.headers.authorization, token)) {
      response.writeHead(401).end(JSON.stringify({ error: "UNAUTHORIZED" }));
      return;
    }
    if (request.method === "GET" && request.url === "/identity") {
      response.writeHead(200).end(JSON.stringify({
        keyId: identity.keyId,
        publicKeySpki: identity.publicKeySpki,
      }));
      return;
    }
    if (request.method !== "POST" || request.url !== "/sign") {
      response.writeHead(404).end(JSON.stringify({ error: "NOT_FOUND" }));
      return;
    }
    try {
      const body = await readJson(request) as { envelope?: unknown };
      if (!body || typeof body !== "object" || !body.envelope || typeof body.envelope !== "object") {
        response.writeHead(400).end(JSON.stringify({ error: "INVALID_REQUEST" }));
        return;
      }
      const candidate = body.envelope as Record<string, unknown>;
      const withAuth = {
        ...candidate,
        auth: { algorithm: "ES256", signature: PLACEHOLDER_SIGNATURE },
      };
      const parsed = safeParseRemoteEnvelope(withAuth);
      if (!parsed.success) {
        response.writeHead(400).end(JSON.stringify({ error: "INVALID_ENVELOPE" }));
        return;
      }
      const envelope = parsed.data;
      if (envelope.keyId !== identity.keyId || REMOTE_MESSAGE_DIRECTIONS[envelope.type] !== "server_to_client") {
        response.writeHead(403).end(JSON.stringify({ error: "SIGNING_SCOPE_DENIED" }));
        return;
      }
      const payload = safeParseRemotePayload(envelope.type, envelope.payload);
      if (!payload.success) {
        response.writeHead(400).end(JSON.stringify({ error: "INVALID_PAYLOAD" }));
        return;
      }
      const { auth: _ignored, ...unsigned } = envelope;
      const signed = signRemoteEnvelope(identity.privateKey, unsigned);
      response.writeHead(200).end(JSON.stringify(signed));
    } catch (error) {
      const status = Number((error as { statusCode?: number }).statusCode) || 500;
      response.writeHead(status).end(JSON.stringify({ error: status === 500 ? "SIGNING_FAILED" : (error as Error).message }));
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
  if (!address || typeof address === "string") throw new Error("Could not allocate the local PC identity broker.");
  let closed = false;
  return {
    url: "http://127.0.0.1:" + address.port,
    token,
    keyId: identity.keyId,
    publicKeySpki: identity.publicKeySpki,
    async close() {
      if (closed) return;
      closed = true;
      identityStore.clearMemory();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}
