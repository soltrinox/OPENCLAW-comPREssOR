import { describe, expect, it, vi } from "vitest";
import { createEngineHost, type EnginePacker } from "../src/engine.ts";
import { RECALL_05_DEFAULTS } from "../src/config.ts";
import { MetaStore } from "../src/meta-store.ts";
import { toolGist } from "../src/ingest.ts";

function mockPacker(overrides: Partial<EnginePacker> = {}): EnginePacker & {
  step: ReturnType<typeof vi.fn>;
} {
  const step =
    (overrides.step as ReturnType<typeof vi.fn> | undefined) ??
    vi.fn(async () => ({ t: 1 }));
  return {
    async sample() {
      return { text: "pack", packed_tokens: 4, method: "query-pack" };
    },
    async flush() {
      return {};
    },
    async dispose() {},
    ...overrides,
    step,
  };
}

describe("engine.ingest", () => {
  it("skips heartbeat — sidecar.step not called", async () => {
    const packer = mockPacker();
    const host = createEngineHost(RECALL_05_DEFAULTS, {
      packer,
      meta: new MetaStore(":memory:"),
      autoStartSidecar: false,
    });
    const result = await host.ingest({
      sessionKey: "sess-hb",
      message: { role: "user", content: "ping", isHeartbeat: true },
    });
    expect(result.ingested).toBe(false);
    expect(result.skipped).toBe("heartbeat");
    expect(packer.step).not.toHaveBeenCalled();
  });

  it("tool gist omits 50k dump and includes exit/path/error", () => {
    const dump = "x".repeat(50_000);
    const msg = {
      role: "tool",
      toolName: "exec",
      content: `exit_code=1\n/tmp/openclaw/foo.ts\nError: boom\n${dump}`,
    };
    const gist = toolGist(msg);
    expect(gist.length).toBeLessThan(2000);
    expect(gist).toContain("exit=1");
    expect(gist).toMatch(/foo\.ts/);
    expect(gist).toMatch(/Error: boom|error=/);
    // Full dump must not appear; gist head caps at 512 chars of body.
    expect(gist.includes(dump)).toBe(false);
    expect(gist).not.toContain("x".repeat(600));
  });

  it("ingest-once: identical messages do not double-step", async () => {
    const packer = mockPacker();
    const host = createEngineHost(RECALL_05_DEFAULTS, {
      packer,
      meta: new MetaStore(":memory:"),
      autoStartSidecar: false,
    });
    const messages = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ];
    await host.ingestBatch({ sessionKey: "sess-once", messages });
    await host.ingestBatch({ sessionKey: "sess-once", messages });
    expect(packer.step).toHaveBeenCalledTimes(2);
  });
});
