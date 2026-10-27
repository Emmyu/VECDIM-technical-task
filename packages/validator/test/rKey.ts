// The parity "answer key" is what the system's own R pipeline produces for the dataset
// (validation_flags_all.csv). When R is installed, it is produced fresh by running the pack's step 1
// (analytics/R/01_validate_and_clean.R) on the dataset. When R is not installed, a snapshot of that
// output (fixtures/validation_flags_all.csv, itself produced by the pipeline) stands in.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const root = resolve(here, '../../..');
export const dataPath = resolve(root, 'seed/vecdim_dummy_entomology_data.csv');
export const snapshotPath = resolve(here, 'fixtures/validation_flags_all.csv');
const analytics = resolve(root, 'analytics');

export function rscript(): string | null {
  const cmd = process.env.RSCRIPT ?? 'Rscript';
  const probe = spawnSync(cmd, ['--version'], { encoding: 'utf8' });
  return probe.error || probe.status !== 0 ? null : cmd;
}

/** Runs R's validation step on the dataset and returns the path of the flags file it wrote, or null if R is missing or fails. */
export function freshKeyFromR(): string | null {
  const cmd = rscript();
  if (!cmd) return null;
  const out = mkdtempSync(resolve(tmpdir(), 'vecdim-parity-'));
  // Default reference date (2026-10-08): VECDIM_REF_DATE must not be set for the parity run
  const env = { ...process.env };
  delete env.VECDIM_REF_DATE;
  const r = spawnSync(cmd, ['R/01_validate_and_clean.R', dataPath, out], { cwd: analytics, env, encoding: 'utf8' });
  const file = resolve(out, 'validation_flags_all.csv');
  return r.status === 0 && existsSync(file) ? file : null;
}

/** Fresh output of the R pipeline if R is available, otherwise the committed snapshot of it. */
export function answerKey(): { path: string; source: 'R pipeline (fresh run)' | 'snapshot of R pipeline output' } {
  const fresh = freshKeyFromR();
  return fresh ? { path: fresh, source: 'R pipeline (fresh run)' } : { path: snapshotPath, source: 'snapshot of R pipeline output' };
}
