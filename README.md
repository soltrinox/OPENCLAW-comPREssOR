# comPREssOR (`@eni6ma/compressor-oc`)

OpenClaw **context-engine** plugin (**comPREssOR**). It occupies the exclusive slot `plugins.slots.contextEngine` with engine id `compressor`.

npm package: **`@eni6ma/compressor-oc`** (org `eni6ma`). Plugin/slot id remains `compressor`.

## What it is

This package will register a context engine that packs local dual-state memory into `assemble()`. **In this version it only registers.** It does not pack yet. `assemble` / `compact` / `commitTurn` throw `EngineNotReadyError` so the Gateway can quarantine to `legacy` instead of silently passing the full transcript through.

## What the model will see (once Plan 03 lands)

A small raw recent tail that keeps tool-call/result pairing, plus a typed pack (HOT_SET, facts, ranked spans). The model does not receive sqlite, safetensors, or graph JSON.

## Install

From npm (public scoped package):

```bash
npm install @eni6ma/compressor-oc
```

Local developer link:

```bash
cd OPENCLAW/COMPRESSOR
npm install
npx tsc --noEmit
openclaw plugins install -l .
openclaw plugins inspect compressor --runtime --json
```

## Publish (eni6ma npm org)

Requires `NPM_TOKEN`: a **Granular Access Token** from [npm Access Tokens](https://www.npmjs.com/settings/~/tokens) with:

- Type: **Automation**
- Packages: org **`eni6ma`** — **Read and write**
- **Bypass 2FA for automation** enabled (classic tokens / tokens without bypass get `E403` on publish)

Never commit tokens; `.npmrc` is gitignored. Do not reuse tokens pasted into chat.

```bash
export NPM_TOKEN=…   # granular Automation token (eni6ma R/W + Bypass 2FA)
npm run release:publish
# or: bash scripts/release-publish.sh
```

The script runs `typecheck` → `build` → `pack`, then `npm publish --access public`, then `npm view @eni6ma/compressor-oc name version repository.url`. On `E403` / 2FA errors it prints the same token remediation.

## Slot

Set the exclusive slot (JSON5):

```json5
{
  plugins: {
    slots: { contextEngine: "compressor" },
    entries: {
      compressor: { enabled: true, config: { profile: "recall-0.5" } },
    },
  },
}
```

Restart the Gateway. `openclaw doctor` should see the plugin. Until the packer exists, a live chat may quarantine; that is fail-open and honest.

## Config

Default profile is `recall-0.5` (SPECS §6). `cursor-parity` is the A/B arm with smaller $K_{\max}$, HOT_SET, and budget. Unknown keys are rejected (`additionalProperties: false`). Overlay of profile-owned knobs is allowed with a doctor warning.

## Fail-open / uninstall

Uninstall restores `legacy`. OpenClaw resets `plugins.slots.contextEngine` when the selected plugin is removed. Heartbeats are not ingested (once ingest exists).

## Python (0.1.0)

The 0.1.0 sidecar path needs Python 3.11+. This scaffold only checks that an interpreter is discoverable. A venv is Plan 02. `engineImpl=ts` is not implemented until 0.2.0.

## State directory

Default `stateDir` is `~/.openclaw/context-graphs` (not `~/.cursor/context-graphs` unless the operator opts in). Graph roots are sanitized session keys. Files are not written in this phase except a doctor writability probe.

## Exclusive slot vs lossless-claw

Only one context engine is active. Installing this plugin and lossless-claw and expecting merged behavior is unsupported. Pick one slot value.

## Links

- [SPECS.md](SPECS.md)
- [001.md](001.md)
- [docs/INSTALL.md](docs/INSTALL.md)
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- [docs/RESEARCH.md](docs/RESEARCH.md) (methods stub; no product claims)

## License

MIT. See [LICENSE](LICENSE).
