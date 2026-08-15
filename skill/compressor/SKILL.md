# compressor skill (HOT_SET literacy)

This skill does not assemble context. The Gateway context engine owns `assemble()`.

## Mechanism

The compressor plugin will pack local dual-state memory (graph + bounded matrix) into a budgeted prefix. Until Plan 03, the engine is not ready: `assemble` throws and the host should quarantine to `legacy`.

When packing exists, the model sees a small recent tail plus a pack ordered HOT_SET → typed facts → ranked spans.

## Outcome

Treat HOT_SET as bounded session state. Prefer the pack over pasting the transcript. Do not invent stronger claims than the pack contains. Do not dump full tool logs into chat to “help memory.”

## Scope

- Not a memory plugin (`memory-core` stays in its slot).
- Not a quality guarantee.
- Pattern-1 vocab decode is debug-only (`injectP1`); do not request it as a default.
- Measurement belongs in `docs/RESEARCH.md`, not in this skill.
