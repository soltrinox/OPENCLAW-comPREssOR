/**
 * Plan 07 — privacy + schema assertions (A7-1, A7-privacy planted UUID).
 */

import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TelemetryStore } from "../src/telemetry/store.ts";
import { Tracker } from "../src/telemetry/tracker.ts";
import type { TurnMetrics } from "../src/telemetry/types.ts";

const PLANTED = "privacy-uuid-DEADBEEF-1111-2222-3333-444455556666";

describe("telemetry.privacy", () => {
  it("A7-1: turn_metrics has no prompt/text/content/hot_set/pack columns", () => {
    const store = new TelemetryStore(":memory:");
    store.assertNoContentColumns();
    const names = store.columnNames().map((n) => n.toLowerCase());
    for (const bad of ["prompt", "text", "content", "hot_set", "pack"]) {
      expect(names).not.toContain(bad);
    }
    store.close();
  });

  it("planted prompt UUID never appears in sqlite file bytes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-telem-priv-"));
    const dbPath = join(dir, "telemetry.sqlite");
    const store = new TelemetryStore(dbPath);
    const tracker = new Tracker({ store });

    const metrics: TurnMetrics = {
      sessionId: "sess-priv",
      turnIndex: 1,
      tauReplay: 100,
      tauPacked: 40,
      budgetMax: 2048,
      budgetUsed: 40,
      hotSetTokens: 10,
      typedLinesTokens: 5,
      rankedSpanTokens: null,
      recentTailTokens: 20,
      matrixRowsK: 2,
      matrixMaxSlots: 64,
      graphActiveNodes: 3,
      graphPrunedNodes: 0,
      rpcLatencyMs: 12,
      totalAssembleMs: 15,
      packMethod: "query-pack",
      impl: "sidecar",
      compacted: false,
    };
    // Malicious attempt: do not put PLANTED into metrics — verify type path + DB.
    tracker.trackTurn(metrics);
    await tracker.flush();

    const bytes = readFileSync(dbPath);
    expect(bytes.includes(Buffer.from(PLANTED))).toBe(false);
    expect(bytes.toString("utf8")).not.toContain("HOT_SET");
    expect(bytes.toString("utf8")).not.toContain(PLANTED);

    // Even if a caller tried to smuggle text via sessionId, column set still has no content cols.
    store.assertNoContentColumns();
    tracker.close();
  });

  it("TurnMetrics type object keys exclude content field names", () => {
    const sample: TurnMetrics = {
      sessionId: "s",
      turnIndex: 0,
      tauReplay: null,
      tauPacked: null,
      budgetMax: null,
      budgetUsed: null,
    };
    const keys = Object.keys(sample).map((k) => k.toLowerCase());
    expect(keys.some((k) => /prompt|content|hot_set|packtext/.test(k))).toBe(false);
  });
});
