/**
 * Widget builders — structural HTML fragments from view-models (Plan 09).
 * No Recharts dependency; SVG polylines / CSS bars only.
 */

import {
  DARK_THEME,
  type DashboardSnapshot,
  type ThemeTokens,
  TAU_CAPTION,
} from "../view-models.ts";

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function sparklineSvg(
  values: number[],
  opts: { width?: number; height?: number; stroke?: string; sla?: number; slaStroke?: string },
): string {
  const w = opts.width ?? 160;
  const h = opts.height ?? 36;
  if (values.length === 0) {
    return `<svg width="${w}" height="${h}" role="img" aria-label="no latency samples"></svg>`;
  }
  const max = Math.max(...values, opts.sla ?? 0, 1);
  const min = 0;
  const pts = values
    .map((v, i) => {
      const x = values.length === 1 ? w / 2 : (i / (values.length - 1)) * (w - 2) + 1;
      const y = h - 2 - ((v - min) / (max - min)) * (h - 4);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  let sla = "";
  if (opts.sla != null && opts.sla > 0) {
    const y = h - 2 - ((opts.sla - min) / (max - min)) * (h - 4);
    sla = `<line x1="0" y1="${y}" x2="${w}" y2="${y}" stroke="${opts.slaStroke ?? "#888"}" stroke-dasharray="3 3" stroke-width="1"/>`;
  }
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="latency sparkline">
  ${sla}
  <polyline fill="none" stroke="${opts.stroke ?? "#6fa8c9"}" stroke-width="1.5" points="${pts}"/>
</svg>`;
}

function areaChartSvg(
  chart: DashboardSnapshot["efficiency"]["chart"],
  theme: ThemeTokens,
): string {
  const w = 420;
  const h = 120;
  if (chart.length === 0) {
    return `<div class="empty">No turns yet — chart placeholder</div>`;
  }
  const packedVals = chart.map((p) => p.tauPacked ?? 0);
  const replayVals = chart.map((p) => (p.tauReplay != null ? p.tauReplay : null));
  const maxY = Math.max(
    ...packedVals,
    ...replayVals.filter((x): x is number => x != null),
    1,
  );
  const xAt = (i: number) =>
    chart.length === 1 ? w / 2 : (i / (chart.length - 1)) * (w - 8) + 4;
  const yAt = (v: number) => h - 4 - (v / maxY) * (h - 12);

  const packedPoly = chart
    .map((p, i) => `${xAt(i).toFixed(1)},${yAt(p.tauPacked ?? 0).toFixed(1)}`)
    .join(" ");
  const replayPts = chart
    .map((p, i) =>
      p.tauReplay == null ? null : `${xAt(i).toFixed(1)},${yAt(p.tauReplay).toFixed(1)}`,
    )
    .filter(Boolean)
    .join(" ");

  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="tau replay vs packed area chart">
  ${
    replayPts
      ? `<polyline fill="none" stroke="${theme.replay}" stroke-width="1.5" opacity="0.85" points="${replayPts}"/>`
      : ""
  }
  <polyline fill="none" stroke="${theme.packed}" stroke-width="2" points="${packedPoly}"/>
  <text x="4" y="12" fill="${theme.muted}" font-size="10">τ</text>
</svg>
<div class="legend"><span style="color:${theme.replay}">Replay estimate (pre-cut)</span>
 · <span style="color:${theme.packed}">Packed P_t</span></div>`;
}

function donutSvg(
  ratio: number | null,
  label: string,
  tone: string,
  theme: ThemeTokens,
): string {
  const r = 36;
  const c = 2 * Math.PI * r;
  const p = ratio == null ? 0 : Math.min(1, Math.max(0, ratio));
  const stroke = tone === "warn" ? theme.warn : theme.ok;
  const dash = `${(p * c).toFixed(1)} ${(c - p * c).toFixed(1)}`;
  return `<svg width="100" height="100" viewBox="0 0 100 100" role="img" aria-label="${esc(label)}">
  <circle cx="50" cy="50" r="${r}" fill="none" stroke="#2a2a2a" stroke-width="10"/>
  <circle cx="50" cy="50" r="${r}" fill="none" stroke="${stroke}" stroke-width="10"
    stroke-dasharray="${dash}" stroke-dashoffset="${(c / 4).toFixed(1)}"
    transform="rotate(-90 50 50)"/>
  <text x="50" y="54" text-anchor="middle" fill="${theme.fg}" font-size="12">${esc(label)}</text>
</svg>`;
}

export function renderWidget1Efficiency(snap: DashboardSnapshot, theme: ThemeTokens = DARK_THEME): string {
  return `<section class="widget" data-widget="efficiency" aria-label="Token efficiency">
  <h2>Efficiency</h2>
  <div class="kpis">
    <div class="kpi"><div class="kpi-label">Δ</div><div class="kpi-value">${esc(snap.efficiency.deltaLabel)}</div></div>
    <div class="kpi"><div class="kpi-label">η</div><div class="kpi-value" data-eta>${esc(snap.efficiency.etaLabel)}</div></div>
    <div class="kpi"><div class="kpi-label">unit</div><div class="kpi-value">τ</div></div>
  </div>
  ${areaChartSvg(snap.efficiency.chart, theme)}
  <p class="caption">${esc(TAU_CAPTION)}</p>
  ${snap.efficiency.chartNote ? `<p class="note">${esc(snap.efficiency.chartNote)}</p>` : ""}
</section>`;
}

export function renderWidget2Capacity(snap: DashboardSnapshot, theme: ThemeTokens = DARK_THEME): string {
  const m = snap.capacity.matrix;
  const bars = snap.capacity.graphBars
    .map(
      (b) => `<div class="bar-row">
      <span>${esc(b.label)}</span>
      <div class="bar-track"><div class="bar-fill" style="width:${b.cap ? Math.min(100, (100 * b.active) / b.cap) : 0}%;background:${theme.ranked}"></div></div>
      <span class="bar-num">${b.active}/${b.cap}</span>
    </div>`,
    )
    .join("");
  return `<section class="widget" data-widget="capacity" aria-label="Dual-state capacity">
  <h2>Capacity</h2>
  <div class="capacity-row">
    ${donutSvg(m.ratio, m.label, m.tone, theme)}
    <div class="bars">${bars || `<div class="empty">No capacity rows</div>`}</div>
  </div>
  <div class="prune">
    <span class="muted">Pruned nodes/turn</span>
    ${sparklineSvg(snap.capacity.prunedPerTurn, { stroke: theme.tail })}
  </div>
</section>`;
}

export function renderWidget3Stack(snap: DashboardSnapshot, theme: ThemeTokens = DARK_THEME): string {
  const c = snap.composition;
  let body: string;
  if (c.kind === "unavailable") {
    body = `<div class="empty" data-composition="unavailable">${esc(c.reason)}</div>`;
  } else if (c.kind === "empty") {
    body = `<div class="empty" data-composition="empty">Composition empty (sum=0)</div>`;
  } else {
    const colors: Record<string, string> = {
      hot: theme.hot,
      typed: theme.typed,
      ranked: theme.ranked,
      tail: theme.tail,
    };
    const segs = c.segments
      .map(
        (s) =>
          `<div class="stack-seg" style="width:${(s.pct * 100).toFixed(2)}%;background:${colors[s.id]}" title="${esc(s.label)} ${s.tokens} τ"></div>`,
      )
      .join("");
    const legend = c.segments
      .map((s) => `<span><i style="background:${colors[s.id]}"></i>${esc(s.label)} ${s.tokens} τ</span>`)
      .join(" ");
    body = `<div class="stack-bar" role="img" aria-label="context stack composition">${segs}</div>
    <div class="legend">${legend}</div>`;
  }
  return `<section class="widget" data-widget="stack" aria-label="Context stack composition">
  <h2>Context stack</h2>
  ${body}
</section>`;
}

export function renderWidget4Health(snap: DashboardSnapshot, theme: ThemeTokens = DARK_THEME): string {
  const tone = snap.quarantined ? theme.danger : theme.ok;
  const events =
    snap.health.events.length === 0
      ? `<li class="muted">No system events in payload (counts-only GETs)</li>`
      : snap.health.events
          .map((e) => `<li><code>${esc(e.code)}</code> — ${esc(e.label)}</li>`)
          .join("");
  return `<section class="widget" data-widget="health" aria-label="Diagnostics" data-quarantined="${snap.quarantined}">
  <h2>Diagnostics</h2>
  <div class="status-pill" style="border-color:${tone};color:${tone}">${esc(snap.health.statusLabel)}</div>
  <div class="latency">
    <span class="muted">assemble ms (visual target ${snap.health.slaMs}ms)</span>
    ${sparklineSvg(snap.health.latencyMs, {
      stroke: theme.ranked,
      sla: snap.health.slaMs,
      slaStroke: theme.muted,
    })}
  </div>
  <ul class="events">${events}</ul>
</section>`;
}

export function renderActionBar(snap: DashboardSnapshot): string {
  const enabled = snap.actions.some((a) => !a.disabled);
  const buttons = snap.actions
    .map((a) => {
      if (a.id === "profile") {
        if (a.disabled) {
          return `<label class="action">Profile
          <select disabled aria-disabled="true" title="${esc(a.title)}">
            <option>${esc(a.label)}</option>
          </select>
          <span class="plan-gate">${esc(a.planGate ?? "")}</span>
        </label>`;
        }
        return `<label class="action">Profile
          <select id="oc-profile" data-action="profile" title="${esc(a.title)}">
            <option value="recall-0.5"${a.label === "recall-0.5" ? " selected" : ""}>recall-0.5</option>
            <option value="cursor-parity"${a.label === "cursor-parity" ? " selected" : ""}>cursor-parity</option>
          </select>
        </label>`;
      }
      if (a.disabled) {
        return `<button type="button" disabled aria-disabled="true" data-action="${a.id}" title="${esc(a.title)}" onclick="return false;">
        ${esc(a.label)} <span class="plan-gate">${esc(a.planGate ?? "")}</span>
      </button>`;
      }
      return `<button type="button" data-action="${a.id}" title="${esc(a.title)}">${esc(a.label)}</button>`;
    })
    .join("");
  const modals = enabled
    ? `<dialog id="oc-confirm-compact">
  <p>Writes a typed checkpoint from HOT_SET and identifiers. Does not call the conversation model.</p>
  <label><input type="checkbox" id="oc-compact-confirm"/> I confirm (no LLM)</label>
  <menu><button type="button" id="oc-compact-ok">Compact</button><button type="button" id="oc-compact-cancel">Cancel</button></menu>
</dialog>
<dialog id="oc-confirm-purge">
  <p>Deletes local dual-state files and telemetry rows for session <code id="oc-purge-sid"></code>. The plugin remains installed. Other sessions are not deleted. Type the session id to confirm.</p>
  <input type="text" id="oc-purge-confirm" autocomplete="off" placeholder="session id"/>
  <menu><button type="button" id="oc-purge-ok" disabled>Purge</button><button type="button" id="oc-purge-cancel">Cancel</button></menu>
</dialog>`
    : "";
  return `<div class="action-bar" data-mutations="${enabled ? "enabled" : "plan-10-disabled"}">${buttons}</div>${modals}`;
}

export function renderAllWidgets(snap: DashboardSnapshot, theme: ThemeTokens = DARK_THEME): string {
  const banner = snap.quarantined
    ? `<div class="banner danger" role="status">Engine quarantined; Gateway on legacy. KPIs frozen — not zeroed.</div>`
    : "";
  return `${banner}
${renderActionBar(snap)}
<div class="grid">
  ${renderWidget1Efficiency(snap, theme)}
  ${renderWidget2Capacity(snap, theme)}
  ${renderWidget3Stack(snap, theme)}
  ${renderWidget4Health(snap, theme)}
</div>`;
}
