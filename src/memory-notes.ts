/**
 * Optional memory-note writer (Plan 10). Writer only — never registerMemoryCapability.
 * Default promoteMemoryNotes=false.
 */

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { logInfo } from "./log.ts";

const MAX_APPEND_CHARS = 2000;

export type MemoryNotesArgs = {
  workspaceRoot?: string;
  session: string;
  entryText: string;
  identifiersOnly?: boolean;
};

/** Extract short decision + identifier lines only (no tool dumps). */
export function memoryNoteBlock(entryText: string, session: string): string {
  const lines = entryText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) =>
      /OpenItem|Decision|identifier|UUID|Fact path|path=/i.test(l),
    )
    .slice(0, 40);
  let body = lines.join("\n");
  if (body.length > MAX_APPEND_CHARS) body = body.slice(0, MAX_APPEND_CHARS);
  const day = new Date().toISOString().slice(0, 10);
  return `\n\n\`\`\`compressor-notes session=${session} date=${day}\n${body || "(empty checkpoint)"}\n\`\`\`\n`;
}

/**
 * Append fenced block to memory/YYYY-MM-DD.md under workspaceRoot.
 * No-op if workspaceRoot missing. Never registers a memory plugin slot.
 */
export function appendMemoryNotes(args: MemoryNotesArgs): {
  written: boolean;
  path?: string;
} {
  if (!args.workspaceRoot) {
    return { written: false };
  }
  const day = new Date().toISOString().slice(0, 10);
  const dir = join(args.workspaceRoot, "memory");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${day}.md`);
  const block = memoryNoteBlock(args.entryText, args.session);
  appendFileSync(path, block, "utf8");
  logInfo("memory_notes_appended", {
    session: args.session,
    path,
    chars: block.length,
  });
  return { written: true, path };
}

export function memoryFileExists(workspaceRoot: string, day?: string): boolean {
  const d = day ?? new Date().toISOString().slice(0, 10);
  return existsSync(join(workspaceRoot, "memory", `${d}.md`));
}
