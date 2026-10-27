import React, { useCallback, useEffect, useState } from 'react';
import { Alert, FlatList, Modal, Pressable, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import type { LocalRecord } from '@vecdim/sync-core';
import { mortalityPct, whoClass } from '@vecdim/validator';
import { subscribe } from './events';
import { DEFAULTS, FIELD_USERS, saveSettings, type Settings } from './settings';
import type { SqliteStorage } from './storage';
import { syncNow, syncState } from './sync';
import { Badge, Button, C, Card, Chip, Label } from './ui';

type Filter = 'all' | 'attention' | 'pending' | 'synced' | 'draft';

export function statusInfo(r: LocalRecord): { text: string; tone: 'ok' | 'warn' | 'bad' | 'info' | 'muted'; detail?: string } {
  switch (r.status) {
    case 'draft':
      return { text: 'Draft', tone: 'muted', detail: `Unfinished, last changed ${new Date(r.updated_at).toLocaleTimeString()}` };
    case 'pending_sync': {
      const wait = r.next_attempt_at - Date.now();
      return {
        text: 'Waiting to sync',
        tone: 'info',
        detail: r.attempts > 0
          ? `Could not upload (try ${r.attempts}). ${wait > 0 ? `Next try in ${Math.ceil(wait / 1000)} s.` : 'Retrying now.'}`
          : 'Saved on this phone. Uploads when there is a connection.',
      };
    }
    case 'synced':
      return { text: 'Synced', tone: 'ok' };
    case 'synced_with_flags':
      return { text: 'Synced with warning', tone: 'warn', detail: r.flags.map((f) => f.message).join(' ') };
    case 'rejected':
      return { text: 'Needs attention', tone: 'bad', detail: r.errors.map((e) => `${e.field}: ${e.message}`).join('\n') };
  }
}

interface Props {
  storage: SqliteStorage;
  settings: Settings;
  onSettings: (s: Settings) => void;
  onOpen: (r: LocalRecord | null) => void;
  /** Offer the unfinished form once when the app opens. */
  offerDraft: boolean;
  onOfferShown: () => void;
}

export function HomeScreen({ storage, settings, onSettings, onOpen, offerDraft, onOfferShown }: Props) {
  const [records, setRecords] = useState<LocalRecord[]>([]);
  const [filter, setFilter] = useState<Filter>('all');
  const [showSettings, setShowSettings] = useState(false);
  const [, force] = useState(0);

  const reload = useCallback(async () => {
    setRecords(await storage.list());
    force((n) => n + 1);
  }, [storage]);

  useEffect(() => {
    void reload();
    const off = subscribe(() => void reload());
    const tick = setInterval(() => force((n) => n + 1), 1000); // refreshes "next try in N s"
    return () => {
      off();
      clearInterval(tick);
    };
  }, [reload]);

  // "You have an unfinished record from 14:32. Resume or discard?"
  useEffect(() => {
    if (!offerDraft) return;
    onOfferShown();
    void storage.drafts().then((drafts) => {
      const d = drafts[0];
      if (!d) return;
      const at = new Date(d.updated_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      Alert.alert('Unfinished record', `You have an unfinished record from ${at}. Resume or discard?`, [
        { text: 'Discard', style: 'destructive', onPress: () => void storage.remove(d.record_id) },
        { text: 'Resume', onPress: () => onOpen(d) },
      ]);
    });
  }, [offerDraft]); // eslint-disable-line react-hooks/exhaustive-deps

  const counts = {
    attention: records.filter((r) => r.status === 'rejected').length,
    pending: records.filter((r) => r.status === 'pending_sync').length,
    synced: records.filter((r) => r.status === 'synced' || r.status === 'synced_with_flags').length,
    draft: records.filter((r) => r.status === 'draft').length,
  };
  const shown = records.filter((r) =>
    filter === 'all' ? true
      : filter === 'attention' ? r.status === 'rejected'
        : filter === 'pending' ? r.status === 'pending_sync'
          : filter === 'synced' ? r.status === 'synced' || r.status === 'synced_with_flags'
            : r.status === 'draft');

  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <View style={st.header}>
        <Text style={st.title}>VECDIM Field</Text>
        <Button title="Settings" kind="secondary" small onPress={() => setShowSettings(true)} />
      </View>

      <View style={{ padding: 14, paddingBottom: 0 }}>
        <Card style={{ marginBottom: 10 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <View style={{ flex: 1 }}>
              <Text style={{ fontWeight: '700', color: C.text }}>
                {syncState.running ? 'Uploading…' : syncState.online ? 'Online' : 'Offline: records are kept on this phone'}
              </Text>
              <Text style={{ color: C.muted }}>
                {counts.pending} waiting · {counts.synced} synced · {counts.attention} need attention
              </Text>
              {syncState.lastError && counts.pending > 0 ? <Text style={{ color: C.warn }}>{syncState.lastError}</Text> : null}
            </View>
            <Button title="Sync now" kind="secondary" small onPress={() => void syncNow()} />
          </View>
        </Card>
        <Button title="+ New record" onPress={() => onOpen(null)} />
        <View style={st.filters}>
          {([
            ['all', `All (${records.length})`], ['attention', `Needs attention (${counts.attention})`],
            ['pending', `Waiting (${counts.pending})`], ['synced', `Synced (${counts.synced})`], ['draft', `Drafts (${counts.draft})`],
          ] as [Filter, string][]).map(([k, t]) => <Chip key={k} title={t} selected={filter === k} onPress={() => setFilter(k)} />)}
        </View>
      </View>

      <FlatList
        data={shown}
        keyExtractor={(r) => r.record_id}
        contentContainerStyle={{ padding: 14, paddingTop: 0 }}
        ListEmptyComponent={<Text style={{ color: C.muted, textAlign: 'center', marginTop: 30 }}>No records here yet.</Text>}
        renderItem={({ item: r }) => {
          const info = statusInfo(r);
          const m = mortalityPct(r.values.n_dead as number, r.values.n_exposed as number);
          const who = whoClass(m);
          const tappable = r.status === 'rejected' || r.status === 'draft';
          return (
            <Pressable disabled={!tappable} onPress={() => onOpen(r)} accessibilityRole={tappable ? 'button' : undefined}>
              <Card style={r.status === 'rejected' ? { borderColor: C.bad, borderWidth: 2 } : undefined}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                  <Text style={{ fontWeight: '700', color: C.text, flex: 1 }}>{String(r.values.ward ?? 'No ward yet')}</Text>
                  <Badge text={info.text} tone={info.tone} />
                </View>
                <Text style={{ color: C.muted, marginTop: 2 }}>
                  {String(r.values.collection_date ?? '')} · {String(r.values.species ?? '—')} · {String(r.values.insecticide ?? '—')}
                </Text>
                {m !== null && <Text style={{ color: C.text, marginTop: 2 }}>Mortality {m.toFixed(1)}%{who ? ` · ${who}` : ''}</Text>}
                {info.detail ? <Text style={{ color: info.tone === 'bad' ? C.bad : C.muted, marginTop: 4 }}>{info.detail}</Text> : null}
                {r.status === 'rejected' && <Text style={{ color: C.primary, fontWeight: '700', marginTop: 6 }}>Tap to fix and resubmit</Text>}
                {r.status === 'draft' && <Text style={{ color: C.primary, fontWeight: '700', marginTop: 6 }}>Tap to resume</Text>}
                <Text style={{ color: C.muted, fontSize: 11, marginTop: 4 }}>ID {r.record_id}</Text>
              </Card>
            </Pressable>
          );
        }}
      />

      <SettingsModal visible={showSettings} settings={settings} storage={storage} onClose={() => setShowSettings(false)} onSaved={onSettings} />
    </View>
  );
}

function SettingsModal({
  visible, settings, storage, onClose, onSaved,
}: { visible: boolean; settings: Settings; storage: SqliteStorage; onClose: () => void; onSaved: (s: Settings) => void }) {
  const [draft, setDraft] = useState(settings);
  const [check, setCheck] = useState<string | null>(null);
  useEffect(() => setDraft(settings), [settings, visible]);

  const test = async () => {
    setCheck('Checking…');
    try {
      const res = await fetch(`${draft.apiUrl.trim().replace(/\/+$/, '')}/api/v1/health`);
      setCheck(res.ok ? 'Connected: the server answered.' : `The server answered ${res.status}.`);
    } catch {
      setCheck('Could not reach the server. Check the address and that this phone is on the same network.');
    }
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: C.bg, padding: 14, paddingTop: 50 }}>
        <Text style={st.title}>Settings</Text>
        <Card style={{ marginTop: 12 }}>
          <Label>Server address</Label>
          <TextInput style={st.input} autoCapitalize="none" autoCorrect={false} value={draft.apiUrl} onChangeText={(t) => setDraft({ ...draft, apiUrl: t })} placeholder={DEFAULTS.apiUrl} />
          <Text style={{ color: C.muted, marginTop: 4 }}>On a real phone use the computer's address on the same Wi-Fi, e.g. http://192.168.1.20:3000</Text>
          <View style={{ height: 8 }} />
          <Button title="Test connection" kind="secondary" small onPress={() => void test()} />
          {check ? <Text style={{ marginTop: 6, color: C.text }}>{check}</Text> : null}
        </Card>
        <Card>
          <Label>Upload as (demo user)</Label>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
            {FIELD_USERS.map((u) => <Chip key={u.id} title={u.label} selected={draft.userId === u.id} onPress={() => setDraft({ ...draft, userId: u.id })} />)}
          </View>
        </Card>
        <Card>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <View style={{ flex: 1, paddingRight: 10 }}>
              <Label>Test tools</Label>
              <Text style={{ color: C.muted }}>Show simulated GPS fixes (6 m, 18 m, 60 m, Osogbo, Ikorodu) in the form.</Text>
            </View>
            <Switch value={draft.testTools} onValueChange={(v) => setDraft({ ...draft, testTools: v })} />
          </View>
        </Card>
        <Button title="Save settings" onPress={() => { void saveSettings(storage, draft).then(() => { onSaved({ ...draft, apiUrl: draft.apiUrl.trim().replace(/\/+$/, '') }); onClose(); void syncNow(); }); }} />
        <View style={{ height: 8 }} />
        <Button title="Close" kind="secondary" onPress={onClose} />
      </View>
    </Modal>
  );
}

const st = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 12, paddingTop: 46, backgroundColor: C.card, borderBottomWidth: 1, borderBottomColor: C.border },
  title: { fontSize: 20, fontWeight: '800', color: C.primary },
  filters: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 12 },
  input: { borderWidth: 1, borderColor: C.border, borderRadius: 8, paddingHorizontal: 12, minHeight: 48, fontSize: 16, color: C.text, backgroundColor: '#fff' },
});
