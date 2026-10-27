import { mortalityPct, num, text, validateRecord, type Issue, type RecordInput } from '@vecdim/validator';

export type BatchStatus = 'accepted' | 'accepted_with_flags' | 'rejected' | 'already_received';

export interface RecordResult {
  record_id: string;
  status: BatchStatus;
  flags: Issue[];
  errors: Issue[];
  enrichment_pending?: boolean;
}

export interface AuthUser {
  user_id: string;
  role: 'field' | 'vecdim' | 'uniosun';
  state: string | null;
}

/** A record after the server has cleaned up types; this is what goes into field_records. */
export interface StoredRecord {
  record_id: string;
  state: string;
  lga: string;
  ward: string;
  latitude: number;
  longitude: number;
  gps_accuracy_m: number | null;
  collection_date: string;
  species: string;
  insecticide: string;
  n_exposed: number;
  n_dead: number;
  mortality_pct: number;
  larval_density: number;
  urban: number;
  irs_covered: number;
  itn_use_pct: number;
  captured_at: string;
}

/** Everything that must happen inside ONE record's transaction. */
export interface RecordTx {
  exists(recordId: string): Promise<boolean>;
  hasDuplicate(rec: StoredRecord): Promise<boolean>;
  /** Returns false when the record_id was inserted by someone else in the meantime (unique constraint). */
  insertRecord(rec: StoredRecord, payload: unknown, batchId: string, flags: Issue[]): Promise<boolean>;
  logItem(item: LogItem): Promise<void>;
}

export interface LogItem {
  batchId: string;
  position: number;
  recordId: string;
  status: BatchStatus;
  errors: Issue[];
  flags: Issue[];
  payload: unknown;
}

export interface BatchStore {
  startBatch(user: AuthUser, deviceId: string | null, size: number): Promise<string>;
  /** Runs `fn` in its own transaction (or savepoint): a failure rolls back only this record. */
  inTransaction<T>(user: AuthUser, fn: (tx: RecordTx) => Promise<T>): Promise<T>;
  finishBatch(user: AuthUser, batchId: string, counts: { accepted: number; rejected: number; already: number }): Promise<void>;
}

/** Thrown by a store when the database itself refuses a row (CHECK, FK, trigger). */
export class ConstraintViolation extends Error {
  constructor(public constraint: string, message: string) {
    super(message);
  }
}

const CONSTRAINT_HINTS: Record<string, { rule: string; field: string; message: string }> = {
  n_dead_not_more_than_exposed: { rule: 'n_dead_gt_n_exposed', field: 'n_dead', message: 'n_dead is more than n_exposed. Correct the number of dead mosquitoes.' },
  gps_in_nigeria: { rule: 'GPS_outside_nigeria', field: 'latitude', message: 'The GPS point is outside Nigeria. Recapture the location.' },
  gps_not_zero_zero: { rule: 'GPS_zero_zero', field: 'latitude', message: 'The GPS point is 0, 0. Recapture the location.' },
  gps_in_chosen_state: { rule: 'GPS_state_mismatch', field: 'state', message: 'The GPS point is not inside the chosen state. Correct the state or recapture the location.' },
  gps_accuracy_usable: { rule: 'GPS_accuracy_unusable', field: 'gps_accuracy_m', message: 'GPS accuracy is worse than 50 m. Move to open sky and recapture the location.' },
  no_future_collection_date: { rule: 'future_date', field: 'collection_date', message: 'The collection date is in the future. Set it to today or earlier.' },
};

export function constraintToIssue(c: ConstraintViolation): Issue {
  const hint = CONSTRAINT_HINTS[c.constraint];
  return {
    rule: hint?.rule ?? 'database_constraint',
    field: hint?.field ?? 'record',
    severity: 'block',
    message: hint?.message ?? `The database refused this record (${c.constraint}). Check the values and resubmit.`,
  };
}

/** Today's date in Nigeria (WAT), so a late-evening record is not "from the future" at UTC. */
export function todayInNigeria(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Lagos', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

function normalise(r: RecordInput, capturedAt: string): StoredRecord {
  const nExposed = num(r.n_exposed) as number;
  const nDead = num(r.n_dead) as number;
  return {
    record_id: String(r.record_id),
    state: text(r.state) as string,
    lga: text(r.lga) as string,
    ward: text(r.ward) as string,
    latitude: num(r.latitude) as number,
    longitude: num(r.longitude) as number,
    gps_accuracy_m: num(r.gps_accuracy_m),
    collection_date: text(r.collection_date) as string,
    species: text(r.species) as string,
    insecticide: text(r.insecticide) as string,
    n_exposed: nExposed,
    n_dead: nDead,
    mortality_pct: mortalityPct(nDead, nExposed) as number,
    larval_density: num(r.larval_density) as number,
    urban: num(r.urban) as number,
    irs_covered: num(r.irs_covered) as number,
    itn_use_pct: num(r.itn_use_pct) as number,
    captured_at: capturedAt,
  };
}

const err = (rule: string, field: string, message: string): Issue => ({ rule, field, severity: 'block', message });

/** Checks that are about the upload itself rather than about the data (id and capture time). */
function envelopeIssues(raw: Record<string, unknown>): { issues: Issue[]; capturedAt: string | null } {
  const issues: Issue[] = [];
  const id = raw.record_id;
  if (typeof id !== 'string' || id.trim() === '' || id.length > 64) {
    issues.push(err('required_field', 'record_id', 'record_id is missing or invalid. The app must create it when the form is opened.'));
  }
  let capturedAt: string | null = null;
  const c = raw.captured_at;
  if (typeof c !== 'string' || Number.isNaN(Date.parse(c))) {
    issues.push(err('required_field', 'captured_at', 'captured_at is missing or not a valid time. The app must stamp it when the record is saved.'));
  } else capturedAt = new Date(c).toISOString();
  return { issues, capturedAt };
}

export interface ProcessOptions {
  deviceId?: string | null;
  /** Server clock, for the future-date rule. */
  now?: Date;
}

/**
 * Processes a batch of records from one device.
 *  - each record is handled in its own transaction, so one bad record never blocks the others;
 *  - a record_id that was already accepted is answered `already_received` (idempotent);
 *  - a record that was rejected is not stored, so the same record_id can be sent again after a fix;
 *  - every attempt, including rejected ones with their errors, is written to the sync log.
 */
export async function processBatch(
  store: BatchStore,
  user: AuthUser,
  records: unknown[],
  opts: ProcessOptions = {},
): Promise<{ batch_id: string; results: RecordResult[] }> {
  const refDate = todayInNigeria(opts.now);
  const batchId = await store.startBatch(user, opts.deviceId ?? null, records.length);
  const results: RecordResult[] = [];
  const counts = { accepted: 0, rejected: 0, already: 0 };

  for (let position = 0; position < records.length; position++) {
    const raw = (records[position] !== null && typeof records[position] === 'object' ? records[position] : {}) as Record<string, unknown>;
    const recordId = typeof raw.record_id === 'string' ? raw.record_id : '';

    const outcome = await handleOne(store, user, batchId, position, raw, refDate).catch(async (e: unknown) => {
      if (!(e instanceof ConstraintViolation)) throw e;
      // The database refused a row the validator let through: reject it and keep the attempt in the log.
      const result: RecordResult = { record_id: recordId, status: 'rejected', flags: [], errors: [constraintToIssue(e)] };
      await store.inTransaction(user, (tx) =>
        tx.logItem({ batchId, position, recordId, status: 'rejected', errors: result.errors, flags: [], payload: raw }),
      );
      return result;
    });

    results.push(outcome);
    if (outcome.status === 'rejected') counts.rejected++;
    else if (outcome.status === 'already_received') counts.already++;
    else counts.accepted++;
  }

  await store.finishBatch(user, batchId, counts);
  return { batch_id: batchId, results };
}

async function handleOne(
  store: BatchStore,
  user: AuthUser,
  batchId: string,
  position: number,
  raw: Record<string, unknown>,
  refDate: string,
): Promise<RecordResult> {
  const recordId = typeof raw.record_id === 'string' ? raw.record_id : '';
  const { issues: envelope, capturedAt } = envelopeIssues(raw);

  return store.inTransaction(user, async (tx) => {
    const log = (status: BatchStatus, errors: Issue[], flags: Issue[]) =>
      tx.logItem({ batchId, position, recordId, status, errors, flags, payload: raw });

    if (envelope.some((e) => e.field === 'record_id')) {
      await log('rejected', envelope, []);
      return { record_id: recordId, status: 'rejected', flags: [], errors: envelope };
    }

    // Idempotency: a record that was already accepted is never written twice
    if (await tx.exists(recordId)) {
      await log('already_received', [], []);
      return { record_id: recordId, status: 'already_received', flags: [], errors: [] };
    }

    const input = raw as RecordInput;
    const provisional = normaliseForDuplicate(input);
    const isDuplicate = provisional ? await tx.hasDuplicate(provisional) : false;
    const verdict = validateRecord(input, { scope: 'server', refDate, isDuplicate, appRecord: true });
    const errors = [...envelope, ...verdict.errors];

    if (errors.length > 0 || capturedAt === null) {
      await log('rejected', errors, verdict.flags);
      return { record_id: recordId, status: 'rejected', flags: verdict.flags, errors };
    }

    const stored = normalise(input, capturedAt);
    const inserted = await tx.insertRecord(stored, raw, batchId, verdict.flags);
    if (!inserted) {
      await log('already_received', [], []);
      return { record_id: recordId, status: 'already_received', flags: [], errors: [] };
    }
    const status: BatchStatus = verdict.flags.length > 0 ? 'accepted_with_flags' : 'accepted';
    await log(status, [], verdict.flags);
    return { record_id: recordId, status, flags: verdict.flags, errors: [], enrichment_pending: verdict.enrichmentPending };
  });
}

/** Just enough of the record to look for a duplicate, even when other fields are still wrong. */
function normaliseForDuplicate(r: RecordInput): StoredRecord | null {
  const ward = text(r.ward);
  const date = text(r.collection_date);
  const species = text(r.species);
  const ins = text(r.insecticide);
  const ne = num(r.n_exposed);
  const nd = num(r.n_dead);
  if (!ward || !date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !species || !ins || ne === null || nd === null) return null;
  if (!Number.isInteger(ne) || !Number.isInteger(nd)) return null;
  return { record_id: String(r.record_id), ward, collection_date: date, species, insecticide: ins, n_exposed: ne, n_dead: nd } as StoredRecord;
}
