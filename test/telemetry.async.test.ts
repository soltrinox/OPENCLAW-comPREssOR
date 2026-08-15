/**
 * Plan 07 — async tracker, fail-open assemble, prune, compact flag, A7-* assertions.
 */

import { describe, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createEngineHost, type EnginePacker } from "../src/engine.ts";
import { assemble } from "../src/assemble.ts";
import { RECALL_05_DEFAULTS } from "../src/config.ts";
import { MetaStore } from "../src/meta-store.ts";
import { TelemetryStore } from "../src/telemetry/store.ts";
import { Tracker, QUEUE_CAP } from "../src/telemetry/tracker.ts";
import { buildAssembleMetrics } from "../src/telemetry/map.ts";
import { runDoctorChecks } from "../src/doctor.ts";
import type { ChatMessage } from "../src/messages.ts";
import type { PackCountFields } from "../src/telemetry/types.ts";

function mockPacker(overrides: Partial<EnginePacker> = {}): EnginePacker {
  return {
    async step() {
      return { t: 1 };
    },
    async sample() {
      return {
        text: "HOT_SET: OpenItem fix-auth\npath=/tmp/a.ts",
        packed_tokens: 40,
        method: "query-pack",
        k: 2,
        k_max: 64,
        duration_ms: 11,
        rpc_latency_ms: 11,
        hot_set_tokens: 8,
        typed_lines_tokens: 4,
        graph_active_nodes: 5,
        graph_pruned_nodes: 1,
      };
    },
    async flush() {
      return {};
    },
    async dispose() {},
    ...overrides,
  };
}

describe("telemetry.async", () => {
  it("A7-2: three assembles → three turn_metrics rows", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-telem-a72-"));
    const store = new TelemetryStore(join(dir, "telemetry.sqlite"));
    const tracker = new Tracker({ store });
    const host = createEngineHost(
      { ...RECALL_05_DEFAULTS, stateDir: dir, keepRecentTokens: 500 },
      {
        packer: mockPacker(),
        meta: new MetaStore(":memory:"),
        tracker,
        autoStartSidecar: false,
      },
    );
    for (let i = 0; i < 3; i++) {
      await host.assemble({
        sessionKey: "sess-a72",
        messages: [{ role: "user", content: `hi-${i}` }],
      });
    }
    await tracker.flush();
    expect(store.countTurns()).toBe(3);
    tracker.close();
    await host.dispose();
  });

  it("A7-3/A7-4: tracker insert failure — assemble still returns addition", async () => {
    const tracker = new Tracker({
      insertHook: async () => {
        throw new Error("forced telemetry failure");
      },
    });
    const host = createEngineHost(RECALL_05_DEFAULTS, {
      packer: mockPacker(),
      meta: new MetaStore(":memory:"),
      tracker,
      autoStartSidecar: false,
    });
    const out = await host.assemble({
      sessionKey: "sess-fail",
      messages: [{ role: "user", content: "hello" }],
    });
    expect(out.systemPromptAddition).toContain("HOT_SET:");
    expect(out.promptAuthority).toBe("assembled");
    await tracker.flush();
    await host.dispose();
  });

  it("A7-3b: unwritable db path — assemble still succeeds", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-telem-ro-"));
    const dbPath = join(dir, "telemetry.sqlite");
    // Create then make directory non-writable after opening fails on insert path.
    writeFileSync(dbPath, "");
    chmodSync(dbPath, 0o444);
    const tracker = new Tracker({ dbPath });
    const host = createEngineHost(RECALL_05_DEFAULTS, {
      packer: mockPacker(),
      meta: new MetaStore(":memory:"),
      tracker,
      autoStartSidecar: false,
    });
    const out = await host.assemble({
      sessionKey: "sess-ro",
      messages: [{ role: "user", content: "still works" }],
    });
    expect(out.systemPromptAddition.length).toBeGreaterThan(0);
    await tracker.flush();
    chmodSync(dbPath, 0o644);
    await host.dispose();
  });

  it("A7-5: compact emits compacted=1 row", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-telem-c-"));
    const store = new TelemetryStore(join(dir, "telemetry.sqlite"));
    const tracker = new Tracker({ store });
    const host = createEngineHost(
      { ...RECALL_05_DEFAULTS, stateDir: dir },
      {
        packer: mockPacker(),
        meta: new MetaStore(":memory:"),
        tracker,
        autoStartSidecar: false,
        hooks: { graphNonempty: () => false },
      },
    );
    await host.compact({
      sessionKey: "sess-c",
      messages: [{ role: "user", content: "/compact" }],
    });
    await tracker.flush();
    expect(store.countTurns()).toBeGreaterThanOrEqual(1);
    const db = new DatabaseSync(store.dbPath);
    const row = db
      .prepare("SELECT compacted FROM turn_metrics ORDER BY id DESC LIMIT 1")
      .get() as { compacted: number };
    expect(row.compacted).toBe(1);
    db.close();
    tracker.close();
    await host.dispose();
  });

  it("A7-6: fat history tau_replay > recent_tail + tau_packed", () => {
    const fat: ChatMessage[] = [];
    for (let i = 0; i < 80; i++) {
      fat.push({ role: "user", content: `HISTORY-${i}-` + "x".repeat(600) });
      fat.push({ role: "assistant", content: `R-${i}-` + "y".repeat(600) });
    }
    const tail = fat.slice(-2);
    const m = buildAssembleMetrics({
      sessionId: "fat",
      turnIndex: 0,
      preCutMessages: fat,
      tailMessages: tail,
      pack: { packed_tokens: 40, k: 2, k_max: 64 },
      budgetMax: 2048,
      budgetUsed: 40,
      totalAssembleMs: 10,
      impl: "sidecar",
    });
    expect(m.tauReplay!).toBeGreaterThan((m.recentTailTokens ?? 0) + (m.tauPacked ?? 0));
  });

  it("A7-7: queue overflow drops oldest without throwing", async () => {
    const inserted: number[] = [];
    const tracker = new Tracker({
      queueCap: 5,
      insertHook: async (m) => {
        // Slow drain so queue fills
        await new Promise((r) => setTimeout(r, 5));
        inserted.push(m.turnIndex);
      },
    });
    for (let i = 0; i < 20; i++) {
      tracker.trackTurn({
        sessionId: "q",
        turnIndex: i,
        tauReplay: 1,
        tauPacked: 1,
        budgetMax: 1,
        budgetUsed: 1,
      });
    }
    expect(tracker.telemetryDropped).toBeGreaterThan(0);
    await tracker.flush();
    tracker.close();
  });

  it("A7-8: doctor warns (not fail) on unwritable telemetry", () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-telem-doc-"));
    const sessionDir = join(dir, "sess-doc");
    mkdirSync(sessionDir, { recursive: true });
    const dbPath = join(sessionDir, "telemetry.sqlite");
    writeFileSync(dbPath, "");
    chmodSync(dbPath, 0o444);
    const findings = runDoctorChecks({
      config: {
        ...RECALL_05_DEFAULTS,
        stateDir: dir,
        engineImpl: "sidecar",
      },
      sessionKey: "sess-doc",
      telemetryDropped: 3,
    });
    const t = findings.find((f) => f.id === "telemetry-writable");
    expect(t).toBeTruthy();
    expect(t!.severity).toBe("warn");
    expect(t!.message).toMatch(/not writable|integrity|telemetry/i);
    chmodSync(dbPath, 0o644);
  });

  it("A7-9: prune deletes rows older than 30 days", () => {
    const store = new TelemetryStore(":memory:");
    const old = Date.now() - 40 * 24 * 60 * 60 * 1000;
    store.insertTurn({
      sessionId: "old",
      turnIndex: 0,
      timestamp: old,
      tauReplay: 1,
      tauPacked: 1,
      budgetMax: 1,
      budgetUsed: 1,
    });
    store.insertTurn({
      sessionId: "new",
      turnIndex: 1,
      timestamp: Date.now(),
      tauReplay: 1,
      tauPacked: 1,
      budgetMax: 1,
      budgetUsed: 1,
    });
    const { deletedAge } = store.prune();
    expect(deletedAge).toBe(1);
    expect(store.countTurns()).toBe(1);
    store.close();
  });

  it("A7-10: impl column sidecar or ts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-telem-impl-"));
    const store = new TelemetryStore(join(dir, "t.sqlite"));
    const tracker = new Tracker({ store });
    const host = createEngineHost(RECALL_05_DEFAULTS, {
      packer: mockPacker(),
      meta: new MetaStore(":memory:"),
      tracker,
      packerImpl: "ts",
      autoStartSidecar: false,
    });
    await host.assemble({
      sessionKey: "sess-ts",
      messages: [{ role: "user", content: "ts path counts" }],
    });
    await tracker.flush();
    const db = new DatabaseSync(store.dbPath);
    const row = db.prepare("SELECT impl FROM turn_metrics LIMIT 1").get() as { impl: string };
    expect(row.impl).toBe("ts");
    db.close();
    tracker.close();
    await host.dispose();

    const m = buildAssembleMetrics({
      sessionId: "x",
      turnIndex: 0,
      preCutMessages: [{ role: "user", content: "a" }],
      tailMessages: [{ role: "user", content: "a" }],
      pack: { packed_tokens: 1 } satisfies PackCountFields,
      budgetMax: 10,
      budgetUsed: 1,
      totalAssembleMs: 1,
      impl: "sidecar",
    });
    expect(m.impl).toBe("sidecar");
  });

  it("A7-11: rpc_latency_ms populated from pack duration", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-telem-rpc-"));
    const store = new TelemetryStore(join(dir, "t.sqlite"));
    const tracker = new Tracker({ store });
    await assemble(
      {
        config: RECALL_05_DEFAULTS,
        packer: mockPacker(),
        meta: new MetaStore(":memory:"),
        agentId: "a",
        sessionId: "s",
        tracker,
        packerImpl: "sidecar",
      },
      { messages: [{ role: "user", content: "q" }] },
    );
    await tracker.flush();
    const db = new DatabaseSync(store.dbPath);
    const row = db.prepare("SELECT rpc_latency_ms, impl FROM turn_metrics LIMIT 1").get() as {
      rpc_latency_ms: number;
      impl: string;
    };
    expect(row.rpc_latency_ms).toBe(11);
    expect(row.impl).toBe("sidecar");
    db.close();
    tracker.close();
  });

  it("does not await slow insert on assemble wall time", async () => {
    let resolveInsert!: () => void;
    const gate = new Promise<void>((r) => {
      resolveInsert = r;
    });
    const tracker = new Tracker({
      insertHook: async () => {
        await gate;
      },
    });
    const t0 = Date.now();
    const host = createEngineHost(RECALL_05_DEFAULTS, {
      packer: mockPacker(),
      meta: new MetaStore(":memory:"),
      tracker,
      autoStartSidecar: false,
    });
    await host.assemble({
      sessionKey: "sess-fast",
      messages: [{ role: "user", content: "fast" }],
    });
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(200);
    resolveInsert();
    await tracker.flush();
    await host.dispose();
  });

  it("QUEUE_CAP constant is 1000", () => {
    expect(QUEUE_CAP).toBe(1000);
  });
});
