"""OpenClaw sidecar JSONL CLI — not Cursor hook_cli.

Transport: one JSON object per stdin line, one JSON object per stdout line.
Always exit 0. Application errors are in-band {ok:false}. Never source
~/.cursor/chat-compressor.env. Do not import hook_cli.
"""

from __future__ import annotations

import json
import logging
import os
import re
import sys
import time
import traceback
from collections import OrderedDict
from pathlib import Path
from typing import Any

from chat_compressor.handle import PersistentAgentHandle
from chat_compressor.producer import make_producer
from chat_compressor.store import StateStore

# Do not import hook_cli — enforced by tests.

_SAFE_AGENT_RE = re.compile(r"^[A-Za-z0-9._-]+$")
_MAX_TEXT_BYTES = 512 * 1024
_HANDLE_CAP = 64

_handles: OrderedDict[str, PersistentAgentHandle] = OrderedDict()
log = logging.getLogger("chat_compressor.claw_cli")


def default_state_root() -> Path:
    return Path.home() / ".openclaw" / "context-graphs"


def resolve_state_root() -> Path:
    raw = os.environ.get("CHAT_COMPRESSOR_STATE_DIR", "").strip()
    if raw:
        return Path(raw).expanduser()
    return default_state_root()


def resolve_k_max() -> int:
    """recall-0.5 default 64; cursor-parity projects K_MAX=32."""
    raw = os.environ.get("K_MAX", "").strip()
    if not raw:
        return 64
    try:
        return max(1, int(raw))
    except ValueError:
        return 64


def resolve_profile_knobs() -> dict[str, Any]:
    """Read env projection from TS spawn. Defaults = recall-0.5."""
    from chat_compressor.compress import resolve_ema
    from chat_compressor.graph import hot_set_max_chars
    from chat_compressor.handle import matrix_span_k, matrix_span_readout_enabled
    from chat_compressor.pack import (
        forward_budget,
        marginal_jaccard_threshold,
        novelty_budget_floor,
    )
    from chat_compressor.producer import chunks_per_turn, protect_kinds
    from chat_compressor.rank import rank_fallback_top_k

    return {
        "kMax": resolve_k_max(),
        "chunksPerTurn": chunks_per_turn(16),
        "poolEma": resolve_ema(0.5),
        "protectKinds": sorted(protect_kinds()),
        "forwardBudget": forward_budget(),
        "hotSetMaxChars": hot_set_max_chars(800),
        "noveltyBudgetFloor": novelty_budget_floor(),
        "rankFallbackTopK": rank_fallback_top_k(8),
        "marginalJaccard": marginal_jaccard_threshold(0.92),
        "matrixSpanReadout": matrix_span_readout_enabled(),
        "matrixSpanK": matrix_span_k(8),
        "injectP1": os.environ.get("CHAT_COMPRESSOR_INJECT_P1", "0").strip().lower()
        not in {"", "0", "false", "no", "off"},
    }


def _configure_logging() -> None:
    root = logging.getLogger()
    if root.handlers:
        return
    handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(logging.Formatter("%(levelname)s %(name)s %(message)s"))
    root.addHandler(handler)
    root.setLevel(logging.INFO)


def _err(req_id: Any, code: str, message: str) -> dict[str, Any]:
    out: dict[str, Any] = {
        "ok": False,
        "error": {"code": code, "message": message},
    }
    if req_id is not None:
        out["id"] = req_id
    return out


def _ok(req_id: Any, result: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {"ok": True, "result": result}
    if req_id is not None:
        out["id"] = req_id
    return out


def _sanitize_agent_id(agent_id: str) -> str | None:
    aid = (agent_id or "").strip()
    if not aid or ".." in aid or "/" in aid or "\\" in aid:
        return None
    if not _SAFE_AGENT_RE.match(aid):
        return None
    return aid


def _get_handle(agent_id: str) -> PersistentAgentHandle:
    if agent_id in _handles:
        _handles.move_to_end(agent_id)
        return _handles[agent_id]
    while len(_handles) >= _HANDLE_CAP:
        old_id, old = _handles.popitem(last=False)
        try:
            old.flush_graph()
        except Exception:  # noqa: BLE001 — eviction must not kill process
            log.exception("flush on evict failed agent_id=%s", old_id)
    root = resolve_state_root()
    root.mkdir(parents=True, exist_ok=True)
    store = StateStore(root)
    k_max = resolve_k_max()
    handle = PersistentAgentHandle(
        agent_id=agent_id,
        store=store,
        producer=make_producer(k_max=k_max),
        k_max=k_max,
    )
    _handles[agent_id] = handle
    return handle


def cmd_health(_params: dict[str, Any]) -> dict[str, Any]:
    return {
        "python": f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}",
        "engine": "chat_compressor",
        "handles": len(_handles),
    }


def cmd_step(agent_id: str, params: dict[str, Any]) -> dict[str, Any]:
    role = str(params.get("role") or "user").strip() or "user"
    text = params.get("text")
    if not isinstance(text, str):
        raise ValueError("params.text must be a string")
    if len(text.encode("utf-8")) > _MAX_TEXT_BYTES:
        raise RuntimeError("too_large")
    flush_graph = params.get("flush_graph")
    flush_kw: bool | None
    if flush_graph is None:
        flush_kw = None
    else:
        flush_kw = bool(flush_graph)

    handle = _get_handle(agent_id)
    t0 = time.perf_counter()
    out = handle.step(text, role=role, flush_graph=flush_kw)
    duration_ms = (time.perf_counter() - t0) * 1000.0
    node = handle.latest()
    k = int(node.C.shape[0]) if node is not None and getattr(node, "C", None) is not None else 0
    graph_nodes = 0
    try:
        graph_nodes = len(handle.graph.active_nodes())
    except Exception:  # noqa: BLE001
        graph_nodes = 0
    log.info(
        "step role=%s text_len=%d t=%d k=%d duration_ms=%.1f",
        role,
        len(text),
        int(out.t),
        k,
        duration_ms,
    )
    return {
        "duration_ms": round(duration_ms, 3),
        "t": int(out.t),
        "k": k,
        "k_max": int(handle.k_max),
        "graph_nodes": graph_nodes,
        "graph_flushed": bool(out.graph_flushed),
        "state_id": out.state_id,
    }


def cmd_sample(agent_id: str, params: dict[str, Any]) -> dict[str, Any]:
    query = str(params.get("query") or "")
    budget = params.get("budget")
    span_k = int(params.get("span_k") or 8)
    channel = str(params.get("channel") or "cursor-sdk")

    prev_budget = os.environ.get("CHAT_COMPRESSOR_FORWARD_BUDGET")
    if budget is not None:
        os.environ["CHAT_COMPRESSOR_FORWARD_BUDGET"] = str(int(budget))
    try:
        handle = _get_handle(agent_id)
        t0 = time.perf_counter()
        sampled = handle.sample_for(channel, query=query or None)
        text = sampled.text or ""
        duration_ms = (time.perf_counter() - t0) * 1000.0
        node = handle.latest()
        k = int(node.C.shape[0]) if node is not None and getattr(node, "C", None) is not None else 0
        packed = int(getattr(sampled, "packed_tokens", 0) or 0)
        if packed < 1 and text.strip():
            packed = max(1, len(text) // 4)
        hot_set_chars = 0
        if text.startswith("HOT_SET:") or "HOT_SET:" in text[:200]:
            hot_set_chars = min(len(text), int(os.environ.get("CHAT_COMPRESSOR_HOTSET_MAX_CHARS") or 800))
        else:
            hot_set_chars = min(len(text), 800)
        # Count-only telemetry fields (Plan 07). No prompt text in these keys.
        try:
            active = list(handle.graph.active_nodes())
            graph_active_nodes = len(active)
            graph_pruned_nodes = max(0, len(handle.graph.nodes) - graph_active_nodes)
        except Exception:
            graph_active_nodes = 0
            graph_pruned_nodes = 0
        hot_set_tokens = max(0, hot_set_chars // 4) if hot_set_chars else 0
        log.info(
            "sample query_len=%d packed_tokens=%d duration_ms=%.1f",
            len(query),
            packed,
            duration_ms,
        )
        return {
            "text": text,
            "packed_tokens": packed,
            "budget": int(budget) if budget is not None else int(os.environ.get("CHAT_COMPRESSOR_FORWARD_BUDGET") or 2048),
            "method": str(getattr(sampled, "method", "query-pack") or "query-pack"),
            "hot_set_chars": hot_set_chars,
            "hot_set_tokens": hot_set_tokens,
            "k": k,
            "k_max": int(handle.k_max),
            "matrix_rows_k": k,
            "matrix_max_slots": int(handle.k_max),
            "graph_active_nodes": graph_active_nodes,
            "graph_pruned_nodes": graph_pruned_nodes,
            "duration_ms": round(duration_ms, 3),
            "rpc_latency_ms": round(duration_ms, 3),
            "t": int(getattr(handle, "turn_index", 0) or 0),
        }
    finally:
        if budget is not None:
            if prev_budget is None:
                os.environ.pop("CHAT_COMPRESSOR_FORWARD_BUDGET", None)
            else:
                os.environ["CHAT_COMPRESSOR_FORWARD_BUDGET"] = prev_budget


def cmd_flush(agent_id: str, params: dict[str, Any]) -> dict[str, Any]:
    reason = str(params.get("reason") or "manual")
    handle = _get_handle(agent_id)
    path = handle.flush_graph()
    log.info("flush reason=%s path=%s", reason, path)
    return {"graph_path": path, "reason": reason}


def cmd_expand_spans(agent_id: str, params: dict[str, Any]) -> dict[str, Any]:
    query = str(params.get("query") or "")
    k = int(params.get("k") or 8)
    handle = _get_handle(agent_id)
    spans = handle.expand_spans(query, k=max(1, k))
    return {"spans": spans}


_DISPATCH = {
    "health": lambda aid, p: cmd_health(p),
    "step": lambda aid, p: cmd_step(aid, p),  # type: ignore[misc]
    "sample": lambda aid, p: cmd_sample(aid, p),  # type: ignore[misc]
    "flush": lambda aid, p: cmd_flush(aid, p),  # type: ignore[misc]
    "expand_spans": lambda aid, p: cmd_expand_spans(aid, p),  # type: ignore[misc]
}


def handle_request(obj: dict[str, Any]) -> dict[str, Any]:
    req_id = obj.get("id")
    cmd = obj.get("cmd")
    if not isinstance(cmd, str) or not cmd:
        return _err(req_id, "bad_request", "cmd required")
    if cmd not in _DISPATCH:
        return _err(req_id, "unknown_cmd", f"unknown cmd: {cmd}")

    params = obj.get("params")
    if params is None:
        params = {}
    if not isinstance(params, dict):
        return _err(req_id, "bad_request", "params must be an object")

    agent_id_raw = obj.get("agent_id")
    if cmd == "health":
        try:
            return _ok(req_id, cmd_health(params))
        except Exception as exc:  # noqa: BLE001
            log.exception("health failed")
            return _err(req_id, "health_failed", str(exc))

    if not isinstance(agent_id_raw, str) or not agent_id_raw.strip():
        return _err(req_id, "bad_request", "agent_id required")
    agent_id = _sanitize_agent_id(agent_id_raw)
    if agent_id is None:
        return _err(req_id, "bad_agent_id", "agent_id rejected")

    try:
        if cmd == "step":
            return _ok(req_id, cmd_step(agent_id, params))
        if cmd == "sample":
            return _ok(req_id, cmd_sample(agent_id, params))
        if cmd == "flush":
            return _ok(req_id, cmd_flush(agent_id, params))
        if cmd == "expand_spans":
            return _ok(req_id, cmd_expand_spans(agent_id, params))
    except RuntimeError as exc:
        if str(exc) == "too_large":
            return _err(req_id, "too_large", "step text exceeds 512KiB")
        return _err(req_id, f"{cmd}_failed", str(exc))
    except ValueError as exc:
        return _err(req_id, "bad_request", str(exc))
    except Exception as exc:  # noqa: BLE001
        log.exception("%s failed", cmd)
        return _err(req_id, f"{cmd}_failed", str(exc) or traceback.format_exc()[-200:])

    return _err(req_id, "unknown_cmd", f"unknown cmd: {cmd}")


def process_line(line: str) -> dict[str, Any]:
    raw = line.strip()
    if not raw:
        return _err(None, "bad_json", "empty line")
    try:
        obj = json.loads(raw)
    except json.JSONDecodeError as exc:
        return _err(None, "bad_json", str(exc))
    if not isinstance(obj, dict):
        return _err(None, "bad_json", "request must be a JSON object")
    return handle_request(obj)


def main() -> int:
    _configure_logging()
    # Explicitly do NOT load ~/.cursor/chat-compressor.env
    for line in sys.stdin:
        try:
            resp = process_line(line)
        except Exception as exc:  # noqa: BLE001 — never crash the process
            log.exception("unhandled")
            resp = _err(None, "internal", str(exc))
        sys.stdout.write(json.dumps(resp, ensure_ascii=False) + "\n")
        sys.stdout.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
