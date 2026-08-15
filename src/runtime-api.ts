/**
 * SDK import adapter. OpenClaw betas move `plugin-sdk` subpaths.
 * Unit tests and local typecheck must not require a installed Gateway package.
 *
 * Documented host fields (docs.openclaw.ai, pluginApi floor >=2026.3.24-beta.2):
 * - package.json `openclaw.extensions` (TS local / workspace)
 * - package.json `openclaw.runtimeExtensions` (built dist for npm/ClawHub)
 * - `definePluginEntry` from `openclaw/plugin-sdk/plugin-entry`
 * - `api.registerContextEngine`, `api.lifecycle.registerRuntimeLifecycle`
 * - Plan 08: `api.registerCli`, `api.registerHttpRoute`, `api.registerGatewayMethod`
 *   (optional — missing adapters → CLI still ships via in-process handlers)
 * - Plan 09: `api.registerControlUiDescriptor` or
 *   `api.session.controls.registerControlUiDescriptor` (tab + path → sandboxed frame)
 *
 * Typed host seam (not yet observed on this machine's SDK):
 * `info.hostRequirements["agent-run"].requiredCapabilities` including
 * `assemble-before-prompt`. Declared on EngineHost.info anyway.
 */

export type PluginRegisterFn = (api: OpenClawPluginApi) => void;

export type OpenClawPluginApi = {
  registerContextEngine: (id: string, factory: (ctx: EngineFactoryCtx) => unknown) => void;
  registerMemoryCapability?: (capability: unknown) => void;
  lifecycle?: {
    registerRuntimeLifecycle: (hooks: {
      onReload?: () => void | Promise<void>;
      onShutdown?: () => void | Promise<void>;
      dispose?: () => void | Promise<void>;
    }) => void;
  };
  registerDoctorCheck?: (check: unknown) => void;
  securityAuditCollectors?: unknown;
  /** Plan 08 — plugin CLI group `compressor`. */
  registerCli?: (opts: {
    name: string;
    description?: string;
    handler: (ctx: { args: string[] }) => Promise<number> | number;
  }) => void;
  /** Plan 08 — HTTP/IPC GET adapters when Gateway exposes them. */
  registerHttpRoute?: (opts: {
    method: string;
    path: string;
    handler: (req: unknown) => unknown | Promise<unknown>;
  }) => void;
  registerGatewayMethod?: (opts: {
    method: string;
    handler: (req: unknown) => unknown | Promise<unknown>;
  }) => void;
  /** Plan 09 — Control UI tab descriptor (flat alias). */
  registerControlUiDescriptor?: (desc: unknown) => void;
  session?: {
    controls?: {
      registerControlUiDescriptor?: (desc: unknown) => void;
    };
  };
};

export type EngineFactoryCtx = {
  config?: Record<string, unknown>;
  agentDir?: string;
  workspaceDir?: string;
};

export type PluginEntryShape = {
  id: string;
  name: string;
  description: string;
  register: PluginRegisterFn;
  configSchema?: unknown;
};

/** Identity helper if `openclaw/plugin-sdk/plugin-entry` is not resolvable. */
export function definePluginEntry<T extends PluginEntryShape>(entry: T): T {
  return entry;
}

export function tryLoadHostDefinePluginEntry(): typeof definePluginEntry {
  return definePluginEntry;
}
