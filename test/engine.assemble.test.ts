import { describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEngineHost, type EnginePacker } from "../src/engine.ts";
import { cutTail } from "../src/assemble.ts";
import { RECALL_05_DEFAULTS } from "../src/config.ts";
import { MetaStore } from "../src/meta-store.ts";
import { SidecarDeadError } from "../src/sidecar/errors.ts";
import type { ChatMessage } from "../src/messages.ts";

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
      };
    },
    async flush() {
      return {};
    },
    async dispose() {},
    ...overrides,
  };
}

describe("engine.assemble", () => {
  it("returns bounded tail + systemPromptAddition with pack text", async () => {
    const host = createEngineHost(
      { ...RECALL_05_DEFAULTS, keepRecentTokens: 200 },
      {
        packer: mockPacker(),
        meta: new MetaStore(":memory:"),
        autoStartSidecar: false,
        hooks: {
          buildMemorySystemPromptAddition: async () => "MEMORY: note",
        },
      },
    );
    const messages: ChatMessage[] = [];
    for (let i = 0; i < 100; i++) {
      messages.push({ role: "user", content: `turn-${i} ${"word ".repeat(40)}` });
      messages.push({ role: "assistant", content: `reply-${i} ${"ok ".repeat(40)}` });
    }
    const out = await host.assemble({
      sessionKey: "sess-asm",
      messages,
      prompt: "what next?",
    });
    expect(out.promptAuthority).toBe("assembled");
    expect(out.systemPromptAddition).toContain("HOT_SET:");
    expect(out.systemPromptAddition).toContain("STATE:");
    expect(out.systemPromptAddition).toContain("MEMORY: note");
    expect(out.messages.length).toBeLessThan(messages.length);
    expect(out.messages.length).toBeGreaterThan(0);
    // Tail should be toward the end of the fixture
    const last = out.messages[out.messages.length - 1]!;
    expect(String(last.content)).toMatch(/turn-99|reply-99/);
  });

  it("keeps tool call and result as a pair (both present or both absent)", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "run" },
      {
        role: "assistant",
        content: "calling",
        toolCalls: [{ id: "c1", name: "exec" }],
      },
      { role: "tool", toolCallId: "c1", content: "x".repeat(8000), toolName: "exec" },
    ];
    const cut = cutTail(messages, 50);
    const hasCall = cut.messages.some((m) => (m.toolCalls?.length ?? 0) > 0);
    const hasResult = cut.messages.some((m) => m.role === "tool");
    expect(hasCall).toBe(true);
    expect(hasResult).toBe(true);
    expect(cut.overBudget).toBe(true);

    // Aged-out pair: both omitted together when a later short turn fills the budget.
    const aged: ChatMessage[] = [
      {
        role: "assistant",
        content: "old",
        toolCalls: [{ id: "c0", name: "exec" }],
      },
      { role: "tool", toolCallId: "c0", content: "y".repeat(8000), toolName: "exec" },
      { role: "user", content: "short" },
      { role: "assistant", content: "ok" },
    ];
    const cut2 = cutTail(aged, 30);
    const hasCall2 = cut2.messages.some((m) => (m.toolCalls?.length ?? 0) > 0);
    const hasResult2 = cut2.messages.some((m) => m.role === "tool");
    expect(hasCall2).toBe(hasResult2);
  });

  it("memory addition mock is included", async () => {
    const mem = vi.fn(async () => "MEM_ADD");
    const host = createEngineHost(RECALL_05_DEFAULTS, {
      packer: mockPacker(),
      meta: new MetaStore(":memory:"),
      autoStartSidecar: false,
      hooks: { buildMemorySystemPromptAddition: mem },
    });
    const out = await host.assemble({
      sessionKey: "sess-mem",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(mem).toHaveBeenCalled();
    expect(out.systemPromptAddition).toContain("MEM_ADD");
  });

  it("sidecar dead — assemble throws (no full-message fallback)", async () => {
    const host = createEngineHost(RECALL_05_DEFAULTS, {
      packer: mockPacker({
        sample: async () => {
          throw new SidecarDeadError("sidecar process is not alive");
        },
      }),
      meta: new MetaStore(":memory:"),
      autoStartSidecar: false,
    });
    await expect(
      host.assemble({
        sessionKey: "sess-dead",
        messages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toBeInstanceOf(SidecarDeadError);
  });

  it("empty pack is not failure", async () => {
    const host = createEngineHost(RECALL_05_DEFAULTS, {
      packer: mockPacker({
        sample: async () => ({ text: "", packed_tokens: 0, method: "query-pack" }),
      }),
      meta: new MetaStore(":memory:"),
      autoStartSidecar: false,
    });
    const out = await host.assemble({
      sessionKey: "sess-empty-pack",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(out.messages.length).toBe(1);
    expect(out.systemPromptAddition).toContain("STATE:");
  });

  it("bootstrap empty graph + transcript calls ingestBatch", async () => {
    const step = vi.fn(async () => ({ t: 1 }));
    const stateDir = mkdtempSync(join(tmpdir(), "oc-boot-"));
    const host = createEngineHost(
      { ...RECALL_05_DEFAULTS, stateDir },
      {
        packer: mockPacker({ step }),
        meta: new MetaStore(":memory:"),
        autoStartSidecar: false,
        hooks: {
          readSessionTranscriptVisibleMessageDelta: () => [
            { role: "user", content: "recovered" },
            { role: "assistant", content: "ok" },
          ],
        },
      },
    );
    const result = await host.bootstrap({ sessionKey: "sess-boot-empty" });
    expect(result.recovered).toBe(true);
    expect(step).toHaveBeenCalled();
  });
});
