import {
  GPS_TARGET_M,
  GPS_UNUSABLE_M,
  INSECTICIDES,
  LGAS,
  LGA_MAX_KM,
  LGA_REF,
  NIGERIA,
  SPECIES,
  STATE_BOX,
} from './constants';
import { haversineKm } from './geo';

export type Severity = 'block' | 'warn';

/** One problem found in a record. `field` is the form field the message is about. */
export interface Issue {
  rule: string;
  field: string;
  severity: Severity;
  message: string;
}

/** A record as the app, the API or a CSV row provides it. Any field may be missing. */
export interface RecordInput {
  record_id?: string | null;
  state?: string | null;
  lga?: string | null;
  ward?: string | null;
  latitude?: number | string | null;
  longitude?: number | string | null;
  gps_accuracy_m?: number | string | null;
  collection_date?: string | null;
  species?: string | null;
  insecticide?: string | null;
  n_exposed?: number | string | null;
  n_dead?: number | string | null;
  larval_density?: number | string | null;
  urban?: number | string | null;
  irs_covered?: number | string | null;
  itn_use_pct?: number | string | null;
  // Added by the server for app records; present in the research dataset
  rainfall_mm?: number | string | null;
  temp_c?: number | string | null;
  ndvi?: number | string | null;
  slide_positivity_pct?: number | string | null;
}

export type Scope = 'device' | 'server';

export interface RuleDef {
  id: string;
  severity: Severity;
  device: boolean;
  server: boolean;
  /** true when the rule is a column of outputs/validation_flags_all.csv (parity test) */
  inR: boolean;
}

// Table from docs/validation_rules.md
export const RULES: RuleDef[] = [
  { id: 'GPS_outside_nigeria', severity: 'block', device: true, server: true, inR: true },
  { id: 'GPS_zero_zero', severity: 'block', device: true, server: true, inR: true },
  { id: 'GPS_state_mismatch', severity: 'block', device: true, server: true, inR: true },
  { id: 'GPS_far_from_lga', severity: 'warn', device: true, server: true, inR: true },
  { id: 'GPS_accuracy_poor', severity: 'warn', device: true, server: true, inR: false },
  { id: 'GPS_accuracy_unusable', severity: 'block', device: true, server: true, inR: false },
  { id: 'n_dead_gt_n_exposed', severity: 'block', device: true, server: true, inR: true },
  { id: 'positivity_out_range', severity: 'block', device: false, server: true, inR: true },
  { id: 'future_date', severity: 'block', device: true, server: true, inR: true },
  { id: 'temp_implausible', severity: 'block', device: false, server: true, inR: true },
  { id: 'rainfall_implausible', severity: 'block', device: false, server: true, inR: true },
  { id: 'duplicate', severity: 'warn', device: true, server: true, inR: true },
  { id: 'missing_core', severity: 'block', device: true, server: true, inR: true },
];

/** The 11 rules compared in the parity test, in the column order of validation_flags_all.csv. */
export const R_RULE_IDS = [
  'GPS_outside_nigeria',
  'GPS_zero_zero',
  'GPS_state_mismatch',
  'GPS_far_from_lga',
  'n_dead_gt_n_exposed',
  'positivity_out_range',
  'future_date',
  'temp_implausible',
  'rainfall_implausible',
  'duplicate',
  'missing_core',
] as const;
export type RRuleId = (typeof R_RULE_IDS)[number];

// ---------------------------------------------------------------------------
// Missing values and three-valued logic (R's NA rules)
// ---------------------------------------------------------------------------

/** "Missing" means null, undefined, an empty string or something that is not a number. */
export function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') {
    if (v.trim() === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function text(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v);
  return s.trim() === '' ? null : s;
}

type Tri = boolean | null; // null = unknown (R's NA)
const and = (a: Tri, b: Tri): Tri => (a === false || b === false ? false : a === null || b === null ? null : true);
const or = (a: Tri, b: Tri): Tri => (a === true || b === true ? true : a === null || b === null ? null : false);
const not = (a: Tri): Tri => (a === null ? null : !a);
const ge = (x: number | null, y: number): Tri => (x === null ? null : x >= y);
const le = (x: number | null, y: number): Tri => (x === null ? null : x <= y);
const gt = (x: number | null, y: number | null): Tri => (x === null || y === null ? null : x > y);
const lt = (x: number | null, y: number): Tri => (x === null ? null : x < y);
const inRange = (x: number | null, lo: number, hi: number): Tri => and(ge(x, lo), le(x, hi));

// ---------------------------------------------------------------------------
// Rule predicates. Each returns true when the rule fires. An unknown (NA) result
// never fires, exactly like na_false() in R/helpers.R.
// ---------------------------------------------------------------------------

export interface Context {
  /** ISO date YYYY-MM-DD. The parity test uses 2026-10-08; the app/API use today. */
  refDate: string;
  /** Result of the duplicate check (needs the other records, so the caller supplies it). */
  isDuplicate?: boolean;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function distanceToLgaKm(rec: RecordInput): number | null {
  const ref = LGA_REF[`${text(rec.state)}|${text(rec.lga)}`];
  const lat = num(rec.latitude);
  const lon = num(rec.longitude);
  if (!ref || lat === null || lon === null) return null;
  return haversineKm(lat, lon, ref.lat, ref.lon);
}

export const PREDICATES: Record<RRuleId, (r: RecordInput, c: Context) => boolean> = {
  GPS_outside_nigeria(r) {
    const lat = num(r.latitude);
    const lon = num(r.longitude);
    const inside = and(inRange(lat, NIGERIA.latMin, NIGERIA.latMax), inRange(lon, NIGERIA.lonMin, NIGERIA.lonMax));
    return not(inside) === true;
  },
  GPS_zero_zero(r) {
    const lat = num(r.latitude);
    const lon = num(r.longitude);
    return and(lat === null ? null : lat === 0, lon === null ? null : lon === 0) === true;
  },
  GPS_state_mismatch(r) {
    const box = STATE_BOX[text(r.state) ?? ''];
    if (!box) return true; // unknown state
    const lat = num(r.latitude);
    const lon = num(r.longitude);
    const inside = and(inRange(lat, box.latMin, box.latMax), inRange(lon, box.lonMin, box.lonMax));
    return not(inside) === true;
  },
  GPS_far_from_lga(r) {
    if (!LGA_REF[`${text(r.state)}|${text(r.lga)}`]) return true; // unknown LGA
    const d = distanceToLgaKm(r);
    return d !== null && d > LGA_MAX_KM;
  },
  n_dead_gt_n_exposed(r) {
    return gt(num(r.n_dead), num(r.n_exposed)) === true;
  },
  positivity_out_range(r) {
    const p = num(r.slide_positivity_pct);
    return or(lt(p, 0), gt(p, 100)) === true;
  },
  future_date(r, c) {
    const d = text(r.collection_date);
    return d !== null && ISO_DATE.test(d) && d > c.refDate;
  },
  temp_implausible(r) {
    const t = num(r.temp_c);
    return or(lt(t, 10), gt(t, 50)) === true;
  },
  rainfall_implausible(r) {
    const x = num(r.rainfall_mm);
    return or(lt(x, 0), gt(x, 1500)) === true;
  },
  duplicate(_r, c) {
    return c.isDuplicate === true;
  },
  missing_core(r) {
    return num(r.ndvi) === null || num(r.rainfall_mm) === null || num(r.itn_use_pct) === null || text(r.species) === null;
  },
};

// ---------------------------------------------------------------------------
// Duplicates
// ---------------------------------------------------------------------------

/** Same ward, date, species, insecticide, n_exposed and n_dead (R: paste of the six columns). */
export function duplicateKey(r: RecordInput): string {
  const part = (v: string | null) => (v === null ? 'NA' : v);
  const n = (v: unknown) => {
    const x = num(v);
    return x === null ? 'NA' : String(x);
  };
  return [
    part(text(r.ward)),
    part(text(r.collection_date)),
    part(text(r.species)),
    part(text(r.insecticide)),
    n(r.n_exposed),
    n(r.n_dead),
  ].join('\u0001');
}

// ---------------------------------------------------------------------------
// Parity: flags for a whole list of records (used by the parity test and the seed)
// ---------------------------------------------------------------------------

export type FlagRow = { record_id: string } & Record<RRuleId, boolean> & { any_flag: boolean };

/**
 * Computes the 11 R-rule flags for every record. Within a group of duplicates the record
 * with the smallest record_id is kept; later ones are flagged (as in R: order(record_id)).
 */
export function computeFlags(records: RecordInput[], refDate: string): FlagRow[] {
  const order = records.map((_, i) => i).sort((a, b) => {
    const x = String(records[a].record_id ?? '');
    const y = String(records[b].record_id ?? '');
    return x < y ? -1 : x > y ? 1 : a - b;
  });
  const seen = new Set<string>();
  const isDup = new Array<boolean>(records.length).fill(false);
  for (const i of order) {
    const k = duplicateKey(records[i]);
    if (seen.has(k)) isDup[i] = true;
    else seen.add(k);
  }
  return records.map((r, i) => {
    const ctx: Context = { refDate, isDuplicate: isDup[i] };
    const row: Record<string, boolean | string> = { record_id: String(r.record_id ?? '') };
    let any = false;
    for (const id of R_RULE_IDS) {
      const v = PREDICATES[id](r, ctx);
      row[id] = v;
      any = any || v;
    }
    row.any_flag = any;
    return row as FlagRow;
  });
}

// ---------------------------------------------------------------------------
// Validation of one record for the device or the server, with messages
// ---------------------------------------------------------------------------

export interface ValidateOptions {
  scope: Scope;
  refDate: string;
  /** Another saved record has the same duplicate key (device: on the phone; server: in the database). */
  isDuplicate?: boolean;
  /**
   * Record comes from the app: ndvi and rainfall_mm are added later by the server, so their absence
   * is `enrichmentPending`, not an error. Leave false for the research dataset (parity test).
   */
  appRecord?: boolean;
}

export interface ValidationResult {
  /** Block rules that fired: the record cannot be saved / is rejected. */
  errors: Issue[];
  /** Warn rules that fired: the record can be saved and syncs with the flag attached. */
  flags: Issue[];
  enrichmentPending: boolean;
}

const REQUIRED_FIELDS: { field: keyof RecordInput; label: string }[] = [
  { field: 'state', label: 'State' },
  { field: 'lga', label: 'LGA' },
  { field: 'ward', label: 'Ward' },
  { field: 'latitude', label: 'Latitude' },
  { field: 'longitude', label: 'Longitude' },
  { field: 'collection_date', label: 'Collection date' },
  { field: 'insecticide', label: 'Insecticide' },
  { field: 'n_exposed', label: 'Number exposed' },
  { field: 'n_dead', label: 'Number dead' },
  { field: 'larval_density', label: 'Larval density' },
  { field: 'urban', label: 'Urban' },
  { field: 'irs_covered', label: 'IRS covered' },
];

function block(rule: string, field: string, message: string): Issue {
  return { rule, field, severity: 'block', message };
}
function warn(rule: string, field: string, message: string): Issue {
  return { rule, field, severity: 'warn', message };
}

function isInt(v: number | null): boolean {
  return v !== null && Number.isInteger(v);
}

/** Field-level form rules (required values, allowed values, ranges). They mirror the database CHECKs. */
function formIssues(r: RecordInput): Issue[] {
  const out: Issue[] = [];
  for (const { field, label } of REQUIRED_FIELDS) {
    const v = r[field];
    const missing = field === 'latitude' || field === 'longitude' || field === 'n_exposed' || field === 'n_dead' ||
      field === 'larval_density' || field === 'urban' || field === 'irs_covered' ? num(v) === null : text(v) === null;
    if (missing) out.push(block('required_field', field, `${label} is required. Fill it in before saving.`));
  }
  const state = text(r.state);
  const lga = text(r.lga);
  if (state !== null && !LGAS[state]) {
    out.push(block('invalid_value', 'state', `State "${state}" is not one of Lagos, Kano or Osun. Pick a state from the list.`));
  } else if (state !== null && lga !== null && !LGAS[state].includes(lga)) {
    out.push(block('invalid_value', 'lga', `${lga} is not an LGA of ${state}. Pick an LGA from the list for ${state}.`));
  }
  const ward = text(r.ward);
  if (ward !== null && lga !== null && !new RegExp(`^${lga.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} Ward [1-6]$`).test(ward)) {
    out.push(block('invalid_value', 'ward', `Ward "${ward}" is not valid for ${lga}. Pick one of "${lga} Ward 1" to "${lga} Ward 6".`));
  }
  const sp = text(r.species);
  if (sp !== null && !(SPECIES as readonly string[]).includes(sp)) {
    out.push(block('invalid_value', 'species', `Species "${sp}" is not on the list. Pick a species from the list.`));
  }
  const ins = text(r.insecticide);
  if (ins !== null && !(INSECTICIDES as readonly string[]).includes(ins)) {
    out.push(block('invalid_value', 'insecticide', `Insecticide "${ins}" is not on the list. Pick an insecticide from the list.`));
  }
  const date = text(r.collection_date);
  if (date !== null && (!ISO_DATE.test(date) || Number.isNaN(Date.parse(date)))) {
    out.push(block('invalid_value', 'collection_date', `Collection date "${date}" is not a valid date. Use the date picker (YYYY-MM-DD).`));
  }
  const ne = num(r.n_exposed);
  if (ne !== null && (!isInt(ne) || ne < 1 || ne > 500)) {
    out.push(block('out_of_range', 'n_exposed', `Number exposed (${ne}) must be a whole number from 1 to 500. Check the tube count.`));
  }
  const nd = num(r.n_dead);
  if (nd !== null && (!isInt(nd) || nd < 0)) {
    out.push(block('out_of_range', 'n_dead', `Number dead (${nd}) must be a whole number, 0 or more. Check the count.`));
  }
  const ld = num(r.larval_density);
  if (ld !== null && (!isInt(ld) || ld < 0)) {
    out.push(block('out_of_range', 'larval_density', `Larval density (${ld}) must be a whole number, 0 or more.`));
  }
  const itn = num(r.itn_use_pct);
  if (itn !== null && (itn < 0 || itn > 100)) {
    out.push(block('out_of_range', 'itn_use_pct', `Bed-net use (${itn}%) must be between 0 and 100. Check the percentage.`));
  }
  for (const f of ['urban', 'irs_covered'] as const) {
    const v = num(r[f]);
    if (v !== null && v !== 0 && v !== 1) out.push(block('invalid_value', f, `${f} must be 0 (no) or 1 (yes).`));
  }
  return out;
}

export function validateRecord(r: RecordInput, opts: ValidateOptions): ValidationResult {
  const { scope, refDate } = opts;
  const ctx: Context = { refDate, isDuplicate: opts.isDuplicate };
  const errors: Issue[] = [];
  const flags: Issue[] = [];
  let enrichmentPending = false;

  errors.push(...formIssues(r));

  const lat = num(r.latitude);
  const lon = num(r.longitude);
  const state = text(r.state);
  const lga = text(r.lga);

  if (PREDICATES.GPS_outside_nigeria(r, ctx)) {
    errors.push(block('GPS_outside_nigeria', 'latitude',
      `The GPS point (${lat}, ${lon}) is outside Nigeria. Check that phone location is on and recapture the location outdoors.`));
  }
  if (PREDICATES.GPS_zero_zero(r, ctx)) {
    errors.push(block('GPS_zero_zero', 'latitude',
      'The GPS point is 0, 0, which means the phone had no fix. Move to open sky and recapture the location.'));
  }
  if (PREDICATES.GPS_state_mismatch(r, ctx)) {
    errors.push(block('GPS_state_mismatch', 'state', state && STATE_BOX[state]
      ? `The GPS point (${lat}, ${lon}) is not inside ${state}. Correct the state, or recapture the location.`
      : `State "${state ?? ''}" is not a pilot state (Lagos, Kano or Osun). Pick the state from the list.`));
  }
  if (PREDICATES.GPS_far_from_lga(r, ctx)) {
    const d = distanceToLgaKm(r);
    flags.push(warn('GPS_far_from_lga', 'lga', d === null
      ? `LGA "${lga ?? ''}" is not recognised for ${state ?? 'this state'}. Pick the LGA from the list.`
      : `Your location is ${Math.round(d)} km from ${lga}. Check the LGA, or recapture the location.`));
  }

  // Accuracy: on the server only "when the field is sent" (undefined = not sent)
  if (scope === 'device' || r.gps_accuracy_m !== undefined) {
    const acc = num(r.gps_accuracy_m);
    if (acc === null || acc > GPS_UNUSABLE_M) {
      errors.push(block('GPS_accuracy_unusable', 'gps_accuracy_m', acc === null
        ? 'The phone gave no GPS accuracy value. Move to open sky and recapture the location.'
        : `GPS accuracy is ${acc} m, which is worse than ${GPS_UNUSABLE_M} m. Move to open sky and recapture the location.`));
    } else if (acc > GPS_TARGET_M) {
      flags.push(warn('GPS_accuracy_poor', 'gps_accuracy_m',
        `GPS accuracy is ${acc} m (target ${GPS_TARGET_M} m or better). You can save, or move to open sky and recapture.`));
    }
  }

  if (PREDICATES.n_dead_gt_n_exposed(r, ctx)) {
    errors.push(block('n_dead_gt_n_exposed', 'n_dead',
      `n_dead (${num(r.n_dead)}) is more than n_exposed (${num(r.n_exposed)}). Correct the number of dead mosquitoes.`));
  }
  if (PREDICATES.future_date(r, ctx)) {
    errors.push(block('future_date', 'collection_date',
      `Collection date ${text(r.collection_date)} is in the future. Set the date to today or earlier.`));
  }
  if (PREDICATES.duplicate(r, ctx)) {
    flags.push(warn('duplicate', 'ward',
      'Another record has the same ward, date, species, insecticide and counts. If this is a repeat entry, discard it.'));
  }

  // missing_core: itn_use_pct and species are on the form (Block). ndvi/rainfall are added by the server.
  if (text(r.species) === null) {
    errors.push(block('missing_core', 'species', 'Species is required. Pick the mosquito species before saving.'));
  }
  if (num(r.itn_use_pct) === null) {
    errors.push(block('missing_core', 'itn_use_pct', 'Bed-net use (%) is required. Enter a number from 0 to 100.'));
  }
  if (num(r.ndvi) === null || num(r.rainfall_mm) === null) {
    if (opts.appRecord) enrichmentPending = true;
    else if (scope === 'server') {
      for (const f of ['ndvi', 'rainfall_mm'] as const) {
        if (num(r[f]) === null) {
          errors.push(block('missing_core', f, `${f} is missing. It is needed for the risk model.`));
        }
      }
    }
  }

  if (scope === 'server') {
    if (PREDICATES.positivity_out_range(r, ctx)) {
      errors.push(block('positivity_out_range', 'slide_positivity_pct',
        `Slide positivity (${num(r.slide_positivity_pct)}%) must be between 0 and 100. Correct the value.`));
    }
    if (PREDICATES.temp_implausible(r, ctx)) {
      errors.push(block('temp_implausible', 'temp_c',
        `Temperature (${num(r.temp_c)} °C) is outside 10 to 50 °C. Correct the value.`));
    }
    if (PREDICATES.rainfall_implausible(r, ctx)) {
      errors.push(block('rainfall_implausible', 'rainfall_mm',
        `Rainfall (${num(r.rainfall_mm)} mm) is outside 0 to 1500 mm. Correct the value.`));
    }
  }

  return { errors, flags, enrichmentPending };
}
