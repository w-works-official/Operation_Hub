-- Qualify one recursive CTE column that collides with the RETURNS TABLE output variable.
-- CREATE OR REPLACE retains the existing function owner and ACL. No operator data changes.
set local lock_timeout='2s';
set local statement_timeout='30s';

do $guard$
declare
 v_function regprocedure:=to_regprocedure('public.save_operations_hub_relation_folder_v2(bigint,text,text,integer,bigint)');
 v_body_md5 text;v_definer boolean;v_config text[];v_result text;
begin
 if v_function is null then raise exception using errcode='55000',message='Expected existing relation-folder save function is missing';end if;
 select md5(replace(prosrc,E'\r','')),prosecdef,proconfig,pg_get_function_result(oid)
 into v_body_md5,v_definer,v_config,v_result from pg_proc where oid=v_function;
 if v_body_md5 not in ('9c7f75f80e9f0bb68a0d968ad223b6f6','2c61340ca33e74e2ae1f9179ebd2ba8f')
    or v_definer
    or v_config is distinct from array['search_path=pg_catalog, public','statement_timeout=4s']
    or v_result is distinct from 'TABLE(folder_id bigint, folder_name text, folder_kind text, parent_folder_id bigint, sort_order integer, updated_at timestamp with time zone)' then
  raise exception using errcode='55000',message='Relation-folder save definition drifted; review before applying the alias fix';
 end if;
end $guard$;

create or replace function public.save_operations_hub_relation_folder_v2(
  p_folder_id bigint,
  p_folder_name text,
  p_folder_kind text default 'custom',
  p_sort_order integer default 100,
  p_parent_folder_id bigint default null
)
returns table (
  folder_id bigint,
  folder_name text,
  folder_kind text,
  parent_folder_id bigint,
  sort_order integer,
  updated_at timestamptz
)
language plpgsql
security invoker
set search_path = pg_catalog, public
set statement_timeout = '4s'
as $$
declare
  v_before jsonb;
  v_folder_id bigint;
begin
  p_folder_name := btrim(coalesce(p_folder_name, ''));
  p_folder_kind := lower(btrim(coalesce(p_folder_kind, 'custom')));
  p_sort_order := greatest(0, least(coalesce(p_sort_order, 100), 10000));

  if length(p_folder_name) not between 1 and 60 then
    raise exception '폴더명은 1~60자로 입력해주세요.';
  end if;
  if p_folder_kind not in ('collection', 'one_plus_one', 'set', 'custom') then
    raise exception '폴더 유형을 확인해주세요.';
  end if;
  if p_parent_folder_id is not null and not exists (
    select 1
    from public.operations_hub_relation_folders parent_folder
    where parent_folder.folder_id = p_parent_folder_id and parent_folder.is_active
  ) then
    raise exception '선택한 상위 폴더를 찾을 수 없습니다.';
  end if;
  if p_folder_id is not null and p_parent_folder_id = p_folder_id then
    raise exception '폴더 자신을 상위 폴더로 지정할 수 없습니다.';
  end if;
  if p_folder_id is not null and p_parent_folder_id is not null and exists (
    with recursive descendants as (
      select folder.folder_id
      from public.operations_hub_relation_folders folder
      where folder.parent_folder_id = p_folder_id and folder.is_active
      union all
      select child.folder_id
      from descendants
      join public.operations_hub_relation_folders child
        on child.parent_folder_id = descendants.folder_id and child.is_active
    )
    select 1 from descendants descendant where descendant.folder_id = p_parent_folder_id
  ) then
    raise exception '하위 폴더를 상위로 지정하는 순환 구조는 만들 수 없습니다.';
  end if;
  if exists (
    select 1
    from public.operations_hub_relation_folders duplicate
    where duplicate.is_active
      and duplicate.parent_folder_id is not distinct from p_parent_folder_id
      and lower(btrim(duplicate.folder_name)) = lower(p_folder_name)
      and duplicate.folder_id <> coalesce(p_folder_id, -1)
  ) then
    raise exception '같은 상위 폴더 안에 동일한 이름의 폴더가 이미 있습니다.';
  end if;

  if p_folder_id is null then
    insert into public.operations_hub_relation_folders (
      folder_name, folder_kind, parent_folder_id, sort_order,
      is_active, updated_by, updated_at
    ) values (
      p_folder_name, p_folder_kind, p_parent_folder_id, p_sort_order,
      true, 'operations_hub_frontend', now()
    )
    returning operations_hub_relation_folders.folder_id into v_folder_id;
  else
    select to_jsonb(folder.*) into v_before
    from public.operations_hub_relation_folders folder
    where folder.folder_id = p_folder_id and folder.is_active
    for update;
    if not found then
      raise exception '수정할 폴더를 찾을 수 없습니다.';
    end if;

    update public.operations_hub_relation_folders folder
    set folder_name = p_folder_name,
        folder_kind = p_folder_kind,
        parent_folder_id = p_parent_folder_id,
        sort_order = p_sort_order,
        updated_by = 'operations_hub_frontend',
        updated_at = now()
    where folder.folder_id = p_folder_id;
    v_folder_id := p_folder_id;
  end if;

  insert into public.operations_hub_relation_events (
    event_type, folder_id, before_value, after_value, changed_by
  )
  select 'FOLDER_SAVE', folder.folder_id, v_before, to_jsonb(folder.*), 'operations_hub_frontend'
  from public.operations_hub_relation_folders folder
  where folder.folder_id = v_folder_id;

  return query
  select
    folder.folder_id,
    folder.folder_name,
    folder.folder_kind,
    folder.parent_folder_id,
    folder.sort_order,
    folder.updated_at
  from public.operations_hub_relation_folders folder
  where folder.folder_id = v_folder_id;
end;
$$;

do $verify$
begin
 if (select md5(replace(prosrc,E'\r','')) from pg_proc where oid='public.save_operations_hub_relation_folder_v2(bigint,text,text,integer,bigint)'::regprocedure) is distinct from '2c61340ca33e74e2ae1f9179ebd2ba8f' then
  raise exception using errcode='55000',message='Unexpected relation-folder save body after replacement';
 end if;
end $verify$;

notify pgrst,'reload schema';
