import { describe, expect, it } from 'vitest';
import { GPS_WAIT_MS, betterFix, gpsStatus, type GpsFix } from '../src';

const fix = (accuracy: number | null): GpsFix => ({ latitude: 7.77, longitude: 4.56, accuracy });

describe('gpsStatus with simulated fixes of 6 m, 18 m and 60 m', () => {
  it('6 m is accepted at once and the search stops', () => {
    expect(gpsStatus(fix(6), 0)).toMatchObject({ phase: 'accepted', keepTrying: false, canSave: true });
  });

  it('18 m shows a warning, keeps trying for 60 s, and can still be saved', () => {
    const early = gpsStatus(fix(18), 5_000);
    expect(early).toMatchObject({ phase: 'improving', keepTrying: true, canSave: true });
    expect(early.message).toContain('Waiting for a better GPS signal. Move to open sky.');
    const late = gpsStatus(fix(18), GPS_WAIT_MS);
    expect(late).toMatchObject({ phase: 'poor', keepTrying: false, canSave: true });
    expect(late.message).toContain('GPS warning');
  });

  it('60 m cannot be saved', () => {
    const s = gpsStatus(fix(60), 1_000);
    expect(s).toMatchObject({ phase: 'unusable', canSave: false });
    expect(s.message).toMatch(/cannot be saved.*open sky/);
  });
});

describe('accuracy edges', () => {
  it.each([
    [10, 'accepted', true],
    [10.1, 'improving', true],
    [50, 'improving', true],
    [50.1, 'unusable', false],
  ])('%s m', (acc, phase, canSave) => {
    expect(gpsStatus(fix(acc), 0)).toMatchObject({ phase, canSave });
  });

  it('a fix with no accuracy value cannot be saved', () => {
    expect(gpsStatus(fix(null), 0)).toMatchObject({ phase: 'unusable', canSave: false });
  });

  it('no fix yet: nothing to save, keeps trying until the window ends', () => {
    expect(gpsStatus(null, 0)).toMatchObject({ phase: 'none', keepTrying: true, canSave: false });
    expect(gpsStatus(null, GPS_WAIT_MS).keepTrying).toBe(false);
  });
});

describe('betterFix', () => {
  it('keeps the most accurate reading', () => {
    expect(betterFix(null, fix(30))?.accuracy).toBe(30);
    expect(betterFix(fix(30), fix(12))?.accuracy).toBe(12);
    expect(betterFix(fix(12), fix(30))?.accuracy).toBe(12);
    expect(betterFix(fix(12), fix(null))?.accuracy).toBe(12);
    expect(betterFix(fix(null), fix(40))?.accuracy).toBe(40);
  });
});
