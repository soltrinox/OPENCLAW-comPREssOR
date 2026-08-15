/**
 * Ingest: heartbeat skip, tool gist, ingest-once, sequential step.
 */

import { createHash } from "node:crypto";
import type { CompressorConfig } from "./config.ts";
import type { MetaStore } from "./meta-store.ts";
import {
  isCompactionNotice,
  isHeartbeat,
  isToolResult,
  messageText,
  type ChatMessage,
} from "./messages.ts";
import { logInfo } from "./log.ts";
import { shouldSkipGroupBystander } from "./middleware/channel-ingest.ts";
import { invalidatePackCache } from "./pack-cache.ts";

// Bounded quantifiers — avoid ReDoS on huge tool dumps.
const PATH_RE =
  /(?:\/[\w.-]{1,64})+\.\w{1,12}\b|(?:[A-Za-z]:\\(?:[\w.-]+\\){0,12}[\w.-]+\.\w{1,12})|\b[\w.-]{1,64}\.(?:ts|js|py|json|md|txt|yml|yaml|sh|go|rs)\b/g;

export type PackerStep = {
  step: (
    agentId: string,
    params: { role: string; text: string; flush_graph?: boolean },
  ) => Promise<Record<string, unknown>>;
};

export type IngestContext = {
  config: CompressorConfig;
  packer: PackerStep;
  meta: MetaStore;
  agentId: string;
  sessionId: string;
};

export function messageIdFor(msg: ChatMessage, index: number): string {
  if (typeof msg.id === "string" && msg.id.length > 0) return msg.id;
  const content = messageText(msg);
  return createHash("sha256")
    .update(`${msg.role}|${content}|${index}`)
    .digest("hex");
}

export function mapRole(msg: ChatMessage): "user" | "assistant" | "event" {
  const role = String(msg.role || "").toLowerCase();
  if (role === "user") return "user";
  if (isToolResult(msg) || role === "tool" || role === "event") return "assistant";
  if (role === "assistant" || role === "model") return "assistant";
  return "assistant";
}

export function toolGist(msg: ChatMessage, maxChars = 512): string {
  const raw = messageText(msg);
  const name = String(msg.toolName ?? msg.name ?? "tool");
  const head = raw.slice(0, maxChars);
  // Scan a bounded window only — avoid ReDoS on huge dumps.
  const scan = raw.slice(0, 8192);
  const exitMatch = scan.match(/\bexit(?:[_ ]?code)?[=:\s]+(-?\d+)/i);
  const exit = exitMatch ? exitMatch[1] : "?";
  const paths = Array.from(new Set(scan.match(PATH_RE) ?? [])).slice(0, 8);
  const errorLine =
    scan
      .split(/\r?\n/)
      .find((line) => /error|fail|traceback|exception/i.test(line))
      ?.trim()
      .slice(0, 200) ?? "";
  return `tool ${name} exit=${exit} paths=${paths.join(",") || "-"} error=${errorLine || "-"} gist=${head}`;
}

export async function ingestOne(
  ctx: IngestContext,
  msg: ChatMessage,
  index: number,
): Promise<{ ingested: boolean; skipped?: string }> {
  if (ctx.config.skipHeartbeats && isHeartbeat(msg)) {
    logInfo("ingest skip heartbeat", { session: ctx.sessionId, index });
    return { ingested: false, skipped: "heartbeat" };
  }
  if (shouldSkipGroupBystander(msg)) {
    logInfo("ingest skip group_bystander", { session: ctx.sessionId, index });
    return { ingested: false, skipped: "group_bystander" };
  }
  if (isCompactionNotice(msg)) {
    return { ingested: false, skipped: "compaction_notice" };
  }

  const id = messageIdFor(msg, index);
  if (ctx.meta.alreadyIngested(ctx.sessionId, id)) {
    return { ingested: false, skipped: "already_ingested" };
  }

  let text = messageText(msg);
  let role = mapRole(msg);
  if (isToolResult(msg) && ctx.config.ingestToolResults) {
    text = toolGist(msg);
    role = "assistant";
  }

  await ctx.packer.step(ctx.agentId, { role, text });
  ctx.meta.markIngested(ctx.sessionId, id);
  // OpenItem signature may change — invalidate pack skip cache.
  invalidatePackCache(ctx.sessionId);
  return { ingested: true };
}

export async function ingest(
  ctx: IngestContext,
  msg: ChatMessage,
  index = 0,
): Promise<{ ingested: boolean; skipped?: string }> {
  return ingestOne(ctx, msg, index);
}

/** Sequential steps only — graph t is ordered. */
export async function ingestBatch(
  ctx: IngestContext,
  messages: ChatMessage[],
): Promise<{ ingested: boolean; count: number }> {
  let count = 0;
  for (let i = 0; i < messages.length; i++) {
    const result = await ingestOne(ctx, messages[i]!, i);
    if (result.ingested) count += 1;
  }
  return { ingested: count > 0, count };
}
