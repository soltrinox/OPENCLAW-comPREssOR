/**
 * Plan 10 — tool-result middleware assertions A10-1..A10-3, A10-15.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  TOOL_RESULT_GIST_THRESHOLD,
  reduceToolResult,
  reduceToolResultText,
} from "../src/middleware/tool-result.ts";
import { shouldSkipGroupBystander } from "../src/middleware/channel-ingest.ts";

const here = dirname(fileURLToPath(import.meta.url));

describe("middleware.tool (Plan 10)", () => {
  it("A10-1 7k tool result unchanged", () => {
    const raw = "x".repeat(7000);
    const out = reduceToolResultText(raw, { toolName: "exec" });
    expect(out.reduced).toBe(false);
    expect(out.text).toBe(raw);
    expect(out.text.length).toBe(7000);
  });

  it("A10-2 20k result reduced; ERROR line and path survive", () => {
    const path = "src/ids.ts";
    const errLine = "ERROR: src/ids.ts: missing sanitize";
    const raw =
      "head " +
      "y".repeat(19_000) +
      `\nexit_code=1\n${errLine}\npath=${path}\n`;
    expect(raw.length).toBeGreaterThan(TOOL_RESULT_GIST_THRESHOLD);
    const out = reduceToolResultText(raw, { toolName: "exec", exitCode: 1 });
    expect(out.reduced).toBe(true);
    expect(out.text.length).toBeLessThanOrEqual(TOOL_RESULT_GIST_THRESHOLD);
    expect(out.text).toMatch(/ERROR: src\/ids\.ts/);
    expect(out.text).toMatch(/ids\.ts/);
    expect(out.text).toMatch(/exit=1/);
  });

  it("A10-3 middleware throw → original result returned", async () => {
    const raw = "KEEP_ORIGINAL_" + "z".repeat(9000);
    const out = await reduceToolResult({
      resultText: raw,
      toolName: "exec",
      forceThrow: true,
    });
    expect(out.passThrough).toBe(true);
    expect(out.text).toBe(raw);
    expect(out.reduced).toBe(false);
  });

  it("A10-15 manifest lists openclaw middleware only", () => {
    const manifest = JSON.parse(
      readFileSync(join(here, "../openclaw.plugin.json"), "utf8"),
    ) as { contracts?: { agentToolResultMiddleware?: string[] } };
    expect(manifest.contracts?.agentToolResultMiddleware).toEqual(["openclaw"]);
    expect(manifest.contracts?.agentToolResultMiddleware).not.toContain("codex");
  });

  it("channel-aware: skip group bystander unless mentioned", () => {
    expect(
      shouldSkipGroupBystander({
        role: "user",
        text: "noise from other",
        isGroup: true,
        senderId: "other",
        selfId: "bot",
      }),
    ).toBe(true);
    expect(
      shouldSkipGroupBystander({
        role: "user",
        text: "@bot help",
        isGroup: true,
        senderId: "other",
        selfId: "bot",
        mentioned: true,
      }),
    ).toBe(false);
    expect(
      shouldSkipGroupBystander({
        role: "user",
        text: "dm",
        isGroup: false,
        senderId: "other",
        selfId: "bot",
      }),
    ).toBe(false);
  });
});
