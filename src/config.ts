import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export type ProfileName = "recall-0.5" | "cursor-parity";
export type EngineImpl = "sidecar" | "ts";

export type CompressorConfig = {
  profile: ProfileName;
  stateDir: string;
  kMax: number;
  chunksPerTurn: number;
  poolEma: number;
  protectKinds: string[];
  forwardBudget: number;
  hotSetMaxChars: number;
  keepRecentTokens: number;
  noveltyBudgetFloor: number;
  rankFallbackTopK: number;
  matrixSpanReadout: boolean;
  matrixSpanK: number;
  ingestToolResults: boolean;
  skipHeartbeats: boolean;
  pythonPath: string;
  engineImpl: EngineImpl;
  promoteMemoryNotes: boolean;
  injectP1: boolean;
  shareGraphByAgent: boolean;
};

export type ConfigIssue = { path: string; message: string };

export type LoadConfigResult = {
  ok: true;
  raw: Record<string, unknown>;
  resolved: CompressorConfig;
  overlayWarnings: string[];
  explicitKeys: string[];
};

export class ConfigValidationError extends Error {
  readonly issues: ConfigIssue[];
  constructor(issues: ConfigIssue[]) {
    super(issues.map((i) => `${i.path}: ${i.message}`).join("; "));
    this.name = "ConfigValidationError";
    this.issues = issues;
  }
}

const FREE_OVERLAY = new Set([
  "stateDir",
  "pythonPath",
  "engineImpl",
  "skipHeartbeats",
  "promoteMemoryNotes",
  "shareGraphByAgent",
  "injectP1",
]);

const WARN_OVERLAY = new Set([
  "kMax",
  "chunksPerTurn",
  "poolEma",
  "forwardBudget",
  "hotSetMaxChars",
  "keepRecentTokens",
  "noveltyBudgetFloor",
  "rankFallbackTopK",
  "matrixSpanK",
  "protectKinds",
]);

export const RECALL_05_DEFAULTS: CompressorConfig = {
  profile: "recall-0.5",
  stateDir: "~/.openclaw/context-graphs",
  kMax: 64,
  chunksPerTurn: 16,
  poolEma: 0.5,
  protectKinds: ["path", "decision", "identifier"],
  forwardBudget: 2048,
  hotSetMaxChars: 800,
  keepRecentTokens: 4000,
  noveltyBudgetFloor: 1.0,
  rankFallbackTopK: 8,
  matrixSpanReadout: true,
  matrixSpanK: 8,
  ingestToolResults: true,
  skipHeartbeats: true,
  pythonPath: "auto",
  engineImpl: "sidecar",
  promoteMemoryNotes: false,
  injectP1: false,
  shareGraphByAgent: false,
};

export const CURSOR_PARITY_DEFAULTS: CompressorConfig = {
  ...RECALL_05_DEFAULTS,
  profile: "cursor-parity",
  kMax: 32,
  chunksPerTurn: 8,
  poolEma: 0.7,
  forwardBudget: 1024,
  hotSetMaxChars: 400,
  noveltyBudgetFloor: 0.5,
  rankFallbackTopK: 3,
};

const ALLOWED_KEYS = new Set<string>([
  "profile",
  ...Object.keys(RECALL_05_DEFAULTS),
]);

function asObject(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigValidationError([{ path: "$", message: "config must be an object" }]);
  }
  return value as Record<string, unknown>;
}

function typeIssue(path: string, expected: string): ConfigIssue {
  return { path, message: `expected ${expected}` };
}

function validateTypes(raw: Record<string, unknown>): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  for (const key of Object.keys(raw)) {
    if (!ALLOWED_KEYS.has(key)) {
      issues.push({ path: key, message: "unknown key (additionalProperties: false)" });
    }
  }
  if (raw.profile !== undefined && raw.profile !== "recall-0.5" && raw.profile !== "cursor-parity") {
    issues.push({ path: "profile", message: 'must be "recall-0.5" or "cursor-parity"' });
  }
  if (raw.engineImpl !== undefined && raw.engineImpl !== "sidecar" && raw.engineImpl !== "ts") {
    issues.push({ path: "engineImpl", message: 'must be "sidecar" or "ts"' });
  }
  const strings = ["stateDir", "pythonPath"] as const;
  for (const k of strings) {
    if (raw[k] !== undefined && typeof raw[k] !== "string") issues.push(typeIssue(k, "string"));
  }
  const ints = [
    "kMax",
    "chunksPerTurn",
    "forwardBudget",
    "hotSetMaxChars",
    "keepRecentTokens",
    "rankFallbackTopK",
    "matrixSpanK",
  ] as const;
  for (const k of ints) {
    if (raw[k] !== undefined && (!Number.isInteger(raw[k]) || (raw[k] as number) < 0)) {
      issues.push(typeIssue(k, "non-negative integer"));
    }
  }
  const nums = ["poolEma", "noveltyBudgetFloor"] as const;
  for (const k of nums) {
    if (raw[k] !== undefined && typeof raw[k] !== "number") issues.push(typeIssue(k, "number"));
  }
  const bools = [
    "matrixSpanReadout",
    "ingestToolResults",
    "skipHeartbeats",
    "promoteMemoryNotes",
    "injectP1",
    "shareGraphByAgent",
  ] as const;
  for (const k of bools) {
    if (raw[k] !== undefined && typeof raw[k] !== "boolean") issues.push(typeIssue(k, "boolean"));
  }
  if (raw.protectKinds !== undefined) {
    if (!Array.isArray(raw.protectKinds) || raw.protectKinds.some((x) => typeof x !== "string")) {
      issues.push(typeIssue("protectKinds", "string[]"));
    }
  }
  return issues;
}

export function expandStateDir(stateDir: string): string {
  const expanded = stateDir.replace(/^~(?=$|[/\\])/, homedir());
  if (!isAbsolute(expanded)) {
    throw new ConfigValidationError([
      { path: "stateDir", message: "must be absolute after ~ expansion" },
    ]);
  }
  return resolve(expanded);
}

export function loadManifestConfigSchema(): Record<string, unknown> {
  const here = dirname(fileURLToPath(import.meta.url));
  const manifestPath = join(here, "..", "openclaw.plugin.json");
  const json = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    configSchema: Record<string, unknown>;
  };
  return json.configSchema;
}

export function validateConfig(rawUnknown?: unknown): LoadConfigResult {
  const raw = asObject(rawUnknown);
  const issues = validateTypes(raw);
  if (issues.length) throw new ConfigValidationError(issues);

  const profile: ProfileName = (raw.profile as ProfileName | undefined) ?? "recall-0.5";
  const base =
    profile === "cursor-parity" ? { ...CURSOR_PARITY_DEFAULTS } : { ...RECALL_05_DEFAULTS };
  const explicitKeys = Object.keys(raw).filter((k) => k !== "profile");
  const overlayWarnings: string[] = [];
  const resolved: CompressorConfig = { ...base, profile };

  for (const key of explicitKeys) {
    const value = raw[key];
    (resolved as unknown as Record<string, unknown>)[key] = value;
    if (WARN_OVERLAY.has(key)) {
      overlayWarnings.push(`profile-owned knob "${key}" overlaid by operator`);
    } else if (!FREE_OVERLAY.has(key) && key !== "profile") {
      overlayWarnings.push(`unexpected overlay key "${key}"`);
    }
  }

  expandStateDir(resolved.stateDir);
  return { ok: true, raw, resolved, overlayWarnings, explicitKeys };
}

export { FREE_OVERLAY, WARN_OVERLAY };
