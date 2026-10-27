import NetInfo from '@react-native-community/netinfo';
import { AppState } from 'react-native';
import { SyncEngine, type ServerResult, type SyncTransport } from '@vecdim/sync-core';
import { emitChange } from './events';
import { loadSettings } from './settings';
import { SqliteStorage } from './storage';

const REQUEST_TIMEOUT_MS = 20_000;

/** Uploads a batch to POST /records/batch. Throws on anything that is not a processed batch, so records are retried. */
function makeTransport(storage: SqliteStorage): SyncTransport {
  return {
    async send(records): Promise<ServerResult[]> {
      const s = await loadSettings(storage);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
      try {
        const res = await fetch(`${s.apiUrl}/api/v1/records/batch`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-User-Id': s.userId },
          body: JSON.stringify({ records, device_id: 'vecdim-app' }),
          signal: ctrl.signal,
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(`Server answered ${res.status}${body?.error ? `: ${body.error}` : ''}`);
        }
        return (await res.json()).results as ServerResult[];
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

let engine: SyncEngine | null = null;
let started = false;
export const syncState = { running: false, lastRunAt: 0, lastError: null as string | null, online: true };

export function getEngine(): SyncEngine {
  if (!engine) throw new Error('Sync not started');
  return engine;
}

/** Starts the automatic upload: on launch, when the connection returns, when the app comes to the front, and every 30 s. */
export async function startSync(storage: SqliteStorage): Promise<void> {
  if (started) return;
  started = true;
  engine = new SyncEngine(storage, makeTransport(storage));
  engine.listeners.add((r) => {
    syncState.lastRunAt = Date.now();
    syncState.lastError = r.failed > 0 ? 'Could not reach the server. Will retry automatically.' : null;
    emitChange();
  });

  // force = ignore the retry delay. Used when the connection returns and when the app comes to the front;
  // the 30-second timer keeps respecting the delay.
  const run = async (force = false) => {
    syncState.running = true;
    emitChange();
    try {
      await engine!.trigger({ force });
    } finally {
      syncState.running = false;
      emitChange();
    }
  };

  NetInfo.addEventListener((state) => {
    const online = state.isConnected === true && state.isInternetReachable !== false;
    const cameOnline = online && !syncState.online;
    syncState.online = online;
    emitChange();
    if (cameOnline) void run(true);
  });
  AppState.addEventListener('change', (s) => {
    if (s === 'active') void run(true);
  });
  setInterval(() => void run(), 30_000);
  void run();
}

/** Ask for an upload pass now (after Save, Resubmit, or the Sync now button). */
export function syncNow(): Promise<void> {
  if (!engine) return Promise.resolve();
  syncState.running = true;
  emitChange();
  return engine.trigger({ force: true }).finally(() => {
    syncState.running = false;
    emitChange();
  });
}
