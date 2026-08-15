/** Query-aware ranking — port of rank.py */

import { chunkText } from "./chunks.ts";
import { hashedNgramEmbed } from "./embed.ts";

/** Duck-typed graph surface (avoids circular import with graph.ts). */
export type RankGraph = {
  windowText: (maxTurns?: number) => string;
  activeNodes: () => Array<{
    kind: string;
    label: string;
    summary: string;
    valid_start: string;
    attrs: Record<string, unknown>;
  }>;
  typedProjection: (
    query: string | null,
    opts?: { hot_set?: string; top_k?: number },
  ) => string[];
};

export const MIN_RANK_SCORE = 0.03;
export const RANK_FALLBACK_TOP_K = 8;

export function rankFallbackTopK(defaultK = RANK_FALLBACK_TOP_K): number {
  const raw = (process.env.CHAT_COMPRESSOR_RANK_FALLBACK_TOP_K || "").trim();
  if (!raw) return defaultK;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : defaultK;
}

export type RankedChunk = { text: string; score: number };

export function cosine(a: Float32Array, b: Float32Array): number {
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
  if (na < 1e-12 || nb < 1e-12) return 0;
  return dot / (na * nb);
}

export function rankChunks(
  query: string,
  chunks: string[],
  opts: { d?: number; seed?: number } = {},
): RankedChunk[] {
  const q = (query || "").trim();
  if (!q) return [];
  const d = opts.d ?? 256;
  const seed = opts.seed ?? 0;
  const qv = hashedNgramEmbed(q, d, seed);
  const scored: RankedChunk[] = [];
  const seen = new Set<string>();
  for (const raw of chunks) {
    const text = (raw || "").trim();
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const cv = hashedNgramEmbed(text, d, seed);
    scored.push({ text, score: cosine(qv, cv) });
  }
  scored.sort((a, b) => b.score - a.score || b.text.length - a.text.length);
  return scored;
}

export function rankRelevantChunks(
  query: string,
  chunks: string[],
  opts: { minScore?: number; fallbackTopK?: number } = {},
): RankedChunk[] {
  const ranked = rankChunks(query, chunks);
  if (!ranked.length) return [];
  const minScore = opts.minScore ?? MIN_RANK_SCORE;
  const filtered = ranked.filter((r) => r.score >= minScore);
  if (filtered.length) return filtered;
  const kFb = opts.fallbackTopK ?? rankFallbackTopK();
  return ranked.slice(0, Math.max(0, kFb));
}

function terms(text: string): Set<string> {
  const out = new Set<string>();
  for (const t of text.replace(/[/\-.]/g, " ").split(/\s+/)) {
    if (t.length >= 3) out.add(t.toLowerCase());
  }
  return out;
}

function relevant(text: string, termSet: Set<string>): boolean {
  if (!termSet.size) return false;
  for (const t of terms(text)) if (termSet.has(t)) return true;
  return false;
}

export function collectCandidates(
  graph: RankGraph,
  opts: { maxChunks?: number; query?: string | null } = {},
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (text: string) => {
    const t = (text || "").trim();
    if (!t) return;
    const key = t.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(t);
  };

  const queryTerms = terms(opts.query || "");
  const window = graph.windowText();
  for (const piece of chunkText(window, opts.maxChunks ?? 32)) add(piece);

  const nodes = graph.activeNodes();
  const turns = nodes
    .filter((n) => n.kind === "Turn")
    .sort(
      (a, b) =>
        a.valid_start.localeCompare(b.valid_start) ||
        Number(a.attrs.index ?? 0) - Number(b.attrs.index ?? 0),
    );
  for (const node of turns.slice(-8)) add(node.summary || node.label);

  for (const line of graph.typedProjection(opts.query || null, { top_k: 16 })) {
    add(line);
  }

  for (const node of nodes) {
    const kind = node.kind;
    const attrs = node.attrs || {};
    const hint = String(attrs.kind_hint || "");
    const label = node.label;
    const summary = node.summary || label;
    const isRel = relevant(`${label} ${summary}`, queryTerms);
    const highValue = ["design", "decision", "outcome"].includes(hint);
    const pathish = hint === "path" || hint === "heading";
    if (kind === "Topic") add(summary || label);
    if (kind === "Event") add(summary || label);
    if (kind === "Fact" && attrs.durable && (highValue || isRel || !pathish)) {
      add(node.summary || node.label);
      if (highValue || isRel) add(node.label);
    }
    if (kind === "OpenItem" && (attrs.state ?? "open") !== "done") add(node.label);
  }
  return out;
}
