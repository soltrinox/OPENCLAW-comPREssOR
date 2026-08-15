# Research methods — Gateway / engine probe

Replay definition, fixture names, and measurement protocol for Plan 05. Do not paste Cursor comPREssOR PERFORMANCE figures here or into README.

## Probe method

| Field | Value |
|-------|-------|
| Fixture path | `test/fixtures/probe-session.jsonl` |
| Fixture version | 1 |
| Fixture sha256 | `893bd5a616c7216e1f93531e87bf68dad11d8ce1138bdae52ca2902db0487d52` |
| Frozen refs | UUID `550e8400-e29b-41d4-a716-446655440000`; path `src/ids.ts`; OpenItem `sanitize session keys` |
| OpenClaw version / pluginApi | Gateway binary **NOT_RUN** (not on PATH); plugin `0.0.0-dev`; peer `>=2026.3.24-beta.2` |
| Model | **NOT_RUN** (`RUN_MODEL` default false) |
| Replay definition | **`R_full_host`** — all host messages before engine cut (legacy arm = `L_uncompacted_full` τ sum of fixture; compressor never sends full host replay to the model) |
| Tokenizer per field | **`tau=chars4`** for packer / assemble estimates; **`hosttok=absent`** (no `runtimeSettings.limits` in this harness) |
| Mechanism | **`engine_assemble_fixture`** (`scripts/probe-assemble-fixture.ts` via `scripts/probe-openclaw.sh`) |
| Live Gateway | **NOT_RUN** — no `openclaw` CLI; doctor/inspect stubs + Plan 01 prior doctor logs required |
| ClawHub / npm publish | **not run** |

### Named quantities

- $R_t$ / `R_full_host`: fixture transcript as host would hold before cut.
- $A_t = T_t \oplus P_t$: compressor assemble tail + `systemPromptAddition` (pack + STATE line).
- $L_t$ / `L_uncompacted_full`: volume upper bound = τ(all fixture messages). Not live legacy-with-compact.
- Units never mixed into one “tokens saved” headline.

### Field dictionary

| Field | Unit | Arm |
|-------|------|-----|
| turn_count | count | both |
| compact_count | count | both |
| overflow_retries | count | both |
| assemble_msg_count | count | both |
| estimated_tokens_sum | tau (named) | both |
| tau_pack_sum | tau | compressor |
| tau_tail_sum | tau | compressor |
| method_last | enum | compressor |
| span_k | int | compressor |
| k / k_max | int | compressor |
| quarantine | bool | compressor |
| id_hit path_hit openitem_hit | bool | both (last haystack) |
| heartbeat_k_delta | int | compressor (0 when ingest skips heartbeat) |
| compact_llm_calls | count | compressor must 0 |

## Results

### Environment grades

| Environment | Result | Evidence |
|-------------|--------|----------|
| Unit pytest | FULL | Plan 04 recall logs |
| Sidecar smoke | FULL | Plan 02 smoke log |
| Engine assemble fixture (default mock packer) | FULL | `probe-plan05-20260815-144510.log.txt` |
| Engine assemble + live sidecar (`PROBE_USE_SIDECAR=1`) | FAIL path_hit | `probe-plan05-sidecar-20260815-144532.log.txt` — research, not README |
| Live Gateway + model | NOT_RUN | no `openclaw` on PATH |
| Docker Gateway | NOT_RUN | no compose in plugin repo |
| Cloud | skip | not this phase |

### Two-arm table (default run — mock packer)

| Field | legacy (`L_uncompacted_full`) | compressor |
|-------|-------------------------------|------------|
| estimated_tokens_sum (tau) | 591 | 202 |
| assemble_msg_count | 38 | 28 |
| tau_pack_sum | 0 | 28 |
| tau_tail_sum | 591 | 174 |
| method_last | none | query-pack |
| quarantine | false | false |
| id_hit | PASS | PASS |
| path_hit | PASS | PASS |
| openitem_hit | PASS | PASS |
| compact_llm_calls | 0 | 0 |
| heartbeat_k_delta | — | 0 |
| delta_volume (tau) | — | 389 |
| WARN_LAST_N | — | yes (tail τ / est ≈ 0.86) |

**Usefulness (default mock arm):** **useful** — retention PASS, compact LLM calls 0, quarantine false, volume lower under matched τ units.

$$\eta_A = 1 - \frac{202}{591} \approx 0.658$$

(τ/τ only; not billed; not a README ship numeral.)

### Sidecar arm (optional research)

| Field | compressor (real SidecarClient) |
|-------|----------------------------------|
| estimated_tokens_sum (tau) | 438 |
| tau_pack_sum | 264 |
| id_hit / openitem_hit | PASS / PASS |
| path_hit | **FAIL** (`src/ids.ts` absent from last haystack) |
| usefulness | **harmful** — volume down AND path_hit FAIL |
| $\eta_A$ | $1 - 438/591 \approx 0.259$ (footnote: path miss) |

Next for path_hit: Plan 04 extractors / pack ranking — **out of Plan 05 file lock**. Harness correctly surfaces `WARN_THIN_PACK`.

### Retention checks

Implementer-frozen: UUID, `src/ids.ts`, OpenItem phrase must appear in `join(tail) + systemPromptAddition` after last assemble.

### npm pack

`npm pack --dry-run` lists `openclaw.plugin.json` and `skill/`. `dist/` **PARTIAL** until Plan 11 build. No publish.

## Non-claims

- Not Cursor `PERFORMANCE.md` / 84% inject-path cards.
- Not USD cost.
- Not a frozen product ship-gate numeral unless an operator explicitly promotes one after honesty review.
- $\eta_A$ under τ is not interchangeable with billed provider tokens.

## recall-0.5 fixture gates (engineering)

Filled by Plan 04 (in-process pytest; not Gateway probe).

| Field | Value |
|-------|-------|
| Fixture class | identifier + OpenItem + tool-dump (`test_recall_profile`, `test_pollution_tools`) |
| entity_recall observed | **1.0** on frozen OpenItem/UUID/URL sample text (term-hit proxy) |
| entity_recall gate tried | **0.5** (baseline Python gate was 0.3; implementer-owned) |
| pollution (path share) | **~0.055** on post-dump HOT_SET (`hot_set_pollution.pollution`) |
| preamble-in-HOT_SET cap | **0.35** (fixture assert) |
| identifier hit | **PASS** (UUID + Cloud Run URL in HOT_SET/typed/sample) |
| OpenItem-after-dump | **PASS** (`ids.ts` / OpenItem remains in HOT_SET) |
| protect-row eviction | When all adjacent pairs blocked: evict oldest unprotected, then oldest non-identifier protected; identifier rows last. |
| notes | Gateway two-arm path_hit FAIL on live sidecar is a separate measurement from Plan 04 in-process gates. |

## Fixtures

- `test/fixtures/probe-session.jsonl` (Plan 05)
- `engine/tests/test_recall_profile.py` / `test_pollution_tools.py` (Plan 04)

## Re-run

```bash
cd OPENCLAW/COMPRESSOR
export ARTIFACTS_DIR=test-results/openclaw-compressor
./scripts/probe-openclaw.sh
# optional live packer:
PROBE_USE_SIDECAR=1 ./scripts/probe-openclaw.sh
```

## Open questions

See SPECS §19. Live Gateway inject path remains a host-seam when `openclaw` is installed. Codex native-history scope not exercised (`SCOPE_EMBEDDED_ONLY` N/A).
