import { existsSync } from "node:fs";
import { join } from "node:path";
import type { CompressorConfig } from "../config.ts";
import { defaultVenvDir, discoverPython, readVenvMeta, venvPythonPath } from "./spawn.ts";
import { SidecarClient } from "./client.ts";

/** Mirrors DoctorFinding without importing doctor.ts (file-lock friendly). */
export type SidecarDoctorFinding = {
  id: string;
  severity: "pass" | "warn" | "fail";
  message: string;
};

/**
 * Sidecar-aware doctor findings (Plan 02).
 * Wired from runDoctorChecks when engineImpl=sidecar.
 */
export function sidecarDoctorFindings(
  config: CompressorConfig,
  storageRoot?: string,
): SidecarDoctorFinding[] {
  const findings: SidecarDoctorFinding[] = [];
  if (config.engineImpl !== "sidecar") {
    return findings;
  }

  try {
    const bin = discoverPython(config.pythonPath);
    findings.push({
      id: "python-sidecar",
      severity: "pass",
      message: `Python for sidecar discoverable: ${bin}`,
    });
  } catch (err) {
    findings.push({
      id: "python-sidecar",
      severity: "fail",
      message: err instanceof Error ? err.message : String(err),
    });
    return findings;
  }

  const venvDir = defaultVenvDir(storageRoot);
  const meta = readVenvMeta(venvDir);
  const py = venvPythonPath(venvDir);
  if (!meta || !existsSync(py)) {
    findings.push({
      id: "sidecar-venv",
      severity: "fail",
      message: `venv missing under ${venvDir}; run ensureVenv / first EngineHost start`,
    });
    return findings;
  }

  findings.push({
    id: "sidecar-venv",
    severity: "pass",
    message: `venv ready: ${py} (version=${meta.version})`,
  });

  // Optional live health if process can boot quickly; best-effort.
  // Doctor must not hang: short boot timeout.
  return findings;
}

export async function probeSidecarHealth(
  config: CompressorConfig,
  storageRoot?: string,
): Promise<SidecarDoctorFinding> {
  const client = new SidecarClient({
    config,
    storageRoot,
    timeouts: { bootMs: 15_000, healthMs: 2_000 },
    stderrLogDir: join(defaultVenvDir(storageRoot), "doctor-logs"),
  });
  try {
    await client.start();
    const result = await client.call("health");
    return {
      id: "sidecar-health",
      severity: "pass",
      message: `sidecar health ok python=${String(result.python)} handles=${String(result.handles)}`,
    };
  } catch (err) {
    return {
      id: "sidecar-health",
      severity: "fail",
      message: err instanceof Error ? err.message : String(err),
    };
  } finally {
    await client.dispose();
  }
}
