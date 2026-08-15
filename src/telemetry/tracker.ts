/**
 * Async count-only tracker. Enqueue never blocks assemble; WAL writes on a promise chain.
 * Failures are swallowed. Queue cap drops oldest and increments telemetry_dropped.
 */

import { logWarn } from "../log.ts";
import { TelemetryStore, telemetryDbPath } from "./store.ts";
import type { SystemEvent, SystemEventCode, TurnMetrics } from "./types.ts";

export const QUEUE_CAP = 1000;

export type TrackerOptions = {
  /** Existing store, or path to open. */
  store?: TelemetryStore;
  dbPath?: string;
  /** Inject for tests: throw on insert. */
  insertHook?: (m: TurnMetrics) => void | Promise<void>;
  queueCap?: number;
};

export class Tracker {
  private store: TelemetryStore | null = null;
  private readonly queue: TurnMetrics[] = [];
  private chain: Promise<void> = Promise.resolve();
  private readonly queueCap: number;
  private readonly insertHook?: TrackerOptions["insertHook"];
  private readonly preferredPath: string | null;
  private closed = false;
  /** Process counter exposed to doctor. */
  telemetryDropped = 0;
  private openFailed = false;

  constructor(opts: TrackerOptions = {}) {
    this.queueCap = opts.queueCap ?? QUEUE_CAP;
    this.insertHook = opts.insertHook;
    this.preferredPath = opts.dbPath ?? null;
    if (opts.store) {
      this.store = opts.store;
    }
  }

  static forSessionDir(sessionStateDir: string, opts: Omit<TrackerOptions, "dbPath"> = {}): Tracker {
    return new Tracker({ ...opts, dbPath: telemetryDbPath(sessionStateDir) });
  }

  get dropped(): number {
    return this.telemetryDropped;
  }

  /** Fire-and-forget. Must never throw into assemble. */
  trackTurn(metrics: TurnMetrics): void {
    try {
      if (this.closed) return;
      if (this.queue.length >= this.queueCap) {
        this.queue.shift();
        this.telemetryDropped += 1;
        this.trackEventSafe("telemetry_dropped", metrics.sessionId);
      }
      this.queue.push(metrics);
      this.scheduleDrain();
    } catch (err) {
      logWarn("telemetry trackTurn swallowed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  trackEvent(code: SystemEventCode, sessionId?: string | null): void {
    this.trackEventSafe(code, sessionId);
  }

  private trackEventSafe(code: SystemEventCode, sessionId?: string | null): void {
    try {
      const ev: SystemEvent = { code, sessionId: sessionId ?? null, timestamp: Date.now() };
      this.chain = this.chain
        .then(async () => {
          const store = this.ensureStore();
          if (!store) return;
          store.insertEvent(ev);
        })
        .catch((err) => {
          logWarn("telemetry event write swallowed", {
            code,
            error: err instanceof Error ? err.message : String(err),
          });
        });
    } catch (err) {
      logWarn("telemetry trackEvent swallowed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private scheduleDrain(): void {
    this.chain = this.chain
      .then(async () => {
        while (this.queue.length > 0) {
          const row = this.queue.shift()!;
          if (this.insertHook) {
            await this.insertHook(row);
          } else {
            const store = this.ensureStore();
            if (!store) continue;
            store.insertTurn(row);
          }
        }
      })
      .catch((err) => {
        logWarn("telemetry write swallowed", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }

  private ensureStore(): TelemetryStore | null {
    if (this.store) return this.store;
    if (this.openFailed) return null;
    if (!this.preferredPath) return null;
    try {
      this.store = new TelemetryStore(this.preferredPath);
      return this.store;
    } catch (err) {
      this.openFailed = true;
      logWarn("telemetry store open failed", {
        path: this.preferredPath,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /** Test helper: wait for writer chain to settle. */
  async flush(): Promise<void> {
    await this.chain;
    // Drain any items enqueued during the await.
    if (this.queue.length > 0) {
      this.scheduleDrain();
      await this.chain;
    }
  }

  getStore(): TelemetryStore | null {
    return this.store ?? this.ensureStore();
  }

  close(): void {
    this.closed = true;
    try {
      this.store?.close();
    } catch {
      /* swallow */
    }
    this.store = null;
  }
}
