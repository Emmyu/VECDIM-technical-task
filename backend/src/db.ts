import pg from 'pg';
import { ConstraintViolation, type AuthUser, type BatchStore, type LogItem, type RecordTx, type StoredRecord } from './batch';
import type { Issue } from '@vecdim/validator';

// DATE columns stay plain 'YYYY-MM-DD' strings (no timezone shifts); counts come back as numbers.
pg.types.setTypeParser(1082, (v: string) => v);
pg.types.setTypeParser(20, (v: string) => Number(v));

export function makePool(connectionString: string): pg.Pool {
  return new pg.Pool({ connectionString, max: 10 });
}

/**
 * Runs `fn` in a transaction with the caller's identity set as transaction-local settings.
 * The row-level-security policies (migration 002) read these settings, so the database, not only
 * the API, decides which rows this user may see or write.
 */
export async function withUser<T>(pool: pg.Pool, user: AuthUser, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('app.user_id', $1, true), set_config('app.role', $2, true), set_config('app.state', $3, true)`,
      [user.user_id, user.role, user.state ?? ''],
    );
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

function asConstraint(e: unknown): ConstraintViolation | null {
  const err = e as { code?: string; constraint?: string; message?: string };
  // 23514 check_violation, 23503 foreign_key, 23502 not_null, 22xxx data exceptions (bad date, out of range)
  if (err?.code && (err.code === '23514' || err.code === '23503' || err.code === '23502' || err.code.startsWith('22'))) {
    return new ConstraintViolation(err.constraint ?? 'invalid_value', err.message ?? 'constraint violated');
  }
  return null;
}

export class PgStore implements BatchStore {
  constructor(private pool: pg.Pool) {}

  async startBatch(user: AuthUser, deviceId: string | null, size: number): Promise<string> {
    return withUser(this.pool, user, async (c) => {
      const r = await c.query(
        `INSERT INTO sync_batches (user_id, device_id, n_records) VALUES ($1, $2, $3) RETURNING batch_id`,
        [user.user_id, deviceId, size],
      );
      return r.rows[0].batch_id as string;
    });
  }

  async inTransaction<T>(user: AuthUser, fn: (tx: RecordTx) => Promise<T>): Promise<T> {
    return withUser(this.pool, user, (c) => fn(new PgTx(c, user)));
  }

  async finishBatch(user: AuthUser, batchId: string, counts: { accepted: number; rejected: number; already: number }): Promise<void> {
    await withUser(this.pool, user, (c) =>
      c.query(`UPDATE sync_batches SET n_accepted = $2, n_rejected = $3, n_already = $4 WHERE batch_id = $1`, [
        batchId,
        counts.accepted,
        counts.rejected,
        counts.already,
      ]),
    );
  }
}

class PgTx implements RecordTx {
  constructor(private c: pg.PoolClient, private user: AuthUser) {}

  async exists(recordId: string): Promise<boolean> {
    // Look at every record, not only the ones this user may read: an id owned by someone else is still taken.
    const r = await this.c.query(`SELECT record_exists($1) AS e`, [recordId]);
    return r.rows[0].e as boolean;
  }

  async hasDuplicate(rec: StoredRecord): Promise<boolean> {
    const r = await this.c.query(`SELECT has_duplicate_record($1, $2, $3::date, $4, $5, $6, $7) AS d`, [
      rec.record_id, rec.ward, rec.collection_date, rec.species, rec.insecticide, rec.n_exposed, rec.n_dead,
    ]);
    return r.rows[0].d as boolean;
  }

  async insertRecord(rec: StoredRecord, payload: unknown, batchId: string, flags: Issue[]): Promise<boolean> {
    try {
      const r = await this.c.query(
        `INSERT INTO field_records (
           record_id, owner_user_id, source, state, lga, ward, latitude, longitude, gps_accuracy_m, collection_date,
           species, insecticide, n_exposed, n_dead, mortality_pct, larval_density, urban, irs_covered, itn_use_pct,
           payload, captured_at, batch_id)
         VALUES ($1,$2,'app',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
         ON CONFLICT (record_id) DO NOTHING
         RETURNING record_id`,
        [
          rec.record_id, this.user.user_id, rec.state, rec.lga, rec.ward, rec.latitude, rec.longitude, rec.gps_accuracy_m,
          rec.collection_date, rec.species, rec.insecticide, rec.n_exposed, rec.n_dead, rec.mortality_pct, rec.larval_density,
          rec.urban, rec.irs_covered, rec.itn_use_pct, JSON.stringify(payload), rec.captured_at, batchId,
        ],
      );
      if (r.rowCount === 0) return false;
      for (const f of flags) {
        await this.c.query(
          `INSERT INTO validation_results (record_id, rule, severity, field, message) VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT DO NOTHING`,
          [rec.record_id, f.rule, f.severity, f.field, f.message],
        );
      }
      return true;
    } catch (e) {
      throw asConstraint(e) ?? e;
    }
  }

  async logItem(item: LogItem): Promise<void> {
    await this.c.query(
      `INSERT INTO sync_batch_items (batch_id, user_id, position, record_id, status, errors, flags, payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [item.batchId, this.user.user_id, item.position, item.recordId, item.status, JSON.stringify(item.errors),
        JSON.stringify(item.flags), JSON.stringify(item.payload ?? {})],
    );
  }
}
