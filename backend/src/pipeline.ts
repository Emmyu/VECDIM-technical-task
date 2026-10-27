import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { parseCsv } from '@vecdim/validator';

pg.types.setTypeParser(1082, (v: string) => v);
pg.types.setTypeParser(20, (v: string) => Number(v));

const here = dirname(fileURLToPath(import.meta.url));

/** The pack's column layout (data/vecdim_dummy_entomology_data.csv). R reads exactly these. */
export const INPUT_COLUMNS = [
  'record_id', 'state', 'lga', 'ward', 'latitude', 'longitude', 'collection_date', 'species', 'insecticide',
  'n_exposed', 'n_dead', 'mortality_pct', 'larval_density', 'rainfall_mm', 'temp_c', 'ndvi', 'elevation_m',
  'dist_water_km', 'urban', 'itn_use_pct', 'irs_covered', 'slide_positivity_pct', 'high_risk',
] as const;

/** R's rule columns in validation_flags_all.csv, and the database column each one is stored in. */
export const RULE_COLUMNS = [
  'GPS_outside_nigeria', 'GPS_zero_zero', 'GPS_state_mismatch', 'GPS_far_from_lga', 'n_dead_gt_n_exposed',
  'positivity_out_range', 'future_date', 'temp_implausible', 'rainfall_implausible', 'duplicate', 'missing_core',
] as const;

/** Small result files kept in the database next to the tables (the figures stay in the run folder). */
export const STORED_FILES = [
  'model_metrics.csv', 'rf_variable_importance.csv', 'descriptive_summary.csv',
  'resistance_by_state_insecticide.csv', 'species_by_state.csv', 'validation_summary.csv',
] as const;

export type Trigger = 'startup' | 'sync' | 'enrichment' | 'schedule' | 'manual' | 'test';

// ---------------------------------------------------------------------------
// CSV out (what R reads)
// ---------------------------------------------------------------------------

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return 'NA'; // R's missing value
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NA';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function rowsToCsv(rows: Array<Record<string, unknown>>, columns: readonly string[] = INPUT_COLUMNS): string {
  const lines = [columns.join(',')];
  for (const r of rows) lines.push(columns.map((c) => csvCell(r[c])).join(','));
  return lines.join('\n') + '\n';
}

/** Dataset rows first (file order, which R's random forest depends on), then app records in arrival order. */
export const EXPORT_SQL = `
  SELECT ${INPUT_COLUMNS.join(', ')}, 0 AS src, seq AS ord FROM raw_entomology
  UNION ALL
  SELECT ${INPUT_COLUMNS.join(', ')}, 1 AS src, row_number() OVER (ORDER BY received_at, record_id) AS ord
  FROM field_records WHERE source = 'app'
  ORDER BY src, ord`;

// ---------------------------------------------------------------------------
// CSV in (what R wrote)
// ---------------------------------------------------------------------------

const num = (s: string | undefined): number | null => (s === undefined || s === '' || s === 'NA' ? null : Number(s));
const bool = (s: string | undefined): boolean => s === 'TRUE';

export interface FlagRow { record_id: string; any_flag: boolean; rules: Record<string, boolean> }
export interface Alert {
  id: string; state: string; lga: string; month: string; n_records: number; mean_risk: number; tier: string;
  pyrethroid_resistance_flag: boolean; mean_pyrethroid_mort: number | null;
}
export interface RiskRow {
  record_id: string; state: string; lga: string; ward: string; latitude: number; longitude: number;
  collection_date: string; p_high: number; tier: string;
}
export interface Outputs {
  flags: FlagRow[];
  risks: RiskRow[];
  alerts: Alert[];
  nClean: number;
  files: Record<string, string>;
}

export function parseFlags(text: string): FlagRow[] {
  return parseCsv(text).map((r) => ({
    record_id: r.record_id,
    any_flag: bool(r.any_flag),
    rules: Object.fromEntries(RULE_COLUMNS.map((c) => [c, bool(r[c])])),
  }));
}

export function parseAlerts(text: string): Alert[] {
  return parseCsv(text).map((a) => ({
    id: `${a.state}|${a.lga}|${a.ym}`,
    state: a.state, lga: a.lga, month: a.ym,
    n_records: Number(a.n), mean_risk: Number(a.mean_p_high), tier: a.alert,
    pyrethroid_resistance_flag: bool(a.pyrethroid_resistance_flag),
    mean_pyrethroid_mort: num(a.mean_pyrethroid_mort),
  }));
}

export function parseRisks(text: string): RiskRow[] {
  return parseCsv(text).map((r) => ({
    record_id: r.record_id, state: r.state, lga: r.lga, ward: r.ward,
    latitude: Number(r.latitude), longitude: Number(r.longitude), collection_date: r.collection_date,
    p_high: Number(r.p_high), tier: r.tier,
  }));
}

/** Reads R's output folder. Throws if a file is missing or the numbers do not add up. */
export function readOutputs(dir: string, nInput: number): Outputs {
  const read = (f: string) => {
    const p = resolve(dir, f);
    if (!existsSync(p)) throw new Error(`R did not produce ${f}`);
    return readFileSync(p, 'utf8');
  };
  const flags = parseFlags(read('validation_flags_all.csv'));
  const risks = parseRisks(read('risk_predictions.csv'));
  const alerts = parseAlerts(read('alerts.csv'));
  const nClean = parseCsv(read('cleaned_data.csv')).length;
  const nFlagged = flags.filter((f) => f.any_flag).length;
  if (flags.length !== nInput) throw new Error(`R returned ${flags.length} validation rows for ${nInput} input rows`);
  if (nClean !== nInput - nFlagged) throw new Error(`cleaned rows (${nClean}) != input (${nInput}) - flagged (${nFlagged})`);
  if (risks.length !== nClean) throw new Error(`risk predictions (${risks.length}) != cleaned rows (${nClean})`);
  const files: Record<string, string> = {};
  for (const f of STORED_FILES) if (existsSync(resolve(dir, f))) files[f] = read(f);
  return { flags, risks, alerts, nClean, files };
}

// ---------------------------------------------------------------------------
// Running R
// ---------------------------------------------------------------------------

interface Exec { code: number | null; out: string; timedOut: boolean }

function exec(cmd: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }): Promise<Exec> {
  return new Promise((resolveP, rejectP) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, windowsHide: true });
    let out = '';
    let timedOut = false;
    const keep = (b: Buffer) => { out = (out + b.toString()).slice(-20000); };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, opts.timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); rejectP(e); });
    child.on('close', (code) => { clearTimeout(timer); resolveP({ code, out, timedOut }); });
  });
}

export interface PipelineOptions {
  /** Owner connection: the pipeline writes the analysis tables. */
  databaseUrl: string;
  /** Folder that contains R/run_all.R (the pack's R code). */
  analyticsDir: string;
  /** Where each run's input and output files are kept. */
  outputRoot: string;
  rscript?: string;
  /** Date the future_date rule is judged against. Default: today in Nigeria. */
  refDate?: string;
  timeoutMs?: number;
  keepRuns?: number;
  log?: (s: string) => void;
}

export interface RunResult {
  run_id: number;
  status: 'succeeded' | 'failed';
  n_input: number; n_dataset: number; n_app: number; n_flagged: number; n_clean: number; n_alerts: number;
  alert_counts: Record<string, number>;
  duration_ms: number;
  error?: string;
}

export function lagosToday(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Lagos' }).format(now); // YYYY-MM-DD
}

export const defaultPaths = {
  analyticsDir: resolve(here, '../../analytics'),
  outputRoot: resolve(here, '../../analysis-output'),
};

/**
 * One full run: export the data, run the pack's R code on it, check what came back, and replace the
 * results tables in a single transaction. If anything fails, the previous results stay in place and
 * the failure is recorded in analysis_runs.
 */
export async function runPipeline(trigger: Trigger, o: PipelineOptions): Promise<RunResult> {
  const log = o.log ?? (() => undefined);
  const rscript = o.rscript ?? process.env.RSCRIPT ?? 'Rscript';
  const refDate = o.refDate ?? lagosToday();
  const started = Date.now();
  const client = new pg.Client({ connectionString: o.databaseUrl });
  await client.connect();
  let runId = 0;
  const empty = { n_input: 0, n_dataset: 0, n_app: 0, n_flagged: 0, n_clean: 0, n_alerts: 0, alert_counts: {} as Record<string, number> };
  try {
    runId = (await client.query(`INSERT INTO analysis_runs (trigger, ref_date) VALUES ($1, $2) RETURNING run_id`, [trigger, refDate])).rows[0].run_id;
    log(`pipeline run ${runId} (${trigger}) started, reference date ${refDate}`);
    try {
      // 1. Export: dataset + app records, in the pack's layout
      const rows = (await client.query(EXPORT_SQL)).rows as Array<Record<string, unknown> & { src: number }>;
      const nApp = rows.filter((r) => r.src === 1).length;
      const nDataset = rows.length - nApp;
      if (rows.length === 0) throw new Error('There is no data to analyse. Load the dataset first (npm run seed).');
      const csv = rowsToCsv(rows);
      const runDir = resolve(o.outputRoot, `run-${runId}`);
      const outDir = resolve(runDir, 'outputs');
      mkdirSync(outDir, { recursive: true });
      const inFile = resolve(runDir, 'input.csv');
      writeFileSync(inFile, csv);
      const sha = createHash('sha256').update(csv).digest('hex');
      await client.query(`UPDATE analysis_runs SET n_input=$2, n_dataset=$3, n_app=$4, input_sha256=$5, output_dir=$6 WHERE run_id=$1`,
        [runId, rows.length, nDataset, nApp, sha, runDir]);

      // 2. Run R (the pack's own code: validate and clean -> descriptive analysis -> random forest and alerts)
      const env = { ...process.env, VECDIM_REF_DATE: refDate };
      const ver = await exec(rscript, ['--version'], { cwd: o.analyticsDir, env, timeoutMs: 30000 }).catch((e) => {
        throw new Error(`Cannot run ${rscript}: ${(e as Error).message}. Install R (>= 4.0) with dplyr, ggplot2 and randomForest, or set RSCRIPT.`);
      });
      const rVersion = ver.out.split('\n')[0].trim();
      const r = await exec(rscript, ['R/run_all.R', inFile, outDir], { cwd: o.analyticsDir, env, timeoutMs: o.timeoutMs ?? 15 * 60 * 1000 });
      await client.query(`UPDATE analysis_runs SET r_version=$2, log=$3 WHERE run_id=$1`, [runId, rVersion, r.out]);
      if (r.timedOut) throw new Error('R did not finish in time and was stopped.');
      if (r.code !== 0) throw new Error(`R exited with code ${r.code}. Last output: ${r.out.slice(-600)}`);

      // 3. Check and load, all or nothing
      const out = readOutputs(outDir, rows.length);
      const ctx = new Map(rows.map((x) => [String(x.record_id), x]));
      const nFlagged = out.flags.filter((f) => f.any_flag).length;
      const alertCounts: Record<string, number> = { ALERT: 0, WARNING: 0, WATCH: 0 };
      for (const a of out.alerts) alertCounts[a.tier] = (alertCounts[a.tier] ?? 0) + 1;

      await client.query('BEGIN');
      try {
        await client.query('DELETE FROM alerts');
        await client.query('DELETE FROM risk_predictions');
        await client.query('DELETE FROM pipeline_flags');
        await client.query('DELETE FROM analysis_files');
        await client.query(
          `INSERT INTO pipeline_flags (record_id, run_id, state, lga, gps_outside_nigeria, gps_zero_zero, gps_state_mismatch, gps_far_from_lga,
             n_dead_gt_n_exposed, positivity_out_range, future_date, temp_implausible, rainfall_implausible, duplicate, missing_core, any_flag)
           SELECT x.record_id, $2, x.state, x.lga, x.r1, x.r2, x.r3, x.r4, x.r5, x.r6, x.r7, x.r8, x.r9, x.r10, x.r11, x.any_flag
           FROM jsonb_to_recordset($1::jsonb) AS x(record_id text, state text, lga text, r1 boolean, r2 boolean, r3 boolean, r4 boolean, r5 boolean,
             r6 boolean, r7 boolean, r8 boolean, r9 boolean, r10 boolean, r11 boolean, any_flag boolean)`,
          [JSON.stringify(out.flags.map((f) => {
            const c = ctx.get(f.record_id);
            const o2: Record<string, unknown> = { record_id: f.record_id, state: c?.state ?? null, lga: c?.lga ?? null, any_flag: f.any_flag };
            RULE_COLUMNS.forEach((rule, i) => { o2[`r${i + 1}`] = f.rules[rule]; });
            return o2;
          })), runId],
        );
        await client.query(
          `INSERT INTO risk_predictions (record_id, run_id, state, lga, ward, latitude, longitude, collection_date, p_high, tier)
           SELECT x.record_id, $2, x.state, x.lga, x.ward, x.latitude, x.longitude, x.collection_date, x.p_high, x.tier::alert_tier
           FROM jsonb_to_recordset($1::jsonb) AS x(record_id text, state text, lga text, ward text, latitude double precision,
             longitude double precision, collection_date date, p_high double precision, tier text)`,
          [JSON.stringify(out.risks), runId],
        );
        await client.query(
          `INSERT INTO alerts (id, state, lga, month, n_records, mean_risk, tier, pyrethroid_resistance_flag, mean_pyrethroid_mort, run_id)
           SELECT x.id, x.state, x.lga, x.month, x.n_records, x.mean_risk, x.tier::alert_tier, x.pyrethroid_resistance_flag, x.mean_pyrethroid_mort, $2
           FROM jsonb_to_recordset($1::jsonb) AS x(id text, state text, lga text, month text, n_records integer, mean_risk double precision,
             tier text, pyrethroid_resistance_flag boolean, mean_pyrethroid_mort double precision)`,
          [JSON.stringify(out.alerts), runId],
        );
        for (const [name, content] of Object.entries(out.files)) {
          await client.query(`INSERT INTO analysis_files (name, run_id, content) VALUES ($1, $2, $3)`, [name, runId, content]);
        }
        // The dataset rows R accepted become ordinary records, so the Field and VECDIM views have data.
        await client.query(
          `INSERT INTO field_records (record_id, owner_user_id, source, state, lga, ward, latitude, longitude, collection_date, species,
             insecticide, n_exposed, n_dead, mortality_pct, larval_density, urban, irs_covered, itn_use_pct, rainfall_mm, temp_c, ndvi,
             elevation_m, dist_water_km, slide_positivity_pct, high_risk, payload, captured_at)
           SELECT r.record_id, u.user_id, 'seed', r.state, r.lga, r.ward, r.latitude, r.longitude, r.collection_date, r.species,
             r.insecticide, r.n_exposed, r.n_dead, r.mortality_pct, r.larval_density, r.urban, r.irs_covered, r.itn_use_pct, r.rainfall_mm,
             r.temp_c, r.ndvi, r.elevation_m, r.dist_water_km, r.slide_positivity_pct, r.high_risk,
             to_jsonb(r) - 'seq' - 'loaded_at', r.collection_date::timestamptz
           FROM raw_entomology r
           JOIN pipeline_flags f ON f.record_id = r.record_id AND NOT f.any_flag
           JOIN LATERAL (SELECT user_id FROM users WHERE role = 'field' AND state = r.state ORDER BY user_id LIMIT 1) u ON true
           ON CONFLICT (record_id) DO NOTHING`,
        );
        const durationMs = Date.now() - started;
        await client.query(
          `UPDATE analysis_runs SET status='succeeded', finished_at=now(), duration_ms=$2, n_flagged=$3, n_clean=$4, n_alerts=$5, alert_counts=$6 WHERE run_id=$1`,
          [runId, durationMs, nFlagged, out.nClean, out.alerts.length, JSON.stringify(alertCounts)],
        );
        await client.query('COMMIT');
        prune(o.outputRoot, o.keepRuns ?? 5);
        log(`pipeline run ${runId} succeeded in ${(durationMs / 1000).toFixed(1)}s: ${rows.length} rows, ${nFlagged} flagged, ${out.nClean} clean, ${out.alerts.length} alerts`);
        return { run_id: runId, status: 'succeeded', n_input: rows.length, n_dataset: nDataset, n_app: nApp, n_flagged: nFlagged,
          n_clean: out.nClean, n_alerts: out.alerts.length, alert_counts: alertCounts, duration_ms: durationMs };
      } catch (e) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw e;
      }
    } catch (e) {
      const message = (e as Error).message;
      const durationMs = Date.now() - started;
      if (runId) {
        await client.query(`UPDATE analysis_runs SET status='failed', finished_at=now(), duration_ms=$2, error=$3 WHERE run_id=$1`,
          [runId, durationMs, message]).catch(() => undefined);
      }
      log(`pipeline run ${runId} FAILED: ${message}`);
      return { run_id: runId, status: 'failed', ...empty, duration_ms: durationMs, error: message };
    }
  } finally {
    await client.end();
  }
}

function prune(root: string, keep: number) {
  try {
    const dirs = readdirSync(root).filter((d) => /^run-\d+$/.test(d)).sort((a, b) => Number(b.slice(4)) - Number(a.slice(4)));
    for (const d of dirs.slice(keep)) rmSync(resolve(root, d), { recursive: true, force: true });
  } catch { /* nothing to prune */ }
}

// ---------------------------------------------------------------------------
// When it runs
// ---------------------------------------------------------------------------

export interface RunnerOptions extends PipelineOptions {
  /** After a sync or enrichment, wait this long for more data before running (milliseconds). */
  debounceMs?: number;
  /** Also run on a timer, every N minutes (0 = off). */
  scheduleMinutes?: number;
}

/**
 * Decides when the pipeline runs. Only one run happens at a time; a request that arrives while one is
 * running is remembered and run once afterwards, so a burst of syncs costs one extra run, not many.
 */
export class PipelineRunner {
  private current: Promise<RunResult> | null = null;
  private queued: Trigger | null = null;
  private timers: NodeJS.Timeout[] = [];
  private debounce: NodeJS.Timeout | null = null;

  constructor(private o: RunnerOptions, private run_: typeof runPipeline = runPipeline) {}

  isRunning(): boolean { return this.current !== null; }

  /** Starts a run now, or marks one to follow the current run. Resolves with the run that was started or joined. */
  run(trigger: Trigger): Promise<RunResult> {
    if (this.current) {
      this.queued = trigger;
      return this.current;
    }
    const p = this.run_(trigger, this.o).finally(() => {
      this.current = null;
      const next = this.queued;
      this.queued = null;
      if (next) void this.run(next).catch(() => undefined);
    });
    this.current = p;
    return p;
  }

  /** For events that arrive in bursts (syncs, enrichment): run once after things go quiet. */
  request(trigger: Trigger): void {
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.debounce = null;
      void this.run(trigger).catch(() => undefined);
    }, this.o.debounceMs ?? 20_000);
    this.debounce.unref?.();
  }

  /** Call once at start-up: run if nothing has succeeded yet (first deployment), and start the timer. */
  async start(): Promise<void> {
    const c = new pg.Client({ connectionString: this.o.databaseUrl });
    await c.connect();
    try {
      const ok = (await c.query(`SELECT count(*)::int n FROM analysis_runs WHERE status = 'succeeded'`)).rows[0].n as number;
      const hasData = (await c.query(`SELECT count(*)::int n FROM raw_entomology`)).rows[0].n as number;
      if (ok === 0 && hasData > 0) void this.run('startup').catch(() => undefined);
    } finally {
      await c.end();
    }
    const mins = this.o.scheduleMinutes ?? 0;
    if (mins > 0) {
      const t = setInterval(() => void this.run('schedule').catch(() => undefined), mins * 60_000);
      t.unref?.();
      this.timers.push(t);
    }
  }

  stop(): void {
    this.timers.forEach(clearInterval);
    this.timers = [];
    if (this.debounce) clearTimeout(this.debounce);
  }
}

// Command line: `npm run pipeline` runs once and exits
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  runPipeline('manual', {
    databaseUrl: url,
    analyticsDir: process.env.ANALYTICS_DIR ?? defaultPaths.analyticsDir,
    outputRoot: process.env.ANALYSIS_DIR ?? defaultPaths.outputRoot,
    refDate: process.env.PIPELINE_REF_DATE || undefined,
    log: console.log,
  }).then((r) => process.exit(r.status === 'succeeded' ? 0 : 1));
}
