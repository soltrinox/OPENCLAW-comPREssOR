/** C_t append-then-pool — port of compress.py (Float32Array, no numpy). */

export const DEFAULT_K_MAX = 64;
export const DEFAULT_D = 256;
export const DEFAULT_EMA = 0.5;

export type FloatMatrix = Float32Array[];

export function resolveEma(defaultEma = DEFAULT_EMA): number {
  const raw = (process.env.CHAT_COMPRESSOR_EMA || "").trim();
  if (!raw) return defaultEma;
  const v = Number.parseFloat(raw);
  if (!Number.isFinite(v)) return defaultEma;
  return Math.max(0, Math.min(1, v));
}

export function l2Normalize(rows: FloatMatrix, eps = 1e-8): FloatMatrix {
  return rows.map((row) => {
    let n = 0;
    for (let i = 0; i < row.length; i++) n += row[i]! * row[i]!;
    n = Math.sqrt(n);
    const denom = Math.max(n, eps);
    const out = new Float32Array(row.length);
    for (let i = 0; i < row.length; i++) out[i] = row[i]! / denom;
    return out;
  });
}

function cosineAdjacent(a: Float32Array, b: Float32Array): number {
  let na = 0;
  let nb = 0;
  let dot = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
    dot += a[i]! * b[i]!;
  }
  na = Math.sqrt(na);
  nb = Math.sqrt(nb);
  if (na < 1e-12 || nb < 1e-12) return -1.0;
  return dot / (na * nb);
}

function pickEvictionIndex(
  protectedRows: boolean[],
  tags: Set<string>[],
): number | null {
  for (let i = 0; i < protectedRows.length; i++) {
    if (!protectedRows[i]) return i;
  }
  for (let i = 0; i < tags.length; i++) {
    if (!tags[i]!.has("identifier")) return i;
  }
  return protectedRows.length ? 0 : null;
}

export function appendThenPool(
  prevC: FloatMatrix | null,
  newRows: FloatMatrix | Float32Array,
  opts: {
    kMax?: number;
    ema?: number;
    protectMask?: boolean[] | null;
    protectKindsTags?: Set<string>[] | null;
  } = {},
): FloatMatrix {
  const kMax = opts.kMax ?? DEFAULT_K_MAX;
  const ema = opts.ema ?? DEFAULT_EMA;
  let rows: FloatMatrix;
  if (Array.isArray(newRows)) {
    rows = newRows.map((r) => (r instanceof Float32Array ? r : Float32Array.from(r)));
  } else {
    rows = [newRows];
  }
  let stacked: FloatMatrix;
  let nPrev = 0;
  if (!prevC || prevC.length === 0) {
    stacked = rows.map((r) => new Float32Array(r));
  } else {
    nPrev = prevC.length;
    stacked = [...prevC.map((r) => new Float32Array(r)), ...rows.map((r) => new Float32Array(r))];
  }

  let n = stacked.length;
  let protectedRows: boolean[];
  let tags: Set<string>[];
  if (!opts.protectMask) {
    protectedRows = Array(n).fill(false);
    tags = Array.from({ length: n }, () => new Set<string>());
  } else {
    const mask = opts.protectMask;
    if (mask.length === n) {
      protectedRows = mask.map(Boolean);
    } else if (mask.length === n - nPrev) {
      protectedRows = [...Array(nPrev).fill(false), ...mask.map(Boolean)];
    } else {
      throw new Error(`protect_mask length ${mask.length} != stacked rows ${n}`);
    }
    if (!opts.protectKindsTags) {
      tags = protectedRows.map((p) => (p ? new Set(["protected"]) : new Set<string>()));
    } else if (opts.protectKindsTags.length === n) {
      tags = opts.protectKindsTags.map((t) => new Set(t));
    } else if (opts.protectKindsTags.length === n - nPrev) {
      tags = [
        ...Array.from({ length: nPrev }, () => new Set<string>()),
        ...opts.protectKindsTags.map((t) => new Set(t)),
      ];
    } else {
      tags = protectedRows.map((p) => (p ? new Set(["protected"]) : new Set<string>()));
    }
  }

  while (stacked.length > kMax) {
    n = stacked.length;
    let bestI = -1;
    let bestSim = -2.0;
    for (let i = 0; i < n - 1; i++) {
      if (protectedRows[i] || protectedRows[i + 1]) continue;
      const sim = cosineAdjacent(stacked[i]!, stacked[i + 1]!);
      if (sim > bestSim) {
        bestSim = sim;
        bestI = i;
      }
    }
    if (bestI >= 0) {
      const merged = new Float32Array(stacked[bestI]!.length);
      for (let j = 0; j < merged.length; j++) {
        merged[j] = ema * stacked[bestI]![j]! + (1.0 - ema) * stacked[bestI + 1]![j]!;
      }
      stacked = [...stacked.slice(0, bestI), merged, ...stacked.slice(bestI + 2)];
      protectedRows = [
        ...protectedRows.slice(0, bestI),
        false,
        ...protectedRows.slice(bestI + 2),
      ];
      tags = [...tags.slice(0, bestI), new Set(), ...tags.slice(bestI + 2)];
      continue;
    }
    let evict = pickEvictionIndex(protectedRows, tags);
    if (evict === null) evict = 0;
    stacked = [...stacked.slice(0, evict), ...stacked.slice(evict + 1)];
    protectedRows = [...protectedRows.slice(0, evict), ...protectedRows.slice(evict + 1)];
    tags = [...tags.slice(0, evict), ...tags.slice(evict + 1)];
  }

  return l2Normalize(stacked);
}

export function liveMask(k: number, kMax?: number): Float32Array {
  if (kMax === undefined || kMax === k) {
    return Float32Array.from({ length: k }, () => 1);
  }
  const mask = new Float32Array(kMax);
  for (let i = 0; i < k; i++) mask[i] = 1;
  return mask;
}
