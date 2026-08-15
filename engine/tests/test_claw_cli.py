"""claw_cli JSONL contract tests — no hook_cli import; always-exit-0 errors."""

from __future__ import annotations

import ast
import json
import os
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
sys.path.insert(0, str(SRC))

from chat_compressor import claw_cli  # noqa: E402


def test_claw_cli_does_not_import_hook_cli():
    path = SRC / "chat_compressor" / "claw_cli.py"
    tree = ast.parse(path.read_text(encoding="utf-8"))
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module:
            assert "hook_cli" not in node.module
            for alias in node.names:
                assert alias.name != "hook_cli"
        if isinstance(node, ast.Import):
            for alias in node.names:
                assert "hook_cli" not in alias.name


def test_health_ok(tmp_path, monkeypatch):
    monkeypatch.setenv("CHAT_COMPRESSOR_STATE_DIR", str(tmp_path))
    monkeypatch.setenv("K_MAX", "16")
    resp = claw_cli.process_line(json.dumps({"id": "1", "cmd": "health", "params": {}}))
    assert resp["ok"] is True
    assert resp["id"] == "1"
    assert "python" in resp["result"]
    assert resp["result"]["engine"] == "chat_compressor"


def test_unknown_cmd(tmp_path, monkeypatch):
    monkeypatch.setenv("CHAT_COMPRESSOR_STATE_DIR", str(tmp_path))
    resp = claw_cli.process_line(json.dumps({"id": "2", "cmd": "nope", "params": {}}))
    assert resp["ok"] is False
    assert resp["error"]["code"] == "unknown_cmd"


def test_missing_agent_id_on_step(tmp_path, monkeypatch):
    monkeypatch.setenv("CHAT_COMPRESSOR_STATE_DIR", str(tmp_path))
    resp = claw_cli.process_line(
        json.dumps({"id": "3", "cmd": "step", "params": {"role": "user", "text": "hi"}})
    )
    assert resp["ok"] is False
    assert resp["error"]["code"] == "bad_request"


def test_bad_agent_id(tmp_path, monkeypatch):
    monkeypatch.setenv("CHAT_COMPRESSOR_STATE_DIR", str(tmp_path))
    resp = claw_cli.process_line(
        json.dumps(
            {
                "id": "4",
                "cmd": "step",
                "agent_id": "../evil",
                "params": {"role": "user", "text": "hi"},
            }
        )
    )
    assert resp["ok"] is False
    assert resp["error"]["code"] == "bad_agent_id"


def test_malformed_json_then_health(tmp_path, monkeypatch):
    monkeypatch.setenv("CHAT_COMPRESSOR_STATE_DIR", str(tmp_path))
    bad = claw_cli.process_line("{not json")
    assert bad["ok"] is False
    assert bad["error"]["code"] == "bad_json"
    good = claw_cli.process_line(json.dumps({"id": "h", "cmd": "health"}))
    assert good["ok"] is True


def test_step_sample_flush_expand(tmp_path, monkeypatch):
    monkeypatch.setenv("CHAT_COMPRESSOR_STATE_DIR", str(tmp_path))
    monkeypatch.setenv("K_MAX", "16")
    monkeypatch.setenv("CHAT_COMPRESSOR_FORWARD_BUDGET", "2048")
    agent = "sess_pytest_01"
    long_text = (
        "Fix OPENCLAW/COMPRESSOR/src/ids.ts UUID 550e8400-e29b-41d4-a716-446655440000. "
        * 20
    )
    step = claw_cli.process_line(
        json.dumps(
            {
                "id": "s1",
                "cmd": "step",
                "agent_id": agent,
                "params": {"role": "user", "text": long_text, "flush_graph": True},
            }
        )
    )
    assert step["ok"] is True, step
    assert step["result"]["t"] >= 1
    agent_dir = tmp_path / agent
    assert agent_dir.is_dir()

    sample = claw_cli.process_line(
        json.dumps(
            {
                "id": "s2",
                "cmd": "sample",
                "agent_id": agent,
                "params": {"query": "what UUID", "budget": 2048, "span_k": 8},
            }
        )
    )
    assert sample["ok"] is True, sample
    assert isinstance(sample["result"]["text"], str)
    assert sample["result"]["packed_tokens"] >= 1

    flush = claw_cli.process_line(
        json.dumps(
            {
                "id": "s3",
                "cmd": "flush",
                "agent_id": agent,
                "params": {"reason": "test"},
            }
        )
    )
    assert flush["ok"] is True, flush

    spans = claw_cli.process_line(
        json.dumps(
            {
                "id": "s4",
                "cmd": "expand_spans",
                "agent_id": agent,
                "params": {"query": "UUID", "k": 4},
            }
        )
    )
    assert spans["ok"] is True, spans
    assert isinstance(spans["result"]["spans"], list)


def test_default_state_root_is_openclaw():
    assert claw_cli.default_state_root() == Path.home() / ".openclaw" / "context-graphs"


def test_too_large_text(tmp_path, monkeypatch):
    monkeypatch.setenv("CHAT_COMPRESSOR_STATE_DIR", str(tmp_path))
    huge = "x" * (512 * 1024 + 1)
    resp = claw_cli.process_line(
        json.dumps(
            {
                "id": "big",
                "cmd": "step",
                "agent_id": "a1",
                "params": {"role": "user", "text": huge},
            }
        )
    )
    assert resp["ok"] is False
    assert resp["error"]["code"] == "too_large"
