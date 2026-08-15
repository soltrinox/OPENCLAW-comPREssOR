/**
 * Control UI descriptor registration (Plan 09).
 * Prefer grouped `api.session.controls.registerControlUiDescriptor`;
 * fall back to flat `api.registerControlUiDescriptor` when present.
 */

export const COMPRESSOR_UI_ID = "compressor";
export const COMPRESSOR_UI_PATH = "/api/plugin/compressor/ui/dashboard";
export const COMPRESSOR_UI_FETCH = [
  "/api/plugin/compressor/stats/summary",
  "/api/plugin/compressor/stats/timeseries",
  "/api/plugin/compressor/state/capacity",
] as const;

export type ControlUiDescriptor = {
  surface: "tab";
  id: string;
  label: string;
  title?: string;
  description: string;
  placement?: string;
  path: string;
  icon?: string;
  group?: "control" | "agent";
  order?: number;
  requiredScopes: string[];
  requiredPermission?: string;
  fetch: readonly string[];
  namespace?: string;
};

export const COMPRESSOR_CONTROL_UI_DESCRIPTOR: ControlUiDescriptor = {
  surface: "tab",
  id: COMPRESSOR_UI_ID,
  label: "Compressor",
  title: "Compressor",
  description:
    "Compressor dashboard: efficiency (τ), capacity, stack composition, health, and operator manage actions (profile/flush/compact/purge).",
  placement: "control-ui-tab",
  path: COMPRESSOR_UI_PATH,
  icon: "gauge",
  group: "control",
  order: 40,
  requiredScopes: ["operator.read", "operator.write"],
  requiredPermission: "operator.write",
  fetch: COMPRESSOR_UI_FETCH,
  namespace: "compressor",
};

export type ControlUiRegistrarApi = {
  registerControlUiDescriptor?: (desc: ControlUiDescriptor) => void;
  session?: {
    controls?: {
      registerControlUiDescriptor?: (desc: ControlUiDescriptor) => void;
    };
  };
};

/** Returns true if a registrar was invoked. */
export function registerCompressorControlUi(api: ControlUiRegistrarApi): boolean {
  const grouped = api.session?.controls?.registerControlUiDescriptor;
  const flat = api.registerControlUiDescriptor;
  const register = typeof grouped === "function" ? grouped : typeof flat === "function" ? flat : null;
  if (!register) return false;
  register({ ...COMPRESSOR_CONTROL_UI_DESCRIPTOR });
  return true;
}
