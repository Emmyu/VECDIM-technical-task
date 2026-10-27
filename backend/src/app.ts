import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type pg from 'pg';
import { processBatch, type AuthUser, type BatchStore } from './batch';
import { PgStore, withUser } from './db';
import { RULE_COLUMNS, type RunResult, type Trigger } from './pipeline';

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthUser;
  }
}

const MAX_BATCH = 500;

/** What the API needs from the pipeline runner (see pipeline.ts). Left out in unit tests. */
export interface PipelineControl {
  run(trigger: Trigger): Promise<RunResult>;
  request(trigger: Trigger): void;
  isRunning(): boolean;
}

export interface AppDeps {
  pool: pg.Pool;
  store?: BatchStore;
  dashboardDir?: string;
  runner?: PipelineControl;
}

const RECORD_COLUMNS = `
  r.record_id, r.owner_user_id, r.source, r.state, r.lga, r.ward, r.latitude, r.longitude, r.gps_accuracy_m,
  r.collection_date, r.species, r.insecticide, r.n_exposed, r.n_dead, r.mortality_pct, r.larval_density, r.urban,
  r.irs_covered, r.itn_use_pct, r.enrichment_pending, r.captured_at, r.received_at,
  COALESCE((SELECT json_agg(json_build_object('rule', v.rule, 'field', v.field, 'severity', v.severity, 'message', v.message))
            FROM validation_results v WHERE v.record_id = r.record_id), '[]'::json) AS flags`;

/** Query-string value: a non-empty string or null. */
function q(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

function intParam(v: unknown, def: number, max: number): number {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? Math.min(n, max) : def;
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 5 * 1024 * 1024 });
  const { pool } = deps;
  const store = deps.store ?? new PgStore(pool);

  app.register(cors, { origin: true });

  const api = async (r: FastifyInstance) => {
    // Demo authentication: the X-User-Id header names one of the seeded demo users (data/demo_users.csv).
    // Real authentication is out of scope; row-level security still enforces what each role can read.
    const authenticate = async (req: FastifyRequest, reply: FastifyReply) => {
      const id = req.headers['x-user-id'];
      if (typeof id !== 'string' || !id) return reply.code(401).send({ error: 'Missing X-User-Id header. Pick a demo user.' });
      const res = await pool.query('SELECT user_id, role, state FROM users WHERE user_id = $1', [id]);
      if (res.rowCount === 0) return reply.code(401).send({ error: `Unknown user ${id}` });
      req.user = res.rows[0] as AuthUser;
    };

    r.get('/health', async () => ({ status: 'ok' }));

    // Public list of demo users for the role switcher
    r.get('/users', async () => {
      const res = await pool.query('SELECT user_id, name, role, state FROM users ORDER BY role, user_id');
      return { users: res.rows };
    });

    r.get('/me', { preHandler: authenticate }, async (req) => req.user);

    r.post('/records/batch', { preHandler: authenticate }, async (req, reply) => {
      const user = req.user!;
      if (user.role !== 'field') return reply.code(403).send({ error: 'Only field users can upload records.' });
      const body = req.body as { records?: unknown; device_id?: unknown } | null;
      if (!body || !Array.isArray(body.records)) return reply.code(400).send({ error: 'Body must be {"records": [...]}.' });
      if (body.records.length > MAX_BATCH) return reply.code(413).send({ error: `At most ${MAX_BATCH} records per batch.` });
      const { batch_id, results } = await processBatch(store, user, body.records, {
        deviceId: typeof body.device_id === 'string' ? body.device_id : null,
      });
      // New records change the analysis, so ask for a (debounced) pipeline run
      if (results.some((x) => x.status === 'accepted' || x.status === 'accepted_with_flags')) deps.runner?.request('sync');
      // 200 for a batch that was processed, even if some records were rejected
      return { batch_id, results };
    });

    r.get('/records', { preHandler: authenticate }, async (req) => {
      const qs = req.query as Record<string, unknown>;
      const since = q(qs.since);
      const limit = intParam(qs.limit, 200, 2000);
      const offset = intParam(qs.offset, 0, 1_000_000);
      const rows = await withUser(pool, req.user!, (c) =>
        c.query(
          `SELECT ${RECORD_COLUMNS}, count(*) OVER () AS total
           FROM field_records r
           WHERE ($1::text IS NULL OR r.state = $1) AND ($2::text IS NULL OR r.lga = $2)
             AND ($3::timestamptz IS NULL OR r.received_at > $3::timestamptz)
           ORDER BY r.received_at DESC, r.record_id
           LIMIT $4 OFFSET $5`,
          [q(qs.state), q(qs.lga), since, limit, offset],
        ),
      );
      return { total: rows.rows[0]?.total ?? 0, records: rows.rows.map(({ total: _t, ...rec }) => rec) };
    });

    // Records whose latest upload attempt was rejected and that have not been accepted since
    r.get('/records/attention', { preHandler: authenticate }, async (req) => {
      const rows = await withUser(pool, req.user!, (c) =>
        c.query(
          `SELECT * FROM (
             SELECT DISTINCT ON (record_id) record_id, user_id, status, errors, flags, payload, received_at, batch_id
             FROM sync_batch_items ORDER BY record_id, id DESC) latest
           WHERE status = 'rejected' ORDER BY received_at DESC`,
        ),
      );
      return { records: rows.rows };
    });

    r.get('/sync/batches', { preHandler: authenticate }, async (req) => {
      const rows = await withUser(pool, req.user!, (c) =>
        c.query(`SELECT * FROM sync_batches ORDER BY received_at DESC LIMIT 50`),
      );
      return { batches: rows.rows };
    });

    r.get('/alerts', { preHandler: authenticate }, async (req) => {
      const qs = req.query as Record<string, unknown>;
      const month = (v: unknown) => q(v)?.slice(0, 7) ?? null; // accepts YYYY-MM or YYYY-MM-DD
      const rows = await withUser(pool, req.user!, (c) =>
        c.query(
          `SELECT id, state, lga, month, n_records, mean_risk, tier, pyrethroid_resistance_flag, mean_pyrethroid_mort
           FROM alerts
           WHERE ($1::text IS NULL OR state = $1) AND ($2::text IS NULL OR lga = $2)
             AND ($3::text IS NULL OR month >= $3) AND ($4::text IS NULL OR month <= $4)
             AND ($5::text IS NULL OR tier::text = $5)
             AND ($6::boolean IS NULL OR pyrethroid_resistance_flag = $6)
           ORDER BY month DESC, state, lga`,
          [q(qs.state), q(qs.lga), month(qs.from), month(qs.to), q(qs.tier)?.toUpperCase() ?? null,
            qs.resistance === 'true' ? true : qs.resistance === 'false' ? false : null],
        ),
      );
      return { count: rows.rowCount, alerts: rows.rows };
    });

    // Counts by tier (and by state), scoped to what the caller may see
    r.get('/alerts/summary', { preHandler: authenticate }, async (req) => {
      const rows = await withUser(pool, req.user!, (c) =>
        c.query(
          `SELECT state, tier, count(*)::int AS n, count(*) FILTER (WHERE pyrethroid_resistance_flag)::int AS resistance_flagged
           FROM alerts GROUP BY state, tier ORDER BY state, tier`,
        ),
      );
      const totals: Record<string, number> = { ALERT: 0, WARNING: 0, WATCH: 0 };
      for (const row of rows.rows) totals[row.tier] += row.n;
      return { totals, by_state: rows.rows };
    });

    // ---- Analysis pipeline (the pack's R code, run by the backend) -----------------------------------------
    const ruleSums = RULE_COLUMNS.map((c) => `count(*) FILTER (WHERE ${c.toLowerCase()})::int AS "${c}"`).join(', ');
    const notForField = (user: AuthUser, reply: FastifyReply) =>
      user.role === 'field' ? reply.code(403).send({ error: 'Analysis results are for VECDIM and UNIOSUN users.' }) : null;

    // Latest run, plus counts of what it produced for the part of the data the caller may see
    r.get('/analysis/latest', { preHandler: authenticate }, async (req, reply) => {
      const denied = notForField(req.user!, reply);
      if (denied) return denied;
      return withUser(pool, req.user!, async (c) => {
        const last = await c.query(
          `SELECT run_id, trigger, status, started_at, finished_at, duration_ms, ref_date, r_version, error
           FROM analysis_runs ORDER BY run_id DESC LIMIT 1`);
        const ok = await c.query(
          `SELECT run_id, trigger, started_at, finished_at, duration_ms, ref_date, r_version
           FROM analysis_runs WHERE status = 'succeeded' ORDER BY run_id DESC LIMIT 1`);
        const f = (await c.query(`SELECT count(*)::int AS records, count(*) FILTER (WHERE any_flag)::int AS flagged, ${ruleSums} FROM pipeline_flags`))
          .rows[0] as Record<string, number>;
        const alertCounts: Record<string, number> = { ALERT: 0, WARNING: 0, WATCH: 0 };
        for (const t of (await c.query(`SELECT tier::text, count(*)::int AS n FROM alerts GROUP BY tier`)).rows) alertCounts[t.tier as string] = t.n as number;
        const risk = (await c.query(`SELECT count(*)::int AS n FROM risk_predictions`)).rows[0].n as number;
        const app = (await c.query(
          `SELECT count(*)::int AS n, count(*) FILTER (WHERE enrichment_pending)::int AS pending FROM field_records WHERE source = 'app'`)).rows[0];
        return {
          running: deps.runner?.isRunning() ?? false,
          latest_run: last.rows[0] ?? null,
          last_successful_run: ok.rows[0] ?? null,
          scope: req.user!.role === 'uniosun' ? 'all states' : req.user!.state,
          counts: {
            records_analysed: f.records, flagged: f.flagged, clean: f.records - f.flagged, risk_predictions: risk, alerts: alertCounts,
            app_records: app.n, app_records_awaiting_enrichment: app.pending,
          },
          rules: Object.fromEntries(RULE_COLUMNS.map((c) => [c, f[c]])),
        };
      });
    });

    r.get('/analysis/runs', { preHandler: authenticate }, async (req, reply) => {
      const denied = notForField(req.user!, reply);
      if (denied) return denied;
      const rows = await withUser(pool, req.user!, (c) =>
        c.query(`SELECT run_id, trigger, status, started_at, finished_at, duration_ms, ref_date, r_version, error
                 FROM analysis_runs ORDER BY run_id DESC LIMIT 20`));
      return { runs: rows.rows };
    });

    // Ask for a run now (national users). Answers at once; the run itself takes a minute or two.
    r.post('/analysis/run', { preHandler: authenticate }, async (req, reply) => {
      if (req.user!.role !== 'uniosun') return reply.code(403).send({ error: 'Only national (UNIOSUN) users can start an analysis run.' });
      if (!deps.runner) return reply.code(503).send({ error: 'The analysis pipeline is not configured on this server.' });
      const already = deps.runner.isRunning();
      void deps.runner.run('manual').catch(() => undefined);
      return reply.code(202).send({ status: already ? 'already_running_will_run_again' : 'started' });
    });

    // The small result files of the latest run (model metrics, variable importance, descriptive tables)
    r.get('/analysis/files/:name', { preHandler: authenticate }, async (req, reply) => {
      const name = (req.params as { name: string }).name;
      const rows = await withUser(pool, req.user!, (c) => c.query(`SELECT content FROM analysis_files WHERE name = $1`, [name]));
      if (rows.rowCount === 0) return reply.code(404).send({ error: 'No such file, or you may not read it.' });
      return reply.type('text/csv').send(rows.rows[0].content);
    });

    // Enrichment: the server adds climate, satellite and health-facility values to app records.
    // National users only; a database function (not a table UPDATE grant) does the write.
    r.post('/enrichment', { preHandler: authenticate }, async (req, reply) => {
      if (req.user!.role !== 'uniosun') return reply.code(403).send({ error: 'Only national (UNIOSUN) users can enrich records.' });
      const body = req.body as { records?: unknown } | null;
      if (!body || !Array.isArray(body.records)) return reply.code(400).send({ error: 'Body must be {"records": [...]}.' });
      if (body.records.length > MAX_BATCH) return reply.code(413).send({ error: `At most ${MAX_BATCH} records per request.` });
      const FIELDS = ['rainfall_mm', 'temp_c', 'ndvi', 'elevation_m', 'dist_water_km', 'slide_positivity_pct'] as const;
      const results: Array<{ record_id: string; status: 'enriched' | 'not_found' | 'invalid'; error?: string }> = [];
      await withUser(pool, req.user!, async (c) => {
        for (const item of body.records as Array<Record<string, unknown>>) {
          const id = typeof item?.record_id === 'string' ? item.record_id : '';
          const bad = FIELDS.filter((f) => typeof item?.[f] !== 'number' || !Number.isFinite(item[f] as number));
          if (!id || bad.length > 0) {
            results.push({ record_id: id, status: 'invalid', error: id ? `Missing or non-numeric: ${bad.join(', ')}` : 'record_id is required' });
            continue;
          }
          await c.query('SAVEPOINT one');
          try {
            const res = await c.query(`SELECT apply_enrichment($1,$2,$3,$4,$5,$6,$7) AS ok`, [id, ...FIELDS.map((f) => item[f])]);
            await c.query('RELEASE SAVEPOINT one');
            results.push({ record_id: id, status: res.rows[0].ok ? 'enriched' : 'not_found' });
          } catch (e) {
            await c.query('ROLLBACK TO SAVEPOINT one');
            const err = e as { code?: string; message?: string };
            if (err.code === '23514' || err.code?.startsWith('22')) results.push({ record_id: id, status: 'invalid', error: err.message });
            else throw e;
          }
        }
      });
      if (results.some((x) => x.status === 'enriched')) deps.runner?.request('enrichment');
      return { results };
    });

    // Bonus: risk predictions inside a bounding box (PostGIS, GiST index on geom)
    r.get('/risk-points', { preHandler: authenticate }, async (req, reply) => {
      const denied = notForField(req.user!, reply);
      if (denied) return denied;
      const parts = String((req.query as Record<string, unknown>).bbox ?? '').split(',').map(Number);
      if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return reply.code(400).send({ error: 'bbox must be minLon,minLat,maxLon,maxLat' });
      const rows = await withUser(pool, req.user!, (c) =>
        c.query(
          `SELECT record_id, state, lga, ward, latitude, longitude, collection_date, p_high, tier::text AS tier
           FROM risk_predictions WHERE geom && ST_MakeEnvelope($1, $2, $3, $4, 4326) ORDER BY p_high DESC LIMIT 2000`, parts));
      return { count: rows.rowCount, points: rows.rows };
    });
  };

  app.register(api, { prefix: '/api/v1' });

  // Static dashboard (plain HTML + JS, no build step)
  const dir = deps.dashboardDir ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../dashboard');
  if (existsSync(dir)) {
    app.register(fastifyStatic, { root: dir, prefix: '/dashboard/' });
    app.get('/', async (_req, reply) => reply.redirect('/dashboard/'));
  }

  app.setErrorHandler((error: Error & { statusCode?: number }, _req, reply) => {
    const status = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;
    if (status >= 500) console.error(error);
    reply.code(status).send({ error: status >= 500 ? 'Internal server error' : error.message });
  });

  return app;
}
