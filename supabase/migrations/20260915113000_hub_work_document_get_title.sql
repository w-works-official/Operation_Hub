create or replace function public.hub_work_documents_v1(
  p_session_token text,
  p_action text,
  p_kind text,
  p_id uuid default null,
  p_title text default null,
  p_body jsonb default null,
  p_version integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  actor jsonb;
  result jsonb;
  saved operations_private.hub_work_documents%rowtype;
begin
  actor := operations_private.require_operations_hub_operator_session(p_session_token);

  if p_kind not in ('ably', 'formula', 'price-links') then
    raise exception '문서 종류 오류';
  end if;

  if p_action = 'list' then
    select coalesce(jsonb_agg(to_jsonb(d) order by d.updated_at desc), '[]'::jsonb)
    into result
    from (
      select id, title, version, updated_at,
             jsonb_array_length(coalesce(body -> 'rows', '[]'::jsonb)) as row_count
      from operations_private.hub_work_documents
      where kind = p_kind
    ) d;
    return result;
  elsif p_action = 'get' then
    select to_jsonb(d)
    into result
    from operations_private.hub_work_documents d
    where id = p_id and kind = p_kind;
    if result is null then
      raise exception '저장된 항목을 찾지 못했습니다.';
    end if;
    return result;
  elsif p_action = 'get_title' then
    if nullif(btrim(p_title), '') is null then
      raise exception '문서 제목을 확인해주세요.';
    end if;
    select to_jsonb(d)
    into result
    from operations_private.hub_work_documents d
    where kind = p_kind and title = btrim(p_title);
    return result;
  elsif p_action = 'save' then
    if p_body is null
       or jsonb_typeof(p_body) <> 'object'
       or octet_length(p_body::text) > 28000000 then
      raise exception '저장 데이터는 28MB 이하의 객체여야 합니다.';
    end if;
    if p_id is null then
      insert into operations_private.hub_work_documents(kind, title, body, updated_by)
      values(p_kind, btrim(p_title), p_body, coalesce(actor ->> 'username', 'operator'))
      returning * into saved;
    else
      update operations_private.hub_work_documents
      set title = btrim(p_title),
          body = p_body,
          version = version + 1,
          updated_at = clock_timestamp(),
          updated_by = coalesce(actor ->> 'username', 'operator')
      where id = p_id and kind = p_kind and version = p_version
      returning * into saved;
      if not found then
        raise exception '다른 화면에서 수정되었습니다. 다시 불러온 후 저장하세요.';
      end if;
    end if;
    return jsonb_build_object(
      'id', saved.id,
      'title', saved.title,
      'version', saved.version,
      'updated_at', saved.updated_at
    );
  else
    raise exception '지원하지 않는 동작';
  end if;
end
$function$;

revoke all on function public.hub_work_documents_v1(text,text,text,uuid,text,jsonb,integer) from public;
grant execute on function public.hub_work_documents_v1(text,text,text,uuid,text,jsonb,integer) to anon, authenticated;
