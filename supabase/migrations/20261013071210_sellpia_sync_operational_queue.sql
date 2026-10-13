-- Operational Sellpia queue. Default disabled; apply only after separately approved configuration.
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
  state text not null check(state in ('queued','collecting','collected','failed','needs_login','cancelled','previewed','applying','db_ready','matrix_failed','complete')),
  worker_id text,
  lease_hash text,
  lease_expires_at timestamptz,
  created_at timestamptz not null,
  body jsonb not null check(jsonb_typeof(body)='object' and body->>'applyProduction'='false' and octet_length(body::text)<=24576),
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

-- An independent DB gate protects automatic imports even if an Edge secret is
-- accidentally enabled. Only a separately approved deployment can change it.
create table operations_private.sellpia_sync_config (
  singleton boolean primary key default true check(singleton),
  apply_enabled boolean not null default false,
  approved_source_fingerprint text check(approved_source_fingerprint ~ '^[0-9a-f]{64}$'),
  max_added_count integer not null default 100 check(max_added_count between 0 and 100000),
  max_added_ratio numeric not null default 0.05 check(max_added_ratio between 0 and 1),
  max_removed_count integer not null default 0 check(max_removed_count between 0 and 100000)
);
insert into operations_private.sellpia_sync_config(singleton) values(true);
create table operations_private.sellpia_sync_workers (
  worker_id text primary key check(worker_id ~ '^[A-Za-z0-9_-]{1,80}$'),
  status text not null check(status in ('connected','needs_login','starting','busy')),
  last_seen_at timestamptz not null default clock_timestamp(), version text
);
create table operations_private.sellpia_sync_apply_scopes (
  job_id uuid primary key references operations_private.sellpia_sync_jobs(job_id),
  token_hash text not null check(token_hash ~ '^[0-9a-f]{64}$'),
  operator_username text not null, baseline_snapshot_id uuid,
  expires_at timestamptz not null, intent_id uuid unique,
  snapshot_id uuid unique, source_fingerprint text not null check(source_fingerprint ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default clock_timestamp()
);
alter table operations_private.sellpia_sync_config enable row level security;
alter table operations_private.sellpia_sync_workers enable row level security;
alter table operations_private.sellpia_sync_apply_scopes enable row level security;
revoke all on operations_private.sellpia_sync_config,operations_private.sellpia_sync_workers,operations_private.sellpia_sync_apply_scopes from public,anon,authenticated;
grant select,insert,update on operations_private.sellpia_sync_config,operations_private.sellpia_sync_workers,operations_private.sellpia_sync_apply_scopes to service_role;

create function operations_private.sellpia_sync_public_job_v1(p_body jsonb)
returns jsonb language sql immutable set search_path=pg_catalog as $$
  select p_body - array['leaseHash','leaseExpiresAt','completedLeaseHash','completedWorkerId','workerId','operatorUsername','payloadHash','manifest','verifiedArtifacts'] || jsonb_build_object('applyProduction',false)
$$;
revoke all on function operations_private.sellpia_sync_public_job_v1(jsonb) from public,anon,authenticated;

-- The Edge validates every custom session with this narrowly scoped bridge.
create function public.hub_sellpia_sync_operator_v1(p_session_token text)
returns jsonb language sql security definer set search_path=pg_catalog as $$
  select operations_private.require_operations_hub_operator_session(p_session_token)
$$;
revoke all on function public.hub_sellpia_sync_operator_v1(text) from public,anon,authenticated;
grant execute on function public.hub_sellpia_sync_operator_v1(text) to service_role;

create function public.hub_sellpia_sync_runtime_v1(p_action text,p_payload jsonb,p_session_token text default null,p_apply_enabled boolean default false)
returns jsonb language plpgsql security definer set search_path=pg_catalog set lock_timeout='5s' as $$
declare
  v_actor jsonb; v_job operations_private.sellpia_sync_jobs%rowtype; v_body jsonb;
  v_scope operations_private.sellpia_sync_apply_scopes%rowtype; v_config operations_private.sellpia_sync_config%rowtype;
  v_worker operations_private.sellpia_sync_workers%rowtype; v_latest uuid; v_intent_status text;
  v_matrix uuid; v_pending boolean; v_state text; v_id uuid; v_jobs jsonb; v_last jsonb; v_active jsonb;
  v_baseline_count integer; v_added integer; v_removed integer; v_token_hash text;
begin
  if jsonb_typeof(p_payload)<>'object' then raise exception using errcode='22023',message='invalid payload'; end if;
  if p_action='hello' then
    if coalesce(p_payload->>'workerId','')!~'^[A-Za-z0-9_-]{1,80}$' or coalesce(p_payload->>'status','') not in ('connected','needs_login','starting','busy')
       or coalesce(p_payload->>'version','')!~'^[A-Za-z0-9._-]{0,64}$' then raise exception using errcode='22023',message='invalid worker health'; end if;
    insert into operations_private.sellpia_sync_workers(worker_id,status,version,last_seen_at)
      values(p_payload->>'workerId',p_payload->>'status',p_payload->>'version',clock_timestamp())
      on conflict(worker_id) do update set status=excluded.status,version=coalesce(excluded.version,operations_private.sellpia_sync_workers.version),last_seen_at=excluded.last_seen_at;
    return jsonb_build_object('recorded',true);
  end if;
  v_actor:=operations_private.require_operations_hub_operator_session(p_session_token);
  if p_action not in ('availability','history','status','apply-init','apply-progress') then raise exception using errcode='22023',message='invalid runtime action'; end if;
  -- All apply paths use the same lock order as completion. Collection CAS uses
  -- only the second lock and never tries to acquire the source-finalizer lock.
  if p_action='apply-init' then perform pg_advisory_xact_lock(hashtextextended('operations_hub_sellpia_patch',0)); end if;
  perform pg_advisory_xact_lock(713102026);
  select * into strict v_config from operations_private.sellpia_sync_config where singleton;
  select matrix_snapshot_id,rebuild_pending into v_matrix,v_pending from public.operations_hub_sellpia_matrix_sync_status limit 1;
  -- Reconcile committed imports after a lost browser response. This never
  -- imports rows or recreates an intent, including when automatic apply is off.
  for v_job in select * from operations_private.sellpia_sync_jobs where state in ('applying','db_ready','matrix_failed','complete') for update loop
    select * into v_scope from operations_private.sellpia_sync_apply_scopes where job_id=v_job.job_id;
    if v_scope.intent_id is null and v_job.state='applying' and v_scope.expires_at<=clock_timestamp() then
      update operations_private.sellpia_sync_jobs set state='failed',body=body||jsonb_build_object('state','failed','phase','import_failed','summary',jsonb_build_object('errorCode','APPLY_SCOPE_EXPIRED'),'updatedAt',clock_timestamp()) where job_id=v_job.job_id;
      update operations_private.sellpia_sync_revision set revision=revision+1 where singleton;
    end if;
    if v_scope.intent_id is not null then
      select i.status into v_intent_status from operations_private.operations_hub_original_upload_intents i where i.intent_id=v_scope.intent_id;
      v_body:=v_job.body||jsonb_build_object('importIntentId',v_scope.intent_id,'applySnapshotId',v_scope.snapshot_id,'importStatus',v_intent_status);
      if v_intent_status='ready' and exists(select 1 from public.sellpia_stock_snapshots where snapshot_id=v_scope.snapshot_id and upload_status='ready') then
        v_state:=case when v_matrix=v_scope.snapshot_id and not coalesce(v_pending,true) then 'complete' when v_job.state='matrix_failed' then 'matrix_failed' else 'db_ready' end;
        v_body:=v_body||jsonb_build_object('state',v_state,'phase',case when v_state='complete' then 'complete' else 'matrix_wait' end,
          'matrixStatus',case when v_state='complete' then 'ready' when v_state='matrix_failed' then 'failed' else 'pending' end);
      elsif v_intent_status in ('aborted','failed','expired') then
        v_body:=v_body||jsonb_build_object('state','failed','phase','import_failed','summary',jsonb_build_object('errorCode','IMPORT_TERMINATED'));
      elsif v_job.state='applying' and v_scope.expires_at<=clock_timestamp() then
        v_body:=v_body||jsonb_build_object('state','failed','phase','import_failed','summary',jsonb_build_object('errorCode','APPLY_SCOPE_EXPIRED'));
      end if;
      if v_body is distinct from v_job.body then
        v_body:=v_body||jsonb_build_object('updatedAt',clock_timestamp());
        update operations_private.sellpia_sync_jobs set body=v_body,state=v_body->>'state' where job_id=v_job.job_id;
        update operations_private.sellpia_sync_revision set revision=revision+1 where singleton;
      end if;
    end if;
  end loop;
  if p_action in ('availability','history') then
    select coalesce(jsonb_agg(operations_private.sellpia_sync_public_job_v1(j.body) order by j.created_at desc),'[]') into v_jobs
      from (select body,created_at from operations_private.sellpia_sync_jobs where body->>'operatorUsername'=v_actor->>'username' order by created_at desc limit 20) j;
    if p_action='history' then return jsonb_build_object('jobs',v_jobs); end if;
    select * into v_worker from operations_private.sellpia_sync_workers order by last_seen_at desc limit 1;
    select operations_private.sellpia_sync_public_job_v1(body) into v_last from operations_private.sellpia_sync_jobs where body->>'operatorUsername'=v_actor->>'username' and state='complete' order by created_at desc limit 1;
    select operations_private.sellpia_sync_public_job_v1(body) into v_active from operations_private.sellpia_sync_jobs where body->>'operatorUsername'=v_actor->>'username' and state in ('queued','collecting','applying','db_ready','matrix_failed') order by created_at desc limit 1;
    return jsonb_build_object('enabled',true,'applyEnabled',p_apply_enabled and v_config.apply_enabled,
      'applicationPolicy',jsonb_build_object('maxAddedCount',v_config.max_added_count,'maxAddedRatio',v_config.max_added_ratio,'maxRemovedCount',v_config.max_removed_count,'approvedSourceFingerprint',v_config.approved_source_fingerprint),
      'runner',jsonb_build_object('online',coalesce(v_worker.last_seen_at>clock_timestamp()-interval '90 seconds',false),'status',case when v_worker.last_seen_at>clock_timestamp()-interval '90 seconds' then v_worker.status else 'offline' end,'lastSeenAt',v_worker.last_seen_at,'workerId',v_worker.worker_id),
      'activeJob',v_active,'lastSuccess',v_last);
  end if;
  v_id:=(p_payload->>'jobId')::uuid;
  select * into v_job from operations_private.sellpia_sync_jobs where job_id=v_id for update;
  if not found then raise exception using errcode='P0002',message='job not found'; end if;
  if v_job.body->>'operatorUsername' is distinct from v_actor->>'username' then raise exception using errcode='42501',message='job owner required'; end if;
  if p_action='status' then return jsonb_build_object('job',operations_private.sellpia_sync_public_job_v1(v_job.body)); end if;
  if p_action='apply-progress' then
    if p_payload->>'state' not in ('matrix_wait','complete','matrix_failed') or v_job.state not in ('db_ready','matrix_failed','complete') then raise exception using errcode='55000',message='snapshot recovery only'; end if;
    if (p_payload->>'snapshotId')::uuid is distinct from (v_job.body->>'applySnapshotId')::uuid then raise exception using errcode='55000',message='snapshot proof mismatch'; end if;
    if p_payload->>'state'='complete' and v_job.state<>'complete' then raise exception using errcode='55000',message='Matrix is not ready'; end if;
    if p_payload->>'state'='matrix_failed' and v_job.state<>'complete' then
      v_body:=v_job.body||jsonb_build_object('state','matrix_failed','matrixStatus','failed','phase','matrix_wait','updatedAt',clock_timestamp());
      update operations_private.sellpia_sync_jobs set state='matrix_failed',body=v_body where job_id=v_id;
      update operations_private.sellpia_sync_revision set revision=revision+1 where singleton;
      return jsonb_build_object('job',operations_private.sellpia_sync_public_job_v1(v_body));
    end if;
    return jsonb_build_object('job',operations_private.sellpia_sync_public_job_v1(v_job.body));
  end if;
  if not p_apply_enabled or not v_config.apply_enabled then raise exception using errcode='55000',message='APPLY_DISABLED'; end if;
  if v_job.state not in ('previewed','applying','db_ready','matrix_failed','complete') then raise exception using errcode='55000',message='validated preview required'; end if;
  if coalesce(v_job.body->'receipt'->>'valid','false')<>'true' or v_job.body->'receipt'->>'sourceFingerprint' is distinct from p_payload->>'sourceFingerprint' then raise exception using errcode='22023',message='source fingerprint mismatch'; end if;
  v_added:=coalesce((v_job.body->'receipt'->'summary'->'comparison'->>'addedCount')::integer,0);
  v_removed:=coalesce((v_job.body->'receipt'->'summary'->'comparison'->>'removedCount')::integer,0);
  v_baseline_count:=coalesce((v_job.body->'receipt'->'summary'->'comparison'->>'baselineRowCount')::integer,0);
  if v_config.approved_source_fingerprint is distinct from p_payload->>'sourceFingerprint' and
    (coalesce((v_job.body->'receipt'->'summary'->>'reviewRequired')::boolean,false) or v_baseline_count<1
     or coalesce((v_job.body->'receipt'->'summary'->'comparison'->>'unknownCount')::integer,1)>0
     or v_added>greatest(v_config.max_added_count,floor(v_baseline_count*v_config.max_added_ratio)::integer)
     or v_removed>v_config.max_removed_count) then raise exception using errcode='55000',message='REVIEW_REQUIRED'; end if;
  select * into v_scope from operations_private.sellpia_sync_apply_scopes where job_id=v_id;
  if v_scope.intent_id is null then
    select snapshot_id into v_latest from public.sellpia_stock_snapshots where upload_status='ready' order by completed_at desc nulls last,created_at desc,snapshot_id desc limit 1;
    if v_latest is distinct from nullif(v_job.body->>'baselineSnapshotId','')::uuid then raise exception using errcode='55000',message='baseline snapshot changed'; end if;
    if exists(select 1 from operations_private.sellpia_sync_jobs where state='applying' and job_id<>v_id) then raise exception using errcode='55000',message='another import is applying'; end if;
  end if;
  v_token_hash:=p_payload->>'tokenHash';
  if coalesce(v_token_hash,'')!~'^[0-9a-f]{64}$' then raise exception using errcode='22023',message='invalid apply scope'; end if;
  insert into operations_private.sellpia_sync_apply_scopes(job_id,token_hash,operator_username,baseline_snapshot_id,expires_at,source_fingerprint)
    values(v_id,v_token_hash,v_actor->>'username',nullif(v_job.body->>'baselineSnapshotId','')::uuid,clock_timestamp()+interval '2 hours',p_payload->>'sourceFingerprint')
    on conflict(job_id) do update set token_hash=excluded.token_hash,expires_at=excluded.expires_at;
  if v_job.state='previewed' then
    v_body:=v_job.body||jsonb_build_object('state','applying','phase','import_wait','updatedAt',clock_timestamp());
    update operations_private.sellpia_sync_jobs set state='applying',body=v_body where job_id=v_id;
    update operations_private.sellpia_sync_revision set revision=revision+1 where singleton;
  else v_body:=v_job.body; end if;
  return jsonb_build_object('job',operations_private.sellpia_sync_public_job_v1(v_body),'requestId',v_job.request_id,'applicationMode',coalesce(v_job.body->>'applicationMode',v_job.body->>'mode'),'selectedFields',v_job.body->'selectedFields','baselineSnapshotId',v_job.body->'baselineSnapshotId','recoverIntentId',v_scope.intent_id,'snapshotId',v_scope.snapshot_id);
end $$;
revoke all on function public.hub_sellpia_sync_runtime_v1(text,jsonb,text,boolean) from public,anon,authenticated;
grant execute on function public.hub_sellpia_sync_runtime_v1(text,jsonb,text,boolean) to service_role;

-- Guarded bridge delegates to the existing full/patch upload boundary. Source
-- bytes must exactly match the independently verified collector manifest.
create function public.hub_sellpia_sync_upload_begin_v1(p_session_token text,p_job_id uuid,p_apply_token text,p_request_id uuid,p_upload_mode text,p_files jsonb,p_selected_fields jsonb,p_source_row_count integer)
returns jsonb language plpgsql security definer set search_path=pg_catalog set lock_timeout='5s' as $$
declare v_actor jsonb; v_scope operations_private.sellpia_sync_apply_scopes%rowtype; v_job operations_private.sellpia_sync_jobs%rowtype; v_latest uuid; v_result jsonb; v_file jsonb; v_expected jsonb; v_i integer; v_intent operations_private.operations_hub_original_upload_intents%rowtype;
begin
  v_actor:=operations_private.require_operations_hub_operator_session(p_session_token);
  perform pg_advisory_xact_lock(hashtextextended('operations_hub_sellpia_patch',0));
  perform pg_advisory_xact_lock(713102026);
  select * into v_scope from operations_private.sellpia_sync_apply_scopes where job_id=p_job_id for update;
  select * into v_job from operations_private.sellpia_sync_jobs where job_id=p_job_id for update;
  if not found or v_scope.operator_username is distinct from v_actor->>'username' or v_scope.token_hash is distinct from encode(extensions.digest(coalesce(p_apply_token,''),'sha256'),'hex') or v_scope.expires_at<=clock_timestamp() then raise exception using errcode='42501',message='scoped sync apply authorization required'; end if;
  if not exists(select 1 from operations_private.sellpia_sync_config where singleton and apply_enabled) then raise exception using errcode='55000',message='APPLY_DISABLED'; end if;
  if p_request_id is distinct from v_job.request_id or p_upload_mode is distinct from coalesce(v_job.body->>'applicationMode',v_job.body->>'mode') or p_selected_fields is distinct from v_job.body->'selectedFields' or p_source_row_count is distinct from (v_job.body->'collectionManifest'->>'expectedRowCount')::integer then raise exception using errcode='22023',message='frozen sync scope changed'; end if;
  if jsonb_typeof(p_files)<>'array' or jsonb_array_length(p_files)<>3 then raise exception using errcode='22023',message='three complete source originals required'; end if;
  for v_i in 0..2 loop
    v_file:=p_files->v_i;v_expected:=v_job.body->'verifiedArtifacts'->v_i;
    if v_expected->>'verified' is distinct from 'true' or v_file->>'name' is distinct from v_expected->>'name' or (v_file->>'size')::bigint is distinct from (v_expected->>'size')::bigint or v_file->>'sha256' is distinct from v_expected->>'sha256' then raise exception using errcode='22023',message='verified collector bytes differ'; end if;
  end loop;
  if v_scope.intent_id is not null then
    select * into v_intent from operations_private.operations_hub_original_upload_intents where intent_id=v_scope.intent_id for update;
    if v_intent.status in ('failed','aborted','expired') then raise exception using errcode='55000',message='terminated import cannot be retried'; end if;
    -- Reauthentication may adopt only this operator's scoped intent. It never
    -- changes manifest, rows, snapshot or request identity.
    update operations_private.operations_hub_original_upload_intents set session_id=(v_actor->>'session_id')::uuid where intent_id=v_scope.intent_id and operator_username=v_actor->>'username';
    return jsonb_build_object('intent_id',v_intent.intent_id,'snapshot_id',v_intent.snapshot_id,'status',v_intent.status,'manifest',v_intent.object_manifest,'idempotent',true,'sync_job_id',p_job_id);
  end if;
  select snapshot_id into v_latest from public.sellpia_stock_snapshots where upload_status='ready' order by completed_at desc nulls last,created_at desc,snapshot_id desc limit 1;
  if v_latest is distinct from v_scope.baseline_snapshot_id or v_job.state<>'applying' then raise exception using errcode='55000',message='baseline snapshot changed'; end if;
  v_result:=public.hub_original_upload_intent_begin_v2(p_session_token,p_request_id,p_upload_mode,p_files,p_selected_fields,p_source_row_count);
  update operations_private.sellpia_sync_apply_scopes set intent_id=(v_result->>'intent_id')::uuid,snapshot_id=(v_result->>'snapshot_id')::uuid where job_id=p_job_id;
  update operations_private.sellpia_sync_jobs set body=body||jsonb_build_object('importIntentId',v_result->>'intent_id','applySnapshotId',v_result->>'snapshot_id','importStatus','uploading','phase','import_upload','updatedAt',clock_timestamp()) where job_id=p_job_id;
  update operations_private.sellpia_sync_revision set revision=revision+1 where singleton;
  update public.sellpia_stock_snapshots set metadata=metadata||jsonb_build_object('sync_job_id',p_job_id,'collection_manifest',v_job.body->'collectionManifest','source_fingerprint',v_scope.source_fingerprint) where snapshot_id=(v_result->>'snapshot_id')::uuid;
  return v_result||jsonb_build_object('sync_job_id',p_job_id);
end $$;
revoke all on function public.hub_sellpia_sync_upload_begin_v1(text,uuid,text,uuid,text,jsonb,jsonb,integer) from public;
grant execute on function public.hub_sellpia_sync_upload_begin_v1(text,uuid,text,uuid,text,jsonb,jsonb,integer) to anon,authenticated;

-- Preserve the existing function body and signature instead of cloning the
-- importer. Both manual callers and the sync caller continue using complete_v2.
alter function public.hub_sellpia_upload_complete_v2(text,uuid) set schema operations_private;
alter function operations_private.hub_sellpia_upload_complete_v2(text,uuid) rename to hub_sellpia_upload_complete_pre_sync_v2;
revoke all on function operations_private.hub_sellpia_upload_complete_pre_sync_v2(text,uuid) from public,anon,authenticated;
alter function public.hub_sellpia_upload_complete_v1(text,uuid) set schema operations_private;
alter function operations_private.hub_sellpia_upload_complete_v1(text,uuid) rename to hub_sellpia_upload_complete_pre_sync_v1;
revoke all on function operations_private.hub_sellpia_upload_complete_pre_sync_v1(text,uuid) from public,anon,authenticated;
do $$ declare v_definition text; begin
  v_definition:=pg_get_functiondef('operations_private.hub_sellpia_upload_complete_pre_sync_v2(text,uuid)'::regprocedure);
  if position('public.hub_sellpia_upload_complete_v1' in v_definition)=0 then raise exception 'completion v2 delegate drift'; end if;
  execute replace(v_definition,'public.hub_sellpia_upload_complete_v1','operations_private.hub_sellpia_upload_complete_pre_sync_v1');
end $$;
create function public.hub_sellpia_upload_complete_v2(p_session_token text,p_intent_id uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog set statement_timeout='90s' set lock_timeout='5s' as $$
declare v_scope operations_private.sellpia_sync_apply_scopes%rowtype; v_latest uuid; v_result jsonb; v_actor jsonb; v_status text; v_config operations_private.sellpia_sync_config%rowtype; v_added integer; v_removed integer; v_baseline_count integer; v_mode text;
begin
  select * into v_scope from operations_private.sellpia_sync_apply_scopes where intent_id=p_intent_id;
  if not found then return operations_private.hub_sellpia_upload_complete_pre_sync_v2(p_session_token,p_intent_id); end if;
  v_actor:=operations_private.require_operations_hub_operator_session(p_session_token);
  if v_scope.operator_username is distinct from v_actor->>'username' then raise exception using errcode='42501',message='sync operator owner required'; end if;
  perform pg_advisory_xact_lock(hashtextextended('operations_hub_sellpia_patch',0));
  perform pg_advisory_xact_lock(713102026);
  select status into v_status from operations_private.operations_hub_original_upload_intents where intent_id=p_intent_id for update;
  if v_status<>'ready' then
    if v_scope.expires_at<=clock_timestamp() or not exists(select 1 from operations_private.sellpia_sync_config where singleton and apply_enabled) then raise exception using errcode='55000',message='sync scope expired or disabled'; end if;
    select snapshot_id into v_latest from public.sellpia_stock_snapshots where upload_status='ready' order by completed_at desc nulls last,created_at desc,snapshot_id desc limit 1;
    if v_latest is distinct from v_scope.baseline_snapshot_id then raise exception using errcode='55000',message='baseline snapshot changed'; end if;
    if not exists(select 1 from operations_private.sellpia_sync_jobs where job_id=v_scope.job_id and state='applying') then raise exception using errcode='55000',message='sync apply no longer active'; end if;
    -- Compute the final SKU set guard from stored import rows independently of
    -- the browser preview counters. A forged/old receipt cannot waive mass
    -- additions/removals. Selected-field patch preserves baseline-only SKUs.
    select * into strict v_config from operations_private.sellpia_sync_config where singleton;
    select upload_mode into v_mode from operations_private.operations_hub_original_upload_intents where intent_id=p_intent_id;
    select count(*)::integer into v_baseline_count from public.sellpia_stock_snapshot_rows where snapshot_id=v_scope.baseline_snapshot_id;
    select count(*)::integer into v_added from public.sellpia_stock_snapshot_rows n
      left join public.sellpia_stock_snapshot_rows b on b.snapshot_id=v_scope.baseline_snapshot_id and b.sellpia_sku_code=n.sellpia_sku_code
      where n.snapshot_id=v_scope.snapshot_id and b.sellpia_sku_code is null;
    if v_mode='full' then
      select count(*)::integer into v_removed from public.sellpia_stock_snapshot_rows b
        left join public.sellpia_stock_snapshot_rows n on n.snapshot_id=v_scope.snapshot_id and n.sellpia_sku_code=b.sellpia_sku_code
        where b.snapshot_id=v_scope.baseline_snapshot_id and n.sellpia_sku_code is null;
    else v_removed:=0;end if;
    if v_config.approved_source_fingerprint is distinct from v_scope.source_fingerprint
      and (v_baseline_count<1 or v_added>greatest(v_config.max_added_count,floor(v_baseline_count*v_config.max_added_ratio)::integer) or v_removed>v_config.max_removed_count)
      then raise exception using errcode='55000',message='REVIEW_REQUIRED: stored SKU set changed beyond approved scope'; end if;
  end if;
  v_result:=operations_private.hub_sellpia_upload_complete_pre_sync_v2(p_session_token,p_intent_id);
  update operations_private.sellpia_sync_jobs set state='db_ready',body=body||jsonb_build_object('state','db_ready','phase','matrix_wait','importStatus','ready','matrixStatus','pending','updatedAt',clock_timestamp()) where job_id=v_scope.job_id and state<>'complete';
  update operations_private.sellpia_sync_revision set revision=revision+1 where singleton;
  return v_result||jsonb_build_object('sync_job_id',v_scope.job_id,'matrix_status','pending');
end $$;
revoke all on function public.hub_sellpia_upload_complete_v2(text,uuid) from public;
grant execute on function public.hub_sellpia_upload_complete_v2(text,uuid) to anon,authenticated;
create function public.hub_sellpia_upload_complete_v1(p_session_token text,p_intent_id uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog set statement_timeout='90s' set lock_timeout='5s' as $$
begin
  if exists(select 1 from operations_private.sellpia_sync_apply_scopes where intent_id=p_intent_id) then
    return public.hub_sellpia_upload_complete_v2(p_session_token,p_intent_id);
  end if;
  return operations_private.hub_sellpia_upload_complete_pre_sync_v1(p_session_token,p_intent_id);
end $$;
revoke all on function public.hub_sellpia_upload_complete_v1(text,uuid) from public;
grant execute on function public.hub_sellpia_upload_complete_v1(text,uuid) to anon,authenticated;

create function public.hub_sellpia_sync_import_status_v1(p_session_token text,p_intent_id uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare v_actor jsonb; v_scope operations_private.sellpia_sync_apply_scopes%rowtype; v_intent operations_private.operations_hub_original_upload_intents%rowtype;
begin
  v_actor:=operations_private.require_operations_hub_operator_session(p_session_token);
  select * into v_scope from operations_private.sellpia_sync_apply_scopes where intent_id=p_intent_id;
  if not found then return jsonb_build_object('sync',false); end if;
  if v_scope.operator_username is distinct from v_actor->>'username' then raise exception using errcode='42501',message='sync owner required'; end if;
  select * into v_intent from operations_private.operations_hub_original_upload_intents where intent_id=p_intent_id;
  return jsonb_build_object('sync',true,'jobId',v_scope.job_id,'status',v_intent.status,'manifest',v_intent.object_manifest);
end $$;
revoke all on function public.hub_sellpia_sync_import_status_v1(text,uuid) from public,anon,authenticated;
grant execute on function public.hub_sellpia_sync_import_status_v1(text,uuid) to service_role;

-- Staging retention never returns a permanent sellpia/<snapshot> path. Wait
-- beyond the 2-hour upload capability before cleaning failed/cancelled jobs;
-- reviewed/successful previews retain staging for 7 days. Source provenance in
-- permanent snapshot originals is covered by its existing retention boundary.
alter table operations_private.sellpia_sync_artifacts add column cleaned_at timestamptz;
create function public.hub_sellpia_sync_cleanup_candidates_v1()
returns jsonb language sql security definer set search_path=pg_catalog as $$
  select coalesce(jsonb_agg(jsonb_build_object('jobId',a.job_id,'path',a.path)),'[]')
  from (select a.job_id,a.path from operations_private.sellpia_sync_artifacts a
    join operations_private.sellpia_sync_jobs j using(job_id)
    where a.path like 'sellpia-sync/%' and a.cleaned_at is null
      and (j.state in ('failed','cancelled','needs_login') and (j.body->>'updatedAt')::timestamptz<clock_timestamp()-interval '3 hours'
        or j.state in ('previewed','complete') and (j.body->>'updatedAt')::timestamptz<clock_timestamp()-interval '7 days')
    order by j.created_at,a.ordinal limit 30) a
$$;
revoke all on function public.hub_sellpia_sync_cleanup_candidates_v1() from public,anon,authenticated;
grant execute on function public.hub_sellpia_sync_cleanup_candidates_v1() to service_role;
create function public.hub_sellpia_sync_cleanup_ack_v1(p_paths text[])
returns void language sql security definer set search_path=pg_catalog as $$
  update operations_private.sellpia_sync_artifacts set cleaned_at=clock_timestamp()
    where path=any(p_paths) and path like 'sellpia-sync/%' and cardinality(p_paths)<=30
$$;
revoke all on function public.hub_sellpia_sync_cleanup_ack_v1(text[]) from public,anon,authenticated;
grant execute on function public.hub_sellpia_sync_cleanup_ack_v1(text[]) to service_role;

-- Deny permissive legacy Storage policies for collector staging. Signed server
-- capabilities remain the only transfer route; service_role bypasses RLS.
create policy sellpia_sync_private_staging on storage.objects as restrictive for all to anon,authenticated
  using (bucket_id<>'seller-originals' or name not like 'sellpia-sync/%')
  with check (bucket_id<>'seller-originals' or name not like 'sellpia-sync/%');
commit;
