# Install (local)

Node floor matches OpenClaw Gateway: **22.22.3+ / 24.15+ / 25.9+ / 26**. This package declares `engines.node: >=22.22.3`.

## Local link (this phase)

```bash
cd OPENCLAW/COMPRESSOR
npm install
npm test
npx tsc --noEmit
openclaw plugins install -l .
openclaw plugins inspect compressor --runtime --json
```

`package.json` `openclaw.extensions` points at `./src/index.ts` for workspace/`-l` loads. `openclaw.runtimeExtensions` points at `./dist/index.js` for published artifacts (Plan 11). Do not publish this `0.0.0-dev` scaffold.

## Predeploy smoke

One command runs the Plan 11 GO prerequisite bar (offline tests, pack typecheck, sidecar when applicable, probe, manage load, pack, ClawHub validate + dry-run). It does **not** live-publish (`clawhub package publish` without `--dry-run` or `npm publish`).

```bash
cd OPENCLAW/COMPRESSOR
npm run predeploy
```

Evidence: `OPENCLAW/PLANS/evidence/predeploy-smoke-<TS>.log.txt`. Exit `0` only when all required stages `[PASS]`. If ClawHub is present, validate `[FAIL]` fails the script (blocks GO).

| Env | Default | Effect |
|-----|---------|--------|
| `ENGINE_IMPL` | `sidecar` | Set to `ts` to skip sidecar smoke |
| `SKIP_SIDECAR` | `0` | `1` skips sidecar stage |
| `SKIP_GATEWAY` | `0` | `1` skips optional gateway install/inspect |
| `EVIDENCE_DIR` | `../PLANS/evidence` | Master + child evidence logs |

Gateway install/inspect is optional: missing CLI or `SKIP_GATEWAY=1` → `[NOT_RUN]`, never fails the required bar.

## Slot

Set `plugins.slots.contextEngine` to `compressor` and `plugins.entries.compressor.enabled` to `true`. Restart Gateway.

## stateDir

Default `~/.openclaw/context-graphs`. Plan 01 doctor may `mkdir` and write a probe file, then delete it. Graph JSON and sqlite appear in Plan 02/03.

## Revert

Uninstall the plugin or set the slot back to `legacy`. OpenClaw resets the slot to `legacy` when the selected context-engine plugin is uninstalled.

## Python

- **`engineImpl=sidecar` (0.1.0 default):** Python 3.11+ required; doctor fails if missing.
- **`engineImpl=ts` (Plan 06 / 0.2.0 path):** Python not required. Doctor passes when interpreter is absent. Set `plugins.entries.compressor.config.engineImpl` to `"ts"`.

Missing interpreter is a **hard fail** only for the sidecar path.

## CLI (Plan 08)

Plugin registers an `openclaw compressor` command group (does not collide with core commands).

```bash
# Efficiency table — unit=tau (estimator τ=(len+3)//4). Not provider billing.
openclaw compressor stats --session <sanitized-id>
openclaw compressor stats --session <sanitized-id> --json

# Packer health + stage-log age + telemetry.sqlite size
openclaw compressor status --session <sanitized-id>

# Purge (confirm token = session id; fixture/stateDir only)
openclaw compressor purge --session <sanitized-id> --confirm

# Count-only CSV/JSON export (no prompt/HOT_SET columns)
openclaw compressor export --session <sanitized-id> --format csv
```

Every human-visible η line includes `unit=tau`. JSON `reductionRatio` is 0–1; the ASCII table prints percent.

## Query API (Plan 08)

In-process handlers (no standalone Express). When the Gateway exposes `registerHttpRoute` / `registerGatewayMethod`:

- `GET /api/plugin/compressor/stats/summary`
- `GET /api/plugin/compressor/stats/timeseries`
- `GET /api/plugin/compressor/state/capacity`
- `POST /api/plugin/compressor/manage/profile` → DynamicProfileSwitcher (refuses `engineImpl` overlay with 400 `restart_required`)
- `POST /api/plugin/compressor/manage/flush` → force packer.flush
- `POST /api/plugin/compressor/manage/compact` → typed checkpoint; requires `confirm: true`; never calls LLM
- `POST /api/plugin/compressor/manage/purge` → requires `confirm` equal to session id

If those registrars are missing, CLI still calls the same handlers; HTTP is graded `NOT_RUN`.

