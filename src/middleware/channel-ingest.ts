/**
 * Channel-aware ingest helpers (Plan 10).
 * Group chats: skip bystander messages in C_t unless mentioned.
 */

import type { ChatMessage } from "../messages.ts";
import { messageText } from "../messages.ts";

export type ChannelIngestMeta = {
  isGroup?: boolean;
  channelType?: string;
  senderId?: string;
  selfId?: string;
  mentioned?: boolean;
  mentionsSelf?: boolean;
};

function metaFromMessage(msg: ChatMessage): ChannelIngestMeta {
  const m = msg as ChatMessage & ChannelIngestMeta & {
    channel?: { type?: string; isGroup?: boolean };
    sender?: { id?: string };
    mention?: boolean;
  };
  const channelType =
    m.channelType ??
    m.channel?.type ??
    (typeof msg.channel === "string" ? msg.channel : undefined);
  const isGroup =
    m.isGroup === true ||
    m.channel?.isGroup === true ||
    channelType === "group" ||
    channelType === "channel";
  return {
    isGroup,
    channelType,
    senderId: m.senderId ?? m.sender?.id,
    selfId: m.selfId,
    mentioned: m.mentioned === true || m.mentionsSelf === true || m.mention === true,
  };
}

/**
 * True when this message should be skipped for group bystander noise.
 * DM / non-group: never skip for this reason.
 * Group: skip other senders unless mentioned.
 */
export function shouldSkipGroupBystander(
  msg: ChatMessage,
  opts?: { selfId?: string; botName?: string },
): boolean {
  const meta = metaFromMessage(msg);
  if (!meta.isGroup) return false;
  if (meta.mentioned || meta.mentionsSelf) return false;

  const selfId = opts?.selfId ?? meta.selfId;
  const sender = meta.senderId;
  if (selfId && sender && sender === selfId) return false;

  // Mention by name in text
  const bot = opts?.botName;
  if (bot) {
    const text = messageText(msg);
    if (new RegExp(`@${bot}\\b`, "i").test(text)) return false;
  }

  // Other sender in group without mention → skip
  if (sender && selfId && sender !== selfId) return true;
  // Unknown sender in group without mention → skip (conservative)
  if (meta.isGroup && !meta.mentioned) return true;
  return false;
}
