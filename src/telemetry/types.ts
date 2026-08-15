/**
 * Count-only turn metrics. Must never include prompt/pack/HOT_SET text.
 * Dual-impl packers (sidecar | ts) share the same optional count fields.
 */

export type PackerImpl = "sidecar" | "ts";

/** Shared count fields returned by sidecar claw_cli and future TsPacker. */
export type PackCountFields = {
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

export type SystemEventCode =
  | "graph_flushed"
  | "precompact_frozen"
  | "budget_scaled"
  | "profile_changed"
  | "sidecar_dead"
  | "telemetry_dropped"
  | "middleware_pass_through";

/**
 * In-memory / DB row shape. Intentionally omits text, prompt, content, hot_set, pack.
 */
export type TurnMetrics = {
  sessionId: string;
  turnIndex: number;
  timestamp?: number;
  tauReplay: number | null;
  tauPacked: number | null;
  budgetMax: number | null;
  budgetUsed: number | null;
  hotSetTokens?: number | null;
  typedLinesTokens?: number | null;
  rankedSpanTokens?: number | null;
  recentTailTokens?: number | null;
  matrixRowsK?: number | null;
  matrixMaxSlots?: number | null;
  graphActiveNodes?: number | null;
  graphPrunedNodes?: number | null;
  rpcLatencyMs?: number | null;
  totalAssembleMs?: number | null;
  packMethod?: string | null;
  impl?: PackerImpl | null;
  compacted?: boolean;
};

export type SystemEvent = {
  code: SystemEventCode;
  sessionId?: string | null;
  timestamp?: number;
};
