/**
 * Doctor helpers for telemetry.sqlite writability (warn, never hard-fail assemble).
 * Plan 08 adds readable-for-stats check.
 */

import { accessSync, constants, existsSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DoctorFinding } from "../doctor.ts";
import { TelemetryStore, telemetryDbPath } from "./store.ts";

export function telemetryWritableFinding(
  sessionStateDir: string,
  dropped = 0,
): DoctorFinding {
  const path = telemetryDbPath(sessionStateDir);
  try {
    mkdirSync(dirname(path), { recursive: true });
    if (!existsSync(path)) {
      // Create empty schema so doctor can integrity-check.
      const store = new TelemetryStore(path);
      store.close();
    }
    accessSync(path, constants.W_OK);
    // Probe append via temp sibling write then unlink marker.
    const probe = join(dirname(path), `.telemetry-doctor-${process.pid}`);
    writeFileSync(probe, "ok");
    unlinkSync(probe);

    let integrity = "skipped";
    try {
      const store = new TelemetryStore(path);
      integrity = store.integrityOk() ? "ok" : "fail";
      store.close();
    } catch {
      integrity = "fail";
    }

    const dropNote = dropped > 0 ? `; telemetry_dropped=${dropped}` : "";
    return {
      id: "telemetry-writable",
      severity: integrity === "fail" ? "warn" : "pass",
      message:
        integrity === "fail"
          ? `telemetry.sqlite integrity_check failed: ${path}${dropNote}`
          : `telemetry.sqlite writable: ${path}${dropNote}`,
    };
  } catch (err) {
    return {
      id: "telemetry-writable",
      severity: "warn",
      message: `telemetry.sqlite not writable (assemble still ok): ${
        err instanceof Error ? err.message : String(err)
      } path=${path}${dropped > 0 ? `; telemetry_dropped=${dropped}` : ""}`,
    };
  }
}

/** Plan 08: stats path requires readable telemetry.sqlite (warn if not). */
export function telemetryReadableForStatsFinding(sessionStateDir: string): DoctorFinding {
  const path = telemetryDbPath(sessionStateDir);
  try {
    if (!existsSync(path)) {
      return {
        id: "telemetry-readable-stats",
        severity: "warn",
        message: `telemetry.sqlite missing for stats (ok until first assemble): ${path}`,
      };
    }
    accessSync(path, constants.R_OK);
    const store = TelemetryStore.openReadonly(path);
    try {
      store.countTurns();
      const ok = store.integrityOk();
      return {
        id: "telemetry-readable-stats",
        severity: ok ? "pass" : "warn",
        message: ok
          ? `telemetry.sqlite readable for stats: ${path}`
          : `telemetry.sqlite readable but integrity_check failed: ${path}`,
      };
    } finally {
      store.close();
    }
  } catch (err) {
    return {
      id: "telemetry-readable-stats",
      severity: "warn",
      message: `telemetry.sqlite not readable for stats: ${
        err instanceof Error ? err.message : String(err)
      } path=${path}`,
    };
  }
}
