import React from 'react';
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

// High-contrast colours: the app is used outdoors in strong sunlight.
export const C = {
  bg: '#f3f5f8', card: '#ffffff', text: '#14202e', muted: '#556275', border: '#c9d1dc', primary: '#1f3864',
  ok: '#1d6b3a', okBg: '#e2f4e8', warn: '#8a5300', warnBg: '#fff1d6', bad: '#a31d1d', badBg: '#fde7e7',
  info: '#1f4b7a', infoBg: '#e3edf9',
};

export function Card({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[s.card, style]}>{children}</View>;
}

export function Label({ children }: { children: React.ReactNode }) {
  return <Text style={s.label}>{children}</Text>;
}

export function Button({
  title, onPress, kind = 'primary', disabled, small,
}: { title: string; onPress: () => void; kind?: 'primary' | 'secondary' | 'danger'; disabled?: boolean; small?: boolean }) {
  const bg = kind === 'primary' ? C.primary : kind === 'danger' ? C.bad : C.card;
  const fg = kind === 'secondary' ? C.primary : '#fff';
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        s.btn, small && s.btnSmall,
        { backgroundColor: bg, borderColor: kind === 'secondary' ? C.primary : bg, opacity: disabled ? 0.45 : pressed ? 0.8 : 1 },
      ]}
    >
      <Text style={[s.btnText, { color: fg }, small && { fontSize: 14 }]}>{title}</Text>
    </Pressable>
  );
}

export function Chip({ title, selected, onPress, disabled }: { title: string; selected: boolean; onPress: () => void; disabled?: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected, disabled }}
      onPress={onPress}
      disabled={disabled}
      style={[s.chip, selected && s.chipOn, disabled && { opacity: 0.4 }]}
    >
      <Text style={[s.chipText, selected && { color: '#fff' }]}>{title}</Text>
    </Pressable>
  );
}

export function Badge({ text, tone }: { text: string; tone: 'ok' | 'warn' | 'bad' | 'info' | 'muted' }) {
  const map = {
    ok: [C.okBg, C.ok], warn: [C.warnBg, C.warn], bad: [C.badBg, C.bad], info: [C.infoBg, C.info], muted: ['#e6e9ee', C.muted],
  } as const;
  return (
    <View style={[s.badge, { backgroundColor: map[tone][0] }]}>
      <Text style={{ color: map[tone][1], fontWeight: '700', fontSize: 12 }}>{text}</Text>
    </View>
  );
}

/** A message tied to a field: Block problems in red, Warn flags in amber. */
export function Message({ tone, children }: { tone: 'bad' | 'warn'; children: React.ReactNode }) {
  return (
    <View style={[s.msg, { backgroundColor: tone === 'bad' ? C.badBg : C.warnBg }]}>
      <Text style={{ color: tone === 'bad' ? C.bad : C.warn, fontSize: 14 }}>{children}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  card: { backgroundColor: C.card, borderRadius: 10, padding: 14, marginBottom: 12, borderWidth: 1, borderColor: C.border },
  label: { fontSize: 14, fontWeight: '600', color: C.text, marginBottom: 6 },
  btn: { minHeight: 48, paddingHorizontal: 16, borderRadius: 8, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  btnSmall: { minHeight: 38, paddingHorizontal: 12 },
  btnText: { fontSize: 16, fontWeight: '700' },
  chip: { minHeight: 42, paddingHorizontal: 12, borderRadius: 21, borderWidth: 1, borderColor: C.border, backgroundColor: C.card, justifyContent: 'center', marginRight: 8, marginBottom: 8 },
  chipOn: { backgroundColor: C.primary, borderColor: C.primary },
  chipText: { color: C.text, fontSize: 15 },
  badge: { alignSelf: 'flex-start', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999 },
  msg: { padding: 8, borderRadius: 6, marginTop: 6 },
});
