/**
 * CLI: openclaw compressor stats | status | purge (stub) | export
 * Handlers are in-process; no standalone HTTP server.
 */

import { existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  handleSummary,
  rejectUnsafeSessionId,
  telemetryDbForSession,
  type SummaryDTO,
} from "../api.ts";
import { expandStateDir, type CompressorConfig, validateConfig } from "../config.ts";
import { sanitize } from "../ids.ts";
import { createPacker, type PackerPort } from "../packer-port.ts";
import { TelemetryStore } from "../telemetry/store.ts";

export type CliIo = {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
};

const defaultIo: CliIo = {
  stdout: (s) => process.stdout.write(s.endsWith("\n") ? s : `${s}\n`),
  stderr: (s) => process.stderr.write(s.endsWith("\n") ? s : `${s}\n`),
};

export type CliDeps = {
  config?: CompressorConfig;
  packer?: PackerPort;
  /** Injected store (tests); skips filesystem open. */
  store?: TelemetryStore;
  storeFactory?: (dbPath: string) => TelemetryStore;
  nowMs?: () => number;
  io?: CliIo;
};

function pad(s: string | number, w: number): string {
  const t = String(s);
  if (t.length >= w) return t;
  return t + " ".repeat(w - t.length);
}

function padL(s: string | number, w: number): string {
  const t = String(s);
  if (t.length >= w) return t;
  return " ".repeat(w - t.length) + t;
}

export function formatStatsTable(dto: SummaryDTO, implHint?: string | null): string {
  const lines: string[] = [];
  lines.push(
    [
      pad("session", 16),
      padL("turns", 6),
      padL("tau_replay", 12),
      padL("tau_packed", 12),
      padL("dTau", 10),
      padL("eta", 8),
      pad("k/K", 8),
      pad("impl", 8),
    ].join(" "),
  );
  if (dto.status === "error" || !dto.data) {
    lines.push(`error: ${dto.error?.code ?? "unknown"} ${dto.error?.message ?? ""}`.trim());
    return lines.join("\n");
  }
  const d = dto.data;
  const eff = d.efficiency;
  const eta =
    eff.reductionRatio == null
      ? "NA"
      : `${(eff.reductionRatio * 100).toFixed(1)}%`;
  const k = d.health.matrixK;
  const kMax = d.health.matrixKMax;
  const kDisp =
    k != null && kMax != null ? `${k}/${kMax}` : "-";
  const impl =
    implHint ??
    (d.health.sidecarStatus === "ts"
      ? "ts"
      : d.health.sidecarStatus === "active"
        ? "sidecar"
        : d.health.sidecarStatus);
  lines.push(
    [
      pad(d.session.slice(0, 16), 16),
      padL(d.totalTurns, 6),
      padL(eff.totalTauReplay, 12),
      padL(eff.totalTauPacked, 12),
      padL(eff.savedTokens, 10),
      padL(eta, 8),
      pad(kDisp, 8),
      pad(impl, 8),
    ].join(" "),
  );
  lines.push("");
  lines.push(
    "Saved and reduction use estimator τ=(len+3)//4 on a named replay (pre-cut history vs pack). Not provider billing. unit=tau",
  );
  return lines.join("\n");
}

function resolveSessionFlag(
  sessionFlag: string | undefined,
  store: TelemetryStore | null,
): { ok: true; session: string } | { ok: false; exitCode: number; message: string } {
  if (!sessionFlag) {
    const last = store?.lastActiveSessionId() ?? null;
    if (!last) {
      return {
        ok: false,
        exitCode: 2,
        message: "usage: --session <id> required (no last-active session in db)",
      };
    }
    return { ok: true, session: last };
  }
  const bad = rejectUnsafeSessionId(sessionFlag);
  if (bad) {
    return { ok: false, exitCode: 2, message: `invalid session: ${bad}` };
  }
  return { ok: true, session: sanitize(sessionFlag) };
}

export async function runStatsCommand(
  args: { session?: string; json?: boolean },
  deps: CliDeps = {},
): Promise<number> {
  const io = deps.io ?? defaultIo;
  const config = deps.config ?? validateConfig({}).resolved;
  let opened: TelemetryStore | null = null;
  try {
    let store: TelemetryStore;
    let session: string;

    if (deps.store) {
      store = deps.store;
      const resolved = resolveSessionFlag(args.session, store);
      if (!resolved.ok) {
        io.stderr(resolved.message);
        return resolved.exitCode;
      }
      session = resolved.session;
    } else {
      if (!args.session) {
        io.stderr("usage: openclaw compressor stats --session <id> [--json]");
        return 2;
      }
      const probeSession = resolveSessionFlag(args.session, null);
      if (!probeSession.ok) {
        io.stderr(probeSession.message);
        return probeSession.exitCode;
      }
      session = probeSession.session;
      const dbPath = telemetryDbForSession(config, session);
      opened = deps.storeFactory
        ? deps.storeFactory(dbPath)
        : existsSync(dbPath)
          ? TelemetryStore.openReadonly(dbPath)
          : new TelemetryStore(":memory:");
      store = opened;
    }

    const dto = handleSummary({ session, store, config });
    if (args.json) {
      io.stdout(JSON.stringify(dto, null, 2));
    } else {
      io.stdout(formatStatsTable(dto, config.engineImpl));
    }
    return dto.status === "error" ? 1 : 0;
  } finally {
    opened?.close();
  }
}

function stageLogAgeMs(sessionStateDir: string, nowMs: number): number | null {
  const logsDir = join(sessionStateDir, "logs");
  if (!existsSync(logsDir)) return null;
  const names = readdirSync(logsDir).filter((n) => n.startsWith("stages-"));
  if (names.length === 0) return null;
  let newest = 0;
  for (const n of names) {
    const m = statSync(join(logsDir, n)).mtimeMs;
    if (m > newest) newest = m;
  }
  return nowMs - newest;
}

export async function runStatusCommand(
  args: { session?: string },
  deps: CliDeps = {},
): Promise<number> {
  const io = deps.io ?? defaultIo;
  const config = deps.config ?? validateConfig({}).resolved;
  const nowMs = deps.nowMs ?? Date.now;

  let session: string;
  if (args.session) {
    const bad = rejectUnsafeSessionId(args.session);
    if (bad) {
      io.stderr(`invalid session: ${bad}`);
      return 2;
    }
    session = sanitize(args.session);
  } else {
    io.stderr("usage: openclaw compressor status --session <id>");
    return 2;
  }

  const root = expandStateDir(config.stateDir);
  const sessionStateDir = join(root, session);
  const dbPath = telemetryDbForSession(config, session);
  const dbBytes = existsSync(dbPath) ? statSync(dbPath).size : 0;
  const age = stageLogAgeMs(sessionStateDir, nowMs());

  let healthOk = true;
  let healthDetail = "n/a";
  let python: string | null = null;
  try {
    const packer = deps.packer ?? createPacker(config);
    const h = await packer.health();
    healthOk = h.ok;
    python = h.python;
    healthDetail = h.ok ? "ok" : h.error ?? "not_ok";
    if (!deps.packer) await packer.dispose();
  } catch (err) {
    healthOk = false;
    healthDetail = err instanceof Error ? err.message : String(err);
  }

  const impl = config.engineImpl;
  const lines = [
    `impl=${impl}`,
    `health=${healthDetail}`,
    `python=${python ?? (impl === "ts" ? "n/a" : "unknown")}`,
    `stage_log_age_ms=${age == null ? "none" : age}`,
    `telemetry_db_bytes=${dbBytes}`,
    `session=${session}`,
    `unit=tau (status does not compute eta)`,
  ];
  io.stdout(lines.join("\n"));

  if (impl === "sidecar" && !healthOk) return 1;
  if (!healthOk && impl === "ts") return 1;
  return 0;
}

/**
 * Purge session state. Requires --confirm (confirm token = session id).
 * Destructive only under config.stateDir (fixture-safe).
 */
export async function runPurgeCommand(
  args: { session?: string; confirm?: boolean; iKnow?: boolean },
  deps: CliDeps = {},
): Promise<number> {
  const io = deps.io ?? defaultIo;
  const config = deps.config ?? validateConfig({}).resolved;

  if (!args.session) {
    io.stderr("usage: openclaw compressor purge --session <id> [--confirm]");
    return 2;
  }
  const bad = rejectUnsafeSessionId(args.session);
  if (bad) {
    io.stderr(`invalid session: ${bad}`);
    return 2;
  }
  const session = sanitize(args.session);
  const root = expandStateDir(config.stateDir);
  const sessionStateDir = join(root, session);
  const preview = [
    join(sessionStateDir, "graph.json"),
    join(sessionStateDir, "telemetry.sqlite"),
    join(sessionStateDir, "meta.sqlite"),
    join(sessionStateDir, "logs"),
  ];
  io.stdout("Would delete:");
  for (const p of preview) io.stdout(`  ${p}`);
  io.stdout(
    "Deletes local graph, spans, logs, and telemetry rows for this session id. Plugin stays installed.",
  );
  if (!args.confirm && !args.iKnow) {
    io.stderr("refusing: pass --confirm (confirm token = session id); exit 2, no delete");
    return 2;
  }
  const { purgeFromCli } = await import("../manage.ts");
  const result = purgeFromCli(config, { session: args.session, confirm: true });
  if (!result.ok) {
    io.stderr(result.error);
    return 2;
  }
  io.stdout(`purged session=${session} deleted=${String(result.data?.deleted ?? false)}`);
  return 0;
}

export async function runExportCommand(
  args: { session?: string; format?: "csv" | "json"; out?: string },
  deps: CliDeps = {},
): Promise<number> {
  const io = deps.io ?? defaultIo;
  const config = deps.config ?? validateConfig({}).resolved;
  if (!args.session) {
    io.stderr("usage: openclaw compressor export --session <id> [--format csv|json] [--out path]");
    return 2;
  }
  const bad = rejectUnsafeSessionId(args.session);
  if (bad) {
    io.stderr(`invalid session: ${bad}`);
    return 2;
  }
  const session = sanitize(args.session);
  const dbPath = telemetryDbForSession(config, session);
  const store = deps.storeFactory
    ? deps.storeFactory(dbPath)
    : existsSync(dbPath)
      ? TelemetryStore.openReadonly(dbPath)
      : null;
  if (!store) {
    io.stderr(`telemetry db missing: ${dbPath}`);
    return 1;
  }
  try {
    const { headers, rows } = store.exportTurnMetricsCsv(session);
    // Privacy: headers must be allowlisted count columns (no text/prompt/hot_set/pack).
    for (const h of headers) {
      if (/prompt|text|content|hot_set|pack/i.test(h) && h !== "pack_method") {
        io.stderr(`privacy fail: forbidden header ${h}`);
        return 1;
      }
    }
    const format = args.format ?? "csv";
    let body: string;
    if (format === "json") {
      body = JSON.stringify(
        rows.map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i]]))),
        null,
        2,
      );
    } else {
      const esc = (v: string | number | null) => {
        if (v == null) return "";
        const s = String(v);
        if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
        return s;
      };
      body = [headers.join(","), ...rows.map((r) => r.map(esc).join(","))].join("\n") + "\n";
    }
    if (args.out) {
      writeFileSync(args.out, body, "utf8");
      io.stderr(`wrote ${args.out}`);
    } else {
      io.stdout(body.trimEnd());
    }
    return 0;
  } finally {
    store.close();
  }
}

export type CliCommand = "stats" | "status" | "purge" | "export";

export function parseCompressorArgs(argv: string[]): {
  command?: CliCommand;
  session?: string;
  json?: boolean;
  confirm?: boolean;
  iKnow?: boolean;
  format?: "csv" | "json";
  out?: string;
} {
  const out: ReturnType<typeof parseCompressorArgs> = {};
  const cmd = argv[0];
  if (cmd === "stats" || cmd === "status" || cmd === "purge" || cmd === "export") {
    out.command = cmd;
  }
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--json") out.json = true;
    else if (a === "--confirm") out.confirm = true;
    else if (a === "--i-know") out.iKnow = true;
    else if (a === "--session") out.session = argv[++i];
    else if (a === "--format") {
      const f = argv[++i];
      if (f === "csv" || f === "json") out.format = f;
    } else if (a === "--out") out.out = argv[++i];
  }
  return out;
}

export async function runCompressorCli(argv: string[], deps: CliDeps = {}): Promise<number> {
  const io = deps.io ?? defaultIo;
  const parsed = parseCompressorArgs(argv);
  if (!parsed.command) {
    io.stderr("usage: openclaw compressor <stats|status|purge|export> ...");
    return 2;
  }
  switch (parsed.command) {
    case "stats":
      return runStatsCommand({ session: parsed.session, json: parsed.json }, deps);
    case "status":
      return runStatusCommand({ session: parsed.session }, deps);
    case "purge":
      return runPurgeCommand(
        { session: parsed.session, confirm: parsed.confirm, iKnow: parsed.iKnow },
        deps,
      );
    case "export":
      return runExportCommand(
        { session: parsed.session, format: parsed.format, out: parsed.out },
        deps,
      );
    default:
      return 2;
  }
}

/** Plugin SDK registration shape (registerCli). */
export function registerCompressorCli(
  api: {
    registerCli?: (opts: {
      name: string;
      description?: string;
      handler: (ctx: { args: string[] }) => Promise<number> | number;
    }) => void;
  },
  depsFactory?: () => CliDeps,
): void {
  if (typeof api.registerCli !== "function") return;
  api.registerCli({
    name: "compressor",
    description: "Compressor stats/status/purge (plugin namespace; unit=tau)",
    async handler(ctx) {
      const deps = depsFactory?.() ?? {};
      return runCompressorCli(ctx.args, deps);
    },
  });
}
