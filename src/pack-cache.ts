/**
 * Optional two-layer pack cache (Plan 10 supercharge #7).
 * RAM-only per session; invalidate on profile/flush/compact/ingest OpenItem change.
 */

export type PackCacheEntry = {
  openitemSignature: string;
  lastQuery: string;
  pack: {
    text: string;
    packed_tokens: number;
    method?: string;
    k?: number;
    k_max?: number;
    t?: number;
    duration_ms?: number;
    [key: string]: unknown;
  };
};

const cache = new Map<string, PackCacheEntry>();

/** Jaccard similarity on whitespace tokens. */
export function jaccardTokens(a: string, b: string): number {
  const sa = new Set(a.toLowerCase().split(/\s+/).filter(Boolean));
  const sb = new Set(b.toLowerCase().split(/\s+/).filter(Boolean));
  if (sa.size === 0 && sb.size === 0) return 1;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter += 1;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

export function invalidatePackCache(sessionId?: string): void {
  if (!sessionId) {
    cache.clear();
    return;
  }
  cache.delete(sessionId);
}

export function getPackCache(sessionId: string): PackCacheEntry | undefined {
  return cache.get(sessionId);
}

export function setPackCache(sessionId: string, entry: PackCacheEntry): void {
  cache.set(sessionId, entry);
}

/**
 * Try reuse last pack when openitem_signature unchanged and query Jaccard high.
 * Heartbeats never sample — caller must skip before calling.
 */
export function tryPackCacheSkip(
  sessionId: string,
  openitemSignature: string,
  query: string,
  jaccardThreshold = 0.85,
): PackCacheEntry["pack"] | null {
  const prev = cache.get(sessionId);
  if (!prev) return null;
  if (prev.openitemSignature !== openitemSignature) return null;
  if (jaccardTokens(prev.lastQuery, query) < jaccardThreshold) return null;
  return {
    ...prev.pack,
    method: "skip",
    duration_ms: 0,
  };
}

export function rememberPack(
  sessionId: string,
  openitemSignature: string,
  query: string,
  pack: PackCacheEntry["pack"],
): void {
  if (pack.method === "skip") return;
  cache.set(sessionId, {
    openitemSignature,
    lastQuery: query,
    pack: { ...pack },
  });
}
