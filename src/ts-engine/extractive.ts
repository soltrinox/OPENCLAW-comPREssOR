/** Extractive helpers — port of extractive.py */

export const PATH_EXTENSIONS = [
  "md", "py", "ts", "tsx", "json", "tex", "sh", "bash", "zsh", "yaml", "yml",
  "toml", "cfg", "ini", "sql", "rs", "go", "java", "kt", "swift", "c", "h",
  "cpp", "css", "scss", "html", "png", "jpg", "svg", "pdf", "log.txt",
] as const;

const PATH_EXT_ALT = PATH_EXTENSIONS.map((e) => e.replace(/\./g, "\\.")).join("|");
export const PATH_RE = new RegExp(
  `(?:[\\w./-]+/)*[\\w.-]+\\.(?:${PATH_EXT_ALT})\\b`,
  "gi",
);
export const PATH_FACT_RE = PATH_RE;
export const HEADING_RE = /^#{1,6}\s+(.+)$/gm;
export const QUOTED_RE = /["']([^"']{2,80})["']/g;
export const PROPER_NOUN_RE = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b/g;
export const TOKEN_SPLIT_RE = /[^\w./#-]+/;

export const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "to", "of", "in", "on", "for", "is", "are",
  "was", "were", "be", "been", "being", "that", "this", "with", "from", "as",
  "at", "by", "it", "its", "into", "after", "before", "until", "while", "about",
  "then", "than", "so", "if", "but", "not", "no", "yes", "you", "your", "we",
  "our", "they", "their", "he", "she", "his", "her", "do", "does", "did", "done",
  "have", "has", "had", "will", "would", "can", "could", "should", "may",
  "might", "must", "shall", "just", "also", "only", "very", "more", "most",
  "other", "some", "such", "too", "what", "when", "where", "which", "who",
  "whom", "how", "all", "each", "few", "both", "own", "same", "any", "add",
  "file", "right", "left", "check", "wait", "call", "create", "open", "item",
  "list", "note", "text", "turn", "user", "agent", "please", "thank", "thanks",
]);

function rankTuple(token: string, boost = 0): [number, number, number, string] {
  const lowered = token.toLowerCase();
  const pathish =
    token.includes(".") &&
    (token.includes("/") || PATH_EXTENSIONS.some((ext) => lowered.endsWith("." + ext)));
  const isPathScore = pathish ? 0 : 1;
  const words = token.split(/\s+/).length;
  return [Math.max(0, isPathScore - boost), -words, -token.length, token.toLowerCase()];
}

function tokenizeCandidate(raw: string): string[] {
  const parts = raw
    .split(TOKEN_SPLIT_RE)
    .map((p) => p.replace(/^[.,;:\s]+|[.,;:\s]+$/g, "").trim())
    .filter(Boolean);
  const out: string[] = [];
  for (const part of parts) {
    if (!part || STOPWORDS.has(part.toLowerCase())) continue;
    if (part.length < 2) continue;
    out.push(part);
  }
  return out;
}

export function extractiveCandidates(text: string): string[] {
  if (!text) return [];
  const scored: Array<{ key: [number, number, number, string]; tok: string }> = [];
  const seen = new Set<string>();

  const add = (raw: string, boost = 0) => {
    const cleaned = raw.trim().replace(/^["']+|["']+$/g, "");
    if (cleaned.includes(" ") && cleaned.length >= 2 && cleaned.length <= 80) {
      const key = cleaned.toLowerCase();
      if (!seen.has(key) && !STOPWORDS.has(key)) {
        seen.add(key);
        scored.push({ key: rankTuple(cleaned, boost), tok: cleaned });
      }
    }
    for (const tok of tokenizeCandidate(raw)) {
      const key = tok.toLowerCase();
      if (seen.has(key) || STOPWORDS.has(key)) continue;
      seen.add(key);
      scored.push({ key: rankTuple(tok, boost), tok });
    }
  };

  for (const m of text.matchAll(new RegExp(PATH_RE.source, "gi"))) add(m[0]!, 2);
  for (const m of text.matchAll(new RegExp(HEADING_RE.source, "gm"))) add(m[1]!, 2);
  for (const m of text.matchAll(new RegExp(QUOTED_RE.source, "g"))) add(m[1]!, 1);
  for (const m of text.matchAll(new RegExp(PROPER_NOUN_RE.source, "g"))) add(m[1]!, 1);

  scored.sort((a, b) => {
    for (let i = 0; i < 4; i++) {
      if (a.key[i]! < b.key[i]!) return -1;
      if (a.key[i]! > b.key[i]!) return 1;
    }
    return 0;
  });
  return scored.map((s) => s.tok);
}

export function extractiveGist(text: string, maxTokens = 32): string {
  const cands = extractiveCandidates(text);
  if (maxTokens < 1) return "";
  const out: string[] = [];
  const seen = new Set<string>();
  for (const tok of cands) {
    const parts = tok.includes(" ") ? tok.split(/\s+/) : [tok];
    for (const part of parts) {
      const key = part.toLowerCase();
      if (seen.has(key) || STOPWORDS.has(key) || part.length < 2) continue;
      seen.add(key);
      out.push(part);
      if (out.length >= maxTokens) return out.join(" ");
    }
  }
  return out.join(" ");
}

export function keywordSet(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/[A-Za-z0-9_./#-]+/g)) {
    if (m[0]!.length > 1) out.add(m[0]!.toLowerCase());
  }
  return out;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1.0;
  if (a.size === 0 || b.size === 0) return 0.0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  const union = a.size + b.size - inter;
  return union ? inter / union : 0.0;
}
