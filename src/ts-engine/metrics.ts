/**
 * Payload metrics — port of engine/src/chat_compressor/metrics.py.
 * τ uses Python `len(str)` semantics (Unicode code points), not UTF-16 length.
 */

import { HEADING_RE, PATH_RE, QUOTED_RE, jaccard, keywordSet } from "./extractive.ts";

const TOKEN_RE = /[A-Za-z0-9_./#-]+/g;
const HOT_LINE_KIND_RE = /^(OpenItem|Fact|Topic|Event|Turn)\s*:?\s+/i;
const PATH_LIKE_RE =
  /(?:^|\s)(?:Fact\s+)?(?:[\w.-]+\/)+[\w.-]+|heading:|\b[\w.-]+\.(?:md|py|json|sh|tex|png|jpg)\b/i;

export const PREAMBLE_LIST = [
  "let me",
  "i'll",
  "i will",
  "reading",
  "checking",
  "running",
  "thanks",
  "thank you",
  "got it",
  "looking at",
  "let's see",
] as const;

/** Unicode code-point length (matches Python 3 `len(str)`). */
export function codePointLen(text: string): number {
  return [...text].length;
}

/**
 * τ = max(1, floor((len+3)/4)) for nonempty; 0 for empty.
 * Uses Unicode code points to match Python metrics.estimate_tokens.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.floor((codePointLen(text) + 3) / 4));
}

export function keywordJaccard(a: string, b: string): number {
  return jaccard(keywordSet(a), keywordSet(b));
}

export function entityRecall(
  referenceTerms: Iterable<string>,
  payload: string,
): number {
  const refs = new Set(
    [...referenceTerms].map((t) => t.toLowerCase().trim()).filter((t) => t.length > 0),
  );
  if (refs.size === 0) return 1.0;
  const payloadKw = keywordSet(payload);
  const payloadLower = payload.toLowerCase();
  let hits = 0;
  for (const term of refs) {
    if (payloadKw.has(term) || payloadLower.includes(term)) {
      hits += 1;
      continue;
    }
    const parts = [...term.matchAll(TOKEN_RE)].map((m) => m[0]!).filter((p) => p.length > 1);
    if (
      parts.length > 0 &&
      parts.every((p) => payloadKw.has(p.toLowerCase()) || payloadLower.includes(p.toLowerCase()))
    ) {
      hits += 1;
    }
  }
  return hits / refs.size;
}

export function referenceTermsFromText(text: string): Set<string> {
  const terms = new Set<string>();
  for (const m of text.matchAll(PATH_RE)) terms.add(m[0]!);
  for (const m of text.matchAll(HEADING_RE)) terms.add(m[1]!.trim());
  for (const m of text.matchAll(QUOTED_RE)) terms.add(m[1]!.trim());
  return new Set([...terms].filter((t) => t.length >= 2));
}

export function isPreambleText(text: string): boolean {
  const blob = (text || "").trim().toLowerCase();
  if (!blob) return false;
  const stripped = blob.replace(HOT_LINE_KIND_RE, "").replace(/^[:\s]+/, "").trim();
  const head = stripped.slice(0, 40);
  return PREAMBLE_LIST.some((p) => head.startsWith(p));
}

export function splitRetainedLines(...blobs: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const blob of blobs) {
    for (const raw of (blob || "").split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      const key = line.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(line);
    }
  }
  return out;
}

export function hotSetPollution(hotSetText: string): Record<string, number> {
  let pathTok = 0;
  let decisionTok = 0;
  let otherTok = 0;
  for (const line of splitRetainedLines(hotSetText)) {
    const tok = estimateTokens(line);
    const lower = line.toLowerCase();
    if (lower.startsWith("openitem ") || lower.slice(0, 20).includes("openitem ")) {
      decisionTok += tok;
      continue;
    }
    if (PATH_LIKE_RE.test(line) || lower.includes("heading:")) {
      pathTok += tok;
      continue;
    }
    if (lower.startsWith("fact ") || HOT_LINE_KIND_RE.test(line)) {
      decisionTok += tok;
    } else {
      otherTok += tok;
    }
  }
  const total = pathTok + decisionTok + otherTok;
  return {
    path_heading_tokens: pathTok,
    decision_openitem_tokens: decisionTok,
    other_tokens: otherTok,
    total_tokens: total,
    pollution: total ? pathTok / total : 0.0,
  };
}
