import * as SQLite from 'expo-sqlite';

let opening: Promise<SQLite.SQLiteDatabase> | null = null;

/**
 * Local database. Everything the field worker enters lives here (drafts, saved records, the sync queue),
 * so it survives the app being closed, killed or the phone restarting.
 */
export function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (!opening) {
    opening = (async () => {
      const db = await SQLite.openDatabaseAsync('vecdim.db');
      await db.execAsync(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS records (
          record_id       TEXT PRIMARY KEY NOT NULL,
          status          TEXT NOT NULL,
          values_json     TEXT NOT NULL,
          captured_at     TEXT NOT NULL DEFAULT '',
          errors_json     TEXT NOT NULL DEFAULT '[]',
          flags_json      TEXT NOT NULL DEFAULT '[]',
          attempts        INTEGER NOT NULL DEFAULT 0,
          next_attempt_at INTEGER NOT NULL DEFAULT 0,
          last_error      TEXT,
          created_at      INTEGER NOT NULL,
          updated_at      INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS records_status_idx ON records (status, next_attempt_at);
        CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY NOT NULL, v TEXT NOT NULL);
      `);
      return db;
    })();
  }
  return opening;
}
