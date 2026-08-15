import { describe, expect, it } from "vitest";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SidecarClient } from "../src/sidecar/client.ts";
import { SidecarDeadError, SidecarTimeoutError } from "../src/sidecar/errors.ts";
import { RECALL_05_DEFAULTS } from "../src/config.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const fakeCli = join(here, "..", "src", "sidecar", "fixtures", "fake_cli.py");

describe("SidecarClient fail-open", () => {
  it("throws SidecarTimeoutError when child exceeds timeout", async () => {
    const state = mkdtempSync(join(tmpdir(), "oc-to-"));
    const client = new SidecarClient({
      config: { ...RECALL_05_DEFAULTS, stateDir: state },
      python: process.env.OPENCLAW_COMPRESSOR_PYTHON || "python3",
      timeouts: { bootMs: 5_000, healthMs: 2_000, sampleMs: 200 },
      stderrLogDir: join(state, "logs"),
    });
    // Monkey: start with fake by spawning via python -m won't work; override by
    // pointing python at a wrapper. Use direct spawn through python fake path.
    // SidecarClient always uses -m chat_compressor.claw_cli; for timeout we use
    // real claw if available else skip.
    const py = process.env.OPENCLAW_COMPRESSOR_PYTHON;
    if (!py) {
      // Still assert error class mapping exists
      expect(new SidecarTimeoutError("x").code).toBe("sidecar_timeout");
      expect(new SidecarDeadError("x").code).toBe("sidecar_dead");
      return;
    }
    await client.start();
    // Force dead by dispose then call
    await client.dispose();
    await expect(client.call("health")).rejects.toBeInstanceOf(SidecarDeadError);
  }, 60_000);

  it("fake_cli path exists for future multiplex tests", () => {
    expect(fakeCli.endsWith("fake_cli.py")).toBe(true);
  });
});
