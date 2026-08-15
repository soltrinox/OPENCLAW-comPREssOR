/**
 * EngineHost: ingest / assemble / compact / commitTurn / bootstrap / afterTurn / dispose.
 * Plan 03 lifecycle — uses Plan 02 SidecarClient (or injected packer mock).
 */

import { appendFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { CompressorConfig } from "./config.ts";
import { expandStateDir } from "./config.ts";
import { graphRoot } from "./ids.ts";
import { MetaStore } from "./meta-store.ts";
import { createPacker, type EnginePacker } from "./packer-port.ts";
import { ingest as ingestMsg, ingestBatch, type IngestContext } from "./ingest.ts";
import { assemble as assembleFn, type AssembleArgs, type AssembleResult } from "./assemble.ts";
import { compact as compactFn, graphLooksNonempty, type CompactArgs, type CompactResult } from "./compact.ts";
import { commitTurn as commitTurnFn, type CommitTurnArgs } from "./commit.ts";
import type { ChatMessage } from "./messages.ts";
import { logInfo } from "./log.ts";
import { prepareSubagentSpawn, onSubagentEnded } from "./subagent.ts";
import { appendMemoryNotes } from "./memory-notes.ts";
import { invalidatePackCache } from "./pack-cache.ts";
import type { SubagentSpawnArgs, SubagentEndedArgs } from "./subagent.ts";

export type { EnginePacker } from "./packer-port.ts";
import { Tracker } from "./telemetry/tracker.ts";
import { telemetryDbPath } from "./telemetry/store.ts";
import type { PackerImpl } from "./telemetry/types.ts";

export class EngineNotReadyError extends Error {
  readonly code = "ENGINE_NOT_READY";
  constructor(method: string) {
    super(
      `compressor ${method} is not implemented until Plan 03 (lifecycle). Host should quarantine to legacy.`,
    );
    this.name = "EngineNotReadyError";
  }
}

export type EngineHostInfo = {
  id: "compressor";
  name: string;
  ownsCompaction: true;
  acceptedHostParams: string[];
  transcriptSemantics: {
    currentTurnFence: "before-current-turn-entry-v1";
    turnAdvancementIdempotency: "atomic-idempotent-v1";
  };
  hostRequirements: {
    "agent-run": { requiredCapabilities: ["assemble-before-prompt"] };
  };
};

export const COMPRESSOR_ENGINE_INFO: EngineHostInfo = {
  id: "compressor",
  name: "OpenClaw compressor",
  ownsCompaction: true,
  acceptedHostParams: ["sessionKey", "runtimeContext"],
  transcriptSemantics: {
    currentTurnFence: "before-current-turn-entry-v1",
    turnAdvancementIdempotency: "atomic-idempotent-v1",
  },
  hostRequirements: {
    "agent-run": { requiredCapabilities: ["assemble-before-prompt"] },
  },
};

export type EngineHostHooks = {
  buildMemorySystemPromptAddition?: AssembleArgs["buildMemorySystemPromptAddition"];
  readSessionTranscriptVisibleMessageDelta?: () =>
    | Promise<ChatMessage[]>
    | ChatMessage[];
  rewriteTranscriptEntries?: (entries: unknown[]) => Promise<void> | void;
  /** When true, compact treats graph as nonempty for empty-entry guard. */
  graphNonempty?: () => Promise<boolean> | boolean;
};

export type CreateEngineHostOptions = {
  packer?: EnginePacker;
  meta?: MetaStore;
  metaDbPath?: string;
  hooks?: EngineHostHooks;
  /** Skip auto-start of real sidecar (tests inject packer). */
  autoStartSidecar?: boolean;
  /** Optional shared tracker (tests). Otherwise per-session telemetry.sqlite. */
  tracker?: Tracker;
  packerImpl?: PackerImpl;
};

export type EngineHost = {
  info: EngineHostInfo;
  resolvedConfig: CompressorConfig;
  bootstrap: (args?: {
    sessionKey?: string;
    agentId?: string;
    messages?: ChatMessage[];
  }) => Promise<{ ok: true; recovered?: boolean }>;
  ingest: (args: {
    message?: ChatMessage;
    messages?: ChatMessage[];
    sessionKey?: string;
    agentId?: string;
    index?: number;
  }) => Promise<{ ingested: boolean; skipped?: string }>;
  ingestBatch: (args: {
    messages: ChatMessage[];
    sessionKey?: string;
    agentId?: string;
  }) => Promise<{ ingested: boolean; count: number }>;
  assemble: (args: AssembleArgs) => Promise<AssembleResult>;
  compact: (args?: CompactArgs) => Promise<CompactResult>;
  commitTurn: (args: CommitTurnArgs & { sessionKey?: string; agentId?: string }) => Promise<{
    status: "committed" | "duplicate";
    advancementKey: string;
  }>;
  afterTurn: (args?: {
    sessionKey?: string;
    agentId?: string;
    packed_tokens?: number;
    method?: string;
    t?: number;
    latencyMs?: number;
  }) => Promise<{ ok: true }>;
  dispose: () => Promise<void>;
  prepareSubagentSpawn: (args?: SubagentSpawnArgs) => Promise<{
    ok: true;
    skipped?: boolean;
    childSessionId?: string;
    copiedLines?: number;
  }>;
  onSubagentEnded: (args?: SubagentEndedArgs) => Promise<{
    ok: true;
    derivedCount?: number;
    parentKDelta?: number;
  }>;
  graphRootFor: (sessionKey?: string, agentId?: string) => string;
  /** Test / doctor access */
  _packer?: EnginePacker;
  _meta?: MetaStore;
  /** Aggregate telemetry_dropped across session trackers. */
  telemetryDropped: () => number;
};

function sessionDirs(config: CompressorConfig, sessionId: string): {
  root: string;
  sessionStateDir: string;
  metaDbPath: string;
  telemetryDbPath: string;
  logsDir: string;
} {
  const root = expandStateDir(config.stateDir);
  const sessionStateDir = join(root, sessionId);
  return {
    root,
    sessionStateDir,
    metaDbPath: join(sessionStateDir, "meta.sqlite"),
    telemetryDbPath: telemetryDbPath(sessionStateDir),
    logsDir: join(sessionStateDir, "logs"),
  };
}

export function createEngineHost(
  resolvedConfig: CompressorConfig,
  options: CreateEngineHostOptions = {},
): EngineHost {
  let packer = options.packer;
  if (!packer) {
    // Plan 06: packer-port switch (ts → TsPacker, sidecar → SidecarClient).
    packer = createPacker(resolvedConfig);
  }

  const metaCache = new Map<string, MetaStore>();
  const trackerCache = new Map<string, Tracker>();
  const packerImpl: PackerImpl =
    options.packerImpl ?? (resolvedConfig.engineImpl === "ts" ? "ts" : "sidecar");

  const getMeta = (sessionId: string): MetaStore => {
    if (options.meta) return options.meta;
    let store = metaCache.get(sessionId);
    if (!store) {
      const path = options.metaDbPath ?? sessionDirs(resolvedConfig, sessionId).metaDbPath;
      store = new MetaStore(path);
      metaCache.set(sessionId, store);
    }
    return store;
  };

  const getTracker = (sessionId: string): Tracker => {
    if (options.tracker) return options.tracker;
    let t = trackerCache.get(sessionId);
    if (!t) {
      const { telemetryDbPath: path } = sessionDirs(resolvedConfig, sessionId);
      t = new Tracker({ dbPath: path });
      trackerCache.set(sessionId, t);
    }
    return t;
  };

  let started = false;
  const ensureStarted = async () => {
    if (started) return;
    if (options.autoStartSidecar === false) {
      started = true;
      return;
    }
    if (packer!.start) await packer!.start();
    started = true;
  };

  const resolveIds = (sessionKey?: string, agentId?: string) => {
    const id = graphRoot(sessionKey, agentId, resolvedConfig.shareGraphByAgent);
    return { agentId: id, sessionId: id };
  };

  const makeCtx = (sessionKey?: string, agentId?: string): IngestContext & {
    packer: EnginePacker;
    tracker: Tracker;
    packerImpl: PackerImpl;
  } => {
    const ids = resolveIds(sessionKey, agentId);
    return {
      config: resolvedConfig,
      packer: packer!,
      meta: getMeta(ids.sessionId),
      agentId: ids.agentId,
      sessionId: ids.sessionId,
      tracker: getTracker(ids.sessionId),
      packerImpl,
    };
  };

  const writeStageLog = (
    sessionId: string,
    line: Record<string, unknown>,
  ): void => {
    const { logsDir } = sessionDirs(resolvedConfig, sessionId);
    mkdirSync(logsDir, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const path = join(logsDir, `stages-${stamp}.log.txt`);
    appendFileSync(path, `${JSON.stringify(line)}\n`);
  };

  const host: EngineHost = {
    info: COMPRESSOR_ENGINE_INFO,
    resolvedConfig,
    _packer: packer,
    get _meta() {
      return options.meta;
    },

    async bootstrap(args = {}) {
      await ensureStarted();
      const ctx = makeCtx(args.sessionKey, args.agentId);
      const { sessionStateDir } = sessionDirs(resolvedConfig, ctx.sessionId);
      const graphEmpty = !graphLooksNonempty(sessionStateDir);
      let messages = args.messages ?? [];
      if (graphEmpty && messages.length === 0 && options.hooks?.readSessionTranscriptVisibleMessageDelta) {
        messages = await options.hooks.readSessionTranscriptVisibleMessageDelta();
      }
      if (graphEmpty && messages.length > 0) {
        await ingestBatch(ctx, messages);
        logInfo("bootstrap recovery ingestBatch", {
          session: ctx.sessionId,
          n: messages.length,
        });
        return { ok: true, recovered: true };
      }
      return { ok: true, recovered: false };
    },

    async ingest(args) {
      await ensureStarted();
      const ctx = makeCtx(args.sessionKey, args.agentId);
      const msg = args.message ?? args.messages?.[0];
      if (!msg) return { ingested: false, skipped: "empty" };
      return ingestMsg(ctx, msg, args.index ?? 0);
    },

    async ingestBatch(args) {
      await ensureStarted();
      const ctx = makeCtx(args.sessionKey, args.agentId);
      return ingestBatch(ctx, args.messages ?? []);
    },

    async assemble(args) {
      await ensureStarted();
      const ctx = makeCtx(args.sessionKey, args.agentId as string | undefined);
      const assembleArgs: AssembleArgs = {
        ...args,
        buildMemorySystemPromptAddition:
          args.buildMemorySystemPromptAddition ??
          options.hooks?.buildMemorySystemPromptAddition,
      };
      return assembleFn(ctx, assembleArgs);
    },

    async compact(args = {}) {
      await ensureStarted();
      const sessionKey =
        args.sessionKey ??
        (args.runtimeContext && typeof args.runtimeContext === "object"
          ? String((args.runtimeContext as { sessionKey?: string }).sessionKey ?? "unknown")
          : "unknown");
      const ctxIds = makeCtx(sessionKey);
      const { sessionStateDir } = sessionDirs(resolvedConfig, ctxIds.sessionId);
      mkdirSync(sessionStateDir, { recursive: true });

      const compactArgs: CompactArgs = {
        ...args,
        runtimeContext: {
          ...args.runtimeContext,
          rewriteTranscriptEntries:
            args.runtimeContext?.rewriteTranscriptEntries ??
            options.hooks?.rewriteTranscriptEntries,
        },
      };

      return compactFn(
        {
          config: resolvedConfig,
          packer: packer!,
          agentId: ctxIds.agentId,
          sessionId: ctxIds.sessionId,
          sessionStateDir,
          graphNonempty:
            options.hooks?.graphNonempty ??
            (() => graphLooksNonempty(sessionStateDir)),
          tracker: getTracker(ctxIds.sessionId),
          packerImpl,
        },
        compactArgs,
      ).then(async (result) => {
        invalidatePackCache(ctxIds.sessionId);
        if (resolvedConfig.promoteMemoryNotes && result.entryText) {
          // Writer only — workspace from runtimeContext.stateDir if provided.
          const ws =
            typeof compactArgs.runtimeContext?.stateDir === "string"
              ? compactArgs.runtimeContext.stateDir
              : undefined;
          if (ws) {
            appendMemoryNotes({
              workspaceRoot: ws,
              session: ctxIds.sessionId,
              entryText: result.entryText,
            });
          }
        }
        return result;
      });
    },

    async commitTurn(args) {
      const ctx = makeCtx(args.sessionKey, args.agentId);
      return commitTurnFn(ctx.meta, ctx.sessionId, args);
    },

    async afterTurn(args = {}) {
      const ctx = makeCtx(args.sessionKey, args.agentId);
      writeStageLog(ctx.sessionId, {
        stage: "afterTurn",
        session: ctx.sessionId,
        t: args.t ?? null,
        packed_tokens: args.packed_tokens ?? null,
        method: args.method ?? null,
        latency_ms: args.latencyMs ?? null,
        ts: new Date().toISOString(),
      });
      return { ok: true };
    },

    async dispose() {
      for (const store of metaCache.values()) {
        store.close();
      }
      metaCache.clear();
      options.meta?.close();
      for (const t of trackerCache.values()) {
        t.close();
      }
      trackerCache.clear();
      options.tracker?.close();
      await packer!.dispose();
      started = false;
    },

    telemetryDropped() {
      let n = options.tracker?.telemetryDropped ?? 0;
      for (const t of trackerCache.values()) n += t.telemetryDropped;
      return n;
    },

    async prepareSubagentSpawn(args = {}) {
      return prepareSubagentSpawn(resolvedConfig, args);
    },

    async onSubagentEnded(args = {}) {
      return onSubagentEnded(resolvedConfig, args);
    },

    graphRootFor(sessionKey, agentId) {
      return graphRoot(sessionKey, agentId, resolvedConfig.shareGraphByAgent);
    },
  };

  return host;
}
