import type { Issue } from '@vecdim/validator';
import {
  ConstraintViolation,
  type AuthUser,
  type BatchStore,
  type LogItem,
  type RecordTx,
  type StoredRecord,
} from '../src/batch';

/**
 * In-memory BatchStore for unit tests. It mimics the properties the real database gives:
 * a unique record_id, a per-record transaction that rolls back on error, and an append-only attempt log.
 */
export class MemoryStore implements BatchStore {
  records = new Map<string, { rec: StoredRecord; owner: string; payload: unknown; flags: Issue[] }>();
  log: (LogItem & { user: string })[] = [];
  batches: { id: string; size: number; counts?: { accepted: number; rejected: number; already: number } }[] = [];
  /** Test hook: make inserting this record_id fail like a database CHECK would. */
  failInsertWith = new Map<string, string>();
  transactions = 0;

  async startBatch(_user: AuthUser, _device: string | null, size: number): Promise<string> {
    const id = `batch-${this.batches.length + 1}`;
    this.batches.push({ id, size });
    return id;
  }

  async inTransaction<T>(user: AuthUser, fn: (tx: RecordTx) => Promise<T>): Promise<T> {
    this.transactions++;
    const pendingRecords: [string, { rec: StoredRecord; owner: string; payload: unknown; flags: Issue[] }][] = [];
    const pendingLog: (LogItem & { user: string })[] = [];
    const tx: RecordTx = {
      exists: async (id) => this.records.has(id),
      hasDuplicate: async (r) =>
        [...this.records.values()].some(
          ({ rec }) =>
            rec.record_id !== r.record_id && rec.ward === r.ward && rec.collection_date === r.collection_date &&
            rec.species === r.species && rec.insecticide === r.insecticide && rec.n_exposed === r.n_exposed && rec.n_dead === r.n_dead,
        ),
      insertRecord: async (rec, payload, _batch, flags) => {
        const failure = this.failInsertWith.get(rec.record_id);
        if (failure) throw new ConstraintViolation(failure, 'simulated database check failure');
        if (this.records.has(rec.record_id)) return false;
        pendingRecords.push([rec.record_id, { rec, owner: user.user_id, payload, flags }]);
        return true;
      },
      logItem: async (item) => {
        pendingLog.push({ ...item, user: user.user_id });
      },
    };
    const out = await fn(tx); // a throw here discards the pending writes: the record's transaction rolled back
    for (const [id, v] of pendingRecords) this.records.set(id, v);
    this.log.push(...pendingLog);
    return out;
  }

  async finishBatch(_user: AuthUser, batchId: string, counts: { accepted: number; rejected: number; already: number }) {
    this.batches.find((b) => b.id === batchId)!.counts = counts;
  }
}
