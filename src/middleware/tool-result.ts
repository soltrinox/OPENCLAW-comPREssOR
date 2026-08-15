/**
 * Agent tool-result middleware (Plan 10).
 * Reduce huge tool dumps before they re-enter the model; ingest gist into G_t.
 * Fail-open: on throw, pass original result (D10.1).
 */

import { toolGist } from "../ingest.ts";
import type { ChatMessage } from "../messages.ts";
import { messageText, isToolResult } from "../messages.ts";
import { logInfo, logWarn } from "../log.ts";

/** Default reduce threshold (chars). Plan A10-1/A10-2. */
export const TOOL_RESULT_GIST_THRESHOLD = 8192;

export type ToolResultMiddlewareCtx = {
  resultText: string;
  toolName?: string;
  exitCode?: number | string | null;
  /** Optional engine ingest of the gist Event/Fact. */
  ingestEvent?: (gist: string) => Promise<void> | void;
  /** When true, force a throw path for tests (fail-open). */
  forceThrow?: boolean;
};

export type ToolResultMiddlewareResult = {
  text: string;
  reduced: boolean;
  passThrough?: boolean;
  reason?: string;
};

/**
 * Pure reducer used by unit tests and host middleware adapter.
 * Scans full text for ERROR/path when reducing (bounded head + full error scan).
 */
export function reduceToolResultText(
  raw: string,
  opts?: {
    toolName?: string;
    threshold?: number;
    exitCode?: number | string | null;
  },
): ToolResultMiddlewareResult {
  const threshold = opts?.threshold ?? TOOL_RESULT_GIST_THRESHOLD;
  const name = opts?.toolName ?? "tool";
  if (raw.length <= threshold) {
    return { text: raw, reduced: false };
  }

  // Prefer ingest.toolGist shape but scan a larger window so late ERROR lines survive.
  const msg: ChatMessage = {
    role: "tool",
    toolName: name,
    text: raw,
  };
  let gist = toolGist(msg, Math.min(512, threshold));

  // Ensure first ERROR line and path survive even if beyond the 8k scan window in toolGist.
  const errorLine =
    raw
      .split(/\r?\n/)
      .find((line) => /error|fail|traceback|exception/i.test(line))
      ?.trim()
      .slice(0, 200) ?? "";
  const pathMatch = raw.match(
    /(?:\/[\w.-]{1,64})+\.\w{1,12}\b|\b[\w.-]{1,64}\.(?:ts|js|py|json|md|txt)\b/,
  );
  const path = pathMatch?.[0] ?? "";
  if (errorLine && !gist.includes(errorLine.slice(0, 40))) {
    gist = `${gist} ERROR_LINE=${errorLine}`;
  }
  if (path && !gist.includes(path)) {
    gist = `${gist} path=${path}`;
  }
  // Prefer explicit exitCode; rewrite exit=? from gist when known.
  if (opts?.exitCode != null && opts.exitCode !== "") {
    if (/\bexit=\?/.test(gist) || !/\bexit=-?\d+/.test(gist)) {
      gist = gist.replace(/\bexit=\?/, `exit=${opts.exitCode}`);
      if (!/\bexit=-?\d+/.test(gist)) {
        gist = `tool ${name} exit=${opts.exitCode} ${gist}`;
      }
    }
  }

  if (gist.length > threshold) {
    gist = gist.slice(0, threshold);
  }
  return { text: gist, reduced: true };
}

/**
 * Host middleware entry. Fail-open on throw → original text + passThrough flag.
 */
export async function reduceToolResult(
  ctx: ToolResultMiddlewareCtx,
): Promise<ToolResultMiddlewareResult> {
  try {
    if (ctx.forceThrow) {
      throw new Error("middleware_forced_throw");
    }
    const out = reduceToolResultText(ctx.resultText, {
      toolName: ctx.toolName,
      exitCode: ctx.exitCode,
    });
    if (out.reduced && ctx.ingestEvent) {
      await ctx.ingestEvent(out.text);
    }
    return out;
  } catch (err) {
    logWarn("middleware_pass_through", {
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      text: ctx.resultText,
      reduced: false,
      passThrough: true,
      reason: "middleware_pass_through",
    };
  }
}

/** Adapter for OpenClaw agentToolResultMiddleware contract. */
export async function openclawToolResultMiddleware(args: {
  result?: unknown;
  toolName?: string;
  name?: string;
  exitCode?: number | string | null;
  ingestEvent?: (gist: string) => Promise<void> | void;
}): Promise<{ resultText: string; reduced: boolean; passThrough?: boolean }> {
  const raw =
    typeof args.result === "string"
      ? args.result
      : args.result == null
        ? ""
        : JSON.stringify(args.result);
  const out = await reduceToolResult({
    resultText: raw,
    toolName: args.toolName ?? args.name ?? "tool",
    exitCode: args.exitCode,
    ingestEvent: args.ingestEvent,
  });
  if (out.passThrough) {
    logInfo("middleware_pass_through", { tool: args.toolName ?? args.name });
  }
  return {
    resultText: out.text,
    reduced: out.reduced,
    passThrough: out.passThrough,
  };
}

/** Replace tool-result message content when middleware reduces. */
export function applyReducedToolMessage(
  msg: ChatMessage,
  reducedText: string,
): ChatMessage {
  if (!isToolResult(msg) && String(msg.role).toLowerCase() !== "tool") {
    return msg;
  }
  return { ...msg, text: reducedText, content: reducedText };
}

export function shouldReduceToolMessage(
  msg: ChatMessage,
  threshold = TOOL_RESULT_GIST_THRESHOLD,
): boolean {
  if (!isToolResult(msg) && String(msg.role).toLowerCase() !== "tool") return false;
  return messageText(msg).length > threshold;
}
