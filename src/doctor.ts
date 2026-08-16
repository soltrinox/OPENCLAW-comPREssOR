import { accessSync, constants, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { expandStateDir, type CompressorConfig } from "./config.ts";
import { sidecarDoctorFindings } from "./sidecar/doctor-checks.ts";
import {
  telemetryReadableForStatsFinding,
  telemetryWritableFinding,
} from "./telemetry/doctor.ts";
import { graphRoot } from "./ids.ts";

export type DoctorSeverity = "pass" | "warn" | "fail";

export type DoctorFinding = {
  id: string;
  severity: DoctorSeverity;
  message: string;
};

export type DoctorContext = {
  slot?: string;
  pluginEnabled?: boolean;
  config: CompressorConfig;
  /** Optional plugin storage root for venv (defaults to ~/.openclaw/compressor-venv). */
  storageRoot?: string;
  /** Optional session key for telemetry path probe. */
  sessionKey?: string;
  agentId?: string;
  /** Process counter from EngineHost.telemetryDropped(). */
  telemetryDropped?: number;
};

const KEEP_RECENT_WARN_THRESHOLD = 12000;

function parsePythonVersion(text: string): number[] | null {
  const m = text.match(/Python\s+(\d+)\.(\d+)/i);
  if (!m) return null;
  return [Number(m[1]), Number(m[2])];
}

function pythonDiscoverable(pythonPath: string): { ok: boolean; detail: string } {
  const bin = !pythonPath || pythonPath === "auto" ? "python3" : pythonPath;
  const result = spawnSync(bin, ["--version"], { encoding: "utf8" });
  const out = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  if (result.error || result.status !== 0) {
    return { ok: false, detail: `interpreter not runnable (${bin}): ${result.error?.message ?? out}` };
  }
  const ver = parsePythonVersion(out);
  if (!ver) return { ok: false, detail: `could not parse version from: ${out}` };
  if (ver[0] < 3 || (ver[0] === 3 && ver[1] < 11)) {
    return { ok: false, detail: `${out} is below 3.11` };
  }
  return { ok: true, detail: out };
}

function stateDirWritable(stateDir: string): { ok: boolean; detail: string } {
  try {
    const abs = expandStateDir(stateDir);
    mkdirSync(abs, { recursive: true });
    accessSync(abs, constants.W_OK);
    const probe = join(abs, `.compressor-doctor-${process.pid}`);
    writeFileSync(probe, "ok");
    unlinkSync(probe);
    return { ok: true, detail: abs };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

export function runDoctorChecks(ctx: DoctorContext): DoctorFinding[] {
  const findings: DoctorFinding[] = [];
  const slot = ctx.slot ?? "compressor";
  const enabled = ctx.pluginEnabled ?? true;

  if (slot === "compressor" && !enabled) {
    findings.push({
      id: "slot-plugin-mismatch",
      severity: "fail",
      message: "plugins.slots.contextEngine is compressor but entries.compressor.enabled is false",
    });
  } else {
    findings.push({
      id: "slot-plugin-mismatch",
      severity: "pass",
      message: "slot and plugin enablement agree (or slot is not compressor)",
    });
  }

  const writable = stateDirWritable(ctx.config.stateDir);
  findings.push({
    id: "stateDir-writable",
    severity: writable.ok ? "pass" : "fail",
    message: writable.ok
      ? `stateDir writable: ${writable.detail}`
      : `stateDir not writable: ${writable.detail}`,
  });

  if (ctx.config.engineImpl === "sidecar") {
    const extra = sidecarDoctorFindings(ctx.config, ctx.storageRoot);
    if (extra.length === 0) {
      const py = pythonDiscoverable(ctx.config.pythonPath);
      findings.push({
        id: "python-sidecar",
        severity: py.ok ? "pass" : "fail",
        message: py.ok
          ? `Python for sidecar: ${py.detail}`
          : `Python 3.11+ required for sidecar (${py.detail})`,
      });
    } else {
      for (const f of extra) findings.push(f);
    }
  } else if (ctx.config.engineImpl === "ts") {
    findings.push({
      id: "engine-impl-ts",
      severity: "pass",
      message: "engineImpl=ts: in-process packer; Python not required",
    });
  } else {
    findings.push({
      id: "engine-impl",
      severity: "fail",
      message: `unknown engineImpl=${String(ctx.config.engineImpl)}`,
    });
  }

  if (ctx.config.keepRecentTokens >= KEEP_RECENT_WARN_THRESHOLD) {
    findings.push({
      id: "keepRecentTokens-large",
      severity: "warn",
      message: `keepRecentTokens=${ctx.config.keepRecentTokens} can recreate last-N replay`,
    });
  }

  if (ctx.config.injectP1) {
    findings.push({
      id: "injectP1-debug",
      severity: "warn",
      message: "injectP1=true is debug-only; Pattern-1 is not a default forward channel",
    });
  }

  // Telemetry: warn if unwritable; never a hard fail (assemble must work).
  const sessionId = graphRoot(
    ctx.sessionKey,
    ctx.agentId,
    ctx.config.shareGraphByAgent,
  );
  const stateAbs = expandStateDir(ctx.config.stateDir);
  const sessionStateDir = join(stateAbs, sessionId);
  findings.push(
    telemetryWritableFinding(sessionStateDir, ctx.telemetryDropped ?? 0),
  );
  findings.push(telemetryReadableForStatsFinding(sessionStateDir));

  return findings;
}

export { KEEP_RECENT_WARN_THRESHOLD };
