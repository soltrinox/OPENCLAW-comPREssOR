import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import { randomUUID } from "node:crypto";
import { mkdirSync, createWriteStream, type WriteStream } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { CompressorConfig } from "../config.ts";
import {
  decodeResponse,
  encodeRequest,
  type SidecarCmd,
  type SidecarRequest,
  type SidecarResponse,
} from "./protocol.ts";
import {
  SidecarAppError,
  SidecarBootError,
  SidecarDeadError,
  SidecarTimeoutError,
} from "./errors.ts";
import { buildChildEnv, ensureVenv, engineRoot } from "./spawn.ts";

export type SidecarTimeouts = {
  bootMs: number;
  healthMs: number;
  sampleMs: number;
  stepMs: number;
  stepFlushMs: number;
  disposeMs: number;
};

export const DEFAULT_TIMEOUTS: SidecarTimeouts = {
  bootMs: 15_000,
  healthMs: 2_000,
  sampleMs: 10_000,
  stepMs: 30_000,
  stepFlushMs: 45_000,
  disposeMs: 5_000,
};

export type SidecarClientOptions = {
  config: CompressorConfig;
  storageRoot?: string;
  timeouts?: Partial<SidecarTimeouts>;
  /** Override python binary (already provisioned). */
  python?: string;
  stderrLogDir?: string;
};

export class SidecarClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private rl: Interface | null = null;
  private stderrStream: WriteStream | null = null;
  private readonly timeouts: SidecarTimeouts;
  private readonly config: CompressorConfig;
  private readonly storageRoot?: string;
  private readonly pythonOverride?: string;
  private readonly stderrLogDir: string;
  private mutex: Promise<void> = Promise.resolve();
  private dead = false;
  private bootstrapped = false;

  constructor(opts: SidecarClientOptions) {
    this.config = opts.config;
    this.storageRoot = opts.storageRoot;
    this.pythonOverride = opts.python;
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...opts.timeouts };
    this.stderrLogDir =
      opts.stderrLogDir ??
      join(homedir(), ".openclaw", "logs");
  }

  get ready(): boolean {
    return this.bootstrapped && !this.dead && this.child !== null;
  }

  async start(): Promise<void> {
    if (this.bootstrapped && this.child && !this.dead) return;

    let python = this.pythonOverride;
    if (!python) {
      const provisioned = ensureVenv({
        pythonPath: this.config.pythonPath,
        storageRoot: this.storageRoot,
        enginePath: engineRoot(),
      });
      python = provisioned.python;
    }

    mkdirSync(this.stderrLogDir, { recursive: true });
    const stderrPath = join(
      this.stderrLogDir,
      `sidecar-stderr-${new Date().toISOString().replace(/[:.]/g, "")}.log.txt`,
    );
    this.stderrStream = createWriteStream(stderrPath, { flags: "a" });

    const env = buildChildEnv(this.config);
    this.child = spawn(python, ["-m", "chat_compressor.claw_cli"], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.dead = false;

    this.child.on("exit", () => {
      this.dead = true;
      this.bootstrapped = false;
    });
    this.child.stderr.on("data", (buf: Buffer) => {
      this.stderrStream?.write(buf);
    });

    this.rl = createInterface({ input: this.child.stdout, crlfDelay: Infinity });

    try {
      const health = await this.request("health", undefined, {}, this.timeouts.bootMs);
      if (!health.ok) {
        throw new SidecarBootError(
          `boot health failed: ${health.error.code} ${health.error.message}`,
        );
      }
      this.bootstrapped = true;
    } catch (err) {
      await this.dispose();
      if (err instanceof SidecarBootError) throw err;
      throw new SidecarBootError(
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  private withMutex<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.mutex.then(fn, fn);
    this.mutex = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private timeoutFor(cmd: SidecarCmd, params?: Record<string, unknown>): number {
    if (cmd === "health") return this.timeouts.healthMs;
    if (cmd === "sample") return this.timeouts.sampleMs;
    if (cmd === "step") {
      return params?.flush_graph ? this.timeouts.stepFlushMs : this.timeouts.stepMs;
    }
    return this.timeouts.stepMs;
  }

  async request(
    cmd: SidecarCmd,
    agentId?: string,
    params: Record<string, unknown> = {},
    timeoutMs?: number,
  ): Promise<SidecarResponse> {
    return this.withMutex(async () => {
      if (!this.child || this.dead || !this.rl) {
        throw new SidecarDeadError("sidecar process is not alive");
      }
      const id = randomUUID();
      const req: SidecarRequest = {
        id,
        cmd,
        params,
      };
      if (agentId !== undefined) req.agent_id = agentId;
      const line = encodeRequest(req);
      const ms = timeoutMs ?? this.timeoutFor(cmd, params);

      return await new Promise<SidecarResponse>((resolve, reject) => {
        if (!this.child || !this.rl) {
          reject(new SidecarDeadError("sidecar process is not alive"));
          return;
        }

        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          this.rl?.removeListener("line", onLine);
          void this.killChild();
          reject(new SidecarTimeoutError(`sidecar ${cmd} timed out after ${ms}ms`));
        }, ms);

        const onLine = (raw: string) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          this.rl?.removeListener("line", onLine);
          try {
            const resp = decodeResponse(raw);
            if (resp.id && resp.id !== id) {
              // v1 is synchronous; unexpected id is protocol failure
              reject(new SidecarTimeoutError(`response id mismatch want=${id} got=${resp.id}`));
              return;
            }
            resolve(resp);
          } catch (err) {
            reject(err instanceof Error ? err : new Error(String(err)));
          }
        };

        this.rl.once("line", onLine);
        this.child.stdin.write(line + "\n", (err) => {
          if (err && !settled) {
            settled = true;
            clearTimeout(timer);
            this.rl?.removeListener("line", onLine);
            reject(new SidecarDeadError(`stdin write failed: ${err.message}`));
          }
        });
      });
    });
  }

  async call(
    cmd: SidecarCmd,
    agentId?: string,
    params: Record<string, unknown> = {},
    timeoutMs?: number,
  ): Promise<Record<string, unknown>> {
    const resp = await this.request(cmd, agentId, params, timeoutMs);
    if (!resp.ok) {
      throw new SidecarAppError(resp.error.code, resp.error.message);
    }
    return resp.result;
  }

  private async killChild(): Promise<void> {
    const child = this.child;
    this.child = null;
    this.bootstrapped = false;
    this.dead = true;
    this.rl?.close();
    this.rl = null;
    if (!child || child.killed) {
      this.stderrStream?.end();
      this.stderrStream = null;
      return;
    }
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
        resolve();
      }, this.timeouts.disposeMs);
      child.once("exit", () => {
        clearTimeout(t);
        resolve();
      });
      try {
        child.kill("SIGTERM");
      } catch {
        clearTimeout(t);
        resolve();
      }
    });
    this.stderrStream?.end();
    this.stderrStream = null;
  }

  async dispose(): Promise<void> {
    await this.killChild();
  }
}

/** Map ok:false / death / timeout into throws for quarantine. */
export async function callOrThrow(
  client: SidecarClient,
  cmd: SidecarCmd,
  agentId?: string,
  params?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return client.call(cmd, agentId, params);
}
