import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  NUMERIC_COLUMNS,
  PARITY_REF_DATE,
  RULES,
  R_RULE_IDS,
  PREDICATES,
  computeFlags,
  csvRowToRecord,
  parseCsv,
  type RecordInput,
} from '../src';
import { answerKey, dataPath, snapshotPath, freshKeyFromR } from './rKey';

const { path: keyPath, source: keySource } = answerKey();
const available = existsSync(dataPath) && existsSync(keyPath);

describe.skipIf(!available)('parity with the R pipeline (validation_flags_all.csv produced by the pipeline)', () => {
  it('reports where the answer key came from', () => {
    console.log('parity answer key: ' + keySource);
    expect(existsSync(keyPath)).toBe(true);
  });

  const records = parseCsv(readFileSync(dataPath, 'utf8')).map((r) => csvRowToRecord(r, NUMERIC_COLUMNS)) as RecordInput[];
  const key = new Map(parseCsv(readFileSync(keyPath, 'utf8')).map((r) => [r.record_id, r]));
  const flags = computeFlags(records, PARITY_REF_DATE);

  it('covers all 1,525 rows', () => {
    expect(records).toHaveLength(1525);
    expect(key.size).toBe(1525);
  });

  it.each([...R_RULE_IDS])('server validator: %s matches on every row', (rule) => {
    const diffs = records
      .map((r, i) => ({ id: String(r.record_id), got: flags[i][rule], want: key.get(String(r.record_id))?.[rule] === 'TRUE' }))
      .filter((x) => x.got !== x.want);
    expect(diffs).toEqual([]);
  });

  it('device validator matches R for the rules marked Device', () => {
    const deviceIds = R_RULE_IDS.filter((id) => RULES.find((r) => r.id === id)?.device);
    expect(deviceIds).toHaveLength(8);
    const diffs: string[] = [];
    records.forEach((r, i) => {
      for (const id of deviceIds) {
        const got = PREDICATES[id](r, { refDate: PARITY_REF_DATE, isDuplicate: flags[i].duplicate });
        if (got !== (key.get(String(r.record_id))?.[id] === 'TRUE')) diffs.push(`${id} ${r.record_id}`);
      }
    });
    expect(diffs).toEqual([]);
  });

  it('flags the same 222 unique records as R', () => {
    expect(flags.filter((f) => f.any_flag)).toHaveLength(222);
  });

  it('the committed snapshot still equals what the pipeline produces now (it has not drifted)', () => {
    const fresh = freshKeyFromR();
    if (!fresh) return; // R not installed here: nothing to compare against
    const lf = (p: string) => readFileSync(p, 'utf8').split('\r\n').join('\n');
    expect(lf(snapshotPath)).toBe(lf(fresh));
  });
});
