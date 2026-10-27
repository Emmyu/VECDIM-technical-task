import DateTimePicker from '@react-native-community/datetimepicker';
import * as Crypto from 'expo-crypto';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert, AppState, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Switch, Text, TextInput, View,
} from 'react-native';
import { resubmit, toPending, type LocalRecord } from '@vecdim/sync-core';
import {
  INSECTICIDES, LGAS, LGA_REF, SPECIES, duplicateKey, mortalityPct, validateRecord, whoClass,
  type GpsFix, type Issue, type RecordInput,
} from '@vecdim/validator';
import { Badge, Button, C, Card, Chip, Label, Message } from './ui';
import { syncNow } from './sync';
import type { Settings } from './settings';
import type { SqliteStorage } from './storage';
import { useGps } from './useGps';

type Values = RecordInput;
const NUMERIC = ['n_exposed', 'n_dead', 'larval_density', 'itn_use_pct'] as const;

/** Today's date on the phone, as YYYY-MM-DD in local time. */
function localToday(): string {
  return localIso(new Date());
}
function localIso(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const WHO_TONE = { Susceptible: 'ok', 'Possible resistance': 'warn', Resistant: 'bad' } as const;

interface Props {
  storage: SqliteStorage;
  settings: Settings;
  /** An existing draft to resume, or a rejected record to fix; null for a new form. */
  record: LocalRecord | null;
  onClose: () => void;
}

export function FormScreen({ storage, settings, record, onClose }: Props) {
  const resubmitting = record?.status === 'rejected';
  // The record_id is made when the form is opened (offline) and never changes afterwards.
  const recordId = useRef(record?.record_id ?? Crypto.randomUUID()).current;
  const [values, setValues] = useState<Values>(() => record?.values ?? { collection_date: localToday(), urban: 0, irs_covered: 0 });
  const [raw, setRaw] = useState<Record<string, string>>(() => {
    const v = record?.values ?? {};
    return Object.fromEntries(NUMERIC.map((k) => [k, v[k] == null ? '' : String(v[k])]));
  });
  const [serverErrors, setServerErrors] = useState<Issue[]>(record?.status === 'rejected' ? record.errors : []);
  const [showErrors, setShowErrors] = useState(resubmitting);
  const [isDuplicate, setIsDuplicate] = useState(false);
  const [showDate, setShowDate] = useState(false);
  const [saving, setSaving] = useState(false);

  const restoredFix: GpsFix | null =
    record && values.latitude != null && values.longitude != null
      ? { latitude: Number(values.latitude), longitude: Number(values.longitude), accuracy: values.gps_accuracy_m == null ? null : Number(values.gps_accuracy_m) }
      : null;
  const gps = useGps(restoredFix);

  // A new form starts looking for a location at once; a resumed draft keeps its saved fix until the user recaptures.
  useEffect(() => {
    if (!record) void gps.start();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (gps.fix) {
      setValues((v) => ({ ...v, latitude: gps.fix!.latitude, longitude: gps.fix!.longitude, gps_accuracy_m: gps.fix!.accuracy }));
    }
  }, [gps.fix]);

  // ---------- autosave of the draft ----------
  const userEdited = useRef(false); // GPS auto-fill alone does not create a draft
  const latest = useRef(values);
  latest.current = values;

  const flushDraft = useCallback(async () => {
    if (resubmitting || !userEdited.current) return;
    const existing = await storage.get(recordId);
    if (existing && existing.status !== 'draft') return; // already saved: never turn it back into a draft
    await storage.save({
      record_id: recordId, status: 'draft', values: latest.current, captured_at: '', errors: [], flags: [],
      attempts: 0, next_attempt_at: 0, last_error: null, updated_at: Date.now(),
    });
  }, [recordId, resubmitting, storage]);

  useEffect(() => {
    if (!userEdited.current) return;
    const t = setTimeout(() => void flushDraft(), 700); // well under the 2 s allowed by the spec
    return () => clearTimeout(t);
  }, [values, flushDraft]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (st) => {
      if (st !== 'active') void flushDraft(); // going to the background: save right now
    });
    return () => sub.remove();
  }, [flushDraft]);

  // ---------- editing ----------
  const set = useCallback((patch: Partial<Values>, fields: string[] = Object.keys(patch)) => {
    userEdited.current = true;
    setValues((v) => ({ ...v, ...patch }));
    // Once the user changes a field, the server's complaint about it no longer applies
    setServerErrors((errs) => errs.filter((e) => !fields.includes(e.field)));
  }, []);

  const setNumber = (key: (typeof NUMERIC)[number], text: string) => {
    setRaw((r) => ({ ...r, [key]: text }));
    const n = text.trim() === '' ? null : Number(text);
    set({ [key]: n === null || Number.isNaN(n) ? null : n } as Partial<Values>, [key]);
  };

  // ---------- duplicate check against records on the device ----------
  useEffect(() => {
    let cancelled = false;
    void storage.savedValues(recordId).then((others) => {
      if (cancelled) return;
      const mine = duplicateKey(values);
      setIsDuplicate(others.some((o) => duplicateKey(o) === mine));
    });
    return () => {
      cancelled = true;
    };
  }, [storage, recordId, values.ward, values.collection_date, values.species, values.insecticide, values.n_exposed, values.n_dead]); // eslint-disable-line react-hooks/exhaustive-deps

  const result = useMemo(
    () => validateRecord(values, { scope: 'device', refDate: localToday(), isDuplicate, appRecord: true }),
    [values, isDuplicate],
  );

  const mortality = mortalityPct(values.n_dead as number | null, values.n_exposed as number | null);
  const who = whoClass(mortality);

  const errorsFor = (field: string): Issue[] => [
    ...serverErrors.filter((e) => e.field === field),
    ...(showErrors ? result.errors.filter((e) => e.field === field && !serverErrors.some((x) => x.rule === e.rule && x.field === e.field)) : []),
  ];
  const flagsFor = (field: string) => result.flags.filter((f) => f.field === field);
  const Msgs = ({ field }: { field: string }) => (
    <>
      {errorsFor(field).map((e, i) => <Message key={`e${i}`} tone="bad">{e.message}</Message>)}
      {flagsFor(field).map((f, i) => <Message key={`f${i}`} tone="warn">{f.message}</Message>)}
    </>
  );

  // ---------- save / resubmit ----------
  const persist = async () => {
    setSaving(true);
    try {
      const now = Date.now();
      if (resubmitting && record) {
        await storage.save(resubmit(record, values, result.flags, now));
      } else {
        await storage.save(toPending(recordId, values, result.flags, now));
      }
      void syncNow(); // upload at once if there is a connection; otherwise it waits in the queue
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const onSave = () => {
    setShowErrors(true);
    if (result.errors.length > 0) return;
    if (result.flags.length > 0) {
      Alert.alert(
        'Save with warnings?',
        result.flags.map((f) => `• ${f.message}`).join('\n\n'),
        [
          { text: 'Go back and fix', style: 'cancel' },
          { text: resubmitting ? 'Resubmit anyway' : 'Save anyway', onPress: () => void persist() },
        ],
      );
      return;
    }
    void persist();
  };

  const onBack = async () => {
    await flushDraft();
    onClose();
  };

  const onDiscard = () => {
    Alert.alert('Discard this draft?', 'Everything entered so far will be deleted.', [
      { text: 'Keep', style: 'cancel' },
      { text: 'Discard', style: 'destructive', onPress: () => void storage.remove(recordId).then(onClose) },
    ]);
  };

  // ---------- derived pieces ----------
  const lgas = values.state ? LGAS[String(values.state)] ?? [] : [];
  const wardNumbers = [1, 2, 3, 4, 5, 6];
  const gpsTone = gps.status.phase === 'accepted' ? 'ok' : gps.status.phase === 'unusable' ? 'bad' : 'warn';
  const baseFix = gps.fix ?? (values.lga && LGA_REF[`${values.state}|${values.lga}`]
    ? { latitude: LGA_REF[`${values.state}|${values.lga}`].lat, longitude: LGA_REF[`${values.state}|${values.lga}`].lon, accuracy: 6 }
    : { latitude: 7.77, longitude: 4.56, accuracy: 6 });
  const blockingCount = result.errors.length;

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: C.bg }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={st.header}>
        <Button title="‹ Back" kind="secondary" small onPress={() => void onBack()} />
        <Text style={st.title}>{resubmitting ? 'Fix and resubmit' : record ? 'Resume draft' : 'New record'}</Text>
        {!resubmitting && userEdited.current !== undefined && record?.status === 'draft' ? (
          <Button title="Discard" kind="danger" small onPress={onDiscard} />
        ) : <View style={{ width: 70 }} />}
      </View>

      <ScrollView contentContainerStyle={{ padding: 14, paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
        {resubmitting && serverErrors.length > 0 && (
          <Card style={{ borderColor: C.bad }}>
            <Text style={{ fontWeight: '700', color: C.bad, marginBottom: 4 }}>The server did not accept this record</Text>
            {serverErrors.map((e, i) => <Text key={i} style={{ color: C.bad, marginTop: 2 }}>• {e.field}: {e.message}</Text>)}
            <Text style={{ color: C.muted, marginTop: 6 }}>Change only what is wrong, then tap Resubmit. Everything else is kept.</Text>
          </Card>
        )}
        {showErrors && blockingCount > 0 && !resubmitting && (
          <Card style={{ borderColor: C.bad }}>
            <Text style={{ fontWeight: '700', color: C.bad }}>
              {blockingCount} problem{blockingCount > 1 ? 's' : ''} to fix before this can be saved. They are shown beside the fields.
            </Text>
          </Card>
        )}

        <Card>
          <Label>State</Label>
          <View style={st.row}>
            {Object.keys(LGAS).map((x) => (
              <Chip key={x} title={x} selected={values.state === x} onPress={() => set({ state: x, lga: null, ward: null }, ['state', 'lga', 'ward'])} />
            ))}
          </View>
          <Msgs field="state" />

          <Label>LGA</Label>
          <View style={st.row}>
            {lgas.length === 0 && <Text style={{ color: C.muted }}>Pick a state first</Text>}
            {lgas.map((x) => (
              <Chip key={x} title={x} selected={values.lga === x} onPress={() => set({ lga: x, ward: null }, ['lga', 'ward'])} />
            ))}
          </View>
          <Msgs field="lga" />

          <Label>Ward</Label>
          <View style={st.row}>
            {!values.lga && <Text style={{ color: C.muted }}>Pick an LGA first</Text>}
            {values.lga && wardNumbers.map((n) => {
              const w = `${values.lga} Ward ${n}`;
              return <Chip key={w} title={`Ward ${n}`} selected={values.ward === w} onPress={() => set({ ward: w })} />;
            })}
          </View>
          <Msgs field="ward" />
        </Card>

        <Card>
          <Label>Location (GPS)</Label>
          <Text style={st.coords}>
            {values.latitude != null && values.longitude != null
              ? `${Number(values.latitude).toFixed(5)}, ${Number(values.longitude).toFixed(5)}`
              : gps.permission === 'denied' ? 'Location permission denied' : 'No location yet'}
          </Text>
          <Message tone={gpsTone === 'bad' ? 'bad' : 'warn'}>
            {gps.permission === 'denied'
              ? 'Location permission is off. Allow location for this app in the phone settings, then tap Recapture.'
              : gps.status.message}
          </Message>
          {gps.status.phase === 'accepted' && <View style={{ marginTop: 6 }}><Badge text="GPS OK" tone="ok" /></View>}
          <View style={{ height: 8 }} />
          <Button title={gps.searching ? 'Searching… tap to restart' : 'Recapture location'} kind="secondary" onPress={() => void gps.start()} />
          <Msgs field="latitude" />
          <Msgs field="longitude" />
          <Msgs field="gps_accuracy_m" />
          {settings.testTools && (
            <View style={st.tools}>
              <Text style={{ fontSize: 12, color: C.muted, marginBottom: 6 }}>Test tools: simulated GPS fixes</Text>
              <View style={st.row}>
                {[6, 18, 60].map((m) => (
                  <Chip key={m} title={`${m} m`} selected={false} onPress={() => { userEdited.current = true; gps.simulate({ latitude: baseFix.latitude, longitude: baseFix.longitude, accuracy: m }); }} />
                ))}
                <Chip title="Point: Osogbo" selected={false} onPress={() => { userEdited.current = true; gps.simulate({ latitude: 7.77, longitude: 4.56, accuracy: 6 }); }} />
                <Chip title="Point: Ikorodu" selected={false} onPress={() => { userEdited.current = true; gps.simulate({ latitude: 6.62, longitude: 3.51, accuracy: 6 }); }} />
              </View>
            </View>
          )}
        </Card>

        <Card>
          <Label>Collection date</Label>
          <Button title={String(values.collection_date ?? 'Pick a date')} kind="secondary" onPress={() => setShowDate(true)} />
          {showDate && (
            <DateTimePicker
              value={values.collection_date ? new Date(`${values.collection_date}T12:00:00`) : new Date()}
              mode="date"
              maximumDate={new Date()}
              onChange={(_e, d) => {
                setShowDate(Platform.OS === 'ios');
                if (d) set({ collection_date: localIso(d) });
              }}
            />
          )}
          <Msgs field="collection_date" />

          <View style={{ height: 10 }} />
          <Label>Species</Label>
          <View style={st.row}>
            {SPECIES.map((x) => <Chip key={x} title={x} selected={values.species === x} onPress={() => set({ species: x })} />)}
          </View>
          <Msgs field="species" />

          <Label>Insecticide</Label>
          <View style={st.row}>
            {INSECTICIDES.map((x) => <Chip key={x} title={x} selected={values.insecticide === x} onPress={() => set({ insecticide: x })} />)}
          </View>
          <Msgs field="insecticide" />
        </Card>

        <Card>
          <Label>Number of mosquitoes exposed (1 to 500)</Label>
          <TextInput style={st.input} keyboardType="number-pad" value={raw.n_exposed} onChangeText={(t) => setNumber('n_exposed', t)} placeholder="e.g. 100" />
          <Msgs field="n_exposed" />
          <View style={{ height: 8 }} />
          <Label>Number dead</Label>
          <TextInput style={st.input} keyboardType="number-pad" value={raw.n_dead} onChangeText={(t) => setNumber('n_dead', t)} placeholder="e.g. 54" />
          <Msgs field="n_dead" />

          <View style={st.mort}>
            <Text style={{ color: C.muted }}>Mortality</Text>
            <Text style={st.mortValue} testID="mortality">{mortality === null ? '—' : `${mortality.toFixed(1)}%`}</Text>
            {who && <Badge text={who} tone={WHO_TONE[who]} />}
          </View>
        </Card>

        <Card>
          <Label>Larval density (larvae per dip)</Label>
          <TextInput style={st.input} keyboardType="number-pad" value={raw.larval_density} onChangeText={(t) => setNumber('larval_density', t)} placeholder="e.g. 6" />
          <Msgs field="larval_density" />

          <View style={st.switchRow}>
            <Text style={st.switchLabel}>Urban area</Text>
            <Switch value={values.urban === 1} onValueChange={(v) => set({ urban: v ? 1 : 0 })} />
          </View>
          <Msgs field="urban" />
          <View style={st.switchRow}>
            <Text style={st.switchLabel}>Indoor spraying (IRS) in the last 12 months</Text>
            <Switch value={values.irs_covered === 1} onValueChange={(v) => set({ irs_covered: v ? 1 : 0 })} />
          </View>
          <Msgs field="irs_covered" />

          <Label>Households reporting bed-net use (%)</Label>
          <TextInput style={st.input} keyboardType="decimal-pad" value={raw.itn_use_pct} onChangeText={(t) => setNumber('itn_use_pct', t)} placeholder="0 to 100" />
          <Msgs field="itn_use_pct" />
        </Card>

        <Button title={saving ? 'Saving…' : resubmitting ? 'Resubmit' : 'Save record'} onPress={onSave} disabled={saving} />
        <Text style={{ color: C.muted, marginTop: 8, textAlign: 'center' }}>
          {resubmitting ? 'The record keeps its ID; nothing else is re-entered.' : 'Saved records upload automatically when there is a connection.'}
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const st = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 10, paddingTop: 44, backgroundColor: C.card, borderBottomWidth: 1, borderBottomColor: C.border },
  title: { fontSize: 18, fontWeight: '700', color: C.text },
  row: { flexDirection: 'row', flexWrap: 'wrap' },
  input: { borderWidth: 1, borderColor: C.border, borderRadius: 8, paddingHorizontal: 12, minHeight: 48, fontSize: 18, color: C.text, backgroundColor: '#fff' },
  coords: { fontSize: 20, fontWeight: '700', color: C.text, marginBottom: 4 },
  mort: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 14, padding: 12, backgroundColor: C.bg, borderRadius: 8 },
  mortValue: { fontSize: 28, fontWeight: '800', color: C.text },
  switchRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginVertical: 8 },
  switchLabel: { flex: 1, fontSize: 15, color: C.text, paddingRight: 10 },
  tools: { marginTop: 12, padding: 8, borderWidth: 1, borderStyle: 'dashed', borderColor: C.border, borderRadius: 8 },
});
