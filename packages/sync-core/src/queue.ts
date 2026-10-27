import type { LocalRecord, ServerResult, SyncRunResult, SyncStorage, SyncTransport, FormValues } from './types';

export const BACKOFF_BASE_MS = 5_000;
export const BACKOFF_CAP_MS = 15 * 60_000;
export const DEFAULT_BATCH_SIZE = 50;

/**
 * Exponential back-off with jitter: ~5 s, 10 s, 20 s ... capped at 15 min.
 * `random` is injectable so tests are deterministic (0..1).
 */
export function backoffMs(attempts: number, random: () => number = Math.random): number {
  const exp = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1));
  return Math.round(exp * (0.8 + 0.4 * random()));
}

/** The JSON the server expects for one record (docs/api_contract.md). */
export function toPayload(r: LocalRecord): Record<string, unknown> {
  return { ...r.values, record_id: r.record_id, captured_at: r.captured_at };
}

/**
 * Applies the server's answer for one record to the local copy.
 *  accepted / already_received -> synced, accepted_with_flags -> synced_with_flags (warning kept),
 *  rejected -> stays on the device as `rejected` with the server's messages, never deleted.
 */
export function applyResult(r: LocalRecord, res: ServerResult, now: number): LocalRecord {
  const base = { ...r, attempts: 0, next_attempt_at: 0, last_error: null, updated_at: now };
  switch (res.status) {
    case 'accepted':
      return { ...base, status: 'synced', errors: [] };
    case 'accepted_with_flags':
      return { ...base, status: 'synced_with_flags', errors: [], flags: res.flags };
    case 'already_received':
      // It was stored by an earlier upload whose answer we never saw; keep any warning we already know of.
      return { ...base, status: r.flags.length > 0 ? 'synced_with_flags' : 'synced', errors: [] };
    case 'rejected':
      return { ...base, status: 'rejected', errors: res.errors, flags: res.flags };
  }
}

/** One upload pass: send everything that is due, apply per-record answers, schedule retries for the rest. */
export async function runSync(
  storage: SyncStorage,
  transport: SyncTransport,
  opts: { now?: () => number; batchSize?: number; random?: () => number; force?: boolean } = {},
): Promise<SyncRunResult> {
  const now = opts.now ?? Date.now;
  // force = ignore the back-off timers (the worker tapped Sync now, or the connection just came back)
  const due = await storage.listDue(opts.force ? Number.MAX_SAFE_INTEGER : now(), opts.batchSize ?? DEFAULT_BATCH_SIZE);
  const out: SyncRunResult = { attempted: due.length, synced: 0, rejected: 0, failed: 0 };
  if (due.length === 0) return out;

  let results: ServerResult[];
  try {
    results = await transport.send(due.map(toPayload));
  } catch (e) {
    // Nothing is lost: the records stay pending_sync and are retried later. The upload is idempotent,
    // so it does not matter whether the server saw the request or not.
    for (const r of due) await scheduleRetry(storage, r, now(), e, opts.random);
    out.failed = due.length;
    return out;
  }

  const byId = new Map(results.map((x) => [x.record_id, x]));
  for (const r of due) {
    const res = byId.get(r.record_id);
    if (!res) {
      await scheduleRetry(storage, r, now(), new Error('No answer for this record'), opts.random);
      out.failed++;
      continue;
    }
    // Re-read: the user may have edited or resubmitted the record while the upload was in flight.
    const current = await storage.get(r.record_id);
    if (current && current.updated_at !== r.updated_at) continue;
    const next = applyResult(r, res, now());
    await storage.save(next);
    if (next.status === 'rejected') out.rejected++;
    else out.synced++;
  }
  return out;
}

async function scheduleRetry(storage: SyncStorage, r: LocalRecord, now: number, error: unknown, random?: () => number) {
  const current = await storage.get(r.record_id);
  if (current && current.updated_at !== r.updated_at) return;
  const attempts = r.attempts + 1;
  await storage.save({
    ...r,
    attempts,
    next_attempt_at: now + backoffMs(attempts, random),
    last_error: error instanceof Error ? error.message : String(error),
    updated_at: r.updated_at, // a failed attempt is not an edit
  });
}

/** Saving a form: the record joins the queue as pending_sync. Drafts never sync. */
export function toPending(
  recordId: string,
  values: FormValues,
  flags: LocalRecord['flags'],
  now: number,
  capturedAt: string = new Date(now).toISOString(),
): LocalRecord {
  return {
    record_id: recordId, status: 'pending_sync', values, captured_at: capturedAt, errors: [], flags,
    attempts: 0, next_attempt_at: 0, last_error: null, updated_at: now,
  };
}

/**
 * Fix and resubmit: the user changes only what is wrong. The record keeps its record_id and every other value,
 * returns to pending_sync with a fresh back-off, and its old server messages are cleared.
 */
export function resubmit(r: LocalRecord, changes: Partial<FormValues>, flags: LocalRecord['flags'], now: number): LocalRecord {
  if (r.status !== 'rejected') throw new Error(`Only a rejected record can be resubmitted (status is ${r.status})`);
  return {
    ...r, status: 'pending_sync', values: { ...r.values, ...changes }, errors: [], flags,
    attempts: 0, next_attempt_at: 0, last_error: null, updated_at: now,
  };
}

/**
 * Runs sync passes one at a time (a second trigger while one is running just asks for another pass afterwards)
 * and schedules the next retry when records are waiting for their back-off.
 */
export class SyncEngine {
  private running = false;
  private again = false;
  private forceAgain = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  listeners = new Set<(r: SyncRunResult) => void>();

  constructor(
    private storage: SyncStorage,
    private transport: SyncTransport,
    private opts: {
      now?: () => number;
      random?: () => number;
      setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
      clearTimer?: (t: ReturnType<typeof setTimeout>) => void;
    } = {},
  ) {}

  /** Call on app start, when a connection returns, when the app comes to the foreground, and after Save. */
  async trigger(opts: { force?: boolean } = {}): Promise<void> {
    if (this.running) {
      this.again = true;
      if (opts.force) this.forceAgain = true;
      return;
    }
    this.running = true;
    let force = opts.force === true;
    try {
      do {
        this.again = false;
        force = force || this.forceAgain;
        this.forceAgain = false;
        const result = await runSync(this.storage, this.transport, { now: this.opts.now, random: this.opts.random, force });
        force = false;
        this.listeners.forEach((l) => l(result));
      } while (this.again);
    } finally {
      this.running = false;
    }
    await this.scheduleNext();
  }

  get isRunning() {
    return this.running;
  }

  stop() {
    if (this.timer) (this.opts.clearTimer ?? clearTimeout)(this.timer);
    this.timer = null;
  }

  private async scheduleNext() {
    this.stop();
    const next = await this.storage.nextAttemptAt();
    if (next === null) return;
    const delay = Math.max(1_000, next - (this.opts.now ?? Date.now)());
    this.timer = (this.opts.setTimer ?? setTimeout)(() => void this.trigger(), delay) as ReturnType<typeof setTimeout>;
  }
}
