# comPREssOR (`@eni6ma/compressor-oc`)

OpenClaw **context-engine** plugin (**comPREssOR**). It occupies the exclusive slot `plugins.slots.contextEngine` with engine id `compressor`.

npm package: **`@eni6ma/compressor-oc`** (org `eni6ma`). Plugin/slot id remains `compressor`.

GitHub: [soltrinox/OPENCLAW-comPREssOR](https://github.com/soltrinox/OPENCLAW-comPREssOR).

## What it is

This package registers a context engine that packs local dual-state memory into `assemble()`. On hard engine failure it throws so the Gateway can quarantine to `legacy` instead of silently passing the full transcript through.

## What the model will see

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
openclaw plugins install -l .
openclaw plugins inspect compressor --runtime --json
```

For operator install, slot config, and CLI details, see [docs/INSTALL.md](docs/INSTALL.md).

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

Restart the Gateway. `openclaw doctor` should see the plugin. On packer failure a live chat may quarantine; that is fail-open and honest.

## Config

Default profile is `recall-0.5` (SPECS §6). `cursor-parity` is the A/B arm with smaller $K_{\max}$, HOT_SET, and budget. Unknown keys are rejected (`additionalProperties: false`). Overlay of profile-owned knobs is allowed with a doctor warning.

## Fail-open / uninstall

Uninstall restores `legacy`. OpenClaw resets `plugins.slots.contextEngine` when the selected plugin is removed. Heartbeats are not ingested.

## Python

The default `engineImpl=sidecar` path needs Python 3.11+. Set `engineImpl=ts` when you want the TypeScript packer without a Python interpreter.

## State directory

Default `stateDir` is `~/.openclaw/context-graphs` (not `~/.cursor/context-graphs` unless the operator opts in). Graph roots are sanitized session keys.

## Exclusive slot vs lossless-claw

Only one context engine is active. Installing this plugin and lossless-claw and expecting merged behavior is unsupported. Pick one slot value.

## Links

- [SPECS.md](SPECS.md)
- [001.md](001.md)
- [docs/INSTALL.md](docs/INSTALL.md)
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- [docs/RESEARCH.md](docs/RESEARCH.md) (methods stub; no product claims)
- [GitHub](https://github.com/soltrinox/OPENCLAW-comPREssOR)

## License

MIT. See [LICENSE](LICENSE).
