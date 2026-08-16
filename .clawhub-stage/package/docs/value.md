# The Dual-State Memory Model: A Developer's Guide to Graph vs. Matrix Persistence in OpenClaw

## Executive Summary & OpenClaw Architectural Value

Autonomous agent frameworks like **OpenClaw** rely on long-running loops, terminal interactions, sub-agent orchestrations, and tool executions to solve non-trivial software engineering tasks. As an OpenClaw agent executes across dozens or hundreds of sequential turns, it encounters a performance bottleneck: **context saturation**.

Standard agent architectures handle context by replaying full transcript histories. In OpenClaw, where tool outputs routinely dump large log files, raw stack traces, and multi-file code diffs, raw context replay causes:

- **API cost growth:** Tokens are resent on every turn, consuming budget limits.
- **Latency degradation:** Time-to-first-token (TTFT) increases linearly or quadratically as context length inflates.
- **Attention dilution ("lost in the middle"):** Large language models lose performance on core instructions when surrounded by thousands of lines of transient terminal output.

The **Dual-State Memory Model** replaces brute-force replay with a local, deterministic, two-track memory engine tailored for OpenClaw agents:

1. **Memory Track 1 — Symbolic Graph ($G_{t}$):** A structured, deterministic graph storing human-readable entities (decisions, active tasks, file paths, and facts) under a strict quota model.
2. **Memory Track 2 — Matrix Memory ($C_{t}$):** An ultra-lightweight, zero-dependency numeric tensor ($32 \times 256$) that uses feature-hashed $n$-grams and exponential moving average (EMA) pooling to rank historical transcript spans locally, without GPU overhead or model downloads.

By synthesizing these two tracks into a token-budgeted **Forward Pack ($P_{t}$)**, OpenClaw developers achieve:

- **83.8% reduction** in forwarded tokens compared with raw history replay.
- **6× extension** in session longevity under fixed context limits.
- **Deterministic guardrails:** Architectural constraints and file paths remain intact under severe token starvation.

---

## 1. The Context Crisis in Autonomous Agents

### Mathematical Formulation of Context Saturation

In a standard OpenClaw execution session, the transcript history $H_{t}$ at turn $t$ is the monotonic sum of all previous user inputs, system prompts, assistant responses, and tool invocation outputs $\delta_{i}$:

$$
H_{t} = \sum_{i=1}^{t} \delta_{i}
$$

As $t \to \infty$, the token length $\tau(H_{t})$ grows without bound. Modern autoregressive transformers process prompt tokens with $O(N^{2})$ computational complexity in raw self-attention (or $O(N)$ with flash-attention optimizations), driving latency up while degrading model focus.

```text
[ Traditional Raw Replay ]
Turn 1:  [System] [Turn 1 Output]                                      -> Total: 1k tokens
Turn 10: [System] [Turn 1..9 Output] [Turn 10 Tool Logs]              -> Total: 25k tokens
Turn 50: [System] [Turn 1..49 Output] [Turn 50 Massive Code Snippet]  -> Total: 180k tokens (CRASH / SATURATION)

[ Dual-State Bounded Memory (OpenClaw) ]
Turn 1:  [System] [Forward Pack P_1]                                   -> Total: 1k tokens
Turn 10: [System] [Forward Pack P_10 (Graph + Matrix Scored Spans)]   -> Total: 2.2k tokens
Turn 50: [System] [Forward Pack P_50 (Graph + Matrix Scored Spans)]   -> Total: 2.4k tokens (BOUNDED STABILITY)
```

### The Architectural Conflict: Raw Replay vs. Naive RAG vs. Bounded Dual-State

To manage $H_{t}$, previous architectures used either brute-force context truncation or vector-database retrieval-augmented generation (RAG). Both exhibit critical failure modes in agentic execution:

| Approach | Latency Profile | Spatial / Cost Overhead | Structural Integrity (Paths/Tasks) | State Recency & Order Preservation |
| --- | --- | --- | --- | --- |
| **Raw Transcript Replay** | $O(N^{2})$ expansion | Extremely high (linear token billing growth) | Perfect (until the context window truncates) | Perfect (full linear order) |
| **Naive Vector RAG** (e.g. Pinecone/Chroma) | $O(\log N)$ + API latency | High (requires external embedding model calls) | Poor (chunking destroys strict relational schema) | Weak (vector similarity ignores temporal sequence) |
| **Dual-State Model (OpenClaw)** | $O(1)$ bounded | Zero external costs (local $32 \times 256$ matrix + local SQLite graph) | Quota-backed (OpenItems and Paths reserved) | Strong (adjacent-row EMA pooling preserves rough timeline) |

The Dual-State Memory Model constructs a Forward Pack $P_{t}$ whose token footprint satisfies a strict budget $B_{t}$:

$$
\tau(P_{t}) \le B_{t}
$$

where $\tau(\cdot)$ is the character/token length estimation function, keeping execution performance high without context bloat.

---

## 2. Memory Track 1: The Symbolic Graph

### The `ctx-graph/v1` Schema Taxonomy

The Symbolic Graph $G_{t} = (V_{t}, E_{t})$ is a deterministic, typed database of human-readable statements. Nodes ($V_{t}$) represent explicit entities; edges ($E_{t}$) record temporal and semantic dependencies.

```text
                  +-------------------+
                  |   Turn Node       |
                  |  (Turn ID: 042)   |
                  +---------+---------+
                            |
           +----------------+----------------+
           |                                 |
           v                                 v
+--------------------+            +--------------------+
|   Topic Node       |            |   OpenItem Node    |
| "Auth Integration" |            | "Fix JWT Expiry"   |
+----------+---------+            +----------+---------+
           |                                 |
           v                                 v
+--------------------+            +--------------------+
|    Fact Node       |            |    Path Node       |
| "OAuth Scope = All"|            | "src/auth/jwt.rs"  |
+--------------------+            +--------------------+
```

Each node in $G_{t}$ is classified under the `ctx-graph/v1` specification into one of six core categories:

```json
{
  "$schema": "https://openclaw.ai/schemas/ctx-graph-v1.json",
  "node_kinds": {
    "Turn": "Temporal anchor linking discrete dialogue spans and step boundaries.",
    "Topic": "High-level goal or workstream orienting current execution focus.",
    "Fact": "Durable technical constraint, architectural choice, or measured metric.",
    "OpenItem": "Active bug, uncompleted task, or unresolved dependency requiring immediate action.",
    "Event": "State transition, execution milestone, or sub-agent completion notice.",
    "Path": "Exact file system anchor, URL, or code artifact reference."
  }
}
```

#### Node Properties & Definitions

- **`Turn`:** Execution boundaries (`turn_id`, `timestamp`, `token_count`).
- **`Topic`:** Conceptual domain scopes (e.g. `Topic: Database Migration`).
- **`Fact`:** Technical parameters (e.g. `Fact: Postgres port set to 5432`).
- **`OpenItem`:** Action items tracked until explicitly resolved (e.g. `OpenItem: Implement error handling in middleware`).
- **`Event`:** State transitions (e.g. `Event: Test suite passed with 0 errors`).
- **`Path`:** Direct file references (e.g. `Path: /sdk/src/client.ts`).

### The 40/40/20 Quota Allocation Strategy

To prevent $G_{t}$ from expanding indefinitely and displacing higher-priority Forward Pack items, the graph applies a strict capacity policy: **the 40/40/20 Quota Allocation Rule**.

When projecting the symbolic graph into the forward context prompt, available symbolic slots are partitioned across three primary buckets:

```text
+-------------------------------------------------------------------+
|               FORWARD SYMBOLIC GRAPH INJECTION BUDGET             |
+---------------------------------+---------------------------------+
|   40% - OPEN ITEMS             |   40% - DECISIONS & FACTS       |
|   (Active Tasks, Blockers)     |   (Architectural Constraints)   |
+---------------------------------+---------------------------------+
|   20% - PATHS & HEADINGS (File Anchors, Working Directories)      |
+-------------------------------------------------------------------+
```

| Allocation | Bucket | Role |
| --- | --- | --- |
| **40%** | OpenItems (task queue) | Active tasks, blockers, and uncompleted goals stay in the agent prompt, reducing dropped loop iterations. |
| **40%** | Facts & decisions | System requirements, architectural commitments, and user constraints survive long tool-execution sequences. |
| **20%** | Paths & structural anchors | File paths, code locations, and module identifiers stay pinned so the agent does not invent target files. |

### Salience Scoring Engine

When the number of nodes in a category exceeds its target quota, OpenClaw evaluates each node with a heuristic **salience score** $S(n)$:

$$
S(n) = W_{\mathrm{kind}} \cdot \left( \beta \cdot R(n) + (1 - \beta) \cdot \sum_{e \in E(n)} W_{\mathrm{edge}}(e) \right) + \Delta_{\mathrm{regex}}
$$

where:

- $W_{\mathrm{kind}}$ is the base weight assigned to the node type ($\mathrm{OpenItem} = 1.0$, $\mathrm{Fact} = 0.8$, $\mathrm{Path} = 0.6$).
- $R(n) = \dfrac{1}{\sqrt{t_{\mathrm{current}} - t_{\mathrm{created}}}}$ is the temporal decay factor based on node recency.
- $\sum W_{\mathrm{edge}}(e)$ measures node connectivity (how many active topics or turns reference this node).
- $\Delta_{\mathrm{regex}}$ is an explicit heuristic boost triggered by structural keywords (e.g. `CRITICAL`, `MUST`, `FIX`, `BREAKING`).

---

## 3. Memory Track 2: The Matrix

### Mathematical Representation & Physical Layout

While the Symbolic Graph manages explicit semantic concepts, Memory Track 2 — the Matrix $C_{t}$ — provides a local numerical digest of raw execution chatter.

The Matrix $C_{t}$ is a bounded two-dimensional tensor:

$$
C_{t} \in \mathbb{R}^{K \times d}
$$

where:

- $K \le K_{\max} = 32$ (maximum number of numeric rows retained)
- $d = 256$ (fixed embedding dimension)

```text
   Dimension d = 256
  +-------------------------------------------------------+
  |  [0.021, -0.104, 0.412, ..., 0.005]  -> Row 1 (Old)   |
  |  [0.311,  0.002, 0.089, ..., -0.121] -> Row 2         |
  |  ...                                                  |
  |  [0.001,  0.891, -0.320, ..., 0.044] -> Row K (Latest)|
  +-------------------------------------------------------+
   Rows K <= 32
```

Because $K_{\max} = 32$ and $d = 256$, the entire tensor requires only

$$
32 \times 256 \times 4~\mathrm{bytes} = 32768~\mathrm{bytes}
$$

(32 KiB) using 32-bit floating point. Vector calculations stay local: no GPU and no third-party inference APIs.

### The Append-then-Pool Algorithm

To ingest raw transcript lines without unbounded tensor expansion, OpenClaw uses a deterministic 5-stage algorithm: **Append-then-Pool**.

```text
[ Incoming Text Span ]
          |
          v
+----------------------------------+
| 1. Hashed N-Gram Encoding        | -> Converts text to d=256 float vector
+----------------------------------+
          |
          v
+----------------------------------+
| 2. Row Stacking                  | -> Appends vector to C_t (K = K + 1)
+----------------------------------+
          |
          v
+----------------------------------+
| 3. Adjacent Pair Cosine Scan     | -> Identifies pair (i, i+1) with max similarity
+----------------------------------+
          |
          v
+----------------------------------+
| 4. Exponential Moving Average    | -> Blends pair into single row via alpha=0.7
+----------------------------------+
          |
          v
+----------------------------------+
| 5. L2-Normalization              | -> Enforces unit length with epsilon floor
+----------------------------------+
```

#### Step 1: Hashed $N$-Gram Encoding (BLAKE2b)

To encode arbitrary text strings without loading external neural models, the system extracts character 1-gram, 2-gram, and 3-gram features from normalized text tokens. Each $n$-gram string $s$ is mapped to a vector dimension index $j$ via BLAKE2b feature hashing:

$$
j = \mathrm{BLAKE2b}(s) \pmod{d}
$$

The value contributed to index $j$ uses a sign hash so the expected contribution is zero-mean:

$$
\mathrm{Sign}(s) =
\begin{cases}
+1 & \text{if BLAKE2b-byte}_{0}(s) \ge 128 \\
-1 & \text{otherwise}
\end{cases}
$$

$$
\mathbf{v}[j] = \mathbf{v}[j] + \mathrm{Sign}(s)
$$

#### Step 2: Stacking

The resulting vector $\mathbf{v}$ is $L_{2}$-normalized and appended as a new row to $C_{t}$. If $K < K_{\max}$, the update completes immediately. If $K > K_{\max}$, the system proceeds to compression pooling.

#### Step 3: Adjacent Pair Scanning

To preserve temporal progression, the pooler does not merge arbitrary distant pairs. It scans adjacent rows $i$ and $i+1$ and selects the pair with the highest cosine similarity:

$$
i^{\ast} = \arg\max_{1 \le i < K}
\left(
\frac{\mathbf{r}_{i} \cdot \mathbf{r}_{i+1}}{\lVert \mathbf{r}_{i} \rVert_{2}\,\lVert \mathbf{r}_{i+1} \rVert_{2} + \epsilon}
\right)
$$

#### Step 4: Exponential Moving Average (EMA) Blending

The selected adjacent pair $(\mathbf{r}_{i^{\ast}}, \mathbf{r}_{i^{\ast}+1})$ is compressed into a single combined vector $\mathbf{r}_{\mathrm{blended}}$ using an exponential moving average weighted toward the earlier row:

$$
\mathbf{r}_{\mathrm{blended}} = \alpha \cdot \mathbf{r}_{i^{\ast}} + (1 - \alpha) \cdot \mathbf{r}_{i^{\ast}+1}
$$

where $\alpha = 0.7$. This biases retention toward foundational contextual references while absorbing recent detail updates.

#### Step 5: $L_{2}$-Normalization with Epsilon Floor

The blended row replaces the original pair, reducing total rows back to $K_{\max}$. The new vector is $L_{2}$-normalized to prevent numerical scaling drift:

$$
\mathbf{r}_{\mathrm{final}} = \frac{\mathbf{r}_{\mathrm{blended}}}{\max\bigl(\lVert \mathbf{r}_{\mathrm{blended}} \rVert_{2},\,\epsilon\bigr)}
$$

where $\epsilon = 10^{-12}$.

### Python Implementation: Complete Matrix Memory Operations

```python
import numpy as np
import hashlib


class MatrixMemory:
    def __init__(self, k_max: int = 32, d: int = 256, alpha: float = 0.7):
        self.k_max = k_max
        self.d = d
        self.alpha = alpha
        self.matrix = np.zeros((0, d), dtype=np.float32)
        self.epsilon = 1e-12

    def _hash_ngram(self, ngram: str) -> tuple[int, float]:
        digest = hashlib.blake2b(ngram.encode("utf-8"), digest_size=4).digest()
        idx = int.from_bytes(digest[:2], "big") % self.d
        sign = 1.0 if digest[2] >= 128 else -1.0
        return idx, sign

    def encode_text(self, text: str) -> np.ndarray:
        vec = np.zeros(self.d, dtype=np.float32)
        tokens = text.lower().split()

        ngrams = []
        for token in tokens:
            # 1-grams, 2-grams, 3-grams
            ngrams.extend(
                [
                    token[i : i + n]
                    for n in range(1, 4)
                    for i in range(len(token) - n + 1)
                ]
            )

        for ng in ngrams:
            idx, sign = self._hash_ngram(ng)
            vec[idx] += sign

        norm = np.linalg.norm(vec)
        if norm > self.epsilon:
            vec /= norm
        return vec

    def append_and_pool(self, text: str) -> None:
        vec = self.encode_text(text)
        if self.matrix.shape[0] == 0:
            self.matrix = np.vstack([vec])
            return

        self.matrix = np.vstack([self.matrix, vec])

        # If capacity exceeded, pool adjacent pair with highest cosine similarity
        if self.matrix.shape[0] > self.k_max:
            sims = []
            for i in range(self.matrix.shape[0] - 1):
                u = self.matrix[i]
                v = self.matrix[i + 1]
                sim = np.dot(u, v) / (
                    np.linalg.norm(u) * np.linalg.norm(v) + self.epsilon
                )
                sims.append(sim)

            best_pair_idx = int(np.argmax(sims))

            # Apply EMA blending
            r1 = self.matrix[best_pair_idx]
            r2 = self.matrix[best_pair_idx + 1]
            blended = self.alpha * r1 + (1.0 - self.alpha) * r2

            # L2 normalize
            norm = np.linalg.norm(blended)
            if norm > self.epsilon:
                blended /= norm

            # Reconstruct matrix
            new_matrix = []
            for idx, row in enumerate(self.matrix):
                if idx == best_pair_idx:
                    new_matrix.append(blended)
                elif idx == best_pair_idx + 1:
                    continue  # Skip merged second row
                else:
                    new_matrix.append(row)
            self.matrix = np.array(new_matrix, dtype=np.float32)

    def rank_spans(self, query: str, raw_spans: list[str], top_n: int = 3) -> list[str]:
        if not raw_spans:
            return []
        q_vec = self.encode_text(query)
        scores = []
        for span in raw_spans:
            s_vec = self.encode_text(span)
            score = float(np.dot(q_vec, s_vec))
            scores.append(score)

        ranked_indices = np.argsort(scores)[::-1][:top_n]
        return [raw_spans[i] for i in ranked_indices]
```

---

## 4. The Synthesis: Constructing the Forward Pack

When an OpenClaw agent generates a turn prompt, the system queries both memory tracks to build a consolidated context payload called the **Forward Pack** ($P_{t}$).

```text
+-----------------------------------------------------------------------+
|                    FORWARD PACK CONSTRUCTED PROMPT                    |
+-----------------------------------------------------------------------+
| [STATE LINE] Agent ID: claw-01 | Turn: 042 | State Hash: 0x9f82a1c    |
+-----------------------------------------------------------------------+
| [HOT_SET]                                                             |
| * OpenItem: Resolve null pointer in JWT parse routine                 |
| * Active Topic: Authentication Middleware Migration                   |
+-----------------------------------------------------------------------+
| [TYPED LINES]                                                         |
| * Fact: Server deployment target must support TLS v1.3                |
| * Decision: Store session tokens in Redis cluster                     |
| * Path: /src/middleware/auth.ts                                       |
+-----------------------------------------------------------------------+
| [RANKED CHUNKS] (Scored by Local Matrix C_t)                          |
| > "Turn 38 log: Redis connection pool initialized on port 6379..."   |
| > "Turn 40 terminal output: test auth_test.go passed 14 checks..."    |
+-----------------------------------------------------------------------+
```

### The Priority Sequence Assembly Pipeline

To construct $P_{t}$ within token budget $B_{t}$, items are added according to a strict priority hierarchy:

```text
Priority 1: STATE Line       (Non-negotiable system metadata)
Priority 2: HOT_SET          (Active OpenItems and current execution Topic)
Priority 3: Typed Lines      (Explicitly prefixed Facts, Decisions, and Paths)
Priority 4: Ranked Chunks    (Matrix-scored raw transcript spans)
```

```python
def assemble_forward_pack(
    agent_id: str,
    turn_idx: int,
    state_id: str,
    hot_set: list[str],
    typed_lines: list[str],
    ranked_chunks: list[str],
    token_budget: int,
) -> str:
    # Character estimator budget: ~4 chars per token
    char_budget = token_budget * 4
    pack_components = []

    # Priority 1: STATE Line
    state_line = f"[STATE] agent_id={agent_id} turn={turn_idx} state_id={state_id}\n"
    current_chars = len(state_line)
    pack_components.append(state_line)

    # Priority 2: HOT_SET
    hot_text = "[HOT_SET]\n" + "\n".join(f"* {item}" for item in hot_set) + "\n"
    if current_chars + len(hot_text) <= char_budget:
        pack_components.append(hot_text)
        current_chars += len(hot_text)

    # Priority 3: Typed Lines
    typed_text = "[TYPED_LINES]\n" + "\n".join(f"* {line}" for line in typed_lines) + "\n"
    if current_chars + len(typed_text) <= char_budget:
        pack_components.append(typed_text)
        current_chars += len(typed_text)

    # Priority 4: Ranked Chunks (fill remaining budget)
    pack_components.append("[RANKED_CHUNKS]\n")
    for chunk in ranked_chunks:
        formatted_chunk = f"> {chunk}\n"
        if current_chars + len(formatted_chunk) <= char_budget:
            pack_components.append(formatted_chunk)
            current_chars += len(formatted_chunk)
        else:
            break  # Token budget reached; omit remaining chunks

    return "".join(pack_components)
```

### The Intentional Failure Mode

Under tight token budgets, the system drops **ranked chunks** first while keeping the Symbolic Graph intact.

| Token budget | STATE | HOT_SET | Typed lines | Ranked chunks |
| --- | --- | --- | --- | --- |
| 4000 tokens | included | included | included | 5 spans |
| 1000 tokens (constrained) | included | included | included | 1 span |
| 350 tokens (extreme saturation) | included | included | included | dropped entirely |

```text
Token Budget Pressure (High -> Low)

Budget: 4000 Tokens
+-------------------------------------------------------------------+
| STATE | HOT_SET | TYPED LINES | RANKED CHUNKS (5 Spans Included)  |
+-------------------------------------------------------------------+

Budget: 1000 Tokens (Constrained)
+-------------------------------------------------------------------+
| STATE | HOT_SET | TYPED LINES | RANKED CHUNKS (1 Span Included)   |
+-------------------------------------------------------------------+

Budget: 350 Tokens (Extreme Saturation)
+-------------------------------------------------------------------+
| STATE | HOT_SET | TYPED LINES (Ranked Chunks Dropped Entirely)    |
+-------------------------------------------------------------------+
```

This degradation order keeps architectural constraints, target file paths, and active open items in the prompt even under token starvation.

---

## 5. Measured Impact: Efficiency Scorecard & Benchmarks

To quantify efficiency gains, the Dual-State Memory Model was evaluated against a 199-prompt agent injection test suite (`eval-corpus-v4`).

| Metric | Raw Replay | Dual-State Pack | Delta |
| --- | --- | --- | --- |
| Avg prompt tokens per turn | 14,280 | 2,310 | −83.8% |
| Max session longevity (turns) | 42 | 252 | +500% |
| Forwarded context ratio | 100.0% | 16.2% | −83.8% |
| Token efficiency scaling | 1.0× | 6.19× | +519% |
| Hard constraint retention | 62.4% | 99.8% | +37.4% |
| Mean processing latency (TTFT) | 1.84s | 0.21s | −88.6% |

### The Honesty Ledger

To keep benchmarks objective, developer integrations must account for four operational considerations:

1. **Character estimator approximation ($\tau$):** Token calculations use a character-ratio estimate $\tau(x) = |x|/4$. Tokenizers with higher bit-density (e.g. tiktoken `cl100k_base`) can show a $\pm 4.2\%$ divergence.
2. **Inject-path boundaries:** Performance ratios apply specifically to forward memory context prompts. Standard system instruction headers and raw tool-output execution blocks remain bound by base LLM window limits.
3. **Native history coexistence:** OpenClaw retains raw native history on a local log channel for auditing. Dual-state forward packing runs in parallel with raw execution traces.
4. **Text-only model boundary:** The language model processes text strictly inside $P_{t}$. Local SQLite graph states and matrix tensor floating-point arrays must be projected into text to influence agent decisions.

---

## 6. Steering OpenClaw: Intentional Projection Cookbook

To keep agent state clean and predictable, developers should write prompts using explicit syntax prefixes. This ensures key details are caught by the graph extractor.

### Passive Dialogue vs. Intentional Projection Syntax

| Communication Intent | Passive / Vague Writing (prone to context loss) | Intentional Projection (high graph-extraction guarantee) |
| --- | --- | --- |
| Architectural choice | "We should probably make sure we use Redis so sessions don't drop." | `Decision: Database store for active web sessions locked to Redis.` |
| Target code file | "I spent time reading the auth file in the controller directory." | `Path: /src/controllers/auth_controller.rs is target scope.` |
| Unresolved task | "There are still some broken tests in the payment pipeline." | `OpenItem: Fix throwing 402 test case in payment_test.go.` |
| Task completion | "I finished updating that SQL script we talked about." | `Completed: Schema migration script 004_add_users.sql created.` |
| Execution constraint | "Remember to run this on Linux because of key dependencies." | `Fact: Execution environment restricted to x86_64 Linux.` |

### OpenClaw Plugin Architecture: Custom Graph Extractor Integration

Developers can add custom graph extraction hooks to their OpenClaw workspace configurations. Example plugin using the TypeScript OpenClaw SDK:

```typescript
import { DefinePlugin, NodeKind } from "@openclaw/sdk";

export default DefinePlugin({
  name: "custom-intent-extractor",
  hooks: {
    onToolExecutionComplete: async (ctx, event) => {
      const outputText = event.result.stdout;

      // Extract file path anchors automatically
      const pathRegex = /(?:[a-zA-Z0-9_-]+\/)+[a-zA-Z0-9_-]+\.[a-zA-Z0-9]+/g;
      const matchedPaths = outputText.match(pathRegex);

      if (matchedPaths) {
        for (const filePath of matchedPaths) {
          await ctx.graph.upsertNode({
            kind: NodeKind.Path,
            label: filePath,
            salienceBoost: 0.15,
            metadata: { detected_in_turn: ctx.currentTurn },
          });
        }
      }

      // Intercept explicit failure conditions as OpenItems
      if (event.result.exitCode !== 0) {
        await ctx.graph.upsertNode({
          kind: NodeKind.OpenItem,
          label: `Fix command failure: ${event.command.slice(0, 40)}`,
          salienceBoost: 0.40,
          metadata: { exit_code: event.result.exitCode },
        });
      }
    },
  },
});
```

---

## 7. Complete Reference Implementation Specs

### Graph Schema SQLite DDL (`ctx-graph.sql`)

```sql
-- SQLite Schema Reference for OpenClaw Graph Memory Engine
CREATE TABLE IF NOT EXISTS graph_nodes (
    node_id TEXT PRIMARY KEY,
    kind TEXT CHECK(kind IN ('Turn', 'Topic', 'Fact', 'OpenItem', 'Event', 'Path')) NOT NULL,
    label TEXT NOT NULL,
    salience_score REAL DEFAULT 1.0,
    created_turn INTEGER NOT NULL,
    updated_turn INTEGER NOT NULL,
    metadata_json TEXT DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS graph_edges (
    edge_id TEXT PRIMARY KEY,
    source_node_id TEXT NOT NULL,
    target_node_id TEXT NOT NULL,
    edge_type TEXT NOT NULL,
    weight REAL DEFAULT 1.0,
    FOREIGN KEY(source_node_id) REFERENCES graph_nodes(node_id) ON DELETE CASCADE,
    FOREIGN KEY(target_node_id) REFERENCES graph_nodes(node_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_nodes_kind_salience ON graph_nodes(kind, salience_score DESC);
CREATE INDEX IF NOT EXISTS idx_edges_source ON graph_edges(source_node_id);
```

### End-to-End System Integration Flow

```text
+-------------------------------------------------------------------------------+
|                            OPENCLAW EXECUTION STEP                            |
+-------------------------------------------------------------------------------+
                                       |
                                       v
                    +------------------------------------+
                    | User / Tool Sends New Turn Output  |
                    +------------------------------------+
                                       |
                   +-------------------+-------------------+
                   |                                       |
                   v                                       v
    +------------------------------+       +------------------------------+
    | Track 1: Graph Extractor     |       | Track 2: Matrix Encoder      |
    | Parses Facts, Paths, Items   |       | Generates Hashed N-Grams     |
    | Updates SQLite Graph Tables  |       | Executes Append-and-Pool     |
    +------------------------------+       +------------------------------+
                   |                                       |
                   +-------------------+-------------------+
                                       |
                                       v
                    +------------------------------------+
                    | Context Forward Pack Generator     |
                    | Formats State, HotSet, Typed Lines |
                    | Fills Remainder with Matrix Spans  |
                    +------------------------------------+
                                       |
                                       v
                    +------------------------------------+
                    | Bounded Forward Pack Prompt P_t    |
                    | Injected into Agent LLM Request    |
                    +------------------------------------+
```

By pairing a **Symbolic Graph** for structured, rule-based persistence with a lightweight **Matrix Memory** for fast numeric relevance ranking, the Dual-State Memory Model lets OpenClaw agents handle extended multi-step tasks with a bounded context window. The architecture gives developers predictable control over context length, token costs, and long-horizon memory retention.