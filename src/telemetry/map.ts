/**
 * Map packer count fields → TurnMetrics. Never copies pack text into metrics.
 */

import { estimateMessageTokens, tauTokens, type ChatMessage } from "../messages.ts";
import type { PackCountFields, PackerImpl, TurnMetrics } from "./types.ts";

export function mapPackCounts(pack: PackCountFields & { text?: string }): Omit<
  PackCountFields,
  never
> {
  // Deliberately ignore pack.text — do not return it.
  return {
    packed_tokens: pack.packed_tokens,
    method: pack.method,
    k: pack.k,
    k_max: pack.k_max,
    t: pack.t,
    duration_ms: pack.duration_ms,
    rpc_latency_ms: pack.rpc_latency_ms ?? pack.duration_ms,
    hot_set_tokens: pack.hot_set_tokens ?? null,
    typed_lines_tokens: pack.typed_lines_tokens ?? null,
    ranked_span_tokens: pack.ranked_span_tokens ?? null,
    matrix_rows_k: pack.matrix_rows_k ?? pack.k ?? null,
    matrix_max_slots: pack.matrix_max_slots ?? pack.k_max ?? null,
    graph_active_nodes: pack.graph_active_nodes ?? null,
    graph_pruned_nodes: pack.graph_pruned_nodes ?? null,
  };
}

/** τ of pre-cut messages (user/assistant/tool), not host system prompt. */
export function tauReplayMessages(messages: ChatMessage[]): number {
  return messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
}

export function tauRecentTail(messages: ChatMessage[]): number {
  return messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
}

export function buildAssembleMetrics(args: {
  sessionId: string;
  turnIndex: number;
  preCutMessages: ChatMessage[];
  tailMessages: ChatMessage[];
  pack: PackCountFields;
  budgetMax: number;
  budgetUsed: number;
  totalAssembleMs: number;
  impl: PackerImpl;
}): TurnMetrics {
  const counts = mapPackCounts(args.pack);
  return {
    sessionId: args.sessionId,
    turnIndex: args.turnIndex,
    timestamp: Date.now(),
    tauReplay: tauReplayMessages(args.preCutMessages),
    tauPacked: counts.packed_tokens,
    budgetMax: args.budgetMax,
    budgetUsed: args.budgetUsed,
    hotSetTokens: counts.hot_set_tokens,
    typedLinesTokens: counts.typed_lines_tokens,
    rankedSpanTokens: counts.ranked_span_tokens,
    recentTailTokens: tauRecentTail(args.tailMessages),
    matrixRowsK: counts.matrix_rows_k,
    matrixMaxSlots: counts.matrix_max_slots,
    graphActiveNodes: counts.graph_active_nodes,
    graphPrunedNodes: counts.graph_pruned_nodes,
    rpcLatencyMs: counts.rpc_latency_ms ?? null,
    totalAssembleMs: args.totalAssembleMs,
    packMethod: counts.method ?? null,
    impl: args.impl,
    compacted: false,
  };
}

export function buildCompactMetrics(args: {
  sessionId: string;
  turnIndex: number;
  /** τ of checkpoint text computed before discarding the string. */
  checkpointTau: number;
  totalMs: number;
  pack: PackCountFields;
  impl: PackerImpl;
}): TurnMetrics {
  const counts = mapPackCounts(args.pack);
  return {
    sessionId: args.sessionId,
    turnIndex: args.turnIndex,
    timestamp: Date.now(),
    tauReplay: null,
    tauPacked: args.checkpointTau,
    budgetMax: null,
    budgetUsed: null,
    hotSetTokens: counts.hot_set_tokens,
    typedLinesTokens: counts.typed_lines_tokens,
    rankedSpanTokens: counts.ranked_span_tokens,
    recentTailTokens: null,
    matrixRowsK: counts.matrix_rows_k,
    matrixMaxSlots: counts.matrix_max_slots,
    graphActiveNodes: counts.graph_active_nodes,
    graphPrunedNodes: counts.graph_pruned_nodes,
    rpcLatencyMs: counts.rpc_latency_ms ?? null,
    totalAssembleMs: args.totalMs,
    packMethod: counts.method ?? null,
    impl: args.impl,
    compacted: true,
  };
}

/** Optional: estimate family splits from pack text in RAM, then drop text. */
export function estimateFamilyTokensFromPackText(packText: string): {
  hot_set_tokens: number | null;
  typed_lines_tokens: number | null;
} {
  if (!packText) return { hot_set_tokens: null, typed_lines_tokens: null };
  const lines = packText.split(/\r?\n/);
  let hot = 0;
  let typed = 0;
  for (const line of lines) {
    const t = tauTokens(line);
    if (/HOT_SET/i.test(line)) hot += t;
    else if (/OpenItem|Decision|STATE:/i.test(line)) typed += t;
  }
  return {
    hot_set_tokens: hot > 0 ? hot : null,
    typed_lines_tokens: typed > 0 ? typed : null,
  };
}

/** Guard: ensure metrics object values are never long strings that look like prompts. */
export function assertCountsOnly(metrics: TurnMetrics): void {
  for (const [k, v] of Object.entries(metrics)) {
    if (typeof v === "string" && v.length > 64 && !["sessionId", "packMethod", "impl"].includes(k)) {
      throw new Error(`telemetry field ${k} looks like content`);
    }
  }
}
