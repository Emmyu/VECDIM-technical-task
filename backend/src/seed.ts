import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { parseCsv } from '@vecdim/validator';

const here = dirname(fileURLToPath(import.meta.url));

const TEXT = ['record_id', 'state', 'lga', 'ward', 'collection_date', 'species', 'insecticide'] as const;
const NUMBER = [
  'latitude', 'longitude', 'n_exposed', 'n_dead', 'mortality_pct', 'larval_density', 'rainfall_mm', 'temp_c', 'ndvi',
  'elevation_m', 'dist_water_km', 'urban', 'itn_use_pct', 'irs_covered', 'slide_positivity_pct', 'high_risk',
] as const;

/** One CSV row -> one raw_entomology row. "NA" and empty cells become null; nothing is judged or fixed here. */
export function datasetRow(row: Record<string, string>): Record<string, string | number | null> {
  const out: Record<string, string | number | null> = {};
  for (const c of TEXT) out[c] = row[c] === undefined || row[c] === '' || row[c] === 'NA' ? null : row[c];
  for (const c of NUMBER) out[c] = row[c] === undefined || row[c] === '' || row[c] === 'NA' ? null : Number(row[c]);
  return out;
}

/**
 * Loads the reference data the system starts from: the demo users and the supplied dataset, exactly as
 * supplied (the 1,525 rows, bad ones included). It does NOT load any validation, risk or alert files:
 * the pipeline (R code, run by the backend) produces those. Safe to run again.
 */
export async function seed(databaseUrl: string, seedDir: string, log: (s: string) => void = console.log) {
  const read = (f: string) => parseCsv(readFileSync(resolve(seedDir, f), 'utf8'));
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  const counts = { users: 0, dataset: 0 };
  try {
    await client.query('BEGIN');

    for (const u of read('demo_users.csv')) {
      const r = await client.query(
        `INSERT INTO users (user_id, name, role, state) VALUES ($1, $2, $3::app_role, NULLIF($4, '')) ON CONFLICT DO NOTHING`,
        [u.user_id, u.name, u.role, u.state],
      );
      counts.users += r.rowCount ?? 0;
    }

    // seq is a serial, so rows keep the file's order (R's random forest depends on it)
    const rows = read('vecdim_dummy_entomology_data.csv').map((r, i) => ({ n: i + 1, ...datasetRow(r) }));
    const r = await client.query(
      `INSERT INTO raw_entomology (record_id, state, lga, ward, latitude, longitude, collection_date, species, insecticide, n_exposed, n_dead,
         mortality_pct, larval_density, rainfall_mm, temp_c, ndvi, elevation_m, dist_water_km, urban, itn_use_pct, irs_covered,
         slide_positivity_pct, high_risk)
       SELECT x.record_id, x.state, x.lga, x.ward, x.latitude, x.longitude, x.collection_date, x.species, x.insecticide, x.n_exposed, x.n_dead,
         x.mortality_pct, x.larval_density, x.rainfall_mm, x.temp_c, x.ndvi, x.elevation_m, x.dist_water_km, x.urban, x.itn_use_pct, x.irs_covered,
         x.slide_positivity_pct, x.high_risk
       FROM jsonb_to_recordset($1::jsonb) AS x(n integer, record_id text, state text, lga text, ward text, latitude double precision,
         longitude double precision, collection_date date, species text, insecticide text, n_exposed integer, n_dead integer,
         mortality_pct double precision, larval_density integer, rainfall_mm double precision, temp_c double precision, ndvi double precision,
         elevation_m double precision, dist_water_km double precision, urban integer, itn_use_pct double precision, irs_covered integer,
         slide_positivity_pct double precision, high_risk integer)
       ORDER BY x.n
       ON CONFLICT (record_id) DO NOTHING`,
      [JSON.stringify(rows)],
    );
    counts.dataset = r.rowCount ?? 0;

    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    await client.end();
  }
  log(`seed: loaded ${counts.users} users and ${counts.dataset} dataset rows (0 means already loaded). The pipeline produces the results.`);
  return counts;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  seed(url, process.env.SEED_DIR ?? resolve(here, '../../seed')).catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
