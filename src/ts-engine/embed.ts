/** Hashed n-gram embed + protect tags — port of producer.py (offline path). */

import { blake2b } from "@noble/hashes/blake2.js";
import { chunkText } from "./chunks.ts";
import {
  DEFAULT_D,
  DEFAULT_EMA,
  DEFAULT_K_MAX,
  appendThenPool,
  liveMask,
  type FloatMatrix,
} from "./compress.ts";

const TOKEN_RE = /[A-Za-z0-9_']+/g;
const UUID_RE =
  /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/;
const URL_RE = /https:\/\/[^\s<>"']{4,200}/;
const PATHISH_RE =
  /(?:^|[\s`"'(])((?:[\w.-]+\/)+[\w.-]+\.[A-Za-z0-9]{1,12}|\/[\w./-]+)/;
const DECISION_RE =
  /\b(decided|chose|decision|instead of|must not|constraint|invariant|policy)\b/i;

export function chunksPerTurn(defaultN = 16): number {
  const raw = (process.env.CHAT_COMPRESSOR_CHUNKS_PER_TURN || "").trim();
  if (!raw) return defaultN;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 1 ? n : defaultN;
}

export function protectKinds(defaultKinds = ["path", "decision", "identifier"]): Set<string> {
  const raw = (process.env.CHAT_COMPRESSOR_PROTECT_KINDS || defaultKinds.join(",")).trim();
  if (!raw) return new Set(defaultKinds);
  return new Set(
    raw
      .split(",")
      .map((p) => p.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function tagChunk(text: string, kinds?: Set<string>): Set<string> {
  const active = kinds ?? protectKinds();
  const tags = new Set<string>();
  const body = text || "";
  if (active.has("identifier") && (UUID_RE.test(body) || URL_RE.test(body))) {
    tags.add("identifier");
  }
  if (active.has("path") && PATHISH_RE.test(body)) tags.add("path");
  if (active.has("decision") && DECISION_RE.test(body)) tags.add("decision");
  return tags;
}

function blake2b8(payload: Uint8Array): Uint8Array {
  return blake2b(payload, { dkLen: 8 });
}

/** Hash-stable mean-pooled n-gram projection. Matches Python hashed_ngram_embed. */
export function hashedNgramEmbed(
  text: string,
  d = DEFAULT_D,
  seed = 0,
): Float32Array {
  const vec = new Float32Array(d);
  let tokens = [...(text.toLowerCase().match(TOKEN_RE) || [])];
  if (!tokens.length) tokens = ["empty"];
  const enc = new TextEncoder();
  for (const n of [1, 2, 3] as const) {
    for (let i = 0; i <= tokens.length - n; i++) {
      const gram = tokens.slice(i, i + n).join(" ");
      const payload = enc.encode(`${seed}:${n}:${gram}`);
      const digest = blake2b8(payload);
      const idx =
        (digest[0]! |
          (digest[1]! << 8) |
          (digest[2]! << 16) |
          (digest[3]! << 24)) >>>
        0;
      const bucket = idx % d;
      const sign = digest[4]! % 2 === 0 ? 1.0 : -1.0;
      vec[bucket]! += sign;
    }
  }
  let norm = 0;
  for (let i = 0; i < d; i++) norm += vec[i]! * vec[i]!;
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < d; i++) vec[i]! /= norm;
  }
  return vec;
}

export type CompressResult = {
  C: FloatMatrix;
  M: Float32Array;
  producer: string;
};

export class EmbeddingProducer {
  d: number;
  kMax: number;
  seed: number;
  name: string;
  ema: number;

  constructor(opts: {
    d?: number;
    kMax?: number;
    seed?: number;
    name?: string;
    ema?: number;
  } = {}) {
    this.d = opts.d ?? DEFAULT_D;
    this.kMax = opts.kMax ?? DEFAULT_K_MAX;
    this.seed = opts.seed ?? 0;
    this.name = opts.name ?? "embed";
    this.ema = opts.ema ?? DEFAULT_EMA;
  }

  encodeRows(text: string): { rows: FloatMatrix; chunks: string[] } {
    const chunks = chunkText(text, chunksPerTurn());
    const rows = chunks.map((c) => hashedNgramEmbed(c, this.d, this.seed));
    return { rows, chunks };
  }

  compress(prevC: FloatMatrix | null, newInput: string): CompressResult {
    const { rows, chunks } = this.encodeRows(newInput);
    const kinds = protectKinds();
    const tags = chunks.map((c) => tagChunk(c, kinds));
    const mask = tags.map((t) => t.size > 0);
    const nPrev = prevC?.length ?? 0;
    const fullMask = [...Array(nPrev).fill(false), ...mask];
    const fullTags = [...Array.from({ length: nPrev }, () => new Set<string>()), ...tags];
    const cT = appendThenPool(prevC, rows, {
      kMax: this.kMax,
      ema: this.ema,
      protectMask: fullMask,
      protectKindsTags: fullTags,
    });
    return { C: cT, M: liveMask(cT.length), producer: this.name };
  }
}
