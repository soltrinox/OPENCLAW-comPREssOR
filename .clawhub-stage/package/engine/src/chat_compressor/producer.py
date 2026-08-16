"""C_t producers: hashed n-gram fallback, optional ST embed, optional HF gist."""

from __future__ import annotations

import hashlib
import os
import re
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from chat_compressor.chunks import chunk_text
from chat_compressor.compress import (
    DEFAULT_D,
    DEFAULT_EMA,
    DEFAULT_K_MAX,
    append_then_pool,
    live_mask,
    resolve_ema,
)

TOKEN_RE = re.compile(r"[A-Za-z0-9_']+")
UUID_RE = re.compile(
    r"\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b"
)
URL_RE = re.compile(r"https://[^\s<>\"']{4,200}")
PATHISH_RE = re.compile(
    r"(?:^|[\s`\"'(])((?:[\w.-]+/)+[\w.-]+\.[A-Za-z0-9]{1,12}|/[\w./-]+)"
)
DECISION_RE = re.compile(
    r"\b(decided|chose|decision|instead of|must not|constraint|invariant|policy)\b",
    re.I,
)


def chunks_per_turn(default: int = 16) -> int:
    raw = os.environ.get("CHAT_COMPRESSOR_CHUNKS_PER_TURN", "").strip()
    if not raw:
        return int(default)
    try:
        return max(1, int(raw))
    except ValueError:
        return int(default)


def protect_kinds() -> set[str]:
    raw = os.environ.get("CHAT_COMPRESSOR_PROTECT_KINDS", "path,decision,identifier").strip()
    if not raw:
        return {"path", "decision", "identifier"}
    return {p.strip().lower() for p in raw.split(",") if p.strip()}


def _chunk_text(text: str, max_chunks: int | None = None) -> list[str]:
    """Compat wrapper — structure-aware chunker lives in chunks.py."""
    n = chunks_per_turn() if max_chunks is None else int(max_chunks)
    return chunk_text(text, max_chunks=n)


def tag_chunk(text: str, kinds: set[str] | None = None) -> set[str]:
    """Heuristic tags for protected-row pooling (path / decision / identifier)."""
    active = kinds if kinds is not None else protect_kinds()
    tags: set[str] = set()
    body = text or ""
    if "identifier" in active and (UUID_RE.search(body) or URL_RE.search(body)):
        tags.add("identifier")
    if "path" in active and PATHISH_RE.search(body):
        tags.add("path")
    if "decision" in active and DECISION_RE.search(body):
        tags.add("decision")
    return tags


def hashed_ngram_embed(text: str, d: int = DEFAULT_D, seed: int = 0) -> np.ndarray:
    """Hash-stable mean-pooled n-gram projection. No model downloads."""
    vec = np.zeros((d,), dtype=np.float32)
    tokens = TOKEN_RE.findall(text.lower())
    if not tokens:
        tokens = ["empty"]
    for n in (1, 2, 3):
        for i in range(len(tokens) - n + 1):
            gram = " ".join(tokens[i : i + n])
            payload = f"{seed}:{n}:{gram}".encode("utf-8")
            digest = hashlib.blake2b(payload, digest_size=8).digest()
            idx = int.from_bytes(digest[:4], "little") % d
            sign = 1.0 if digest[4] % 2 == 0 else -1.0
            vec[idx] += sign
    norm = float(np.linalg.norm(vec))
    if norm > 0:
        vec /= norm
    return vec


@dataclass
class CompressResult:
    C: np.ndarray
    M: np.ndarray
    producer: str
    KV: np.ndarray | None = None


class EmbeddingProducer:
    """Default offline producer. Uses ST if EMBED_MODEL_PATH loads; else hashed."""

    def __init__(
        self,
        d: int = DEFAULT_D,
        k_max: int = DEFAULT_K_MAX,
        seed: int = 0,
        name: str = "embed",
        ema: float | None = None,
    ) -> None:
        self.d = int(d)
        self.k_max = int(k_max)
        self.seed = int(seed)
        self.name = name
        self.ema = float(ema) if ema is not None else resolve_ema(DEFAULT_EMA)
        self._st_model = None
        self._try_load_sentence_transformer()

    def _try_load_sentence_transformer(self) -> None:
        path = os.environ.get("EMBED_MODEL_PATH", "").strip()
        if not path:
            return
        try:
            from sentence_transformers import SentenceTransformer

            self._st_model = SentenceTransformer(path)
            self.d = int(self._st_model.get_sentence_embedding_dimension())
        except Exception:
            self._st_model = None

    def encode_rows(self, text: str) -> tuple[np.ndarray, list[str]]:
        chunks = _chunk_text(text)
        if self._st_model is not None:
            emb = np.asarray(self._st_model.encode(chunks), dtype=np.float32)
            return emb, chunks
        rows = np.stack([hashed_ngram_embed(c, d=self.d, seed=self.seed) for c in chunks])
        return rows, chunks

    def compress(self, prev_c: np.ndarray | None, new_input: str) -> CompressResult:
        new_rows, chunks = self.encode_rows(new_input)
        kinds = protect_kinds()
        tags = [tag_chunk(c, kinds) for c in chunks]
        mask = [bool(t) for t in tags]
        # Prev rows: unknown tags → unprotected (mergeable) unless caller tracks them.
        n_prev = 0 if prev_c is None or getattr(prev_c, "size", 0) == 0 else int(prev_c.shape[0])
        full_mask = [False] * n_prev + mask
        full_tags: list[set[str]] = [set() for _ in range(n_prev)] + tags
        c_t = append_then_pool(
            prev_c,
            new_rows,
            k_max=self.k_max,
            ema=self.ema,
            protect_mask=full_mask,
            protect_kinds_tags=full_tags,
        )
        return CompressResult(C=c_t, M=live_mask(c_t.shape[0]), producer=self.name)


class GistHFProducer:
    """Optional local transformers gist model. Env-gated; never used by pytest."""

    def __init__(
        self,
        model_path: str,
        k_max: int = DEFAULT_K_MAX,
        name: str = "gist-hf",
        ema: float | None = None,
    ) -> None:
        self.model_path = model_path
        self.k_max = int(k_max)
        self.name = name
        self.ema = float(ema) if ema is not None else resolve_ema(DEFAULT_EMA)
        self.d = DEFAULT_D
        self._model = None
        self._tokenizer = None
        self._load()

    def _load(self) -> None:
        from transformers import AutoModel, AutoTokenizer

        self._tokenizer = AutoTokenizer.from_pretrained(self.model_path)
        self._model = AutoModel.from_pretrained(self.model_path)
        self._model.eval()
        self.d = int(self._model.config.hidden_size)

    def compress(self, prev_c: np.ndarray | None, new_input: str) -> CompressResult:
        import torch

        assert self._model is not None and self._tokenizer is not None
        tokens = self._tokenizer(
            new_input,
            return_tensors="pt",
            truncation=True,
            max_length=512,
        )
        with torch.no_grad():
            out = self._model(**tokens)
            hidden = out.last_hidden_state[0].cpu().numpy().astype(np.float32)
        take = min(self.k_max, hidden.shape[0])
        new_rows = hidden[-take:]
        c_t = append_then_pool(prev_c, new_rows, k_max=self.k_max, ema=self.ema)
        kv = None
        if hasattr(out, "past_key_values") and out.past_key_values is not None:
            try:
                k_last = out.past_key_values[-1][0][0].cpu().numpy().astype(np.float32)
                kv = k_last[: c_t.shape[0]]
            except Exception:
                kv = None
        return CompressResult(C=c_t, M=live_mask(c_t.shape[0]), producer=self.name, KV=kv)


def make_producer(
    *,
    d: int = DEFAULT_D,
    k_max: int = DEFAULT_K_MAX,
    seed: int = 0,
    name: str = "embed",
) -> EmbeddingProducer | GistHFProducer:
    gist = os.environ.get("GIST_MODEL_PATH", "").strip()
    ema = resolve_ema(DEFAULT_EMA)
    if gist and Path(gist).exists():
        return GistHFProducer(gist, k_max=k_max, ema=ema)
    return EmbeddingProducer(d=d, k_max=k_max, seed=seed, name=name, ema=ema)
