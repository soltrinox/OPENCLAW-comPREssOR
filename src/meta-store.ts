/**
 * SQLite meta store for turn commits and ingest-once fences.
 * Uses node:sqlite (WAL). Separate from future telemetry.sqlite.
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type CommitRow = {
  advancementKey: string;
  status: "committed";
  sessionId: string;
  fromIndex: number;
  toIndex: number;
  t: number;
  createdMs: number;
};

export type CommitResult =
  | { status: "committed"; advancementKey: string }
  | { status: "duplicate"; advancementKey: string };

export class MetaStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    if (dbPath !== ":memory:") {
      this.db.exec("PRAGMA journal_mode = WAL;");
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS turn_commits (
        advancement_key TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        session_id TEXT NOT NULL,
        from_index INTEGER NOT NULL,
        to_index INTEGER NOT NULL,
        t INTEGER NOT NULL DEFAULT 0,
        created_ms INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ingested_messages (
        session_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        PRIMARY KEY (session_id, message_id)
      );
    `);
  }

  alreadyIngested(sessionId: string, messageId: string): boolean {
    const row = this.db
      .prepare(
        "SELECT 1 AS ok FROM ingested_messages WHERE session_id = ? AND message_id = ? LIMIT 1",
      )
      .get(sessionId, messageId) as { ok?: number } | undefined;
    return Boolean(row?.ok);
  }

  markIngested(sessionId: string, messageId: string): void {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO ingested_messages (session_id, message_id) VALUES (?, ?)",
      )
      .run(sessionId, messageId);
  }

  commitTurn(args: {
    advancementKey: string;
    sessionId: string;
    fromIndex: number;
    toIndex: number;
    t?: number;
  }): CommitResult {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db
        .prepare("SELECT advancement_key FROM turn_commits WHERE advancement_key = ? LIMIT 1")
        .get(args.advancementKey) as { advancement_key?: string } | undefined;
      if (existing?.advancement_key) {
        this.db.exec("COMMIT");
        return { status: "duplicate", advancementKey: args.advancementKey };
      }
      this.db
        .prepare(
          `INSERT INTO turn_commits
            (advancement_key, status, session_id, from_index, to_index, t, created_ms)
           VALUES (?, 'committed', ?, ?, ?, ?, ?)`,
        )
        .run(
          args.advancementKey,
          args.sessionId,
          args.fromIndex,
          args.toIndex,
          args.t ?? 0,
          Date.now(),
        );
      this.db.exec("COMMIT");
      return { status: "committed", advancementKey: args.advancementKey };
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* ignore */
      }
      throw err;
    }
  }

  hasAnyCommits(sessionId: string): boolean {
    const row = this.db
      .prepare("SELECT 1 AS ok FROM turn_commits WHERE session_id = ? LIMIT 1")
      .get(sessionId) as { ok?: number } | undefined;
    return Boolean(row?.ok);
  }

  close(): void {
    this.db.close();
  }
}
