import { Platform } from 'react-native';
import type { SqliteStorage } from './storage';

export interface Settings {
  /** Base URL of the API, e.g. http://192.168.1.20:3000 (no trailing slash). */
  apiUrl: string;
  /** Demo user the app uploads as (data/demo_users.csv). Real login is out of scope. */
  userId: string;
  /** Show the simulated-GPS buttons in the form (for demos and testing without a mock-location app). */
  testTools: boolean;
}

// The Android emulator reaches the host machine at 10.0.2.2
export const DEFAULTS: Settings = {
  // EXPO_PUBLIC_API_URL overrides the default at start-up (e.g. when port 3000 is taken: EXPO_PUBLIC_API_URL=http://10.0.2.2:3100)
  apiUrl: process.env.EXPO_PUBLIC_API_URL || (Platform.OS === 'android' ? 'http://10.0.2.2:3000' : 'http://localhost:3000'),
  userId: 'u_field_03',
  testTools: true,
};

export const FIELD_USERS = [
  { id: 'u_field_01', label: 'Field worker 1 (Lagos)' },
  { id: 'u_field_02', label: 'Field worker 2 (Kano)' },
  { id: 'u_field_03', label: 'Field worker 3 (Osun)' },
];

export async function loadSettings(storage: SqliteStorage): Promise<Settings> {
  const raw = await storage.getSetting('settings');
  if (!raw) return DEFAULTS;
  try {
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return DEFAULTS;
  }
}

export async function saveSettings(storage: SqliteStorage, s: Settings): Promise<void> {
  await storage.setSetting('settings', JSON.stringify({ ...s, apiUrl: s.apiUrl.trim().replace(/\/+$/, '') }));
}
