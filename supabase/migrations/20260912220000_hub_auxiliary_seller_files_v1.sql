create table if not exists public.operations_hub_channel_files (
  file_id uuid primary key default gen_random_uuid(),
  source_channel text not null,
  source_role text not null,
  file_name text not null,
  storage_path text not null unique,
  mime_type text,
  file_size bigint,
  row_count integer,
  matched_count integer,
  unresolved_count integer,
  parse_status text not null default 'ready',
  metadata jsonb not null default '{}'::jsonb,
  uploaded_by text,
  created_at timestamptz not null default now(),
  is_active boolean not null default true,
  constraint operations_hub_channel_files_source_check check (source_channel in ('ably')),
  constraint operations_hub_channel_files_role_check check (source_role in ('playauto_product','playauto_option')),
  constraint operations_hub_channel_files_size_check check (file_size is null or file_size >= 0),
  constraint operations_hub_channel_files_count_check check ((row_count is null or row_count >= 0) and (matched_count is null or matched_count >= 0) and (unresolved_count is null or unresolved_count >= 0))
);
create unique index if not exists operations_hub_channel_files_active_role_uidx
  on public.operations_hub_channel_files(source_channel,source_role) where is_active;
create index if not exists operations_hub_channel_files_created_idx
  on public.operations_hub_channel_files(source_channel,source_role,created_at desc);
alter table public.operations_hub_channel_files enable row level security;
revoke all on public.operations_hub_channel_files from anon,authenticated;

create or replace function public.hub_channel_file_register_v1(
  p_session_token text,p_source_channel text,p_source_role text,p_file_name text,p_storage_path text,
  p_mime_type text default null,p_file_size bigint default null,p_row_count integer default null,
  p_matched_count integer default null,p_unresolved_count integer default null,p_metadata jsonb default '{}'::jsonb
) returns jsonb
language plpgsql security definer set search_path=pg_catalog set statement_timeout='30s' set lock_timeout='5s'
as $$
declare actor jsonb; created public.operations_hub_channel_files%rowtype;
begin
  actor:=operations_private.require_operations_hub_operator_session(p_session_token);
  if p_source_channel <> 'ably' then raise exception '지원하지 않는 판매처 파일입니다.'; end if;
  if p_source_role not in ('playauto_product','playauto_option') then raise exception '지원하지 않는 파일 역할입니다.'; end if;
  if btrim(coalesce(p_file_name,''))='' then raise exception '파일명이 필요합니다.'; end if;
  if btrim(coalesce(p_storage_path,''))='' or p_storage_path not like 'ably/%' then raise exception '저장 경로를 확인해주세요.'; end if;
  perform pg_advisory_xact_lock(hashtextextended('operations_hub_channel_files:'||p_source_channel||':'||p_source_role,0));
  update public.operations_hub_channel_files set is_active=false
   where source_channel=p_source_channel and source_role=p_source_role and is_active;
  insert into public.operations_hub_channel_files(
    source_channel,source_role,file_name,storage_path,mime_type,file_size,row_count,matched_count,unresolved_count,metadata,uploaded_by
  ) values(
    p_source_channel,p_source_role,btrim(p_file_name),btrim(p_storage_path),nullif(btrim(coalesce(p_mime_type,'')),''),
    p_file_size,p_row_count,p_matched_count,p_unresolved_count,coalesce(p_metadata,'{}'::jsonb),actor->>'username'
  ) returning * into created;
  return to_jsonb(created);
end $$;

create or replace function public.hub_channel_file_status_v1(p_session_token text,p_source_channel text default 'ably')
returns jsonb language plpgsql security definer set search_path=pg_catalog set statement_timeout='30s'
as $$
declare actor jsonb; rows jsonb;
begin
  actor:=operations_private.require_operations_hub_operator_session(p_session_token);
  if p_source_channel <> 'ably' then raise exception '지원하지 않는 판매처입니다.'; end if;
  select coalesce(jsonb_agg(to_jsonb(f) order by f.source_role),'[]'::jsonb) into rows
    from public.operations_hub_channel_files f where f.source_channel=p_source_channel and f.is_active;
  return jsonb_build_object('source_channel',p_source_channel,'rows',rows);
end $$;

revoke all on function public.hub_channel_file_register_v1(text,text,text,text,text,text,bigint,integer,integer,integer,jsonb) from public;
revoke all on function public.hub_channel_file_status_v1(text,text) from public;
grant execute on function public.hub_channel_file_register_v1(text,text,text,text,text,text,bigint,integer,integer,integer,jsonb) to anon,authenticated;
grant execute on function public.hub_channel_file_status_v1(text,text) to anon,authenticated;
notify pgrst,'reload schema';
