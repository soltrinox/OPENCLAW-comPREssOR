#!/usr/bin/env python3
"""Minimal fake claw_cli for TS SidecarClient tests (no numpy)."""

from __future__ import annotations

import json
import sys
import time


def main() -> int:
    for line in sys.stdin:
        raw = line.strip()
        if not raw:
            continue
        try:
            obj = json.loads(raw)
        except json.JSONDecodeError:
            sys.stdout.write(json.dumps({"ok": False, "error": {"code": "bad_json", "message": "parse"}}) + "\n")
            sys.stdout.flush()
            continue
        req_id = obj.get("id")
        cmd = obj.get("cmd")
        if cmd == "sleep":
            time.sleep(float((obj.get("params") or {}).get("seconds") or 5))
        if cmd == "health":
            resp = {"id": req_id, "ok": True, "result": {"python": "3.12.0", "engine": "fake", "handles": 0}}
        elif cmd == "step":
            resp = {"id": req_id, "ok": True, "result": {"t": 1, "k": 1, "k_max": 16, "duration_ms": 1}}
        elif cmd == "sample":
            resp = {
                "id": req_id,
                "ok": True,
                "result": {"text": "HOT_SET: fake", "packed_tokens": 2, "budget": 2048, "method": "fake", "hot_set_chars": 10, "k": 1, "k_max": 16, "duration_ms": 1},
            }
        elif cmd == "die":
            sys.exit(0)
        else:
            resp = {"id": req_id, "ok": False, "error": {"code": "unknown_cmd", "message": str(cmd)}}
        sys.stdout.write(json.dumps(resp) + "\n")
        sys.stdout.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
