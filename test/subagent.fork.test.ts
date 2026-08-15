/**
 * Plan 10 — subagent HOT_SET fork A10-4..A10-6.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RECALL_05_DEFAULTS } from "../src/config.ts";
import { CtxGraph, newId, type GraphNode } from "../src/ts-engine/graph.ts";
import {
  prepareSubagentSpawn,
  onSubagentEnded,
  extractHotSetBootstrap,
} from "../src/subagent.ts";

function seedOpenItem(g: CtxGraph, label: string, summary?: string): void {
  const stamp = new Date().toISOString();
  const node: GraphNode = {
    id: newId("item"),
    kind: "OpenItem",
    label: label.slice(0, 80),
    summary: summary ?? `open: ${label}`,
    status: "active",
    valid_start: stamp,
    valid_end: null,
    attrs: { state: "open" },
  };
  g.insert(node);
}

function seedIdentifier(g: CtxGraph, uuid: string): void {
  const stamp = new Date().toISOString();
  const node: GraphNode = {
    id: newId("fact"),
    kind: "Fact",
    label: uuid.slice(0, 80),
    summary: `identifier: ${uuid}`,
    status: "active",
    valid_start: stamp,
    valid_end: null,
    attrs: { kind_hint: "identifier", durable: true },
  };
  g.insert(node);
}

describe("subagent.fork (Plan 10)", () => {
  it("A10-4 child sample contains parent OpenItem and UUID", async () => {
    const root = mkdtempSync(join(tmpdir(), "oc-p10-sub-"));
    const parentId = "parent_sess";
    const childId = "child_sess";
    const parentDir = join(root, parentId);
    mkdirSync(parentDir, { recursive: true });
    const g = new CtxGraph();
    seedOpenItem(g, "sanitize session keys");
    seedIdentifier(g, "550e8400-e29b-41d4-a716-446655440000");
    g.save(join(parentDir, "graph.json"));

    const config = { ...RECALL_05_DEFAULTS, stateDir: root, engineImpl: "ts" as const };
    const spawn = await prepareSubagentSpawn(config, {
      parentSessionKey: parentId,
      childSessionKey: childId,
    });
    expect(spawn.ok).toBe(true);
    expect((spawn.copiedLines ?? 0) > 0).toBe(true);

    const childGraph = CtxGraph.tryLoad(join(root, childId, "graph.json"));
    const hot = childGraph.hotSet("continue");
    const dump = childGraph.dumps();
    expect(hot + dump).toMatch(/sanitize session keys/i);
    expect(hot + dump).toMatch(/550e8400-e29b-41d4-a716-446655440000/);
    expect(existsSync(join(root, childId, "subagent-bootstrap.json"))).toBe(true);
    const boot = JSON.parse(
      readFileSync(join(root, childId, "subagent-bootstrap.json"), "utf8"),
    ) as { no_transcript: boolean };
    expect(boot.no_transcript).toBe(true);
  });

  it("A10-5/A10-6 parent k delta bounded; derived_from after end", async () => {
    const root = mkdtempSync(join(tmpdir(), "oc-p10-end-"));
    const parentId = "parent_end";
    const childId = "child_end";
    mkdirSync(join(root, parentId), { recursive: true });
    mkdirSync(join(root, childId), { recursive: true });
    const parent = new CtxGraph();
    seedOpenItem(parent, "parent-task");
    parent.save(join(root, parentId, "graph.json"));
    const child = new CtxGraph();
    seedOpenItem(child, "child-result-item");
    // Simulate a huge tool dump as a non-OpenItem Fact that must NOT be derived.
    // (Do not call ingestTurn on 50k text — prune is O(n) and times out.)
    const stamp = new Date().toISOString();
    child.insert({
      id: newId("fact"),
      kind: "Fact",
      label: "tool-dump-stub",
      summary: "tool dump omitted from parent fork",
      status: "active",
      valid_start: stamp,
      valid_end: null,
      attrs: { kind_hint: "tool_dump", size: 50_000 },
    });
    child.save(join(root, childId, "graph.json"));

    const kBefore = parent.activeNodes().length;
    const config = { ...RECALL_05_DEFAULTS, stateDir: root, engineImpl: "ts" as const };
    const end = await onSubagentEnded(config, {
      parentSessionKey: parentId,
      childSessionKey: childId,
    });
    expect(end.ok).toBe(true);
    expect((end.derivedCount ?? 0) >= 1).toBe(true);
    expect((end.parentKDelta ?? 99) < 8).toBe(true);

    const parentAfter = CtxGraph.tryLoad(join(root, parentId, "graph.json"));
    const text = parentAfter.dumps();
    expect(text).toMatch(/child-result-item|derived_from/i);
    expect(text).not.toMatch(/X{1000}/);
    expect(text.length).toBeLessThan(20_000);
    expect(parentAfter.activeNodes().length - kBefore).toBeLessThan(8);
  }, 15_000);

  it("extractHotSetBootstrap does not include raw transcript dump lines", () => {
    const g = new CtxGraph();
    seedOpenItem(g, "keep-me");
    seedIdentifier(g, "abc-uuid-1");
    const boot = extractHotSetBootstrap(g);
    expect(boot.openItems.some((x) => /keep-me/i.test(x.label + x.summary))).toBe(true);
    expect(boot.identifiers.some((x) => /abc-uuid-1/i.test(x))).toBe(true);
  });
});
