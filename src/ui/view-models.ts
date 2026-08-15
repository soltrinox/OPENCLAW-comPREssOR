/**
 * Pure view-models for Control UI widgets (Plan 09).
 * Testable without DOM / browser. Counts only — never pack or graph text.
 */

export const UNIT_TAU = "tau" as const;
export const TAU_CAPTION =
  "unit=tau (chars/4), not billed tokens — estimator for operator-local accounting";
export const SLA_MS_VISUAL = 200; // display guide only; not a contractual SLO
export const EMPTY_ETA_LABEL = "n/a (replay τ undefined)";
export const EMPTY_KPI = "—";

export type SaturationTone = "ok" | "warn" | "na";

/** η = 1 − Στ(P)/Στ(R). When sumR==0 returns 0 (math); UI must use formatEta for null. */
export function eta(sumR: number, sumP: number): number {
  if (sumR === 0) return 0;
  return 1 - sumP / sumR;
}

export function delta(sumR: number, sumP: number): number {
  return sumR - sumP;
}

/** k/Kmax or null when matrix is optional / absent. */
export function saturation(k: number | null | undefined, kMax: number | null | undefined): number | null {
  if (k == null || kMax == null || kMax <= 0) return null;
  return k / kMax;
}

export function saturationTone(p: number | null | undefined): SaturationTone {
  if (p == null || !Number.isFinite(p)) return "na";
  return p > 0.8 ? "warn" : "ok";
}

/** One decimal percent string from ratio in [0,1]. Does not invent values. */
export function formatPct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

/**
 * Honest η display: null → n/a (never "0%"); empty session → em-dash.
 * Pass reductionRatio from Plan 08 summary when available.
 */
export function formatEta(
  reductionRatio: number | null | undefined,
  opts?: { emptySession?: boolean },
): string {
  if (opts?.emptySession) return EMPTY_KPI;
  if (reductionRatio === null || reductionRatio === undefined) return EMPTY_ETA_LABEL;
  if (!Number.isFinite(reductionRatio)) return EMPTY_ETA_LABEL;
  return formatPct(reductionRatio);
}

export function formatDelta(savedTokens: number | null | undefined, emptySession?: boolean): string {
  if (emptySession || savedTokens == null || !Number.isFinite(savedTokens)) return EMPTY_KPI;
  return `${Math.trunc(savedTokens)} τ saved`;
}

export function formatKOverKmax(
  k: number | null | undefined,
  kMax: number | null | undefined,
  matrixOptional?: boolean,
): { label: string; ratio: number | null; tone: SaturationTone } {
  if (matrixOptional && (k == null || kMax == null || kMax <= 0)) {
    return { label: "n/a (span index / optional matrix)", ratio: null, tone: "na" };
  }
  if (k == null || kMax == null || kMax <= 0) {
    return { label: "n/a", ratio: null, tone: "na" };
  }
  const ratio = k / kMax;
  return {
    label: `${k}/${kMax}`,
    ratio,
    tone: saturationTone(ratio),
  };
}

export type FamilyTokens = {
  hotSetTokens: number | null;
  typedLinesTokens: number | null;
  rankedSpanTokens: number | null;
  recentTailTokens: number | null;
};

export type CompositionSegment = {
  id: "hot" | "typed" | "ranked" | "tail";
  label: string;
  tokens: number;
  pct: number;
};

export type CompositionView =
  | { kind: "ok"; segments: CompositionSegment[]; total: number }
  | { kind: "empty" }
  | { kind: "unavailable"; reason: string };

/** 100% stacked composition. Null family → unavailable (never fake 25% quarters). */
export function compositionFromFamily(family: FamilyTokens | null | undefined): CompositionView {
  if (!family) {
    return {
      kind: "unavailable",
      reason: "Composition requires packer family fields (Plan 04/06).",
    };
  }
  const vals = [
    family.hotSetTokens,
    family.typedLinesTokens,
    family.rankedSpanTokens,
    family.recentTailTokens,
  ];
  if (vals.some((v) => v == null || !Number.isFinite(v))) {
    return {
      kind: "unavailable",
      reason: "Composition requires packer family fields (Plan 04/06).",
    };
  }
  const hot = Number(family.hotSetTokens);
  const typed = Number(family.typedLinesTokens);
  const ranked = Number(family.rankedSpanTokens);
  const tail = Number(family.recentTailTokens);
  const total = hot + typed + ranked + tail;
  if (total <= 0) return { kind: "empty" };
  const segs: CompositionSegment[] = [
    { id: "hot", label: "HOT_SET", tokens: hot, pct: hot / total },
    { id: "typed", label: "typed", tokens: typed, pct: typed / total },
    { id: "ranked", label: "ranked", tokens: ranked, pct: ranked / total },
    { id: "tail", label: "tail", tokens: tail, pct: tail / total },
  ];
  return { kind: "ok", segments: segs, total };
}

export type EfficiencyChartPoint = {
  turn: number;
  tauReplay: number | null;
  tauPacked: number | null;
};

/** Skip missing replay series points; always keep packed when present. */
export function chartPointsFromTimeseries(data: {
  turnIndex: number[];
  tauReplay: Array<number | null>;
  tauPacked: Array<number | null>;
}): EfficiencyChartPoint[] {
  const out: EfficiencyChartPoint[] = [];
  const n = data.turnIndex.length;
  for (let i = 0; i < n; i++) {
    out.push({
      turn: data.turnIndex[i]!,
      tauReplay: data.tauReplay[i] ?? null,
      tauPacked: data.tauPacked[i] ?? null,
    });
  }
  return out;
}

export type SystemEventView = { code: string; label: string; timestamp?: number };

const EVENT_LABELS: Record<string, string> = {
  graph_flushed: "Graph flushed to disk",
  compact_ok: "Compact ok",
  budget: "Budget applied",
  quarantined: "Engine quarantined; Gateway on legacy",
};

export function mapSystemEventCode(code: string): string {
  if (EVENT_LABELS[code]) return EVENT_LABELS[code]!;
  if (code.startsWith("budget=")) return `Budget ${code.slice("budget=".length)} τ`;
  return code.replace(/_/g, " ");
}

export function systemEventsView(
  codes: Array<{ code: string; timestamp?: number }> | null | undefined,
): SystemEventView[] {
  if (!codes || codes.length === 0) return [];
  return codes.slice(-5).map((e) => ({
    code: e.code,
    label: mapSystemEventCode(e.code),
    timestamp: e.timestamp,
  }));
}

export type SidecarStatus = "active" | "quarantined" | "ts" | "stopped";

export function mapSidecarStatusLabel(status: SidecarStatus | string): string {
  if (status === "ts") return "in-process (ts)";
  if (status === "active") return "sidecar active";
  if (status === "quarantined") return "quarantined";
  if (status === "stopped") return "stopped";
  return String(status);
}

export type ActionBarControl = {
  id: "profile" | "flush" | "compact" | "purge";
  label: string;
  disabled: boolean;
  planGate?: string;
  title: string;
};

/** Mutations deferred — visible but inert (legacy Plan 09). */
export function disabledActionBar(profileLabel = "recall-0.5"): ActionBarControl[] {
  const title =
    "Enable in management phase (Plan 10): profile switch / flush / compact / purge.";
  return [
    {
      id: "profile",
      label: profileLabel,
      disabled: true,
      planGate: "Plan 10",
      title,
    },
    { id: "flush", label: "Flush", disabled: true, planGate: "Plan 10", title },
    { id: "compact", label: "Compact", disabled: true, planGate: "Plan 10", title },
    { id: "purge", label: "Purge", disabled: true, planGate: "Plan 10", title },
  ];
}

/** Plan 10 — mutations enabled against manage POSTs. */
export function enabledActionBar(profileLabel = "recall-0.5"): ActionBarControl[] {
  return [
    {
      id: "profile",
      label: profileLabel,
      disabled: false,
      title: "Switch profile (recall-0.5 | cursor-parity). Does not wipe session graph.",
    },
    {
      id: "flush",
      label: "Flush",
      disabled: false,
      title: "Force packer.flush; emits graph_flushed.",
    },
    {
      id: "compact",
      label: "Compact",
      disabled: false,
      title:
        "Writes a typed checkpoint from HOT_SET and identifiers. Does not call the conversation model.",
    },
    {
      id: "purge",
      label: "Purge",
      disabled: false,
      title:
        "Deletes local dual-state files and telemetry rows for this session. Type the session id to confirm.",
    },
  ];
}

export type ThemeTokens = {
  bg: string;
  fg: string;
  muted: string;
  replay: string;
  packed: string;
  hot: string;
  typed: string;
  ranked: string;
  tail: string;
  warn: string;
  ok: string;
  danger: string;
};

/** Dark-mode compatible muted data-viz palette (dashboard plan). */
export const DARK_THEME: ThemeTokens = {
  bg: "#111111",
  fg: "#e6e6e6",
  muted: "#9a9a9a",
  replay: "#6b4f4f",
  packed: "#3d7a6a",
  hot: "#4b2d6b",
  typed: "#3a3f8c",
  ranked: "#6fa8c9",
  tail: "#7a7a7a",
  warn: "#c9a227",
  ok: "#3d7a6a",
  danger: "#a33a3a",
};

export type DashboardSnapshot = {
  emptySession: boolean;
  quarantined: boolean;
  efficiency: {
    deltaLabel: string;
    etaLabel: string;
    unitCaption: string;
    chart: EfficiencyChartPoint[];
    chartNote?: string;
  };
  capacity: {
    matrix: ReturnType<typeof formatKOverKmax>;
    graphBars: Array<{ id: string; label: string; active: number; cap: number }>;
    prunedPerTurn: number[];
  };
  composition: CompositionView;
  health: {
    statusLabel: string;
    status: string;
    latencyMs: number[];
    slaMs: number;
    events: SystemEventView[];
  };
  actions: ActionBarControl[];
  freezeKpis: boolean;
};

export type SummaryLike = {
  status: string;
  data?: {
    totalTurns?: number;
    efficiency?: {
      savedTokens?: number;
      reductionRatio?: number | null;
      unit?: string;
    };
    health?: {
      sidecarStatus?: string;
      avgLatencyMs?: number;
      matrixK?: number | null;
      matrixKMax?: number | null;
      matrixSaturationPct?: number | null;
    };
  };
};

export type TimeseriesLike = {
  status: string;
  data?: {
    turnIndex: number[];
    tauReplay: Array<number | null>;
    tauPacked: Array<number | null>;
    budgetMax?: Array<number | null>;
    assembleMs?: Array<number | null>;
    hotSetTokens?: Array<number | null>;
    typedLinesTokens?: Array<number | null>;
    rankedSpanTokens?: Array<number | null>;
    recentTailTokens?: Array<number | null>;
  };
};

export type CapacityLike = {
  status: string;
  data?: {
    matrix: { k: number; kMax: number; optional: boolean };
    graph: {
      turns: { active: number; cap: number };
      durableFacts: { active: number; cap: number };
      nonDurableFacts: { active: number; cap: number };
    };
    prunedPerTurn: number[];
  };
};

function lastFamilyFromTimeseries(ts: TimeseriesLike["data"]): FamilyTokens | null {
  if (!ts) return null;
  const n = ts.turnIndex?.length ?? 0;
  if (n === 0) return null;
  const i = n - 1;
  if (
    !ts.hotSetTokens ||
    !ts.typedLinesTokens ||
    !ts.rankedSpanTokens ||
    !ts.recentTailTokens
  ) {
    return null;
  }
  return {
    hotSetTokens: ts.hotSetTokens[i] ?? null,
    typedLinesTokens: ts.typedLinesTokens[i] ?? null,
    rankedSpanTokens: ts.rankedSpanTokens[i] ?? null,
    recentTailTokens: ts.recentTailTokens[i] ?? null,
  };
}

/** Bind Plan 08 GET payloads into a dashboard snapshot (no DOM). */
export function buildDashboardSnapshot(input: {
  summary: SummaryLike;
  timeseries: TimeseriesLike;
  capacity: CapacityLike;
  profileLabel?: string;
  systemEvents?: Array<{ code: string; timestamp?: number }>;
  /** Plan 10: enable manage POSTs in action bar (default true). */
  mutationsEnabled?: boolean;
}): DashboardSnapshot {
  const emptySession =
    input.summary.status === "empty" ||
    (input.summary.data?.totalTurns ?? 0) === 0;
  const status = input.summary.data?.health?.sidecarStatus ?? "stopped";
  const quarantined = status === "quarantined";
  const eff = input.summary.data?.efficiency;
  const matrix = input.capacity.data?.matrix;
  const chart = input.timeseries.data
    ? chartPointsFromTimeseries(input.timeseries.data)
    : [];
  const totalTurns = input.summary.data?.totalTurns ?? 0;
  const chartNote =
    chart.length > 0 && chart.length < totalTurns
      ? `chart shows last ${chart.length} turns`
      : undefined;
  const mutations = input.mutationsEnabled !== false;

  return {
    emptySession,
    quarantined,
    freezeKpis: quarantined,
    efficiency: {
      deltaLabel: formatDelta(eff?.savedTokens, emptySession),
      etaLabel: formatEta(eff?.reductionRatio ?? null, { emptySession }),
      unitCaption: TAU_CAPTION,
      chart,
      chartNote,
    },
    capacity: {
      matrix: formatKOverKmax(matrix?.k, matrix?.kMax, matrix?.optional),
      graphBars: input.capacity.data
        ? [
            {
              id: "turns",
              label: "Turns",
              active: input.capacity.data.graph.turns.active,
              cap: input.capacity.data.graph.turns.cap,
            },
            {
              id: "durable",
              label: "Durable facts",
              active: input.capacity.data.graph.durableFacts.active,
              cap: input.capacity.data.graph.durableFacts.cap,
            },
            {
              id: "nondurable",
              label: "Non-durable",
              active: input.capacity.data.graph.nonDurableFacts.active,
              cap: input.capacity.data.graph.nonDurableFacts.cap,
            },
          ]
        : [],
      prunedPerTurn: input.capacity.data?.prunedPerTurn ?? [],
    },
    composition: compositionFromFamily(lastFamilyFromTimeseries(input.timeseries.data)),
    health: {
      statusLabel: mapSidecarStatusLabel(status),
      status,
      latencyMs: (input.timeseries.data?.assembleMs ?? []).map((x) => x ?? 0),
      slaMs: SLA_MS_VISUAL,
      events: systemEventsView(input.systemEvents),
    },
    actions: mutations
      ? enabledActionBar(input.profileLabel ?? "recall-0.5")
      : disabledActionBar(input.profileLabel ?? "recall-0.5"),
  };
}
