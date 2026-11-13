/**
 * @vanessa/protocol — canonical wire contract for Project Vanessa.
 *
 * v2 (`./canonicalize.ts`, `./messages.ts`, `./envelope.ts`, `./signatures.ts`)
 * is the contract the authenticated phone <-> PC listener speaks: signed
 * envelopes, PC-resolved permissions, bounded payloads.
 *
 * v1 (`./protocol.ts`) is exported unchanged for the desktop's legacy loopback
 * gateway and is scheduled for removal. Import v2 names in new code.
 */

export * from "./canonicalize.ts";
export * from "./messages.ts";
export * from "./envelope.ts";
export * from "./signatures.ts";

// Legacy v1 (deprecated): local loopback gateway only.
export * from "./protocol.ts";

export * from "./sessionGuard.ts";
