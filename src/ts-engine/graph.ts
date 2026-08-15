/**
 * CtxGraph — port of graph.py (ctx-graph/v1).
 * Algorithm-locked to Plan 04 recall-0.5 operators.
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import {
  PATH_RE as PATH_FACT_RE,
  PROPER_NOUN_RE,
  jaccard,
  keywordSet,
} from "./extractive.ts";
import { rankChunks } from "./rank.ts";

export const SCHEMA_ID = "ctx-graph/v1";
export const KINDS = ["Turn", "Topic", "Fact", "OpenItem", "Event"] as const;
export const RELS = ["mentions", "contains", "continues", "supersedes", "derived_from"] as const;

const SENTENCE_RE = /(?<=[.!?])\s+/;
const ITEM_RE = /["']([^"']{2,80})["']/g;
const OPEN_HINT_RE = /\b(todo|open|add|create|remain|left|item)\b/i;
const DONE_ITEM_RE =
  /(?:mark(?:ed)?|completed?)\s+["']([^"']+)["']|["']([^"']+)["']\s+(?:done|complete)|completed[:\s]+["']([^"']+)["']/gi;
const DONE_VERB_RE =
  /\b(?:drafted|implemented|verified|completed|marked)\s+["']?([^"'\n,]{2,80})["']?/gi;
const HEADING_FACT_RE = /^(#{1,6})\s+(.+)$/gm;
const FENCE_RE = /```[^\n]*\n.*?```/gs;
const CHECKBOX_RE = /^[\s]*[-*]\s+\[([ xX])\]\s+(.+)$/gm;
const TODO_LINE_RE = /\bTODO:\s*(.+)$/gim;
const NEXT_LINE_RE = /^\s*next:\s*(.+)$/gim;
const BULLET_RE = /^\s*[-*]\s+(?:\[(?: |x|X)\]\s+)?(.+)$/;
const NUMBERED_RE = /^\s*\d+\.\s+(.+)$/;
const DEFERRED_HINT_RE =
  /\b(deferred|out of scope|left unresolved|left alone|untouched because)\b/i;
const DEFERRED_HEADING_RE = /\b(left unresolved|deferred|out of scope|unresolved)\b/i;
const ACTION_ITEM_RE =
  /\b(should|must|need to|fix|add|move|keep|treat|impose|defer|todo)\b/i;
const DECISION_BOOST_RE =
  /\b(decided|chose|instead of|because|so that|constraint|invariant|must not|rather than|the fix is|impose|should not|reveal rule|contract|policy)\b/i;
const TRADEOFF_RE = /\b(vs\.?|versus|trade-?off|rather than|instead of|compared to)\b/i;
const NUMERIC_CLAIM_RE =
  /\b\d+(?:\.\d+)?\s*(?:pages?|%|percent|tokens?|chars?|hours?|ms|kb|mb|lines?|chapters?|turns?)\b/i;
const IDENT_RE =
  /\b(phi|φ|part ii|part i|tier-?\d|c\d{2}-\d{2}|eni6ma|unicity|hourglass|shannon)\b/i;
const DEFINE_RE =
  /\b(is defined as|means that|defines |definition|term:|replaces|maps? that)\b|\b\w+ is a \b/i;
const PREAMBLE_RE =
  /^\s*(let me|i'll|i will|i'm going to|i am going to|reading|checking|running|thanks|thank you|got it|sure[,.]|looking at|let's see|i can |i'm finding|i read )\b/i;
const TOPIC_LINE_RE =
  /^[ \t]*(?:topic|goal|workstream|task)[ \t]*:[ \t]*(.+)$/gim;
const DESIGN_HEADING_RE =
  /\b(?:recommended structure|template|decision|design|glossary design)\b/i;
const DESIGN_LINE_RE =
  /^\s*(?:[-*]\s*)?(?:(structure|entry fields|fields|recommendation|decision|design)\s*[=:]\s*)?(.+)$/i;
const OPEN_LINE_RE =
  /^\s*(?:[-*]\s*)?(?:open item|open|todo|remaining|follow-up|next)\s*:\s*(.+)$/gim;
const DONE_LINE_RE =
  /^\s*(?:[-*]\s*)?(?:completed|done|fixed|resolved|validation)\s*:\s*(.+)$/gim;
const OUTCOME_RE =
  /\b(?:\d+\s+(?:entries?\s+standardized|broken\s+links?)|0\s+broken\s+links?|Ch\d+\s+[A-Z]{1,4}-\d+\s+link\s+fixed|validation\s+passed|fixed\s+[\w./#-]+)\b/gi;

export const MAX_ACTIVE_TURNS = 48;
export const MAX_ACTIVE_NON_DURABLE_FACTS = 64;
export const MAX_ACTIVE_DURABLE_FACTS = 48;
export const PER_TURN_PATH_CAP = 8;
export const HOT_SET_OPEN_SHARE = 0.4;
export const HOT_SET_DECISION_SHARE = 0.4;
export const HOT_SET_PATH_HEADING_SHARE = 0.2;
export const DEFAULT_HOT_SET_MAX_CHARS = 800;

const UUID_FACT_RE =
  /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g;
const URL_FACT_RE = /https:\/\/[^\s<>"']{4,240}/g;
const CLOUD_RUN_RE =
  /https:\/\/[a-z0-9-]+-[a-z0-9]+-[a-z0-9]+\.[a-z0-9-]+\.run\.app(?:\/[^\s<>"']*)?/gi;
const TELEGRAM_MSG_ID_RE =
  /\b(?:telegram[-_ ]?(?:message[-_ ]?)?id|msg[_-]?id)\s*[:=]?\s*(\d{5,})\b/gi;
const SLASH_CMD_RE = /^\s*(\/(?:compact|new|context))\b/gim;

export function hotSetMaxChars(defaultVal = DEFAULT_HOT_SET_MAX_CHARS): number {
  const raw = (process.env.CHAT_COMPRESSOR_HOTSET_MAX_CHARS || "").trim();
  if (!raw) return defaultVal;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 64 ? n : defaultVal;
}

function nowIso(): string {
  return new Date().toISOString();
}

export function newId(prefix: string): string {
  return `urn:ctx:${prefix}:${randomUUID()}`;
}

export type GraphNode = {
  id: string;
  kind: string;
  label: string;
  summary: string;
  status: string;
  valid_start: string;
  valid_end: string | null;
  attrs: Record<string, unknown>;
};

export type GraphEdge = {
  id: string;
  src: string;
  dst: string;
  rel: string;
  valid_start: string;
  valid_end: string | null;
};

export function nodeToDict(n: GraphNode): Record<string, unknown> {
  return {
    id: n.id,
    kind: n.kind,
    label: n.label,
    summary: n.summary,
    status: n.status,
    valid_start: n.valid_start,
    valid_end: n.valid_end,
    attrs: { ...n.attrs },
  };
}

export function nodeFromDict(data: Record<string, unknown>): GraphNode {
  return {
    id: String(data.id),
    kind: String(data.kind),
    label: String(data.label ?? ""),
    summary: String(data.summary ?? ""),
    status: String(data.status ?? "active"),
    valid_start: String(data.valid_start ?? ""),
    valid_end: (data.valid_end as string | null) ?? null,
    attrs: { ...((data.attrs as Record<string, unknown>) || {}) },
  };
}

export function edgeToDict(e: GraphEdge): Record<string, unknown> {
  return {
    id: e.id,
    src: e.src,
    dst: e.dst,
    rel: e.rel,
    valid_start: e.valid_start,
    valid_end: e.valid_end,
  };
}

export function edgeFromDict(data: Record<string, unknown>): GraphEdge {
  return {
    id: String(data.id),
    src: String(data.src),
    dst: String(data.dst),
    rel: String(data.rel),
    valid_start: String(data.valid_start ?? ""),
    valid_end: (data.valid_end as string | null) ?? null,
  };
}

function factsPerTurn(): number {
  const raw = (process.env.CHAT_COMPRESSOR_FACTS_PER_TURN || "").trim();
  if (!raw) return 3;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? Math.max(1, Math.min(12, n)) : 3;
}

function scoreFactSentence(sentence: string, priorUser = ""): number {
  let score = 0;
  if (DECISION_BOOST_RE.test(sentence)) score += 3;
  DECISION_BOOST_RE.lastIndex = 0;
  if (TRADEOFF_RE.test(sentence)) score += 1.5;
  TRADEOFF_RE.lastIndex = 0;
  if (NUMERIC_CLAIM_RE.test(sentence)) score += 1;
  NUMERIC_CLAIM_RE.lastIndex = 0;
  const idents = [...sentence.matchAll(new RegExp(IDENT_RE.source, "gi"))];
  if (idents.length) score += 1.5 * Math.min(idents.length, 4);
  if (DEFINE_RE.test(sentence)) score += 2;
  DEFINE_RE.lastIndex = 0;
  if (PREAMBLE_RE.test(sentence)) score -= 3;
  PREAMBLE_RE.lastIndex = 0;
  if (priorUser && jaccard(keywordSet(sentence), keywordSet(priorUser)) >= 0.6) score -= 4;
  return score;
}

function factSentences(text: string, priorUser = ""): Array<[string, number, string]> {
  const chunks = text.split(SENTENCE_RE).map((c) => c.trim()).filter(Boolean);
  const scored: Array<[number, string, string]> = [];
  for (let chunk of chunks) {
    if (chunk.length < 20) continue;
    if (chunk.length > 240) chunk = chunk.slice(0, 237) + "...";
    const salience = scoreFactSentence(chunk, priorUser);
    const kindHint = salience >= 2.0 ? "decision" : "sentence";
    scored.push([salience, chunk, kindHint]);
  }
  scored.sort((a, b) => b[0] - a[0]);
  const positive = scored.filter((r) => r[0] > 0);
  const ranked = positive.length ? positive : scored;
  return ranked.slice(0, factsPerTurn()).map(([sal, chunk, hint]) => [chunk, sal, hint]);
}

function pathFacts(
  text: string,
  mentionCounts: Record<string, number>,
): Array<[string, number]> {
  const unfenced = text.replace(FENCE_RE, "\n");
  const fences = [...text.matchAll(new RegExp(FENCE_RE.source, "gs"))].map((m) => m[0]!).join("\n");
  const outside = [...unfenced.matchAll(new RegExp(PATH_FACT_RE.source, "gi"))].map((m) => m[0]!);
  const inside = [...fences.matchAll(new RegExp(PATH_FACT_RE.source, "gi"))].map((m) => m[0]!);
  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const p of [...outside, ...inside]) {
    const key = p.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    ordered.push(p);
  }
  const scored: Array<[number, string]> = [];
  for (const p of ordered) {
    const key = p.toLowerCase();
    const inOut = outside.filter((x) => x.toLowerCase() === key).length;
    const inFence = inside.filter((x) => x.toLowerCase() === key).length;
    mentionCounts[key] = (mentionCounts[key] || 0) + inOut + inFence;
    const fenceOnly = inOut === 0 && inFence > 0;
    if (fenceOnly && mentionCounts[key]! < 2) continue;
    let salience = 0.45 + 0.1 * Math.min(mentionCounts[key]!, 3);
    if (inOut) salience += 0.15;
    const low = p.toLowerCase();
    if (`/${low}`.includes("/scripts/") || low.startsWith("scripts/")) salience += 0.5;
    if (`/${low}`.includes("/figures/") || low.startsWith("figures/")) salience += 0.5;
    if ([".py", ".json", ".sh", ".tex", ".png"].some((e) => low.endsWith(e))) salience += 0.25;
    if (low.endsWith(".log.txt") || low.includes("test-results/") || low.includes(".cursor/"))
      salience -= 0.4;
    if (low.startsWith("/users/")) salience -= 0.2;
    scored.push([salience, p]);
  }
  scored.sort((a, b) => b[0] - a[0]);
  return scored.slice(0, PER_TURN_PATH_CAP).map(([sal, p]) => [p, sal]);
}

function headingFacts(text: string): Array<[string, number]> {
  const unfenced = text.replace(FENCE_RE, "\n");
  const found = [...unfenced.matchAll(new RegExp(HEADING_FACT_RE.source, "gm"))].map((m) => [
    m[1]!.length,
    m[2]!.trim(),
  ] as [number, string]);
  const seen = new Set<string>();
  const out: Array<[string, number]> = [];
  for (const [level, heading] of found) {
    const key = heading.toLowerCase();
    if (seen.has(key) || heading.length < 2) continue;
    seen.add(key);
    out.push([heading, level]);
    if (out.length >= 8) break;
  }
  return out;
}

function h1H2Headings(text: string): Array<[number, string]> {
  return headingFacts(text)
    .filter(([, level]) => level <= 2)
    .map(([heading, level]) => [level, heading]);
}

function topicSubsumes(a: string, b: string): boolean {
  const left = a.toLowerCase().trim();
  const right = b.toLowerCase().trim();
  if (left === right) return false;
  return left.includes(right) || right.includes(left);
}

function isPathOrHeading(node: GraphNode): boolean {
  const hint = String(node.attrs.kind_hint || "");
  if (hint === "path" || hint === "heading") return true;
  const label = node.label || "";
  return (
    Boolean(label.match(new RegExp(PATH_FACT_RE.source, "i"))) ||
    (node.summary || "").startsWith("heading:")
  );
}

function isIdentifierFact(node: GraphNode): boolean {
  return String(node.attrs.kind_hint || "") === "identifier";
}

function referencedByOpenItem(graph: CtxGraph, fact: GraphNode): boolean {
  const label = (fact.label || "").toLowerCase();
  if (!label) return false;
  for (const node of graph.activeNodes()) {
    if (node.kind !== "OpenItem" || (node.attrs.state ?? "open") === "done") continue;
    const body = `${node.label} ${node.summary}`.toLowerCase();
    if (body.includes(label)) return true;
  }
  return false;
}

function identifierFacts(text: string): Array<[string, number]> {
  const found: Array<[string, number]> = [];
  const seen = new Set<string>();
  const add = (raw: string, salience: number) => {
    let ident = raw.trim().replace(/[).,;\]]+$/, "");
    if (ident.length > 240) ident = ident.slice(0, 237) + "...";
    const key = ident.toLowerCase();
    if (!ident || seen.has(key)) return;
    seen.add(key);
    found.push([ident, salience]);
  };
  for (const m of text.matchAll(new RegExp(CLOUD_RUN_RE.source, "gi"))) add(m[0]!, 2.4);
  for (const m of text.matchAll(new RegExp(UUID_FACT_RE.source, "g"))) add(m[0]!, 2.2);
  for (const m of text.matchAll(new RegExp(URL_FACT_RE.source, "g"))) add(m[0]!, 2.0);
  for (const m of text.matchAll(new RegExp(TELEGRAM_MSG_ID_RE.source, "gi"))) add(m[1]!, 1.8);
  return found;
}

function slashCommandEvents(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of (text || "").matchAll(new RegExp(SLASH_CMD_RE.source, "gim"))) {
    const cmd = m[1]!.toLowerCase();
    if (seen.has(cmd)) continue;
    seen.add(cmd);
    out.push(cmd);
  }
  return out;
}

function isDecisionFact(node: GraphNode): boolean {
  if (node.kind !== "Fact") return false;
  if (isPathOrHeading(node)) return false;
  const hint = String(node.attrs.kind_hint || "");
  if (["decision", "design", "outcome"].includes(hint)) return true;
  return Number(node.attrs.salience ?? 0) >= 2.0;
}

function cleanItemLabel(raw: string): string {
  let text = raw.replace(/[*`]+/g, "").trim();
  text = text.replace(/\s+/g, " ");
  if (text.length > 80) text = text.slice(0, 77) + "...";
  return text.replace(/^[ .]+|[ .]+$/g, "");
}

function checkboxItems(text: string): Array<[string, string]> {
  const found: Array<[string, string]> = [];
  for (const match of text.matchAll(new RegExp(CHECKBOX_RE.source, "gm"))) {
    const mark = match[1]!;
    const label = cleanItemLabel(match[2]!);
    if (!label) continue;
    found.push([label, mark.toLowerCase() === "x" ? "done" : "open"]);
  }
  return found;
}

function deferredSectionItems(text: string): string[] {
  const items: string[] = [];
  let inDeferred = false;
  let deferredLevel = 0;
  for (const line of text.split("\n")) {
    const hm = /^(#{1,6})\s+(.+)$/.exec(line);
    if (hm) {
      const level = hm[1]!.length;
      const title = hm[2]!;
      if (DEFERRED_HEADING_RE.test(title)) {
        inDeferred = true;
        deferredLevel = level;
        continue;
      }
      if (inDeferred && level <= deferredLevel) inDeferred = false;
    }
    if (!inDeferred) continue;
    const bm = BULLET_RE.exec(line);
    if (bm) {
      const label = cleanItemLabel(bm[1]!);
      if (label) items.push(label);
    }
  }
  return items;
}

function openItemsFromText(text: string): Array<[string, string]> {
  const found: Array<[string, string]> = [];
  const seen = new Set<string>();
  const add = (label: string, state: string) => {
    const cleaned = cleanItemLabel(label);
    const key = cleaned.toLowerCase();
    if (!cleaned || seen.has(key) || cleaned.length < 2) return;
    seen.add(key);
    found.push([cleaned, state]);
  };
  for (const [label, state] of checkboxItems(text)) {
    if (state !== "done") add(label, state);
  }
  for (const match of text.matchAll(new RegExp(TODO_LINE_RE.source, "gim"))) add(match[1]!, "open");
  for (const match of text.matchAll(new RegExp(NEXT_LINE_RE.source, "gim"))) add(match[1]!, "open");
  for (const match of text.matchAll(new RegExp(OPEN_LINE_RE.source, "gim"))) add(match[1]!, "open");
  for (const label of deferredSectionItems(text)) add(label, "deferred");
  for (const line of text.split("\n")) {
    if (DEFERRED_HINT_RE.test(line)) {
      const bm = BULLET_RE.exec(line);
      if (bm) add(bm[1]!, "deferred");
      else if (!/^#{1,6}\s+/.test(line)) add(line, "deferred");
    }
    const nm = NUMBERED_RE.exec(line);
    if (nm && ACTION_ITEM_RE.test(line)) add(nm[1]!, "open");
  }
  if (OPEN_HINT_RE.test(text)) {
    for (const item of quotedItems(text)) add(item, "open");
  }
  return found.slice(0, 16);
}

function doneItems(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(new RegExp(DONE_ITEM_RE.source, "gi"))) {
    const item = match[1] || match[2] || match[3] || "";
    if (item) found.push(item.trim());
  }
  return found;
}

function doneItemsVerb(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(new RegExp(DONE_VERB_RE.source, "gi"))) {
    const item = (match[1] || "").replace(/^[ .]+|[ .]+$/g, "");
    if (item && item.length >= 2 && item.length <= 80) found.push(item);
  }
  return found;
}

function doneLines(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(new RegExp(DONE_LINE_RE.source, "gim"))) {
    const body = stripItem(match[1]!);
    if (body) found.push(body);
  }
  return found;
}

function labelOf(text: string, maxLen = 96): string {
  let clean = (text || "").trim().replace(/\s+/g, " ");
  if (clean.length <= maxLen) return clean;
  let cut = clean.slice(0, maxLen - 3).replace(/\s+$/, "");
  const space = cut.lastIndexOf(" ");
  if (space >= maxLen / 2) cut = cut.slice(0, space);
  return cut.replace(/[ ,;:-]+$/, "") + "...";
}

function stripItem(text: string): string {
  return (text || "").trim().replace(/^[-*\[\]() \t`"'.]+|[-*\[\]() \t`"'.]+$/g, "");
}

function sentenceFragment(text: string): string {
  let clean = (text || "").trim();
  for (const sep of ["\n", ". "]) {
    if (clean.includes(sep)) clean = clean.split(sep, 1)[0]!;
  }
  clean = clean.replace(/\s+/g, " ").replace(/^[-*\[\]() \t`"']+|[-*\[\]() \t`"']+$/g, "");
  if (!clean) return "";
  for (const sep of [". ", "\n"]) {
    if (clean.includes(sep)) clean = clean.split(sep, 1)[0]!;
  }
  return labelOf(clean, 140);
}

function dedupeLimited(items: string[], limit: number, maxLen: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const clean = labelOf(item, maxLen).trim();
    const key = clean.toLowerCase();
    if (!clean || seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
    if (out.length >= limit) break;
  }
  return out;
}

function designFacts(text: string): Array<[string, string]> {
  const found: Array<[string, string]> = [];
  let inDesignBlock = false;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) {
      inDesignBlock = false;
      continue;
    }
    const heading = line.replace(/^#+/, "").trim();
    const headingLike =
      line.startsWith("#") ||
      (!line.startsWith("-") &&
        !line.startsWith("*") &&
        DESIGN_HEADING_RE.test(heading) &&
        !/[=:]/.test(line));
    if (headingLike) {
      inDesignBlock = true;
      continue;
    }
    const match = DESIGN_LINE_RE.exec(line);
    if (!match) continue;
    const marker = (match[1] || "").toLowerCase();
    let body = stripItem(match[2]!);
    if (!body || body.length < 8) continue;
    const isDesign = inDesignBlock || Boolean(marker) || body.includes("->");
    if (!isDesign) continue;
    let hint =
      marker === "decision" || line.toLowerCase().startsWith("decision") ? "decision" : "design";
    if (["structure", "entry fields", "fields"].includes(marker)) body = `${marker}: ${body}`;
    else if (marker === "recommendation") body = `recommendation: ${body}`;
    else if (marker === "decision" || marker === "design") body = `${marker}: ${body}`;
    found.push([sentenceFragment(body), hint]);
  }
  const deduped: Array<[string, string]> = [];
  const seen = new Set<string>();
  for (const [summary, hint] of found) {
    const key = summary.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push([summary, hint]);
    if (deduped.length >= 8) break;
  }
  return deduped;
}

function outcomeItems(text: string): string[] {
  const found = [...text.matchAll(new RegExp(OUTCOME_RE.source, "gi"))].map((m) =>
    sentenceFragment(m[0]!),
  );
  return dedupeLimited(found, 8, 120);
}

function quotedItems(text: string): string[] {
  const found = [...text.matchAll(new RegExp(ITEM_RE.source, "g"))].map((m) => m[1]!.trim());
  const extra: string[] = [];
  for (const match of text.matchAll(/\badd\b[:\s]+(.+)/gi)) {
    for (const p of match[1]!.split(",")) {
      const s = p.replace(/^[ .]+|[ .]+$/g, "");
      if (s.length >= 2 && s.length <= 40 && !s.slice(1).includes(" ")) extra.push(s);
    }
  }
  const seen = new Set<string>();
  const items: string[] = [];
  for (const item of [...found, ...extra]) {
    const key = item.toLowerCase();
    if (key && !seen.has(key) && item.length >= 2 && item.length <= 80) {
      seen.add(key);
      items.push(item);
    }
  }
  return items.slice(0, 8);
}

export class CtxGraph {
  nodes: GraphNode[] = [];
  edges: GraphEdge[] = [];
  private byId = new Map<string, GraphNode>();
  private lastTurnId: string | null = null;
  private lastUserText = "";
  private pathMentions: Record<string, number> = {};

  insert(node: GraphNode): GraphNode {
    if (!node.valid_start) node.valid_start = nowIso();
    this.nodes.push(node);
    this.byId.set(node.id, node);
    return node;
  }

  addEdge(src: string, dst: string, rel: string, at?: string | null): GraphEdge {
    if (!(RELS as readonly string[]).includes(rel)) throw new Error(`unknown rel ${rel}`);
    const edge: GraphEdge = {
      id: newId("edge"),
      src,
      dst,
      rel,
      valid_start: at || nowIso(),
      valid_end: null,
    };
    this.edges.push(edge);
    return edge;
  }

  supersede(
    old: GraphNode,
    neu: GraphNode,
    opts: { at?: string | null; reason?: string } = {},
  ): [GraphNode, GraphNode, GraphEdge] {
    const stamp = opts.at || nowIso();
    old.status = "superseded";
    old.valid_end = stamp;
    old.attrs.supersede_reason = opts.reason ?? "superseded";
    if (!neu.valid_start) neu.valid_start = stamp;
    neu.status = "active";
    this.insert(neu);
    const edge = this.addEdge(neu.id, old.id, "supersedes", stamp);
    return [old, neu, edge];
  }

  activeNodes(): GraphNode[] {
    return this.nodes.filter((n) => n.status === "active" && n.valid_end == null);
  }

  prune(opts: {
    maxTurns?: number;
    maxNonDurableFacts?: number;
    maxDurableFacts?: number | null;
    at?: string | null;
  } = {}): number {
    const stamp = opts.at || nowIso();
    let pruned = 0;
    const maxTurns = opts.maxTurns ?? MAX_ACTIVE_TURNS;
    const maxNon = opts.maxNonDurableFacts ?? MAX_ACTIVE_NON_DURABLE_FACTS;
    const durableCap = opts.maxDurableFacts ?? MAX_ACTIVE_DURABLE_FACTS;

    const turns = this.activeNodes()
      .filter((n) => n.kind === "Turn")
      .sort(
        (a, b) =>
          a.valid_start.localeCompare(b.valid_start) ||
          Number(a.attrs.index ?? 0) - Number(b.attrs.index ?? 0),
      );
    while (turns.length > maxTurns) {
      const old = turns.shift()!;
      old.status = "pruned";
      old.valid_end = stamp;
      old.attrs.prune_reason = "max_turns";
      pruned += 1;
    }

    const facts = this.activeNodes()
      .filter((n) => n.kind === "Fact" && !n.attrs.durable)
      .sort((a, b) => a.valid_start.localeCompare(b.valid_start));
    while (facts.length > maxNon) {
      const old = facts.shift()!;
      old.status = "pruned";
      old.valid_end = stamp;
      old.attrs.prune_reason = "max_facts";
      pruned += 1;
    }

    const durable = this.activeNodes()
      .filter((n) => n.kind === "Fact" && Boolean(n.attrs.durable))
      .sort(
        (a, b) =>
          Number(a.attrs.salience ?? 0) - Number(b.attrs.salience ?? 0) ||
          a.valid_start.localeCompare(b.valid_start),
      );
    while (durable.length > durableCap) {
      let idx = durable.findIndex(
        (n) =>
          String(n.attrs.kind_hint || "") !== "identifier" &&
          !referencedByOpenItem(this, n),
      );
      if (idx < 0) {
        idx = durable.findIndex((n) => String(n.attrs.kind_hint || "") !== "identifier");
        if (idx < 0) idx = 0;
      }
      const old = durable.splice(idx, 1)[0]!;
      old.status = "pruned";
      old.valid_end = stamp;
      old.attrs.prune_reason = "max_durable_facts";
      pruned += 1;
    }
    return pruned;
  }

  private activeOpenItem(label: string): GraphNode | null {
    const key = label.toLowerCase().trim();
    for (let i = this.nodes.length - 1; i >= 0; i--) {
      const node = this.nodes[i]!;
      if (
        node.kind === "OpenItem" &&
        node.status === "active" &&
        node.label.toLowerCase() === key &&
        (node.attrs.state ?? "open") !== "done"
      )
        return node;
    }
    return null;
  }

  private activeOpenItemFuzzy(label: string): GraphNode | null {
    const key = label.toLowerCase().trim();
    for (let i = this.nodes.length - 1; i >= 0; i--) {
      const node = this.nodes[i]!;
      if (node.kind !== "OpenItem" || node.status !== "active") continue;
      if ((node.attrs.state ?? "open") === "done") continue;
      const lab = node.label.toLowerCase();
      if (key === lab || lab.includes(key) || key.includes(lab)) return node;
    }
    return null;
  }

  private activeFactLabel(label: string): GraphNode | null {
    const key = label.toLowerCase().trim();
    for (let i = this.nodes.length - 1; i >= 0; i--) {
      const node = this.nodes[i]!;
      if (node.kind === "Fact" && node.status === "active" && node.label.toLowerCase() === key)
        return node;
    }
    return null;
  }

  private activeFactSummary(summary: string): GraphNode | null {
    const key = summary.toLowerCase().trim();
    for (let i = this.nodes.length - 1; i >= 0; i--) {
      const node = this.nodes[i]!;
      if (node.kind === "Fact" && node.status === "active" && node.summary.toLowerCase() === key)
        return node;
    }
    return null;
  }

  private activeTopic(label: string): GraphNode | null {
    const key = label.toLowerCase().trim();
    for (let i = this.nodes.length - 1; i >= 0; i--) {
      const node = this.nodes[i]!;
      if (node.kind === "Topic" && node.status === "active" && node.label.toLowerCase() === key)
        return node;
    }
    return null;
  }

  ingestTurn(role: string, text: string, index: number, at?: string | null): GraphNode {
    const stamp = at || nowIso();
    let summary = text.trim().replace(/\n/g, " ");
    if (summary.length > 240) summary = summary.slice(0, 237) + "...";
    const turn: GraphNode = {
      id: newId("turn"),
      kind: "Turn",
      label: `${role}:${index}`,
      summary,
      status: "active",
      valid_start: stamp,
      valid_end: null,
      attrs: { role, index },
    };
    this.insert(turn);
    if (this.lastTurnId) this.addEdge(turn.id, this.lastTurnId, "continues", stamp);
    this.lastTurnId = turn.id;

    const newFacts: GraphNode[] = [];
    for (const [sentence, salience, kindHint] of factSentences(text, this.lastUserText)) {
      const fact: GraphNode = {
        id: newId("fact"),
        kind: "Fact",
        label: sentence.slice(0, 80),
        summary: sentence,
        status: "active",
        valid_start: stamp,
        valid_end: null,
        attrs: { from_turn: turn.id, salience, kind_hint: kindHint },
      };
      this.insert(fact);
      this.addEdge(turn.id, fact.id, "contains", stamp);
      newFacts.push(fact);
    }

    for (const [path, salience] of pathFacts(text, this.pathMentions)) {
      const existing = this.activeFactLabel(path);
      if (existing) {
        existing.attrs.salience = Math.max(Number(existing.attrs.salience ?? 0), salience);
        continue;
      }
      const fact: GraphNode = {
        id: newId("fact"),
        kind: "Fact",
        label: path,
        summary: `path: ${path}`,
        status: "active",
        valid_start: stamp,
        valid_end: null,
        attrs: {
          from_turn: turn.id,
          durable: true,
          kind_hint: "path",
          salience,
        },
      };
      this.insert(fact);
      this.addEdge(turn.id, fact.id, "contains", stamp);
      newFacts.push(fact);
    }

    for (const [ident, salience] of identifierFacts(text)) {
      const existing = this.activeFactLabel(ident);
      if (existing) {
        existing.attrs.salience = Math.max(Number(existing.attrs.salience ?? 0), salience);
        existing.attrs.kind_hint = "identifier";
        existing.attrs.durable = true;
        continue;
      }
      const fact: GraphNode = {
        id: newId("fact"),
        kind: "Fact",
        label: ident.slice(0, 120),
        summary: `identifier: ${ident}`,
        status: "active",
        valid_start: stamp,
        valid_end: null,
        attrs: {
          from_turn: turn.id,
          durable: true,
          kind_hint: "identifier",
          salience,
        },
      };
      this.insert(fact);
      this.addEdge(turn.id, fact.id, "contains", stamp);
      newFacts.push(fact);
    }

    for (const cmd of slashCommandEvents(text)) {
      const event: GraphNode = {
        id: newId("event"),
        kind: "Event",
        label: cmd,
        summary: `slash: ${cmd}`,
        status: "active",
        valid_start: stamp,
        valid_end: null,
        attrs: { from_turn: turn.id, kind_hint: "slash" },
      };
      this.insert(event);
      this.addEdge(turn.id, event.id, "contains", stamp);
    }

    for (const [heading, level] of headingFacts(text)) {
      const salience = level <= 1 ? 0.7 : level === 2 ? 0.55 : 0.4;
      const existing = this.activeFactLabel(heading);
      if (existing) {
        existing.attrs.salience = Math.max(Number(existing.attrs.salience ?? 0), salience);
        continue;
      }
      const fact: GraphNode = {
        id: newId("fact"),
        kind: "Fact",
        label: heading.slice(0, 80),
        summary: `heading: ${heading}`,
        status: "active",
        valid_start: stamp,
        valid_end: null,
        attrs: {
          from_turn: turn.id,
          durable: true,
          kind_hint: "heading",
          salience,
        },
      };
      this.insert(fact);
      this.addEdge(turn.id, fact.id, "contains", stamp);
      newFacts.push(fact);
    }

    for (const [sum, hint] of designFacts(text)) {
      if (this.activeFactSummary(sum)) continue;
      const salience = hint === "decision" ? 2.5 : 2.0;
      const fact: GraphNode = {
        id: newId("fact"),
        kind: "Fact",
        label: labelOf(sum),
        summary: sum,
        status: "active",
        valid_start: stamp,
        valid_end: null,
        attrs: {
          from_turn: turn.id,
          durable: true,
          kind_hint: hint,
          salience,
        },
      };
      this.insert(fact);
      this.addEdge(turn.id, fact.id, "contains", stamp);
      newFacts.push(fact);
    }

    for (const outcome of outcomeItems(text)) {
      if (this.activeFactSummary(outcome)) continue;
      const event: GraphNode = {
        id: newId("event"),
        kind: "Event",
        label: labelOf(outcome),
        summary: outcome,
        status: "active",
        valid_start: stamp,
        valid_end: null,
        attrs: { from_turn: turn.id, kind_hint: "outcome" },
      };
      this.insert(event);
      this.addEdge(turn.id, event.id, "contains", stamp);
      const fact: GraphNode = {
        id: newId("fact"),
        kind: "Fact",
        label: labelOf(outcome),
        summary: outcome,
        status: "active",
        valid_start: stamp,
        valid_end: null,
        attrs: {
          from_turn: turn.id,
          durable: true,
          kind_hint: "outcome",
          salience: 1.8,
        },
      };
      this.insert(fact);
      this.addEdge(turn.id, fact.id, "contains", stamp);
      newFacts.push(fact);
    }

    this.ingestTopics(text, turn.id, stamp, newFacts);

    const doneList = [
      ...doneItems(text),
      ...doneLines(text),
      ...doneItemsVerb(text),
      ...checkboxItems(text).filter(([, s]) => s === "done").map(([l]) => l),
    ];
    const seenDone = new Set<string>();
    const uniqDone: string[] = [];
    for (const item of doneList) {
      const key = item.toLowerCase();
      if (seenDone.has(key)) continue;
      seenDone.add(key);
      uniqDone.push(item);
    }
    for (const item of uniqDone) {
      let existing = this.activeOpenItem(item) ?? this.activeOpenItemFuzzy(item);
      if (!existing) continue;
      const replacement: GraphNode = {
        id: newId("item"),
        kind: "OpenItem",
        label: existing.label,
        summary: `completed: ${existing.label}`,
        status: "active",
        valid_start: stamp,
        valid_end: null,
        attrs: { state: "done" },
      };
      this.supersede(existing, replacement, { at: stamp, reason: "completed" });
      this.addEdge(turn.id, replacement.id, "mentions", stamp);
    }

    const doneKeys = new Set(uniqDone.map((d) => d.toLowerCase()));
    const slashCmds = new Set(slashCommandEvents(text).map((c) => c.toLowerCase()));
    for (const [item, state] of openItemsFromText(text)) {
      if (doneKeys.has(item.toLowerCase())) continue;
      if (slashCmds.has(item.toLowerCase().trim()) || item.trim().startsWith("/")) continue;
      if (this.activeOpenItem(item)) continue;
      const opened: GraphNode = {
        id: newId("item"),
        kind: "OpenItem",
        label: item.slice(0, 80),
        summary: `${state}: ${item}`,
        status: "active",
        valid_start: stamp,
        valid_end: null,
        attrs: { state },
      };
      this.insert(opened);
      this.addEdge(turn.id, opened.id, "mentions", stamp);
    }

    if (role === "user") this.lastUserText = text;
    this.prune({ at: stamp });
    return turn;
  }

  private ingestTopics(
    text: string,
    turnId: string,
    stamp: string,
    newFacts: GraphNode[],
  ): void {
    const labels: string[] = [];
    for (const match of text.matchAll(new RegExp(TOPIC_LINE_RE.source, "gim"))) {
      const cleaned = stripItem(match[1]!);
      if (cleaned) labels.push(cleaned);
    }
    for (const [, heading] of h1H2Headings(text)) {
      if (heading.trim()) labels.push(heading.trim());
    }
    const nounCounts: Record<string, number> = {};
    for (const match of text.matchAll(new RegExp(PROPER_NOUN_RE.source, "g"))) {
      const noun = match[1]!.trim();
      if (noun.length < 3) continue;
      nounCounts[noun] = (nounCounts[noun] || 0) + 1;
    }
    for (const [noun, count] of Object.entries(nounCounts)) {
      if (count >= 2 || this.activeTopic(noun)) labels.push(noun);
    }
    const seen = new Set<string>();
    const unique: string[] = [];
    for (const label of labels) {
      const key = label.toLowerCase();
      if (seen.has(key) || label.length < 2) continue;
      seen.add(key);
      unique.push(label);
    }
    for (const label of unique.slice(0, 8)) {
      const topic = this.upsertTopic(label, stamp, turnId);
      const blob = label.toLowerCase();
      for (const fact of newFacts) {
        const hay = `${fact.label} ${fact.summary}`.toLowerCase();
        if (hay.includes(blob) || blob.split(/\s+/).some((tok) => tok.length > 4 && hay.includes(tok))) {
          this.addEdge(topic.id, fact.id, "contains", stamp);
        }
      }
    }
  }

  private upsertTopic(label: string, stamp: string, turnId: string): GraphNode {
    const existing = this.activeTopic(label);
    if (existing) return existing;
    for (const old of [...this.activeNodes()]) {
      if (old.kind !== "Topic") continue;
      if (topicSubsumes(label, old.label)) {
        const replacement: GraphNode = {
          id: newId("topic"),
          kind: "Topic",
          label: (label.length >= old.label.length ? label : old.label).slice(0, 80),
          summary: label.length >= old.label.length ? label : old.label,
          status: "active",
          valid_start: stamp,
          valid_end: null,
          attrs: { salience: 0.8 },
        };
        this.supersede(old, replacement, { at: stamp, reason: "subsumed" });
        this.addEdge(turnId, replacement.id, "mentions", stamp);
        return replacement;
      }
    }
    const topic: GraphNode = {
      id: newId("topic"),
      kind: "Topic",
      label: label.slice(0, 80),
      summary: label,
      status: "active",
      valid_start: stamp,
      valid_end: null,
      attrs: { salience: 0.8 },
    };
    this.insert(topic);
    this.addEdge(turnId, topic.id, "mentions", stamp);
    return topic;
  }

  windowText(maxTurns = 8): string {
    const turns = this.activeNodes()
      .filter((n) => n.kind === "Turn")
      .sort(
        (a, b) =>
          a.valid_start.localeCompare(b.valid_start) ||
          Number(a.attrs.index ?? 0) - Number(b.attrs.index ?? 0),
      )
      .slice(-maxTurns);
    const parts = turns.filter((n) => n.summary).map((n) => n.summary);
    for (const n of this.activeNodes()) {
      if (n.kind === "OpenItem" && (n.attrs.state ?? "open") !== "done") parts.push(n.label);
      if (n.kind === "Fact" && n.attrs.durable) parts.push(n.label);
    }
    return parts.join("\n");
  }

  typedProjection(
    query: string | null = null,
    opts: { hot_set?: string; top_k?: number } = {},
  ): string[] {
    const hot = opts.hot_set ?? this.hotSet(query);
    const topK = opts.top_k ?? 12;
    const lines: string[] = [];
    const events: GraphNode[] = [];
    for (const node of this.activeNodes()) {
      if (node.kind === "OpenItem" && (node.attrs.state ?? "open") !== "done") {
        lines.push(`OpenItem: ${(node.summary || node.label).trim()}`);
      } else if (node.kind === "Fact") {
        const label = (node.label || "").trim();
        const summary = (node.summary || label).trim();
        if (isIdentifierFact(node)) lines.push(`Fact: ${label}`);
        else {
          const pathish =
            node.attrs.kind_hint === "path" ||
            Boolean(label.match(new RegExp(PATH_FACT_RE.source, "i")));
          lines.push(pathish ? `Path: ${label}` : `Fact: ${summary}`);
        }
      } else if (node.kind === "Event") events.push(node);
    }
    if (events.length) {
      events.sort((a, b) => a.valid_start.localeCompare(b.valid_start));
      const last = events[events.length - 1]!;
      lines.push(`Event: ${(last.summary || last.label).trim()}`);
    }
    const deduped: string[] = [];
    const seen = new Set<string>();
    const hotL = hot.toLowerCase();
    for (const line of lines) {
      const key = line.toLowerCase();
      if (seen.has(key)) continue;
      const rest = line.includes(":") ? line.split(":", 2)[1]!.trim().toLowerCase() : key;
      if (hotL.includes(key) || (rest && hotL.includes(rest))) {
        if (deduped.some((s) => s.toLowerCase() === key)) continue;
      }
      seen.add(key);
      deduped.push(line);
    }
    if (query && query.trim() && deduped.length) {
      return rankChunks(query, deduped).map((r) => r.text).slice(0, topK);
    }
    return deduped.slice(0, topK);
  }

  hotSet(query: string | null = null, maxChars?: number): string {
    const cap = maxChars ?? hotSetMaxChars();
    const queryKw = keywordSet(query || "");
    const rank = (node: GraphNode): [number, string] => {
      const body = `${node.label} ${node.summary}`;
      const sal = Number(node.attrs.salience ?? 0);
      const overlap = queryKw.size ? jaccard(keywordSet(body), queryKw) : 0;
      return [sal + 0.5 * overlap, node.valid_start];
    };
    const openItems = this.activeNodes().filter(
      (n) => n.kind === "OpenItem" && (n.attrs.state ?? "open") !== "done",
    );
    const decisions = this.activeNodes().filter((n) => n.kind === "Fact" && isDecisionFact(n));
    const pathHeading = this.activeNodes().filter(
      (n) => n.kind === "Fact" && isPathOrHeading(n),
    );
    const identifiers = this.activeNodes().filter(
      (n) => n.kind === "Fact" && isIdentifierFact(n),
    );
    const otherFacts = this.activeNodes().filter(
      (n) =>
        n.kind === "Fact" &&
        !isDecisionFact(n) &&
        !isPathOrHeading(n) &&
        !isIdentifierFact(n),
    );
    const byRank = (a: GraphNode, b: GraphNode) => {
      const [sa, ta] = rank(a);
      const [sb, tb] = rank(b);
      return sb - sa || tb.localeCompare(ta);
    };
    openItems.sort(byRank);
    decisions.sort(byRank);
    pathHeading.sort(byRank);
    identifiers.sort(byRank);
    otherFacts.sort(byRank);

    const nSlots = Math.max(5, Math.floor(cap / 64));
    const caps: Record<string, number> = {
      open: Math.max(1, Math.floor(nSlots * HOT_SET_OPEN_SHARE)),
      decision: Math.max(1, Math.floor(nSlots * HOT_SET_DECISION_SHARE)),
      path: Math.max(1, Math.floor(nSlots * HOT_SET_PATH_HEADING_SHARE)),
      other: nSlots,
    };
    const buckets: Array<[string, GraphNode[]]> = [
      ["decision", decisions],
      ["open", openItems],
      ["path", [...pathHeading, ...identifiers]],
      ["other", otherFacts],
    ];
    const parts: string[] = [];
    let used = 0;
    const seen = new Set<string>();
    const taken: Record<string, number> = { open: 0, decision: 0, path: 0, other: 0 };

    const emit = (node: GraphNode, bucket: string): boolean => {
      if (taken[bucket]! >= caps[bucket]!) return false;
      const key = `${node.kind}:${node.label.toLowerCase()}`;
      if (seen.has(key)) return false;
      let summary = (node.summary || node.label).trim();
      if (summary.length > 64) summary = summary.slice(0, 61) + "...";
      const line = isIdentifierFact(node)
        ? `Fact: ${node.label}`
        : `${node.kind} ${node.label}: ${summary}`;
      if (used + line.length + 1 > cap) return false;
      seen.add(key);
      parts.push(line);
      used += line.length + 1;
      taken[bucket]! += 1;
      return true;
    };

    for (const [bucket, nodes] of buckets) {
      for (const node of nodes) {
        if (used >= cap) break;
        emit(node, bucket);
      }
    }

    for (const node of identifiers) {
      if (used >= cap) break;
      const key = `${node.kind}:${node.label.toLowerCase()}`;
      if (seen.has(key)) continue;
      const line = `Fact: ${node.label}`;
      if (used + line.length + 1 > cap) {
        let dropI: number | null = null;
        for (let i = 0; i < parts.length; i++) {
          const p = parts[i]!;
          const pl = p.toLowerCase();
          if (pl.startsWith("fact:") && identifiers.some((idn) => pl.includes(idn.label.toLowerCase())))
            continue;
          if (p.startsWith("Fact ") || p.startsWith("Path ") || p.startsWith("Fact:")) {
            if (identifiers.some((idn) => pl.includes(idn.label.toLowerCase()))) continue;
            dropI = i;
            break;
          }
        }
        if (dropI === null) break;
        const removed = parts.splice(dropI, 1)[0]!;
        used -= removed.length + 1;
      }
      if (used + line.length + 1 > cap) break;
      seen.add(key);
      parts.push(line);
      used += line.length + 1;
    }
    return parts.join("\n");
  }

  openitemSignature(): string {
    const rows: string[] = [];
    for (const node of this.activeNodes()) {
      if (node.kind !== "OpenItem") continue;
      const state = String(node.attrs.state ?? "open");
      rows.push(`${node.id}|${state}|${node.summary}|${node.label}`);
    }
    rows.sort();
    const blob = rows.join("\n");
    if (!blob) return "empty";
    return createHash("sha1").update(blob, "utf8").digest("hex").slice(0, 16);
  }

  supersedeCount(): number {
    return this.nodes.filter((n) => n.status === "superseded").length;
  }

  toDict(): Record<string, unknown> {
    return {
      schema: SCHEMA_ID,
      nodes: this.nodes.map(nodeToDict),
      edges: this.edges.map(edgeToDict),
    };
  }

  dumps(): string {
    return JSON.stringify(sortKeysDeep(this.toDict()));
  }

  dumpsCompact(): string {
    return this.dumps();
  }

  save(path: string): string {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, this.dumpsCompact() + "\n", "utf8");
    return path;
  }

  static fromDict(data: Record<string, unknown>): CtxGraph {
    const graph = new CtxGraph();
    for (const raw of (data.nodes as Record<string, unknown>[]) || []) {
      const node = nodeFromDict(raw);
      graph.nodes.push(node);
      graph.byId.set(node.id, node);
      if (node.kind === "Turn" && node.status === "active") {
        graph.lastTurnId = node.id;
        if ((node.attrs || {}).role === "user") graph.lastUserText = node.summary;
      }
    }
    for (const raw of (data.edges as Record<string, unknown>[]) || []) {
      graph.edges.push(edgeFromDict(raw));
    }
    return graph;
  }

  static load(path: string): CtxGraph {
    return CtxGraph.fromDict(JSON.parse(readFileSync(path, "utf8")));
  }

  static tryLoad(path: string): CtxGraph {
    if (!existsSync(path)) return new CtxGraph();
    try {
      return CtxGraph.load(path);
    } catch {
      return new CtxGraph();
    }
  }
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) out[k] = sortKeysDeep(obj[k]);
    return out;
  }
  return value;
}
