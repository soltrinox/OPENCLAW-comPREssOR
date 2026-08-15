/** Structure-aware chunker — port of chunks.py */

import { PATH_RE } from "./extractive.ts";

const HEADING_SPLIT_RE = /(?=^#{1,6}\s+)/m;
const SENTENCE_SPLIT_RE = /(?<=[.!?])\s+|\n+/;
const FENCE_RE = /```[^\n]*\n.*?```/gs;
const DEF_CLASS_RE = /^(?:async\s+def|def|class)\s+\S[^\n]*/gm;
const HEADING_LINE_RE = /^#{1,6}\s+/;
const PLACEHOLDER_FENCE = /__FENCE_(\d+)__/g;
const PLACEHOLDER_PATH = /__PATH_(\d+)__/g;

const TARGET_TOKENS = 96;
const MIN_TOKENS = 64;
const MAX_TOKENS = 128;

export function estimateWsTokens(text: string): number {
  return text.trim() ? text.split(/\s+/).length : 0;
}

export function chunkText(text: string, maxChunks = 8): string[] {
  const raw = text || "";
  if (!raw.trim()) return [""];

  const { text: stripped, fences } = extractFences(raw);
  const { text: protectedText, paths } = protectPaths(stripped);

  const sections = protectedText
    .split(HEADING_SPLIT_RE)
    .map((s) => s.trim())
    .filter(Boolean);
  const secs = sections.length <= 1 ? [protectedText.trim()] : sections;

  const headings: string[] = [];
  const body: string[] = [];
  for (const sec of secs) {
    const lines = sec.split("\n");
    if (lines[0] && HEADING_LINE_RE.test(lines[0]!)) {
      headings.push(lines[0]!.trim());
      const rest = lines.slice(1).join("\n").trim();
      if (rest) body.push(...splitCodeAndSentences(rest));
    } else {
      body.push(...splitCodeAndSentences(sec));
    }
  }

  const restoredHead = headings.map((h) => restore(h, fences, paths));
  const restoredBody = body.map((b) => restore(b, fences, paths));
  const mergedBody = mergeToTarget(restoredBody);
  let chunks = [...restoredHead, ...mergedBody]
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
  if (!chunks.length) return [raw.trim()];
  if (chunks.length <= maxChunks) return chunks;

  const keepHead = Math.min(restoredHead.length, maxChunks);
  let selected = restoredHead.slice(0, keepHead);
  const remaining = maxChunks - keepHead;
  const pool = mergedBody;
  const fencePool = pool.filter((c) => isCompleteFence(c));
  if (remaining <= 0) {
    if (fencePool.length && maxChunks >= 1) {
      selected = [...selected.slice(0, maxChunks - 1), fencePool[0]!];
    }
    return selected.slice(0, maxChunks);
  }
  if (pool.length <= remaining) return [...selected, ...pool].slice(0, maxChunks);
  if (remaining === 1) {
    selected.push(fencePool[0] ?? pool[0]!);
    return selected.slice(0, maxChunks);
  }
  const step = (pool.length - 1) / (remaining - 1);
  const idxs = [...new Set([...Array(remaining)].map((_, i) => Math.round(i * step)))].sort(
    (a, b) => a - b,
  );
  for (const i of idxs) {
    if (i < pool.length) selected.push(pool[i]!);
  }
  if (fencePool.length && !selected.some((c) => isCompleteFence(c))) {
    selected[selected.length - 1] = fencePool[0]!;
  }
  return selected.slice(0, maxChunks);
}

function isCompleteFence(text: string): boolean {
  const s = (text || "").trim();
  if (!(s.startsWith("```") && s.endsWith("```"))) return false;
  const count = (s.match(/```/g) || []).length;
  return count >= 2 && count % 2 === 0;
}

function extractFences(text: string): { text: string; fences: string[] } {
  const fences: string[] = [];
  const out = text.replace(FENCE_RE, (match) => {
    fences.push(match.trim());
    return `\n\n__FENCE_${fences.length - 1}__\n\n`;
  });
  return { text: out, fences };
}

function protectPaths(text: string): { text: string; paths: string[] } {
  const paths: string[] = [];
  const re = new RegExp(PATH_RE.source, "gi");
  const out = text.replace(re, (match) => {
    paths.push(match);
    return ` __PATH_${paths.length - 1}__ `;
  });
  return { text: out, paths };
}

function restore(text: string, fences: string[], paths: string[]): string {
  let out = text.replace(PLACEHOLDER_FENCE, (_m, idx) => {
    const i = Number(idx);
    return i >= 0 && i < fences.length ? fences[i]! : _m;
  });
  out = out.replace(PLACEHOLDER_PATH, (_m, idx) => {
    const i = Number(idx);
    return i >= 0 && i < paths.length ? paths[i]! : _m;
  });
  return out;
}

function splitCodeAndSentences(text: string): string[] {
  const parts: string[] = [];
  let cursor = 0;
  const re = new RegExp(DEF_CLASS_RE.source, "gm");
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const before = text.slice(cursor, match.index).trim();
    if (before) {
      parts.push(
        ...before
          .split(SENTENCE_SPLIT_RE)
          .map((p) => p.trim())
          .filter(Boolean),
      );
    }
    const sig = match[0]!.trim();
    if (sig) parts.push(sig);
    cursor = match.index + match[0]!.length;
  }
  const rest = text.slice(cursor).trim();
  if (rest) {
    parts.push(
      ...rest
        .split(SENTENCE_SPLIT_RE)
        .map((p) => p.trim())
        .filter(Boolean),
    );
  }
  return parts;
}

function mergeToTarget(pieces: string[]): string[] {
  if (!pieces.length) return [];
  const out: string[] = [];
  let buf = "";
  let bufTok = 0;
  for (const piece of pieces) {
    const tok = estimateWsTokens(piece);
    const atomic = tok >= MIN_TOKENS || isCompleteFence(piece);
    if (atomic) {
      if (buf) {
        out.push(buf.trim());
        buf = "";
        bufTok = 0;
      }
      out.push(piece.trim());
      continue;
    }
    if (buf && bufTok + tok > MAX_TOKENS) {
      out.push(buf.trim());
      buf = piece;
      bufTok = tok;
      continue;
    }
    buf = buf ? `${buf} ${piece}`.trim() : piece;
    bufTok = estimateWsTokens(buf);
    if (bufTok >= TARGET_TOKENS) {
      out.push(buf.trim());
      buf = "";
      bufTok = 0;
    }
  }
  if (buf) out.push(buf.trim());
  return out;
}
