# Changelog

## 0.0.0-dev

Scaffold + sidecar engine path (Plans 01–04). ClawHub-shaped package, strict
config schema, lifecycle/sidecar wiring, recall-0.5 Python knobs.

**Plan 11 dry-run (Wave 4):** `npm pack` + `clawhub package validate` /
`publish --dry-run` only. Live `clawhub package publish` and `npm publish`
remain **DEPLOY_HELD** until Wave 8 operator GO. Semver tag for live ship will
be 0.1.0 (sidecar), 0.2.0 (ts default), or 0.3.0 (supercharge) matching what
actually ships — do not treat this package version as a registry release.

`openclaw.build.openclawVersion` is set to the declared peer floor
`2026.3.24-beta.2` for ClawHub dry-run mechanics. Plan 05 Gateway inspect was
`NOT_RUN`; Wave 8 must replace this with a version proven by inspect before GO.
