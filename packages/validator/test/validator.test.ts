import { describe, expect, it } from 'vitest';
import { haversineKm, mortalityPct, round1, validateRecord, whoClass, type RecordInput } from '../src';

const REF = '2026-10-08';
const good: RecordInput = {
  record_id: 'a',
  state: 'Osun',
  lga: 'Osogbo',
  ward: 'Osogbo Ward 2',
  latitude: 7.77,
  longitude: 4.56,
  gps_accuracy_m: 6,
  collection_date: '2026-10-07',
  species: 'An. gambiae s.s.',
  insecticide: 'Permethrin',
  n_exposed: 100,
  n_dead: 54,
  larval_density: 6,
  urban: 1,
  irs_covered: 0,
  itn_use_pct: 61.5,
};
const dev = (r: RecordInput, extra = {}) => validateRecord(r, { scope: 'device', refDate: REF, appRecord: true, ...extra });
const srv = (r: RecordInput, extra = {}) => validateRecord(r, { scope: 'server', refDate: REF, appRecord: true, ...extra });
const rules = (xs: { rule: string }[]) => xs.map((x) => x.rule);

describe('WHO class and mortality', () => {
  it.each([
    [89.9, 'Resistant'],
    [90.0, 'Possible resistance'],
    [97.9, 'Possible resistance'],
    [98.0, 'Susceptible'],
    [100, 'Susceptible'],
    [50, 'Resistant'],
    [89.5, 'Resistant'],
    [97.5, 'Possible resistance'],
  ])('%s is %s', (m, cls) => expect(whoClass(m)).toBe(cls));

  it('rounds to 1 decimal before classifying', () => {
    expect(mortalityPct(54, 100)).toBe(54);
    expect(mortalityPct(69, 75)).toBe(92);
    expect(mortalityPct(1, 3)).toBe(33.3);
    expect(round1(6.25)).toBe(6.2); // R rounds an exact tie to even
    expect(mortalityPct(0, 0)).toBeNull();
    expect(mortalityPct(null, 10)).toBeNull();
  });
});

describe('haversine', () => {
  it('is zero for the same point and about 111 km per degree of latitude', () => {
    expect(haversineKm(7, 4, 7, 4)).toBe(0);
    expect(haversineKm(7, 4, 8, 4)).toBeCloseTo(111.19, 1);
  });
});

describe('a clean record', () => {
  it('has no errors or flags and is enrichment pending', () => {
    const r = dev(good);
    expect(r.errors).toEqual([]);
    expect(r.flags).toEqual([]);
    expect(r.enrichmentPending).toBe(true);
    expect(srv(good).errors).toEqual([]);
  });
});

describe('GPS accuracy edges (10, 10.1, 50, 50.1 m)', () => {
  it.each([
    [6, [], []],
    [10, [], []],
    [10.1, [], ['GPS_accuracy_poor']],
    [18, [], ['GPS_accuracy_poor']],
    [50, [], ['GPS_accuracy_poor']],
    [50.1, ['GPS_accuracy_unusable'], []],
    [60, ['GPS_accuracy_unusable'], []],
  ])('accuracy %s m', (acc, errs, flgs) => {
    for (const run of [dev, srv]) {
      const r = run({ ...good, gps_accuracy_m: acc });
      expect(rules(r.errors)).toEqual(errs);
      expect(rules(r.flags)).toEqual(flgs);
    }
  });

  it('no accuracy from the phone blocks on the device', () => {
    expect(rules(dev({ ...good, gps_accuracy_m: null }).errors)).toEqual(['GPS_accuracy_unusable']);
  });

  it('server skips the rule when the field is not sent, but blocks an explicit null', () => {
    const { gps_accuracy_m: _drop, ...noAcc } = good;
    expect(srv(noAcc).errors).toEqual([]);
    expect(rules(srv({ ...good, gps_accuracy_m: null }).errors)).toEqual(['GPS_accuracy_unusable']);
  });
});

describe('location rules', () => {
  it('Ife Central with a point in Osogbo warns (not blocks)', () => {
    const r = dev({ ...good, lga: 'Ife Central', ward: 'Ife Central Ward 1' });
    expect(r.errors).toEqual([]);
    expect(rules(r.flags)).toEqual(['GPS_far_from_lga']);
    expect(r.flags[0].message).toMatch(/km from Ife Central\. Check the LGA, or recapture the location/);
    expect(r.flags[0].field).toBe('lga');
  });

  it('outside Nigeria, 0,0 and wrong state block', () => {
    expect(rules(dev({ ...good, latitude: 51.5, longitude: -0.1 }).errors)).toContain('GPS_outside_nigeria');
    expect(rules(dev({ ...good, latitude: 0, longitude: 0 }).errors)).toEqual(
      expect.arrayContaining(['GPS_zero_zero', 'GPS_outside_nigeria', 'GPS_state_mismatch']),
    );
    expect(rules(dev({ ...good, state: 'Kano', lga: 'Dala', ward: 'Dala Ward 1' }).errors)).toContain('GPS_state_mismatch');
  });

  it('bounding boxes are inclusive', () => {
    expect(rules(dev({ ...good, latitude: 7.0, longitude: 4.0 }).errors)).not.toContain('GPS_state_mismatch');
    expect(rules(dev({ ...good, latitude: 8.2000001 }).errors)).toContain('GPS_state_mismatch');
  });

  it('unknown state blocks with a fix hint', () => {
    const r = dev({ ...good, state: 'Ogun' });
    expect(r.errors.find((e) => e.rule === 'GPS_state_mismatch')?.message).toMatch(/Pick the state/);
  });
});

describe('count, date and missing rules', () => {
  it('n_dead > n_exposed has the contract message and field', () => {
    const r = dev({ ...good, n_exposed: 100, n_dead: 120 });
    expect(r.errors).toEqual([
      {
        rule: 'n_dead_gt_n_exposed',
        field: 'n_dead',
        severity: 'block',
        message: 'n_dead (120) is more than n_exposed (100). Correct the number of dead mosquitoes.',
      },
    ]);
  });

  it('future date blocks, today is fine', () => {
    expect(rules(dev({ ...good, collection_date: '2026-10-09' }).errors)).toEqual(['future_date']);
    expect(dev({ ...good, collection_date: '2026-10-08' }).errors).toEqual([]);
  });

  it('missing species / itn_use_pct block as missing_core on the device', () => {
    const r = dev({ ...good, species: '', itn_use_pct: null });
    expect(r.errors.map((e) => [e.rule, e.field])).toEqual([
      ['missing_core', 'species'],
      ['missing_core', 'itn_use_pct'],
    ]);
  });

  it('missing ndvi/rainfall is enrichment pending for app records but an error for dataset rows', () => {
    expect(srv(good).enrichmentPending).toBe(true);
    const r = validateRecord(good, { scope: 'server', refDate: REF });
    expect(rules(r.errors)).toEqual(['missing_core', 'missing_core']);
  });

  it('missing values never fire comparison rules', () => {
    const r = srv({ ...good, temp_c: null, slide_positivity_pct: undefined, rainfall_mm: '' });
    expect(rules(r.errors)).toEqual([]);
  });

  it('server-only rules fire on the server only', () => {
    const bad = { ...good, temp_c: 51, rainfall_mm: 1501, slide_positivity_pct: 101, ndvi: 0.5 };
    expect(dev(bad).errors).toEqual([]);
    expect(rules(srv(bad).errors).sort()).toEqual(['positivity_out_range', 'rainfall_implausible', 'temp_implausible']);
    const low = { ...good, temp_c: 9.9, ndvi: 0.5, rainfall_mm: 0, slide_positivity_pct: -1 };
    expect(rules(srv(low).errors).sort()).toEqual(['positivity_out_range', 'temp_implausible']);
  });

  it('duplicate is a warning supplied by the caller', () => {
    const r = dev(good, { isDuplicate: true });
    expect(r.errors).toEqual([]);
    expect(rules(r.flags)).toEqual(['duplicate']);
  });
});

describe('form field rules (mirror the database CHECKs)', () => {
  it.each([
    [{ n_exposed: 0 }, 'n_exposed'],
    [{ n_exposed: 501 }, 'n_exposed'],
    [{ n_exposed: 10.5 }, 'n_exposed'],
    [{ n_dead: -1 }, 'n_dead'],
    [{ larval_density: -2 }, 'larval_density'],
    [{ itn_use_pct: 100.5 }, 'itn_use_pct'],
    [{ species: 'An. unknown' }, 'species'],
    [{ insecticide: 'DDT' }, 'insecticide'],
    [{ lga: 'Dala' }, 'lga'],
    [{ ward: 'Osogbo Ward 7' }, 'ward'],
    [{ urban: 2 }, 'urban'],
    [{ state: null }, 'state'],
    [{ latitude: null }, 'latitude'],
  ] as [Partial<RecordInput>, string][])('%j blocks on %s', (patch, field) => {
    const r = dev({ ...good, ...patch });
    expect(r.errors.some((e) => e.field === field)).toBe(true);
  });
});
