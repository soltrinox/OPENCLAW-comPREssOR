import { describe, expect, it } from "vitest";
import {
  CURSOR_PARITY_DEFAULTS,
  RECALL_05_DEFAULTS,
  ConfigValidationError,
  loadManifestConfigSchema,
  validateConfig,
} from "../src/config.ts";

describe("config schema", () => {
  it("rejects unknown keys", () => {
    expect(() => validateConfig({ profile: "recall-0.5", extraKnob: 1 })).toThrow(
      ConfigValidationError,
    );
    try {
      validateConfig({ extraKnob: 1 });
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigValidationError);
      expect((err as ConfigValidationError).issues.some((i) => i.path === "extraKnob")).toBe(true);
    }
  });

  it("recall-0.5 defaults match SPECS §6 table", () => {
    const { resolved } = validateConfig({ profile: "recall-0.5" });
    expect(resolved.kMax).toBe(64);
    expect(resolved.chunksPerTurn).toBe(16);
    expect(resolved.poolEma).toBe(0.5);
    expect(resolved.protectKinds).toEqual(["path", "decision", "identifier"]);
    expect(resolved.forwardBudget).toBe(2048);
    expect(resolved.hotSetMaxChars).toBe(800);
    expect(resolved.keepRecentTokens).toBe(4000);
    expect(resolved.noveltyBudgetFloor).toBe(1.0);
    expect(resolved.rankFallbackTopK).toBe(8);
    expect(resolved.matrixSpanReadout).toBe(true);
    expect(resolved.matrixSpanK).toBe(8);
    expect(resolved.ingestToolResults).toBe(true);
    expect(resolved.skipHeartbeats).toBe(true);
    expect(resolved.pythonPath).toBe("auto");
    expect(resolved.engineImpl).toBe("sidecar");
    expect(resolved.promoteMemoryNotes).toBe(false);
    expect(resolved.injectP1).toBe(false);
    expect(resolved.shareGraphByAgent).toBe(false);
    expect(resolved.stateDir).toBe("~/.openclaw/context-graphs");
    expect(resolved).toMatchObject(RECALL_05_DEFAULTS);
  });

  it("cursor-parity projection matches Cursor-like knobs", () => {
    const { resolved } = validateConfig({ profile: "cursor-parity" });
    expect(resolved.kMax).toBe(32);
    expect(resolved.chunksPerTurn).toBe(8);
    expect(resolved.poolEma).toBe(0.7);
    expect(resolved.forwardBudget).toBe(1024);
    expect(resolved.hotSetMaxChars).toBe(400);
    expect(resolved.noveltyBudgetFloor).toBe(0.5);
    expect(resolved.rankFallbackTopK).toBe(3);
    expect(resolved).toMatchObject(CURSOR_PARITY_DEFAULTS);
  });

  it("manifest schema sets additionalProperties false", () => {
    const schema = loadManifestConfigSchema();
    expect(schema.additionalProperties).toBe(false);
  });

  it("warns when overlaying profile-owned knobs", () => {
    const { overlayWarnings, resolved } = validateConfig({
      profile: "recall-0.5",
      kMax: 16,
    });
    expect(resolved.kMax).toBe(16);
    expect(overlayWarnings.some((w) => w.includes("kMax"))).toBe(true);
  });
});
