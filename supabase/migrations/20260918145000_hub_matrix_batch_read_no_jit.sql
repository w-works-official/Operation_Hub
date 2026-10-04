-- Read-only wrappers: existing row bounds, RLS and session guards remain in the called RPCs.
ALTER FUNCTION operations_private.hub_matrix_shadow_payload_batch_v1(text,jsonb) SET jit TO 'off';

CREATE OR REPLACE FUNCTION public.load_operations_hub_matrix_metadata_batch_v1(p_skus text[])
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER
SET search_path TO 'pg_catalog' SET jit TO 'off'
AS $$ SELECT public.load_operations_hub_matrix_metadata_v1(p_skus) $$;
REVOKE ALL ON FUNCTION public.load_operations_hub_matrix_metadata_batch_v1(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.load_operations_hub_matrix_metadata_batch_v1(text[]) TO anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.hub_matrix_input_fingerprints_batch_v1(p_session_token text,p_skus text[],p_source text)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER
SET search_path TO 'pg_catalog' SET jit TO 'off'
AS $$ SELECT public.hub_input_fingerprints_v1(p_session_token,p_skus,p_source) $$;
REVOKE ALL ON FUNCTION public.hub_matrix_input_fingerprints_batch_v1(text,text[],text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.hub_matrix_input_fingerprints_batch_v1(text,text[],text) TO anon,authenticated,service_role;
