import { describe, expect, it, vi } from "vitest";
import { register, COMPRESSOR_ENGINE_INFO } from "../src/index.ts";
import { createEngineHost } from "../src/engine.ts";
import { RECALL_05_DEFAULTS } from "../src/config.ts";
import { MetaStore } from "../src/meta-store.ts";
import type { OpenClawPluginApi } from "../src/runtime-api.ts";
import type { EnginePacker } from "../src/engine.ts";

function mockPacker(overrides: Partial<EnginePacker> = {}): EnginePacker {
  return {
    async step() {
      return { t: 1 };
    },
    async sample() {
      return { text: "HOT_SET: OpenItem", packed_tokens: 12, method: "query-pack", k: 1, k_max: 64 };
    },
    async flush() {
      return { reason: "compact" };
    },
    async dispose() {},
    ...overrides,
  };
}

describe("plugin entry", () => {
  it("registers engine id compressor and never registerMemoryCapability", () => {
    const registerContextEngine = vi.fn();
    const registerMemoryCapability = vi.fn();
    const registerRuntimeLifecycle = vi.fn();
    const api: OpenClawPluginApi = {
      registerContextEngine,
      registerMemoryCapability,
      lifecycle: { registerRuntimeLifecycle },
    };
    register(api);
    expect(registerContextEngine).toHaveBeenCalledTimes(1);
    expect(registerContextEngine.mock.calls[0]![0]).toBe("compressor");
    expect(registerMemoryCapability).not.toHaveBeenCalled();
    expect(registerRuntimeLifecycle).toHaveBeenCalled();
  });

  it("declares assemble-before-prompt and ownsCompaction on factory info", () => {
    expect(COMPRESSOR_ENGINE_INFO.ownsCompaction).toBe(true);
    expect(
      COMPRESSOR_ENGINE_INFO.hostRequirements["agent-run"].requiredCapabilities,
    ).toContain("assemble-before-prompt");
    expect(COMPRESSOR_ENGINE_INFO.transcriptSemantics.currentTurnFence).toBe(
      "before-current-turn-entry-v1",
    );
  });

  it("factory host advertises ownsCompaction and assemble-before-prompt", () => {
    const host = createEngineHost(RECALL_05_DEFAULTS, {
      packer: mockPacker(),
      meta: new MetaStore(":memory:"),
      autoStartSidecar: false,
    });
    expect(host.info.ownsCompaction).toBe(true);
    expect(host.info.hostRequirements["agent-run"].requiredCapabilities).toContain(
      "assemble-before-prompt",
    );
  });
});
