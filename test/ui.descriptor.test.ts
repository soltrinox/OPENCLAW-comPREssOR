/**
 * Plan 09 — Control UI view-models, descriptor registration, privacy contracts.
 */
import { describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { register } from "../src/index.ts";
import type { OpenClawPluginApi } from "../src/runtime-api.ts";
import {
  COMPRESSOR_CONTROL_UI_DESCRIPTOR,
  COMPRESSOR_UI_ID,
  COMPRESSOR_UI_PATH,
  registerCompressorControlUi,
  eta,
  delta,
  saturationTone,
  formatPct,
  formatEta,
  formatKOverKmax,
  compositionFromFamily,
  buildDashboardSnapshot,
  disabledActionBar,
  enabledActionBar,
  dashboardHtmlFromApis,
  EMPTY_ETA_LABEL,
} from "../src/ui/index.ts";

describe("view-models (A9)", () => {
  it("A9-2 eta(125000,21000) ≈ 0.832", () => {
    expect(eta(125000, 21000)).toBeCloseTo(0.832, 3);
  });

  it("A9-3 eta(0,0) === 0", () => {
    expect(eta(0, 0)).toBe(0);
    expect(delta(125000, 21000)).toBe(104000);
  });

  it("A9-4 saturationTone warn/ok", () => {
    expect(saturationTone(0.81)).toBe("warn");
    expect(saturationTone(0.79)).toBe("ok");
  });

  it("A9-5 formatPct does not invent 83.8", () => {
    expect(formatPct(0.832)).toBe("83.2%");
    expect(formatPct(0.832)).not.toBe("83.8%");
  });

  it("A9-8 empty / null η does not render 0%", () => {
    expect(formatEta(null)).toBe(EMPTY_ETA_LABEL);
    expect(formatEta(null)).not.toContain("0%");
    expect(formatEta(undefined)).toBe(EMPTY_ETA_LABEL);
    expect(formatEta(0.832)).toBe("83.2%");
    const empty = buildDashboardSnapshot({
      summary: {
        status: "empty",
        data: {
          totalTurns: 0,
          efficiency: { reductionRatio: null, savedTokens: 0 },
          health: { sidecarStatus: "stopped" },
        },
      },
      timeseries: { status: "empty", data: { turnIndex: [], tauReplay: [], tauPacked: [] } },
      capacity: {
        status: "empty",
        data: {
          matrix: { k: 0, kMax: 0, optional: true },
          graph: {
            turns: { active: 0, cap: 1 },
            durableFacts: { active: 0, cap: 1 },
            nonDurableFacts: { active: 0, cap: 1 },
          },
          prunedPerTurn: [],
        },
      },
    });
    expect(empty.efficiency.etaLabel).not.toBe("0%");
    expect(empty.efficiency.etaLabel).toMatch(/—|n\/a/);
  });

  it("A9-9 caption / unit includes tau", () => {
    const snap = buildDashboardSnapshot({
      summary: {
        status: "ok",
        data: {
          totalTurns: 2,
          efficiency: { savedTokens: 104000, reductionRatio: 0.832, unit: "tau" },
          health: { sidecarStatus: "ts", avgLatencyMs: 12 },
        },
      },
      timeseries: {
        status: "ok",
        data: {
          turnIndex: [1, 2],
          tauReplay: [1000, null],
          tauPacked: [200, 180],
          assembleMs: [10, 12],
        },
      },
      capacity: {
        status: "ok",
        data: {
          matrix: { k: 28, kMax: 64, optional: false },
          graph: {
            turns: { active: 12, cap: 32 },
            durableFacts: { active: 20, cap: 48 },
            nonDurableFacts: { active: 40, cap: 64 },
          },
          prunedPerTurn: [1, 2, 0],
        },
      },
    });
    expect(snap.efficiency.unitCaption.toLowerCase()).toContain("tau");
    const html = dashboardHtmlFromApis({
      summary: {
        status: "ok",
        data: {
          totalTurns: 2,
          efficiency: { savedTokens: 104000, reductionRatio: 0.832, unit: "tau" },
          health: { sidecarStatus: "ts" },
        },
      },
      timeseries: {
        status: "ok",
        data: { turnIndex: [1], tauReplay: [100], tauPacked: [20], assembleMs: [5] },
      },
      capacity: {
        status: "ok",
        data: {
          matrix: { k: 28, kMax: 64, optional: false },
          graph: {
            turns: { active: 1, cap: 32 },
            durableFacts: { active: 0, cap: 48 },
            nonDurableFacts: { active: 0, cap: 64 },
          },
          prunedPerTurn: [],
        },
      },
    });
    expect(html).toMatch(/unit=tau/i);
    expect(html).not.toMatch(/\$|USD/i);
  });

  it("A9-10 matrixOptional hides fake 0/64 donut", () => {
    const na = formatKOverKmax(null, null, true);
    expect(na.label.toLowerCase()).toContain("n/a");
    expect(na.ratio).toBeNull();
  });

  it("A9-11 quarantine banner does not zero KPIs", () => {
    const snap = buildDashboardSnapshot({
      summary: {
        status: "ok",
        data: {
          totalTurns: 5,
          efficiency: { savedTokens: 104000, reductionRatio: 0.832 },
          health: { sidecarStatus: "quarantined" },
        },
      },
      timeseries: {
        status: "ok",
        data: { turnIndex: [1], tauReplay: [100], tauPacked: [20], assembleMs: [5] },
      },
      capacity: {
        status: "ok",
        data: {
          matrix: { k: 10, kMax: 64, optional: false },
          graph: {
            turns: { active: 1, cap: 32 },
            durableFacts: { active: 0, cap: 48 },
            nonDurableFacts: { active: 0, cap: 64 },
          },
          prunedPerTurn: [],
        },
      },
    });
    expect(snap.quarantined).toBe(true);
    expect(snap.freezeKpis).toBe(true);
    expect(snap.efficiency.etaLabel).toBe("83.2%");
    expect(snap.efficiency.deltaLabel).toContain("104000");
    const html = dashboardHtmlFromApis({
      summary: snap.quarantined
        ? {
            status: "ok",
            data: {
              totalTurns: 5,
              efficiency: { savedTokens: 104000, reductionRatio: 0.832 },
              health: { sidecarStatus: "quarantined" },
            },
          }
        : { status: "error" },
      timeseries: {
        status: "ok",
        data: { turnIndex: [1], tauReplay: [100], tauPacked: [20], assembleMs: [5] },
      },
      capacity: {
        status: "ok",
        data: {
          matrix: { k: 10, kMax: 64, optional: false },
          graph: {
            turns: { active: 1, cap: 32 },
            durableFacts: { active: 0, cap: 48 },
            nonDurableFacts: { active: 0, cap: 64 },
          },
          prunedPerTurn: [],
        },
      },
    });
    expect(html).toMatch(/quarantined/i);
    expect(html).toContain("83.2%");
    expect(html).not.toMatch(/data-eta">0%/);
  });

  it("composition unavailable when family null — never 25% quarters", () => {
    const c = compositionFromFamily(null);
    expect(c.kind).toBe("unavailable");
    const ok = compositionFromFamily({
      hotSetTokens: 120,
      typedLinesTokens: 40,
      rankedSpanTokens: 30,
      recentTailTokens: 10,
    });
    expect(ok.kind).toBe("ok");
    if (ok.kind === "ok") {
      expect(ok.total).toBe(200);
      expect(ok.segments[0]!.pct).toBeCloseTo(0.6, 5);
    }
  });
});

describe("descriptor registration (A9-1)", () => {
  it("registerControlUiDescriptor called with id compressor (grouped)", () => {
    const registerControlUiDescriptor = vi.fn();
    const ok = registerCompressorControlUi({
      session: { controls: { registerControlUiDescriptor } },
    });
    expect(ok).toBe(true);
    expect(registerControlUiDescriptor).toHaveBeenCalled();
    const desc = registerControlUiDescriptor.mock.calls[0]![0];
    expect(desc.id).toBe(COMPRESSOR_UI_ID);
    expect(desc.id).toBe("compressor");
    expect(desc.path).toBe(COMPRESSOR_UI_PATH);
    expect(desc.requiredScopes).toContain("operator.read");
  });

  it("flat registerControlUiDescriptor alias", () => {
    const registerControlUiDescriptor = vi.fn();
    expect(registerCompressorControlUi({ registerControlUiDescriptor })).toBe(true);
    expect(registerControlUiDescriptor.mock.calls[0]![0].namespace).toBe("compressor");
  });

  it("plugin register() wires Control UI + dashboard HTTP", () => {
    const registerControlUiDescriptor = vi.fn();
    const registerHttpRoute = vi.fn();
    const api: OpenClawPluginApi = {
      registerContextEngine: vi.fn(),
      registerCli: vi.fn(),
      registerHttpRoute,
      registerControlUiDescriptor,
      lifecycle: { registerRuntimeLifecycle: vi.fn() },
    };
    register(api);
    expect(registerControlUiDescriptor).toHaveBeenCalled();
    expect(registerControlUiDescriptor.mock.calls[0]![0].id).toBe("compressor");
    const paths = registerHttpRoute.mock.calls.map((c) => c[0].path as string);
    expect(paths).toContain(COMPRESSOR_UI_PATH);
    expect(paths).toContain("/api/plugin/compressor/stats/summary");
  });

  it("A9-7 / Plan 10 action bar enabled against manage POSTs", () => {
    const disabled = disabledActionBar("recall-0.5");
    expect(disabled.every((a) => a.disabled && a.planGate === "Plan 10")).toBe(true);
    const enabled = enabledActionBar("recall-0.5");
    expect(enabled.every((a) => a.disabled === false)).toBe(true);
    const html = dashboardHtmlFromApis({
      summary: {
        status: "ok",
        data: {
          totalTurns: 1,
          efficiency: { savedTokens: 10, reductionRatio: 0.5 },
          health: { sidecarStatus: "active" },
        },
      },
      timeseries: {
        status: "ok",
        data: { turnIndex: [1], tauReplay: [100], tauPacked: [50], assembleMs: [9] },
      },
      capacity: {
        status: "ok",
        data: {
          matrix: { k: 1, kMax: 32, optional: false },
          graph: {
            turns: { active: 1, cap: 8 },
            durableFacts: { active: 0, cap: 8 },
            nonDurableFacts: { active: 0, cap: 8 },
          },
          prunedPerTurn: [],
        },
      },
      mutationsEnabled: true,
    });
    expect(html).toMatch(/data-mutations="enabled"/);
    expect(html).toMatch(/data-action="flush"/);
    expect(html).toMatch(/oc-confirm-purge/);
    expect(html).toMatch(/\/api\/plugin\/compressor\/manage\//);
    const inert = dashboardHtmlFromApis({
      summary: {
        status: "ok",
        data: {
          totalTurns: 1,
          efficiency: { savedTokens: 10, reductionRatio: 0.5 },
          health: { sidecarStatus: "active" },
        },
      },
      timeseries: {
        status: "ok",
        data: { turnIndex: [1], tauReplay: [100], tauPacked: [50], assembleMs: [9] },
      },
      capacity: {
        status: "ok",
        data: {
          matrix: { k: 1, kMax: 32, optional: false },
          graph: {
            turns: { active: 1, cap: 8 },
            durableFacts: { active: 0, cap: 8 },
            nonDurableFacts: { active: 0, cap: 8 },
          },
          prunedPerTurn: [],
        },
      },
      mutationsEnabled: false,
    });
    expect(inert).toMatch(/aria-disabled="true"/);
    expect(inert).toMatch(/data-mutations="plan-10-disabled"/);
  });
});

describe("privacy (A9-6, A9-12)", () => {
  function walkUiSrc(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walkUiSrc(p, out);
      else if (/\.(ts|tsx|js|html)$/.test(name)) out.push(p);
    }
    return out;
  }

  it("A9-6 ui src never fetches graph.json / safetensors", () => {
    const files = walkUiSrc(join(process.cwd(), "src/ui"));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      expect(text).not.toMatch(/graph\.json/);
      expect(text).not.toMatch(/safetensors/);
      expect(text).not.toMatch(/fetch\([^)]*pack/i);
    }
  });

  it("A9-12 no USD string in ui src", () => {
    const files = walkUiSrc(join(process.cwd(), "src/ui"));
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      expect(text).not.toMatch(/\bUSD\b/);
      expect(text).not.toMatch(/\$\/token/);
    }
  });

  it("descriptor fetch list is count-only GETs", () => {
    expect(COMPRESSOR_CONTROL_UI_DESCRIPTOR.fetch).toEqual([
      "/api/plugin/compressor/stats/summary",
      "/api/plugin/compressor/stats/timeseries",
      "/api/plugin/compressor/state/capacity",
    ]);
  });
});
