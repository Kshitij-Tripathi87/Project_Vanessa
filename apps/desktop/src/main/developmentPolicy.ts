/** A packaged application must never trust a development origin, even with a stale environment. */
export function allowDevelopmentRenderer(isPackaged: boolean, env: NodeJS.ProcessEnv): boolean {
  return !isPackaged && env.VANESSA_DEV_MODE === "1";
}

/** Run before reading packaged configuration and again for spawned services. */
export function restrictPackagedEnvironment(env: NodeJS.ProcessEnv): void {
  env.VANESSA_DEV_MODE = "0";
  delete env.VITE_DEV_SERVER_URL;
}
