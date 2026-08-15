/**
 * PackerPort — strategy interface for SidecarPacker vs TsPacker (Plan 06).
 * Sample fields include optional Plan 07 telemetry counts (null when unknown).
 */

import { expandStateDir, type CompressorConfig } from "./config.ts";
import { SidecarClient } from "./sidecar/client.ts";
import { PersistentAgentHandle } from "./ts-engine/handle.ts";
import { StateStore } from "./ts-engine/store.ts";

export type PackerSampleResult = {
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

/** Injectable packer surface (SidecarClient or TsPacker or test mock). */
export type EnginePacker = {
  start?: () => Promise<void>;
  step: (
    agentId: string,
    params: { role: string; text: string; flush_graph?: boolean },
  ) => Promise<Record<string, unknown>>;
  sample: (
    agentId: string,
    params: { query: string; budget?: number; span_k?: number },
  ) => Promise<PackerSampleResult>;
  flush: (
    agentId: string,
    params?: { reason?: string },
  ) => Promise<Record<string, unknown>>;
  dispose: () => Promise<void>;
};

export type PackerHealthResult = {
  ok: boolean;
  impl: "sidecar" | "ts";
  python: string | null;
  graph_path?: string | null;
  error?: string;
};

export type PackerPort = EnginePacker & {
  expandSpans?: (
    agentId: string,
    params: { query: string; k: number },
  ) => Promise<string[]>;
  health: () => Promise<PackerHealthResult>;
};

function numOrUndef(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
function numOrNull(v: unknown): number | null | undefined {
  if (v === null) return null;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return undefined;
}

export function wrapSidecarAsPacker(client: SidecarClient): PackerPort {
  return {
    start: () => client.start(),
    async step(agentId, params) {
      return client.call("step", agentId, params);
    },
    async sample(agentId, params) {
      const result = await client.call("sample", agentId, params);
      return {
        text: typeof result.text === "string" ? result.text : "",
        packed_tokens: Number(result.packed_tokens ?? 0),
        method: typeof result.method === "string" ? result.method : "query-pack",
        k: numOrUndef(result.k),
        k_max: numOrUndef(result.k_max),
        t: numOrUndef(result.t),
        duration_ms: numOrUndef(result.duration_ms),
        rpc_latency_ms:
          numOrUndef(result.rpc_latency_ms) ?? numOrUndef(result.duration_ms),
        hot_set_tokens: numOrNull(result.hot_set_tokens),
        typed_lines_tokens: numOrNull(result.typed_lines_tokens),
        ranked_span_tokens: numOrNull(result.ranked_span_tokens),
        matrix_rows_k: numOrNull(result.matrix_rows_k) ?? numOrUndef(result.k),
        matrix_max_slots:
          numOrNull(result.matrix_max_slots) ?? numOrUndef(result.k_max),
        graph_active_nodes: numOrNull(result.graph_active_nodes),
        graph_pruned_nodes: numOrNull(result.graph_pruned_nodes),
      };
    },
    async flush(agentId, params) {
      return client.call("flush", agentId, params ?? {});
    },
    async health() {
      try {
        if (!client.ready) await client.start();
        const h = await client.call("health", undefined, {});
        return {
          ok: Boolean(h.ok),
          impl: "sidecar" as const,
          python: "sidecar",
        };
      } catch (err) {
        return {
          ok: false,
          impl: "sidecar",
          python: null,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
    dispose: () => client.dispose(),
  };
}

/** In-process TypeScript packer — no child process. */
export class TsPacker implements PackerPort {
  private config: CompressorConfig;
  private readonly root: string;
  private store: StateStore;
  private handles = new Map<string, PersistentAgentHandle>();
  private disposed = false;

  constructor(config: CompressorConfig) {
    this.config = config;
    this.root = expandStateDir(config.stateDir);
    this.store = new StateStore(this.root);
  }

  /** Hot-swap knobs without wiping graphs (Plan 10). */
  applyConfig(config: CompressorConfig): void {
    this.config = config;
    for (const h of this.handles.values()) {
      h.applyConfig(config);
    }
  }

  private handleFor(agentId: string): PersistentAgentHandle {
    if (this.disposed) throw new Error("TsPacker disposed");
    let h = this.handles.get(agentId);
    if (!h) {
      h = new PersistentAgentHandle({
        agentId,
        store: this.store,
        config: this.config,
      });
      this.handles.set(agentId, h);
    }
    return h;
  }

  async step(agentId: string, params: { role: string; text: string; flush_graph?: boolean }) {
    return { ...this.handleFor(agentId).step(params) };
  }

  async sample(
    agentId: string,
    params: { query: string; budget?: number; span_k?: number },
  ): Promise<PackerSampleResult> {
    const h = this.handleFor(agentId);
    const out = h.sample(params);
    return {
      text: out.text,
      packed_tokens: out.packed_tokens,
      method: out.method,
      k: out.k,
      k_max: out.k_max,
      t: out.t,
      duration_ms: out.duration_ms,
      rpc_latency_ms: out.duration_ms,
      hot_set_tokens: out.tau_hot ?? null,
      typed_lines_tokens: out.tau_typed ?? null,
      ranked_span_tokens: (out.tau_ranked ?? 0) + (out.tau_spans ?? 0),
      matrix_rows_k: out.k,
      matrix_max_slots: out.k_max,
      graph_active_nodes: h.graph.activeNodes().length,
      graph_pruned_nodes: h.graph.nodes.filter((n) => n.status === "pruned").length,
    };
  }

  async flush(agentId: string, _params?: { reason?: string }) {
    const path = this.handleFor(agentId).flushGraph();
    return { ok: true, graph_path: path };
  }

  async expandSpans(agentId: string, params: { query: string; k: number }) {
    return this.handleFor(agentId).expandSpans(params.query, params.k);
  }

  async health(): Promise<PackerHealthResult> {
    return { ok: true, impl: "ts", python: null, graph_path: null };
  }

  async dispose(): Promise<void> {
    this.handles.clear();
    try {
      this.store.close();
    } catch {
      /* ignore */
    }
    this.disposed = true;
  }
}

export function createPacker(config: CompressorConfig): PackerPort {
  if (config.engineImpl === "ts") return new TsPacker(config);
  if (config.engineImpl === "sidecar") {
    return wrapSidecarAsPacker(new SidecarClient({ config }));
  }
  throw new Error(`unknown engineImpl: ${String((config as { engineImpl?: string }).engineImpl)}`);
}

export function asEnginePacker(port: PackerPort): EnginePacker {
  return {
    start: port.start ? () => port.start!() : undefined,
    step: (agentId, params) => port.step(agentId, params),
    sample: (agentId, params) => port.sample(agentId, params),
    flush: (agentId, params) => port.flush(agentId, params),
    dispose: () => port.dispose(),
  };
}
