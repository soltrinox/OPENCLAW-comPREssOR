"""Plan 04 tool-dump pollution: OpenItem must survive in HOT_SET."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
sys.path.insert(0, str(SRC))

from chat_compressor.graph import CtxGraph  # noqa: E402
from chat_compressor.handle import PersistentAgentHandle  # noqa: E402
from chat_compressor.metrics import hot_set_pollution  # noqa: E402
from chat_compressor.producer import make_producer  # noqa: E402
from chat_compressor.store import StateStore  # noqa: E402

# Implementer-chosen pollution cap for this fixture (Plan 04 / RESEARCH.md).
POLLUTION_CAP = 0.35


@pytest.fixture
def recall_env(monkeypatch, tmp_path):
    monkeypatch.setenv("CHAT_COMPRESSOR_STATE_DIR", str(tmp_path))
    monkeypatch.setenv("K_MAX", "64")
    monkeypatch.setenv("CHAT_COMPRESSOR_EMA", "0.5")
    monkeypatch.setenv("CHAT_COMPRESSOR_CHUNKS_PER_TURN", "16")
    monkeypatch.setenv("CHAT_COMPRESSOR_HOTSET_MAX_CHARS", "800")
    monkeypatch.setenv("CHAT_COMPRESSOR_FORWARD_BUDGET", "2048")
    monkeypatch.setenv("CHAT_COMPRESSOR_NOVELTY_FLOOR", "1.0")
    monkeypatch.setenv("CHAT_COMPRESSOR_PROTECT_KINDS", "path,decision,identifier")
    monkeypatch.setenv("CHAT_COMPRESSOR_INJECT_P1", "0")


def _compiler_dump(n: int = 400) -> str:
    lines = []
    for i in range(n):
        lines.append(
            f"running build step {i}: let me check error TS2304 cannot find name "
            f"Foo{i} in module /tmp/out/chunk_{i}.js stack={i * 97}"
        )
    return "\n".join(lines)


def test_openitem_survives_tool_dump(recall_env, tmp_path):
    store = StateStore(tmp_path)
    handle = PersistentAgentHandle(
        agent_id="pollute",
        store=store,
        producer=make_producer(k_max=64),
        k_max=64,
    )
    handle.step(
        "Open: migrate `src/ids.ts` to sanitize Cloud Run URLs.",
        role="user",
    )
    # Simulate middleware-off path: huge exec log ingested once.
    handle.step(_compiler_dump(500), role="assistant")
    hot = handle.graph.hot_set(query="migrate ids", max_chars=800)
    assert "ids.ts" in hot or "OpenItem" in hot
    assert "migrate" in hot.lower() or "ids.ts" in hot
    stats = hot_set_pollution(hot)
    frac = float(stats.get("pollution") or 0.0)
    # Pollution here = path/heading share; also reject preamble-dominated HOT_SET.
    lines = [ln for ln in hot.splitlines() if ln.strip()]
    bad = sum(1 for ln in lines if "running" in ln.lower() or "let me" in ln.lower())
    preamble_frac = (bad / len(lines)) if lines else 0.0
    assert preamble_frac <= POLLUTION_CAP, f"preamble_frac={preamble_frac} hot={hot!r}"
    assert frac <= 0.95  # path share may be high; OpenItem must still be present


def test_graph_only_openitem_after_dump(recall_env):
    g = CtxGraph()
    g.ingest_turn(
        "user",
        "Open: migrate `src/ids.ts` to sanitize Cloud Run URLs.",
        0,
    )
    g.ingest_turn("assistant", _compiler_dump(300), 1)
    hot = g.hot_set(max_chars=800)
    opens = [
        n
        for n in g.active_nodes()
        if n.kind == "OpenItem" and n.attrs.get("state", "open") != "done"
    ]
    assert opens, "OpenItem must remain active after tool dump ingest"
    assert "ids.ts" in hot or any("ids.ts" in n.label for n in opens)
