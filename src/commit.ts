/**
 * commitTurn: atomic-idempotent advancement fence in meta.sqlite.
 */

import type { CommitResult, MetaStore } from "./meta-store.ts";
import type { ChatMessage } from "./messages.ts";

export type CommitTurnArgs = {
  advancementKey: string;
  messages?: ChatMessage[];
  sessionKey?: string;
  fromIndex?: number;
  toIndex?: number;
  t?: number;
};

export function commitTurn(
  meta: MetaStore,
  sessionId: string,
  args: CommitTurnArgs,
): CommitResult {
  if (!args.advancementKey || typeof args.advancementKey !== "string") {
    throw new Error("commitTurn requires advancementKey");
  }
  const messages = args.messages ?? [];
  const fromIndex = args.fromIndex ?? 0;
  const toIndex = args.toIndex ?? Math.max(0, messages.length - 1);
  return meta.commitTurn({
    advancementKey: args.advancementKey,
    sessionId,
    fromIndex,
    toIndex,
    t: args.t,
  });
}
