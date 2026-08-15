import { describe, expect, it } from "vitest";
import { createEngineHost, type EnginePacker } from "../src/engine.ts";
import { RECALL_05_DEFAULTS } from "../src/config.ts";
import { MetaStore } from "../src/meta-store.ts";

function mockPacker(): EnginePacker {
  return {
    async step() {
      return { t: 1 };
    },
    async sample() {
      return { text: "p", packed_tokens: 1 };
    },
    async flush() {
      return {};
    },
    async dispose() {},
  };
}

describe("engine.commit", () => {
  it("retry with same advancementKey returns duplicate", async () => {
    const meta = new MetaStore(":memory:");
    const host = createEngineHost(RECALL_05_DEFAULTS, {
      packer: mockPacker(),
      meta,
      autoStartSidecar: false,
    });
    const args = {
      sessionKey: "sess-commit",
      advancementKey: "turn-abc",
      messages: [
        { role: "user", content: "a" },
        { role: "assistant", content: "b" },
      ],
    };
    const first = await host.commitTurn(args);
    const second = await host.commitTurn(args);
    expect(first.status).toBe("committed");
    expect(second.status).toBe("duplicate");
  });

  it("parallel commitTurn: one committed, one duplicate, no throw", async () => {
    const meta = new MetaStore(":memory:");
    const host = createEngineHost(RECALL_05_DEFAULTS, {
      packer: mockPacker(),
      meta,
      autoStartSidecar: false,
    });
    const key = "turn-parallel";
    const results = await Promise.all([
      host.commitTurn({ sessionKey: "sess-p", advancementKey: key, messages: [] }),
      host.commitTurn({ sessionKey: "sess-p", advancementKey: key, messages: [] }),
    ]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual(["committed", "duplicate"]);
  });

  it("subagent hooks no-op without throw (Plan 10 fork)", async () => {
    const host = createEngineHost(RECALL_05_DEFAULTS, {
      packer: mockPacker(),
      meta: new MetaStore(":memory:"),
      autoStartSidecar: false,
    });
    await expect(host.prepareSubagentSpawn({})).resolves.toMatchObject({ ok: true });
    await expect(host.onSubagentEnded({})).resolves.toMatchObject({ ok: true });
  });
});
