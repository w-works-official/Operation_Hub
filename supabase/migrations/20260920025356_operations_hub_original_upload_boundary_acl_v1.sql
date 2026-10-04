-- Restrict Storage verification evidence to the trusted Edge Function service role.
-- Supabase default function privileges include direct anon/authenticated grants,
-- so revoking PUBLIC alone is not sufficient for this RPC.
revoke all on function public.hub_original_upload_intent_uploaded_v1(text,uuid,jsonb) from public, anon, authenticated;
grant execute on function public.hub_original_upload_intent_uploaded_v1(text,uuid,jsonb) to service_role;