/**
 * Compact: flush + precompact snapshot + typed checkpoint sample. Never call LLM.
 */

import { cpSync, existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { CompressorConfig } from "./config.ts";
import type { PackerSample, PackSample } from "./assemble.ts";
import type { ChatMessage } from "./messages.ts";
import { tauTokens } from "./messages.ts";
import { logInfo, logWarn } from "./log.ts";
import type { Tracker } from "./telemetry/tracker.ts";
import type { PackerImpl } from "./telemetry/types.ts";
import { buildCompactMetrics } from "./telemetry/map.ts";

export type PackerFlush = {
  flush: (
    agentId: string,
    params?: { reason?: string },
  ) => Promise<Record<string, unknown>>;
};

export type CompactArgs = {
  instruction?: string;
  prompt?: string;
  sessionKey?: string;
  messages?: ChatMessage[];
  /** Host LLM — must never be invoked by compact. */
  complete?: (...args: unknown[]) => Promise<unknown>;
  chat?: (...args: unknown[]) => Promise<unknown>;
  runtimeContext?: {
    rewriteTranscriptEntries?: (entries: unknown[]) => Promise<void> | void;
    stateDir?: string;
    [key: string]: unknown;
  };
};

export type CompactResult = {
  ok: true;
  compacted: true;
  entryText?: string;
  snapshotDir?: string;
};

export class CompactError extends Error {
  readonly code = "COMPACT_FAILED";
  constructor(message: string) {
    super(message);
    this.name = "CompactError";
  }
}

function lastUserText(messages: ChatMessage[] | undefined): string {
  if (!messages?.length) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (String(m.role).toLowerCase() === "user") {
      const t = typeof m.text === "string" ? m.text : typeof m.content === "string" ? m.content : "";
      if (t) return t;
    }
  }
  return "";
}

/** Prefer HOT_SET / identifier lines when present; else full pack text. */
export function typedCheckpointText(pack: PackSample): string {
  const text = pack.text || "";
  if (!text.trim()) return "";
  const lines = text.split(/\r?\n/);
  const preferred = lines.filter((line) =>
    /HOT_SET|OpenItem|Decision|path=|identifier|UUID|STATE:/i.test(line),
  );
  if (preferred.length > 0) return preferred.join("\n");
  return text;
}

function copyIfExists(src: string, dest: string, copied: string[]): void {
  if (!existsSync(src)) return;
  mkdirSync(join(dest, ".."), { recursive: true });
  cpSync(src, dest, { recursive: true });
  copied.push(src);
}

export function freezePrecompactSnapshot(
  sessionStateDir: string,
  isoStamp: string,
): { snapshotDir: string; manifestPath: string } {
  const snapshotDir = join(sessionStateDir, "precompact", isoStamp);
  mkdirSync(snapshotDir, { recursive: true });
  const copied: string[] = [];

  copyIfExists(join(sessionStateDir, "graph.json"), join(snapshotDir, "graph.json"), copied);
  copyIfExists(join(sessionStateDir, "meta.sqlite"), join(snapshotDir, "meta.sqlite"), copied);
  // Copy recent span / safetensors listings into manifest; copy small span json files.
  const names = existsSync(sessionStateDir) ? readdirSync(sessionStateDir) : [];
  const spanFiles = names.filter(
    (n) => n.endsWith(".spans.json") || /^t\d+\.safetensors$/.test(n) || n === "meta.json",
  );
  for (const name of spanFiles.slice(-8)) {
    copyIfExists(join(sessionStateDir, name), join(snapshotDir, name), copied);
  }

  const manifest = {
    created: isoStamp,
    copied,
    note: "Minimum restore set for doctor/debug; not automatic rollback.",
  };
  const manifestPath = join(snapshotDir, "manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return { snapshotDir, manifestPath };
}

export type CompactContext = {
  config: CompressorConfig;
  packer: PackerSample & PackerFlush;
  agentId: string;
  sessionId: string;
  sessionStateDir: string;
  /** Optional probe: if pack empty and this returns true, throw. */
  graphNonempty?: () => Promise<boolean> | boolean;
  tracker?: Tracker;
  packerImpl?: PackerImpl;
  turnIndex?: number;
};

export async function compact(
  ctx: CompactContext,
  args: CompactArgs = {},
): Promise<CompactResult> {
  const t0 = Date.now();
  // Assert LLM hooks are not used even if provided.
  const complete = args.complete;
  const chat = args.chat;

  await ctx.packer.flush(ctx.agentId, { reason: "compact" });

  const iso = new Date().toISOString().replace(/[:.]/g, "");
  const { snapshotDir } = freezePrecompactSnapshot(ctx.sessionStateDir, iso);

  const query =
    args.instruction ||
    args.prompt ||
    lastUserText(args.messages) ||
    "/compact";

  const pack = await ctx.packer.sample(ctx.agentId, {
    query,
    budget: ctx.config.forwardBudget,
    span_k: ctx.config.matrixSpanK,
  });

  const entryText = typedCheckpointText(pack);
  // τ of checkpoint before discarding string from metrics path.
  const checkpointTau = tauTokens(entryText);
  const nonemptyGraph = ctx.graphNonempty ? await ctx.graphNonempty() : false;
  if (!entryText.trim() && nonemptyGraph) {
    throw new CompactError("empty compact entry while graph is nonempty");
  }
  if (!entryText.trim() && pack.packed_tokens > 0) {
    // Defensive: packed but no text — treat as failure if graph claimed nonempty.
    if (nonemptyGraph) throw new CompactError("compact sample returned no entry text");
  }

  if (args.runtimeContext?.rewriteTranscriptEntries) {
    await args.runtimeContext.rewriteTranscriptEntries([
      {
        role: "assistant",
        content: entryText,
        kind: "typed_compact_checkpoint",
      },
    ]);
  }

  if (complete || chat) {
    // Documented: compact must not call these. Presence alone is fine; call count must stay 0.
    logInfo("compact llm hooks present but unused", { session: ctx.sessionId });
  }

  const ms = Date.now() - t0;
  logInfo("compact", {
    session: ctx.sessionId,
    packed_tokens: pack.packed_tokens,
    snapshotDir,
    entry_len: entryText.length,
    ms,
  });

  if (ctx.tracker) {
    try {
      ctx.tracker.trackTurn(
        buildCompactMetrics({
          sessionId: ctx.sessionId,
          turnIndex: ctx.turnIndex ?? 0,
          checkpointTau,
          totalMs: ms,
          pack: {
            packed_tokens: pack.packed_tokens,
            method: pack.method,
            k: pack.k,
            k_max: pack.k_max,
            t: pack.t,
            duration_ms: pack.duration_ms,
            rpc_latency_ms: pack.rpc_latency_ms ?? pack.duration_ms,
            hot_set_tokens: pack.hot_set_tokens,
            typed_lines_tokens: pack.typed_lines_tokens,
            ranked_span_tokens: pack.ranked_span_tokens,
            matrix_rows_k: pack.matrix_rows_k ?? pack.k,
            matrix_max_slots: pack.matrix_max_slots ?? pack.k_max,
            graph_active_nodes: pack.graph_active_nodes,
            graph_pruned_nodes: pack.graph_pruned_nodes,
          },
          impl: ctx.packerImpl ?? "sidecar",
        }),
      );
      ctx.tracker.trackEvent("precompact_frozen", ctx.sessionId);
    } catch (err) {
      logWarn("telemetry compact enqueue swallowed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    ok: true,
    compacted: true,
    entryText,
    snapshotDir,
  };
}

/** Read graph.json node count for empty-compact guard when file exists. */
export function graphLooksNonempty(sessionStateDir: string): boolean {
  const path = join(sessionStateDir, "graph.json");
  if (!existsSync(path)) return false;
  try {
    const raw = readFileSync(path, "utf8");
    const json = JSON.parse(raw) as { nodes?: unknown[]; active?: unknown[] };
    const n = Array.isArray(json.nodes)
      ? json.nodes.length
      : Array.isArray(json.active)
        ? json.active.length
        : Object.keys(json).length;
    return n > 0;
  } catch {
    return rawLengthHint(path);
  }
}

function rawLengthHint(path: string): boolean {
  try {
    return readFileSync(path, "utf8").trim().length > 2;
  } catch {
    return false;
  }
}
