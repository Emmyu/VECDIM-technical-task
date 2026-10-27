import type { Issue, RecordInput } from '@vecdim/validator';

/** Statuses a record can have on the device (docs/field_form_spec.md). */
export type LocalStatus = 'draft' | 'pending_sync' | 'synced' | 'synced_with_flags' | 'rejected';

/** The fields the field worker enters (plus the GPS fix). Values may be missing while a form is a draft. */
export type FormValues = RecordInput;

export interface LocalRecord {
  /** UUID v4 made on the phone when the form was opened; never changes (drafts, saving, syncing, resubmission). */
  record_id: string;
  status: LocalStatus;
  values: FormValues;
  /** When the record was saved on the device (ISO). */
  captured_at: string;
  /** Block problems the server reported, shown beside the fields they concern. */
  errors: Issue[];
  /** Warn flags (from the device validator before saving, and from the server). */
  flags: Issue[];
  /** Failed upload attempts since the last change; drives the back-off. */
  attempts: number;
  /** Do not try before this time (epoch ms). */
  next_attempt_at: number;
  last_error: string | null;
  updated_at: number;
}

/** Persistence used by the queue. The app implements it on SQLite; tests use memory. */
export interface SyncStorage {
  /** Records with status pending_sync whose next_attempt_at is due, oldest first. */
  listDue(now: number, limit: number): Promise<LocalRecord[]>;
  get(recordId: string): Promise<LocalRecord | null>;
  save(record: LocalRecord): Promise<void>;
  /** Earliest next_attempt_at among pending records (to schedule the next retry), or null. */
  nextAttemptAt(): Promise<number | null>;
}

export interface ServerResult {
  record_id: string;
  status: 'accepted' | 'accepted_with_flags' | 'rejected' | 'already_received';
  flags: Issue[];
  errors: Issue[];
}

export interface SyncTransport {
  /** Throws when the batch could not be delivered (no connection, timeout, 5xx). */
  send(records: Record<string, unknown>[]): Promise<ServerResult[]>;
}

export interface SyncRunResult {
  attempted: number;
  synced: number;
  rejected: number;
  failed: number;
}
