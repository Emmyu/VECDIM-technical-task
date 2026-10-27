-- An id that exists is "already received" even when the record belongs to another worker, so this lookup
-- runs as the function owner and returns only a boolean.
CREATE FUNCTION record_exists(p_record_id text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM field_records WHERE record_id = p_record_id)
$$;
REVOKE ALL ON FUNCTION record_exists(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION record_exists(text) TO vecdim_api;
