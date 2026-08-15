-- Telemetry schema v1 (counts only; no prompt/text/content columns).
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS turn_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  turn_index INTEGER NOT NULL,
  timestamp INTEGER NOT NULL,
  tau_replay INTEGER,
  tau_packed INTEGER,
  budget_max INTEGER,
  budget_used INTEGER,
  hot_set_tokens INTEGER,
  typed_lines_tokens INTEGER,
  ranked_span_tokens INTEGER,
  recent_tail_tokens INTEGER,
  matrix_rows_k INTEGER,
  matrix_max_slots INTEGER,
  graph_active_nodes INTEGER,
  graph_pruned_nodes INTEGER,
  rpc_latency_ms INTEGER,
  total_assemble_ms INTEGER,
  pack_method TEXT,
  impl TEXT,
  compacted INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_turn_metrics_session_turn
  ON turn_metrics(session_id, turn_index);

CREATE INDEX IF NOT EXISTS idx_turn_metrics_session_ts
  ON turn_metrics(session_id, timestamp);

CREATE TABLE IF NOT EXISTS system_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER NOT NULL,
  session_id TEXT,
  code TEXT NOT NULL
);
