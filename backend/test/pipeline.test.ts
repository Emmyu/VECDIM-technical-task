// Unit tests for the parts of the analysis pipeline that need no database and no R.
import { describe, expect, it } from 'vitest';
import {
  INPUT_COLUMNS, PipelineRunner, RULE_COLUMNS, lagosToday, parseAlerts, parseFlags, parseRisks, rowsToCsv, type RunResult,
} from '../src/pipeline';
import { datasetRow } from '../src/seed';

const result = (id = 1): RunResult => ({
  run_id: id, status: 'succeeded', n_input: 0, n_dataset: 0, n_app: 0, n_flagged: 0, n_clean: 0, n_alerts: 0, alert_counts: {}, duration_ms: 1,
});

describe('CSV given to R', () => {
  it('uses the pack\'s column order and writes missing values as NA, which is what R reads as missing', () => {
    const csv = rowsToCsv([{ record_id: 'a', state: 'Osun', ndvi: null, rainfall_mm: undefined, latitude: 7.5, ward: 'Osogbo, Ward 2' }]);
    const [header, line] = csv.trim().split('\n');
    expect(header).toBe(INPUT_COLUMNS.join(','));
    const cells = line.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/); // split on commas outside quotes
    expect(cells[header.split(',').indexOf('ndvi')]).toBe('NA');
    expect(cells[header.split(',').indexOf('rainfall_mm')]).toBe('NA');
    expect(cells[header.split(',').indexOf('latitude')]).toBe('7.5');
    expect(cells[header.split(',').indexOf('ward')]).toBe('"Osogbo, Ward 2"');
  });

  it('turns the dataset\'s own NA cells into nulls without judging or fixing any value', () => {
    const row = datasetRow({ record_id: 'VD1', state: 'Lagos', species: 'NA', itn_use_pct: 'NA', latitude: '0', n_dead: '120', n_exposed: '100' } as never);
    expect(row.species).toBeNull();
    expect(row.itn_use_pct).toBeNull();
    expect(row.latitude).toBe(0);      // a bad GPS value is kept: finding it is R's job
    expect(row.n_dead).toBe(120);      // so is dead > exposed
  });
});

describe('what R wrote', () => {
  it('reads the validation flags: TRUE/FALSE per rule and any_flag', () => {
    const header = ['record_id', ...RULE_COLUMNS, 'any_flag'].map((h) => `"${h}"`).join(',');
    const falses = RULE_COLUMNS.map(() => 'FALSE');
    const dup = RULE_COLUMNS.map((r) => (r === 'duplicate' ? 'TRUE' : 'FALSE'));
    const flags = parseFlags([header, `"VD1",${falses.join(',')},FALSE`, `"VD2",${dup.join(',')},TRUE`].join('\n'));
    expect(flags[0]).toMatchObject({ record_id: 'VD1', any_flag: false });
    expect(flags[1].any_flag).toBe(true);
    expect(flags[1].rules.duplicate).toBe(true);
    expect(flags[1].rules.missing_core).toBe(false);
  });

  it('reads the alerts: id is State|LGA|YYYY-MM, NA pyrethroid mortality is null, the flag is a boolean', () => {
    const csv = [
      '"state","lga","ym","n","mean_p_high","mean_pyrethroid_mort","alert","pyrethroid_resistance_flag"',
      '"Kano","Dala","2022-05",1,0.108,NA,"WATCH",FALSE',
      '"Kano","Dala","2022-07",1,0.726,76,"ALERT",TRUE',
    ].join('\n');
    const alerts = parseAlerts(csv);
    expect(alerts[0]).toMatchObject({ id: 'Kano|Dala|2022-05', tier: 'WATCH', mean_pyrethroid_mort: null, pyrethroid_resistance_flag: false });
    expect(alerts[1]).toMatchObject({ id: 'Kano|Dala|2022-07', tier: 'ALERT', mean_risk: 0.726, mean_pyrethroid_mort: 76, pyrethroid_resistance_flag: true });
  });

  it('reads the risk predictions', () => {
    const csv = ['"record_id","state","lga","ward","latitude","longitude","collection_date","p_high","tier"',
      '"VD01324","Osun","Iwo","Iwo Ward 4",7.61666,4.18003,2023-04-20,0.22,"WATCH"'].join('\n');
    expect(parseRisks(csv)[0]).toMatchObject({ record_id: 'VD01324', p_high: 0.22, tier: 'WATCH', latitude: 7.61666 });
  });
});

describe('reference date', () => {
  it('is today in Nigeria (WAT, UTC+1), not the server\'s UTC day', () => {
    expect(lagosToday(new Date('2026-10-08T23:30:00Z'))).toBe('2026-10-09');
    expect(lagosToday(new Date('2026-10-08T22:30:00Z'))).toBe('2026-10-08');
  });
});

describe('PipelineRunner scheduling', () => {
  const options = { databaseUrl: 'unused', analyticsDir: '', outputRoot: '' };

  it('runs one analysis at a time, and a burst of requests costs one extra run, not many', async () => {
    const started: string[] = [];
    let release: () => void = () => undefined;
    const run = (trigger: string) => {
      started.push(trigger);
      return new Promise<RunResult>((r) => { release = () => r(result(started.length)); });
    };
    const runner = new PipelineRunner(options, run as never);
    const first = runner.run('manual');
    expect(runner.isRunning()).toBe(true);
    void runner.run('sync');
    void runner.run('sync');
    void runner.run('enrichment');
    expect(started).toEqual(['manual']);       // nothing else started while one is running
    release();
    await first;
    await new Promise((r) => setTimeout(r, 5));
    expect(started).toEqual(['manual', 'enrichment']); // the three requests became a single follow-up run
    release();
    await new Promise((r) => setTimeout(r, 5));
    expect(runner.isRunning()).toBe(false);
  });

  it('waits for things to go quiet before running after a sync', async () => {
    const started: string[] = [];
    const runner = new PipelineRunner({ ...options, debounceMs: 30 }, (async (t: string) => { started.push(t); return result(); }) as never);
    runner.request('sync');
    runner.request('sync');
    runner.request('sync');
    expect(started).toEqual([]);
    await new Promise((r) => setTimeout(r, 80));
    expect(started).toEqual(['sync']);
    runner.stop();
  });

  it('a failing run does not stop later runs', async () => {
    let n = 0;
    const runner = new PipelineRunner(options, (async () => { n++; if (n === 1) throw new Error('boom'); return result(n); }) as never);
    await expect(runner.run('manual')).rejects.toThrow('boom');
    expect(runner.isRunning()).toBe(false);
    await expect(runner.run('manual')).resolves.toMatchObject({ run_id: 2 });
  });
});
