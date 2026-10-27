// Parity test: our validator vs the flags the system's own R pipeline produces (validation_flags_all.csv).
// R is run fresh on the dataset when it is installed; otherwise a snapshot of the pipeline's output is used.
// Usage: tsx scripts/parity.ts [dataCsv] [flagsCsv] [outFile]
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  NUMERIC_COLUMNS,
  PARITY_REF_DATE,
  PREDICATES,
  RULES,
  R_RULE_IDS,
  computeFlags,
  csvRowToRecord,
  parseCsv,
  type Context,
  type RecordInput,
} from '../src';
import { answerKey } from '../test/rKey';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const dataPath = process.argv[2] ?? resolve(root, 'seed/vecdim_dummy_entomology_data.csv');
const key0 = process.argv[3] ? { path: process.argv[3], source: 'file given on the command line' } : answerKey();
const keyPath = key0.path;
const outPath = process.argv[4] ?? resolve(root, 'parity_output.txt');

const records = parseCsv(readFileSync(dataPath, 'utf8')).map((r) => csvRowToRecord(r, NUMERIC_COLUMNS)) as RecordInput[];
const key = new Map(parseCsv(readFileSync(keyPath, 'utf8')).map((r) => [r.record_id, r]));

const lines: string[] = [];
const log = (s: string) => {
  lines.push(s);
  console.log(s);
};
log('Answer key: validation_flags_all.csv from the ' + key0.source);

function compare(label: string, ruleIds: readonly string[], rowOf: (i: number) => Record<string, boolean>): number {
  log(`\n== ${label}: ${records.length} rows, reference date ${PARITY_REF_DATE} ==`);
  let totalDiff = 0;
  const diffRows = new Set<string>();
  for (const id of ruleIds) {
    let diff = 0;
    let ours = 0;
    let theirs = 0;
    records.forEach((rec, i) => {
      const expected = key.get(String(rec.record_id))?.[id] === 'TRUE';
      const got = rowOf(i)[id];
      if (got) ours++;
      if (expected) theirs++;
      if (got !== expected) {
        diff++;
        diffRows.add(String(rec.record_id));
        log(`  DIFF ${id} ${rec.record_id}: ours=${got} R=${expected}`);
      }
    });
    totalDiff += diff;
    log(`${id.padEnd(22)} ours=${String(ours).padStart(4)}  R=${String(theirs).padStart(4)}  differing rows=${diff}`);
  }
  log(`RESULT ${label}: ${totalDiff === 0 ? 'PASS, every rule matches on every row' : `${diffRows.size} differing row(s)`}`);
  return totalDiff;
}

const missingKey = records.filter((r) => !key.has(String(r.record_id))).length;
if (missingKey) log(`WARNING: ${missingKey} records have no row in the answer key`);

// Server validator: all 11 rules
const flags = computeFlags(records, PARITY_REF_DATE);
const serverDiff = compare('SERVER validator (11 rules)', R_RULE_IDS, (i) => flags[i] as unknown as Record<string, boolean>);

// Device validator: only the R rules marked Device, with the on-device duplicate check
const deviceIds = R_RULE_IDS.filter((id) => RULES.find((r) => r.id === id)?.device);
const deviceRows = records.map((r, i) => {
  const ctx: Context = { refDate: PARITY_REF_DATE, isDuplicate: flags[i].duplicate };
  return Object.fromEntries(deviceIds.map((id) => [id, PREDICATES[id](r, ctx)]));
});
const deviceDiff = compare('DEVICE validator (rules marked Device)', deviceIds, (i) => deviceRows[i]);

writeFileSync(outPath, lines.join('\n') + '\n');
console.log(`\nSaved to ${outPath}`);
process.exit(serverDiff + deviceDiff === 0 ? 0 : 1);
