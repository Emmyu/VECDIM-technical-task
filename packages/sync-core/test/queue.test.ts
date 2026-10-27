import { beforeEach, describe, expect, it } from 'vitest';
import { processBatch, type AuthUser } from '../../../backend/src/batch';
import { MemoryStore } from '../../../backend/test/memoryStore';
import {
  BACKOFF_CAP_MS, SyncEngine, backoffMs, resubmit, runSync, toPayload, toPending,
  type LocalRecord, type ServerResult, type SyncStorage, type SyncTransport,
} from '../src';

class MemoryStorage implements SyncStorage {
  rows = new Map<string, LocalRecord>();
  async listDue(now: number, limit: number) {
    return [...this.rows.values()]
      .filter((r) => r.status === 'pending_sync' && r.next_attempt_at <= now)
      .sort((a, b) => a.captured_at.localeCompare(b.captured_at))
      .slice(0, limit);
  }
  async get(id: string) { return this.rows.get(id) ?? null; }
  async save(r: LocalRecord) { this.rows.set(r.record_id, structuredClone(r)); }
  async nextAttemptAt() {
    const t = [...this.rows.values()].filter((r) => r.status === 'pending_sync').map((r) => r.next_attempt_at);
    return t.length ? Math.min(...t) : null;
  }
}

const values = (over: Record<string, unknown> = {}) => ({
  state: 'Osun', lga: 'Osogbo', ward: 'Osogbo Ward 2', latitude: 7.77, longitude: 4.56, gps_accuracy_m: 6.5,
  collection_date: '2026-10-07', species: 'An. gambiae s.s.', insecticide: 'Permethrin', n_exposed: 100, n_dead: 54,
  larval_density: 6, urban: 1, irs_covered: 0, itn_use_pct: 61.5, ...over,
});

let t = Date.UTC(2026, 9, 8, 10, 0, 0);
const clock = () => t;
let seq = 0;
const pending = (over: Record<string, unknown> = {}, id?: string) => {
  const i = ++seq;
  return toPending(id ?? `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, values({ n_dead: 40 + i, ...over }), [], t,
    new Date(t + i).toISOString());
};

/** A server backed by the real batch logic; the connection can be switched off. */
function fakeServer() {
  const store = new MemoryStore();
  const user: AuthUser = { user_id: 'u_field_03', role: 'field', state: 'Osun' };
  const state = { online: true, dropAfterServerWrites: false, calls: 0 };
  const transport: SyncTransport = {
    async send(records) {
      state.calls++;
      if (!state.online) throw new Error('Network request failed');
      const { results } = await processBatch(store, user, records, { now: new Date(t) });
      if (state.dropAfterServerWrites) throw new Error('Connection lost before the response arrived');
      return results as ServerResult[];
    },
  };
  return { store, state, transport };
}

let storage: MemoryStorage;
beforeEach(() => {
  storage = new MemoryStorage();
  t = Date.UTC(2026, 9, 8, 10, 0, 0);
});

describe('back-off', () => {
  it('doubles from 5 s up to the 15 min cap, with jitter within +-20%', () => {
    expect(backoffMs(1, () => 0.5)).toBe(5_000);
    expect(backoffMs(2, () => 0.5)).toBe(10_000);
    expect(backoffMs(3, () => 0.5)).toBe(20_000);
    expect(backoffMs(30, () => 0.5)).toBe(BACKOFF_CAP_MS);
    expect(backoffMs(1, () => 0)).toBe(4_000);
    expect(backoffMs(1, () => 1)).toBe(6_000);
  });
});

describe('uploading', () => {
  it('uploads pending records and marks them synced', async () => {
    const { transport, store } = fakeServer();
    for (let i = 0; i < 3; i++) await storage.save(pending());
    const out = await runSync(storage, transport, { now: clock });
    expect(out).toMatchObject({ attempted: 3, synced: 3, rejected: 0, failed: 0 });
    expect([...storage.rows.values()].map((r) => r.status)).toEqual(['synced', 'synced', 'synced']);
    expect(store.records.size).toBe(3);
  });

  it('does not upload drafts', async () => {
    const { transport, state } = fakeServer();
    await storage.save({ ...pending(), status: 'draft' });
    expect((await runSync(storage, transport, { now: clock })).attempted).toBe(0);
    expect(state.calls).toBe(0);
  });

  it('keeps the server warning on a record accepted with flags', async () => {
    const { transport } = fakeServer();
    const r = pending({ lga: 'Ife Central', ward: 'Ife Central Ward 1' });
    await storage.save(r);
    await runSync(storage, transport, { now: clock });
    const after = (await storage.get(r.record_id))!;
    expect(after.status).toBe('synced_with_flags');
    expect(after.flags.map((f) => f.rule)).toEqual(['GPS_far_from_lga']);
  });
});

describe('offline and retry', () => {
  it('stays pending when offline, backs off, and uploads when the connection returns', async () => {
    const { transport, state, store } = fakeServer();
    state.online = false;
    const r = pending();
    await storage.save(r);

    const first = await runSync(storage, transport, { now: clock, random: () => 0.5 });
    expect(first.failed).toBe(1);
    let row = (await storage.get(r.record_id))!;
    expect(row).toMatchObject({ status: 'pending_sync', attempts: 1, next_attempt_at: t + 5_000, last_error: 'Network request failed' });

    // Not due yet: nothing is sent while the back-off runs
    const calls = state.calls;
    expect((await runSync(storage, transport, { now: clock })).attempted).toBe(0);
    expect(state.calls).toBe(calls);

    // Still offline after the wait: the delay doubles
    t += 5_000;
    await runSync(storage, transport, { now: clock, random: () => 0.5 });
    row = (await storage.get(r.record_id))!;
    expect(row.attempts).toBe(2);
    expect(row.next_attempt_at).toBe(t + 10_000);

    // Connection returns
    state.online = true;
    t += 10_000;
    expect((await runSync(storage, transport, { now: clock })).synced).toBe(1);
    expect((await storage.get(r.record_id))!).toMatchObject({ status: 'synced', attempts: 0 });
    expect(store.records.size).toBe(1);
  });

  it('closing the app in the middle of an upload: the rest finishes later with no duplicates', async () => {
    const { transport, state, store } = fakeServer();
    const rows = [pending(), pending(), pending(), pending()];
    for (const r of rows) await storage.save(r);

    // The server stored everything but the phone never heard back (app killed / connection lost)
    state.dropAfterServerWrites = true;
    await runSync(storage, transport, { now: clock });
    expect([...storage.rows.values()].every((r) => r.status === 'pending_sync')).toBe(true);
    expect(store.records.size).toBe(4);

    // The app reopens (a new storage object over the same saved rows) and sync resumes
    state.dropAfterServerWrites = false;
    t += 60_000;
    const reopened = new MemoryStorage();
    for (const r of storage.rows.values()) await reopened.save(r);
    const out = await runSync(reopened, transport, { now: clock });
    expect(out.synced).toBe(4);
    expect([...reopened.rows.values()].every((r) => r.status === 'synced')).toBe(true);
    expect(store.records.size).toBe(4); // still four rows: no duplicates
  });

  it('a record with no answer in the response is retried, not lost', async () => {
    const transport: SyncTransport = { send: async () => [] };
    const r = pending();
    await storage.save(r);
    const out = await runSync(storage, transport, { now: clock });
    expect(out.failed).toBe(1);
    expect((await storage.get(r.record_id))!.status).toBe('pending_sync');
  });
});

describe('forcing a pass past the back-off', () => {
  it('Sync now and a returning connection upload at once, even after a long time offline (delay at the 15 min cap)', async () => {
    const { transport, state, store } = fakeServer();
    state.online = false;
    const r = pending();
    await storage.save(r);
    // Many failed tries while offline push the next attempt far into the future
    for (let i = 0; i < 14; i++) {
      t = Math.max(t, (await storage.get(r.record_id))!.next_attempt_at);
      await runSync(storage, transport, { now: clock, random: () => 0.5 });
    }
    const waiting = (await storage.get(r.record_id))!;
    expect(waiting.next_attempt_at - t).toBeGreaterThanOrEqual(BACKOFF_CAP_MS * 0.8);

    state.online = true;
    // A normal (timer) pass respects the delay and sends nothing...
    expect((await runSync(storage, transport, { now: clock })).attempted).toBe(0);
    // ...but a forced pass uploads now
    const forced = await runSync(storage, transport, { now: clock, force: true });
    expect(forced).toMatchObject({ attempted: 1, synced: 1 });
    expect((await storage.get(r.record_id))!.status).toBe('synced');
    expect(store.records.size).toBe(1);
  });

  it('a forced trigger that arrives while a pass is running is not downgraded to a normal pass', async () => {
    const { transport, state } = fakeServer();
    state.online = false;
    const r = pending();
    await storage.save(r);
    for (let i = 0; i < 6; i++) {
      t = Math.max(t, (await storage.get(r.record_id))!.next_attempt_at);
      await runSync(storage, transport, { now: clock, random: () => 0.5 });
    }
    state.online = true;
    let release: () => void = () => undefined;
    const slow: SyncTransport = { send: (recs) => new Promise((res) => { release = () => res(recs.map((x) => ({ record_id: x.record_id, status: 'accepted', flags: [], errors: [] }) as ServerResult)); }) };
    const engine = new SyncEngine(storage, slow, { now: clock, setTimer: () => 0 as never, clearTimer: () => undefined });
    const first = engine.trigger();          // normal pass: nothing is due, so it finishes at once
    await first;
    const second = engine.trigger({ force: true });
    await Promise.resolve();
    release();
    await second;
    expect((await storage.get(r.record_id))!.status).toBe('synced');
  });
});

describe('rejected records: fix and resubmit', () => {
  it('one bad record in ten: nine synced, the bad one stays on the phone with the server message', async () => {
    const { transport, store } = fakeServer();
    const all = Array.from({ length: 10 }, () => pending());
    const bad = pending({ n_exposed: 100, n_dead: 120 });
    all[6] = bad;
    for (const r of all) await storage.save(r);

    const out = await runSync(storage, transport, { now: clock });
    expect(out).toMatchObject({ attempted: 10, synced: 9, rejected: 1 });
    expect(store.records.size).toBe(9);

    const stuck = (await storage.get(bad.record_id))!;
    expect(stuck.status).toBe('rejected');
    expect(stuck.errors).toHaveLength(1);
    expect(stuck.errors[0]).toMatchObject({ rule: 'n_dead_gt_n_exposed', field: 'n_dead' });
    expect(stuck.errors[0].message).toBe('n_dead (120) is more than n_exposed (100). Correct the number of dead mosquitoes.');
    expect(stuck.values.n_exposed).toBe(100); // everything else kept
  });

  it('a rejected record is not retried automatically', async () => {
    const { transport, state } = fakeServer();
    await storage.save(pending({ n_dead: 999 }));
    await runSync(storage, transport, { now: clock });
    const calls = state.calls;
    t += 3_600_000;
    expect((await runSync(storage, transport, { now: clock })).attempted).toBe(0);
    expect(state.calls).toBe(calls);
  });

  it('correcting one field and resubmitting is accepted under the same record_id', async () => {
    const { transport, store } = fakeServer();
    const bad = pending({ n_exposed: 100, n_dead: 120 });
    await storage.save(bad);
    await runSync(storage, transport, { now: clock });
    const rejected = (await storage.get(bad.record_id))!;
    expect(rejected.status).toBe('rejected');

    await storage.save(resubmit(rejected, { n_dead: 60 }, [], t));
    const row = (await storage.get(bad.record_id))!;
    expect(row).toMatchObject({ status: 'pending_sync', errors: [], attempts: 0, record_id: bad.record_id });
    expect(row.values).toMatchObject({ n_dead: 60, n_exposed: 100, ward: 'Osogbo Ward 2' });

    await runSync(storage, transport, { now: clock });
    expect((await storage.get(bad.record_id))!.status).toBe('synced');
    expect(store.records.get(bad.record_id)?.rec.n_dead).toBe(60);
    expect(store.records.size).toBe(1);
  });

  it('only a rejected record can be resubmitted', () => {
    expect(() => resubmit(pending(), { n_dead: 1 }, [], t)).toThrow(/rejected/);
  });
});

describe('payload', () => {
  it('sends the saved values with the record_id and capture time', () => {
    const r = pending();
    expect(toPayload(r)).toMatchObject({ record_id: r.record_id, captured_at: r.captured_at, lga: 'Osogbo' });
  });
});

describe('SyncEngine', () => {
  it('runs one pass at a time and runs again if triggered meanwhile', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let sends = 0;
    const transport: SyncTransport = {
      async send(records) {
        sends++;
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 10));
        inFlight--;
        return records.map((x) => ({ record_id: x.record_id as string, status: 'accepted', flags: [], errors: [] }));
      },
    };
    await storage.save(pending());
    const engine = new SyncEngine(storage, transport, { now: clock });
    await Promise.all([engine.trigger(), engine.trigger(), engine.trigger()]);
    expect(maxInFlight).toBe(1);
    expect(sends).toBeGreaterThanOrEqual(1);
    expect(engine.isRunning).toBe(false);
  });

  it('schedules the next retry after a failed pass', async () => {
    const { transport, state } = fakeServer();
    state.online = false;
    await storage.save(pending());
    const timers: number[] = [];
    const engine = new SyncEngine(storage, transport, {
      now: clock,
      random: () => 0.5,
      setTimer: ((_fn: () => void, ms: number) => { timers.push(ms); return 0 as never; }) as never,
      clearTimer: () => undefined,
    });
    await engine.trigger();
    expect(timers).toEqual([5_000]);
  });
});
