import { StatusBar } from 'expo-status-bar';
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import type { LocalRecord } from '@vecdim/sync-core';
import { FormScreen } from './src/FormScreen';
import { HomeScreen } from './src/HomeScreen';
import { DEFAULTS, loadSettings, type Settings } from './src/settings';
import { SqliteStorage } from './src/storage';
import { startSync } from './src/sync';
import { C } from './src/ui';

type Screen = { name: 'home' } | { name: 'form'; record: LocalRecord | null; key: number };

export default function App() {
  const [storage, setStorage] = useState<SqliteStorage | null>(null);
  const [settings, setSettings] = useState<Settings>(DEFAULTS);
  const [screen, setScreen] = useState<Screen>({ name: 'home' });
  const [offerDraft, setOfferDraft] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const s = await SqliteStorage.open();
        setSettings(await loadSettings(s));
        setStorage(s);
        await startSync(s); // uploads by itself whenever a connection is available
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, []);

  if (error) {
    return <View style={{ flex: 1, justifyContent: 'center', padding: 20 }}><Text style={{ color: C.bad }}>Could not start: {error}</Text></View>;
  }
  if (!storage) {
    return <View style={{ flex: 1, justifyContent: 'center' }}><ActivityIndicator size="large" /></View>;
  }

  return (
    <>
      <StatusBar style="dark" />
      {screen.name === 'home' ? (
        <HomeScreen
          storage={storage}
          settings={settings}
          onSettings={setSettings}
          offerDraft={offerDraft}
          onOfferShown={() => setOfferDraft(false)}
          onOpen={(record) => setScreen({ name: 'form', record, key: Date.now() })}
        />
      ) : (
        <FormScreen key={screen.key} storage={storage} settings={settings} record={screen.record} onClose={() => setScreen({ name: 'home' })} />
      )}
    </>
  );
}
