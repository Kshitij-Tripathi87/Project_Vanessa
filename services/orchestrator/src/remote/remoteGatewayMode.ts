/**
 * Remote gateway mode gates. Packaged desktop has one supported remote
 * transport: authenticated protocol v2. The legacy HMAC gateway is retained
 * for local development compatibility only.
 */
export function shouldStartLegacyMobileGateway(
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  return environment.VANESSA_PACKAGED_DESKTOP !== "true" &&
    environment.VANESSA_MOBILE_GATEWAY_ENABLED === "true";
}
