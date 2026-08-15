import { describe, expect, it } from "vitest";
import {
  assertProtocolInvariants,
  decodeResponse,
  encodeRequest,
} from "../src/sidecar/protocol.ts";
import { projectConfigEnv } from "../src/sidecar/spawn.ts";
import { RECALL_05_DEFAULTS } from "../src/config.ts";
import { runDoctorChecks } from "../src/doctor.ts";
import { SidecarTimeoutError } from "../src/sidecar/errors.ts";

describe("sidecar protocol", () => {
  it("encode/decode round-trip and ignore unknown fields", () => {
    const line = encodeRequest({ id: "abc", cmd: "health", params: {} });
    expect(line).toContain('"cmd":"health"');
    const resp = decodeResponse(
      '{"id":"abc","ok":true,"result":{"python":"3.13.0"},"extra":true}',
    );
    expect(resp.ok).toBe(true);
    if (resp.ok) expect(resp.result.python).toBe("3.13.0");
  });

  it("missing ok is protocol error", () => {
    expect(() => decodeResponse('{"result":{}}')).toThrow();
  });

  it("assertProtocolInvariants", () => {
    expect(() => assertProtocolInvariants()).not.toThrow();
  });
});

describe("env projection", () => {
  it("projects OpenClaw stateDir not Cursor", () => {
    const env = projectConfigEnv(RECALL_05_DEFAULTS);
    expect(env.CHAT_COMPRESSOR_STATE_DIR).toContain("openclaw");
    expect(env.CHAT_COMPRESSOR_STATE_DIR).not.toContain(".cursor");
    expect(env.K_MAX).toBe("64");
    expect(env.CHAT_COMPRESSOR_INJECT_P1).toBe("0");
    expect(env.CHAT_COMPRESSOR_EMA).toBe("0.5");
  });
});

describe("doctor sidecar upgrade", () => {
  it("fails sidecar-venv when venv missing", () => {
    const findings = runDoctorChecks({
      config: { ...RECALL_05_DEFAULTS },
      storageRoot: `/tmp/openclaw-no-venv-${process.pid}`,
    });
    const venv = findings.find((f) => f.id === "sidecar-venv");
    expect(venv?.severity).toBe("fail");
  });
});

describe("error mapping", () => {
  it("SidecarTimeoutError has code", () => {
    const e = new SidecarTimeoutError("boom");
    expect(e.code).toBe("sidecar_timeout");
  });
});
