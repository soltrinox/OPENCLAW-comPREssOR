import { definePluginEntry, type EngineFactoryCtx, type OpenClawPluginApi } from "./runtime-api.ts";
import { loadManifestConfigSchema, validateConfig, type CompressorConfig } from "./config.ts";
import { createEngineHost, type EngineHost } from "./engine.ts";
import { registerDoctorChecks } from "./doctor.ts";
import { logResolvedConfig } from "./log.ts";
import {
  handleCapacity,
  handleSummary,
  handleTimeseries,
  telemetryDbForSession,
} from "./api.ts";
import {
  switchProfile,
  forceFlush,
  triggerCompact,
  purgeSession,
  manageJson,
  appendManageAudit,
} from "./manage.ts";
import { openclawToolResultMiddleware } from "./middleware/tool-result.ts";
import { registerCompressorCli } from "./cli/index.ts";
import {
  COMPRESSOR_UI_PATH,
  DASHBOARD_CONTENT_TYPE,
  dashboardHtmlFromApis,
  emptyDashboardHtml,
  registerCompressorControlUi,
  renderDashboardBody,
} from "./ui/index.ts";
import { existsSync } from "node:fs";
import { TelemetryStore } from "./telemetry/store.ts";

const hosts = new Set<EngineHost>();
let lastConfig: CompressorConfig = validateConfig({}).resolved;
/** Last created host — management POSTs target this. */
let primaryHost: EngineHost | null = null;

function factory(ctx: EngineFactoryCtx): EngineHost {
  const loaded = validateConfig(ctx.config);
  lastConfig = loaded.resolved as CompressorConfig;
  logResolvedConfig(loaded.resolved as CompressorConfig & Record<string, unknown>);
  const host = createEngineHost(loaded.resolved);
  hosts.add(host);
  primaryHost = host;
  return host;
}

async function disposeAll(): Promise<void> {
  for (const host of hosts) {
    await host.dispose();
  }
  hosts.clear();
  primaryHost = null;
}

function queryFromReq(req: unknown): { session?: string; limit?: number } {
  const r = req as {
    query?: Record<string, string>;
    params?: Record<string, string>;
    session?: string;
    limit?: number;
  };
  const session = r.query?.session ?? r.params?.session ?? r.session;
  const limitRaw = r.query?.limit ?? r.limit;
  const limit = limitRaw != null ? Number(limitRaw) : undefined;
  return { session, limit: Number.isFinite(limit) ? limit : undefined };
}

function bodyFromReq(req: unknown): Record<string, unknown> {
  const r = req as { body?: unknown; json?: unknown };
  const b = r.body ?? r.json ?? req;
  if (b && typeof b === "object" && !Array.isArray(b)) return b as Record<string, unknown>;
  return {};
}

function storeForSession(session: string | undefined): TelemetryStore | undefined {
  if (!session) return undefined;
  try {
    const path = telemetryDbForSession(lastConfig, session);
    if (!existsSync(path)) return undefined;
    return TelemetryStore.openReadonly(path);
  } catch {
    return undefined;
  }
}

function queryPartial(req: unknown): boolean {
  const r = req as { query?: Record<string, string>; partial?: string | boolean };
  const p = r.query?.partial ?? r.partial;
  return p === true || p === "1" || p === "true";
}

function buildDashboardResponse(req: unknown): { contentType: string; body: string } {
  const q = queryFromReq(req);
  const store = storeForSession(q.session);
  const summary = handleSummary({ ...q, store, config: lastConfig });
  const timeseries = handleTimeseries({ ...q, store, config: lastConfig });
  const capacity = handleCapacity({ ...q, store, config: lastConfig });
  const profileLabel = lastConfig.profile ?? "recall-0.5";
  const input = { summary, timeseries, capacity, profileLabel, mutationsEnabled: true };
  if (!q.session && summary.status === "error") {
    const body = queryPartial(req)
      ? renderDashboardBody({
          summary: {
            status: "empty",
            data: {
              totalTurns: 0,
              efficiency: { reductionRatio: null, savedTokens: 0, unit: "tau" },
            },
          },
          timeseries: {
            status: "empty",
            data: { turnIndex: [], tauReplay: [], tauPacked: [], assembleMs: [] },
          },
          capacity: {
            status: "empty",
            data: {
              matrix: { k: 0, kMax: 0, optional: true },
              graph: {
                turns: { active: 0, cap: 1 },
                durableFacts: { active: 0, cap: 1 },
                nonDurableFacts: { active: 0, cap: 1 },
              },
              prunedPerTurn: [],
            },
          },
          profileLabel,
          mutationsEnabled: true,
        })
      : emptyDashboardHtml();
    return { contentType: DASHBOARD_CONTENT_TYPE, body };
  }
  const body = queryPartial(req)
    ? renderDashboardBody(input)
    : dashboardHtmlFromApis(input);
  return { contentType: DASHBOARD_CONTENT_TYPE, body };
}

function registerHttpAdapters(api: OpenClawPluginApi): void {
  const routes: Array<{ method: string; path: string; run: (req: unknown) => unknown }> = [
    {
      method: "GET",
      path: "/api/plugin/compressor/stats/summary",
      run: (req) => {
        const q = queryFromReq(req);
        const store = storeForSession(q.session);
        return handleSummary({ ...q, store, config: lastConfig });
      },
    },
    {
      method: "GET",
      path: "/api/plugin/compressor/stats/timeseries",
      run: (req) => {
        const q = queryFromReq(req);
        const store = storeForSession(q.session);
        return handleTimeseries({ ...q, store, config: lastConfig });
      },
    },
    {
      method: "GET",
      path: "/api/plugin/compressor/state/capacity",
      run: (req) => {
        const q = queryFromReq(req);
        const store = storeForSession(q.session);
        return handleCapacity({ ...q, store, config: lastConfig });
      },
    },
    {
      method: "GET",
      path: COMPRESSOR_UI_PATH,
      run: (req) => {
        const { contentType, body } = buildDashboardResponse(req);
        return { statusCode: 200, headers: { "content-type": contentType }, body };
      },
    },
    {
      method: "POST",
      path: "/api/plugin/compressor/manage/profile",
      run: (req) => {
        const body = bodyFromReq(req);
        const host = primaryHost;
        if (!host) {
          return { statusCode: 503, body: { ok: false, error: "engine_not_ready" } };
        }
        const result = switchProfile(host, {
          profile: String(body.profile ?? ""),
          overlays: (body.overlays as Record<string, unknown>) ?? undefined,
          session: String(body.session ?? queryFromReq(req).session ?? ""),
        });
        lastConfig = host.resolvedConfig;
        if (result.ok && body.session) {
          appendManageAudit(host.resolvedConfig, String(body.session), {
            action: "profile",
            profile: body.profile,
          });
        }
        const j = manageJson(result);
        return { statusCode: j.statusCode, body: j.body };
      },
    },
    {
      method: "POST",
      path: "/api/plugin/compressor/manage/flush",
      run: async (req) => {
        const body = bodyFromReq(req);
        const host = primaryHost;
        if (!host) {
          return { statusCode: 503, body: { ok: false, error: "engine_not_ready" } };
        }
        const session = String(body.session ?? queryFromReq(req).session ?? "");
        const result = await forceFlush(host, { session });
        const j = manageJson(result);
        return { statusCode: j.statusCode, body: j.body };
      },
    },
    {
      method: "POST",
      path: "/api/plugin/compressor/manage/compact",
      run: async (req) => {
        const body = bodyFromReq(req);
        const host = primaryHost;
        if (!host) {
          return { statusCode: 503, body: { ok: false, error: "engine_not_ready" } };
        }
        const result = await triggerCompact(host, {
          session: String(body.session ?? ""),
          query: body.query != null ? String(body.query) : undefined,
          confirm: body.confirm as boolean | string | undefined,
        });
        const j = manageJson(result);
        return { statusCode: j.statusCode, body: j.body };
      },
    },
    {
      method: "POST",
      path: "/api/plugin/compressor/manage/purge",
      run: (req) => {
        const body = bodyFromReq(req);
        const config = primaryHost?.resolvedConfig ?? lastConfig;
        const result = purgeSession(config, {
          session: String(body.session ?? ""),
          confirm: body.confirm != null ? String(body.confirm) : undefined,
        });
        const j = manageJson(result);
        return { statusCode: j.statusCode, body: j.body };
      },
    },
  ];

  if (typeof api.registerHttpRoute === "function") {
    for (const route of routes) {
      api.registerHttpRoute({
        method: route.method,
        path: route.path,
        handler: route.run,
      });
    }
  } else if (typeof api.registerGatewayMethod === "function") {
    for (const route of routes) {
      api.registerGatewayMethod({
        method: `${route.method} ${route.path}`,
        handler: route.run,
      });
    }
  }

  const apiExt = api as OpenClawPluginApi & {
    registerAgentToolResultMiddleware?: (fn: typeof openclawToolResultMiddleware) => void;
  };
  if (typeof apiExt.registerAgentToolResultMiddleware === "function") {
    apiExt.registerAgentToolResultMiddleware(openclawToolResultMiddleware);
  }
}

export function register(api: OpenClawPluginApi): void {
  api.registerContextEngine("compressor", factory);
  api.lifecycle?.registerRuntimeLifecycle({
    onReload: disposeAll,
    onShutdown: disposeAll,
    dispose: disposeAll,
  });
  registerDoctorChecks(api, () => ({
    slot: "compressor",
    pluginEnabled: true,
    config: lastConfig,
  }));
  registerCompressorCli(api, () => ({ config: lastConfig }));
  registerHttpAdapters(api);
  registerCompressorControlUi(api);
}

const plugin = definePluginEntry({
  id: "compressor",
  name: "OpenClaw compressor",
  description:
    "Registers context engine id compressor with ingest/assemble/compact/commitTurn lifecycle.",
  configSchema: loadManifestConfigSchema(),
  register,
});

export default plugin;
export { factory };
export { COMPRESSOR_ENGINE_INFO, EngineNotReadyError } from "./engine.ts";
export { sanitize, graphRoot } from "./ids.ts";
export { validateConfig, ConfigValidationError } from "./config.ts";
export {
  handleSummary,
  handleTimeseries,
  handleCapacity,
  handlePostProfile,
} from "./api.ts";
export {
  switchProfile,
  forceFlush,
  triggerCompact,
  purgeSession,
  manageJson,
} from "./manage.ts";
export { openclawToolResultMiddleware } from "./middleware/tool-result.ts";
export { runCompressorCli, registerCompressorCli } from "./cli/index.ts";
