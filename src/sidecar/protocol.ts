/** OpenClaw sidecar JSONL protocol types and encode/decode helpers. */

export type SidecarCmd = "health" | "step" | "sample" | "flush" | "expand_spans";

export type SidecarRequest = {
  id: string;
  cmd: SidecarCmd;
  agent_id?: string;
  params?: Record<string, unknown>;
};

export type SidecarOk = {
  id?: string;
  ok: true;
  result: Record<string, unknown>;
};

export type SidecarErr = {
  id?: string;
  ok: false;
  error: { code: string; message: string };
};

export type SidecarResponse = SidecarOk | SidecarErr;

export class SidecarProtocolError extends Error {
  readonly code = "protocol_error";
  constructor(message: string) {
    super(message);
    this.name = "SidecarProtocolError";
  }
}

export function encodeRequest(req: SidecarRequest): string {
  if (!req.id || !req.cmd) {
    throw new SidecarProtocolError("encodeRequest requires id and cmd");
  }
  const payload: Record<string, unknown> = {
    id: req.id,
    cmd: req.cmd,
    params: req.params ?? {},
  };
  if (req.agent_id !== undefined) payload.agent_id = req.agent_id;
  return JSON.stringify(payload);
}

export function decodeResponse(line: string): SidecarResponse {
  const raw = line.trim();
  if (!raw) throw new SidecarProtocolError("empty response line");
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch (err) {
    throw new SidecarProtocolError(
      `invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    throw new SidecarProtocolError("response must be a JSON object");
  }
  const rec = obj as Record<string, unknown>;
  if (typeof rec.ok !== "boolean") {
    throw new SidecarProtocolError("response missing boolean ok");
  }
  if (rec.ok === true) {
    const result =
      rec.result !== undefined && typeof rec.result === "object" && rec.result !== null
        ? (rec.result as Record<string, unknown>)
        : {};
    return {
      ok: true,
      id: typeof rec.id === "string" ? rec.id : undefined,
      result,
    };
  }
  const errObj = rec.error;
  let code = "unknown";
  let message = "sidecar error";
  if (errObj && typeof errObj === "object" && !Array.isArray(errObj)) {
    const e = errObj as Record<string, unknown>;
    if (typeof e.code === "string") code = e.code;
    if (typeof e.message === "string") message = e.message;
  }
  return {
    ok: false,
    id: typeof rec.id === "string" ? rec.id : undefined,
    error: { code, message },
  };
}

/** Lightweight invariants for smoke without vitest include path. */
export function assertProtocolInvariants(): void {
  const enc = encodeRequest({ id: "1", cmd: "health", params: {} });
  if (!enc.includes('"cmd":"health"')) throw new Error("encode health failed");
  const ok = decodeResponse('{"id":"1","ok":true,"result":{"python":"3.12.0"},"extra":1}');
  if (!ok.ok || ok.result.python !== "3.12.0") throw new Error("decode ok failed");
  const bad = decodeResponse('{"ok":false,"error":{"code":"bad_json","message":"x"}}');
  if (bad.ok || bad.error.code !== "bad_json") throw new Error("decode err failed");
  let threw = false;
  try {
    decodeResponse('{"result":{}}');
  } catch {
    threw = true;
  }
  if (!threw) throw new Error("missing ok should throw");
}
