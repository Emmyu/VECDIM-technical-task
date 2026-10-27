import { beforeEach, describe, expect, it } from 'vitest';
import { processBatch, todayInNigeria, type AuthUser } from '../src/batch';
import { MemoryStore } from './memoryStore';

const user: AuthUser = { user_id: 'u_field_03', role: 'field', state: 'Osun' };
const now = new Date('2026-10-08T10:00:00Z');

let n = 0;
const rec = (over: Record<string, unknown> = {}) => ({
  record_id: `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
  state: 'Osun', lga: 'Osogbo', ward: 'Osogbo Ward 2', latitude: 7.77, longitude: 4.56, gps_accuracy_m: 6.5,
  collection_date: '2026-10-07', species: 'An. gambiae s.s.', insecticide: 'Permethrin', n_exposed: 100,
  n_dead: 54 + n, larval_density: 6, urban: 1, irs_covered: 0, itn_use_pct: 61.5, captured_at: '2026-10-07T09:14:22Z',
  ...over,
});

let store: MemoryStore;
beforeEach(() => {
  store = new MemoryStore();
});
const send = (records: unknown[]) => processBatch(store, user, records, { now });

describe('accepting records', () => {
  it('accepts a valid record, stores the payload as received and marks enrichment pending', async () => {
    const r = rec();
    const { results } = await send([r]);
    expect(results[0]).toMatchObject({ record_id: r.record_id, status: 'accepted', errors: [], flags: [], enrichment_pending: true });
    const stored = store.records.get(r.record_id)!;
    expect(stored.payload).toEqual(r);
    expect(stored.rec.mortality_pct).toBe(r.n_dead);
    expect(stored.owner).toBe('u_field_03');
  });

  it('accepts with flags when only Warn rules fire (far from LGA, poor accuracy)', async () => {
    const r = rec({ lga: 'Ife Central', ward: 'Ife Central Ward 1', gps_accuracy_m: 18 });
    const { results } = await send([r]);
    expect(results[0].status).toBe('accepted_with_flags');
    expect(results[0].flags.map((f) => f.rule).sort()).toEqual(['GPS_accuracy_poor', 'GPS_far_from_lga']);
    expect(store.records.has(r.record_id)).toBe(true);
  });
});

describe('idempotency', () => {
  it('sending the same record twice stores one row and answers already_received', async () => {
    const r = rec();
    const first = await send([r]);
    const second = await send([r]);
    expect(first.results[0].status).toBe('accepted');
    expect(second.results[0].status).toBe('already_received');
    expect(store.records.size).toBe(1);
  });

  it('the same record twice inside one batch is stored once', async () => {
    const r = rec();
    const { results } = await send([r, r]);
    expect(results.map((x) => x.status)).toEqual(['accepted', 'already_received']);
    expect(store.records.size).toBe(1);
  });
});

describe('partial failure', () => {
  it('one bad record in a batch of ten: nine accepted, the bad one rejected with its message', async () => {
    const batch = Array.from({ length: 10 }, () => rec());
    batch[4] = rec({ n_exposed: 100, n_dead: 120 });
    const { results } = await send(batch);
    expect(results.filter((r) => r.status === 'accepted')).toHaveLength(9);
    expect(results[4].status).toBe('rejected');
    expect(results[4].errors).toEqual([
      { rule: 'n_dead_gt_n_exposed', field: 'n_dead', severity: 'block',
        message: 'n_dead (120) is more than n_exposed (100). Correct the number of dead mosquitoes.' },
    ]);
    expect(store.records.size).toBe(9);
    expect(store.records.has(batch[4].record_id as string)).toBe(false);
  });

  it('results come back in the same order as the request', async () => {
    const batch = [rec(), rec({ n_dead: 999 }), rec()];
    const { results } = await send(batch);
    expect(results.map((r) => r.record_id)).toEqual(batch.map((r) => r.record_id));
  });

  it('every record runs in its own transaction', async () => {
    await send([rec(), rec(), rec()]);
    expect(store.transactions).toBe(3);
  });

  it('a database constraint failure rejects only that record and the attempt is logged', async () => {
    const bad = rec();
    store.failInsertWith.set(bad.record_id, 'gps_in_chosen_state');
    const { results } = await send([rec(), bad, rec()]);
    expect(results.map((r) => r.status)).toEqual(['accepted', 'rejected', 'accepted']);
    expect(results[1].errors[0]).toMatchObject({ rule: 'GPS_state_mismatch', field: 'state' });
    expect(store.records.has(bad.record_id)).toBe(false);
    expect(store.log.find((l) => l.recordId === bad.record_id)?.status).toBe('rejected');
  });
});

describe('resubmission after a fix', () => {
  it('a rejected record corrected and sent again under the same record_id is accepted', async () => {
    const bad = rec({ n_dead: 120 });
    expect((await send([bad])).results[0].status).toBe('rejected');
    expect(store.records.size).toBe(0);

    const fixed = { ...bad, n_dead: 60 };
    const again = await send([fixed]);
    expect(again.results[0]).toMatchObject({ record_id: bad.record_id, status: 'accepted' });
    expect(store.records.get(bad.record_id)?.rec.n_dead).toBe(60);
  });

  it('keeps every attempt, rejected ones with their errors, in the sync log', async () => {
    const bad = rec({ n_dead: 120 });
    await send([bad]);
    await send([{ ...bad, n_dead: 60 }]);
    await send([{ ...bad, n_dead: 60 }]);
    const attempts = store.log.filter((l) => l.recordId === bad.record_id);
    expect(attempts.map((a) => a.status)).toEqual(['rejected', 'accepted', 'already_received']);
    expect(attempts[0].errors[0].rule).toBe('n_dead_gt_n_exposed');
    expect(attempts[0].payload).toMatchObject({ n_dead: 120 });
  });
});

describe('server-side re-validation (never trust the device)', () => {
  it.each([
    [{ latitude: 0, longitude: 0 }, 'GPS_zero_zero'],
    [{ latitude: 51.5, longitude: -0.1 }, 'GPS_outside_nigeria'],
    [{ state: 'Kano', lga: 'Dala', ward: 'Dala Ward 1' }, 'GPS_state_mismatch'],
    [{ collection_date: '2026-10-09' }, 'future_date'],
    [{ gps_accuracy_m: 60 }, 'GPS_accuracy_unusable'],
    [{ species: null }, 'missing_core'],
    [{ itn_use_pct: null }, 'missing_core'],
    [{ temp_c: 55 }, 'temp_implausible'],
    [{ rainfall_mm: -1 }, 'rainfall_implausible'],
    [{ slide_positivity_pct: 120 }, 'positivity_out_range'],
  ])('rejects %j with %s', async (patch, rule) => {
    const { results } = await send([rec(patch)]);
    expect(results[0].status).toBe('rejected');
    expect(results[0].errors.map((e) => e.rule)).toContain(rule);
    expect(store.records.size).toBe(0);
  });

  it('rejects a record with no record_id or no captured_at', async () => {
    const noId = await send([{ ...rec(), record_id: '' }]);
    expect(noId.results[0].errors[0]).toMatchObject({ rule: 'required_field', field: 'record_id' });
    const noTime = await send([{ ...rec(), captured_at: undefined }]);
    expect(noTime.results[0].errors.map((e) => e.field)).toContain('captured_at');
    expect(store.records.size).toBe(0);
  });

  it('survives a non-object entry in the batch', async () => {
    const { results } = await send([null, 42, rec()]);
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected', 'accepted']);
  });
});

describe('duplicate rule (Warn)', () => {
  it('flags the later record as a duplicate but still stores it', async () => {
    const a = rec({ n_dead: 50 });
    const b = rec({ n_dead: 50 });
    await send([a]);
    const { results } = await send([b]);
    expect(results[0].status).toBe('accepted_with_flags');
    expect(results[0].flags.map((f) => f.rule)).toEqual(['duplicate']);
    expect(store.records.size).toBe(2);
  });
});

describe('batch bookkeeping', () => {
  it('records the outcome counts for the batch', async () => {
    const dup = rec();
    await send([dup]);
    await send([dup, rec(), rec({ n_dead: 999 })]);
    expect(store.batches[1].counts).toEqual({ accepted: 1, rejected: 1, already: 1 });
  });

  it('todayInNigeria uses WAT, so late evening UTC is already tomorrow', () => {
    expect(todayInNigeria(new Date('2026-10-08T23:30:00Z'))).toBe('2026-10-09');
    expect(todayInNigeria(new Date('2026-10-08T22:30:00Z'))).toBe('2026-10-08');
  });
});
