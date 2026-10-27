-- VECDIM schema, migration 001.
-- PostgreSQL is the system of record: bad, duplicate or out-of-scope data must not get in even if the
-- API is bypassed, so every Block rule that can be a constraint is a constraint here.

CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TYPE app_role AS ENUM ('field', 'vecdim', 'uniosun');
CREATE TYPE alert_tier AS ENUM ('ALERT', 'WARNING', 'WATCH');
CREATE TYPE rule_severity AS ENUM ('block', 'warn');
CREATE TYPE sync_status AS ENUM ('accepted', 'accepted_with_flags', 'rejected', 'already_received');

-- ---------------------------------------------------------------------------
-- Reference data: the 15 pilot LGAs (data/lga_reference.csv). Records point at it with a foreign key,
-- so an unknown state/LGA pair cannot be stored.
-- ---------------------------------------------------------------------------
CREATE TABLE lgas (
  state   text NOT NULL CHECK (state IN ('Lagos', 'Kano', 'Osun')),
  lga     text NOT NULL,
  ref_lat double precision NOT NULL,
  ref_lon double precision NOT NULL,
  max_km  double precision NOT NULL DEFAULT 25,
  PRIMARY KEY (state, lga)
);

INSERT INTO lgas (state, lga, ref_lat, ref_lon) VALUES
  ('Lagos', 'Ikorodu', 6.62, 3.51), ('Lagos', 'Alimosho', 6.60, 3.25), ('Lagos', 'Epe', 6.58, 3.98),
  ('Lagos', 'Badagry', 6.43, 2.88), ('Lagos', 'Eti-Osa', 6.45, 3.60),
  ('Kano', 'Dala', 12.00, 8.52), ('Kano', 'Nasarawa', 12.00, 8.55), ('Kano', 'Gwale', 11.98, 8.49),
  ('Kano', 'Tarauni', 11.97, 8.54), ('Kano', 'Ungogo', 12.05, 8.48),
  ('Osun', 'Osogbo', 7.77, 4.56), ('Osun', 'Ife Central', 7.48, 4.56), ('Osun', 'Ilesa East', 7.62, 4.73),
  ('Osun', 'Iwo', 7.63, 4.18), ('Osun', 'Ede North', 7.74, 4.43);

-- ---------------------------------------------------------------------------
-- Users (demo users from data/demo_users.csv). A VECDIM user is tied to one state.
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  user_id text PRIMARY KEY,
  name    text NOT NULL,
  role    app_role NOT NULL,
  state   text CHECK (state IN ('Lagos', 'Kano', 'Osun')),
  CONSTRAINT vecdim_has_state CHECK (role <> 'vecdim' OR state IS NOT NULL),
  CONSTRAINT uniosun_has_no_state CHECK (role <> 'uniosun' OR state IS NULL)
);

-- ---------------------------------------------------------------------------
-- Sync batches: what each device sent, when, and the outcome of every record in it
-- (including rejected attempts and their errors). Rejected records are not stored in field_records,
-- so this log is where every attempt is kept.
-- ---------------------------------------------------------------------------
CREATE TABLE sync_batches (
  batch_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      text NOT NULL REFERENCES users (user_id),
  device_id    text,
  received_at  timestamptz NOT NULL DEFAULT now(),
  n_records    integer NOT NULL DEFAULT 0 CHECK (n_records >= 0),
  n_accepted   integer NOT NULL DEFAULT 0,
  n_rejected   integer NOT NULL DEFAULT 0,
  n_already    integer NOT NULL DEFAULT 0
);

CREATE TABLE sync_batch_items (
  id          bigserial PRIMARY KEY,
  batch_id    uuid NOT NULL REFERENCES sync_batches (batch_id) ON DELETE CASCADE,
  user_id     text NOT NULL REFERENCES users (user_id),
  position    integer NOT NULL,
  record_id   text NOT NULL,                       -- not a foreign key: rejected records are not stored
  status      sync_status NOT NULL,
  errors      jsonb NOT NULL DEFAULT '[]'::jsonb,  -- Block rules that fired
  flags       jsonb NOT NULL DEFAULT '[]'::jsonb,  -- Warn rules that fired
  payload     jsonb NOT NULL,                      -- exactly as received
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sync_batch_items_record_idx ON sync_batch_items (record_id, id DESC);
CREATE INDEX sync_batch_items_user_idx ON sync_batch_items (user_id, status);

-- ---------------------------------------------------------------------------
-- Field records: one row per submitted form that passed every Block rule.
-- ---------------------------------------------------------------------------
CREATE TABLE field_records (
  record_id       text PRIMARY KEY CHECK (length(record_id) BETWEEN 1 AND 64),  -- unique ID made on the phone
  owner_user_id   text NOT NULL REFERENCES users (user_id),
  source          text NOT NULL DEFAULT 'app' CHECK (source IN ('app', 'seed')),

  state           text NOT NULL,
  lga             text NOT NULL,
  ward            text NOT NULL,
  latitude        double precision NOT NULL,
  longitude       double precision NOT NULL,
  gps_accuracy_m  double precision,
  collection_date date NOT NULL,
  species         text NOT NULL CHECK (species IN ('An. gambiae s.s.', 'An. coluzzii', 'An. arabiensis', 'An. funestus')),
  insecticide     text NOT NULL CHECK (insecticide IN ('Permethrin', 'Deltamethrin', 'Alphacypermethrin', 'Pirimiphos-methyl')),
  n_exposed       integer NOT NULL,
  n_dead          integer NOT NULL,
  mortality_pct   double precision NOT NULL,       -- 100 x n_dead / n_exposed, rounded to 1 decimal (as in R)
  larval_density  integer NOT NULL CHECK (larval_density >= 0),
  urban           smallint NOT NULL CHECK (urban IN (0, 1)),
  irs_covered     smallint NOT NULL CHECK (irs_covered IN (0, 1)),
  itn_use_pct     double precision NOT NULL CHECK (itn_use_pct BETWEEN 0 AND 100),

  -- Added by the server (satellite / climate / health-facility layers); null for new app records
  rainfall_mm          double precision CHECK (rainfall_mm BETWEEN 0 AND 1500),
  temp_c               double precision CHECK (temp_c BETWEEN 10 AND 50),
  ndvi                 double precision,
  elevation_m          double precision,
  dist_water_km        double precision,
  slide_positivity_pct double precision CHECK (slide_positivity_pct BETWEEN 0 AND 100),
  high_risk            smallint CHECK (high_risk IN (0, 1)),
  enrichment_pending   boolean GENERATED ALWAYS AS (ndvi IS NULL OR rainfall_mm IS NULL) STORED,

  -- PostGIS point built from the GPS reading; it cannot disagree with latitude/longitude
  geom geometry(Point, 4326) GENERATED ALWAYS AS (ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)) STORED,

  -- Audit trail
  payload      jsonb NOT NULL,                      -- the record exactly as received
  captured_at  timestamptz NOT NULL,                -- when it was captured on the device
  received_at  timestamptz NOT NULL DEFAULT now(),  -- when the server received it
  batch_id     uuid REFERENCES sync_batches (batch_id),

  CONSTRAINT lga_exists FOREIGN KEY (state, lga) REFERENCES lgas (state, lga),
  CONSTRAINT ward_belongs_to_lga CHECK (ward ~ ' Ward [1-6]$' AND left(ward, length(ward) - 7) = lga),
  CONSTRAINT n_exposed_range CHECK (n_exposed BETWEEN 1 AND 500),
  CONSTRAINT n_dead_not_more_than_exposed CHECK (n_dead >= 0 AND n_dead <= n_exposed),
  CONSTRAINT mortality_matches_counts CHECK (abs(mortality_pct - 100.0 * n_dead / n_exposed) <= 0.0501),
  CONSTRAINT gps_in_nigeria CHECK (latitude BETWEEN 4 AND 14 AND longitude BETWEEN 2.5 AND 15),
  CONSTRAINT gps_not_zero_zero CHECK (NOT (latitude = 0 AND longitude = 0)),
  CONSTRAINT gps_in_chosen_state CHECK (
    CASE state
      WHEN 'Lagos' THEN latitude BETWEEN 6.3 AND 6.8 AND longitude BETWEEN 2.7 AND 4.4
      WHEN 'Kano'  THEN latitude BETWEEN 11.5 AND 12.6 AND longitude BETWEEN 8.0 AND 9.2
      WHEN 'Osun'  THEN latitude BETWEEN 7.0 AND 8.2 AND longitude BETWEEN 4.0 AND 5.0
      ELSE false
    END),
  CONSTRAINT gps_accuracy_usable CHECK (gps_accuracy_m IS NULL OR gps_accuracy_m BETWEEN 0 AND 50)
);

CREATE INDEX field_records_geom_gix ON field_records USING gist (geom);
CREATE INDEX field_records_state_lga_idx ON field_records (state, lga);
CREATE INDEX field_records_owner_idx ON field_records (owner_user_id, received_at DESC);
CREATE INDEX field_records_received_idx ON field_records (received_at);
-- Lookup for the `duplicate` rule
CREATE INDEX field_records_dup_key_idx ON field_records (ward, collection_date, species, insecticide, n_exposed, n_dead);

-- future_date (Block): the date may not be later than today in Nigeria (WAT). A trigger, because it depends on the clock.
CREATE FUNCTION reject_future_collection_date() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.collection_date > (now() AT TIME ZONE 'Africa/Lagos')::date THEN
    RAISE EXCEPTION 'collection_date % is in the future', NEW.collection_date
      USING ERRCODE = '23514', CONSTRAINT = 'no_future_collection_date';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER field_records_no_future_date BEFORE INSERT OR UPDATE OF collection_date ON field_records
  FOR EACH ROW EXECUTE FUNCTION reject_future_collection_date();

-- The audit columns never change after the first write.
CREATE FUNCTION protect_audit_columns() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.payload IS DISTINCT FROM OLD.payload
     OR NEW.captured_at IS DISTINCT FROM OLD.captured_at
     OR NEW.received_at IS DISTINCT FROM OLD.received_at
     OR NEW.record_id IS DISTINCT FROM OLD.record_id THEN
    RAISE EXCEPTION 'payload, captured_at, received_at and record_id are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER field_records_protect_audit BEFORE UPDATE ON field_records
  FOR EACH ROW EXECUTE FUNCTION protect_audit_columns();

-- ---------------------------------------------------------------------------
-- Validation results: one row per record for each rule it triggers (Warn flags on accepted records).
-- ---------------------------------------------------------------------------
CREATE TABLE validation_results (
  id         bigserial PRIMARY KEY,
  record_id  text NOT NULL REFERENCES field_records (record_id) ON DELETE CASCADE,
  rule       text NOT NULL,
  severity   rule_severity NOT NULL,
  field      text NOT NULL,
  message    text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (record_id, rule, field)
);
CREATE INDEX validation_results_rule_idx ON validation_results (rule);

-- ---------------------------------------------------------------------------
-- Alerts: loaded from outputs/alerts.csv (LGA x month). Tier and resistance flag are separate columns;
-- the flag never changes the tier.
-- ---------------------------------------------------------------------------
CREATE TABLE alerts (
  id            text PRIMARY KEY,                 -- 'State|LGA|YYYY-MM'
  state         text NOT NULL,
  lga           text NOT NULL,
  month         text NOT NULL CHECK (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  n_records     integer NOT NULL CHECK (n_records > 0),
  mean_risk     double precision NOT NULL CHECK (mean_risk BETWEEN 0 AND 1),
  tier          alert_tier NOT NULL,
  pyrethroid_resistance_flag boolean NOT NULL,
  mean_pyrethroid_mort       double precision,
  CONSTRAINT alert_lga_exists FOREIGN KEY (state, lga) REFERENCES lgas (state, lga),
  CONSTRAINT alert_id_matches CHECK (id = state || '|' || lga || '|' || month),
  CONSTRAINT tier_matches_risk CHECK (
    (tier = 'ALERT' AND mean_risk >= 0.70) OR
    (tier = 'WARNING' AND mean_risk >= 0.50 AND mean_risk < 0.70) OR
    (tier = 'WATCH' AND mean_risk < 0.50))
);
CREATE INDEX alerts_state_month_idx ON alerts (state, month);
CREATE INDEX alerts_tier_idx ON alerts (tier);
