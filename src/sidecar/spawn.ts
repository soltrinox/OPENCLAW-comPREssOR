import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  realpathSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import type { CompressorConfig } from "../config.ts";
import { expandStateDir } from "../config.ts";
import { SidecarProvisionError } from "./errors.ts";

export type VenvMeta = {
  python: string;
  enginePath: string;
  version: string;
  createdAt: string;
};

export type SpawnEnv = Record<string, string>;

const ENGINE_VERSION = "0.2.0-openclaw";

export function engineRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "..", "engine");
}

export function discoverPython(pythonPath: string): string {
  const candidates =
    !pythonPath || pythonPath === "auto"
      ? ["python3", "python"]
      : [pythonPath];
  for (const bin of candidates) {
    const r = spawnSync(bin, ["--version"], { encoding: "utf8" });
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
    if (r.error || r.status !== 0) continue;
    const m = out.match(/Python\s+(\d+)\.(\d+)/i);
    if (!m) continue;
    const major = Number(m[1]);
    const minor = Number(m[2]);
    if (major > 3 || (major === 3 && minor >= 11)) return bin;
  }
  throw new SidecarProvisionError(
    `Python 3.11+ not found (pythonPath=${pythonPath || "auto"})`,
  );
}

export function defaultVenvDir(storageRoot?: string): string {
  const root =
    storageRoot?.trim() ||
    join(homedir(), ".openclaw", "compressor-venv");
  return resolve(root);
}

export function projectConfigEnv(config: CompressorConfig): SpawnEnv {
  const stateDir = expandStateDir(config.stateDir);
  return {
    CHAT_COMPRESSOR_STATE_DIR: stateDir,
    K_MAX: String(config.kMax),
    CHAT_COMPRESSOR_FORWARD_BUDGET: String(config.forwardBudget),
    CHAT_COMPRESSOR_INJECT_P1: config.injectP1 ? "1" : "0",
    CHAT_COMPRESSOR_EMA: String(config.poolEma),
    CHAT_COMPRESSOR_CHUNKS_PER_TURN: String(config.chunksPerTurn),
    CHAT_COMPRESSOR_PROTECT_KINDS: config.protectKinds.join(","),
    CHAT_COMPRESSOR_NOVELTY_FLOOR: String(config.noveltyBudgetFloor),
    CHAT_COMPRESSOR_RANK_FALLBACK_TOP_K: String(config.rankFallbackTopK),
    CHAT_COMPRESSOR_HOTSET_MAX_CHARS: String(config.hotSetMaxChars),
  };
}

export function buildChildEnv(config: CompressorConfig): NodeJS.ProcessEnv {
  const overlay = projectConfigEnv(config);
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    LANG: process.env.LANG ?? "en_US.UTF-8",
    LC_ALL: process.env.LC_ALL,
    USER: process.env.USER,
    TMPDIR: process.env.TMPDIR,
    ...overlay,
  };
  // Do not inherit Cursor chat-compressor.env path accidentally.
  delete env.CHAT_COMPRESSOR_ENV_FILE;
  return env;
}

function pipTail(output: string, n = 30): string {
  const lines = output.split(/\r?\n/).filter(Boolean);
  return lines.slice(-n).join("\n");
}

function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number },
): SpawnSyncReturns<string> {
  return spawnSync(cmd, args, {
    encoding: "utf8",
    cwd: opts.cwd,
    env: opts.env,
    timeout: opts.timeoutMs ?? 600_000,
  });
}

export function venvPythonPath(venvDir: string): string {
  const unix = join(venvDir, "bin", "python");
  const win = join(venvDir, "Scripts", "python.exe");
  if (existsSync(unix)) return unix;
  if (existsSync(win)) return win;
  return unix;
}

export function readVenvMeta(venvDir: string): VenvMeta | null {
  const metaPath = join(venvDir, "venv.meta.json");
  if (!existsSync(metaPath)) return null;
  try {
    return JSON.parse(readFileSync(metaPath, "utf8")) as VenvMeta;
  } catch {
    return null;
  }
}

export function ensureVenv(options: {
  pythonPath: string;
  storageRoot?: string;
  enginePath?: string;
}): { python: string; venvDir: string; meta: VenvMeta; reused: boolean } {
  const basePython = discoverPython(options.pythonPath);
  const venvDir = defaultVenvDir(options.storageRoot);
  const eng = options.enginePath ?? engineRoot();
  mkdirSync(venvDir, { recursive: true });

  const existing = readVenvMeta(venvDir);
  const py = venvPythonPath(venvDir);
  if (
    existing &&
    existing.version === ENGINE_VERSION &&
    existsSync(py) &&
    existing.enginePath === eng
  ) {
    return { python: py, venvDir, meta: existing, reused: true };
  }

  if (!existsSync(py)) {
    const created = run(basePython, ["-m", "venv", venvDir], {});
    if (created.status !== 0) {
      const out = `${created.stdout ?? ""}${created.stderr ?? ""}`;
      throw new SidecarProvisionError(`venv create failed: ${out}`, pipTail(out));
    }
  }

  const pip = run(
    py,
    ["-m", "pip", "install", "-e", eng],
    { timeoutMs: 600_000 },
  );
  const pipOut = `${pip.stdout ?? ""}${pip.stderr ?? ""}`;
  if (pip.status !== 0) {
    // one automatic retry
    const retry = run(py, ["-m", "pip", "install", "-e", eng], { timeoutMs: 600_000 });
    const retryOut = `${retry.stdout ?? ""}${retry.stderr ?? ""}`;
    if (retry.status !== 0) {
      throw new SidecarProvisionError(
        `pip install -e engine failed`,
        pipTail(`${pipOut}\n${retryOut}`),
      );
    }
  }

  const meta: VenvMeta = {
    python: py,
    enginePath: eng,
    version: ENGINE_VERSION,
    createdAt: new Date().toISOString(),
  };
  writeFileSync(join(venvDir, "venv.meta.json"), JSON.stringify(meta, null, 2));
  return { python: py, venvDir, meta, reused: false };
}

export function venvExists(storageRoot?: string): boolean {
  const venvDir = defaultVenvDir(storageRoot);
  const meta = readVenvMeta(venvDir);
  return Boolean(meta && existsSync(venvPythonPath(venvDir)));
}

export function fingerprintConfigEnv(config: CompressorConfig): string {
  const env = projectConfigEnv(config);
  const keys = Object.keys(env).sort();
  const payload = keys.map((k) => `${k}=${env[k]}`).join("\n");
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

export function resolveEngineDirForSmoke(): string {
  try {
    return realpathSync(engineRoot());
  } catch {
    return engineRoot();
  }
}
