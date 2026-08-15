export type LogFields = Record<string, unknown>;

export function logInfo(message: string, fields?: LogFields): void {
  const payload = fields ? ` ${JSON.stringify(fields)}` : "";
  console.info(`[compressor] ${message}${payload}`);
}

export function logWarn(message: string, fields?: LogFields): void {
  const payload = fields ? ` ${JSON.stringify(fields)}` : "";
  console.warn(`[compressor] ${message}${payload}`);
}

/** Log resolved knobs once per factory init. Do not rewrite ~user into other homes. */
export function logResolvedConfig(resolved: { stateDir: string } & Record<string, unknown>): void {
  logInfo("resolvedConfig", { ...resolved, stateDir: resolved.stateDir });
}
