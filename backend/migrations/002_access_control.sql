-- Role scope is enforced in the data layer with row-level security, not only in the API.
-- The API connects as `vecdim_api` (not the table owner, so RLS applies) and, in every transaction, sets
--   app.user_id / app.role / app.state
-- with set_config(..., true). The migration/seed user is the table owner and bypasses RLS.
-- Dev-only password; override with the DB role settings in production.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vecdim_api') THEN
    CREATE ROLE vecdim_api LOGIN PASSWORD 'vecdim_api';
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO vecdim_api;
GRANT SELECT ON users, lgas, alerts TO vecdim_api;
GRANT SELECT, INSERT ON field_records, validation_results, sync_batch_items TO vecdim_api;
GRANT SELECT, INSERT, UPDATE ON sync_batches TO vecdim_api;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO vecdim_api;
-- field_records and validation_results are append-only for the API: no UPDATE or DELETE grants.

CREATE FUNCTION app_role_now() RETURNS text LANGUAGE sql STABLE AS $$ SELECT current_setting('app.role', true) $$;
CREATE FUNCTION app_state_now() RETURNS text LANGUAGE sql STABLE AS $$ SELECT current_setting('app.state', true) $$;
CREATE FUNCTION app_user_now() RETURNS text LANGUAGE sql STABLE AS $$ SELECT current_setting('app.user_id', true) $$;

-- field_records
ALTER TABLE field_records ENABLE ROW LEVEL SECURITY;
CREATE POLICY field_records_read ON field_records FOR SELECT TO vecdim_api USING (
  app_role_now() = 'uniosun'
  OR (app_role_now() = 'vecdim' AND state = app_state_now())
  OR (app_role_now() = 'field' AND owner_user_id = app_user_now())
);
CREATE POLICY field_records_write ON field_records FOR INSERT TO vecdim_api WITH CHECK (
  app_role_now() = 'field' AND owner_user_id = app_user_now() AND source = 'app'
);

-- validation_results: visible exactly when the record is visible
ALTER TABLE validation_results ENABLE ROW LEVEL SECURITY;
CREATE POLICY validation_results_read ON validation_results FOR SELECT TO vecdim_api USING (
  EXISTS (SELECT 1 FROM field_records fr WHERE fr.record_id = validation_results.record_id)
);
CREATE POLICY validation_results_write ON validation_results FOR INSERT TO vecdim_api WITH CHECK (
  EXISTS (SELECT 1 FROM field_records fr WHERE fr.record_id = validation_results.record_id)
);

-- sync batches and their items: a field worker sees their own, a state user sees their state's, national sees all
ALTER TABLE sync_batches ENABLE ROW LEVEL SECURITY;
CREATE POLICY sync_batches_read ON sync_batches FOR SELECT TO vecdim_api USING (
  app_role_now() = 'uniosun'
  OR (app_role_now() = 'field' AND user_id = app_user_now())
  OR (app_role_now() = 'vecdim' AND EXISTS (SELECT 1 FROM users u WHERE u.user_id = sync_batches.user_id AND u.state = app_state_now()))
);
CREATE POLICY sync_batches_insert ON sync_batches FOR INSERT TO vecdim_api WITH CHECK (
  app_role_now() = 'field' AND user_id = app_user_now()
);
CREATE POLICY sync_batches_update ON sync_batches FOR UPDATE TO vecdim_api
  USING (app_role_now() = 'field' AND user_id = app_user_now())
  WITH CHECK (app_role_now() = 'field' AND user_id = app_user_now());

ALTER TABLE sync_batch_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY sync_batch_items_read ON sync_batch_items FOR SELECT TO vecdim_api USING (
  app_role_now() = 'uniosun'
  OR (app_role_now() = 'field' AND user_id = app_user_now())
  OR (app_role_now() = 'vecdim' AND EXISTS (SELECT 1 FROM users u WHERE u.user_id = sync_batch_items.user_id AND u.state = app_state_now()))
);
CREATE POLICY sync_batch_items_insert ON sync_batch_items FOR INSERT TO vecdim_api WITH CHECK (
  app_role_now() = 'field' AND user_id = app_user_now()
);

-- alerts: national sees all states, a state user sees only their state; field workers see none
ALTER TABLE alerts ENABLE ROW LEVEL SECURITY;
CREATE POLICY alerts_read ON alerts FOR SELECT TO vecdim_api USING (
  app_role_now() = 'uniosun'
  OR (app_role_now() = 'vecdim' AND state = app_state_now())
);

-- The duplicate rule has to look at every record in the database, not just the ones the caller may read,
-- so it runs as the function owner. It returns only a boolean, so nothing leaks.
CREATE FUNCTION has_duplicate_record(
  p_record_id text, p_ward text, p_date date, p_species text, p_insecticide text, p_n_exposed integer, p_n_dead integer
) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM field_records
    WHERE record_id <> p_record_id AND ward = p_ward AND collection_date = p_date AND species = p_species
      AND insecticide = p_insecticide AND n_exposed = p_n_exposed AND n_dead = p_n_dead)
$$;
REVOKE ALL ON FUNCTION has_duplicate_record(text, text, date, text, text, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION has_duplicate_record(text, text, date, text, text, integer, integer) TO vecdim_api;
