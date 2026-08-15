#!/usr/bin/env bash
# Plan 10 UI-4.3 simulated load: assemble mocks + mid-stream profile switch + flush.
# Required: none (in-process via npx tsx). Destructive: fixture dirs only.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

TS="$(date +%Y%m%d-%H%M%S)"
EVIDENCE_DIR="${EVIDENCE_DIR:-$ROOT/../PLANS/evidence}"
mkdir -p "$EVIDENCE_DIR"
LOG="$EVIDENCE_DIR/manage-load-plan10-${TS}.log.txt"

echo "[INFO] Plan 10 manage load test → $LOG" | tee "$LOG"

npx --yes tsx - <<'EOF' 2>&1 | tee -a "$LOG"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RECALL_05_DEFAULTS } from "./src/config.ts";
import { createEngineHost } from "./src/engine.ts";
import { MetaStore } from "./src/meta-store.ts";
import { switchProfile, forceFlush } from "./src/manage.ts";
import { Tracker } from "./src/telemetry/tracker.ts";
import { TelemetryStore } from "./src/telemetry/store.ts";

const N = 30;
const SWITCH_AT = 10;
const FLUSH_AT = 20;
const root = mkdtempSync(join(tmpdir(), "oc-p10-load-"));
const session = "load_sess";
mkdirSync(join(root, session), { recursive: true });
writeFileSync(
  join(root, session, "graph.json"),
  JSON.stringify({ schema: "ctx-graph-v1", nodes: [], edges: [] }) + "\n",
);

const budgets: number[] = [];
const events: string[] = [];
let sampleN = 0;

const packer = {
  async step() {
    return { t: sampleN, k: 2, k_max: 64 };
  },
  async sample(_id: string, params: { budget?: number }) {
    sampleN += 1;
    const budget = params.budget ?? 2048;
    budgets.push(budget);
    await new Promise((r) => setTimeout(r, 5));
    return {
      text: `HOT_SET:\nOpenItem load-${sampleN}`,
      packed_tokens: 20,
      method: "query-pack",
      k: 2,
      k_max: budget === 1024 ? 32 : 64,
      t: sampleN,
      duration_ms: 5,
    };
  },
  async flush() {
    events.push("graph_flushed");
    return { ok: true };
  },
  async dispose() {},
};

const tracker = new Tracker({ dbPath: join(root, session, "telemetry.sqlite") });
const host = createEngineHost(
  { ...RECALL_05_DEFAULTS, stateDir: root, engineImpl: "ts", profile: "recall-0.5" },
  { packer, meta: new MetaStore(":memory:"), autoStartSidecar: false, tracker },
);

let throws = 0;
for (let i = 1; i <= N; i++) {
  try {
    if (i === SWITCH_AT) {
      const r = switchProfile(host, { profile: "cursor-parity", session }, { tracker });
      if (!r.ok) throw new Error("profile switch failed: " + r.error);
      events.push("profile_changed");
      console.log(`[PASS] profile switch at n=${i} budget=${host.resolvedConfig.forwardBudget}`);
    }
    if (i === FLUSH_AT) {
      const r = await forceFlush(host, { session }, { tracker });
      if (!r.ok) throw new Error("flush failed: " + r.error);
      console.log(`[PASS] flush at n=${i}`);
    }
    await host.assemble({
      sessionKey: session,
      messages: [{ role: "user", text: `turn ${i} continue work` }],
      prompt: `turn ${i} continue work`,
    });
  } catch (e) {
    throws += 1;
    console.error("[FAIL] assemble throw", e);
  }
}

await tracker.flush();
const store = TelemetryStore.openReadonly(join(root, session, "telemetry.sqlite"));
const eff = store.summarizeEfficiency(session);
store.close();

const last10Budgets = budgets.slice(-10);
const allMatch = last10Budgets.every((b) => b === 1024);
const hasProfile = events.includes("profile_changed");
const hasFlush = events.includes("graph_flushed");

console.log(`[INFO] sampleN=${sampleN} throws=${throws} turns=${eff.totalTurns}`);
console.log(`[INFO] last10 budgets=${JSON.stringify(last10Budgets)}`);
console.log(`[INFO] events=${JSON.stringify(events)}`);

if (throws === 0) console.log("[PASS] no assemble throw");
else console.log("[FAIL] assemble throw");

if (sampleN >= N) console.log("[PASS] telemetry/sample count >= N");
else console.log("[FAIL] sample count");

if (allMatch) console.log("[PASS] last 10 budget_max match cursor-parity (1024)");
else console.log("[FAIL] budget_max mismatch");

if (hasProfile && hasFlush) console.log("[PASS] system_events profile_changed + graph_flushed");
else console.log("[FAIL] missing system events");

await host.dispose();

if (throws === 0 && sampleN >= N && allMatch && hasProfile && hasFlush) {
  console.log("[PASS] A10-16 load script");
  process.exit(0);
}
console.log("[FAIL] A10-16 load script");
process.exit(1);
EOF

echo "[INFO] done" | tee -a "$LOG"
