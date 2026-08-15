import { describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEngineHost, type EnginePacker } from "../src/engine.ts";
import { CompactError } from "../src/compact.ts";
import { RECALL_05_DEFAULTS } from "../src/config.ts";
import { MetaStore } from "../src/meta-store.ts";

function mockPacker(overrides: Partial<EnginePacker> = {}): EnginePacker {
  return {
    async step() {
      return { t: 1 };
    },
    async sample() {
      return {
        text: "HOT_SET: OpenItem\nDecision: keep ids",
        packed_tokens: 20,
        method: "query-pack",
        k: 3,
        k_max: 64,
      };
    },
    async flush() {
      return { reason: "compact" };
    },
    async dispose() {},
    ...overrides,
  };
}

describe("engine.compact", () => {
  it("does not call complete()/chat() LLM mocks", async () => {
    const complete = vi.fn(async () => ({ text: "should not run" }));
    const chat = vi.fn(async () => ({ text: "should not run" }));
    const stateDir = mkdtempSync(join(tmpdir(), "oc-compact-"));
    const host = createEngineHost(
      { ...RECALL_05_DEFAULTS, stateDir },
      {
        packer: mockPacker(),
        meta: new MetaStore(":memory:"),
        autoStartSidecar: false,
        hooks: { graphNonempty: () => false },
      },
    );
    const out = await host.compact({
      sessionKey: "sess-c1",
      instruction: "/compact Focus on X",
      complete,
      chat,
    });
    expect(out.ok).toBe(true);
    expect(out.compacted).toBe(true);
    expect(complete).toHaveBeenCalledTimes(0);
    expect(chat).toHaveBeenCalledTimes(0);
  });

  it("throws when entry empty and graph nonempty", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "oc-compact-empty-"));
    const host = createEngineHost(
      { ...RECALL_05_DEFAULTS, stateDir },
      {
        packer: mockPacker({
          sample: async () => ({ text: "", packed_tokens: 0, method: "query-pack" }),
        }),
        meta: new MetaStore(":memory:"),
        autoStartSidecar: false,
        hooks: { graphNonempty: () => true },
      },
    );
    await expect(
      host.compact({ sessionKey: "sess-c2", instruction: "/compact" }),
    ).rejects.toBeInstanceOf(CompactError);
  });

  it("returns ok on nonempty pack", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "oc-compact-ok-"));
    const flush = vi.fn(async () => ({ reason: "compact" }));
    const host = createEngineHost(
      { ...RECALL_05_DEFAULTS, stateDir },
      {
        packer: mockPacker({ flush }),
        meta: new MetaStore(":memory:"),
        autoStartSidecar: false,
      },
    );
    const out = await host.compact({ sessionKey: "sess-c3" });
    expect(flush).toHaveBeenCalled();
    expect(out).toMatchObject({ ok: true, compacted: true });
    expect(out.entryText).toMatch(/HOT_SET|Decision/);
  });
});
