/**
 * State store — graph.json + spans + inject history + optional matrix meta.
 * matrixOptional: true — no safetensors required (Plan 06 D6.1).
 */

import { DatabaseSync } from "node:sqlite";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { FloatMatrix } from "./compress.ts";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS agents (
    agent_id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    producer TEXT NOT NULL,
    d INTEGER NOT NULL,
    k_max INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS states (
    state_id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    parent_id TEXT,
    t INTEGER NOT NULL,
    blob_path TEXT NOT NULL,
    k INTEGER NOT NULL,
    d INTEGER NOT NULL,
    producer TEXT NOT NULL,
    graph_path TEXT,
    created_at TEXT NOT NULL,
    meta_json TEXT
);
CREATE INDEX IF NOT EXISTS lineage ON states (agent_id, t);
`;

const INJECT_HISTORY_NAME = "inject_history.json";
const INJECT_HISTORY_KEEP = 32;

function nowIso(): string {
  return new Date().toISOString();
}

function newStateId(): string {
  return `st_${randomUUID().replace(/-/g, "")}`;
}

export type StateNode = {
  state_id: string;
  agent_id: string;
  t: number;
  C: FloatMatrix;
  M: Float32Array;
  producer: string;
  d: number;
  k: number;
  parent_id: string | null;
  blob_path: string;
  graph_path: string | null;
  created_at: string;
  meta: Record<string, unknown>;
  matrixOptional: true;
};

export class StateStore {
  readonly root: string;
  readonly dbPath: string;
  private db: DatabaseSync;

  constructor(root: string) {
    this.root = root;
    mkdirSync(root, { recursive: true });
    this.dbPath = join(root, "meta.sqlite");
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(SCHEMA_SQL);
  }

  ensureAgent(agentId: string, producer: string, d: number, kMax: number): void {
    const row = this.db
      .prepare("SELECT agent_id FROM agents WHERE agent_id = ?")
      .get(agentId) as { agent_id?: string } | undefined;
    if (!row?.agent_id) {
      this.db
        .prepare(
          "INSERT INTO agents (agent_id, created_at, producer, d, k_max) VALUES (?, ?, ?, ?, ?)",
        )
        .run(agentId, nowIso(), producer, d, kMax);
    }
  }

  save(args: {
    agentId: string;
    C: FloatMatrix;
    M?: Float32Array | null;
    parent?: StateNode | null;
    producer?: string;
    graphPath?: string | null;
    meta?: Record<string, unknown>;
    kMax?: number;
  }): StateNode {
    const arr = args.C;
    const k = arr.length;
    const d = k ? arr[0]!.length : 0;
    const mask = args.M ?? Float32Array.from({ length: k }, () => 1);
    const t = args.parent ? args.parent.t + 1 : 1;
    const parentId = args.parent?.state_id ?? null;
    const stateId = newStateId();
    const created = nowIso();
    const agentDir = join(this.root, args.agentId);
    mkdirSync(agentDir, { recursive: true });
    // Optional matrix: persist rows as JSON .bin companion (no safetensors).
    const blobPath = join(agentDir, `t${String(t).padStart(4, "0")}.matrix.json`);
    writeFileSync(
      blobPath,
      JSON.stringify({
        C: arr.map((r) => Array.from(r)),
        M: Array.from(mask),
        matrixOptional: true,
      }) + "\n",
      "utf8",
    );
    const producer = args.producer ?? "embed";
    this.ensureAgent(args.agentId, producer, d, args.kMax ?? 64);
    this.db
      .prepare(
        `INSERT INTO states (state_id, agent_id, parent_id, t, blob_path, k, d, producer, graph_path, created_at, meta_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        stateId,
        args.agentId,
        parentId,
        t,
        blobPath,
        k,
        d,
        producer,
        args.graphPath ?? null,
        created,
        JSON.stringify(args.meta ?? {}),
      );
    return this.load(stateId);
  }

  load(stateId: string): StateNode {
    const row = this.db
      .prepare("SELECT * FROM states WHERE state_id = ?")
      .get(stateId) as Record<string, unknown> | undefined;
    if (!row) throw new Error(`unknown state_id ${stateId}`);
    return this.rowToNode(row);
  }

  loadLatest(agentId: string): StateNode | null {
    const row = this.db
      .prepare("SELECT * FROM states WHERE agent_id = ? ORDER BY t DESC LIMIT 1")
      .get(agentId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.rowToNode(row);
  }

  private rowToNode(row: Record<string, unknown>): StateNode {
    const blob = String(row.blob_path);
    let C: FloatMatrix = [];
    let M = new Float32Array(0);
    if (existsSync(blob)) {
      try {
        const raw = JSON.parse(readFileSync(blob, "utf8")) as {
          C?: number[][];
          M?: number[];
        };
        C = (raw.C || []).map((r) => Float32Array.from(r));
        M = Float32Array.from(raw.M || []);
      } catch {
        /* empty matrix ok when optional */
      }
    }
    return {
      state_id: String(row.state_id),
      agent_id: String(row.agent_id),
      t: Number(row.t),
      C,
      M,
      producer: String(row.producer),
      d: Number(row.d),
      k: Number(row.k),
      parent_id: (row.parent_id as string | null) ?? null,
      blob_path: blob,
      graph_path: (row.graph_path as string | null) ?? null,
      created_at: String(row.created_at),
      meta: row.meta_json ? JSON.parse(String(row.meta_json)) : {},
      matrixOptional: true,
    };
  }

  close(): void {
    this.db.close();
  }
}

export function injectHistoryPath(agentDir: string): string {
  return join(agentDir, INJECT_HISTORY_NAME);
}

export function loadInjectHistory(agentDir: string): Array<Record<string, unknown>> {
  const path = injectHistoryPath(agentDir);
  if (!existsSync(path)) return [];
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    if (raw && typeof raw === "object" && Array.isArray(raw.turns)) return raw.turns;
    if (Array.isArray(raw)) return raw;
  } catch {
    /* ignore */
  }
  return [];
}

export function saveInjectHistory(
  agentDir: string,
  turns: Array<Record<string, unknown>>,
): string {
  mkdirSync(agentDir, { recursive: true });
  const dest = injectHistoryPath(agentDir);
  const kept = turns.slice(-INJECT_HISTORY_KEEP);
  writeFileSync(dest, JSON.stringify({ turns: kept }, null, 2) + "\n", "utf8");
  return dest;
}

export function appendInjectHistory(
  agentDir: string,
  row: Record<string, unknown>,
): Array<Record<string, unknown>> {
  const turns = loadInjectHistory(agentDir);
  turns.push(row);
  saveInjectHistory(agentDir, turns);
  return turns;
}

export function recentLineHashes(
  history: Array<Record<string, unknown>>,
  k = 3,
): Set<string> {
  const out = new Set<string>();
  for (const row of history.slice(-Math.max(1, k))) {
    const hashes = row.hashes;
    if (!Array.isArray(hashes)) continue;
    for (const item of hashes) if (item) out.add(String(item));
  }
  return out;
}

export function rollingNovelty(
  history: Array<Record<string, unknown>>,
  k = 3,
): number {
  let packed = 0;
  let novel = 0;
  for (const row of history.slice(-Math.max(1, k))) {
    packed += Number(row.packed_tokens || 0);
    novel += Number(row.novel_tokens || 0);
  }
  if (packed <= 0) return 1.0;
  return Math.max(0, Math.min(1, novel / packed));
}

export function writeSpanSidecar(
  blobPath: string,
  spans: Array<Record<string, unknown>>,
): string {
  // tNNNN.matrix.json -> tNNNN.spans.json OR beside any blob
  const dest = blobPath.replace(/\.matrix\.json$/, ".spans.json").replace(
    /\.safetensors$/,
    ".spans.json",
  );
  const finalDest = dest.endsWith(".spans.json")
    ? dest
    : blobPath.replace(/\.[^.]+$/, "") + ".spans.json";
  mkdirSync(dirname(finalDest), { recursive: true });
  writeFileSync(finalDest, JSON.stringify(spans, null, 2) + "\n", "utf8");
  return finalDest;
}

export function listSpanTexts(agentDir: string): string[] {
  if (!existsSync(agentDir)) return [];
  const texts: string[] = [];
  for (const name of readdirSync(agentDir).sort()) {
    if (!/^t\d+\.spans\.json$/.test(name)) continue;
    try {
      const raw = JSON.parse(readFileSync(join(agentDir, name), "utf8"));
      if (!Array.isArray(raw)) continue;
      for (const item of raw) {
        if (item && typeof item === "object" && String(item.text || "").trim()) {
          texts.push(String(item.text).trim());
        }
      }
    } catch {
      /* skip */
    }
  }
  return texts;
}
