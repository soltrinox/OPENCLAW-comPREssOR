/**
 * Plan 10 — manage profile / flush / compact / purge A10-7..A10-14.
 */
import { describe, expect, it, vi } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RECALL_05_DEFAULTS } from "../src/config.ts";
import { createEngineHost } from "../src/engine.ts";
import { MetaStore } from "../src/meta-store.ts";
import {
  switchProfile,
  forceFlush,
  triggerCompact,
  purgeSession,
} from "../src/manage.ts";
import { memoryFileExists } from "../src/memory-notes.ts";
import { appendMemoryNotes } from "../src/memory-notes.ts";
import { Tracker } from "../src/telemetry/tracker.ts";

function mockPacker(overrides: Record<string, unknown> = {}) {
  return {
    async step() {
      return { t: 1, k: 1, k_max: 64 };
    },
    async sample() {
      return {
        text: "HOT_SET:\nOpenItem sanitize\nFact identifier: 550e8400-e29b-41d4-a716-446655440000",
        packed_tokens: 40,
        method: "query-pack",
        k: 4,
        k_max: 64,
        t: 2,
        duration_ms: 1,
      };
    },
    async flush() {
      return { ok: true, reason: "manual_flush" };
    },
    async dispose() {},
    ...overrides,
  };
}

describe("manage.profile (Plan 10)", () => {
  it("A10-7/A10-8/A10-9 profile switch changes budget; graph preserved; UUID in sample", async () => {
    const root = mkdtempSync(join(tmpdir(), "oc-p10-prof-"));
    const session = "sess_prof";
    mkdirSync(join(root, session), { recursive: true });
    writeFileSync(join(root, session, "graph.json"), '{"schema":"ctx-graph-v1","nodes":[],"edges":[]}\n');

    const host = createEngineHost(
      { ...RECALL_05_DEFAULTS, stateDir: root, engineImpl: "ts", profile: "recall-0.5" },
      {
        packer: mockPacker(),
        meta: new MetaStore(":memory:"),
        autoStartSidecar: false,
      },
    );

    const r = switchProfile(host, { profile: "cursor-parity", session });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data?.forwardBudget).toBe(1024);
      expect(r.data?.kMax).toBe(32);
      expect(r.data?.graphPreserved).toBe(true);
    }
    expect(existsSync(join(root, session, "graph.json"))).toBe(true);
    expect(host.resolvedConfig.forwardBudget).toBe(1024);
    expect(host.resolvedConfig.profile).toBe("cursor-parity");

    const sample = await host.assemble({
      sessionKey: session,
      messages: [{ role: "user", text: "what about the uuid?" }],
      prompt: "continue",
    });
    expect(sample.systemPromptAddition).toMatch(/550e8400-e29b-41d4-a716-446655440000/);
    expect(host.resolvedConfig.forwardBudget).toBe(1024);
    await host.dispose();
  });

  it("A10-10 engineImpl change 400 restart_required", () => {
    const host = createEngineHost(
      { ...RECALL_05_DEFAULTS, engineImpl: "ts" },
      { packer: mockPacker(), meta: new MetaStore(":memory:"), autoStartSidecar: false },
    );
    const r = switchProfile(host, {
      profile: "recall-0.5",
      session: "s1",
      overlays: { engineImpl: "sidecar" },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.httpStatus).toBe(400);
      expect(r.code).toBe("restart_required");
    }
  });

  it("A10-11 purge without confirm 400, files remain", () => {
    const root = mkdtempSync(join(tmpdir(), "oc-p10-purge-"));
    const session = "sess_purge";
    mkdirSync(join(root, session), { recursive: true });
    const graph = join(root, session, "graph.json");
    writeFileSync(graph, "{}");
    const r = purgeSession(
      { ...RECALL_05_DEFAULTS, stateDir: root },
      { session, confirm: "wrong" },
    );
    expect(r.ok).toBe(false);
    expect(existsSync(graph)).toBe(true);
  });

  it("A10-12 purge confirm=session deletes dir", () => {
    const root = mkdtempSync(join(tmpdir(), "oc-p10-purge2-"));
    const session = "sess_purge2";
    mkdirSync(join(root, session), { recursive: true });
    writeFileSync(join(root, session, "graph.json"), "{}");
    const r = purgeSession(
      { ...RECALL_05_DEFAULTS, stateDir: root },
      { session, confirm: session },
    );
    expect(r.ok).toBe(true);
    expect(existsSync(join(root, session))).toBe(false);
  });

  it("A10-13 compact trigger LLM mock 0", async () => {
    const root = mkdtempSync(join(tmpdir(), "oc-p10-cmp-"));
    const session = "sess_cmp";
    mkdirSync(join(root, session), { recursive: true });
    writeFileSync(
      join(root, session, "graph.json"),
      JSON.stringify({ schema: "ctx-graph-v1", nodes: [{ id: "1" }], edges: [] }),
    );
    const host = createEngineHost(
      { ...RECALL_05_DEFAULTS, stateDir: root, engineImpl: "ts" },
      { packer: mockPacker(), meta: new MetaStore(":memory:"), autoStartSidecar: false },
    );
    const noConfirm = await triggerCompact(host, { session, confirm: false });
    expect(noConfirm.ok).toBe(false);

    const ok = await triggerCompact(host, { session, confirm: true });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.data?.llmCalls).toBe(0);
    await host.dispose();
  });

  it("A10-14 promoteMemoryNotes false → no memory file write", async () => {
    const root = mkdtempSync(join(tmpdir(), "oc-p10-mem-"));
    const ws = mkdtempSync(join(tmpdir(), "oc-p10-ws-"));
    const session = "sess_mem";
    mkdirSync(join(root, session), { recursive: true });
    writeFileSync(
      join(root, session, "graph.json"),
      JSON.stringify({ schema: "ctx-graph-v1", nodes: [{ id: "1" }], edges: [] }),
    );
    const host = createEngineHost(
      {
        ...RECALL_05_DEFAULTS,
        stateDir: root,
        engineImpl: "ts",
        promoteMemoryNotes: false,
      },
      { packer: mockPacker(), meta: new MetaStore(":memory:"), autoStartSidecar: false },
    );
    await triggerCompact(host, { session, confirm: true }, { workspaceRoot: ws });
    expect(memoryFileExists(ws)).toBe(false);

    // When true, writer appends
    appendMemoryNotes({
      workspaceRoot: ws,
      session,
      entryText: "OpenItem: decided\nidentifier: uuid-1",
    });
    expect(memoryFileExists(ws)).toBe(true);
    await host.dispose();
  });

  it("forceFlush emits ok", async () => {
    const host = createEngineHost(
      { ...RECALL_05_DEFAULTS, engineImpl: "ts" },
      { packer: mockPacker(), meta: new MetaStore(":memory:"), autoStartSidecar: false },
    );
    const flush = vi.fn(async () => ({ ok: true }));
    (host as { _packer?: { flush: typeof flush } })._packer = {
      ...mockPacker(),
      flush,
    } as never;
    const r = await forceFlush(host, { session: "s_flush" });
    expect(r.ok).toBe(true);
    expect(flush).toHaveBeenCalled();
  });
});
