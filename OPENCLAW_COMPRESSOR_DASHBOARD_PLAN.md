# SPECS EXTENSION: OpenClaw Compressor - Dashboard, Telemetry & Management Console
**Module:** `OPENCLAW/COMPRESSOR/UI_TELEMETRY`
**Document Version:** 1.0.0
**Target:** Cursor IDE / LLM Product Planning Context

---

## 1. Executive Summary & Product Vision

The OpenClaw Context-Engine Plugin (`compressor`) fundamentally alters how long-running Agent Chat sessions manage state by substituting raw transcript replay with dual-state memory (symbolic graph + bounded matrix) and budgeted text projection. However, the theoretical mathematical benefits of token reduction ($\eta$) and contextual density must be made visible, quantifiable, and actionable to the end-user or enterprise operator. 

This specifications extension outlines the design, architecture, and implementation plan for a comprehensive **Industry-Standard Metrics Dashboard and Management Console**. By exposing the inner workings of the `compressor` plugin, operators will immediately perceive the quantifiable ROI (Return on Investment) through token savings, monitor the exact capacity and health of their dual-state memory, and actively manage profiles without restarting the Gateway.

This document extends the core `SPECS.md` and provides the blueprint for adding telemetry, visual dashboards, and CLI controls, ensuring the `compressor` plugin is not just a silent backend utility, but a highly observable, enterprise-grade context management platform.

---

## 2. Core Definitions & Lexicon

To ensure alignment across the engineering team, product managers, and the LLM context, the following definitions govern the telemetry and dashboard architectures:

### 2.1 Mathematical & Telemetry Variables
*   **$\tau$ (Tau - Token Estimator):** The internal accounting unit for text volume, defined as `(len(text)+3)//4`. The dashboard normalizes all token charts using $\tau$ to avoid dependency on specific vendor tokenizers (e.g., tiktoken), ensuring stable, reproducible metrics across different model backends.
*   **$\Delta$ (Delta - Token Savings):** The absolute number of tokens saved per turn or per session. Calculated as $\sum \tau(R_t) - \sum \tau(P_t)$, where $R_t$ is the raw replay text and $P_t$ is the packed inject text.
*   **$\eta$ (Eta - Token Reduction Ratio):** The percentage representation of efficiency. Calculated as $1 - (\sum \tau(P_t) / \sum \tau(R_t))$. This is the primary "ROI" metric displayed in the dashboard.
*   **$B_t$ & $B_{max}$ (Adaptive Budgets):** The current token budget and the maximum allowed budget for a turn. The dashboard will visualize how $B_t$ shrinks during repetitive turns and expands during high-novelty turns.

### 2.2 Architectural Components
*   **$G_t$ (Symbolic Graph):** The local SQLite-backed memory storing Turns, Topics, Facts, OpenItems, and Events. Dashboard capacity metrics will track the active node count against configured caps (e.g., `MAX_ACTIVE_DURABLE_FACTS`).
*   **$C_t$ (Bounded Matrix):** The local safetensors digest. Capacity is defined by $k / K_{max}$, where $K_{max}$ is typically 32 or 64.
*   **HOT_SET:** The highest-priority assembly payload (Open work, active decisions, recent facts).
*   **Control UI:** The OpenClaw frontend extensibility framework allowing plugins to register custom views, graphs, and forms.
*   **Sidecar RPC:** The JSON-RPC communication layer between the Node.js Gateway and the Python 3.11+ `chat_compressor` instance. Latency across this boundary is a critical health metric.

---

## 3. Strategic Goals & Objectives

### 3.1 Primary Goals
1.  **Immediate Value Realization:** Prove the worth of the plugin instantly. When a user runs a long session, the dashboard must explicitly show the cumulative token savings versus legacy pass-through, translating abstract algorithmic compression into concrete resource/cost conservation.
2.  **Capacity Observability:** Prevent "black box" memory failures. Users must see if their $C_t$ matrix is saturated or if their graph $G_t$ is aggressively pruning facts due to low caps, empowering them to adjust `profile` configurations dynamically.
3.  **Context Transparency:** Answer the user question: *"What exactly did the model see this turn?"* by providing a visual breakdown of the injected context ($P_t$ composition).
4.  **Operational Reliability:** Monitor the latency and health of the Python sidecar process, identifying bottlenecks in graph projection, ranking, or packing before they cause timeout fallbacks to the `legacy` engine.

### 3.2 Secondary Goals
1.  **A/B Testing Enablement:** Allow operators to easily toggle between the `recall-0.5` and `cursor-parity` profiles and visually compare the resulting $\eta$ and HOT_SET composition.
2.  **Data Portability:** Enable exporting of telemetry data (CSV/JSON) for enterprise billing analysis or research (as defined in §19 of the core specs).

### 3.3 Non-Goals
*   We will **not** attempt to calculate exact fiat currency (USD) cost savings, as model pricing fluctuates and $\tau$ is an estimator. The dashboard will show token and ratio savings only.
*   We will **not** render the actual multi-dimensional vectors of the $C_t$ matrix. We will only render its slot capacity ($k / K_{max}$).
*   We will **not** build a separate standalone web server. All UI must be integrated directly into the OpenClaw Control UI via registered descriptors.

---

## 4. Architectural Modules & Components

The telemetry and management expansion requires new modules across both the TypeScript host and the Python sidecar (for v1), eventually migrating entirely to the TS engine (v1.1).

### 4.1 Telemetry Aggregation Layer (`src/telemetry/`)
This module is responsible for asynchronously capturing metrics without blocking the critical path of `assemble()` or `compact()`.

*   **`src/telemetry/tracker.ts`**: The core singleton instantiated per `EngineHost`. Exposes methods like `trackTurn(metrics: TurnMetrics)` and `trackSidecarHealth(ping: number)`.
*   **`src/telemetry/store.ts`**: A dedicated lightweight SQLite database (`telemetry.sqlite`) stored alongside `meta.sqlite` in `~/.openclaw/context-graphs/`. It stores time-series data for historical charting.
    *   *Schema - `turn_metrics`:* `session_id`, `turn_index`, `timestamp`, `tau_replay`, `tau_packed`, `budget_max`, `budget_used`, `hot_set_tokens`, `ranked_tokens`, `rpc_latency_ms`.
    *   *Schema - `capacity_metrics`:* `timestamp`, `matrix_rows_k`, `graph_active_nodes`, `graph_pruned_nodes`.
*   **`src/telemetry/exporter.ts`**: Handles the aggregation of rows into time-bucketed datasets suitable for rendering in the UI.

### 4.2 Control UI Plugin (`src/ui/descriptors.ts`)
This module registers the interactive dashboard within the OpenClaw Gateway ecosystem.

*   **Registration:** Calls `api.registerControlUiDescriptor(...)` with the `compressor` namespace.
*   **API Handlers:** Registers local REST/IPC endpoints that the UI will query:
    *   `GET /api/plugin/compressor/stats/summary`
    *   `GET /api/plugin/compressor/stats/timeseries`
    *   `GET /api/plugin/compressor/state/capacity`
    *   `POST /api/plugin/compressor/manage/profile`
    *   `POST /api/plugin/compressor/manage/flush`

### 4.3 Management Controller (`src/api.ts` & `src/manage.ts`)
Handles active mutations and state management requested by the user via the UI or CLI.

*   **`DynamicProfileSwitcher`**: Allows hot-swapping configurations (e.g., modifying `chunksPerTurn` or `poolEma`) and re-projecting the `chat-compressor.env` file without dropping the active session.
*   **`ManualStateOperator`**: Exposes functions to manually trigger `compact()` flows, force graph flushes to disk, or purge specific session caches safely.

### 4.4 CLI Extensions (`src/cli/index.ts`)
Extends the OpenClaw terminal interface.
*   `openclaw compressor stats`: Outputs an ASCII table of $\eta$, $\Delta$, and current capacity limits.
*   `openclaw compressor status`: Pings the sidecar, checks Python venv integrity, and reports stage log health.
*   `openclaw compressor purge --session <id>`: CLI hook into the `ManualStateOperator`.

---

## 5. Dashboard Console UI Specifications

The dashboard is designed as a single-pane-of-glass interface consisting of four primary widgets. It utilizes an industry-standard aesthetic: muted data-viz colors, dark-mode compatibility, and dense but readable typography.

### 5.1 Widget 1: Value Realization & Token Efficiency (The "ROI" Panel)
**Purpose:** Prove the mathematical benefit of the plugin.
*   **Top-Level KPIs (Big Numbers):**
    *   **Total Tokens Saved ($\Delta$):** Highlighted in green. Cumulative across the session.
    *   **Reduction Ratio ($\eta$):** Displayed as a percentage (e.g., "83.8% Reduction").
    *   **Current Budget Utilization:** E.g., "783 / 1024 $\tau$".
*   **Visualization:** A stacked Area Chart plotting over time (X-axis = Turn Index).
    *   *Background area (Light Red/Grey):* Represents $\tau(R_t)$ (What would have been sent via raw replay).
    *   *Foreground area (Solid Blue/Green):* Represents $\tau(P_t)$ (What was actually packed and injected).
    *   The gap between the two visualizes the accumulated savings.

### 5.2 Widget 2: Dual-State Capacity & Memory Gauge
**Purpose:** Monitor the internal pressure on $C_t$ and $G_t$.
*   **Matrix Capacity ($C_t$):** A Donut Chart displaying $k$ active rows out of $K_{max}$ (e.g., 28/64 rows used). Color shifts from blue to amber when $> 80\%$ full.
*   **Graph Density ($G_t$):** A grouped vertical bar chart showing active quotas vs. caps:
    *   Bar 1: Active Turns (e.g., 12 / 32)
    *   Bar 2: Durable Facts (e.g., 20 / 48)
    *   Bar 3: Non-Durable Facts (e.g., 40 / 64)
*   **Pruning Velocity:** A sparkline showing nodes pruned per turn. A high velocity indicates the memory is thrashing and the user may need to increase their profile caps.

### 5.3 Widget 3: Context Stack Composition
**Purpose:** Deconstruct the `assemble()` payload for transparency.
*   **Visualization:** A 100% Stacked Bar Chart for the most recent turn.
*   **Segments:**
    *   `HOT_SET`: (Open items, Decisions, active paths) - Dark Purple.
    *   `Typed Lines`: (Facts, Events) - Indigo.
    *   `Ranked Spans`: (Query-retrieved text) - Light Blue.
    *   `Recent Tail`: (Raw recent history) - Grey.
*   **Interaction:** Hovering over a segment reveals the exact $\tau$ token estimate and character count for that block.

### 5.4 Widget 4: Runtime Diagnostics & Health
**Purpose:** Ensure operational reliability of the Python sidecar / TS Engine.
*   **Sidecar Status Indicator:** Blinking green dot for "Healthy", red for "Quarantined / Fallback".
*   **Latency Sparkline:** Plots the execution time (in ms) of `assemble()` over the last 50 turns. Includes a horizontal dashed line for the SLA target (e.g., 200ms).
*   **Recent Events Log:** A scrolling text window showing the last 5 system events (e.g., `preCompact snapshot frozen`, `graph flushed to disk`, `Adaptive budget scaled to 512`).

### 5.5 Management Action Bar
A floating or pinned header providing immediate control:
*   **Profile Dropdown:** Select between `recall-0.5`, `cursor-parity`, or `custom`.
*   **Action Buttons:** `Force Flush Graph`, `Trigger Compaction`, `Purge Session Memory` (requires confirmation modal).

---

## 6. Data Schemas & API Contracts

### 6.1 Telemetry Payload (`TurnMetrics` Interface)
Whenever `assemble()` completes, it constructs this payload and dispatches it asynchronously to the `telemetry/tracker.ts`.

```typescript
interface TurnMetrics {
  sessionId: string;
  turnIndex: number;
  timestamp: number;
  
  // Efficiency
  tauReplay: number;
  tauPacked: number;
  budgetMax: number;
  budgetUsed: number;
  
  // Composition
  hotSetTokens: number;
  typedLinesTokens: number;
  rankedSpanTokens: number;
  recentTailTokens: number;
  
  // Capacity Post-Turn
  matrixRowsActive: number;
  matrixMaxSlots: number;
  graphActiveNodes: number;
  graphPrunedNodes: number;
  
  // Performance
  rpcLatencyMs: number;
  totalAssembleMs: number;
}
```

### 6.2 REST Endpoint Response Example: `/api/plugin/compressor/stats/summary`
```json
{
  "status": "ok",
  "data": {
    "session": "sess-alpha-99",
    "totalTurns": 45,
    "efficiency": {
      "totalTauReplay": 125000,
      "totalTauPacked": 21000,
      "savedTokens": 104000,
      "reductionRatio": 0.832
    },
    "health": {
      "sidecarStatus": "active",
      "avgLatencyMs": 145,
      "matrixSaturationPct": 0.65
    }
  }
}
```

---

## 7. Implementation Plan & Task DAG

To safely introduce telemetry without destabilizing the core compressor logic, delivery is phased. This integrates into the master project plan (SPECS.md §16).

### Phase 1: Core Telemetry Plumbery (Backend)
**Prerequisite:** Core `assemble()` and `compact()` loops must be functional.
*   **[Task UI-1.1]** Create `telemetry.sqlite` schema and initial migrations.
*   **[Task UI-1.2]** Implement `Tracker` singleton class with asynchronous non-blocking writes.
*   **[Task UI-1.3]** Instrument `assemble.ts` and `compact.ts` to emit `TurnMetrics` events upon completion.
*   **[Task UI-1.4]** Instrument the Python sidecar `claw_cli.py` to return duration and slot counts inside its stdout JSON response.

### Phase 2: CLI Integration & API endpoints
*   **[Task UI-2.1]** Implement `src/api.ts` GET handlers to query the telemetry SQLite db and calculate $\eta$ and averages.
*   **[Task UI-2.2]** Implement `src/cli/index.ts` commands (`stats`, `status`, `purge`).
*   **[Task UI-2.3]** Add `doctor.ts` checks to ensure the `telemetry.sqlite` is writable and not corrupted.

### Phase 3: Dashboard Control UI Build (Frontend)
**Prerequisite:** OpenClaw Control UI API must be accessible.
*   **[Task UI-3.1]** Scaffold the React/WebComponent tab descriptor in `src/ui/descriptors.ts`.
*   **[Task UI-3.2]** Build Widget 1: Token Efficiency Area Charts (using lightweight charting libs like Recharts or Chart.js).
*   **[Task UI-3.3]** Build Widget 2: Dual-State Capacity Gauges.
*   **[Task UI-3.4]** Build Widget 3: Context Stack Composition bar charts.
*   **[Task UI-3.5]** Build Widget 4: Diagnostics and live log viewer.

### Phase 4: Management Actions & Hot-Swapping
*   **[Task UI-4.1]** Implement the `DynamicProfileSwitcher` to allow config changes without Gateway restarts.
*   **[Task UI-4.2]** Wire the UI action buttons (`Force Flush`, `Trigger Compaction`) to their respective REST POST endpoints.
*   **[Task UI-4.3]** End-to-end testing of the Management Console interactions during active simulated load.

---

## 8. Performance & Security Considerations

**Observation Overhead:** Monitoring the system must not degrade the system.
*   *Mitigation:* All telemetry SQLite writes must be strictly asynchronous. Use a write-ahead log (WAL) for `telemetry.sqlite`. If the telemetry write fails, the error is swallowed and logged to file; it must **never** throw and abort the `assemble()` pipeline.

**Data Privacy:**
*   *Mitigation:* The telemetry database stores **metadata and counts only**. It does not store raw user prompts, specific file paths, or text snippets from the HOT_SET. Context content remains strictly in the dual-state memory (`graph.json`, `safetensors`) which is explicitly purged on command.

**Storage Quotas:**
*   *Mitigation:* The `telemetry.sqlite` file will automatically prune records older than 30 days or exceeding 50MB to prevent disk bloat on the host machine.

---

## 9. Future Research & Extensions

As outlined in SPECS.md §19, the telemetry gathered by this dashboard opens new avenues for optimization:
1.  **Auto-Tuning Profiles:** Using historical $\eta$ and pruning velocity, the dashboard could eventually suggest profile changes (e.g., "Notice: High graph thrashing detected. We recommend switching to the 'broad-recall' profile.")
2.  **Semantic Health Scores:** Integrating an `entity_recall` proxy directly into the live dashboard, checking if key nouns from $q_t$ survived into $P_t$, rather than just tracking token volume.
3.  **Cross-Session Benchmarking:** Allowing operators to compare token efficiency across different projects or workspaces to identify prompt-engineering anti-patterns.

---
*End of Specs Extension. Ready for integration into Cursor IDE / Project Master Plan.*
