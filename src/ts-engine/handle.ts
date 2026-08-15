/**
 * PersistentAgentHandle — TS port of handle.py (matrix optional).
 * injectP1 is never applied on the default path.
 */

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { chunkText } from "./chunks.ts";
import { EmbeddingProducer, chunksPerTurn } from "./embed.ts";
import { CtxGraph, hotSetMaxChars } from "./graph.ts";
import {
  WARMUP_TURNS,
  adaptiveBudget,
  crossTurnDedupEnabled,
  forwardBudget,
  packForward,
} from "./pack.ts";
import { collectCandidates, rankChunks, rankRelevantChunks } from "./rank.ts";
import {
  StateStore,
  appendInjectHistory,
  listSpanTexts,
  loadInjectHistory,
  recentLineHashes,
  rollingNovelty,
  writeSpanSidecar,
  type StateNode,
} from "./store.ts";
import type { CompressorConfig } from "../config.ts";

export type SampleResult = {
  text: string;
  packed_tokens: number;
  method: string;
  k: number;
  k_max: number;
  t: number;
  duration_ms: number;
  tau_hot?: number;
  tau_typed?: number;
  tau_ranked?: number;
  tau_spans?: number;
  matrixOptional: true;
};

export type StepResult = {
  state_id: string;
  t: number;
  parent_id: string | null;
  graph_path: string | null;
  compress_ms: number;
  persist_ms: number;
  graph_flushed: boolean;
  k: number;
  k_max: number;
};

function graphFlushEvery(): number {
  const raw = (process.env.GRAPH_FLUSH_EVERY || "").trim();
  if (!raw) return 5;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 1 ? n : 5;
}

export class PersistentAgentHandle {
  agentId: string;
  store: StateStore;
  producer: EmbeddingProducer;
  graph: CtxGraph;
  kMax: number;
  config: CompressorConfig;
  private turnIndex = 0;
  private lastGraphPath: string | null = null;
  lastSampleMs = 0;

  constructor(opts: {
    agentId: string;
    store: StateStore;
    config: CompressorConfig;
    graph?: CtxGraph;
    producer?: EmbeddingProducer;
  }) {
    this.agentId = opts.agentId;
    this.store = opts.store;
    this.config = opts.config;
    this.kMax = opts.config.kMax;
    this.producer =
      opts.producer ??
      new EmbeddingProducer({
        kMax: opts.config.kMax,
        ema: opts.config.poolEma,
        d: 256,
      });
    const latest = join(this.agentDir(), "graph.json");
    this.graph = opts.graph ?? CtxGraph.tryLoad(latest);
  }

  /** Plan 10 profile hot-swap: update knobs; shrink kMax without wiping graph.json. */
  applyConfig(config: CompressorConfig): void {
    const prevK = this.kMax;
    this.config = config;
    this.kMax = config.kMax;
    this.producer.kMax = config.kMax;
    this.producer.ema = config.poolEma;
    // Force matrix pool on next step when kMax shrinks; graph OpenItems stay.
    if (config.kMax < prevK) {
      // Evict unprotected matrix rows via empty compress cycle if live node exists.
      const prev = this.latest();
      if (prev?.C) {
        const result = this.producer.compress(prev.C, "");
        this.store.save({
          agentId: this.agentId,
          C: result.C,
          M: result.M,
          parent: prev,
          producer: result.producer,
          graphPath: this.lastGraphPath ?? this.latestGraphPath(),
          meta: { tool_status: "stub", tokenizer_id: "hashed-ngram", matrixOptional: true },
          kMax: this.kMax,
        });
      }
    }
  }

  private agentDir(): string {
    return join(this.store.root, this.agentId);
  }

  private latestGraphPath(): string {
    return join(this.agentDir(), "graph.json");
  }

  step(args: {
    text: string;
    role?: string;
    flush_graph?: boolean;
  }): StepResult {
    const prev = this.store.loadLatest(this.agentId);
    const tNext = prev ? prev.t + 1 : 1;
    const t0 = performance.now();
    // Optional matrix path: still run pool for k/kMax dashboard, but pack does not need it.
    const result = this.producer.compress(prev?.C ?? null, args.text);
    const compressMs = performance.now() - t0;

    this.graph.ingestTurn(args.role ?? "user", args.text, this.turnIndex);
    this.turnIndex += 1;

    const every = graphFlushEvery();
    const versioned =
      args.flush_graph !== undefined ? args.flush_graph : tNext % every === 0;

    mkdirSync(this.agentDir(), { recursive: true });
    const latest = this.latestGraphPath();
    this.graph.save(latest);
    this.lastGraphPath = latest;
    let graphPath = latest;
    if (versioned) {
      const snap = join(this.agentDir(), `graph_t${tNext}.json`);
      this.graph.save(snap);
      graphPath = snap;
      this.lastGraphPath = snap;
    }

    const t1 = performance.now();
    const node = this.store.save({
      agentId: this.agentId,
      C: result.C,
      M: result.M,
      parent: prev,
      producer: result.producer,
      graphPath,
      meta: { tool_status: "stub", tokenizer_id: "hashed-ngram", matrixOptional: true },
      kMax: this.kMax,
    });
    const persistMs = performance.now() - t1;
    const spans = chunkText(args.text, chunksPerTurn(this.config.chunksPerTurn))
      .filter((c) => (c || "").trim())
      .map((c, i) => ({ text: c, row: i }));
    writeSpanSidecar(node.blob_path, spans);

    return {
      state_id: node.state_id,
      t: node.t,
      parent_id: node.parent_id,
      graph_path: node.graph_path,
      compress_ms: compressMs,
      persist_ms: persistMs,
      graph_flushed: Boolean(versioned),
      k: node.k,
      k_max: this.kMax,
    };
  }

  latest(): StateNode | null {
    return this.store.loadLatest(this.agentId);
  }

  flushGraph(): string | null {
    const prev = this.latest();
    const t = prev?.t ?? Math.max(1, this.turnIndex);
    const latest = this.latestGraphPath();
    mkdirSync(this.agentDir(), { recursive: true });
    this.graph.save(latest);
    const snap = join(this.agentDir(), `graph_t${t}.json`);
    this.graph.save(snap);
    this.lastGraphPath = snap;
    return this.lastGraphPath;
  }

  sample(args: { query: string; budget?: number; span_k?: number }): SampleResult {
    const node = this.latest();
    const q = (args.query || "").trim() || this.lastUserQuery();
    const hotMax = this.config.hotSetMaxChars || hotSetMaxChars();
    const hot = this.graph.hotSet(q || null, hotMax);
    const typed = this.graph.typedProjection(q || null, { hot_set: hot });
    const history = loadInjectHistory(this.agentDir());
    const t = node?.t ?? 0;
    const novelty = rollingNovelty(history, 3);
    let budget = adaptiveBudget(
      t,
      novelty,
      args.budget ?? this.config.forwardBudget ?? forwardBudget(),
      this.config.noveltyBudgetFloor,
    );
    if (!crossTurnDedupEnabled()) {
      budget = args.budget ?? this.config.forwardBudget ?? forwardBudget();
    }
    const last = history.length ? history[history.length - 1]! : {};
    let openitemChanged = true;
    let nodeSuperseded = false;
    let recent = new Set<string>();
    if (crossTurnDedupEnabled() && history.length) {
      const prevSig = String(last.openitem_sig || "");
      openitemChanged = this.graph.openitemSignature() !== prevSig;
      nodeSuperseded = this.graph.supersedeCount() > Number(last.supersede_count || 0);
      recent = recentLineHashes(history, 3);
    }
    const allowSkip = crossTurnDedupEnabled() && t > WARMUP_TURNS;

    let rankedList: string[] = [];
    let spanList: string[] = [];
    if (q.trim()) {
      const cands = collectCandidates(this.graph, { query: q });
      rankedList = rankRelevantChunks(q, cands, {
        fallbackTopK: this.config.rankFallbackTopK,
      }).map((r) => r.text);
    }
    if (this.config.matrixSpanReadout && q.trim()) {
      spanList = this.expandSpans(q, args.span_k ?? this.config.matrixSpanK);
    }
    const rankedNorm = new Set(rankedList.map((x) => x.toLowerCase()));
    spanList = spanList.filter((s) => !rankedNorm.has(s.toLowerCase()));

    const t0 = performance.now();
    const packed = packForward({
      hot_set: hot,
      typed_lines: typed,
      ranked_chunks: rankedList,
      span_chunks: spanList,
      budget,
      recent_hashes: recent,
      openitem_changed: openitemChanged,
      node_superseded: nodeSuperseded,
      allow_skip: allowSkip,
    });

    // injectP1 deliberately omitted (Plan 06 / Plan 04 constitution).
    if (this.config.injectP1) {
      // Doctor warns; packer still does not emit vocab-bag-only packs.
    }

    if (packed.method !== "skip" && packed.line_hashes.length) {
      appendInjectHistory(this.agentDir(), {
        state_id: node?.state_id ?? null,
        t,
        hashes: packed.line_hashes,
        text: (packed.text || "").slice(0, 8000),
        openitem_sig: this.graph.openitemSignature(),
        supersede_count: this.graph.supersedeCount(),
        packed_tokens: packed.packed_tokens,
        novel_tokens: packed.novel_tokens,
        dup_suppressed_tokens: packed.dup_suppressed_tokens,
      });
    }

    this.lastSampleMs = performance.now() - t0;
    const k = node?.k ?? 0;
    return {
      text: packed.text,
      packed_tokens: packed.packed_tokens,
      method: packed.method,
      k,
      k_max: this.kMax,
      t,
      duration_ms: this.lastSampleMs,
      tau_hot: packed.tau_hot,
      tau_typed: packed.tau_typed,
      tau_ranked: packed.tau_ranked,
      tau_spans: packed.tau_spans,
      matrixOptional: true,
    };
  }

  expandSpans(query: string, k = 8): string[] {
    const texts = listSpanTexts(this.agentDir());
    const ranked = rankChunks(query, texts);
    const seen = new Set<string>();
    const out: string[] = [];
    for (const row of ranked) {
      const key = row.text.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(row.text);
      if (out.length >= Math.max(1, k)) break;
    }
    return out;
  }

  private lastUserQuery(): string {
    const turns = this.graph
      .activeNodes()
      .filter((n) => n.kind === "Turn" && (n.attrs || {}).role === "user");
    if (!turns.length) return "";
    turns.sort(
      (a, b) =>
        a.valid_start.localeCompare(b.valid_start) ||
        Number(a.attrs.index ?? 0) - Number(b.attrs.index ?? 0),
    );
    return (turns[turns.length - 1]!.summary || "").trim();
  }

  dispose(): void {
    // Store is owned by TsPacker; do not close shared StateStore here.
  }

  health(): { ok: true; impl: "ts"; python: null; graph_path: string | null } {
    const gp = this.latestGraphPath();
    return {
      ok: true,
      impl: "ts",
      python: null,
      graph_path: existsSync(gp) ? gp : this.lastGraphPath,
    };
  }
}
