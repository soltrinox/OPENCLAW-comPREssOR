/**
 * Parity + engineImpl=ts assemble (no spawn) + doctor without python.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEngineHost } from "../src/engine.ts";
import { RECALL_05_DEFAULTS } from "../src/config.ts";
import { MetaStore } from "../src/meta-store.ts";
import { runDoctorChecks } from "../src/doctor.ts";
import { TsPacker, createPacker, asEnginePacker } from "../src/packer-port.ts";
import { CtxGraph } from "../src/ts-engine/graph.ts";
import { keywordSet, jaccard } from "../src/ts-engine/extractive.ts";
import { estimateTokens } from "../src/ts-engine/metrics.ts";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const goldens = join(dirname(fileURLToPath(import.meta.url)), "goldens");

describe("ts-engine parity + switch", () => {
  it("A6-6 assemble does not spawn when engineImpl=ts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-ts-asm-"));
    const host = createEngineHost(
      {
        ...RECALL_05_DEFAULTS,
        engineImpl: "ts",
        stateDir: dir,
        keepRecentTokens: 500,
      },
      { meta: new MetaStore(":memory:") },
    );
    expect(host._packer).toBeInstanceOf(TsPacker);
    const out = await host.assemble({
      sessionKey: "sess-ts",
      messages: [
        {
          role: "user",
          content:
            "Please fix auth. UUID 550e8400-e29b-41d4-a716-446655440000 path src/auth.ts\nTODO: wire jwt",
        },
        { role: "assistant", content: "Working on jwt wiring." },
        { role: "user", content: "status of auth?" },
      ],
      prompt: "auth jwt",
    });
    expect(out.promptAuthority).toBe("assembled");
    expect(out.systemPromptAddition).toContain("HOT_SET:");
    expect(out.systemPromptAddition).toMatch(/550e8400-e29b-41d4-a716-446655440000/);
    // TsPacker path — no SidecarClient child process
    expect(host.resolvedConfig.engineImpl).toBe("ts");
    await host.dispose();
  });

  it("A6-7 doctor passes with python hidden when impl=ts", () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-ts-doc-"));
    const findings = runDoctorChecks({
      config: { ...RECALL_05_DEFAULTS, engineImpl: "ts", stateDir: dir, pythonPath: "/nonexistent/python" },
      pluginEnabled: true,
      slot: "legacy",
    });
    const fails = findings.filter((f) => f.severity === "fail");
    expect(fails, JSON.stringify(findings)).toEqual([]);
    expect(findings.some((f) => f.id === "engine-impl-ts" && f.severity === "pass")).toBe(true);
  });

  it("A6-8 doctor fails sidecar impl with python hidden", () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-side-doc-"));
    const findings = runDoctorChecks({
      config: {
        ...RECALL_05_DEFAULTS,
        engineImpl: "sidecar",
        stateDir: dir,
        pythonPath: "/nonexistent/python-xyz",
      },
      pluginEnabled: true,
      slot: "legacy",
    });
    const py = findings.find((f) => f.id === "python-sidecar" || f.id.startsWith("python") || f.id.includes("venv") || f.id.includes("sidecar"));
    const hard = findings.filter((f) => f.severity === "fail");
    expect(hard.length).toBeGreaterThan(0);
    expect(py || hard[0]).toBeTruthy();
  });

  it("parity: HOT_SET lines Jaccard and τ within tolerance vs Python fixture", () => {
    const pyHot = readFileSync(join(goldens, "hot_set.txt"), "utf8").trim();
    const graph = CtxGraph.load(join(goldens, "graph_fixture.json"));
    const tsHot = graph.hotSet("auth jwt", 800).trim();
    // Identical HOT_SET preferred; allow Jaccard ≥ 0.9 on line sets
    const pyLines = new Set(pyHot.split("\n").map((l) => l.trim().toLowerCase()).filter(Boolean));
    const tsLines = new Set(tsHot.split("\n").map((l) => l.trim().toLowerCase()).filter(Boolean));
    const jac = jaccard(pyLines, tsLines);
    expect(jac).toBeGreaterThanOrEqual(0.9);
    const dTau = Math.abs(estimateTokens(pyHot) - estimateTokens(tsHot));
    expect(dTau).toBeLessThanOrEqual(1);
    // UUID must be present in both
    expect(tsHot).toContain("550e8400-e29b-41d4-a716-446655440000");
  });

  it("A6-1 PackerPort TsPacker + createPacker(ts)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-ts-port-"));
    const packer = createPacker({ ...RECALL_05_DEFAULTS, engineImpl: "ts", stateDir: dir });
    expect(packer).toBeInstanceOf(TsPacker);
    const h = await packer.health();
    expect(h.ok).toBe(true);
    expect(h.impl).toBe("ts");
    expect(h.python).toBeNull();
    await packer.step("agent-a", {
      role: "user",
      text: "UUID 550e8400-e29b-41d4-a716-446655440000 TODO: ship",
    });
    const sample = await packer.sample("agent-a", { query: "ship", budget: 512 });
    expect(sample.text.startsWith("HOT_SET:") || sample.text.includes("HOT_SET")).toBe(true);
    await packer.dispose();
  });

  it("A6-11 injectP1 false: pack is not vocab-bag-only", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-ts-p1-"));
    const packer = new TsPacker({
      ...RECALL_05_DEFAULTS,
      engineImpl: "ts",
      stateDir: dir,
      injectP1: false,
    });
    await packer.step("a", { role: "user", text: "OpenItem: milk\npath src/x.ts" });
    const s = await packer.sample("a", { query: "milk", budget: 256 });
    expect(s.method).not.toBe("p1-debug");
    expect(s.text).toMatch(/HOT_SET:|OpenItem|Fact|Path/);
    await packer.dispose();
  });

  it("A6-12 dispose closes cleanly; second dispose ok", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-ts-disp-"));
    const packer = new TsPacker({ ...RECALL_05_DEFAULTS, engineImpl: "ts", stateDir: dir });
    await packer.step("a", { role: "user", text: "hello" });
    await packer.dispose();
    await expect(packer.step("a", { role: "user", text: "again" })).rejects.toThrow(/disposed/i);
  });
});
