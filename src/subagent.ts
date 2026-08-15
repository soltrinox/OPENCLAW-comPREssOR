/**
 * Subagent HOT_SET fork (Plan 10).
 * prepareSubagentSpawn: copy parent HOT_SET + identifier vault only (not transcript).
 * onSubagentEnded: ingest child OpenItems into parent with derived_from.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expandStateDir, type CompressorConfig } from "./config.ts";
import { graphRoot } from "./ids.ts";
import { logInfo, logWarn } from "./log.ts";
import { CtxGraph, newId, type GraphNode } from "./ts-engine/graph.ts";

export type SubagentSpawnArgs = {
  parentSessionKey?: string;
  parentAgentId?: string;
  childSessionKey?: string;
  childAgentId?: string;
  skip?: boolean;
  isolated?: boolean;
  lightContext?: boolean;
};

export type SubagentEndedArgs = {
  parentSessionKey?: string;
  parentAgentId?: string;
  childSessionKey?: string;
  childAgentId?: string;
};

export type SubagentForkResult = {
  ok: true;
  skipped?: boolean;
  reason?: string;
  childSessionId?: string;
  parentSessionId?: string;
  copiedLines?: number;
  derivedCount?: number;
  parentKDelta?: number;
};

function sessionDir(config: CompressorConfig, sessionId: string): string {
  return join(expandStateDir(config.stateDir), sessionId);
}

function graphPath(dir: string): string {
  return join(dir, "graph.json");
}

function loadGraph(path: string): CtxGraph | null {
  if (!existsSync(path)) return null;
  try {
    return CtxGraph.tryLoad(path);
  } catch {
    return null;
  }
}

/** Extract HOT_SET lines + identifier facts from parent graph (no transcript). */
export function extractHotSetBootstrap(parent: CtxGraph): {
  lines: string[];
  identifiers: string[];
  openItems: Array<{ label: string; summary: string }>;
} {
  const hot = parent.hotSet(null);
  const lines = hot
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const identifiers: string[] = [];
  const openItems: Array<{ label: string; summary: string }> = [];
  for (const n of parent.activeNodes()) {
    if (n.kind === "OpenItem" && (n.attrs.state ?? "open") !== "done") {
      openItems.push({
        label: (n.label || "").trim(),
        summary: (n.summary || n.label || "").trim(),
      });
    }
    if (n.kind === "Fact" && String(n.attrs.kind_hint || "") === "identifier") {
      identifiers.push((n.summary || n.label || "").trim());
    }
  }
  return { lines, identifiers, openItems };
}

/**
 * Write child bootstrap graph from parent HOT_SET + identifiers only.
 * Child t=0, C_t empty (no transcript copy). Direct node insert — no 20k dump.
 */
export function writeChildBootstrapGraph(
  childDir: string,
  bootstrap: ReturnType<typeof extractHotSetBootstrap>,
): { copiedLines: number } {
  mkdirSync(childDir, { recursive: true });
  const child = new CtxGraph();
  const stamp = new Date().toISOString();
  let copied = 0;
  for (const item of bootstrap.openItems) {
    if (!item.label && !item.summary) continue;
    const node: GraphNode = {
      id: newId("item"),
      kind: "OpenItem",
      label: (item.label || item.summary).slice(0, 80),
      summary: item.summary || item.label,
      status: "active",
      valid_start: stamp,
      valid_end: null,
      attrs: { state: "open", forked: true },
    };
    child.insert(node);
    copied += 1;
  }
  for (const id of bootstrap.identifiers) {
    if (!id) continue;
    const node: GraphNode = {
      id: newId("fact"),
      kind: "Fact",
      label: id.slice(0, 80),
      summary: id.startsWith("identifier:") ? id : `identifier: ${id}`,
      status: "active",
      valid_start: stamp,
      valid_end: null,
      attrs: { kind_hint: "identifier", durable: true, forked: true },
    };
    child.insert(node);
    copied += 1;
  }
  for (const line of bootstrap.lines) {
    if (!/Path|Decision|Fact /i.test(line)) continue;
    const node: GraphNode = {
      id: newId("fact"),
      kind: "Fact",
      label: line.slice(0, 80),
      summary: line.slice(0, 200),
      status: "active",
      valid_start: stamp,
      valid_end: null,
      attrs: { forked: true },
    };
    child.insert(node);
    copied += 1;
  }
  child.save(graphPath(childDir));
  writeFileSync(
    join(childDir, "subagent-bootstrap.json"),
    JSON.stringify(
      {
        source: "hot_set_fork",
        openItems: bootstrap.openItems.length,
        identifiers: bootstrap.identifiers.length,
        lines: bootstrap.lines.length,
        no_transcript: true,
      },
      null,
      2,
    ),
  );
  return { copiedLines: copied };
}

export async function prepareSubagentSpawn(
  config: CompressorConfig,
  args: SubagentSpawnArgs,
): Promise<SubagentForkResult> {
  if (args.skip || (args.isolated && args.lightContext)) {
    return { ok: true, skipped: true, reason: "host_isolated_light" };
  }
  const parentId = graphRoot(
    args.parentSessionKey,
    args.parentAgentId,
    config.shareGraphByAgent,
  );
  const childId = graphRoot(
    args.childSessionKey ?? `${parentId}__child_${Date.now()}`,
    args.childAgentId,
    false,
  );
  const parentDir = sessionDir(config, parentId);
  const childDir = sessionDir(config, childId);
  const parentGraph = loadGraph(graphPath(parentDir));
  if (!parentGraph) {
    mkdirSync(childDir, { recursive: true });
    writeFileSync(
      graphPath(childDir),
      JSON.stringify({ schema: "ctx-graph-v1", nodes: [], edges: [] }) + "\n",
    );
    logInfo("subagent_fork empty_parent", { parent: parentId, child: childId });
    return { ok: true, parentSessionId: parentId, childSessionId: childId, copiedLines: 0 };
  }
  const bootstrap = extractHotSetBootstrap(parentGraph);
  const { copiedLines } = writeChildBootstrapGraph(childDir, bootstrap);
  logInfo("subagent_fork", {
    parent: parentId,
    child: childId,
    copiedLines,
    openItems: bootstrap.openItems.length,
  });
  return {
    ok: true,
    parentSessionId: parentId,
    childSessionId: childId,
    copiedLines,
  };
}

/**
 * Ingest child OpenItems into parent with derived_from relation.
 * Skip child tool dumps (only OpenItem summaries; bounded ≤8).
 */
export async function onSubagentEnded(
  config: CompressorConfig,
  args: SubagentEndedArgs,
): Promise<SubagentForkResult> {
  const parentId = graphRoot(
    args.parentSessionKey,
    args.parentAgentId,
    config.shareGraphByAgent,
  );
  const childId = graphRoot(args.childSessionKey, args.childAgentId, false);
  const parentDir = sessionDir(config, parentId);
  const childDir = sessionDir(config, childId);
  const parentGraph = loadGraph(graphPath(parentDir));
  const childGraph = loadGraph(graphPath(childDir));
  if (!parentGraph || !childGraph) {
    return { ok: true, parentSessionId: parentId, childSessionId: childId, derivedCount: 0 };
  }
  const kBefore = parentGraph.activeNodes().length;
  const stamp = new Date().toISOString();
  let derivedCount = 0;
  for (const n of childGraph.activeNodes()) {
    if (n.kind !== "OpenItem" || (n.attrs.state ?? "open") === "done") continue;
    const label = (n.summary || n.label || "").trim();
    if (!label || label.length >= 2000) continue;
    if (derivedCount >= 8) break;
    const node: GraphNode = {
      id: newId("item"),
      kind: "OpenItem",
      label: (n.label || label).slice(0, 80),
      summary: `${label} (derived_from child)`,
      status: "active",
      valid_start: stamp,
      valid_end: null,
      attrs: { state: "open", derived_from: childId },
    };
    parentGraph.insert(node);
    derivedCount += 1;
  }
  if (derivedCount > 0) {
    parentGraph.save(graphPath(parentDir));
  }
  const kAfter = parentGraph.activeNodes().length;
  const parentKDelta = kAfter - kBefore;
  logInfo("subagent_end", {
    parent: parentId,
    child: childId,
    derivedCount,
    parentKDelta,
  });
  if (parentKDelta > 8) {
    logWarn("subagent_end k delta high", { parentKDelta });
  }
  return {
    ok: true,
    parentSessionId: parentId,
    childSessionId: childId,
    derivedCount,
    parentKDelta,
  };
}
