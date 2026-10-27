-- Migration 004: the analysis pipeline (the pack's R code, run by the backend itself).
--
--   raw_entomology   the dataset exactly as supplied, bad rows included (the R code is what finds them)
--   field_records    (existing) records uploaded by the app
--        |  both are exported to one CSV in the pack's column layout and handed to R
--        v
--   analysis_runs    one row per run: trigger, status, counts, R version, log
--   pipeline_flags   R's validation_flags_all.csv     (latest run)
--   risk_predictions R's risk_predictions.csv         (latest run)
--   alerts           R's alerts.csv                   (latest run; table from migration 001)
--   analysis_files   R's small CSV outputs: model metrics, variable importance, descriptive tables (latest run)
--
-- The tables hold the latest run's results; the history of runs lives in analysis_runs.

-- ---------------------------------------------------------------------------
-- Staging table for the supplied dataset. No constraints on purpose: it must be able to hold the rows
-- the validation rules are meant to catch (GPS 0,0, dead > exposed, future dates, missing values).
-- ---------------------------------------------------------------------------
CREATE TABLE raw_entomology (
  seq                  bigserial PRIMARY KEY,   -- file order: R's random forest depends on row order
  record_id            text NOT NULL UNIQUE,
  state                text, lga text, ward text,
  latitude             double precision, longitude double precision,
  collection_date      date,
  species              text, insecticide text,
  n_exposed            integer, n_dead integer, mortality_pct double precision,
  larval_density       integer,
  rainfall_mm          double precision, temp_c double precision, ndvi double precision,
  elevation_m          double precision, dist_water_km double precision,
  urban                integer,
  itn_use_pct          double precision,
  irs_covered          integer,
  slide_positivity_pct double precision,
  high_risk            integer,
  loaded_at            timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Runs
-- ---------------------------------------------------------------------------
CREATE TYPE run_status AS ENUM ('running', 'succeeded', 'failed');

CREATE TABLE analysis_runs (
  run_id        bigserial PRIMARY KEY,
  trigger       text NOT NULL CHECK (trigger IN ('startup', 'sync', 'enrichment', 'schedule', 'manual', 'test')),
  status        run_status NOT NULL DEFAULT 'running',
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  duration_ms   integer,
  ref_date      date,                  -- the date the future_date rule was judged against
  n_input       integer,               -- rows given to R (dataset + app records)
  n_dataset     integer,
  n_app         integer,
  n_flagged     integer,
  n_clean       integer,
  n_alerts      integer,
  alert_counts  jsonb,
  r_version     text,
  input_sha256  text,                  -- hash of the CSV given to R: same data, same hash
  output_dir    text,
  log           text,
  error         text
);
CREATE INDEX analysis_runs_started_idx ON analysis_runs (started_at DESC);

-- ---------------------------------------------------------------------------
-- Results of the latest successful run
-- ---------------------------------------------------------------------------
CREATE TABLE pipeline_flags (
  record_id            text PRIMARY KEY,
  run_id               bigint NOT NULL REFERENCES analysis_runs (run_id),
  state                text,
  lga                  text,
  gps_outside_nigeria  boolean NOT NULL,
  gps_zero_zero        boolean NOT NULL,
  gps_state_mismatch   boolean NOT NULL,
  gps_far_from_lga     boolean NOT NULL,
  n_dead_gt_n_exposed  boolean NOT NULL,
  positivity_out_range boolean NOT NULL,
  future_date          boolean NOT NULL,
  temp_implausible     boolean NOT NULL,
  rainfall_implausible boolean NOT NULL,
  duplicate            boolean NOT NULL,
  missing_core         boolean NOT NULL,
  any_flag             boolean NOT NULL
);
CREATE INDEX pipeline_flags_state_idx ON pipeline_flags (state, any_flag);

CREATE TABLE risk_predictions (
  record_id       text PRIMARY KEY,
  run_id          bigint NOT NULL REFERENCES analysis_runs (run_id),
  state           text NOT NULL,
  lga             text NOT NULL,
  ward            text,
  latitude        double precision NOT NULL,
  longitude       double precision NOT NULL,
  collection_date date NOT NULL,
  p_high          double precision NOT NULL CHECK (p_high BETWEEN 0 AND 1),
  tier            alert_tier NOT NULL,
  geom            geometry(Point, 4326) GENERATED ALWAYS AS (ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)) STORED,
  CONSTRAINT risk_tier_matches CHECK (
    (tier = 'ALERT' AND p_high >= 0.70) OR (tier = 'WARNING' AND p_high >= 0.50 AND p_high < 0.70) OR (tier = 'WATCH' AND p_high < 0.50))
);
CREATE INDEX risk_predictions_geom_gix ON risk_predictions USING gist (geom);
CREATE INDEX risk_predictions_state_idx ON risk_predictions (state, lga);

CREATE TABLE analysis_files (
  name    text PRIMARY KEY,                -- e.g. model_metrics.csv
  run_id  bigint NOT NULL REFERENCES analysis_runs (run_id),
  content text NOT NULL
);

ALTER TABLE alerts ADD COLUMN run_id bigint REFERENCES analysis_runs (run_id);

-- ---------------------------------------------------------------------------
-- Access: the API role may only read. The pipeline writes as the table owner.
-- ---------------------------------------------------------------------------
-- Column-level grant: state users may see that a run happened, not the national counts in it
-- (those they get from the scoped tables below).
GRANT SELECT (run_id, trigger, status, started_at, finished_at, duration_ms, ref_date, r_version, error) ON analysis_runs TO vecdim_api;
GRANT SELECT ON pipeline_flags, risk_predictions, analysis_files TO vecdim_api;

ALTER TABLE pipeline_flags ENABLE ROW LEVEL SECURITY;
CREATE POLICY pipeline_flags_read ON pipeline_flags FOR SELECT TO vecdim_api USING (
  app_role_now() = 'uniosun' OR (app_role_now() = 'vecdim' AND state = app_state_now())
);

ALTER TABLE risk_predictions ENABLE ROW LEVEL SECURITY;
CREATE POLICY risk_predictions_read ON risk_predictions FOR SELECT TO vecdim_api USING (
  app_role_now() = 'uniosun' OR (app_role_now() = 'vecdim' AND state = app_state_now())
);

ALTER TABLE analysis_files ENABLE ROW LEVEL SECURITY;
CREATE POLICY analysis_files_read ON analysis_files FOR SELECT TO vecdim_api USING (app_role_now() = 'uniosun');

ALTER TABLE analysis_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY analysis_runs_read ON analysis_runs FOR SELECT TO vecdim_api USING (app_role_now() IN ('uniosun', 'vecdim'));

-- ---------------------------------------------------------------------------
-- Enrichment: the server adds climate, satellite and health-facility values to app records
-- (field form spec, "Added by the server"). The API role has no UPDATE on field_records, so the
-- only way in is this function, which checks the caller's role and touches only those columns.
-- ---------------------------------------------------------------------------
CREATE FUNCTION apply_enrichment(
  p_record_id text, p_rainfall_mm double precision, p_temp_c double precision, p_ndvi double precision,
  p_elevation_m double precision, p_dist_water_km double precision, p_slide_positivity_pct double precision
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF app_role_now() IS DISTINCT FROM 'uniosun' THEN
    RAISE EXCEPTION 'only national (uniosun) users may enrich records' USING ERRCODE = '42501';
  END IF;
  UPDATE field_records
     SET rainfall_mm = p_rainfall_mm, temp_c = p_temp_c, ndvi = p_ndvi, elevation_m = p_elevation_m,
         dist_water_km = p_dist_water_km, slide_positivity_pct = p_slide_positivity_pct,
         high_risk = CASE WHEN p_slide_positivity_pct >= 30 THEN 1 ELSE 0 END   -- the pack's target definition
   WHERE record_id = p_record_id AND source = 'app';
  RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION apply_enrichment(text, double precision, double precision, double precision, double precision, double precision, double precision) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION apply_enrichment(text, double precision, double precision, double precision, double precision, double precision, double precision) TO vecdim_api;
