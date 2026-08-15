const ALLOWED = /[^A-Za-z0-9._-]/g;
export const SANITIZE_MAX_LEN = 120;

export function sanitize(id: string | undefined | null): string {
  if (id === undefined || id === null || String(id).length === 0) return "unknown";
  let next = String(id).replace(ALLOWED, "_").replace(/_+/g, "_");
  next = next.replace(/^\.+/, "");
  next = next.replace(/\.\./g, "_").replace(/_+/g, "_");
  next = next.replace(/^_+/, "");
  if (next.length > SANITIZE_MAX_LEN) next = next.slice(0, SANITIZE_MAX_LEN);
  if (!next) return "unknown";
  if (next === "." || next === ".." || next.startsWith(".")) {
    throw new Error(`sanitize rejected identity: ${JSON.stringify(id)}`);
  }
  if (next.includes("/") || next.includes("\\") || next.includes("..")) {
    throw new Error(`sanitize produced unsafe path fragment: ${next}`);
  }
  return next;
}

export function graphRoot(
  sessionKey: string | undefined,
  agentId: string | undefined,
  shareGraphByAgent: boolean,
): string {
  if (shareGraphByAgent && agentId) return sanitize(agentId);
  return sanitize(sessionKey);
}
