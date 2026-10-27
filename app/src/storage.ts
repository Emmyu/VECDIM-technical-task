import type { SQLiteDatabase } from 'expo-sqlite';
import type { LocalRecord, LocalStatus, SyncStorage } from '@vecdim/sync-core';
import { getDb } from './db';
import { emitChange } from './events';

interface Row {
  record_id: string;
  status: LocalStatus;
  values_json: string;
  captured_at: string;
  errors_json: string;
  flags_json: string;
  attempts: number;
  next_attempt_at: number;
  last_error: string | null;
  updated_at: number;
}

const toRecord = (r: Row): LocalRecord => ({
  record_id: r.record_id,
  status: r.status,
  values: JSON.parse(r.values_json),
  captured_at: r.captured_at,
  errors: JSON.parse(r.errors_json),
  flags: JSON.parse(r.flags_json),
  attempts: r.attempts,
  next_attempt_at: r.next_attempt_at,
  last_error: r.last_error,
  updated_at: r.updated_at,
});

/** The sync queue and the record list, stored in SQLite. */
export class SqliteStorage implements SyncStorage {
  private constructor(private db: SQLiteDatabase) {}

  static async open(): Promise<SqliteStorage> {
    return new SqliteStorage(await getDb());
  }

  async listDue(now: number, limit: number): Promise<LocalRecord[]> {
    const rows = await this.db.getAllAsync<Row>(
      `SELECT * FROM records WHERE status = 'pending_sync' AND next_attempt_at <= ? ORDER BY created_at LIMIT ?`,
      now,
      limit,
    );
    return rows.map(toRecord);
  }

  async get(recordId: string): Promise<LocalRecord | null> {
    const row = await this.db.getFirstAsync<Row>('SELECT * FROM records WHERE record_id = ?', recordId);
    return row ? toRecord(row) : null;
  }

  /** Insert or update one record in a single statement (so a draft becomes pending_sync atomically). */
  async save(r: LocalRecord): Promise<void> {
    const now = Date.now();
    await this.db.runAsync(
      `INSERT INTO records (record_id, status, values_json, captured_at, errors_json, flags_json, attempts, next_attempt_at, last_error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(record_id) DO UPDATE SET
         status = excluded.status, values_json = excluded.values_json, captured_at = excluded.captured_at,
         errors_json = excluded.errors_json, flags_json = excluded.flags_json, attempts = excluded.attempts,
         next_attempt_at = excluded.next_attempt_at, last_error = excluded.last_error, updated_at = excluded.updated_at`,
      r.record_id, r.status, JSON.stringify(r.values), r.captured_at, JSON.stringify(r.errors), JSON.stringify(r.flags),
      r.attempts, r.next_attempt_at, r.last_error, now, r.updated_at,
    );
    emitChange();
  }

  async nextAttemptAt(): Promise<number | null> {
    const row = await this.db.getFirstAsync<{ t: number | null }>(
      `SELECT MIN(next_attempt_at) AS t FROM records WHERE status = 'pending_sync'`,
    );
    return row?.t ?? null;
  }

  /** Newest first. Drafts are included only when asked for. */
  async list(): Promise<LocalRecord[]> {
    const rows = await this.db.getAllAsync<Row>('SELECT * FROM records ORDER BY created_at DESC');
    return rows.map(toRecord);
  }

  async drafts(): Promise<LocalRecord[]> {
    const rows = await this.db.getAllAsync<Row>(`SELECT * FROM records WHERE status = 'draft' ORDER BY updated_at DESC`);
    return rows.map(toRecord);
  }

  async remove(recordId: string): Promise<void> {
    await this.db.runAsync(`DELETE FROM records WHERE record_id = ? AND status = 'draft'`, recordId);
    emitChange();
  }

  /** Saved (non-draft) records other than `exceptId`, for the on-device duplicate check. */
  async savedValues(exceptId: string): Promise<LocalRecord['values'][]> {
    const rows = await this.db.getAllAsync<{ values_json: string }>(
      `SELECT values_json FROM records WHERE status <> 'draft' AND record_id <> ?`,
      exceptId,
    );
    return rows.map((r) => JSON.parse(r.values_json));
  }

  async getSetting(key: string): Promise<string | null> {
    const row = await this.db.getFirstAsync<{ v: string }>('SELECT v FROM kv WHERE k = ?', key);
    return row?.v ?? null;
  }

  async setSetting(key: string, value: string): Promise<void> {
    await this.db.runAsync('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', key, value);
    emitChange();
  }
}
