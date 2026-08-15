/**
 * Golden tests for ts-engine vs committed Python fixtures.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { estimateTokens } from "../src/ts-engine/metrics.ts";
import { hashedNgramEmbed } from "../src/ts-engine/embed.ts";
import { cosine } from "../src/ts-engine/rank.ts";
import { packForward } from "../src/ts-engine/pack.ts";
import { chunkText } from "../src/ts-engine/chunks.ts";
import { CtxGraph } from "../src/ts-engine/graph.ts";

const here = dirname(fileURLToPath(import.meta.url));
const goldens = join(here, "goldens");

describe("ts-engine goldens", () => {
  it("A6-2 estimate_tokens exact on golden strings", () => {
    const rows = JSON.parse(readFileSync(join(goldens, "tau.json"), "utf8")) as Array<{
      text: string;
      tau: number;
    }>;
    expect(rows.length).toBeGreaterThanOrEqual(20);
    for (const row of rows) {
      expect(estimateTokens(row.text), JSON.stringify(row.text)).toBe(row.tau);
    }
  });

  it("A6-3 embed cosine vs Python ≥ 0.999", () => {
    const vectors = JSON.parse(
      readFileSync(join(goldens, "embed_vectors.json"), "utf8"),
    ) as Record<string, number[]>;
    for (const [key, py] of Object.entries(vectors)) {
      const text = key === "(empty)" ? "" : key;
      const js = hashedNgramEmbed(text);
      const pyArr = Float32Array.from(py);
      const c = cosine(js, pyArr);
      expect(c, key).toBeGreaterThanOrEqual(0.999);
    }
  });

  it("A6-4 pack_forward golden exact given frozen lists", () => {
    const g = JSON.parse(readFileSync(join(goldens, "pack_order.json"), "utf8")) as {
      hot_set: string;
      typed_lines: string[];
      ranked_chunks: string[];
      budget: number;
      text: string;
      packed_tokens: number;
      method: string;
    };
    const packed = packForward({
      hot_set: g.hot_set,
      typed_lines: g.typed_lines,
      ranked_chunks: g.ranked_chunks,
      budget: g.budget,
    });
    expect(packed.text).toBe(g.text);
    expect(packed.packed_tokens).toBe(g.packed_tokens);
    expect(packed.method).toBe(g.method);
  });

  it("chunks golden matches structure", () => {
    const g = JSON.parse(readFileSync(join(goldens, "chunks.json"), "utf8")) as {
      input: string;
      chunks: string[];
    };
    const got = chunkText(g.input, 8);
    expect(got).toEqual(g.chunks);
  });

  it("A6-5 sample text starts with HOT_SET: on nonempty graph", () => {
    const graph = CtxGraph.load(join(goldens, "graph_fixture.json"));
    const hot = graph.hotSet("auth jwt", 800);
    expect(hot.length).toBeGreaterThan(0);
    const packed = packForward({
      hot_set: hot,
      typed_lines: graph.typedProjection("auth jwt", { hot_set: hot }),
      ranked_chunks: ["auth jwt wiring"],
      budget: 512,
    });
    expect(packed.text.startsWith("HOT_SET:")).toBe(true);
  });

  it("A6-10 identifier UUID appears in hot_set", () => {
    const hot = readFileSync(join(goldens, "hot_set.txt"), "utf8");
    // Recompute from fixture graph for TS path
    const graph = CtxGraph.load(join(goldens, "graph_fixture.json"));
    const tsHot = graph.hotSet("auth jwt", 800);
    expect(tsHot).toContain("550e8400-e29b-41d4-a716-446655440000");
    expect(hot).toContain("550e8400-e29b-41d4-a716-446655440000");
  });
});
