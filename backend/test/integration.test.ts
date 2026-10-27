// Integration tests against a real PostgreSQL + PostGIS. They run only when TEST_DATABASE_URL is set, e.g.
//   TEST_DATABASE_URL=postgres://vecdim:vecdim@localhost:5432 npm test -w @vecdim/backend
// (server only, no database name). Each run creates and drops its own database.
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { makePool } from '../src/db';
import { migrate } from '../src/migrate';
import { defaultPaths, runPipeline, type RunResult } from '../src/pipeline';
import { seed } from '../src/seed';

const base = process.env.TEST_DATABASE_URL;
const dbName = `vecdim_test_${process.pid}`;
const seedDir = resolve(fileURLToPath(import.meta.url), '../../../seed');
const quiet = () => undefined;
// The pipeline needs R with dplyr, ggplot2 and randomForest (set RSCRIPT if Rscript is not on the PATH).
const rscript = process.env.RSCRIPT ?? 'Rscript';
// The brief's reference numbers were produced with this date; pinning it keeps the test stable as time passes.
const REF_DATE = '2026-10-08';
const pipelineOptions = (url: string, outputRoot: string) => ({
  databaseUrl: url, analyticsDir: defaultPaths.analyticsDir, outputRoot, rscript, refDate: REF_DATE, log: quiet,
});

function urlFor(db: string, user?: { name: string; password?: string }): string {
  const u = new URL(base!);
  u.pathname = `/${db}`;
  if (user) {
    u.username = user.name;
    u.password = user.password ?? '';
  }
  return u.toString();
}

describe.skipIf(!base)('PostgreSQL / PostGIS integration', () => {
  let owner: pg.Pool;
  let apiPool: pg.Pool;
  let app: ReturnType<typeof buildApp>;
  let firstRun: RunResult;
  const outputRoot = mkdtempSync(resolve(tmpdir(), 'vecdim-analysis-'));

  beforeAll(async () => {
    const probe = spawnSync(rscript, ['--version'], { encoding: 'utf8' });
    if (probe.error) {
      throw new Error(`Integration tests run the R pipeline, but ${rscript} could not be started. Install R with dplyr, ggplot2 and randomForest, or set RSCRIPT.`);
    }
    const admin = new pg.Client({ connectionString: urlFor('postgres') });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin.query(`CREATE DATABASE ${dbName}`);
    await admin.end();
    await migrate(urlFor(dbName), quiet);
    await seed(urlFor(dbName), seedDir, quiet);
    // The system produces its own results: the pack's R code runs on the loaded dataset
    firstRun = await runPipeline('test', pipelineOptions(urlFor(dbName), outputRoot));
    if (firstRun.status !== 'succeeded') throw new Error(`pipeline failed: ${firstRun.error}`);
    owner = new pg.Pool({ connectionString: urlFor(dbName) });
    apiPool = makePool(urlFor(dbName, { name: 'vecdim_api', password: 'vecdim_api' }));
    app = buildApp({ pool: apiPool });
  }, 15 * 60_000);

  afterAll(async () => {
    await app?.close();
    await apiPool?.end();
    await owner?.end();
    const admin = new pg.Client({ connectionString: urlFor('postgres') });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin.end();
  });

  const call = async (method: 'GET' | 'POST', url: string, user?: string, payload?: unknown) => {
    const res = await app.inject({ method, url: `/api/v1${url}`, headers: user ? { 'x-user-id': user } : {}, payload: payload as never });
    return { status: res.statusCode, body: res.json() };
  };

  let n = 0;
  const rec = (over: Record<string, unknown> = {}) => ({
    record_id: `11111111-1111-4111-8111-${String(++n).padStart(12, '0')}`,
    state: 'Osun', lga: 'Osogbo', ward: 'Osogbo Ward 2', latitude: 7.77, longitude: 4.56, gps_accuracy_m: 6.5,
    collection_date: '2026-10-07', species: 'An. gambiae s.s.', insecticide: 'Permethrin', n_exposed: 100, n_dead: 30 + n,
    larval_density: 6, urban: 1, irs_covered: 0, itn_use_pct: 61.5, captured_at: '2026-10-07T09:14:22Z', ...over,
  });

  describe('seed and first pipeline run', () => {
    it('the seed loads the dataset as supplied (1,525 rows, bad ones included) and the pipeline produces the results', async () => {
      expect((await owner.query('SELECT count(*)::int n FROM raw_entomology')).rows[0].n).toBe(1525);
      expect(firstRun).toMatchObject({ n_input: 1525, n_app: 0, n_flagged: 222, n_clean: 1303, n_alerts: 647 });
      expect((await owner.query('SELECT count(*)::int n FROM pipeline_flags')).rows[0].n).toBe(1525);
      expect((await owner.query('SELECT count(*)::int n FROM pipeline_flags WHERE any_flag')).rows[0].n).toBe(222);
      expect((await owner.query('SELECT count(*)::int n FROM risk_predictions')).rows[0].n).toBe(1303);
      expect((await owner.query('SELECT count(*)::int n FROM alerts')).rows[0].n).toBe(647);
      // the 1,303 records R accepted are the ordinary records the Field and VECDIM views show
      expect((await owner.query(`SELECT count(*)::int n FROM field_records WHERE source = 'seed'`)).rows[0].n).toBe(1303);
    });

    it('the seed is safe to repeat, and so is a second run on unchanged data (same input hash, same numbers)', async () => {
      const again = await seed(urlFor(dbName), seedDir, quiet);
      expect(again).toEqual({ users: 0, dataset: 0 });
      const second = await runPipeline('test', pipelineOptions(urlFor(dbName), outputRoot));
      expect(second).toMatchObject({ status: 'succeeded', n_flagged: 222, n_clean: 1303, n_alerts: 647 });
      const hashes = await owner.query(`SELECT DISTINCT input_sha256 FROM analysis_runs WHERE status = 'succeeded'`);
      expect(hashes.rowCount).toBe(1);
      expect((await owner.query('SELECT count(*)::int n FROM alerts')).rows[0].n).toBe(647);
      expect((await owner.query('SELECT count(*)::int n FROM field_records')).rows[0].n).toBe(1303);
    }, 10 * 60_000);

    it("R's per-rule counts match the reference summary in the brief", async () => {
      const r = await owner.query(
        `SELECT count(*) FILTER (WHERE gps_outside_nigeria)::int a, count(*) FILTER (WHERE gps_zero_zero)::int b,
                count(*) FILTER (WHERE gps_state_mismatch)::int c, count(*) FILTER (WHERE gps_far_from_lga)::int d,
                count(*) FILTER (WHERE n_dead_gt_n_exposed)::int e, count(*) FILTER (WHERE positivity_out_range)::int f,
                count(*) FILTER (WHERE future_date)::int g, count(*) FILTER (WHERE temp_implausible)::int h,
                count(*) FILTER (WHERE rainfall_implausible)::int i, count(*) FILTER (WHERE duplicate)::int j,
                count(*) FILTER (WHERE missing_core)::int k FROM pipeline_flags`);
      expect(Object.values(r.rows[0])).toEqual([12, 8, 30, 30, 18, 10, 10, 8, 6, 25, 115]);
    });

    it("the model's validation results match the reference model_metrics.csv in the brief (all four settings)", async () => {
      const f = await owner.query(`SELECT content FROM analysis_files WHERE name = 'model_metrics.csv'`);
      expect(f.rows[0].content.trim().split(/\r?\n/)).toEqual([
        '"setting","mean_auc","sd_auc","fold1","fold2","fold3","fold4","fold5"',
        '"Covariates only | random 5-fold",0.82,0.039,0.849,0.843,0.761,0.848,0.8',
        '"Covariates only | LGA-grouped (spatial) 5-fold",0.817,0.066,0.724,0.909,0.816,0.833,0.801',
        '"Covariates + lat/lon | random 5-fold",0.885,0.035,0.91,0.904,0.83,0.91,0.873',
        '"Covariates + lat/lon | LGA-grouped (spatial) 5-fold",0.802,0.072,0.718,0.912,0.794,0.819,0.769',
      ]);
      const imp = await owner.query(`SELECT content FROM analysis_files WHERE name = 'rf_variable_importance.csv'`);
      expect(imp.rows[0].content.split(/\r?\n/)[1]).toMatch(/^"rainfall_mm",102\.69842/); // top variable and its importance, as in the reference
    });

    it('UNIOSUN tier counts come from one SQL query: 86 ALERT, 135 WARNING, 426 WATCH', async () => {
      const r = await owner.query(`SELECT tier::text, count(*)::int n FROM alerts GROUP BY tier`);
      const by = Object.fromEntries(r.rows.map((x) => [x.tier, x.n]));
      expect(by).toEqual({ ALERT: 86, WARNING: 135, WATCH: 426 });
    });

    it('stores a PostGIS point for every record with a GiST index', async () => {
      const r = await owner.query(`SELECT count(*)::int n FROM field_records WHERE geom IS NULL`);
      expect(r.rows[0].n).toBe(0);
      const idx = await owner.query(`SELECT indexdef FROM pg_indexes WHERE indexname = 'field_records_geom_gix'`);
      expect(idx.rows[0].indexdef).toMatch(/USING gist/);
      const type = await owner.query(`SELECT type, srid FROM geometry_columns WHERE f_table_name = 'field_records'`);
      expect(type.rows[0]).toEqual({ type: 'POINT', srid: 4326 });
    });

    it('keeps alert tier and resistance flag in separate columns, and the flag never decides the tier', async () => {
      const r = await owner.query(`SELECT count(*)::int n FROM alerts WHERE tier = 'WATCH' AND pyrethroid_resistance_flag`);
      expect(r.rows[0].n).toBeGreaterThan(0); // a WATCH alert can still carry the resistance flag
    });
  });

  describe('the database refuses bad data even if the API is bypassed', () => {
    const insert = (over: Record<string, unknown>) => {
      const r = { ...rec(), ...over } as Record<string, unknown>;
      return owner.query(
        `INSERT INTO field_records (record_id, owner_user_id, state, lga, ward, latitude, longitude, gps_accuracy_m, collection_date,
           species, insecticide, n_exposed, n_dead, mortality_pct, larval_density, urban, irs_covered, itn_use_pct, payload, captured_at)
         VALUES ($1,'u_field_03',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'{}'::jsonb, now())`,
        [r.record_id, r.state, r.lga, r.ward, r.latitude, r.longitude, r.gps_accuracy_m, r.collection_date, r.species, r.insecticide,
          r.n_exposed, r.n_dead, r.mortality_pct ?? (100 * Number(r.n_dead)) / Number(r.n_exposed), r.larval_density, r.urban, r.irs_covered, r.itn_use_pct],
      );
    };
    it('accepts a valid row and builds the point from the GPS reading', async () => {
      const r = rec({ record_id: 'direct-ok' });
      await insert(r);
      const g = await owner.query(`SELECT ST_AsText(geom) t, ST_SRID(geom) s FROM field_records WHERE record_id = 'direct-ok'`);
      expect(g.rows[0]).toEqual({ t: 'POINT(4.56 7.77)', s: 4326 });
    });
    it.each([
      [{ n_exposed: 100, n_dead: 120 }, 'n_dead_not_more_than_exposed'],
      [{ n_exposed: 501, n_dead: 5 }, 'n_exposed_range'],
      [{ latitude: 0, longitude: 0 }, 'gps_in_chosen_state'], // also breaks gps_in_nigeria and gps_not_zero_zero; Postgres reports the first by name
      [{ latitude: 51.5, longitude: -0.1 }, 'gps_in_chosen_state'],
      [{ latitude: 6.6, longitude: 3.4 }, 'gps_in_chosen_state'], // Lagos point, Osun record
      [{ gps_accuracy_m: 60 }, 'gps_accuracy_usable'],
      [{ ward: 'Osogbo Ward 7' }, 'ward_belongs_to_lga'],
      [{ ward: 'Iwo Ward 1' }, 'ward_belongs_to_lga'],
      [{ species: 'An. unknown' }, 'field_records_species_check'],
      [{ itn_use_pct: 120 }, 'field_records_itn_use_pct_check'],
      [{ lga: 'Dala', ward: 'Dala Ward 1' }, 'lga_exists'], // Dala is a Kano LGA, not an Osun one
      [{ collection_date: '2999-01-01' }, 'no_future_collection_date'],
    ])('rejects %j (%s)', async (over, constraint) => {
      await expect(insert(over)).rejects.toMatchObject({ constraint });
    });
    it('rejects a second row with the same record_id (unique constraint)', async () => {
      await expect(insert({ record_id: 'direct-ok' })).rejects.toMatchObject({ code: '23505' });
    });
    it('does not let the audit columns change after the first write', async () => {
      await expect(owner.query(`UPDATE field_records SET payload = '{"x":1}' WHERE record_id = 'direct-ok'`)).rejects.toThrow(/immutable/);
    });
  });

  describe('API: safe sync', () => {
    it('GET /health', async () => {
      expect(await call('GET', '/health')).toEqual({ status: 200, body: { status: 'ok' } });
    });

    it('requires a user', async () => {
      expect((await call('GET', '/records')).status).toBe(401);
      expect((await call('GET', '/records', 'nobody')).status).toBe(401);
    });

    it('sending the same record twice leaves one row', async () => {
      const r = rec();
      const a = await call('POST', '/records/batch', 'u_field_03', { records: [r] });
      const b = await call('POST', '/records/batch', 'u_field_03', { records: [r] });
      expect(a.body.results[0].status).toBe('accepted');
      expect(b.status).toBe(200);
      expect(b.body.results[0].status).toBe('already_received');
      expect((await owner.query(`SELECT count(*)::int n FROM field_records WHERE record_id = $1`, [r.record_id])).rows[0].n).toBe(1);
    });

    it('one bad record in ten: nine accepted, the bad one rejected and not stored; fix and resubmit under the same id', async () => {
      const batch = Array.from({ length: 10 }, () => rec());
      const bad = rec({ n_exposed: 100, n_dead: 120 });
      batch[3] = bad;
      const first = await call('POST', '/records/batch', 'u_field_03', { records: batch });
      expect(first.status).toBe(200);
      expect(first.body.results.filter((x: { status: string }) => x.status === 'accepted')).toHaveLength(9);
      expect(first.body.results[3]).toMatchObject({
        record_id: bad.record_id, status: 'rejected',
        errors: [{ rule: 'n_dead_gt_n_exposed', field: 'n_dead',
          message: 'n_dead (120) is more than n_exposed (100). Correct the number of dead mosquitoes.' }],
      });
      expect((await owner.query(`SELECT count(*)::int n FROM field_records WHERE record_id = $1`, [bad.record_id])).rows[0].n).toBe(0);

      // it shows up under "needs attention" for the worker
      const attn = await call('GET', '/records/attention', 'u_field_03');
      expect(attn.body.records.map((x: { record_id: string }) => x.record_id)).toContain(bad.record_id);

      const fixed = await call('POST', '/records/batch', 'u_field_03', { records: [{ ...bad, n_dead: 60 }] });
      expect(fixed.body.results[0]).toMatchObject({ record_id: bad.record_id, status: 'accepted' });
      const after = await call('GET', '/records/attention', 'u_field_03');
      expect(after.body.records.map((x: { record_id: string }) => x.record_id)).not.toContain(bad.record_id);

      // every attempt, including the rejected one with its errors, is in the sync log
      const log = await owner.query(`SELECT status::text, errors FROM sync_batch_items WHERE record_id = $1 ORDER BY id`, [bad.record_id]);
      expect(log.rows.map((x) => x.status)).toEqual(['rejected', 'accepted']);
      expect(log.rows[0].errors[0].rule).toBe('n_dead_gt_n_exposed');
    });

    it('keeps the payload as received and both timestamps', async () => {
      const r = rec({ extra_client_field: 'kept' });
      await call('POST', '/records/batch', 'u_field_03', { records: [r] });
      const row = (await owner.query(`SELECT payload, captured_at, received_at, enrichment_pending FROM field_records WHERE record_id = $1`, [r.record_id])).rows[0];
      expect(row.payload).toEqual(r);
      expect(new Date(row.captured_at).toISOString()).toBe('2026-10-07T09:14:22.000Z');
      expect(row.received_at).toBeInstanceOf(Date);
      expect(row.enrichment_pending).toBe(true);
    });

    it('stores Warn flags with an accepted record (far from LGA, poor accuracy)', async () => {
      const r = rec({ lga: 'Ife Central', ward: 'Ife Central Ward 1', gps_accuracy_m: 18 });
      const res = await call('POST', '/records/batch', 'u_field_03', { records: [r] });
      expect(res.body.results[0].status).toBe('accepted_with_flags');
      const v = await owner.query(`SELECT rule, severity::text FROM validation_results WHERE record_id = $1 ORDER BY rule`, [r.record_id]);
      expect(v.rows).toEqual([{ rule: 'GPS_accuracy_poor', severity: 'warn' }, { rule: 'GPS_far_from_lga', severity: 'warn' }]);
    });

    it('re-validates on the server: a device that skipped its checks is still rejected', async () => {
      const res = await call('POST', '/records/batch', 'u_field_03', {
        records: [rec({ latitude: 0, longitude: 0 }), rec({ gps_accuracy_m: 60 }), rec({ collection_date: '2999-01-01' }), rec({ temp_c: 99 })],
      });
      expect(res.body.results.map((x: { status: string }) => x.status)).toEqual(['rejected', 'rejected', 'rejected', 'rejected']);
    });

    it('only field users may upload', async () => {
      expect((await call('POST', '/records/batch', 'u_vecdim_osun', { records: [rec()] })).status).toBe(403);
      expect((await call('POST', '/records/batch', 'u_field_03', { nope: 1 })).status).toBe(400);
    });
  });

  describe('API: role scope enforced by the database', () => {
    it('a field worker sees only their own records', async () => {
      const mine = await call('GET', '/records?limit=1', 'u_field_03');
      const other = await call('GET', '/records?limit=1', 'u_field_01');
      expect(mine.body.total).toBeGreaterThan(0);
      const lagosOwned = (await owner.query(`SELECT count(*)::int n FROM field_records WHERE owner_user_id = 'u_field_01'`)).rows[0].n;
      expect(other.body.total).toBe(lagosOwned);
      expect(other.body.records.every((x: { owner_user_id: string }) => x.owner_user_id === 'u_field_01')).toBe(true);
    });

    it('a VECDIM user sees only their own state, even when asking for another', async () => {
      const own = await call('GET', '/records?limit=500', 'u_vecdim_osun');
      expect(own.body.records.every((x: { state: string }) => x.state === 'Osun')).toBe(true);
      const other = await call('GET', '/records?state=Kano', 'u_vecdim_osun');
      expect(other.body.total).toBe(0);
      expect(other.body.records).toEqual([]);
    });

    it('UNIOSUN sees all states', async () => {
      const all = await call('GET', '/records?limit=1', 'u_uniosun_01');
      expect(all.body.total).toBeGreaterThanOrEqual(1303);
      const states = new Set((await call('GET', '/alerts', 'u_uniosun_01')).body.alerts.map((a: { state: string }) => a.state));
      expect([...states].sort()).toEqual(['Kano', 'Lagos', 'Osun']);
    });

    it('GET /alerts returns 647 items for UNIOSUN with tier and resistance flag as separate fields', async () => {
      const r = await call('GET', '/alerts', 'u_uniosun_01');
      expect(r.body.count).toBe(647);
      expect(r.body.alerts[0]).toHaveProperty('tier');
      expect(r.body.alerts[0]).toHaveProperty('pyrethroid_resistance_flag');
      const s = await call('GET', '/alerts/summary', 'u_uniosun_01');
      expect(s.body.totals).toEqual({ ALERT: 86, WARNING: 135, WATCH: 426 });
    });

    it('alerts are scoped by state for VECDIM users and hidden from field workers', async () => {
      const osun = await call('GET', '/alerts', 'u_vecdim_osun');
      expect(osun.body.alerts.every((a: { state: string }) => a.state === 'Osun')).toBe(true);
      expect(osun.body.count).toBeGreaterThan(0);
      expect((await call('GET', '/alerts?state=Lagos', 'u_vecdim_osun')).body.count).toBe(0);
      expect((await call('GET', '/alerts', 'u_field_03')).body.count).toBe(0);
    });

    it('filters alerts by tier, LGA and month range', async () => {
      const r = await call('GET', '/alerts?state=Osun&tier=ALERT&from=2023-01&to=2023-12', 'u_uniosun_01');
      expect(r.body.alerts.every((a: { tier: string; state: string; month: string }) => a.tier === 'ALERT' && a.state === 'Osun' && a.month.startsWith('2023'))).toBe(true);
    });

    it('the API role cannot change or delete records, and cannot write outside its role even with raw SQL', async () => {
      const c = await apiPool.connect();
      try {
        await expect(c.query(`DELETE FROM field_records WHERE record_id = 'direct-ok'`)).rejects.toThrow(/permission denied/);
        await expect(c.query(`UPDATE field_records SET ward = ward`)).rejects.toThrow(/permission denied/);
        await c.query('BEGIN');
        await c.query(`SELECT set_config('app.role','vecdim',true), set_config('app.state','Osun',true), set_config('app.user_id','u_vecdim_osun',true)`);
        await expect(c.query(
          `INSERT INTO field_records (record_id, owner_user_id, source, state, lga, ward, latitude, longitude, collection_date, species, insecticide,
             n_exposed, n_dead, mortality_pct, larval_density, urban, irs_covered, itn_use_pct, payload, captured_at)
           VALUES ('rls-bypass','u_vecdim_osun','app','Osun','Osogbo','Osogbo Ward 1',7.77,4.56,'2026-10-01','An. coluzzii','Permethrin',10,5,50,1,0,0,50,'{}',now())`,
        )).rejects.toThrow(/row-level security/);
        await c.query('ROLLBACK');
      } finally {
        c.release();
      }
    });
  });

  // Last, because it adds records and runs the pipeline again. This is the "new data, not only the sample file" check.
  describe('new field data flows through the pipeline', () => {
    const calls: string[] = [];
    let appWithRunner: ReturnType<typeof buildApp>;
    const callR = async (method: 'GET' | 'POST', url: string, user: string, payload?: unknown) => {
      const res = await appWithRunner.inject({ method, url: `/api/v1${url}`, headers: { 'x-user-id': user }, payload: payload as never });
      return { status: res.statusCode, body: res.json() };
    };
    const fakeRunner = {
      run: async () => ({ run_id: 0, status: 'succeeded' as const, n_input: 0, n_dataset: 0, n_app: 0, n_flagged: 0, n_clean: 0, n_alerts: 0, alert_counts: {}, duration_ms: 0 }),
      request: (t: string) => { calls.push(t); },
      isRunning: () => false,
    };
    const newIds: string[] = [];
    let appBefore = 0;
    let run1: RunResult;

    beforeAll(async () => {
      appWithRunner = buildApp({ pool: apiPool, runner: fakeRunner });
      appBefore = (await owner.query(`SELECT count(*)::int n FROM field_records WHERE source = 'app'`)).rows[0].n;
    });
    afterAll(async () => { await appWithRunner?.close(); });

    it('a sync of new records asks for a pipeline run (the trigger), and a rejected-only batch does not', async () => {
      const good = [rec({ n_dead: 77 }), rec({ n_dead: 88 }), rec({ n_dead: 99 })];
      const r = await callR('POST', '/records/batch', 'u_field_03', { records: good });
      expect(r.body.results.map((x: { status: string }) => x.status)).toEqual(['accepted', 'accepted', 'accepted']);
      newIds.push(...good.map((g) => g.record_id));
      expect(calls).toEqual(['sync']);
      const bad = await callR('POST', '/records/batch', 'u_field_03', { records: [rec({ n_dead: 500, n_exposed: 100 })] });
      expect(bad.body.results[0].status).toBe('rejected');
      expect(calls).toEqual(['sync']); // unchanged
    });

    it('the pipeline reads the new records together with the dataset; until enriched they are flagged (missing_core) and kept out of the model', async () => {
      run1 = await runPipeline('sync', pipelineOptions(urlFor(dbName), outputRoot));
      expect(run1.status).toBe('succeeded');
      expect(run1.n_app).toBe(appBefore + 3);
      expect(run1.n_input).toBe(1525 + appBefore + 3);
      // every app record so far has no climate/satellite values, so R flags it: clean stays at the dataset's 1,303
      expect(run1.n_clean).toBe(1303);
      expect(run1.n_flagged).toBe(222 + appBefore + 3);
      const f = await owner.query(`SELECT missing_core, any_flag FROM pipeline_flags WHERE record_id = ANY($1)`, [newIds]);
      expect(f.rows).toHaveLength(3);
      expect(f.rows.every((x) => x.missing_core && x.any_flag)).toBe(true);
      expect((await owner.query(`SELECT count(*)::int n FROM risk_predictions WHERE record_id = ANY($1)`, [newIds])).rows[0].n).toBe(0);
      const latest = await callR('GET', '/analysis/latest', 'u_uniosun_01');
      expect(latest.body.counts.app_records_awaiting_enrichment).toBe(appBefore + 3);
    }, 10 * 60_000);

    it('only national users may enrich; bad values and unknown ids are reported per record', async () => {
      const values = { rainfall_mm: 180.5, temp_c: 27.2, ndvi: 0.52, elevation_m: 310, dist_water_km: 1.4, slide_positivity_pct: 45 };
      expect((await callR('POST', '/enrichment', 'u_field_03', { records: [] })).status).toBe(403);
      expect((await callR('POST', '/enrichment', 'u_vecdim_osun', { records: [] })).status).toBe(403);
      const r = await callR('POST', '/enrichment', 'u_uniosun_01', {
        records: [
          { record_id: newIds[0], ...values },
          { record_id: newIds[1], ...values, slide_positivity_pct: 12 },
          { record_id: newIds[2], ...values, slide_positivity_pct: 38 },
          { record_id: 'no-such-record', ...values },
          { record_id: newIds[0], ...values, temp_c: 99 },
          { record_id: newIds[0], rainfall_mm: 1 },
        ],
      });
      expect(r.body.results.map((x: { status: string }) => x.status)).toEqual(['enriched', 'enriched', 'enriched', 'not_found', 'invalid', 'invalid']);
      expect(calls.at(-1)).toBe('enrichment');
      const row = (await owner.query(`SELECT record_id, high_risk, enrichment_pending FROM field_records WHERE record_id = ANY($1) ORDER BY slide_positivity_pct`, [newIds])).rows;
      expect(row.map((x) => x.high_risk)).toEqual([0, 1, 1]); // slide positivity >= 30 is the pack's definition of high risk
      expect(row.every((x) => x.enrichment_pending === false)).toBe(true);
      // the API role has no UPDATE: the audit columns and the rest of the record are untouched
      expect((await owner.query(`SELECT count(*)::int n FROM field_records WHERE record_id = ANY($1) AND payload ? 'rainfall_mm'`, [newIds])).rows[0].n).toBe(0);
    });

    it('after enrichment the same records pass R\'s rules, enter the model, and appear in risk predictions and alerts', async () => {
      const run2 = await runPipeline('enrichment', pipelineOptions(urlFor(dbName), outputRoot));
      expect(run2.status).toBe('succeeded');
      expect(run2.n_clean).toBe(1303 + 3);
      expect(run2.n_flagged).toBe(222 + appBefore);
      const risk = (await owner.query(`SELECT record_id, p_high, tier::text AS tier FROM risk_predictions WHERE record_id = ANY($1)`, [newIds])).rows;
      expect(risk).toHaveLength(3);
      for (const x of risk) expect(x.p_high >= 0 && x.p_high <= 1).toBe(true);
      const a = (await owner.query(`SELECT n_records, mean_risk, tier::text AS tier FROM alerts WHERE id = 'Osun|Osogbo|2026-10'`)).rows[0];
      expect(a.n_records).toBe(3);
      const expectedTier = a.mean_risk >= 0.7 ? 'ALERT' : a.mean_risk >= 0.5 ? 'WARNING' : 'WATCH';
      expect(a.tier).toBe(expectedTier);
      // role scope applies to the new results too
      const osun = await callR('GET', '/risk-points?bbox=4.4,7.6,4.7,7.9', 'u_vecdim_osun');
      expect(osun.body.points.some((p: { record_id: string }) => p.record_id === newIds[0])).toBe(true);
      expect((await callR('GET', '/risk-points?bbox=4.4,7.6,4.7,7.9', 'u_vecdim_kano')).body.count).toBe(0);
      expect((await callR('GET', '/risk-points?bbox=4.4,7.6,4.7,7.9', 'u_field_03')).status).toBe(403);
      // the run history is kept, with the trigger and R version of each run
      const runs = await callR('GET', '/analysis/runs', 'u_uniosun_01');
      expect(runs.body.runs.some((x: { trigger: string }) => x.trigger === 'enrichment')).toBe(true);
      expect(runs.body.runs[0].r_version).toMatch(/R/);
    }, 10 * 60_000);

    it('a state user sees only their state in the analysis counts; a field worker is refused; a manual run needs UNIOSUN', async () => {
      const all = await callR('GET', '/analysis/latest', 'u_uniosun_01');
      const kano = await callR('GET', '/analysis/latest', 'u_vecdim_kano');
      expect(all.body.counts.records_analysed).toBeGreaterThan(kano.body.counts.records_analysed);
      expect(kano.body.scope).toBe('Kano');
      expect(kano.body.counts.app_records).toBeLessThan(all.body.counts.app_records);
      expect((await callR('GET', '/analysis/latest', 'u_field_01')).status).toBe(403);
      expect((await callR('POST', '/analysis/run', 'u_vecdim_kano')).status).toBe(403);
      expect((await callR('POST', '/analysis/run', 'u_uniosun_01')).status).toBe(202);
      const csv = (user: string) => appWithRunner.inject({ method: 'GET', url: '/api/v1/analysis/files/model_metrics.csv', headers: { 'x-user-id': user } });
      const metrics = await csv('u_uniosun_01');
      expect(metrics.statusCode).toBe(200);
      expect(metrics.headers['content-type']).toMatch(/text\/csv/);
      expect(metrics.body.trim().split('\n')).toHaveLength(5); // header + the four validation settings
      expect((await csv('u_vecdim_kano')).statusCode).toBe(404);
    });

    it('a failed run (R missing) is recorded and leaves the previous results in place', async () => {
      const before = (await owner.query('SELECT count(*)::int n FROM alerts')).rows[0].n;
      const failed = await runPipeline('test', { ...pipelineOptions(urlFor(dbName), outputRoot), rscript: 'definitely-not-r' });
      expect(failed.status).toBe('failed');
      expect(failed.error).toMatch(/Cannot run definitely-not-r/);
      expect((await owner.query('SELECT count(*)::int n FROM alerts')).rows[0].n).toBe(before);
      const last = (await owner.query(`SELECT status::text AS status, error FROM analysis_runs ORDER BY run_id DESC LIMIT 1`)).rows[0];
      expect(last.status).toBe('failed');
    });
  });
});
