"""Token-budget packer: HOT_SET → typed lines → ranked chunks."""

from __future__ import annotations

import hashlib
import os
from dataclasses import dataclass, field

from chat_compressor.extractive import jaccard, keyword_set
from chat_compressor.metrics import estimate_tokens


DEFAULT_FORWARD_BUDGET = 2048
DEDUP_K = 3
WARMUP_TURNS = 3
# recall-0.5 defaults (cursor-parity callers may pass 0.8 / 0.5 explicitly)
MARGINAL_JACCARD = 0.92
SKIP_FLOOR_TOKENS = 64
NOVELTY_BUDGET_FLOOR = 1.0


def forward_budget() -> int:
    raw = os.environ.get("CHAT_COMPRESSOR_FORWARD_BUDGET", "").strip()
    if not raw:
        return DEFAULT_FORWARD_BUDGET
    try:
        return max(1, int(raw))
    except ValueError:
        return DEFAULT_FORWARD_BUDGET


def novelty_budget_floor() -> float:
    raw = os.environ.get("CHAT_COMPRESSOR_NOVELTY_FLOOR", "").strip()
    if not raw:
        return float(NOVELTY_BUDGET_FLOOR)
    try:
        return max(0.0, min(1.0, float(raw)))
    except ValueError:
        return float(NOVELTY_BUDGET_FLOOR)


def marginal_jaccard_threshold(default: float = MARGINAL_JACCARD) -> float:
    raw = os.environ.get("CHAT_COMPRESSOR_MARGINAL_JACCARD", "").strip()
    if not raw:
        return float(default)
    try:
        return max(0.0, min(1.0, float(raw)))
    except ValueError:
        return float(default)


def cross_turn_dedup_enabled() -> bool:
    raw = os.environ.get("CHAT_COMPRESSOR_CROSS_TURN_DEDUP", "1").strip().lower()
    return raw not in {"0", "false", "no", "off"}


def count_tokens(text: str) -> tuple[int, int]:
    """Return (whitespace_tokens, chars/4_tokens)."""
    ws = len(text.split()) if text.strip() else 0
    chars4 = estimate_tokens(text) if text else 0
    return ws, chars4


def line_hash(text: str) -> str:
    return hashlib.sha1(text.strip().lower().encode("utf-8")).hexdigest()[:16]


def adaptive_budget(
    t: int,
    novelty_rate: float,
    cap: int | None = None,
    floor: float | None = None,
) -> int:
    """B_max for the first 3 turns, then scale to rolling novelty (capped)."""
    limit = int(cap if cap is not None else forward_budget())
    limit = max(1, limit)
    if int(t) <= WARMUP_TURNS:
        return limit
    rate = max(0.0, min(1.0, float(novelty_rate)))
    rho_min = novelty_budget_floor() if floor is None else float(floor)
    scaled = int(limit * max(rho_min, rate))
    return max(SKIP_FLOOR_TOKENS, min(limit, scaled))


@dataclass(frozen=True)
class PackResult:
    text: str
    packed_tokens: int
    tokens_ws: int
    tokens_chars4: int
    budget: int
    rate: float
    method: str
    novel_tokens: int = 0
    dup_suppressed_tokens: int = 0
    line_hashes: tuple[str, ...] = field(default_factory=tuple)
    tau_hot: int = 0
    tau_typed: int = 0
    tau_ranked: int = 0
    tau_spans: int = 0


def pack_forward(
    *,
    hot_set: str = "",
    typed_lines: list[str] | None = None,
    ranked_chunks: list[str] | None = None,
    span_chunks: list[str] | None = None,
    budget: int | None = None,
    recent_hashes: set[str] | None = None,
    openitem_changed: bool = True,
    node_superseded: bool = False,
    allow_skip: bool = False,
    marginal_jaccard: float | None = None,
    skip_floor_tokens: int = SKIP_FLOOR_TOKENS,
) -> PackResult:
    """Pack in order. HOT_SET → typed → ranked → spans. Cap at budget (chars/4)."""
    cap = int(budget if budget is not None else forward_budget())
    cap = max(1, cap)
    mu = marginal_jaccard_threshold() if marginal_jaccard is None else float(marginal_jaccard)
    parts: list[str] = []
    used = 0
    packed_norm: set[str] = set()
    method = "hot_set"
    dup_suppressed = 0
    tau_hot = 0
    tau_typed = 0
    tau_ranked = 0
    tau_spans = 0
    suppress = set(recent_hashes or ())
    if node_superseded or not cross_turn_dedup_enabled():
        suppress = set()

    def _blocked(text: str) -> bool:
        if not suppress:
            return False
        return line_hash(text) in suppress

    extra_parts: list[str] = []

    def _marginal(text: str) -> bool:
        if not extra_parts:
            return False
        body = "\n".join(extra_parts)
        return jaccard(keyword_set(text), keyword_set(body)) > mu

    hot = (hot_set or "").strip()
    if hot:
        piece = f"HOT_SET:\n{hot}"
        toks = estimate_tokens(piece)
        if toks > cap:
            piece = _truncate_to_budget(piece, cap)
            toks = estimate_tokens(piece)
        parts.append(piece)
        used += toks
        tau_hot = toks
        packed_norm.add(hot.lower())
        for line in hot.splitlines():
            packed_norm.add(line.strip().lower())

    def _fits(block: str) -> bool:
        return used + estimate_tokens(block) <= cap

    typed_added = False
    for line in typed_lines or []:
        text = (line or "").strip()
        if not text:
            continue
        key = text.lower()
        if key in packed_norm:
            continue
        if _blocked(text):
            dup_suppressed += estimate_tokens(text)
            continue
        if _marginal(text):
            dup_suppressed += estimate_tokens(text)
            continue
        if not _fits(text):
            continue
        toks = estimate_tokens(text)
        parts.append(text)
        extra_parts.append(text)
        used += toks
        tau_typed += toks
        packed_norm.add(key)
        typed_added = True

    chunk_added = False
    for chunk in ranked_chunks or []:
        text = (chunk or "").strip()
        if not text:
            continue
        key = text.lower()
        if key in packed_norm or _contained_in_hot(text, hot):
            continue
        if _blocked(text):
            dup_suppressed += estimate_tokens(text)
            continue
        if _marginal(text):
            dup_suppressed += estimate_tokens(text)
            continue
        if not _fits(text):
            continue
        toks = estimate_tokens(text)
        parts.append(text)
        extra_parts.append(text)
        used += toks
        tau_ranked += toks
        packed_norm.add(key)
        chunk_added = True

    span_added = False
    for chunk in span_chunks or []:
        text = (chunk or "").strip()
        if not text:
            continue
        key = text.lower()
        if key in packed_norm or _contained_in_hot(text, hot):
            continue
        if _blocked(text):
            dup_suppressed += estimate_tokens(text)
            continue
        if _marginal(text):
            dup_suppressed += estimate_tokens(text)
            continue
        if not _fits(text):
            continue
        toks = estimate_tokens(text)
        parts.append(text)
        extra_parts.append(text)
        used += toks
        tau_spans += toks
        packed_norm.add(key)
        span_added = True

    body = "\n\n".join(parts).strip()
    ws, chars4 = count_tokens(body)
    packed = chars4
    if packed > cap and body:
        body = _truncate_to_budget(body, cap)
        ws, chars4 = count_tokens(body)
        packed = chars4
    if typed_added or chunk_added or span_added:
        method = "query-pack"
    elif not hot:
        method = "extractive" if (chunk_added or span_added) else "hot_set"

    skip = (
        allow_skip
        and cross_turn_dedup_enabled()
        and not openitem_changed
        and not node_superseded
        and packed < skip_floor_tokens
    )
    if skip:
        hashes: tuple[str, ...] = ()
        return PackResult(
            text="",
            packed_tokens=0,
            tokens_ws=0,
            tokens_chars4=0,
            budget=cap,
            rate=0.0,
            method="skip",
            novel_tokens=0,
            dup_suppressed_tokens=dup_suppressed + packed,
            line_hashes=hashes,
            tau_hot=0,
            tau_typed=0,
            tau_ranked=0,
            tau_spans=0,
        )

    hashes = tuple(line_hash(line) for line in body.splitlines() if line.strip())
    novel = packed
    if suppress and hashes:
        novel_body_parts = [
            line
            for line in body.splitlines()
            if line.strip() and line_hash(line) not in (recent_hashes or set())
        ]
        novel = estimate_tokens("\n".join(novel_body_parts)) if novel_body_parts else 0
    rate = (packed / cap) if cap else 0.0
    return PackResult(
        text=body,
        packed_tokens=packed,
        tokens_ws=ws,
        tokens_chars4=chars4,
        budget=cap,
        rate=rate,
        method=method,
        novel_tokens=novel,
        dup_suppressed_tokens=dup_suppressed,
        line_hashes=hashes,
        tau_hot=tau_hot,
        tau_typed=tau_typed,
        tau_ranked=tau_ranked,
        tau_spans=tau_spans,
    )


def _contained_in_hot(text: str, hot: str) -> bool:
    if not hot or not text:
        return False
    needle = text.lower()
    hay = hot.lower()
    if needle in hay:
        return True
    # typed "OpenItem: milk" vs hot "OpenItem milk: open: milk"
    if ":" in text:
        rest = text.split(":", 1)[1].strip().lower()
        if rest and rest in hay:
            return True
    return False


def _truncate_to_budget(text: str, budget: int) -> str:
    if estimate_tokens(text) <= budget:
        return text
    # chars/4 ≈ budget → max_chars = budget * 4
    max_chars = max(1, budget * 4)
    if len(text) <= max_chars:
        return text
    return text[: max(0, max_chars - 3)].rstrip() + "..."
