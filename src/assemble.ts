/**
 * Assemble: ingest-missing + sample pack + paired-window tail cut + memory addition.
 */

import type { CompressorConfig } from "./config.ts";
import { ingestBatch, type IngestContext } from "./ingest.ts";
import {
  estimateMessageTokens,
  isToolCall,
  isToolResult,
  messageText,
  resultToolCallId,
  toolCallIds,
  type ChatMessage,
} from "./messages.ts";
import { logInfo, logWarn } from "./log.ts";
import type { Tracker } from "./telemetry/tracker.ts";
import type { PackerImpl } from "./telemetry/types.ts";
import {
  buildAssembleMetrics,
  estimateFamilyTokensFromPackText,
} from "./telemetry/map.ts";
import {
  rememberPack,
  tryPackCacheSkip,
} from "./pack-cache.ts";

export type PackSample = {
  text: string;
  packed_tokens: number;
  method?: string;
  k?: number;
  k_max?: number;
  t?: number;
  duration_ms?: number;
  rpc_latency_ms?: number;
  hot_set_tokens?: number | null;
  typed_lines_tokens?: number | null;
  ranked_span_tokens?: number | null;
  matrix_rows_k?: number | null;
  matrix_max_slots?: number | null;
  graph_active_nodes?: number | null;
  graph_pruned_nodes?: number | null;
};

export type PackerSample = {
  sample: (
    agentId: string,
    params: { query: string; budget?: number; span_k?: number },
  ) => Promise<PackSample>;
};

export type AssembleArgs = {
  messages?: ChatMessage[];
  tokenBudget?: number;
  prompt?: string;
  sessionKey?: string;
  agentId?: string;
  availableTools?: unknown;
  citationsMode?: unknown;
  runtimeSettings?: {
    limits?: { tokens?: number; [key: string]: unknown };
    estimateTokens?: (messages: ChatMessage[]) => number;
    [key: string]: unknown;
  };
  buildMemorySystemPromptAddition?: (args: AssembleArgs) => Promise<string> | string;
};

export type AssembleResult = {
  messages: ChatMessage[];
  estimatedTokens: number;
  systemPromptAddition: string;
  promptAuthority: "assembled";
  meta?: {
    tail_over_budget?: boolean;
    cut_unit?: "host" | "tau";
    packed_tokens?: number;
    method?: string;
  };
};

export type CutTailResult = {
  messages: ChatMessage[];
  used: number;
  overBudget: boolean;
  cutUnit: "host" | "tau";
};

function groupStartIndex(messages: ChatMessage[], i: number): number {
  const msg = messages[i]!;
  if (!isToolResult(msg)) return i;
  const want = resultToolCallId(msg);
  let j = i - 1;
  while (j >= 0) {
    const prev = messages[j]!;
    if (isToolCall(prev)) {
      const ids = toolCallIds(prev);
      if (!want || ids.length === 0 || ids.includes(want)) {
        return j;
      }
    }
    if (isToolResult(prev)) {
      j -= 1;
      continue;
    }
    // Adjacent preceding assistant tool-call without id match: still keep pair by adjacency.
    if (want && j === i - 1 && isToolCall(prev)) return j;
    break;
  }
  // Adjacency fallback: keep result with immediate predecessor if it looks like a call.
  if (i > 0 && isToolCall(messages[i - 1]!)) return i - 1;
  return i;
}

export function cutTail(
  messages: ChatMessage[],
  budget: number,
  opts?: {
    estimateTokens?: (messages: ChatMessage[]) => number;
    useHost?: boolean;
  },
): CutTailResult {
  const useHost = Boolean(opts?.useHost && opts.estimateTokens);
  const cutUnit: "host" | "tau" = useHost ? "host" : "tau";
  const estimateGroup = (group: ChatMessage[]): number => {
    if (useHost && opts?.estimateTokens) return opts.estimateTokens(group);
    return group.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
  };

  if (!messages.length) {
    return { messages: [], used: 0, overBudget: false, cutUnit };
  }

  const acc: ChatMessage[] = [];
  let used = 0;
  let overBudget = false;
  let i = messages.length - 1;

  while (i >= 0) {
    const start = groupStartIndex(messages, i);
    const group = messages.slice(start, i + 1);
    const cost = estimateGroup(group);
    if (acc.length > 0 && used + cost > budget) {
      break;
    }
    acc.unshift(...group);
    used += cost;
    if (acc.length === group.length && cost > budget) {
      overBudget = true;
    }
    i = start - 1;
  }

  return { messages: acc, used, overBudget, cutUnit };
}

export function stateLine(
  pack: PackSample,
  sessionId: string,
): string {
  const t = pack.t ?? "?";
  const k = pack.k ?? "?";
  const kmax = pack.k_max ?? "?";
  const method = pack.method ?? "query-pack";
  return `STATE: t=${t} k=${k}/${kmax} tau_pack=${pack.packed_tokens} method=${method} session=${sessionId}`;
}

async function safeMemoryAddition(args: AssembleArgs): Promise<string> {
  if (!args.buildMemorySystemPromptAddition) return "";
  try {
    const out = await args.buildMemorySystemPromptAddition(args);
    return typeof out === "string" ? out : "";
  } catch (err) {
    logWarn("memory addition failed; continuing without", {
      error: err instanceof Error ? err.message : String(err),
    });
    return "";
  }
}

function lastUserText(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (String(m.role).toLowerCase() === "user") return messageText(m);
  }
  return "";
}

export type AssembleContext = IngestContext & {
  packer: IngestContext["packer"] & PackerSample;
  config: CompressorConfig;
  /** Optional async telemetry — failures must not affect assemble. */
  tracker?: Tracker;
  /** sidecar | ts — recorded on turn_metrics.impl */
  packerImpl?: PackerImpl;
  /** Monotonic turn index for telemetry (defaults 0). */
  turnIndex?: number;
};

export async function assemble(
  ctx: AssembleContext,
  args: AssembleArgs,
): Promise<AssembleResult> {
  const t0 = Date.now();
  const messages = args.messages ?? [];
  try {
    await ingestBatch(ctx, messages);

    const query = (args.prompt && args.prompt.length > 0 ? args.prompt : lastUserText(messages)) || "";
    const hostBudget =
      typeof args.tokenBudget === "number" && args.tokenBudget > 0
        ? args.tokenBudget
        : undefined;
    const packBudget = Math.min(
      ctx.config.forwardBudget,
      hostBudget ?? ctx.config.forwardBudget,
    );

    // Pack cache: signature invalidated on ingest; Jaccard on query for skip.
    const openitemSig = `sess:${ctx.sessionId}`;
    const cached = tryPackCacheSkip(ctx.sessionId, openitemSig, query);
    let pack: PackSample;
    if (cached) {
      pack = cached as PackSample;
      logInfo("assemble pack_cache_skip", { session: ctx.sessionId, method: "skip" });
    } else {
      pack = await ctx.packer.sample(ctx.agentId, {
        query,
        budget: packBudget,
        span_k: ctx.config.matrixSpanK,
      });
      rememberPack(ctx.sessionId, openitemSig, query, pack);
    }

    const keepBudget = ctx.config.keepRecentTokens;
    const cut = cutTail(messages, keepBudget, {
      useHost: Boolean(args.runtimeSettings?.limits),
      estimateTokens: args.runtimeSettings?.estimateTokens,
    });
    if (cut.overBudget) {
      logInfo("tail_over_budget", { session: ctx.sessionId, used: cut.used, budget: keepBudget });
    }

    const memory = await safeMemoryAddition(args);
    const addition = [pack.text || "", stateLine(pack, ctx.sessionId), memory]
      .filter((s) => s && s.length > 0)
      .join("\n");

    const estimatedTokens =
      (args.runtimeSettings?.estimateTokens
        ? args.runtimeSettings.estimateTokens(cut.messages)
        : cut.used) + (pack.packed_tokens || 0);

    const ms = Date.now() - t0;
    logInfo("assemble", {
      session: ctx.sessionId,
      packed_tokens: pack.packed_tokens,
      method: pack.method,
      tail_n: cut.messages.length,
      over_budget: cut.overBudget,
      cut_unit: cut.cutUnit,
      ms,
    });

    // Telemetry: counts only; never await insert on the assemble path.
    if (ctx.tracker) {
      try {
        const family =
          pack.hot_set_tokens != null || pack.typed_lines_tokens != null
            ? {
                hot_set_tokens: pack.hot_set_tokens,
                typed_lines_tokens: pack.typed_lines_tokens,
              }
            : estimateFamilyTokensFromPackText(pack.text || "");
        const metrics = buildAssembleMetrics({
          sessionId: ctx.sessionId,
          turnIndex: ctx.turnIndex ?? 0,
          preCutMessages: messages,
          tailMessages: cut.messages,
          pack: {
            packed_tokens: pack.packed_tokens,
            method: pack.method,
            k: pack.k,
            k_max: pack.k_max,
            t: pack.t,
            duration_ms: pack.duration_ms,
            rpc_latency_ms: pack.rpc_latency_ms ?? pack.duration_ms,
            hot_set_tokens: family.hot_set_tokens,
            typed_lines_tokens: family.typed_lines_tokens,
            ranked_span_tokens: pack.ranked_span_tokens,
            matrix_rows_k: pack.matrix_rows_k ?? pack.k,
            matrix_max_slots: pack.matrix_max_slots ?? pack.k_max,
            graph_active_nodes: pack.graph_active_nodes,
            graph_pruned_nodes: pack.graph_pruned_nodes,
          },
          budgetMax: packBudget,
          budgetUsed: pack.packed_tokens || 0,
          totalAssembleMs: ms,
          impl: ctx.packerImpl ?? "sidecar",
        });
        ctx.tracker.trackTurn(metrics);
      } catch (err) {
        logWarn("telemetry enqueue swallowed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return {
      messages: cut.messages,
      estimatedTokens,
      systemPromptAddition: addition,
      promptAuthority: "assembled",
      meta: {
        tail_over_budget: cut.overBudget,
        cut_unit: cut.cutUnit,
        packed_tokens: pack.packed_tokens,
        method: pack.method,
      },
    };
  } catch (err) {
    try {
      ctx.tracker?.trackEvent("sidecar_dead", ctx.sessionId);
    } catch {
      /* swallow */
    }
    throw err;
  }
}
