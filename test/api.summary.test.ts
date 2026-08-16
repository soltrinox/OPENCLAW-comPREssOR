/**
 * Plan 08 — API/CLI tests against fixture sqlite (synthetic counts, no user text).
 */

import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  handleCapacity,
  handlePostProfile,
  handleSummary,
  handleTimeseries,
  rejectUnsafeSessionId,
} from "../src/api.ts";
import {
  formatStatsTable,
  runCompressorCli,
  runDoctorCommand,
  runPurgeCommand,
  runStatsCommand,
  runStatusCommand,
} from "../src/cli/index.ts";
import { CURSOR_PARITY_DEFAULTS, RECALL_05_DEFAULTS } from "../src/config.ts";
import { TelemetryStore } from "../src/telemetry/store.ts";
import { runDoctorChecks } from "../src/doctor.ts";
import { register } from "../src/index.ts";
import type { OpenClawPluginApi } from "../src/runtime-api.ts";
import { vi } from "vitest";

const SESSION = "sess_fixture_08";

/** 45 turns: sum tau_replay=125000, sum tau_packed=21000 → ratio ≈ 0.832 */
function seedFixture45(store: TelemetryStore): void {
  const n = 45;
  // Distribute so sums are exact: most turns share floor; adjust remainder on last rows.
  const replayPer = Math.floor(125000 / n); // 2777
  const packedPer = Math.floor(21000 / n); // 466
  let remR = 125000 - replayPer * n; // 125000 - 124965 = 35
  let remP = 21000 - packedPer * n; // 21000 - 20970 = 30
  for (let i = 1; i <= n; i++) {
    const extraR = remR > 0 ? 1 : 0;
    const extraP = remP > 0 ? 1 : 0;
    if (remR > 0) remR -= 1;
    if (remP > 0) remP -= 1;
    store.insertTurn({
      sessionId: SESSION,
      turnIndex: i,
      timestamp: 1_700_000_000_000 + i * 1000,
      tauReplay: replayPer + extraR,
      tauPacked: packedPer + extraP,
      budgetMax: 2048,
      budgetUsed: packedPer + extraP,
      matrixRowsK: 28,
      matrixMaxSlots: 64,
      graphActiveNodes: 12,
      graphPrunedNodes: i % 5 === 0 ? 4 : i % 3 === 0 ? 1 : 0,
      totalAssembleMs: 40 + (i % 7),
      impl: "ts",
      packMethod: "query-pack",
    });
  }
}

describe("api.summary (Plan 08)", () => {
  it("A8-1 fixture 125000/21000 → saved 104000, ratio ~0.832, unit=tau", () => {
    const store = new TelemetryStore(":memory:");
    seedFixture45(store);
    const dto = handleSummary({ session: SESSION, store });
    expect(dto.status).toBe("ok");
    expect(dto.data?.totalTurns).toBe(45);
    expect(dto.data?.efficiency.totalTauReplay).toBe(125000);
    expect(dto.data?.efficiency.totalTauPacked).toBe(21000);
    expect(dto.data?.efficiency.savedTokens).toBe(104000);
    expect(dto.data?.efficiency.reductionRatio).toBeCloseTo(0.832, 3);
    expect(dto.data?.efficiency.unit).toBe("tau");
    store.close();
  });

  it("A8-2 empty db → status empty, reductionRatio 0, no throw", () => {
    const store = new TelemetryStore(":memory:");
    const dto = handleSummary({ session: SESSION, store });
    expect(dto.status).toBe("empty");
    expect(dto.data?.totalTurns).toBe(0);
    expect(dto.data?.efficiency.reductionRatio).toBe(0);
    expect(dto.data?.message).toBe("no_samples");
    store.close();
  });

  it("A8-3 divide-by-zero / null replay → reductionRatio null not NaN", () => {
    const store = new TelemetryStore(":memory:");
    store.insertTurn({
      sessionId: SESSION,
      turnIndex: 1,
      tauReplay: null,
      tauPacked: null,
      budgetMax: 100,
      budgetUsed: 0,
    });
    store.insertTurn({
      sessionId: SESSION,
      turnIndex: 2,
      tauReplay: 0,
      tauPacked: 0,
      budgetMax: 100,
      budgetUsed: 0,
    });
    const dto = handleSummary({ session: SESSION, store });
    expect(dto.status).toBe("ok");
    expect(dto.data?.efficiency.reductionRatio).toBeNull();
    expect(dto.data?.efficiency.reason).toBe("replay_tau_undefined");
    expect(Number.isNaN(dto.data?.efficiency.reductionRatio as number)).toBe(false);
    store.close();
  });

  it("A8-6 / A8-14 path traversal session → error; unit field present on ok", () => {
    expect(rejectUnsafeSessionId("../x")).toBe("path_traversal");
    const store = new TelemetryStore(":memory:");
    const dto = handleSummary({ session: "../x", store });
    expect(dto.status).toBe("error");
    expect(dto.error?.code).toBe("unknown_session");
    store.close();
  });

  it("A8-10 timeseries length ≤ 500", () => {
    const store = new TelemetryStore(":memory:");
    for (let i = 1; i <= 600; i++) {
      store.insertTurn({
        sessionId: SESSION,
        turnIndex: i,
        tauReplay: 100,
        tauPacked: 20,
        budgetMax: 2048,
        budgetUsed: 20,
      });
    }
    const dto = handleTimeseries({ session: SESSION, store, limit: 500 });
    expect(dto.status).toBe("ok");
    expect(dto.data!.turnIndex.length).toBeLessThanOrEqual(500);
    expect(dto.data!.turnIndex.length).toBe(500);
    store.close();
  });

  it("A8-11 capacity caps follow resolved profile (cursor-parity kMax=32)", () => {
    const store = new TelemetryStore(":memory:");
    store.insertTurn({
      sessionId: SESSION,
      turnIndex: 1,
      tauReplay: 10,
      tauPacked: 2,
      budgetMax: 1024,
      budgetUsed: 2,
      matrixRowsK: 10,
      matrixMaxSlots: 32,
      graphActiveNodes: 5,
      graphPrunedNodes: 0,
    });
    const dto = handleCapacity({
      session: SESSION,
      store,
      config: CURSOR_PARITY_DEFAULTS,
    });
    expect(dto.data?.matrix.kMax).toBe(32);
    expect(dto.data?.matrix.k).toBe(10);
    store.close();
  });

  it("A8-12 POST profile without host returns host_required or bad_request", () => {
    const r = handlePostProfile();
    expect([400, 501]).toContain(r.httpStatus);
    expect(r.status).toBe("error");
  });
});

describe("cli.stats (Plan 08)", () => {
  it("A8-4 CLI stdout contains tau; A8-5 not hardcoded 84%", async () => {
    const store = new TelemetryStore(":memory:");
    seedFixture45(store);
    const chunks: string[] = [];
    const code = await runStatsCommand(
      { session: SESSION },
      {
        store,
        config: { ...RECALL_05_DEFAULTS, engineImpl: "ts" },
        io: {
          stdout: (s) => chunks.push(s),
          stderr: () => {},
        },
      },
    );
    const out = chunks.join("\n");
    expect(code).toBe(0);
    expect(out).toMatch(/tau/i);
    expect(out).toMatch(/unit=tau/);
    expect(out).toMatch(/83\.2%/);
    expect(out).not.toMatch(/\b84%/);
    expect(out).not.toMatch(/0\.838/);
    store.close();
  });

  it("--json is parseable SummaryDTO", async () => {
    const store = new TelemetryStore(":memory:");
    seedFixture45(store);
    const chunks: string[] = [];
    await runStatsCommand(
      { session: SESSION, json: true },
      {
        store,
        io: { stdout: (s) => chunks.push(s), stderr: () => {} },
      },
    );
    const dto = JSON.parse(chunks.join("")) as ReturnType<typeof handleSummary>;
    expect(dto.data?.efficiency.unit).toBe("tau");
    expect(formatStatsTable(dto)).toMatch(/tau/);
    store.close();
  });

  it("A8-7 purge without confirm exit 2 and leaves graph.json", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-p08-purge-"));
    const session = "sess_purge";
    const sessionDir = join(dir, session);
    mkdirSync(sessionDir, { recursive: true });
    const graph = join(sessionDir, "graph.json");
    writeFileSync(graph, '{"nodes":[]}');
    const code = await runPurgeCommand(
      { session },
      {
        config: { ...RECALL_05_DEFAULTS, stateDir: dir, engineImpl: "ts" },
        io: { stdout: () => {}, stderr: () => {} },
      },
    );
    expect(code).toBe(2);
    expect(existsSync(graph)).toBe(true);
  });

  it("A8-7b purge with --confirm deletes fixture session dir", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-p08-purge-ok-"));
    const session = "sess_purge_ok";
    const sessionDir = join(dir, session);
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, "graph.json"), '{"nodes":[]}');
    const code = await runPurgeCommand(
      { session, confirm: true },
      {
        config: { ...RECALL_05_DEFAULTS, stateDir: dir, engineImpl: "ts" },
        io: { stdout: () => {}, stderr: () => {} },
      },
    );
    expect(code).toBe(0);
    expect(existsSync(sessionDir)).toBe(false);
  });

  it("A8-6 purge ../other fails without delete", async () => {
    const code = await runPurgeCommand(
      { session: "../other", confirm: true },
      { io: { stdout: () => {}, stderr: () => {} } },
    );
    expect(code).toBe(2);
  });

  it("A8-13 status exit 1 when health not ok (sidecar)", async () => {
    const code = await runStatusCommand(
      { session: "sess_x" },
      {
        config: { ...RECALL_05_DEFAULTS, engineImpl: "sidecar", stateDir: mkdtempSync(join(tmpdir(), "oc-st-")) },
        packer: {
          async step() {
            return {};
          },
          async sample() {
            return { text: "", packed_tokens: 0 };
          },
          async flush() {
            return {};
          },
          async dispose() {},
          async health() {
            return { ok: false, impl: "sidecar", python: null, error: "dead" };
          },
        },
        io: { stdout: () => {}, stderr: () => {} },
      },
    );
    expect(code).toBe(1);
  });

  it("csv export headers ⊆ turn_metrics columns (A8-9 privacy)", async () => {
    const store = new TelemetryStore(":memory:");
    seedFixture45(store);
    const { headers } = store.exportTurnMetricsCsv(SESSION);
    expect(headers).not.toContain("prompt");
    expect(headers).not.toContain("text");
    expect(headers).not.toContain("hot_set");
    expect(headers).toContain("tau_replay");
    store.close();
  });
});

describe("doctor + register (Plan 08)", () => {
  it("doctor includes telemetry-readable-stats", () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-doc-"));
    const findings = runDoctorChecks({
      config: { ...RECALL_05_DEFAULTS, stateDir: dir, engineImpl: "ts" },
      sessionKey: "sess_doc",
    });
    expect(findings.some((f) => f.id === "telemetry-readable-stats")).toBe(true);
  });

  it("register wires CLI without colliding core; optional HTTP", () => {
    const registerCli = vi.fn();
    const registerHttpRoute = vi.fn();
    const registerContextEngine = vi.fn();
    const api: OpenClawPluginApi = {
      registerContextEngine,
      registerCli,
      registerHttpRoute,
      lifecycle: { registerRuntimeLifecycle: vi.fn() },
    };
    register(api);
    expect(registerCli).toHaveBeenCalled();
    expect(registerCli.mock.calls[0]![0].name).toBe("compressor");
    expect(registerHttpRoute.mock.calls.length).toBeGreaterThanOrEqual(3);
    const paths = registerHttpRoute.mock.calls.map((c) => c[0].path as string);
    expect(paths).toContain("/api/plugin/compressor/stats/summary");
  });

  it("runCompressorCli parse group", async () => {
    const store = new TelemetryStore(":memory:");
    seedFixture45(store);
    const chunks: string[] = [];
    const code = await runCompressorCli(["stats", "--session", SESSION, "--json"], {
      store,
      io: { stdout: (s) => chunks.push(s), stderr: () => {} },
    });
    expect(code).toBe(0);
    expect(JSON.parse(chunks.join("")).data.efficiency.unit).toBe("tau");
    store.close();
  });

  it("openclaw compressor doctor prints findings via registerCli path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-cli-doc-"));
    const chunks: string[] = [];
    const code = await runCompressorCli(["doctor", "--json"], {
      config: { ...RECALL_05_DEFAULTS, stateDir: dir, engineImpl: "ts" },
      io: { stdout: (s) => chunks.push(s), stderr: () => {} },
    });
    expect(code).toBe(0);
    const findings = JSON.parse(chunks.join("")) as Array<{ id: string; severity: string }>;
    expect(findings.some((f) => f.id === "engine-impl-ts" && f.severity === "pass")).toBe(true);
    expect(findings.some((f) => f.id === "telemetry-readable-stats")).toBe(true);
  });

  it("runDoctorCommand exits 1 when sidecar venv is missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-cli-doc-fail-"));
    const chunks: string[] = [];
    const code = await runDoctorCommand(
      { json: true },
      {
        config: {
          ...RECALL_05_DEFAULTS,
          stateDir: dir,
          engineImpl: "sidecar",
          pythonPath: "/nonexistent/python-xyz",
        },
        io: { stdout: (s) => chunks.push(s), stderr: () => {} },
      },
    );
    expect(code).toBe(1);
    const findings = JSON.parse(chunks.join("")) as Array<{ id: string; severity: string }>;
    expect(findings.some((f) => f.severity === "fail")).toBe(true);
  });
});
