/** CSP for the local desktop surface. Provider traffic does not originate here. */
export function rendererContentSecurityPolicy(allowDevelopment: boolean): string {
  const developmentScripts = allowDevelopment ? " 'unsafe-inline'" : "";
  return `default-src 'self'; script-src 'self'${developmentScripts}; style-src 'self' 'unsafe-inline'; connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:* http://localhost:* ws://localhost:*; img-src 'self' data: blob:; media-src 'self' data: blob:; font-src 'self' data:; worker-src 'self' blob:; object-src 'none'; base-uri 'self'`;
}
