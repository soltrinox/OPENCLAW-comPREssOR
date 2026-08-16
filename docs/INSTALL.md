# Install

Node floor matches OpenClaw Gateway: **22.22.3+ / 24.15+ / 25.9+ / 26**. This package declares `engines.node: >=22.22.3`.

## Local link

```bash
cd OPENCLAW/COMPRESSOR
npm install
npm test
npx tsc --noEmit
openclaw plugins install -l .
openclaw plugins inspect compressor --runtime --json
```

`package.json` `openclaw.extensions` points at `./src/index.ts` for workspace/`-l` loads. `openclaw.runtimeExtensions` points at `./dist/index.js` for published artifacts. npm package name is `@eni6ma/compressor-oc`.

## Slot

Set `plugins.slots.contextEngine` to `compressor` and `plugins.entries.compressor.enabled` to `true`. Restart Gateway.

## stateDir

Default `~/.openclaw/context-graphs`. Doctor may create the directory and probe writability. Graph JSON, sqlite, and packer state live under sanitized session keys.

## Revert

Uninstall the plugin or set the slot back to `legacy`. OpenClaw resets the slot to `legacy` when the selected context-engine plugin is uninstalled.

## Python

- **`engineImpl=sidecar` (default):** Python 3.11+ required; doctor fails if missing.
- **`engineImpl=ts`:** Python not required. Doctor passes when interpreter is absent. Set `plugins.entries.compressor.config.engineImpl` to `"ts"`.

Missing interpreter is a **hard fail** only for the sidecar path.

## CLI

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

## Query API

In-process handlers (no standalone Express). When the Gateway exposes `registerHttpRoute` / `registerGatewayMethod`:

- `GET /api/plugin/compressor/stats/summary`
- `GET /api/plugin/compressor/stats/timeseries`
- `GET /api/plugin/compressor/state/capacity`
- `POST /api/plugin/compressor/manage/profile` → DynamicProfileSwitcher (refuses `engineImpl` overlay with 400 `restart_required`)
- `POST /api/plugin/compressor/manage/flush` → force packer.flush
- `POST /api/plugin/compressor/manage/compact` → typed checkpoint; requires `confirm: true`; never calls LLM
- `POST /api/plugin/compressor/manage/purge` → requires `confirm` equal to session id

If those registrars are missing, CLI still calls the same handlers; HTTP routes are simply unavailable.
