#!/usr/bin/env python3
"""Dump golden fixtures for TS engine tests. Manual / reviewed — not silent in npm test."""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "engine" / "src"))

from chat_compressor.chunks import chunk_text
from chat_compressor.graph import CtxGraph
from chat_compressor.metrics import estimate_tokens
from chat_compressor.pack import pack_forward
from chat_compressor.producer import hashed_ngram_embed

OUT = ROOT / "test" / "goldens"
OUT.mkdir(parents=True, exist_ok=True)

strings = [
    "",
    "a",
    "hello",
    "src/ids.ts",
    "émoji 🚀 test",
    "OpenItem: fix-auth",
    "path: engine/src/foo.py",
    "The quick brown fox jumps over the lazy dog.",
    "UUID 550e8400-e29b-41d4-a716-446655440000",
    "https://example.com/x",
] + [f"line-{i} " * 10 for i in range(10)]

(OUT / "tau.json").write_text(
    json.dumps([{"text": s, "tau": estimate_tokens(s)} for s in strings[:20]], indent=2) + "\n"
)

embeds = {}
for s in [
    "src/ids.ts",
    "hello world",
    "OpenItem fix",
    "uuid-test 550e8400-e29b-41d4-a716-446655440000",
    "",
]:
    embeds[s if s else "(empty)"] = hashed_ngram_embed(s).tolist()
(OUT / "embed_vectors.json").write_text(json.dumps(embeds, indent=2) + "\n")

pack = pack_forward(
    hot_set="OpenItem fix-auth: open: fix-auth\nFact path: a/b.ts",
    typed_lines=["OpenItem: open: fix-auth", "Path: a/b.ts", "Fact: decided to use ts"],
    ranked_chunks=["relevant chunk about auth", "another chunk"],
    budget=256,
)
(OUT / "pack_order.json").write_text(
    json.dumps(
        {
            "hot_set": "OpenItem fix-auth: open: fix-auth\nFact path: a/b.ts",
            "typed_lines": ["OpenItem: open: fix-auth", "Path: a/b.ts", "Fact: decided to use ts"],
            "ranked_chunks": ["relevant chunk about auth", "another chunk"],
            "budget": 256,
            "text": pack.text,
            "packed_tokens": pack.packed_tokens,
            "method": pack.method,
            "tau_hot": pack.tau_hot,
        },
        indent=2,
    )
    + "\n"
)

sample = "# Title\n\nHello world. Next sentence.\n\n```\ncode\n```\n\ndef foo():\n  pass\n"
(OUT / "chunks.json").write_text(
    json.dumps({"input": sample, "chunks": chunk_text(sample, max_chunks=8)}, indent=2) + "\n"
)

g = CtxGraph()
g.ingest_turn(
    "user",
    "Please fix auth. UUID 550e8400-e29b-41d4-a716-446655440000 path src/auth.ts\nTODO: wire jwt\nWe decided to use TypeScript instead of Python.",
    0,
)
g.ingest_turn("assistant", "OpenItem wire jwt. Path src/auth.ts. Decision: use TypeScript.", 1)
(OUT / "hot_set.txt").write_text(g.hot_set(query="auth jwt", max_chars=800))
(OUT / "graph_fixture.json").write_text(g.dumps() + "\n")
print("wrote", list(OUT.iterdir()))
