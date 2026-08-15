# SPECS: OpenClaw compressor plugin

**Name:** ClawHub context-engine plugin (`compressor`)  
**Folder:** `OPENCLAW/COMPRESSOR`  
**Distribution:** ClawHub code plugin. Not a core OpenClaw PR that replaces `legacy`.

This document is the system stack, module map, and task DAG for a package an operator can install with `openclaw plugins install clawhub:…`, select with `plugins.slots.contextEngine`, and uninstall back to `legacy`.

Performance measurement is left to implementers. See **§19 Areas for research**.

---

## 1. Purpose

OpenClaw’s default context path is the built-in `legacy` engine. Ingest is a no-op. Assemble is pass-through. Compact delegates to LLM summarization and keeps a large recent tail (`keepRecentTokens` default 20,000). Before compact, a silent memory-flush turn tries to copy durable notes into Markdown.

That path is workable for short chats and costly for long Gateway sessions (Telegram, Discord, WebChat, subagents). The model sees growing history, then a prose digest that can drop paths, open items, and opaque identifiers. OpenClaw already added `identifierPolicy: "strict"` because summaries lose IDs.

This plugin substitutes local dual state plus budgeted projection:

```text
turn text → S_t = (G_t, C_t) → P_t = Π(S_t, q_t; B_t)
P_t = HOT_SET → typed lines → ranked chunks → matrix-span readout
τ(P_t) ≤ B_t ≤ B_max
```

Each model run receives (a) a small raw recent tail that preserves tool-call/result pairing, and (b) a typed pack of active work, decisions, paths, and query-ranked spans. Compaction does not call the conversation model.

**Scope:** context assembly only. The plugin does not replace `memory-core`, does not crawl the repo as RAG, and does not send safetensors to the model.

**Product shape:** exclusive slot `plugins.slots.contextEngine`. OpenClaw docs tell authors not to land third-party engines in the OpenClaw tree. lossless-claw is the existing precedent: same slot, same install path.

---

## 2. Constitution

1. **Plugin, not core.** Exclusive slot `plugins.slots.contextEngine`. Uninstall resets to `legacy`.
2. **Text-only model boundary.** $G_t$ and $C_t$ stay on disk. The model sees messages + `systemPromptAddition`.
3. **Fail-open.** A thrown engine is quarantined; OpenClaw continues on `legacy`. Heartbeats are not ingested.
4. **Owns compaction.** `ownsCompaction: true`. A no-op `compact()` is unsafe.
5. **Transcript fence.** Declare `before-current-turn-entry-v1` and `atomic-idempotent-v1`; implement `commitTurn`.
6. **Assemble-before-prompt.** Declare host requirement so generic CLI backends fail closed.
7. **Do not own memory.** Use `buildMemorySystemPromptAddition(...)`. Optional append to `memory/YYYY-MM-DD.md` is a writer, not a slot takeover.
8. **No Pattern-1 in the default forward channel.** Vocab decode stays debug-only.
9. **Native plugin trust.** In-process, unsandboxed, same class as lossless-claw. Keep the package small; no surprise network on assemble.
10. **Measurement is implementer-owned.** Do not bake Cursor inject-path ratios or billed-probe figures into this spec. Record methods and fixtures under §19.

---

## 3. Why a plugin, not a system PR

| Criterion | Core PR that replaces `legacy` | ClawHub context-engine plugin |
|---|---|---|
| How OpenClaw is built | `legacy` is the default pass-through; engines are pluggable | Matches `registerContextEngine` + exclusive slot |
| User risk | Changes every Gateway | Opt-in; uninstall resets the slot to `legacy` |
| Failure mode | A packer bug is a platform incident | Engine is quarantined; replies continue on `legacy` |
| Review burden | Compaction, transcripts, Codex harness, overflow, subagents | Plugin owns graph/pack/rank; core owns contracts |
| Release cadence | Tied to OpenClaw betas | Version `pluginApi` / `minGatewayVersion` |
| Install | Wait for a release | `openclaw plugins install clawhub:…` then set the slot |

A large system enhancement that swaps the default assembler would force every channel user onto unproven knobs. OpenClaw isolates plugin engines so a bad `assemble()` does not silence the agent.

**Small host-contract PRs** are still in scope if today’s SDK cannot:

- drop/replace transcript messages from `assemble()`
- expose a usable token budget on `runtimeSettings.limits`
- honor tool-result middleware for the needed runtimes
- round-trip `commitTurn` / transcript fence for compact entries
- show engine-reported pack vs tail tokens in `/context`

Those PRs are typed host seams. They are not “add compressor to core.”

---

## 4. System stack

```text
Chat channels / WebChat / CLI
        │
        ▼
OpenClaw Gateway (Node, in-process plugins)
        │  plugins.slots.contextEngine = "compressor"
        ▼
┌──────────────────────────────────────────────────────────┐
│  @soltrinox/openclaw-compressor                          │
│                                                          │
│  index.ts     definePluginEntry + registerContextEngine  │
│  engine-host  sessionKey → handle, assemble, compact     │
│  config.ts    recall-0.5 profile, schema projection      │
│  middleware   optional tool-result reducer (phase 2)     │
│  skill/       HOT_SET literacy SKILL.md                  │
│                                                          │
│           ┌─────────────┐     ┌─────────────────────┐    │
│  v1       │ sidecar.ts  │────▶│ chat_compressor     │    │
│           │ JSON-RPC    │     │ PersistentAgentHandle│    │
│           └─────────────┘     │ graph/pack/rank/C_t │    │
│                               └─────────────────────┘    │
│  v1.1     ts-engine/  graph + pack + rank (+ optional C) │
└──────────────────────────────────────────────────────────┘
        │
        ▼
~/.openclaw/context-graphs/<agentOrSession>/
  meta.sqlite  graph.json  tNNNN.safetensors  tNNNN.spans.json  logs/
```

| Layer | Technology | Role |
|---|---|---|
| Host | OpenClaw Gateway, Node 22.22.3+ / 24.15+ / 25.9+ / 26 | Sessions, tools, channels, overflow, `/compact` |
| Plugin runtime | TypeScript ESM, `openclaw/plugin-sdk/*` | Registration, lifecycle, config, doctor, UI |
| Packer v1 | Python 3.11+ vendored `chat_compressor` | Dual state, pack, span sidecars |
| Packer v1.1 | TypeScript port of graph/pack/rank | Remove sidecar for Gateway-native install |
| State | SQLite + JSON graph + safetensors + spans | Local lineage; never sent to the model |
| Memory (foreign) | `memory-core` | Search/recall; engine prepends host-prepared sections |
| Distribution | ClawHub code plugin + npm pack artifact | `openclaw plugins install clawhub:…` |

v1 ships with a managed sidecar so the Cursor-proven engine is reused. v1.1 ports `graph.py`, `pack.py`, `rank.py`, `chunks.py`, `extractive.py`, `metrics.py` to TypeScript. Matrix $C_t$ can remain Python-optional. The pack the model sees does not require numpy if span readout is implemented against `spans.json` and the graph.

---

## 5. Repository and package layout

New package in this folder (or built here). Do not fold Gateway code into the Cursor VSIX.

```text
OPENCLAW/COMPRESSOR/
  SPECS.md                # this document
  package.json
  openclaw.plugin.json
  tsconfig.json
  README.md
  LICENSE
  CHANGELOG.md
  src/
    index.ts              # definePluginEntry
    api.ts
    runtime-api.ts
    config.ts             # profile + defaults
    ids.ts                # sessionKey / agentId mapping
    engine.ts             # ContextEngine factory
    assemble.ts           # message tail + pack composition
    compact.ts            # typed checkpoint
    ingest.ts             # role mapping, skip heartbeat
    commit.ts             # advancementKey store
    sidecar/
      client.ts
      spawn.ts
      protocol.ts
    ts-engine/            # v1.1: ported operators
      graph.ts
      pack.ts
      rank.ts
      chunks.ts
      metrics.ts
      handle.ts
      store.ts
    middleware/
      tool-result.ts      # phase 2
    ui/
      descriptors.ts      # Control UI tab (phase 2)
    doctor.ts
    log.ts
  skill/
    compressor/SKILL.md
  engine/                 # vendored chat_compressor
    pyproject.toml
    src/chat_compressor/
      claw_cli.py         # OpenClaw-facing CLI (not hook_cli)
  scripts/
    pack.sh
    probe-openclaw.sh
    sidecar-smoke.sh
  test/
    engine.assemble.test.ts
    engine.compact.test.ts
    engine.commit.test.ts
    config.schema.test.ts
    sidecar.protocol.test.ts
    recall-profile.test.ts
  docs/
    ARCHITECTURE.md
    INSTALL.md
    RESEARCH.md           # methods, fixtures, open questions (§19)
```

| Field | Value |
|---|---|
| npm name | `@soltrinox/openclaw-compressor` (scope must match ClawHub owner) |
| plugin `id` | `compressor` |
| engine id | `compressor` (must equal `plugins.slots.contextEngine`) |
| `kind` | `"context-engine"` |
| peer | `openclaw` at the `pluginApi` floor you test |
| activation | `onStartup: true` |

`package.json` must point **built** JS for published artifacts (`openclaw.extensions` / `runtimeExtensions` → `./dist/index.js`). TypeScript entries are for local `-l` only.

---

## 6. Manifest and config schema

`openclaw.plugin.json` is read without executing plugin code. It must include `id`, `kind`, `configSchema` (`additionalProperties: false`), `activation.onStartup`, optional `skills`, and `contracts` for later middleware.

| Key | Type | Default (`recall-0.5`) | Purpose |
|---|---|---|---|
| `profile` | `"cursor-parity"` \| `"recall-0.5"` | `recall-0.5` | Named knob set |
| `stateDir` | string | `~/.openclaw/context-graphs` | Not `~/.cursor/…` unless the operator opts in |
| `kMax` | int | 64 | Live $C_t$ rows |
| `chunksPerTurn` | int | 16 | Rows admitted per ingest |
| `poolEma` | number | 0.5 | Merge keeps more new mass than Cursor’s 0.7 |
| `protectKinds` | string[] | `path,decision,identifier` | Never-merge matrix rows |
| `forwardBudget` | int | 2048 | Pack $B_{\max}$ in $\tau$ units until a host tokenizer exists |
| `hotSetMaxChars` | int | 800 | HOT_SET prefix |
| `keepRecentTokens` | int | 4000 | Raw tail (not 20k) |
| `noveltyBudgetFloor` | number | 1.0 | Do not shrink $B_t$ on long sessions |
| `rankFallbackTopK` | int | 8 | Weak-cosine fallback |
| `matrixSpanReadout` | bool | true | `expand_spans` into ranked family |
| `matrixSpanK` | int | 8 | Spans pulled from sidecars |
| `ingestToolResults` | bool | true | Tool dumps enter graph as Event/Fact, not full dump in tail |
| `skipHeartbeats` | bool | true | `ingest({ isHeartbeat })` no-op |
| `pythonPath` | string | auto | Sidecar interpreter |
| `engineImpl` | `"sidecar"` \| `"ts"` | `sidecar` then `ts` | Runtime switch |
| `promoteMemoryNotes` | bool | false | Append compact notes to daily memory file |
| `injectP1` | bool | false | Debug only |

`cursor-parity` restores K_MAX 32, chunks 8, EMA 0.7, budget 1024, HOT_SET 400, novelty floor 0.5 — useful as an A/B arm.

Doctor should flag: missing Python when `engineImpl=sidecar`; unwritable `stateDir`; slot set to `compressor` while plugin disabled; `keepRecentTokens` large enough to recreate last-N replay (operator-chosen threshold).

Easy install:

```bash
openclaw plugins install clawhub:soltrinox/openclaw-compressor
```

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

Restart the Gateway. `openclaw doctor` confirms the slot.

---

## 7. Dual-state model

comPREssOR keeps two local memories. The OpenClaw plugin reuses both.

### 7.1 Symbolic graph $G_t$

`ctx-graph/v1` node kinds: Turn, Topic, Fact, OpenItem, Event.  
Relations: mentions, contains, continues, supersedes, derived_from.

HOT_SET slot shares (unchanged):

$$
s_{\mathrm{open}}=0.40,\quad s_{\mathrm{decision}}=0.40,\quad s_{\mathrm{path}}=0.20.
$$

Default HOT_SET `max_chars` under `recall-0.5` is 800 (Cursor default 400). Ranking within buckets uses salience plus Jaccard overlap with the query.

OpenClaw-specific extractors to add:

- Opaque identifiers: UUIDs, `https://` URLs, Cloud Run URLs, Telegram message ids → Fact `kind_hint=identifier`, protected in $C_t$.
- Slash-command outcomes (`/compact`, `/new`) as Events, not OpenItems.
- Channel sender in group chats as Topic only when mentioned.

Caps for `recall-0.5`: active turns 48, durable facts 48, non-durable 64.

### 7.2 Matrix $C_t$

$C_t \in \mathbb{R}^{k \times d}$, $d=256$ hashed n-grams by default, $k \le K_{\max}$.

Today most of a turn never enters the matrix: `encode_rows` uses `max_chunks=8`, then `append_then_pool` EMA-merges until `K_MAX=32` with `DEFAULT_EMA=0.7` (merges keep 70% of the older row). The Cursor pack often ignores $C_t$ except for optional Pattern-1 decode.

**Admission (recall-0.5 lever):** encode up to 16 chunks per turn; EMA 0.5; protect path/decision/identifier rows from `append_then_pool`. Unprotected adjacent pairs still merge when $k > K_{\max}$.

**Readout (required):** `assemble` calls `expand_spans(q, k=matrixSpanK)` and concatenates those verbatim chunks into the ranked family after graph rank, before pack. Do not enable Pattern-1 to chase retention.

Protected-row pool:

```text
if row tagged path|decision|identifier:
  skip EMA merge (counts against K_MAX but never collapses)
else:
  append_then_pool as today
```

Note: fixture `entity_recall` in the Python engine is a term-hit proxy (`metrics.entity_recall`). The test gate today is `>= 0.3`. The `recall-0.5` profile is an **engineering target** for that proxy class, not a quality score. Implementers decide pass/fail in §19.

### 7.3 Packer $\Pi$

Keep $\theta = \mathtt{MIN\_RANK\_SCORE} = 0.03$. Do not raise it toward 0.5; that filters chunks out. Raise `RANK_FALLBACK_TOP_K` to 8. Collect last 16 turns. `MARGINAL_JACCARD` 0.92. `noveltyBudgetFloor` 1.0 so $B_t = B_{\max}$.

Pack order:

1. HOT_SET (identifiers and open work first)
2. Typed projection
3. Graph-ranked chunks
4. Matrix-span readout

Stop when $\tau(P_t) \ge B_t$. $\tau$ is `(len(text)+3)//4` for nonempty text — internal packing only.

---

## 8. OpenClaw lifecycle mapping

| comPREssOR / Cursor | OpenClaw context engine | Action |
|---|---|---|
| `beforeSubmitPrompt` → `step(user)` + inject pack | `assemble({ messages, tokenBudget, prompt })` | Recent turns + `systemPromptAddition` from the pack |
| `afterAgentResponse` → `step(assistant)` | `ingest` / `ingestBatch` / `afterTurn` | Persist assistant + tool text into $G_t$ and $C_t$ |
| `preCompact` → flush graph, freeze snapshot | `compact()` with `ownsCompaction: true` | Typed compact entry; no LLM summary |
| `sessionStart` → flush + pack | `bootstrap()` | Load graph; import transcript via cursor API |
| Cursor `agent_id` | `sessionKey` / `agentId` | One graph per session; optional share per agent |
| Fail-open `{continue:true}` | Engine quarantine → `legacy` | Never silence the agent |

Required engine contract (or OpenClaw falls back to legacy for that turn):

- `transcriptSemantics.currentTurnFence: "before-current-turn-entry-v1"`
- `turnAdvancementIdempotency: "atomic-idempotent-v1"`
- `commitTurn({ advancementKey, messages })` as one atomic write

Declare `hostRequirements["agent-run"].requiredCapabilities: ["assemble-before-prompt"]`. Native Codex still owns its own thread history; the engine only projects into Codex developer instructions.

---

## 9. Module design

### 9.1 Plugin entry (`src/index.ts`)

`definePluginEntry` from `openclaw/plugin-sdk/plugin-entry`. `register(api)`:

- `api.registerContextEngine("compressor", factory)`
- optional `api.registerAgentToolResultMiddleware` only if manifest lists runtimes
- optional Control UI descriptor
- `api.lifecycle.registerRuntimeLifecycle` to dispose sidecar on reload/shutdown
- do **not** `registerMemoryCapability`

Factory `ctx` supplies `config`, `agentDir`, `workspaceDir`. Build one `EngineHost` per factory invocation (per agent workspace).

### 9.2 Identity (`ids.ts`)

| Mode | Graph root | When |
|---|---|---|
| Default | `sessionKey` | Isolation; groups do not leak |
| Optional `shareGraphByAgent` | `agentId` | Telegram + WebChat share OpenItems |

Sanitize ids with `[A-Za-z0-9._-]`. Heartbeat and `/new` must not reuse a compacted successor without `commitTurn` / `sessionTarget` handling.

### 9.3 Ingest (`ingest.ts` + `handle.step`)

| OpenClaw message | Role | Graph effect |
|---|---|---|
| user | `user` | Topics, OpenItems, paths |
| assistant | `assistant` | Decisions, completions, supersede |
| tool call + result | `assistant` or `event` | Paths, errors, truncated gist if `ingestToolResults` |
| heartbeat | skip | No $C_t$ pollution |
| compaction notice | skip | Not durable work |

Tool results: store a bounded gist (head, exit code, extracted paths, first error line) in the graph; keep full text only in span sidecars with a size cap (e.g. 8k chars per result). The raw tail in `assemble` keeps paired tool messages for the recent window only.

### 9.4 Assemble (`assemble.ts`)

Inputs: `messages`, `tokenBudget`, `prompt`, `sessionKey`, `availableTools`, `citationsMode`, `runtimeSettings`.

1. Resolve handle; ingest any messages not yet committed (idempotent by message id if the host provides one; else hash role+content+index).
2. Split `messages` into recent tail by **host** token estimate when `runtimeSettings.limits` is present; else $\tau$ with `keepRecentTokens`. Never split a tool call from its result.
3. `sample_for("cursor-sdk", query=prompt || last user text)` with readout enabled.
4. `systemPromptAddition` = pack + `STATE` line + `buildMemorySystemPromptAddition(...)`.
5. Return `{ messages: tail, estimatedTokens, systemPromptAddition }`. Prefer `promptAuthority: "assembled"` while `ownsCompaction: true`.

Under pressure, drop ranked prose first, then matrix spans, then typed lines. HOT_SET and identifier vault last.

### 9.5 Compact (`compact.ts`)

On `/compact` or overflow recovery:

1. `flush_graph()` + freeze `precompact/` snapshot.
2. Build compact entry text from HOT_SET + identifier vault + optional `/compact Focus on X` as the query.
3. Rewrite transcript via `runtimeContext.rewriteTranscriptEntries()` or return successor `sessionTarget` if you create a new session identity. Prefer **keeping session identity** unless you must rotate.
4. Return `{ ok: true, compacted: true }`. Never call the conversation model.

If compact fails, throw; host falls back to legacy after quarantine. Empty compact must not look like success.

### 9.6 Commit (`commit.ts`)

Persist `advancementKey` → inclusive message range in SQLite beside `meta.sqlite`. First write `{ status: "committed" }`; retries `{ status: "duplicate" }`.

### 9.7 Bootstrap, afterTurn, subagents, dispose

- `bootstrap`: load graph from disk; if empty, `ingestBatch` visible transcript via `readSessionTranscriptVisibleMessageDelta`.
- `afterTurn`: persist; optional memory-note promotion; stage log.
- `prepareSubagentSpawn`: copy parent HOT_SET + identifier vault into child graph; do not copy 20k tokens. Isolated+lightContext: skip if the host skips the hook.
- `onSubagentEnded`: ingest child OpenItems/Facts with `derived_from`.
- `dispose`: kill sidecar, close SQLite.

### 9.8 Sidecar protocol (`claw_cli.py`)

Do not reuse Cursor `hook_cli` JSON (`additional_context`, `continue`). New commands:

```text
step { agent_id, role, text, flush_graph? }
sample { agent_id, query, budget, span_k }
flush { agent_id }
expand_spans { agent_id, query, k }
health {}
```

Transport: subprocess, JSONL stdin/stdout, bounded timeouts, always-exit-0 with `{ ok:false, error }` so the TS host can throw and trigger quarantine. One sidecar per plugin factory (per agent dir), not per turn.

Provisioning: on first factory init, create venv under plugin global storage, install the vendored wheel. If Python is missing, doctor fails; `engineImpl=ts` works after v1.1.

### 9.9 Tool-result middleware (phase 2)

Manifest: `contracts.agentToolResultMiddleware: ["openclaw"]` (add `codex` only if tested). After `exec`/`read`/`browser`, shrink huge results before they re-enter the model. Ingest gist into $G_t$. This is the durable version of OpenClaw pruning (pruning is in-memory only).

### 9.10 Companion skill

`skills: ["./skill/compressor"]`. Short SKILL.md: treat HOT_SET as bounded session state; prefer pack over pasting the transcript. Skills are on-demand; they do not assemble context.

### 9.11 Optional Control UI

`registerControlUiDescriptor` tab: live $k$, last pack $\tau$, sidecar health, current profile. Gateway methods under plugin prefix, `operator.read` only.

---

## 10. Data model and files

| Artifact | Writer | Reader | Model-visible? |
|---|---|---|---|
| `graph.json` | ingest/flush | assemble, compact, UI | Only via projection |
| `graph_tNNNN.json` | cadence flush | debug | no |
| `tNNNN.safetensors` | step | span scoring, optional P1 | no |
| `tNNNN.spans.json` | step | `expand_spans` | selected text only |
| `meta.sqlite` | store + commitTurn | lineage, advancementKey | no |
| `precompact/` | compact | recovery | no |
| `logs/stages-*.log.txt` | all | doctor, probes | no |
| `inject-history.json` | sample | dedup | no |

Lineage: `StateNode` with `state_id`, `parent_id`, `t`, blob path, graph path — keep the existing schema so comPREssOR debugging still applies.

Privacy: state is local to the Gateway host. Uninstall does not delete graphs unless the operator runs purge. Default `stateDir` is `~/.openclaw/context-graphs/` so Cursor sessions are not mixed unless the operator points them together.

---

## 11. Runtime sequence (one user message)

```text
message:received
  → engine.ingest (skip heartbeat)
agent run
  → assemble
       load S_t
       sample P_t (HOT_SET, typed, rank, spans)
       cut tail to keepRecentTokens
       prepend memory addition
  → model (tail + systemPromptAddition + tools)
  → ingestBatch assistant + tools
  → commitTurn(advancementKey)
  → afterTurn
if overflow or /compact
  → compact (typed checkpoint, no LLM)
  → retry assemble
```

Cursor `beforeSubmitPrompt` could not strip native history. Here `assemble` **is** the prompt.

---

## 12. Supercharge mechanisms (phase 2+)

Ranked by leverage; not required for 0.1.0.

1. **Tool-result reducer** — `registerAgentToolResultMiddleware` for `openclaw`.
2. **Host embedding rank** — optional hybrid $0.5\cos_{\mathrm{hash}}+0.5\cos_{\mathrm{host}}$ using `registerEmbeddingProvider`. Fail back to hash.
3. **Channel-aware ingest** — group vs DM; skip other senders’ noise in $C_t$.
4. **Subagent HOT_SET fork** — `prepareSubagentSpawn` / `onSubagentEnded` as above.
5. **Compact = typed checkpoint** — `/compact Focus on X` becomes the query for that pack.
6. **Promote into OpenClaw memory** — append durable decisions to `memory/YYYY-MM-DD.md`; leave `plugins.slots.memory` as `memory-core`.
7. **Two-layer pack cache** — if `openitem_signature` unchanged and Jaccard(q, last_q) high, reuse last pack. Skip heartbeats.
8. **`/context`-visible accounting** — report pack vs tail vs bootstrap vs tools.
9. **Control UI tab** — operators inspect live $K$, last pack, sidecar health.
10. **Cross-channel agent graph** — optional one $S_t$ per `agentId`. Default off.

**Out of first scope:** compaction-provider-only mode, Pattern-1 inject, replacing memory-core, raising $\theta$, keeping a 20k recent tail “just in case.”

---

## 13. Security and operations

Native plugins equal Gateway code. Mitigations: no outbound network in assemble; no API keys in config; sidecar cannot execute shell from packer; sanitize log content; `stateDir` under home or an operator-chosen path.

Doctor checks: Python version, venv, writable state, slot match, last stage log age.

Reload: `dispose` sidecar; factory recreates. Config change of `engineImpl` requires Gateway restart.

---

## 14. Testing (engineering, not claims)

**Unit (no Gateway)**  
Port fixtures from comPREssOR `engine/tests/`: pack order, HOT_SET quotas, rank fallback, `append_then_pool` shape, `entity_recall` helper. Add an OpenClaw-like transcript with tool dumps (must not drown HOT_SET). Retention gates for the `recall-0.5` profile are implementer-chosen; record them in `docs/RESEARCH.md`.

**Sidecar contract**  
`health`, `step`, `sample` round-trip; timeout; malformed JSON returns `ok:false`.

**Plugin contract**  
`openclaw plugins inspect compressor --runtime --json` after `npm-pack:` install. Manifest schema rejects unknown config keys.

**Gateway probe**  
`scripts/probe-openclaw.sh` should exist so developers can compare `legacy` vs `compressor` on the same fixture. What to capture, how to score, and whether a given delta is “enough” is §19 — not a frozen product numeral in this spec.

**Compat**  
Watch OpenClaw beta tags; `pluginApi` floor must be tested before publish.

---

## 15. ClawHub ship checklist

1. Build `dist/` with runtime extensions.
2. `npm pack` includes `dist/`, `openclaw.plugin.json`, vendored wheel, skill.
3. `clawhub package validate` then `publish --dry-run` then `clawhub package publish`.
4. `openclaw.compat.pluginApi` and `openclaw.build.openclawVersion` set.
5. README: install, slot config, Python vs TS, doctor. No borrowed Cursor billing ratios.
6. Semver: 0.1.0 sidecar; 0.2.0 TS engine default; 0.3.0 middleware + UI.

---

## 16. Work packages and task DAG

### Package 0 — Scaffold and contracts

| ID | Task | Exit evidence |
|---|---|---|
| P0-1 | Repo + `package.json` + `openclaw.plugin.json` (`kind: context-engine`, strict schema) | local schema test or `clawhub package validate` |
| P0-2 | `definePluginEntry` registers engine id `compressor` | inspect runtime JSON |
| P0-3 | Config types + `recall-0.5` / `cursor-parity` | unit test defaults |
| P0-4 | README INSTALL + RESEARCH stub | files exist |
| P0-5 | Local link install `openclaw plugins install -l` | doctor sees plugin |

### Package 1 — Sidecar protocol

| ID | Task | Exit evidence |
|---|---|---|
| P1-1 | `claw_cli.py` commands step/sample/flush/expand_spans/health | pytest |
| P1-2 | TS client + spawn + venv provision | sidecar-smoke.sh PASS |
| P1-3 | Timeouts and fail-open mapping to throw | test: host throws on sidecar death |
| P1-4 | StateDir default `~/.openclaw/context-graphs` | files appear after step |

### Package 2 — Lifecycle

| ID | Task | Exit evidence |
|---|---|---|
| P2-1 | ingest + skip heartbeat + tool gist | graph nodes in fixture |
| P2-2 | assemble tail + pack + memory addition | returned messages length bounded |
| P2-3 | compact typed checkpoint, no LLM mock called | compact test |
| P2-4 | commitTurn duplicate/committed | retry test |
| P2-5 | bootstrap from disk | restart simulation |
| P2-6 | hostRequirements assemble-before-prompt | documented; factory info |

### Package 3 — Recall-0.5 admission and readout

| ID | Task | Exit evidence |
|---|---|---|
| P3-1 | Knobs: kMax 64, chunks 16, ema 0.5, protectKinds | config projection |
| P3-2 | Matrix span readout in sample | spans appear in pack |
| P3-3 | Identifier extractor | UUID/URL in HOT_SET or typed |
| P3-4 | Retention fixtures for the profile | tests exist; thresholds in RESEARCH.md |
| P3-5 | Tool dump does not evict OpenItem | pollution fixture |

### Package 4 — Gateway probe harness

| ID | Task | Exit evidence |
|---|---|---|
| P4-1 | probe script `legacy` vs `compressor` | runnable script + log capture |
| P4-2 | Capture usage, `/context` sizes, compact count, overflow retries | fields documented in RESEARCH.md |
| P4-3 | npm-pack install proof | inspect --runtime |

### Package 5 — TS engine

| ID | Task | Exit evidence |
|---|---|---|
| P5-1 | Port graph/pack/rank/chunks/metrics | golden tests vs Python |
| P5-2 | `engineImpl=ts` default path | sidecar optional |
| P5-3 | Pack parity on a shared fixture | implementer-defined tolerance |

### Package 6 — Supercharge

| ID | Task | Exit evidence |
|---|---|---|
| P6-1 | Tool-result middleware | contracts + reduced tool message |
| P6-2 | Subagent HOT_SET fork | prepareSubagentSpawn test |
| P6-3 | Optional memory note promotion | file append |
| P6-4 | Control UI tab | descriptor registered |
| P6-5 | Plugin CLI purge | destructive confirm |

### Package 7 — ClawHub publish

| ID | Task | Exit evidence |
|---|---|---|
| P7-1 | dist + pack includes wheel/skill | `npm pack` list |
| P7-2 | dry-run publish | clawhub JSON |
| P7-3 | publish + install from `clawhub:` | doctor slot |
| P7-4 | Compat floor documented | package.json fields |

**Ship gate for 0.1.0:** P0–P4 + P7. P5 is strongly recommended before calling it Gateway-native. P6 is enhancement.

---

## 17. Phased delivery

**0.1.0 Sidecar engine (MVP)**  
Installable ClawHub plugin; `assemble` + `compact` + `commitTurn`; recall-0.5 knobs; Python sidecar; probe harness. Operators need Python 3.11+.

**0.2.0 TypeScript engine**  
Default `engineImpl=ts`. Python optional. This is the easy-install bar for hosts that will not provision a venv.

**0.3.0 Supercharge**  
Tool middleware, subagent fork, UI, memory-note writer.

Do not hold 0.1.0 for the TS port if the sidecar is stable; do not market 0.1.0 as zero-dependency.

---

## 18. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Sidecar latency on every ingest | Batch ingest; keep sidecar warm; skip heartbeats |
| Python missing on server | Doctor + 0.2.0 TS path |
| Tail grew until it is last-N again | Cap `keepRecentTokens`; treat oversized tail as a research finding |
| Identifier still dropped | Protected facts + vault in compact entry |
| Codex native history dominates | Scope first measurements to the embedded runner |
| Dual plugin with lossless-claw | Exclusive slot; document “one engine” |
| State mix with Cursor | Separate default `stateDir` |
| Quarantine loops | Stage logs; never throw on empty pack, only on hard failures |

---

## 19. Areas for research

Implementers own scoring, corpora, tokenizers, and whether a given run is a ship gate. This spec does not freeze Cursor inject-path ratios, SDK billed totals, or fixture recall as OpenClaw product claims. Use `docs/RESEARCH.md` to record methods and results.

### 19.1 Retention vs volume

- How does fixture `entity_recall` (term-hit proxy in `metrics.py`) move when switching from the 0.3 test gate to the `recall-0.5` knobs (K_MAX, chunks per turn, EMA, span readout, HOT_SET chars)?
- What is the corresponding change in packed $\tau(P_t)$, host-estimated tokens, and provider billed input on an OpenClaw session?
- At what `keepRecentTokens` does the tail dominate the pack so the engine is last-N with extra metadata?

### 19.2 Matrix admission and readout

- Does raising chunks-per-turn and lowering EMA actually increase distinct entities in live $C_t$ rows, or only smear them?
- Do protected (never-merge) path/decision/identifier rows improve identifier survival in compact entries?
- Is hashed n-gram cosine sufficient, or does a host embedding provider change rank quality enough to matter?
- When does span sidecar readout help vs pollute the ranked family?

### 19.3 Assemble substitution vs inject-only

- Cursor could not strip native history. Measure whether OpenClaw `assemble()` that **returns a reduced `messages` array** changes billed input relative to `legacy` on the same Gateway, same model, same fixture.
- Separate the compact-call cost (LLM summarization tokens + latency) from the per-turn prompt cost.
- Compare embedded runner vs Codex app-server, where native thread history may remain.

### 19.4 Compaction quality

- Typed HOT_SET compact entry vs OpenClaw LLM summary: identifier survival, open-item survival, decision survival, operator preference.
- Overflow retry rate and `/compact` frequency vs `legacy`.
- Interaction with `identifierPolicy` when `ownsCompaction: true` (policy may not apply).

### 19.5 Tool dumps and pruning

- In-memory OpenClaw pruning vs durable tool-result middleware: which reduces window occupancy without dropping the failing command and path?
- Gist-size caps for tool sidecars vs losing the error line the next turn needs.

### 19.6 Multi-agent and channels

- `sessionKey` graphs vs `agentId`-shared graphs: cross-channel continuity vs group-chat pollution.
- Subagent fork: HOT_SET-only child context vs host `isolated` / `fork` / `lightContext` behavior.
- Heartbeat skip: any missed durable state on heartbeat-only agents?

### 19.7 Runtime cost

- Sidecar spawn vs warm process vs in-process TS port: ingest/assemble latency, Gateway RSS, failure isolation.
- Pack-cache hit rate when open items are unchanged.

### 19.8 Operator surfaces

- What `/context` breakdown is sufficient to debug “the model forgot X”?
- Control UI: which fields change operator behavior (profile, budget, purge)?

### 19.9 Suggested probe harness (not a locked scoreboard)

`scripts/probe-openclaw.sh` should be able to run two arms (`legacy`, `compressor`) on one fixture and write a timestamped `.log.txt` with at least:

- turn count, compact count, overflow retries
- assembled message count / estimated tokens (host and $\tau$)
- pack method, packed_tokens, span_k
- optional provider usage if the Gateway exposes it
- identifier / path / open-item presence checks the implementer defines

Interpret the log in `docs/RESEARCH.md`. Do not copy Cursor PERFORMANCE cards into the plugin README as OpenClaw results.

### 19.10 Related code and docs to study

- comPREssOR: `engine/src/chat_compressor/{graph,pack,rank,handle,compress,producer,hook_cli}.py`
- comPREssOR tests: `engine/tests/test_loop_upgrades.py` (`entity_recall >= 0.3` gate)
- OpenClaw: context engine, compaction, memory, plugin manifest, ClawHub publishing
- Comparable plugin: lossless-claw (`plugins.slots.contextEngine`)

---

## 20. Immediate next work

Scaffold this folder as `@soltrinox/openclaw-compressor`: `package.json`, `openclaw.plugin.json`, `definePluginEntry`, recall-0.5 config schema, local `-l` install, doctor. Do not publish. Do not change OpenClaw core.

Then Package 1 (`claw_cli` + sidecar), Package 2 (assemble/compact/commit), Package 3 (admission/readout), Package 4 (probe harness), Package 7 (ClawHub when the operator is ready).

---

## References

- [OpenClaw](https://docs.openclaw.ai/)
- [Context engine](https://docs.openclaw.ai/concepts/context-engine)
- [Compaction](https://docs.openclaw.ai/concepts/compaction)
- [Context](https://docs.openclaw.ai/concepts/context)
- [Memory](https://docs.openclaw.ai/concepts/memory)
- [Building plugins](https://docs.openclaw.ai/plugins/building-plugins)
- [Plugin manifest](https://docs.openclaw.ai/plugins/manifest)
- [Plugin SDK](https://docs.openclaw.ai/plugins/sdk-overview)
- [ClawHub](https://docs.openclaw.ai/clawhub)
- comPREssOR engine: `comPREssOR/engine/` (graph, pack, rank, handle)
