/**
 * telemetry.sqlite — separate WAL file from meta.sqlite.
 * Migrations + prune (30d / 50MB → 40MB). No VACUUM on assemble path.
 */

import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, statSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SystemEvent, TurnMetrics } from "./types.ts";

export const SCHEMA_VERSION = 1;
export const PRUNE_MAX_BYTES = 50 * 1024 * 1024;
export const PRUNE_TARGET_BYTES = 40 * 1024 * 1024;
export const PRUNE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const PRUNE_EVERY_N_WRITES = 100;
export const PRUNE_MIN_INTERVAL_MS = 10 * 60 * 1000;

const FORBIDDEN_COLUMN_RE = /^(prompt|text|content|hot_set|pack)$/i;

export function telemetryDbPath(sessionStateDir: string): string {
  return join(sessionStateDir, "telemetry.sqlite");
}

export class TelemetryStore {
  private readonly db: DatabaseSync;
  readonly dbPath: string;
  private writeCount = 0;
  private lastPruneMs = Date.now();

  constructor(dbPath: string, opts: { readOnly?: boolean } = {}) {
    this.dbPath = dbPath;
    const readOnly = opts.readOnly === true;
    if (dbPath !== ":memory:" && !readOnly) {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = readOnly
      ? new DatabaseSync(dbPath, { readOnly: true })
      : new DatabaseSync(dbPath);
    if (dbPath !== ":memory:" && !readOnly) {
      try {
        this.db.exec("PRAGMA journal_mode = WAL;");
        this.db.exec("PRAGMA busy_timeout = 2000;");
        this.db.exec("PRAGMA wal_autocheckpoint = 1000;");
      } catch {
        /* swallow — caller must not fail assemble */
      }
    }
    if (!readOnly) this.migrate();
  }

  migrate(): void {
    const here = dirname(fileURLToPath(import.meta.url));
    const schemaPath = join(here, "schema.sql");
    // Fallback inline SQL if schema.sql not resolvable (compiled dist).
    let sql: string;
    try {
      sql = readFileSync(schemaPath, "utf8");
    } catch {
      sql = INLINE_SCHEMA;
    }
    this.db.exec(sql);
    const row = this.db
      .prepare("SELECT version FROM schema_migrations WHERE version = ? LIMIT 1")
      .get(SCHEMA_VERSION) as { version?: number } | undefined;
    if (!row?.version) {
      this.db
        .prepare("INSERT OR REPLACE INTO schema_migrations (version, applied_ms) VALUES (?, ?)")
        .run(SCHEMA_VERSION, Date.now());
    }
  }

  /** Column names for privacy assertions (A7-1). */
  columnNames(): string[] {
    const rows = this.db.prepare("PRAGMA table_info(turn_metrics)").all() as Array<{
      name: string;
    }>;
    return rows.map((r) => r.name);
  }

  assertNoContentColumns(): void {
    for (const name of this.columnNames()) {
      if (FORBIDDEN_COLUMN_RE.test(name)) {
        throw new Error(`forbidden telemetry column: ${name}`);
      }
    }
  }

  insertTurn(m: TurnMetrics): void {
    this.db
      .prepare(
        `INSERT INTO turn_metrics (
          session_id, turn_index, timestamp,
          tau_replay, tau_packed, budget_max, budget_used,
          hot_set_tokens, typed_lines_tokens, ranked_span_tokens, recent_tail_tokens,
          matrix_rows_k, matrix_max_slots, graph_active_nodes, graph_pruned_nodes,
          rpc_latency_ms, total_assemble_ms, pack_method, impl, compacted
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        m.sessionId,
        m.turnIndex,
        m.timestamp ?? Date.now(),
        m.tauReplay,
        m.tauPacked,
        m.budgetMax,
        m.budgetUsed,
        m.hotSetTokens ?? null,
        m.typedLinesTokens ?? null,
        m.rankedSpanTokens ?? null,
        m.recentTailTokens ?? null,
        m.matrixRowsK ?? null,
        m.matrixMaxSlots ?? null,
        m.graphActiveNodes ?? null,
        m.graphPrunedNodes ?? null,
        m.rpcLatencyMs ?? null,
        m.totalAssembleMs ?? null,
        m.packMethod ?? null,
        m.impl ?? null,
        m.compacted ? 1 : 0,
      );
    this.writeCount += 1;
    this.maybePrune();
  }

  insertEvent(ev: SystemEvent): void {
    this.db
      .prepare(
        "INSERT INTO system_events (timestamp, session_id, code) VALUES (?, ?, ?)",
      )
      .run(ev.timestamp ?? Date.now(), ev.sessionId ?? null, ev.code);
    this.writeCount += 1;
    this.maybePrune();
  }

  countTurns(sessionId?: string): number {
    if (sessionId) {
      const row = this.db
        .prepare("SELECT COUNT(*) AS n FROM turn_metrics WHERE session_id = ?")
        .get(sessionId) as { n: number };
      return Number(row.n);
    }
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM turn_metrics").get() as {
      n: number;
    };
    return Number(row.n);
  }

  /** Open existing db read-only (stats path). Throws if missing / unreadable. */
  static openReadonly(dbPath: string): TelemetryStore {
    if (dbPath !== ":memory:" && !existsSync(dbPath)) {
      throw new Error(`telemetry db not found: ${dbPath}`);
    }
    return new TelemetryStore(dbPath, { readOnly: true });
  }

  /** Last session_id by max(timestamp), or null if empty. */
  lastActiveSessionId(): string | null {
    const row = this.db
      .prepare(
        "SELECT session_id AS id FROM turn_metrics ORDER BY timestamp DESC LIMIT 1",
      )
      .get() as { id?: string } | undefined;
    return row?.id ?? null;
  }

  /**
   * Sum τ columns only where both tau_replay and tau_packed are non-null.
   * reductionRatio = 1 - packed/replay when sumReplay > 0; else null + reason.
   */
  summarizeEfficiency(sessionId: string): {
    totalTurns: number;
    totalTauReplay: number;
    totalTauPacked: number;
    savedTokens: number;
    reductionRatio: number | null;
    reason?: string;
    avgLatencyMs: number;
    matrixSaturationPct: number | null;
    latestImpl: string | null;
    latestK: number | null;
    latestKMax: number | null;
  } {
    const totalTurns = this.countTurns(sessionId);
    const sumRow = this.db
      .prepare(
        `SELECT
          COALESCE(SUM(tau_replay), 0) AS sum_r,
          COALESCE(SUM(tau_packed), 0) AS sum_p,
          COUNT(*) AS n_pair
         FROM turn_metrics
         WHERE session_id = ?
           AND tau_replay IS NOT NULL
           AND tau_packed IS NOT NULL`,
      )
      .get(sessionId) as { sum_r: number; sum_p: number; n_pair: number };

    const totalTauReplay = Number(sumRow.sum_r);
    const totalTauPacked = Number(sumRow.sum_p);
    const nPair = Number(sumRow.n_pair);
    let reductionRatio: number | null = null;
    let reason: string | undefined;
    if (nPair === 0 || totalTauReplay <= 0) {
      reductionRatio = null;
      reason = "replay_tau_undefined";
    } else {
      const raw = 1 - totalTauPacked / totalTauReplay;
      reductionRatio = Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 0;
    }
    const savedTokens =
      reductionRatio === null ? 0 : Math.max(0, totalTauReplay - totalTauPacked);

    const latRow = this.db
      .prepare(
        `SELECT AVG(total_assemble_ms) AS avg_ms
         FROM turn_metrics
         WHERE session_id = ? AND total_assemble_ms IS NOT NULL`,
      )
      .get(sessionId) as { avg_ms: number | null };
    const avgLatencyMs =
      latRow.avg_ms != null && Number.isFinite(Number(latRow.avg_ms))
        ? Number(latRow.avg_ms)
        : 0;

    const latest = this.db
      .prepare(
        `SELECT matrix_rows_k, matrix_max_slots, impl
         FROM turn_metrics
         WHERE session_id = ?
         ORDER BY turn_index DESC, timestamp DESC
         LIMIT 1`,
      )
      .get(sessionId) as
      | { matrix_rows_k: number | null; matrix_max_slots: number | null; impl: string | null }
      | undefined;

    let matrixSaturationPct: number | null = null;
    const k = latest?.matrix_rows_k ?? null;
    const kMax = latest?.matrix_max_slots ?? null;
    if (k != null && kMax != null && kMax > 0) {
      matrixSaturationPct = Math.min(1, Math.max(0, Number(k) / Number(kMax)));
    }

    return {
      totalTurns,
      totalTauReplay,
      totalTauPacked,
      savedTokens,
      reductionRatio,
      reason,
      avgLatencyMs,
      matrixSaturationPct,
      latestImpl: latest?.impl ?? null,
      latestK: k != null ? Number(k) : null,
      latestKMax: kMax != null ? Number(kMax) : null,
    };
  }

  /** Last N turns for timeseries widgets (cap 500). No text columns. */
  timeseries(sessionId: string, limit = 500): {
    turnIndex: number[];
    tauReplay: Array<number | null>;
    tauPacked: Array<number | null>;
    budgetMax: Array<number | null>;
    assembleMs: Array<number | null>;
  } {
    const cap = Math.min(Math.max(1, limit), 500);
    const rows = this.db
      .prepare(
        `SELECT turn_index, tau_replay, tau_packed, budget_max, total_assemble_ms
         FROM turn_metrics
         WHERE session_id = ?
         ORDER BY turn_index DESC, timestamp DESC
         LIMIT ?`,
      )
      .all(sessionId, cap) as Array<{
      turn_index: number;
      tau_replay: number | null;
      tau_packed: number | null;
      budget_max: number | null;
      total_assemble_ms: number | null;
    }>;
    rows.reverse();
    return {
      turnIndex: rows.map((r) => Number(r.turn_index)),
      tauReplay: rows.map((r) => (r.tau_replay == null ? null : Number(r.tau_replay))),
      tauPacked: rows.map((r) => (r.tau_packed == null ? null : Number(r.tau_packed))),
      budgetMax: rows.map((r) => (r.budget_max == null ? null : Number(r.budget_max))),
      assembleMs: rows.map((r) =>
        r.total_assemble_ms == null ? null : Number(r.total_assemble_ms),
      ),
    };
  }

  /** Capacity snapshot from latest turn + pruned-per-turn sparkline. */
  capacityRows(
    sessionId: string,
    limit = 50,
  ): {
    latest: {
      matrixRowsK: number | null;
      matrixMaxSlots: number | null;
      graphActiveNodes: number | null;
      graphPrunedNodes: number | null;
    } | null;
    prunedPerTurn: number[];
  } {
    const latest = this.db
      .prepare(
        `SELECT matrix_rows_k, matrix_max_slots, graph_active_nodes, graph_pruned_nodes
         FROM turn_metrics
         WHERE session_id = ?
         ORDER BY turn_index DESC, timestamp DESC
         LIMIT 1`,
      )
      .get(sessionId) as
      | {
          matrix_rows_k: number | null;
          matrix_max_slots: number | null;
          graph_active_nodes: number | null;
          graph_pruned_nodes: number | null;
        }
      | undefined;

    const pruned = this.db
      .prepare(
        `SELECT graph_pruned_nodes
         FROM turn_metrics
         WHERE session_id = ?
         ORDER BY turn_index DESC, timestamp DESC
         LIMIT ?`,
      )
      .all(sessionId, Math.min(limit, 500)) as Array<{ graph_pruned_nodes: number | null }>;
    pruned.reverse();

    return {
      latest: latest
        ? {
            matrixRowsK: latest.matrix_rows_k == null ? null : Number(latest.matrix_rows_k),
            matrixMaxSlots:
              latest.matrix_max_slots == null ? null : Number(latest.matrix_max_slots),
            graphActiveNodes:
              latest.graph_active_nodes == null ? null : Number(latest.graph_active_nodes),
            graphPrunedNodes:
              latest.graph_pruned_nodes == null ? null : Number(latest.graph_pruned_nodes),
          }
        : null,
      prunedPerTurn: pruned.map((r) =>
        r.graph_pruned_nodes == null ? 0 : Number(r.graph_pruned_nodes),
      ),
    };
  }

  /** Count-only CSV rows (allowlisted columns). */
  exportTurnMetricsCsv(sessionId: string): { headers: string[]; rows: Array<Array<string | number | null>> } {
    const headers = [
      "session_id",
      "turn_index",
      "timestamp",
      "tau_replay",
      "tau_packed",
      "budget_max",
      "budget_used",
      "hot_set_tokens",
      "typed_lines_tokens",
      "ranked_span_tokens",
      "recent_tail_tokens",
      "matrix_rows_k",
      "matrix_max_slots",
      "graph_active_nodes",
      "graph_pruned_nodes",
      "rpc_latency_ms",
      "total_assemble_ms",
      "pack_method",
      "impl",
      "compacted",
    ];
    const rows = this.db
      .prepare(
        `SELECT ${headers.join(", ")} FROM turn_metrics WHERE session_id = ? ORDER BY turn_index ASC`,
      )
      .all(sessionId) as Array<Record<string, string | number | null>>;
    return {
      headers,
      rows: rows.map((r) => headers.map((h) => r[h] ?? null)),
    };
  }

  /** Delete rows older than 30d; if file >50MB delete oldest until ≤40MB. No VACUUM. */
  prune(nowMs = Date.now()): { deletedAge: number; deletedSize: number } {
    const ageCutoff = nowMs - PRUNE_MAX_AGE_MS;
    const ageResult = this.db
      .prepare("DELETE FROM turn_metrics WHERE timestamp < ?")
      .run(ageCutoff);
    const deletedAge = Number(ageResult.changes ?? 0);

    let deletedSize = 0;
    if (this.dbPath !== ":memory:" && existsSync(this.dbPath)) {
      let size = statSync(this.dbPath).size;
      while (size > PRUNE_MAX_BYTES) {
        const oldest = this.db
          .prepare("SELECT id FROM turn_metrics ORDER BY timestamp ASC LIMIT 200")
          .all() as Array<{ id: number }>;
        if (oldest.length === 0) break;
        const ids = oldest.map((r) => r.id);
        this.db.exec(`DELETE FROM turn_metrics WHERE id IN (${ids.join(",")})`);
        deletedSize += ids.length;
        size = existsSync(this.dbPath) ? statSync(this.dbPath).size : 0;
        if (size <= PRUNE_TARGET_BYTES) break;
      }
    }
    this.lastPruneMs = nowMs;
    return { deletedAge, deletedSize };
  }

  private maybePrune(): void {
    const now = Date.now();
    if (
      this.writeCount % PRUNE_EVERY_N_WRITES === 0 ||
      now - this.lastPruneMs >= PRUNE_MIN_INTERVAL_MS
    ) {
      try {
        this.prune(now);
      } catch {
        /* swallow */
      }
    }
  }

  fileSizeBytes(): number | null {
    if (this.dbPath === ":memory:" || !existsSync(this.dbPath)) return null;
    return statSync(this.dbPath).size;
  }

  integrityOk(): boolean {
    try {
      const row = this.db.prepare("PRAGMA integrity_check").get() as {
        integrity_check?: string;
      };
      return String(row?.integrity_check ?? "").toLowerCase() === "ok";
    } catch {
      return false;
    }
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* swallow */
    }
  }
}

const INLINE_SCHEMA = `
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
`;
