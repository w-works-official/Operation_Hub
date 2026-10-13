-- REVIEW PROPOSAL ONLY. Not a migration; never executed by build or deployment.
-- Queue/staging metadata only. No operational rows, snapshots, prices, links,
-- tags, Picking tables, or source import RPCs are changed by this proposal.
-- Before an approved enablement: audit seller-originals Storage policies so
-- sellpia-sync/ is server-only, require a private bucket, and review retention
-- of abandoned objects after the 2-hour signed-upload capability expires.
begin;
create schema if not exists operations_private;
create table operations_private.sellpia_sync_revision (
  singleton boolean primary key default true check(singleton),
  revision bigint not null default 0
);
insert into operations_private.sellpia_sync_revision(singleton) values(true);
create table operations_private.sellpia_sync_jobs (
  job_id uuid primary key,
  request_id uuid not null unique,
  payload_hash text not null check(payload_hash ~ '^[0-9a-f]{64}$'),
  state text not null check(state in ('queued','collecting','collected','failed','needs_login','cancelled','previewed')),
  worker_id text,
  lease_hash text,
  lease_expires_at timestamptz,
  created_at timestamptz not null,
  body jsonb not null check(jsonb_typeof(body)='object' and body->>'applyProduction'='false' and octet_length(body::text)<=16384),
  check ((state='collecting' and worker_id is not null and lease_hash ~ '^[0-9a-f]{64}$' and lease_expires_at is not null) or
         (state<>'collecting' and lease_hash is null and lease_expires_at is null))
);
create unique index sellpia_sync_one_collecting_global on operations_private.sellpia_sync_jobs((true)) where state='collecting';
create index sellpia_sync_pending on operations_private.sellpia_sync_jobs(created_at,job_id) where state in ('queued','collecting');
create table operations_private.sellpia_sync_artifacts (
  job_id uuid not null references operations_private.sellpia_sync_jobs(job_id),
  ordinal integer not null check(ordinal between 1 and 3),
  path text not null unique,
  name text not null,
  size bigint not null check(size between 1 and 26214400),
  sha256 text not null check(sha256 ~ '^[0-9a-f]{64}$'),
  verified boolean not null default false,
  primary key(job_id,ordinal),
  check(path ~ '^sellpia-sync/[0-9a-f-]{36}/[1-3]\.(csv|xlsx|xls)$')
);
alter table operations_private.sellpia_sync_jobs enable row level security;
alter table operations_private.sellpia_sync_artifacts enable row level security;
alter table operations_private.sellpia_sync_revision enable row level security;
revoke all on operations_private.sellpia_sync_jobs, operations_private.sellpia_sync_artifacts, operations_private.sellpia_sync_revision from public,anon,authenticated;
grant usage on schema operations_private to service_role;
grant select,insert,update on operations_private.sellpia_sync_jobs,operations_private.sellpia_sync_artifacts,operations_private.sellpia_sync_revision to service_role;

-- Private tables need not be added to exposed Data API schemas. This invoker
-- bridge is callable only by the server's service_role. Browser session and
-- worker credential checks happen in the Edge handler before invoking it.
-- RLS has no anon/authenticated policies; service_role retains BYPASSRLS.
create function public.hub_sellpia_sync_queue_v1(p_action text,p_payload jsonb default '{}'::jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_revision bigint; v_guard jsonb; v_job operations_private.sellpia_sync_jobs;
  v_body jsonb; v_file jsonb; v_verified boolean; v_id uuid; v_now timestamptz;
begin
  if current_user <> 'service_role' then raise exception 'server role required' using errcode='42501'; end if;
  if jsonb_typeof(p_payload)<>'object' then raise exception 'invalid payload' using errcode='22023'; end if;
  perform pg_catalog.pg_advisory_xact_lock(713102026);
  select revision into strict v_revision from operations_private.sellpia_sync_revision where singleton;
  v_now:=pg_catalog.clock_timestamp();
  if p_action='read' then
    return jsonb_build_object('revision',v_revision,'now',floor(extract(epoch from v_now)*1000),
      'jobs',coalesce((select jsonb_agg(j.body order by j.created_at,j.job_id)
        from operations_private.sellpia_sync_jobs j
        where j.state in ('queued','collecting')
           or j.job_id=nullif(p_payload->>'jobId','')::uuid
           or j.request_id=nullif(p_payload->>'requestId','')::uuid),'[]'::jsonb));
  end if;
  if p_action<>'apply' or jsonb_typeof(p_payload->'changed')<>'array' or jsonb_array_length(p_payload->'changed') not between 1 and 102 then raise exception 'invalid command' using errcode='22023'; end if;
  if (p_payload->>'expectedRevision')::bigint<>v_revision then raise exception 'queue revision changed' using errcode='40001'; end if;
  v_guard:=p_payload->'leaseGuard';
  if v_guard is not null and jsonb_typeof(v_guard)='object' then
    select * into v_job from operations_private.sellpia_sync_jobs where job_id=(v_guard->>'jobId')::uuid;
    if not found or v_job.state<>'collecting' or v_job.worker_id is distinct from v_guard->>'workerId'
       or v_job.lease_hash is distinct from v_guard->>'leaseHash' or v_job.lease_expires_at<=v_now then
      raise exception 'lease expired or revoked' using errcode='42501';
    end if;
  end if;
  -- Release an expired collector before assigning its replacement, regardless
  -- of the JSON array order; the unique active-collector index stays valid.
  for v_body in select value from jsonb_array_elements(p_payload->'changed') order by (value->>'state'='collecting') loop
    v_id:=(v_body->>'jobId')::uuid;
    if v_body->>'applyProduction' is distinct from 'false' then raise exception 'preview only' using errcode='22023'; end if;
    -- No silent replacement of an immutable idempotency identity.
    if exists(select 1 from operations_private.sellpia_sync_jobs j where j.job_id=v_id and
       (j.request_id<>(v_body->>'requestId')::uuid or j.payload_hash<>v_body->>'payloadHash')) then
      raise exception 'request identity changed' using errcode='22023';
    end if;
    insert into operations_private.sellpia_sync_jobs(job_id,request_id,payload_hash,state,worker_id,lease_hash,lease_expires_at,created_at,body)
      values(v_id,(v_body->>'requestId')::uuid,v_body->>'payloadHash',v_body->>'state',v_body->>'workerId',v_body->>'leaseHash',
       case when v_body->>'leaseExpiresAt' is null then null else to_timestamp((v_body->>'leaseExpiresAt')::double precision/1000) end,
       (v_body->>'createdAt')::timestamptz,v_body)
      on conflict(job_id) do update set state=excluded.state,worker_id=excluded.worker_id,lease_hash=excluded.lease_hash,
        lease_expires_at=excluded.lease_expires_at,body=excluded.body;
    if jsonb_array_length(coalesce(v_body->'manifest','[]'::jsonb))>3 then raise exception 'too many files' using errcode='22023'; end if;
    if coalesce((select sum((x->>'size')::bigint) from jsonb_array_elements(coalesce(v_body->'manifest','[]'::jsonb)) x),0)>62914560 then raise exception 'size limit' using errcode='22023'; end if;
    for v_file in select value from jsonb_array_elements(coalesce(v_body->'manifest','[]'::jsonb)) loop
      if v_file->>'path' <> 'sellpia-sync/'||v_id::text||'/'||(v_file->>'ordinal')||'.'||lower(regexp_replace(v_file->>'name','^.*\.','')) then raise exception 'server path mismatch' using errcode='22023'; end if;
      if exists(select 1 from operations_private.sellpia_sync_artifacts a where a.job_id=v_id and a.ordinal=(v_file->>'ordinal')::integer
        and (a.path<>v_file->>'path' or a.name<>v_file->>'name' or a.size<>(v_file->>'size')::bigint or a.sha256<>v_file->>'sha256')) then
        raise exception 'immutable manifest changed' using errcode='22023';
      end if;
      v_verified:=exists(select 1 from jsonb_array_elements(coalesce(v_body->'verifiedArtifacts','[]'::jsonb)) x
        where x->>'path'=v_file->>'path' and x->>'sha256'=v_file->>'sha256' and x->>'verified'='true');
      insert into operations_private.sellpia_sync_artifacts(job_id,ordinal,path,name,size,sha256,verified)
        values(v_id,(v_file->>'ordinal')::integer,v_file->>'path',v_file->>'name',(v_file->>'size')::bigint,v_file->>'sha256',v_verified)
        on conflict(job_id,ordinal) do update set verified=operations_private.sellpia_sync_artifacts.verified or excluded.verified;
    end loop;
  end loop;
  update operations_private.sellpia_sync_revision set revision=revision+1 where singleton;
  return jsonb_build_object('revision',v_revision+1);
end;
$$;
revoke all on function public.hub_sellpia_sync_queue_v1(text,jsonb) from public,anon,authenticated;
grant execute on function public.hub_sellpia_sync_queue_v1(text,jsonb) to service_role;
commit;

-- Activation prerequisites (separate approval required):
-- [functions.operations-hub-sellpia-sync] verify_jwt = false, because this
-- handler verifies x-operations-hub-session or x-sellpia-sync-worker-token.
-- Edge secrets: SELLPIA_SYNC_WORKER_ID, random SELLPIA_SYNC_WORKER_TOKEN >=32
-- chars, SELLPIA_SYNC_ENABLED=true only after review. Service-role key stays
-- in Edge env; never pass it, an operator session, or Sellpia cookies to runner.
-- Downloads have a 300-second bearer capability; cancellation prevents new
-- signatures but cannot revoke URLs already issued. Upload signatures last
-- 2 hours; expired leases cannot finalize and abandoned objects need retention.
