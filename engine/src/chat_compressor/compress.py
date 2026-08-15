"""Compression taxonomy and C_t merge (append-then-pool / slot-wise EMA)."""

from __future__ import annotations

import logging
import os
from typing import Literal

import numpy as np

Method = Literal[
    "digest",
    "hot_set",
    "p1",
    "p2",
    "extractive+hot",
    "extractive",
    "p1-debug",
    "query-pack",
]
DEFAULT_K_MAX = 64
DEFAULT_D = 256
# OpenClaw recall-0.5 default (Cursor upstream was 0.7; use env for cursor-parity)
DEFAULT_EMA = 0.5

log = logging.getLogger("chat_compressor.compress")


def resolve_ema(default: float = DEFAULT_EMA) -> float:
    raw = os.environ.get("CHAT_COMPRESSOR_EMA", "").strip()
    if not raw:
        return float(default)
    try:
        return max(0.0, min(1.0, float(raw)))
    except ValueError:
        return float(default)


def l2_normalize(rows: np.ndarray, eps: float = 1e-8) -> np.ndarray:
    norms = np.linalg.norm(rows, axis=-1, keepdims=True)
    return rows / np.maximum(norms, eps)


def _cosine_adjacent(a: np.ndarray, b: np.ndarray) -> float:
    na = float(np.linalg.norm(a))
    nb = float(np.linalg.norm(b))
    if na < 1e-12 or nb < 1e-12:
        return -1.0
    return float(np.dot(a, b) / (na * nb))


def classify_method(*, producer: str, sampled_via: str) -> str:
    if sampled_via == "p2":
        return "p2"
    if sampled_via in {"extractive+hot", "extractive", "hot_set", "p1-debug", "query-pack"}:
        return sampled_via
    if sampled_via == "p1":
        return "digest+p1" if producer == "embed" else "gist-hf+p1"
    return "digest"


def append_then_pool(
    prev_c: np.ndarray | None,
    new_rows: np.ndarray,
    k_max: int = DEFAULT_K_MAX,
    ema: float = DEFAULT_EMA,
    protect_mask: list[bool] | None = None,
    protect_kinds_tags: list[set[str]] | None = None,
) -> np.ndarray:
    """Append new gist rows, then EMA-merge highest-cosine adjacent pair until k <= k_max.

    When ``protect_mask`` is provided (aligned with the stacked rows after concat),
    pairs where either row is protected are ineligible for EMA merge. Overflow then
    evicts oldest unprotected rows. Identifier-tagged protected rows are last to go.
    When ``protect_mask`` is None, behavior matches Cursor upstream.
    """
    if new_rows.ndim == 1:
        new_rows = new_rows[None, :]
    if prev_c is None or prev_c.size == 0:
        stacked = np.asarray(new_rows, dtype=np.float32)
        n_prev = 0
    else:
        prev = np.asarray(prev_c, dtype=np.float32)
        stacked = np.vstack([prev, np.asarray(new_rows, dtype=np.float32)])
        n_prev = int(prev.shape[0])

    n = int(stacked.shape[0])
    if protect_mask is None:
        protected = [False] * n
        tags: list[set[str]] = [set() for _ in range(n)]
    else:
        if len(protect_mask) != n:
            # Allow mask for new rows only (common when prev tags unknown).
            if len(protect_mask) == n - n_prev and n_prev >= 0:
                protected = [False] * n_prev + [bool(x) for x in protect_mask]
            else:
                raise ValueError(
                    f"protect_mask length {len(protect_mask)} != stacked rows {n}"
                )
        else:
            protected = [bool(x) for x in protect_mask]
        if protect_kinds_tags is None:
            tags = [{"protected"} if p else set() for p in protected]
        elif len(protect_kinds_tags) == n:
            tags = [set(t) for t in protect_kinds_tags]
        elif len(protect_kinds_tags) == n - n_prev:
            tags = [set() for _ in range(n_prev)] + [set(t) for t in protect_kinds_tags]
        else:
            tags = [{"protected"} if p else set() for p in protected]

    while stacked.shape[0] > k_max:
        n = int(stacked.shape[0])
        best_i = -1
        best_sim = -2.0
        for i in range(n - 1):
            if protected[i] or protected[i + 1]:
                continue
            sim = _cosine_adjacent(stacked[i], stacked[i + 1])
            if sim > best_sim:
                best_sim = sim
                best_i = i

        if best_i >= 0:
            merged = ema * stacked[best_i] + (1.0 - ema) * stacked[best_i + 1]
            stacked = np.vstack(
                [stacked[:best_i], merged[None, :], stacked[best_i + 2 :]]
            )
            protected = protected[:best_i] + [False] + protected[best_i + 2 :]
            tags = tags[:best_i] + [set()] + tags[best_i + 2 :]
            continue

        # No eligible merge pair — evict oldest unprotected, then non-identifier protected.
        evict = _pick_eviction_index(protected, tags)
        if evict is None:
            log.warning("matrix_over_protected k=%d k_max=%d", n, k_max)
            evict = 0
        stacked = np.vstack([stacked[:evict], stacked[evict + 1 :]])
        protected = protected[:evict] + protected[evict + 1 :]
        tags = tags[:evict] + tags[evict + 1 :]

    return l2_normalize(stacked.astype(np.float32))


def _pick_eviction_index(
    protected: list[bool], tags: list[set[str]]
) -> int | None:
    """Prefer oldest unprotected; then oldest protected non-identifier; never prefer identifiers."""
    for i, p in enumerate(protected):
        if not p:
            return i
    for i, t in enumerate(tags):
        if "identifier" not in t:
            return i
    # All identifier — documented hard-cap stress: evict oldest identifier last resort.
    return 0 if protected else None


def live_mask(k: int, k_max: int | None = None) -> np.ndarray:
    if k_max is None or k_max == k:
        return np.ones((k,), dtype=np.float32)
    mask = np.zeros((k_max,), dtype=np.float32)
    mask[:k] = 1.0
    return mask
