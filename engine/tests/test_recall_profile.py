"""Plan 04 recall-0.5 profile: knobs, pack order, protect rows, identifiers."""

from __future__ import annotations

import os
import sys
from pathlib import Path

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
sys.path.insert(0, str(SRC))

from chat_compressor.claw_cli import resolve_profile_knobs  # noqa: E402
from chat_compressor.compress import append_then_pool  # noqa: E402
from chat_compressor.graph import (  # noqa: E402
    MAX_ACTIVE_DURABLE_FACTS,
    MAX_ACTIVE_NON_DURABLE_FACTS,
    MAX_ACTIVE_TURNS,
    CtxGraph,
)
from chat_compressor.handle import PersistentAgentHandle  # noqa: E402
from chat_compressor.metrics import entity_recall  # noqa: E402
from chat_compressor.pack import (  # noqa: E402
    MARGINAL_JACCARD,
    NOVELTY_BUDGET_FLOOR,
    adaptive_budget,
    pack_forward,
)
from chat_compressor.producer import hashed_ngram_embed, make_producer  # noqa: E402
from chat_compressor.rank import rank_fallback_top_k, rank_relevant_chunks  # noqa: E402
from chat_compressor.store import StateStore  # noqa: E402
from chat_compressor.translate.vocab_bridge import inject_p1_enabled  # noqa: E402


UUID = "550e8400-e29b-41d4-a716-446655440000"
URL = "https://my-svc-abc123-uc.a.run.app/health"


@pytest.fixture
def recall_env(monkeypatch):
    monkeypatch.setenv("K_MAX", "64")
    monkeypatch.setenv("CHAT_COMPRESSOR_EMA", "0.5")
    monkeypatch.setenv("CHAT_COMPRESSOR_CHUNKS_PER_TURN", "16")
    monkeypatch.setenv("CHAT_COMPRESSOR_FORWARD_BUDGET", "2048")
    monkeypatch.setenv("CHAT_COMPRESSOR_HOTSET_MAX_CHARS", "800")
    monkeypatch.setenv("CHAT_COMPRESSOR_NOVELTY_FLOOR", "1.0")
    monkeypatch.setenv("CHAT_COMPRESSOR_RANK_FALLBACK_TOP_K", "8")
    monkeypatch.setenv("CHAT_COMPRESSOR_MARGINAL_JACCARD", "0.92")
    monkeypatch.setenv("CHAT_COMPRESSOR_PROTECT_KINDS", "path,decision,identifier")
    monkeypatch.setenv("CHAT_COMPRESSOR_INJECT_P1", "0")
    monkeypatch.setenv("CHAT_COMPRESSOR_MATRIX_SPAN_READOUT", "1")
    monkeypatch.setenv("CHAT_COMPRESSOR_MATRIX_SPAN_K", "8")


@pytest.fixture
def cursor_parity_env(monkeypatch):
    monkeypatch.setenv("K_MAX", "32")
    monkeypatch.setenv("CHAT_COMPRESSOR_EMA", "0.7")
    monkeypatch.setenv("CHAT_COMPRESSOR_CHUNKS_PER_TURN", "8")
    monkeypatch.setenv("CHAT_COMPRESSOR_FORWARD_BUDGET", "1024")
    monkeypatch.setenv("CHAT_COMPRESSOR_HOTSET_MAX_CHARS", "400")
    monkeypatch.setenv("CHAT_COMPRESSOR_NOVELTY_FLOOR", "0.5")
    monkeypatch.setenv("CHAT_COMPRESSOR_RANK_FALLBACK_TOP_K", "3")
    monkeypatch.setenv("CHAT_COMPRESSOR_MARGINAL_JACCARD", "0.8")


def test_recall_05_knob_projection(recall_env):
    knobs = resolve_profile_knobs()
    assert knobs["kMax"] == 64
    assert knobs["chunksPerTurn"] == 16
    assert knobs["poolEma"] == 0.5
    assert knobs["protectKinds"] == ["decision", "identifier", "path"]
    assert knobs["forwardBudget"] == 2048
    assert knobs["hotSetMaxChars"] == 800
    assert knobs["noveltyBudgetFloor"] == 1.0
    assert knobs["rankFallbackTopK"] == 8
    assert knobs["marginalJaccard"] == 0.92
    assert knobs["matrixSpanReadout"] is True
    assert knobs["matrixSpanK"] == 8
    assert knobs["injectP1"] is False
    assert MARGINAL_JACCARD == 0.92
    assert NOVELTY_BUDGET_FLOOR == 1.0
    assert MAX_ACTIVE_TURNS == 48
    assert MAX_ACTIVE_DURABLE_FACTS == 48
    assert MAX_ACTIVE_NON_DURABLE_FACTS == 64


def test_cursor_parity_knob_projection(cursor_parity_env):
    knobs = resolve_profile_knobs()
    assert knobs["kMax"] == 32
    assert knobs["chunksPerTurn"] == 8
    assert knobs["poolEma"] == 0.7
    assert knobs["forwardBudget"] == 1024
    assert knobs["hotSetMaxChars"] == 400
    assert knobs["noveltyBudgetFloor"] == 0.5
    assert knobs["rankFallbackTopK"] == 3
    assert knobs["marginalJaccard"] == 0.8


def test_inject_p1_default_false(recall_env):
    assert inject_p1_enabled() is False


def test_novelty_floor_keeps_bmax(recall_env):
    assert adaptive_budget(10, novelty_rate=0.1, cap=2048) == 2048


def test_pack_order_hot_typed_ranked(recall_env):
    packed = pack_forward(
        hot_set="OpenItem migrate: open: migrate src/ids.ts",
        typed_lines=[f"Fact: {UUID}"],
        ranked_chunks=["ranked unique prose about sanitizing urls"],
        span_chunks=["span verbatim chunk about cloud run"],
        budget=2048,
        allow_skip=False,
    )
    assert packed.text.startswith("HOT_SET:")
    hot_i = packed.text.index("HOT_SET:")
    typed_i = packed.text.index("Fact:")
    ranked_i = packed.text.index("ranked unique prose")
    span_i = packed.text.index("span verbatim chunk")
    assert hot_i < typed_i < ranked_i < span_i
    assert packed.tau_hot > 0
    assert packed.tau_typed > 0
    assert packed.tau_ranked > 0
    assert packed.tau_spans > 0


def test_rank_fallback_top_k_8(recall_env):
    assert rank_fallback_top_k() == 8
    # Force weak-cosine path: raise θ so every chunk fails the floor → fallback k=8.
    chunks = [f"unrelated compiler dump line number {i} xyzabc" for i in range(20)]
    ranked = rank_relevant_chunks(
        "session continuity identifiers",
        chunks,
        min_score=0.99,
        fallback_top_k=None,
    )
    assert len(ranked) == 8


def test_protected_identifier_row_survives_overflow(recall_env):
    """K_max=4 forced overflow: identifier row must keep identity (no EMA smear)."""
    prose = [hashed_ngram_embed(f"prose filler chunk about weather {i}") for i in range(4)]
    ident = hashed_ngram_embed(f"session uuid is {UUID} keep this identifier")
    prev = np.stack(prose[:2] + [ident] + prose[2:3])
    # tags aligned with prev
    prev_mask = [False, False, True, False]
    prev_tags = [set(), set(), {"identifier"}, set()]
    # overflow with two more prose rows
    new_rows = np.stack(prose[3:4] + [hashed_ngram_embed("more prose about logs")])
    # Full stacked mask after concat: prev + new
    full_mask = prev_mask + [False, False]
    full_tags = prev_tags + [set(), set()]
    out = append_then_pool(
        prev,
        new_rows,
        k_max=4,
        ema=0.5,
        protect_mask=full_mask,
        protect_kinds_tags=full_tags,
    )
    assert out.shape[0] == 4
    # Identifier row still present within 1e-5 cosine of original
    sims = [
        float(np.dot(out[i], ident) / (np.linalg.norm(out[i]) * np.linalg.norm(ident) + 1e-12))
        for i in range(out.shape[0])
    ]
    assert max(sims) > 0.999


def test_protect_mask_none_matches_unprotected_merge():
    """Mask None keeps Cursor-compatible merge path."""
    rows = np.stack([hashed_ngram_embed(f"sameish topic alpha {i%2}") for i in range(6)])
    a = append_then_pool(None, rows, k_max=3, ema=0.7, protect_mask=None)
    b = append_then_pool(None, rows, k_max=3, ema=0.7)
    assert a.shape == b.shape
    assert np.allclose(a, b, atol=1e-5)


def test_identifier_extractor_and_hot_set(recall_env, tmp_path, monkeypatch):
    monkeypatch.setenv("CHAT_COMPRESSOR_STATE_DIR", str(tmp_path))
    g = CtxGraph()
    text = (
        f"Open: migrate `src/ids.ts` to sanitize Cloud Run URLs. "
        f"Track request {UUID} at {URL}."
    )
    g.ingest_turn("user", text, 0)
    idents = [
        n
        for n in g.active_nodes()
        if n.kind == "Fact" and n.attrs.get("kind_hint") == "identifier"
    ]
    assert any(UUID in (n.label or "") for n in idents)
    assert any("run.app" in (n.label or "") for n in idents)
    hot = g.hot_set(query="what uuid", max_chars=800)
    typed = "\n".join(g.typed_projection(query="uuid", hot_set=hot))
    blob = hot + "\n" + typed
    assert UUID in blob
    assert "https://" in blob


def test_slash_compact_is_event_not_openitem(recall_env):
    g = CtxGraph()
    g.ingest_turn("user", "/compact Focus on identifiers", 0)
    events = [n for n in g.active_nodes() if n.kind == "Event"]
    opens = [n for n in g.active_nodes() if n.kind == "OpenItem"]
    assert any("/compact" in (n.label or n.summary) for n in events)
    assert not any("/compact" in (n.label or "").lower() for n in opens)


def test_sample_pack_contains_uuid_and_no_p1_bag(recall_env, tmp_path, monkeypatch):
    monkeypatch.setenv("CHAT_COMPRESSOR_STATE_DIR", str(tmp_path))
    store = StateStore(tmp_path)
    handle = PersistentAgentHandle(
        agent_id="recall-id",
        store=store,
        producer=make_producer(k_max=64),
        k_max=64,
    )
    handle.step(
        f"Open: keep {UUID} and call {URL} when migrating src/ids.ts.",
        role="user",
    )
    sampled = handle.sample_for("cursor-sdk", query="UUID Cloud Run")
    assert sampled.text.startswith("HOT_SET:") or "HOT_SET:" in sampled.text
    assert UUID in sampled.text
    # injectP1 off → pack is labeled text, not vocab-bag-only
    assert "OpenItem" in sampled.text or "Fact:" in sampled.text or "Fact " in sampled.text
    assert inject_p1_enabled() is False


def test_entity_recall_helper_exists(recall_env):
    score = entity_recall({"uuid", "migrate"}, f"migrate path keep {UUID}")
    assert 0.0 <= score <= 1.0
    assert score >= 0.3
