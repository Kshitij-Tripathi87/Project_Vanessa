import { randomUUID } from "node:crypto";
import type { RemoteEnvelope } from "@vanessa/protocol";
import type { RemoteV2IdentitySigner } from "./remoteV2Gateway.js";

type PendingSign = {
  resolve: (envelope: RemoteEnvelope) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

/** The orchestrator child process never receives the PC private identity key. */
export function createParentProcessRemoteSigner(): RemoteV2IdentitySigner | undefined {
  if (typeof process.send !== "function") return undefined;
  const keyId = process.env.VANESSA_REMOTE_PC_KEY_ID?.trim();
  const publicKeySpki = process.env.VANESSA_REMOTE_PC_PUBLIC_KEY?.trim();
  if (!keyId || !publicKeySpki) return undefined;
  const pending = new Map<string, PendingSign>();

  process.on("message", (message: unknown) => {
    if (!message || typeof message !== "object") return;
    const record = message as { type?: string; requestId?: string; envelope?: RemoteEnvelope; error?: string };
    if (record.type !== "vanessa.remote.sign.response" || typeof record.requestId !== "string") return;
    const waiter = pending.get(record.requestId);
    if (!waiter) return;
    pending.delete(record.requestId);
    clearTimeout(waiter.timer);
    if (record.error || !record.envelope) waiter.reject(new Error(record.error || "PC signer returned no envelope."));
    else waiter.resolve(record.envelope);
  });

  process.on("disconnect", () => {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("The desktop signer IPC channel closed."));
    }
    pending.clear();
  });

  return {
    keyId,
    publicKeySpki,
    sign(envelope) {
      return new Promise<RemoteEnvelope>((resolve, reject) => {
        const requestId = randomUUID();
        const timer = setTimeout(() => {
          pending.delete(requestId);
          reject(new Error("Desktop PC identity signer timed out."));
        }, 5_000);
        pending.set(requestId, { resolve, reject, timer });
        process.send?.({ type: "vanessa.remote.sign", requestId, envelope }, (error) => {
          if (!error) return;
          const waiter = pending.get(requestId);
          if (!waiter) return;
          pending.delete(requestId);
          clearTimeout(waiter.timer);
          waiter.reject(error);
        });
      });
    },
  };
}
