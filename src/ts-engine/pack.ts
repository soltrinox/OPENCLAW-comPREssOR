/** Token-budget packer — port of pack.py */

import { createHash } from "node:crypto";
import { jaccard, keywordSet } from "./extractive.ts";
import { estimateTokens } from "./metrics.ts";

export const DEFAULT_FORWARD_BUDGET = 2048;
export const DEDUP_K = 3;
export const WARMUP_TURNS = 3;
export const MARGINAL_JACCARD = 0.92;
export const SKIP_FLOOR_TOKENS = 64;
export const NOVELTY_BUDGET_FLOOR = 1.0;

export function forwardBudget(): number {
  const raw = (process.env.CHAT_COMPRESSOR_FORWARD_BUDGET || "").trim();
  if (!raw) return DEFAULT_FORWARD_BUDGET;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 1 ? n : DEFAULT_FORWARD_BUDGET;
}

export function noveltyBudgetFloor(): number {
  const raw = (process.env.CHAT_COMPRESSOR_NOVELTY_FLOOR || "").trim();
  if (!raw) return NOVELTY_BUDGET_FLOOR;
  const v = Number.parseFloat(raw);
  if (!Number.isFinite(v)) return NOVELTY_BUDGET_FLOOR;
  return Math.max(0, Math.min(1, v));
}

export function marginalJaccardThreshold(defaultVal = MARGINAL_JACCARD): number {
  const raw = (process.env.CHAT_COMPRESSOR_MARGINAL_JACCARD || "").trim();
  if (!raw) return defaultVal;
  const v = Number.parseFloat(raw);
  if (!Number.isFinite(v)) return defaultVal;
  return Math.max(0, Math.min(1, v));
}

export function crossTurnDedupEnabled(): boolean {
  const raw = (process.env.CHAT_COMPRESSOR_CROSS_TURN_DEDUP || "1").trim().toLowerCase();
  return !["0", "false", "no", "off"].includes(raw);
}

export function countTokens(text: string): { ws: number; chars4: number } {
  const ws = text.trim() ? text.split(/\s+/).length : 0;
  const chars4 = text ? estimateTokens(text) : 0;
  return { ws, chars4 };
}

export function lineHash(text: string): string {
  return createHash("sha1")
    .update(text.trim().toLowerCase(), "utf8")
    .digest("hex")
    .slice(0, 16);
}

export function adaptiveBudget(
  t: number,
  noveltyRate: number,
  cap?: number,
  floor?: number,
): number {
  let limit = Math.max(1, cap ?? forwardBudget());
  if (t <= WARMUP_TURNS) return limit;
  const rate = Math.max(0, Math.min(1, noveltyRate));
  const rhoMin = floor ?? noveltyBudgetFloor();
  const scaled = Math.floor(limit * Math.max(rhoMin, rate));
  return Math.max(SKIP_FLOOR_TOKENS, Math.min(limit, scaled));
}

export type PackResult = {
  text: string;
  packed_tokens: number;
  tokens_ws: number;
  tokens_chars4: number;
  budget: number;
  rate: number;
  method: string;
  novel_tokens: number;
  dup_suppressed_tokens: number;
  line_hashes: string[];
  tau_hot: number;
  tau_typed: number;
  tau_ranked: number;
  tau_spans: number;
};

export function packForward(args: {
  hot_set?: string;
  typed_lines?: string[];
  ranked_chunks?: string[];
  span_chunks?: string[];
  budget?: number;
  recent_hashes?: Set<string>;
  openitem_changed?: boolean;
  node_superseded?: boolean;
  allow_skip?: boolean;
  marginal_jaccard?: number;
  skip_floor_tokens?: number;
}): PackResult {
  const cap = Math.max(1, args.budget ?? forwardBudget());
  const mu =
    args.marginal_jaccard === undefined
      ? marginalJaccardThreshold()
      : args.marginal_jaccard;
  const skipFloor = args.skip_floor_tokens ?? SKIP_FLOOR_TOKENS;
  const parts: string[] = [];
  let used = 0;
  const packedNorm = new Set<string>();
  let method = "hot_set";
  let dupSuppressed = 0;
  let tauHot = 0;
  let tauTyped = 0;
  let tauRanked = 0;
  let tauSpans = 0;
  let suppress = new Set(args.recent_hashes ?? []);
  if (args.node_superseded || !crossTurnDedupEnabled()) suppress = new Set();

  const blocked = (text: string) => (suppress.size ? suppress.has(lineHash(text)) : false);
  const extraParts: string[] = [];
  const marginal = (text: string) => {
    if (!extraParts.length) return false;
    return jaccard(keywordSet(text), keywordSet(extraParts.join("\n"))) > mu;
  };

  const hot = (args.hot_set || "").trim();
  if (hot) {
    let piece = `HOT_SET:\n${hot}`;
    let toks = estimateTokens(piece);
    if (toks > cap) {
      piece = truncateToBudget(piece, cap);
      toks = estimateTokens(piece);
    }
    parts.push(piece);
    used += toks;
    tauHot = toks;
    packedNorm.add(hot.toLowerCase());
    for (const line of hot.split("\n")) packedNorm.add(line.trim().toLowerCase());
  }

  const fits = (block: string) => used + estimateTokens(block) <= cap;

  let typedAdded = false;
  for (const line of args.typed_lines ?? []) {
    const text = (line || "").trim();
    if (!text) continue;
    const key = text.toLowerCase();
    if (packedNorm.has(key)) continue;
    if (blocked(text)) {
      dupSuppressed += estimateTokens(text);
      continue;
    }
    if (marginal(text)) {
      dupSuppressed += estimateTokens(text);
      continue;
    }
    if (!fits(text)) continue;
    const toks = estimateTokens(text);
    parts.push(text);
    extraParts.push(text);
    used += toks;
    tauTyped += toks;
    packedNorm.add(key);
    typedAdded = true;
  }

  let chunkAdded = false;
  for (const chunk of args.ranked_chunks ?? []) {
    const text = (chunk || "").trim();
    if (!text) continue;
    const key = text.toLowerCase();
    if (packedNorm.has(key) || containedInHot(text, hot)) continue;
    if (blocked(text)) {
      dupSuppressed += estimateTokens(text);
      continue;
    }
    if (marginal(text)) {
      dupSuppressed += estimateTokens(text);
      continue;
    }
    if (!fits(text)) continue;
    const toks = estimateTokens(text);
    parts.push(text);
    extraParts.push(text);
    used += toks;
    tauRanked += toks;
    packedNorm.add(key);
    chunkAdded = true;
  }

  let spanAdded = false;
  for (const chunk of args.span_chunks ?? []) {
    const text = (chunk || "").trim();
    if (!text) continue;
    const key = text.toLowerCase();
    if (packedNorm.has(key) || containedInHot(text, hot)) continue;
    if (blocked(text)) {
      dupSuppressed += estimateTokens(text);
      continue;
    }
    if (marginal(text)) {
      dupSuppressed += estimateTokens(text);
      continue;
    }
    if (!fits(text)) continue;
    const toks = estimateTokens(text);
    parts.push(text);
    extraParts.push(text);
    used += toks;
    tauSpans += toks;
    packedNorm.add(key);
    spanAdded = true;
  }

  let body = parts.join("\n\n").trim();
  let { ws, chars4 } = countTokens(body);
  let packed = chars4;
  if (packed > cap && body) {
    body = truncateToBudget(body, cap);
    ({ ws, chars4 } = countTokens(body));
    packed = chars4;
  }
  if (typedAdded || chunkAdded || spanAdded) method = "query-pack";
  else if (!hot) method = chunkAdded || spanAdded ? "extractive" : "hot_set";

  const skip =
    Boolean(args.allow_skip) &&
    crossTurnDedupEnabled() &&
    !args.openitem_changed &&
    !args.node_superseded &&
    packed < skipFloor;
  if (skip) {
    return {
      text: "",
      packed_tokens: 0,
      tokens_ws: 0,
      tokens_chars4: 0,
      budget: cap,
      rate: 0,
      method: "skip",
      novel_tokens: 0,
      dup_suppressed_tokens: dupSuppressed + packed,
      line_hashes: [],
      tau_hot: 0,
      tau_typed: 0,
      tau_ranked: 0,
      tau_spans: 0,
    };
  }

  const hashes = body
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => lineHash(l));
  let novel = packed;
  if (suppress.size && hashes.length) {
    const novelParts = body
      .split("\n")
      .filter((line) => line.trim() && !args.recent_hashes?.has(lineHash(line)));
    novel = novelParts.length ? estimateTokens(novelParts.join("\n")) : 0;
  }
  return {
    text: body,
    packed_tokens: packed,
    tokens_ws: ws,
    tokens_chars4: chars4,
    budget: cap,
    rate: cap ? packed / cap : 0,
    method,
    novel_tokens: novel,
    dup_suppressed_tokens: dupSuppressed,
    line_hashes: hashes,
    tau_hot: tauHot,
    tau_typed: tauTyped,
    tau_ranked: tauRanked,
    tau_spans: tauSpans,
  };
}

function containedInHot(text: string, hot: string): boolean {
  if (!hot || !text) return false;
  const needle = text.toLowerCase();
  const hay = hot.toLowerCase();
  if (hay.includes(needle)) return true;
  if (text.includes(":")) {
    const rest = text.split(":", 2)[1]?.trim().toLowerCase() ?? "";
    if (rest && hay.includes(rest)) return true;
  }
  return false;
}

function truncateToBudget(text: string, budget: number): string {
  if (estimateTokens(text) <= budget) return text;
  const maxChars = Math.max(1, budget * 4);
  if ([...text].length <= maxChars) return text;
  // Prefer code-point truncate to match estimateTokens
  const chars = [...text];
  return chars.slice(0, Math.max(0, maxChars - 3)).join("").replace(/\s+$/, "") + "...";
}
