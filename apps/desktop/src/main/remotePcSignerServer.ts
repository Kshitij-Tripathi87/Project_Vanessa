import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  safeParseRemoteEnvelope,
  signRemoteEnvelope,
  type RemoteEnvelope,
} from "@vanessa/protocol";
import type { RemotePcIdentityStore } from "./remotePcIdentityStore.js";

/** Only the orchestrator child receives this short-lived signing capability. */
export type PcSignerRuntimeConfig = {
  url: string;
  token: string;
  keyId: string;
  publicKeySpki: string;
  fingerprint: string;
};

/**
 * Loopback-only signing bridge. The PC private KeyObject remains in Electron
 * main and is protected at rest by the OS key store; child processes never
 * receive a PEM, PKCS#8 blob, or private key file.
 */
export class RemotePcSignerServer {
  private server?: Server;
  private config?: PcSignerRuntimeConfig;

  constructor(private readonly identities: RemotePcIdentityStore) {}

  async start(): Promise<PcSignerRuntimeConfig> {
    if (this.server && this.config) return this.config;
    const identity = await this.identities.loadOrCreate();
    const token = randomBytes(32).toString("base64url");
    const server = createServer((request, response) => {
      void this.handle(request, response, token, identity);
    });
    this.server = server;
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => { server.off("listening", onListening); reject(error); };
        const onListening = () => { server.off("error", onError); resolve(); };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(0, "127.0.0.1");
      });
    } catch (error) {
      this.server = undefined;
      server.close();
      throw error;
    }
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("PC signing bridge did not bind to loopback.");
    this.config = {
      url: `http://127.0.0.1:${address.port}`,
      token,
      keyId: identity.keyId,
      publicKeySpki: identity.publicKeySpki,
      fingerprint: identity.fingerprint,
    };
    return this.config;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.config = undefined;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async handle(
    request: IncomingMessage,
    response: ServerResponse,
    token: string,
    identity: Awaited<ReturnType<RemotePcIdentityStore["loadOrCreate"]>>,
  ): Promise<void> {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    const remoteAddress = request.socket.remoteAddress ?? "";
    const loopback = remoteAddress === "127.0.0.1" || remoteAddress === "::1" || remoteAddress === "::ffff:127.0.0.1";
    if (!loopback) {
      this.respond(response, 403, { error: "LOOPBACK_ONLY" });
      return;
    }
    if (request.headers.origin) {
      this.respond(response, 403, { error: "ORIGIN_NOT_ALLOWED" });
      return;
    }
    if (!this.hasValidToken(request, token)) {
      this.respond(response, 401, { error: "UNAUTHORIZED" });
      return;
    }

    const route = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (route === "/health" && request.method === "GET") {
      this.respond(response, 200, { status: "ok", service: "vanessa-pc-signer" });
      return;
    }
    if (route !== "/sign" || request.method !== "POST") {
      this.respond(response, 404, { error: "NOT_FOUND" });
      return;
    }
    if ((request.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase() !== "application/json") {
      this.respond(response, 415, { error: "JSON_REQUIRED" });
      return;
    }

    try {
      const body = await this.readBody(request, 64 * 1024);
      const value: unknown = JSON.parse(body.toString("utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        this.respond(response, 400, { error: "INVALID_ENVELOPE" });
        return;
      }
      const candidate = {
        ...(value as Record<string, unknown>),
        auth: { algorithm: "ES256", signature: "A".repeat(16) },
      };
      const parsed = safeParseRemoteEnvelope(candidate);
      if (!parsed.success || parsed.data.keyId !== identity.keyId) {
        this.respond(response, 400, { error: "INVALID_ENVELOPE" });
        return;
      }
      const { auth: _placeholder, ...unsigned } = parsed.data;
      const signed: RemoteEnvelope = signRemoteEnvelope(identity.privateKey, unsigned);
      this.respond(response, 200, signed);
    } catch (error) {
      const tooLarge = (error as { code?: string })?.code === "BODY_TOO_LARGE";
      this.respond(response, tooLarge ? 413 : 400, { error: tooLarge ? "PAYLOAD_TOO_LARGE" : "INVALID_REQUEST" });
    }
  }

  private hasValidToken(request: IncomingMessage, token: string): boolean {
    const authorization = request.headers.authorization;
    if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) return false;
    const supplied = Buffer.from(authorization.slice(7), "utf8");
    const expected = Buffer.from(token, "utf8");
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  }

  private async readBody(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of request) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += bytes.length;
      if (total > maxBytes) throw Object.assign(new Error("Request body is too large."), { code: "BODY_TOO_LARGE" });
      chunks.push(bytes);
    }
    return Buffer.concat(chunks, total);
  }

  private respond(response: ServerResponse, status: number, body: unknown): void {
    if (response.headersSent || response.destroyed) return;
    const encoded = JSON.stringify(body);
    response.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(encoded),
    });
    response.end(encoded);
  }
}
