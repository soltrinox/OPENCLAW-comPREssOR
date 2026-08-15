/**
 * Management operators (Plan 10): DynamicProfileSwitcher + ManualStateOperator.
 * POST bodies: profile | flush | compact | purge. Confirm-gated destructive actions.
 */

import { existsSync, rmSync, appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  CURSOR_PARITY_DEFAULTS,
  RECALL_05_DEFAULTS,
  validateConfig,
  type CompressorConfig,
  type ProfileName,
} from "./config.ts";
import { expandStateDir } from "./config.ts";
import { sanitize } from "./ids.ts";
import { rejectUnsafeSessionId, assertSessionUnderStateDir } from "./api.ts";
import { logInfo, logWarn } from "./log.ts";
import type { EngineHost } from "./engine.ts";
import { TelemetryStore, telemetryDbPath } from "./telemetry/store.ts";
import { TsPacker } from "./packer-port.ts";
import { invalidatePackCache } from "./pack-cache.ts";
import { appendMemoryNotes } from "./memory-notes.ts";
import { Tracker } from "./telemetry/tracker.ts";

export type ManageOk = { ok: true; data?: Record<string, unknown> };
export type ManageErr = {
  ok: false;
  error: string;
  httpStatus: number;
  code?: string;
};
export type ManageResult = ManageOk | ManageErr;

function err(code: string, message: string, httpStatus = 400): ManageErr {
  return { ok: false, error: message, httpStatus, code };
}

function resolveSession(raw: string | undefined): ManageErr | { session: string } {
  if (!raw) return err("session_required", "session required");
  const bad = rejectUnsafeSessionId(raw);
  if (bad) return err("unknown_session", `session not found (${bad})`, 400);
  return { session: sanitize(raw) };
}

/** Emit system_event code via tracker or direct store insert. */
export function emitManageEvent(
  config: CompressorConfig,
  session: string,
  code: "profile_changed" | "graph_flushed" | "precompact_frozen",
  tracker?: Tracker | null,
): void {
  try {
    if (tracker) {
      tracker.trackEvent(code, session);
      return;
    }
    const check = assertSessionUnderStateDir(config.stateDir, session);
    if (!check.ok) return;
    const path = telemetryDbPath(check.sessionStateDir);
    mkdirSync(check.sessionStateDir, { recursive: true });
    const store = new TelemetryStore(path);
    store.insertEvent({ code, sessionId: session, timestamp: Date.now() });
    store.close();
  } catch (e) {
    logWarn("manage event emit failed", {
      code,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

export type ProfileSwitchBody = {
  profile: ProfileName | string;
  overlays?: Record<string, unknown>;
  session?: string;
};

/**
 * Hot-swap profile without wiping session graph (D10.2, D10.3).
 * Refuses engineImpl overlay with 400 restart_required.
 */
export function switchProfile(
  host: EngineHost,
  body: ProfileSwitchBody,
  opts?: { tracker?: Tracker | null },
): ManageResult {
  const sessionR = resolveSession(body.session);
  if ("ok" in sessionR && sessionR.ok === false) return sessionR;
  if (!("session" in sessionR)) return sessionR;
  const session = sessionR.session;

  if (body.overlays && "engineImpl" in body.overlays) {
    return err("restart_required", "engineImpl change requires Gateway restart", 400);
  }

  const profile = body.profile;
  if (profile !== "recall-0.5" && profile !== "cursor-parity") {
    return err("invalid_profile", 'profile must be "recall-0.5" or "cursor-parity"');
  }

  const base =
    profile === "cursor-parity" ? { ...CURSOR_PARITY_DEFAULTS } : { ...RECALL_05_DEFAULTS };
  // Preserve stateDir / engineImpl / pythonPath from current host.
  const merged: Record<string, unknown> = {
    ...base,
    stateDir: host.resolvedConfig.stateDir,
    engineImpl: host.resolvedConfig.engineImpl,
    pythonPath: host.resolvedConfig.pythonPath,
    promoteMemoryNotes: host.resolvedConfig.promoteMemoryNotes,
    shareGraphByAgent: host.resolvedConfig.shareGraphByAgent,
    skipHeartbeats: host.resolvedConfig.skipHeartbeats,
    ...(body.overlays ?? {}),
    profile,
  };
  // Never allow engineImpl via overlays (already refused) — strip if slipped.
  delete merged.engineImpl;
  merged.engineImpl = host.resolvedConfig.engineImpl;

  let resolved: CompressorConfig;
  try {
    const loaded = validateConfig(merged);
    resolved = loaded.resolved;
  } catch (e) {
    return err(
      "schema_invalid",
      e instanceof Error ? e.message : String(e),
      400,
    );
  }

  // Mutate host config in place (same object reference used by assemble).
  Object.assign(host.resolvedConfig, resolved);

  // Apply to TsPacker handles without dropping graph.
  const packer = host._packer as TsPacker | undefined;
  if (packer && typeof (packer as TsPacker & { applyConfig?: (c: CompressorConfig) => void }).applyConfig === "function") {
    (packer as TsPacker & { applyConfig: (c: CompressorConfig) => void }).applyConfig(resolved);
  }

  // Prove graph.json still present.
  const check = assertSessionUnderStateDir(host.resolvedConfig.stateDir, session);
  const graphStillThere =
    check.ok && existsSync(join(check.sessionStateDir, "graph.json"));

  invalidatePackCache(session);
  emitManageEvent(host.resolvedConfig, session, "profile_changed", opts?.tracker);
  logInfo("profile_changed", {
    session,
    profile: resolved.profile,
    budget: resolved.forwardBudget,
    kMax: resolved.kMax,
    graph: graphStillThere,
  });

  return {
    ok: true,
    data: {
      profile: resolved.profile,
      forwardBudget: resolved.forwardBudget,
      kMax: resolved.kMax,
      graphPreserved: graphStillThere,
    },
  };
}

export async function forceFlush(
  host: EngineHost,
  body: { session?: string },
  opts?: { tracker?: Tracker | null },
): Promise<ManageResult> {
  const sessionR = resolveSession(body.session);
  if (!("session" in sessionR)) return sessionR;
  const session = sessionR.session;
  try {
    await host._packer?.flush(session, { reason: "manual_flush" });
    invalidatePackCache(session);
    emitManageEvent(host.resolvedConfig, session, "graph_flushed", opts?.tracker);
    return { ok: true, data: { session, event: "graph_flushed" } };
  } catch (e) {
    return err("flush_failed", e instanceof Error ? e.message : String(e), 500);
  }
}

export async function triggerCompact(
  host: EngineHost,
  body: { session?: string; query?: string; confirm?: boolean | string },
  opts?: { tracker?: Tracker | null; workspaceRoot?: string },
): Promise<ManageResult> {
  const sessionR = resolveSession(body.session);
  if (!("session" in sessionR)) return sessionR;
  const session = sessionR.session;
  if (body.confirm !== true && body.confirm !== "true") {
    return err(
      "confirm_required",
      "compact requires confirm: true (typed checkpoint, no LLM)",
      400,
    );
  }
  const llmMock = { calls: 0 };
  const complete = async () => {
    llmMock.calls += 1;
    throw new Error("LLM must not be called");
  };
  try {
    const result = await host.compact({
      sessionKey: session,
      instruction: body.query,
      complete,
      chat: complete,
    });
    if (llmMock.calls !== 0) {
      return err("llm_invoked", "compact must not call conversation model", 500);
    }
    invalidatePackCache(session);
    emitManageEvent(host.resolvedConfig, session, "precompact_frozen", opts?.tracker);

    if (host.resolvedConfig.promoteMemoryNotes) {
      appendMemoryNotes({
        workspaceRoot: opts?.workspaceRoot,
        session,
        entryText: result.entryText ?? "",
        identifiersOnly: true,
      });
    }

    return {
      ok: true,
      data: {
        session,
        llmCalls: llmMock.calls,
        entryLen: (result.entryText ?? "").length,
      },
    };
  } catch (e) {
    return err("compact_failed", e instanceof Error ? e.message : String(e), 500);
  }
}

/**
 * Purge session state dir. confirm must equal session id (A10-11/A10-12).
 * Destructive only under fixture/stateDir — never escapes root.
 */
export function purgeSession(
  config: CompressorConfig,
  body: { session?: string; confirm?: string },
): ManageResult {
  const sessionR = resolveSession(body.session);
  if (!("session" in sessionR)) return sessionR;
  const session = sessionR.session;
  if (body.confirm !== session) {
    return err(
      "confirm_mismatch",
      "purge requires confirm equal to session id; no delete",
      400,
    );
  }
  const check = assertSessionUnderStateDir(config.stateDir, session);
  if (!check.ok) return err("path_escape", check.message, 400);
  const dir = check.sessionStateDir;
  if (!existsSync(dir)) {
    return { ok: true, data: { session, deleted: false, reason: "missing" } };
  }
  try {
    rmSync(dir, { recursive: true, force: true });
    invalidatePackCache(session);
    logInfo("purge_session", { session, dir });
    return { ok: true, data: { session, deleted: true } };
  } catch (e) {
    return err("purge_failed", e instanceof Error ? e.message : String(e), 500);
  }
}

/** HTTP adapter helpers — never return stack traces with foreign session paths. */
export function manageJson(result: ManageResult): {
  statusCode: number;
  body: { ok: boolean; error?: string; data?: Record<string, unknown> };
} {
  if (result.ok) {
    return { statusCode: 200, body: { ok: true, data: result.data } };
  }
  return {
    statusCode: result.httpStatus,
    body: { ok: false, error: result.error },
  };
}

/** CLI purge: --confirm means confirm token === session. */
export function purgeFromCli(
  config: CompressorConfig,
  args: { session?: string; confirm?: boolean },
): ManageResult {
  if (!args.session) return err("session_required", "session required");
  if (!args.confirm) {
    return err("confirm_required", "pass --confirm (confirm token = session id)", 400);
  }
  return purgeSession(config, { session: args.session, confirm: sanitize(args.session) });
}

/** Append-only audit line under session logs (counts/codes only). */
export function appendManageAudit(
  config: CompressorConfig,
  session: string,
  line: Record<string, unknown>,
): void {
  try {
    const check = assertSessionUnderStateDir(config.stateDir, session);
    if (!check.ok) return;
    const logs = join(check.sessionStateDir, "logs");
    mkdirSync(logs, { recursive: true });
    appendFileSync(
      join(logs, "manage-audit.log.txt"),
      `${JSON.stringify({ ...line, ts: new Date().toISOString() })}\n`,
    );
  } catch {
    /* ignore */
  }
}

void Tracker;
void expandStateDir;
void RECALL_05_DEFAULTS;
