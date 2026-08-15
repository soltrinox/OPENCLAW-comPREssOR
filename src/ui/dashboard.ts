/**
 * Self-contained dashboard HTML for Control UI sandboxed iframe (Plan 09).
 * Served via registerHttpRoute — no standalone listen().
 * Client polls the same GET path while visible; mutations stay disabled in markup.
 */

import {
  DARK_THEME,
  buildDashboardSnapshot,
  type SummaryLike,
  type TimeseriesLike,
  type CapacityLike,
} from "./view-models.ts";
import { renderAllWidgets } from "./widgets/render.ts";
import { COMPRESSOR_UI_FETCH } from "./descriptors.ts";

export const DASHBOARD_CONTENT_TYPE = "text/html; charset=utf-8";

const THEME_CSS = `
:root {
  --oc-bg: ${DARK_THEME.bg};
  --oc-fg: ${DARK_THEME.fg};
  --oc-muted: ${DARK_THEME.muted};
}
* { box-sizing: border-box; }
body {
  margin: 0; padding: 12px;
  font-family: ui-sans-serif, system-ui, sans-serif;
  background: var(--oc-bg, ${DARK_THEME.bg});
  color: var(--oc-fg, ${DARK_THEME.fg});
  font-size: 13px;
}
h1 { font-size: 16px; font-weight: 600; margin: 0 0 8px; }
h2 { font-size: 13px; font-weight: 600; margin: 0 0 8px; color: ${DARK_THEME.muted}; text-transform: uppercase; letter-spacing: 0.04em; }
.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
@media (max-width: 900px) { .grid { grid-template-columns: 1fr; } }
.widget { border: 1px solid #2a2a2a; padding: 10px; border-radius: 4px; background: #161616; }
.kpis { display: flex; gap: 12px; margin-bottom: 8px; }
.kpi { flex: 1; }
.kpi-label { color: ${DARK_THEME.muted}; font-size: 11px; }
.kpi-value { font-size: 18px; font-variant-numeric: tabular-nums; }
.caption, .note, .muted { color: ${DARK_THEME.muted}; font-size: 12px; }
.caption { margin-top: 6px; }
.legend { margin-top: 4px; font-size: 11px; color: ${DARK_THEME.muted}; }
.legend i { display: inline-block; width: 8px; height: 8px; margin-right: 4px; }
.capacity-row { display: flex; gap: 12px; align-items: center; }
.bars { flex: 1; }
.bar-row { display: grid; grid-template-columns: 100px 1fr 48px; gap: 6px; align-items: center; margin: 4px 0; }
.bar-track { height: 8px; background: #2a2a2a; border-radius: 2px; overflow: hidden; }
.bar-fill { height: 100%; }
.bar-num { font-variant-numeric: tabular-nums; text-align: right; }
.stack-bar { display: flex; height: 18px; border-radius: 2px; overflow: hidden; background: #2a2a2a; }
.stack-seg { height: 100%; }
.status-pill { display: inline-block; padding: 2px 8px; border: 1px solid; border-radius: 999px; margin-bottom: 8px; }
.events { margin: 8px 0 0; padding-left: 18px; }
.action-bar { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; align-items: center; }
.action-bar button, .action-bar select {
  background: #1c1c1c; color: ${DARK_THEME.fg}; border: 1px solid #333;
  padding: 6px 10px; border-radius: 3px; cursor: pointer; opacity: 1;
}
.action-bar button:disabled, .action-bar select:disabled {
  color: ${DARK_THEME.muted}; cursor: not-allowed; opacity: 0.7;
}
.action-bar[data-mutations="enabled"] button:not(:disabled) {
  border-color: ${DARK_THEME.ok};
}
.plan-gate { font-size: 10px; color: ${DARK_THEME.warn}; margin-left: 4px; }
.banner.danger {
  background: #2a1515; color: #e8a0a0; border: 1px solid ${DARK_THEME.danger};
  padding: 8px; margin-bottom: 10px; border-radius: 3px;
}
.empty { color: ${DARK_THEME.muted}; padding: 12px 0; }
.error { color: ${DARK_THEME.danger}; }
.meta { color: ${DARK_THEME.muted}; font-size: 11px; margin-bottom: 8px; }
`;

/** Inner widget markup only (partial refresh). */
export function renderDashboardBody(input: {
  summary: SummaryLike;
  timeseries: TimeseriesLike;
  capacity: CapacityLike;
  profileLabel?: string;
  systemEvents?: Array<{ code: string; timestamp?: number }>;
  mutationsEnabled?: boolean;
}): string {
  const snap = buildDashboardSnapshot(input);
  return renderAllWidgets(snap, DARK_THEME);
}

export function renderDashboardDocument(bodyHtml: string, opts?: { title?: string }): string {
  const title = opts?.title ?? "Compressor";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${title}</title>
<style>${THEME_CSS}</style>
</head>
<body>
  <h1>Compressor</h1>
  <p class="meta">Operator controls · fetches ${COMPRESSOR_UI_FETCH.join(", ")} · unit=tau</p>
  <div id="root">${bodyHtml}</div>
  <script>
(function () {
  var POLL_MS = 5000;
  var POLL_BACKOFF_MS = 15000;
  var timer = null;
  var visibleSince = Date.now();
  function sessionId() {
    try {
      return new URLSearchParams(location.search).get("session") || "";
    } catch (_) { return ""; }
  }
  function pollInterval() {
    return Date.now() - visibleSince > 3600000 ? POLL_BACKOFF_MS : POLL_MS;
  }
  function stopPoll() {
    if (timer) clearInterval(timer);
    timer = null;
  }
  function startPoll() {
    stopPoll();
    visibleSince = Date.now();
    timer = setInterval(function () { void refresh(); }, pollInterval());
  }
  async function refresh() {
    if (document.hidden) return;
    try {
      var url = location.pathname + location.search + (location.search ? "&" : "?") + "partial=1&_=" + Date.now();
      var res = await fetch(url, { credentials: "same-origin", headers: { "Accept": "text/html" } });
      if (!res.ok) return;
      var html = await res.text();
      var root = document.getElementById("root");
      if (root) root.innerHTML = html;
      bindActions();
    } catch (_) { /* keep last paint */ }
  }
  async function postManage(path, body) {
    var res = await fetch(path, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify(body)
    });
    var json = null;
    try { json = await res.json(); } catch (_) {}
    return { ok: res.ok && json && json.ok, status: res.status, json: json };
  }
  function bindActions() {
    var root = document.getElementById("root");
    if (!root) return;
    var sid = sessionId();
    var profile = root.querySelector("#oc-profile");
    if (profile && !profile._bound) {
      profile._bound = true;
      profile.addEventListener("change", function () {
        void postManage("/api/plugin/compressor/manage/profile", {
          session: sid, profile: profile.value
        }).then(function () { void refresh(); });
      });
    }
    root.querySelectorAll("[data-action]").forEach(function (btn) {
      if (btn._bound || btn.tagName === "SELECT") return;
      btn._bound = true;
      btn.addEventListener("click", function () {
        var action = btn.getAttribute("data-action");
        if (action === "flush") {
          void postManage("/api/plugin/compressor/manage/flush", { session: sid }).then(function () { void refresh(); });
        } else if (action === "compact") {
          var d = document.getElementById("oc-confirm-compact");
          if (d && d.showModal) d.showModal();
        } else if (action === "purge") {
          var p = document.getElementById("oc-confirm-purge");
          var label = document.getElementById("oc-purge-sid");
          if (label) label.textContent = sid;
          var inp = document.getElementById("oc-purge-confirm");
          var ok = document.getElementById("oc-purge-ok");
          if (inp) { inp.value = ""; }
          if (ok) ok.disabled = true;
          if (p && p.showModal) p.showModal();
        }
      });
    });
    var cOk = document.getElementById("oc-compact-ok");
    if (cOk && !cOk._bound) {
      cOk._bound = true;
      cOk.addEventListener("click", function () {
        var cb = document.getElementById("oc-compact-confirm");
        if (!cb || !cb.checked) return;
        var d = document.getElementById("oc-confirm-compact");
        if (d && d.close) d.close();
        void postManage("/api/plugin/compressor/manage/compact", {
          session: sid, confirm: true
        }).then(function () { void refresh(); });
      });
    }
    var cCancel = document.getElementById("oc-compact-cancel");
    if (cCancel && !cCancel._bound) {
      cCancel._bound = true;
      cCancel.addEventListener("click", function () {
        var d = document.getElementById("oc-confirm-compact");
        if (d && d.close) d.close();
      });
    }
    var pInp = document.getElementById("oc-purge-confirm");
    var pOk = document.getElementById("oc-purge-ok");
    if (pInp && pOk && !pInp._bound) {
      pInp._bound = true;
      pInp.addEventListener("input", function () {
        pOk.disabled = pInp.value !== sid;
      });
      pOk.addEventListener("click", function () {
        if (pInp.value !== sid) return;
        var p = document.getElementById("oc-confirm-purge");
        if (p && p.close) p.close();
        void postManage("/api/plugin/compressor/manage/purge", {
          session: sid, confirm: sid
        }).then(function () { void refresh(); });
      });
    }
    var pCancel = document.getElementById("oc-purge-cancel");
    if (pCancel && !pCancel._bound) {
      pCancel._bound = true;
      pCancel.addEventListener("click", function () {
        var p = document.getElementById("oc-confirm-purge");
        if (p && p.close) p.close();
      });
    }
  }
  document.addEventListener("visibilitychange", function () {
    if (document.hidden) stopPoll();
    else { void refresh(); startPoll(); }
  });
  bindActions();
  startPoll();
})();
  </script>
</body>
</html>`;
}

export function dashboardHtmlFromApis(input: {
  summary: SummaryLike;
  timeseries: TimeseriesLike;
  capacity: CapacityLike;
  profileLabel?: string;
  systemEvents?: Array<{ code: string; timestamp?: number }>;
  mutationsEnabled?: boolean;
}): string {
  return renderDashboardDocument(renderDashboardBody(input));
}

export function emptyDashboardHtml(): string {
  return dashboardHtmlFromApis({
    summary: {
      status: "empty",
      data: {
        totalTurns: 0,
        efficiency: { reductionRatio: null, savedTokens: 0, unit: "tau" },
        health: { sidecarStatus: "stopped", avgLatencyMs: 0 },
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
  });
}
