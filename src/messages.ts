/** Host message shapes used by ingest / assemble / compact. */

export type ChatMessage = {
  id?: string;
  role: string;
  content?: unknown;
  text?: string;
  isHeartbeat?: boolean;
  name?: string;
  toolName?: string;
  toolCallId?: string;
  tool_call_id?: string;
  toolCalls?: Array<{ id?: string; name?: string }>;
  tool_calls?: Array<{ id?: string; name?: string }>;
  [key: string]: unknown;
};

export function messageText(msg: ChatMessage): string {
  if (typeof msg.text === "string") return msg.text;
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && "text" in part) {
          return String((part as { text?: unknown }).text ?? "");
        }
        return JSON.stringify(part);
      })
      .join("\n");
  }
  if (msg.content === undefined || msg.content === null) return "";
  return typeof msg.content === "object" ? JSON.stringify(msg.content) : String(msg.content);
}

export function isHeartbeat(msg: ChatMessage): boolean {
  return msg.isHeartbeat === true || msg.role === "heartbeat";
}

export function isCompactionNotice(msg: ChatMessage): boolean {
  const role = String(msg.role || "").toLowerCase();
  if (role === "compaction" || role === "compact_notice") return true;
  const text = messageText(msg).toLowerCase();
  return text.startsWith("[compaction]") || text.startsWith("compaction notice");
}

export function isToolResult(msg: ChatMessage): boolean {
  const role = String(msg.role || "").toLowerCase();
  return role === "tool" || role === "toolresult" || role === "tool_result";
}

export function isToolCall(msg: ChatMessage): boolean {
  const role = String(msg.role || "").toLowerCase();
  if (role === "toolcall" || role === "tool_call" || role === "function_call") return true;
  const calls = msg.toolCalls ?? msg.tool_calls;
  return Array.isArray(calls) && calls.length > 0;
}

export function toolCallIds(msg: ChatMessage): string[] {
  const calls = msg.toolCalls ?? msg.tool_calls;
  if (Array.isArray(calls)) {
    return calls.map((c) => c.id).filter((id): id is string => typeof id === "string" && id.length > 0);
  }
  if (typeof msg.toolCallId === "string") return [msg.toolCallId];
  if (typeof msg.tool_call_id === "string") return [msg.tool_call_id];
  return [];
}

export function resultToolCallId(msg: ChatMessage): string | undefined {
  if (typeof msg.toolCallId === "string") return msg.toolCallId;
  if (typeof msg.tool_call_id === "string") return msg.tool_call_id;
  return undefined;
}

/** Rough τ = (len+3)//4 token estimate. */
export function tauTokens(text: string): number {
  return Math.floor((text.length + 3) / 4);
}

export function estimateMessageTokens(msg: ChatMessage): number {
  return tauTokens(messageText(msg));
}
