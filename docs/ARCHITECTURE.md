# Architecture (Plans 03 + 06 + 08 + 09 — lifecycle + dual packer + API + Control UI)

```text
OpenClaw Gateway
  reads openclaw.plugin.json
  loads plugin entry
    definePluginEntry.register(api)
      api.registerContextEngine("compressor", factory)
      api.lifecycle.registerRuntimeLifecycle(dispose)
      does NOT registerMemoryCapability
  factory(ctx) → EngineHost
    info.ownsCompaction = true
    info.hostRequirements assemble-before-prompt
    PackerPort (src/packer-port.ts)
      ├─ SidecarPacker  (engineImpl=sidecar → Plan 02 JSONL)
      └─ TsPacker       (engineImpl=ts → src/ts-engine/*)
    bootstrap → recovery ingestBatch if graph empty
    ingest / ingestBatch → packer.step
    assemble → ingest missing + sample + cutTail + memory addition
    compact → flush + precompact/ snapshot + typed sample (no LLM)
    commitTurn → meta.sqlite atomic-idempotent
    afterTurn → stage log
    dispose → packer.dispose + close SQLite
```

## Dual implementation (Plan 06)

| engineImpl | Packer | Python | Matrix |
|------------|--------|--------|--------|
| `sidecar` | SidecarClient → claw_cli | required | safetensors optional on Python side |
| `ts` | TsPacker → PersistentAgentHandle | not required | `matrixOptional: true` (spans.json + hashed rank) |

Doctor: `engineImpl=ts` skips Python hard-fail; still requires writable `stateDir`.

## Host callback → file → packer cmds

| Host callback | File | Packer cmds |
|---------------|------|-------------|
| ingest | `src/ingest.ts` | step |
| assemble | `src/assemble.ts` | sample (+ ingest missing) |
| compact | `src/compact.ts` | flush, sample |
| commitTurn | `src/commit.ts` + `src/meta-store.ts` | none |
| bootstrap | `src/engine.ts` | none or ingestBatch → step |
| afterTurn | `src/engine.ts` | optional cadence |
| dispose | packer-port / sidecar client | dispose |

## Runtime sequence (one user message)

```text
message:received → engine.ingest (skip heartbeat)
agent run
  → assemble
       resolve handle / graphRoot
       ingest uncommitted messages (idempotent)
       sample P_t (Plan 02 sidecar; Plan 04 retunes knobs)
       cutTail (paired tool window; keepRecentTokens)
       prepend systemPromptAddition = pack + STATE + memory
  → model (tail + addition + tools)
  → ingestBatch assistant + tools
  → commitTurn(advancementKey)
  → afterTurn (stage log)
overflow / /compact
  → compact (typed checkpoint; complete() never called)
dispose / reload → sidecar dispose
```

## Invariants

- Assemble is the prompt (not inject-only). Sidecar failure throws (quarantine); no full-message fallback.
- Empty pack is OK; empty compact with nonempty graph throws.
- `ownsCompaction: true` requires a real compact implementation.
- Subagent spawn/end: HOT_SET + identifier fork (`src/subagent.ts`); child dumps not absorbed into parent.
- Dual-state recall-0.5 knob values are Plan 04; this phase only calls `sample`/`step` correctly.

## Plan 01 / 02 layers retained

- Config projection, identity sanitize, doctor stubs (Plan 01).
- Sidecar JSONL client, venv, claw_cli (Plan 02).
- CLI, Control UI operator manage POSTs (profile/flush/compact/purge), tool-result middleware: Plan 10.

## Telemetry (Plan 07)

```text
assemble / compact
  → TurnMetrics (counts only; no prompt/HOT_SET text)
  → Tracker.enqueue (never await on prompt path)
  → telemetry.sqlite WAL  (separate file from meta.sqlite)
```

- Path: `~/.openclaw/context-graphs/<sessionId>/telemetry.sqlite` (beside `meta.sqlite`).
- Failures swallowed; assemble still returns. Queue cap 1000 drop-oldest.
- Doctor warns if telemetry.sqlite unwritable (`severity: warn`, not fail).
- `tau_replay` := τ of pre-cut messages (not tail+pack).
- Prune: 30-day age delete; size hysteresis 50MB→40MB; no VACUUM on assemble.
- Dual impl field parity: `impl` = `sidecar` | `ts`; TsPacker count fields share `PackCountFields` (Plan 06 port owns implementation).

## CLI / query API (Plan 08)

```text
CLI / HTTP GET
  → src/api.ts (handleSummary | handleTimeseries | handleCapacity)
  → telemetry/store.ts read-only
doctor → telemetry-readable-stats
```

- Registration: `api.registerCli({ name: "compressor" })`; optional `registerHttpRoute` for dashboard paths.
- Named units: `efficiency.unit = "tau"`; never mix hosttok into `reductionRatio`.
- Purge CLI requires `--confirm` (confirm token = session id); deletes under stateDir only.
- POST `/manage/profile|flush|compact|purge` wired via `src/manage.ts` (confirm-gated compact/purge).
- Control UI (Plan 09): `registerControlUiDescriptor` / `session.controls.registerControlUiDescriptor`
  with `id: "compressor"`, `surface: "tab"`, `path: /api/plugin/compressor/ui/dashboard`,
  `requiredScopes: ["operator.read"]`. Sandboxed frame loads HTML that polls Plan 08 GET
  summary / timeseries / capacity only. View-models in `src/ui/view-models.ts` (η/Δ/saturation).
  Chart library: SVG polylines (no Recharts). Mutations enabled against manage POSTs (Plan 10).
  Never fetches `graph.json` / pack text / safetensors. No standalone HTTP listen.

