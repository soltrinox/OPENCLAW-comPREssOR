/**
 * Pure read handlers over telemetry.sqlite (Plan 08).
 * SDK-agnostic — index.ts wires registerHttpRoute / registerGatewayMethod.
 * Never writes. Never returns HOT_SET / pack text.
 */

import { existsSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { expandStateDir, type CompressorConfig } from "./config.ts";
import { sanitize } from "./ids.ts";
import { TelemetryStore, telemetryDbPath } from "./telemetry/store.ts";

export type ApiStatus = "ok" | "empty" | "error";

export type SummaryDTO = {
  status: ApiStatus;
  data?: {
    session: string;
    totalTurns: number;
    message?: string;
    efficiency: {
      totalTauReplay: number;
      totalTauPacked: number;
      savedTokens: number;
      reductionRatio: number | null;
      unit: "tau";
      reason?: string;
    };
    health: {
      sidecarStatus: "active" | "quarantined" | "ts" | "stopped";
      avgLatencyMs: number;
      matrixSaturationPct: number | null;
      matrixK?: number | null;
      matrixKMax?: number | null;
    };
  };
  error?: { code: string; message: string };
};

export type TimeseriesDTO = {
  status: ApiStatus;
  data?: {
    turnIndex: number[];
    tauReplay: Array<number | null>;
    tauPacked: Array<number | null>;
    budgetMax: Array<number | null>;
    assembleMs: Array<number | null>;
  };
  error?: { code: string; message: string };
};

export type CapacityDTO = {
  status: ApiStatus;
  data?: {
    matrix: { k: number; kMax: number; optional: boolean };
    graph: {
      turns: { active: number; cap: number };
      durableFacts: { active: number; cap: number };
      nonDurableFacts: { active: number; cap: number };
    };
    prunedPerTurn: number[];
  };
  error?: { code: string; message: string };
};

export type HandlerQuery = {
  session?: string;
  limit?: number;
  store?: TelemetryStore;
  dbPath?: string;
  config?: CompressorConfig;
  /** Injected health for summary (optional). */
  sidecarStatus?: SummaryDTO["data"] extends infer D
    ? D extends { health: { sidecarStatus: infer S } }
      ? S
      : never
    : never;
  /** Last-active default when session omitted. */
  defaultSession?: string | null;
};

/** Reject path-traversal session strings before sanitize maps them to safe ids. */
export function rejectUnsafeSessionId(raw: string): string | null {
  if (/[/\\]/.test(raw) || raw.includes("..")) {
    return "path_traversal";
  }
  try {
    const id = sanitize(raw);
    if (!id || id === "unknown") return "invalid_session";
    return null;
  } catch {
    return "invalid_session";
  }
}

export function resolveSessionId(q: HandlerQuery):
  | { ok: true; session: string }
  | { ok: false; code: string; message: string } {
  const raw = q.session;
  if (raw === undefined || raw === null || String(raw).length === 0) {
    const def = q.defaultSession ?? q.store?.lastActiveSessionId() ?? null;
    if (!def) {
      return { ok: false, code: "session_required", message: "session query param required" };
    }
    return { ok: true, session: def };
  }
  const bad = rejectUnsafeSessionId(String(raw));
  if (bad) {
    return { ok: false, code: "unknown_session", message: `session not found (${bad})` };
  }
  return { ok: true, session: sanitize(String(raw)) };
}

function openStore(q: HandlerQuery): TelemetryStore {
  if (q.store) return q.store;
  if (q.dbPath) return TelemetryStore.openReadonly(q.dbPath);
  if (q.config && q.session) {
    const sid = sanitize(q.session);
    const path = telemetryDbPath(join(expandStateDir(q.config.stateDir), sid));
    return TelemetryStore.openReadonly(path);
  }
  throw new Error("store or dbPath required");
}

function mapSidecarStatus(
  impl: string | null | undefined,
  injected?: SummaryDTO["data"] extends infer D
    ? D extends { health: { sidecarStatus: infer S } }
      ? S
      : never
    : never,
): NonNullable<SummaryDTO["data"]>["health"]["sidecarStatus"] {
  if (injected) return injected;
  if (impl === "ts") return "ts";
  if (impl === "sidecar") return "active";
  return "stopped";
}

export function handleSummary(q: HandlerQuery): SummaryDTO {
  try {
    const resolved = resolveSessionId(q);
    if (!resolved.ok) {
      return { status: "error", error: { code: resolved.code, message: resolved.message } };
    }
    const store = openStore({ ...q, session: resolved.session });
    const eff = store.summarizeEfficiency(resolved.session);
    if (eff.totalTurns === 0) {
      return {
        status: "empty",
        data: {
          session: resolved.session,
          totalTurns: 0,
          message: "no_samples",
          efficiency: {
            totalTauReplay: 0,
            totalTauPacked: 0,
            savedTokens: 0,
            reductionRatio: 0,
            unit: "tau",
            reason: "no_samples",
          },
          health: {
            sidecarStatus: mapSidecarStatus(null, q.sidecarStatus),
            avgLatencyMs: 0,
            matrixSaturationPct: null,
            matrixK: null,
            matrixKMax: null,
          },
        },
      };
    }
    return {
      status: "ok",
      data: {
        session: resolved.session,
        totalTurns: eff.totalTurns,
        efficiency: {
          totalTauReplay: eff.totalTauReplay,
          totalTauPacked: eff.totalTauPacked,
          savedTokens: eff.savedTokens,
          reductionRatio: eff.reductionRatio,
          unit: "tau",
          ...(eff.reason ? { reason: eff.reason } : {}),
        },
        health: {
          sidecarStatus: mapSidecarStatus(eff.latestImpl, q.sidecarStatus),
          avgLatencyMs: eff.avgLatencyMs,
          matrixSaturationPct: eff.matrixSaturationPct,
          matrixK: eff.latestK,
          matrixKMax: eff.latestKMax,
        },
      },
    };
  } catch (err) {
    return {
      status: "error",
      error: {
        code: "summary_failed",
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

export function handleTimeseries(q: HandlerQuery): TimeseriesDTO {
  try {
    const resolved = resolveSessionId(q);
    if (!resolved.ok) {
      return { status: "error", error: { code: resolved.code, message: resolved.message } };
    }
    const store = openStore({ ...q, session: resolved.session });
    const data = store.timeseries(resolved.session, q.limit ?? 500);
    if (data.turnIndex.length === 0) {
      return { status: "empty", data };
    }
    return { status: "ok", data };
  } catch (err) {
    return {
      status: "error",
      error: {
        code: "timeseries_failed",
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

/** Graph caps: use resolvedConfig profile; telemetry may not store family splits yet. */
export function handleCapacity(q: HandlerQuery): CapacityDTO {
  try {
    const resolved = resolveSessionId(q);
    if (!resolved.ok) {
      return { status: "error", error: { code: resolved.code, message: resolved.message } };
    }
    const config = q.config;
    if (!config) {
      return {
        status: "error",
        error: { code: "config_required", message: "resolvedConfig required for capacity caps" },
      };
    }
    const store = openStore({ ...q, session: resolved.session });
    const cap = store.capacityRows(resolved.session);
    const kMax = config.kMax;
    const k = cap.latest?.matrixRowsK ?? 0;
    const activeNodes = cap.latest?.graphActiveNodes ?? 0;
    // Family splits not in v1 schema — expose active under turns; caps from profile knobs.
    const turnCap = Math.max(1, Math.floor(config.chunksPerTurn * 3));
    const durableCap = Math.max(1, Math.floor(kMax * 0.75));
    const nonDurableCap = kMax;
    return {
      status: cap.latest ? "ok" : "empty",
      data: {
        matrix: {
          k: Number(k),
          kMax,
          optional: config.engineImpl === "ts",
        },
        graph: {
          turns: { active: Math.min(activeNodes, turnCap), cap: turnCap },
          durableFacts: { active: 0, cap: durableCap },
          nonDurableFacts: { active: Math.max(0, activeNodes), cap: nonDurableCap },
        },
        prunedPerTurn: cap.prunedPerTurn,
      },
    };
  } catch (err) {
    return {
      status: "error",
      error: {
        code: "capacity_failed",
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

/** POST profile — Plan 10 DynamicProfileSwitcher. */
export type PostProfileBody = {
  profile?: string;
  overlays?: Record<string, unknown>;
  session?: string;
};

export function handlePostProfile(
  _q: HandlerQuery = {},
  _body?: PostProfileBody,
): {
  status: "error" | "ok";
  httpStatus: number;
  error?: { code: string; message: string };
  data?: Record<string, unknown>;
} {
  // Thin stub when called without host — index wires real switchProfile.
  if (!_body?.session || !_body?.profile) {
    return {
      status: "error",
      httpStatus: 400,
      error: { code: "bad_request", message: "session and profile required" },
    };
  }
  return {
    status: "error",
    httpStatus: 501,
    error: {
      code: "host_required",
      message: "POST profile requires EngineHost (wired in index.ts)",
    },
  };
}

/** Session state dir must stay under expandStateDir(config.stateDir). */
export function assertSessionUnderStateDir(
  stateDir: string,
  sessionId: string,
): { ok: true; sessionStateDir: string } | { ok: false; message: string } {
  const root = expandStateDir(stateDir);
  const resolvedRoot = resolve(root) + sep;
  const sessionStateDir = resolve(join(root, sessionId));
  if (!sessionStateDir.startsWith(resolvedRoot) && sessionStateDir !== resolve(root)) {
    return { ok: false, message: "session path escapes stateDir" };
  }
  return { ok: true, sessionStateDir };
}

export function telemetryDbForSession(config: CompressorConfig, sessionId: string): string {
  const check = assertSessionUnderStateDir(config.stateDir, sessionId);
  if (!check.ok) throw new Error(check.message);
  return telemetryDbPath(check.sessionStateDir);
}

export function dbBytesIfExists(dbPath: string): number | null {
  if (!existsSync(dbPath)) return null;
  return statSync(dbPath).size;
}
