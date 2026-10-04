begin;

do $migration$
declare
  v_actor constant text := 'legacy-formula-tag-migration-20260914';
  v_inserted integer;
  v_updated integer;
begin
  perform pg_advisory_xact_lock(hashtextextended('hub-rule-registry', 0));

  if (select count(*) from public.operations_hub_price_rule_tags where is_active) <> 10
    or (select count(*) from public.operations_hub_price_rule_sets where is_active) <> 6
    or (select count(*) from public.operations_hub_price_rule_set_items i join public.operations_hub_price_rule_sets s using(price_rule_set_id) where i.is_active and s.is_active) <> 12
    or (select count(*) from public.operations_hub_inbound_cost_formula_tags where is_active) <> 3 then
    raise exception '기존 저장 수식 대상 수가 preview(10/6/12/3)와 다릅니다.';
  end if;

  if exists (
    select 1
    from (select * from public.operations_hub_price_rule_tags where is_active) actual
    full join (
      values
        (54::bigint, '판매가 +2,000원', 'price', null::text, null::text, 'add', 2000::numeric),
        (55, '판매가 +3,000원', 'price', null, null, 'add', 3000),
        (56, '판매가 +4,000원', 'price', null, null, 'add', 4000),
        (57, '판매가 +5,000원', 'price', null, null, 'add', 5000),
        (58, '스마트스토어 즉시할인 -2,000원', 'discount', 'smartstore', null, 'add', -2000),
        (59, '스마트스토어 즉시할인 -3,000원', 'discount', 'smartstore', null, 'add', -3000),
        (60, '스마트스토어 즉시할인 -4,000원', 'discount', 'smartstore', null, 'add', -4000),
        (61, '스마트스토어 즉시할인 -5,000원', 'discount', 'smartstore', null, 'add', -5000),
        (62, '에이블리 즉시할인 -1,000원', 'discount', 'ably', null, 'add', -1000),
        (63, '에이블리 즉시할인 -2,000원', 'discount', 'ably', null, 'add', -2000)
    ) expected(id, name, role, source, rule_code, modify_type, modify_value)
      on actual.price_rule_tag_id = expected.id
    where actual.price_rule_tag_id is null
       or expected.id is null
       or not actual.is_active
       or actual.tag_name is distinct from expected.name
       or actual.tag_role is distinct from expected.role
       or actual.discount_source_channel is distinct from expected.source
       or actual.discount_rule_code is distinct from expected.rule_code
       or actual.modify_type is distinct from expected.modify_type
       or actual.modify_value is distinct from expected.modify_value
       or actual.replace_price is not null
       or actual.min_price is not null
       or actual.max_price is not null
       or actual.rounding_unit is distinct from 1::numeric
       or actual.rounding_mode is distinct from 'nearest'
  ) then
    raise exception '기존 계산/할인 태그가 승인된 preview와 다릅니다.';
  end if;

  if exists (
    select 1
    from (select * from public.operations_hub_price_rule_sets where is_active) actual
    full join (
      values
        (49::bigint, '스스_2000', '54,58'),
        (50, '스스_3000', '55,59'),
        (51, '스스_4000', '56,60'),
        (52, '스스_5000', '57,61'),
        (53, '에이블리_1000', '56,62'),
        (54, '에이블리_2000', '57,63')
    ) expected(id, name, item_ids)
      on actual.price_rule_set_id = expected.id
    left join lateral (
      select string_agg(i.price_rule_tag_id::text, ',' order by i.sort_order) item_ids
      from public.operations_hub_price_rule_set_items i
      where i.price_rule_set_id = actual.price_rule_set_id and i.is_active
    ) items on true
    where actual.price_rule_set_id is null
       or expected.id is null
       or not actual.is_active
       or actual.set_name is distinct from expected.name
       or items.item_ids is distinct from expected.item_ids
  ) then
    raise exception '기존 가격 조합이 승인된 preview와 다릅니다.';
  end if;

  if exists (
    select 1
    from (select * from public.operations_hub_inbound_cost_formula_tags where is_active) actual
    full join (
      values
        (5::bigint, '14K_기본', 1::numeric, 1::numeric, 0::numeric),
        (6, '14K_노볼', 1, 1, -7500),
        (7, '14K_1/2', 1, 2, 0)
    ) expected(id, name, multiply_value, divide_value, add_value)
      on actual.tag_id = expected.id
    where actual.tag_id is null
       or expected.id is null
       or not actual.is_active
       or actual.tag_name is distinct from expected.name
       or actual.multiply_value is distinct from expected.multiply_value
       or actual.divide_value is distinct from expected.divide_value
       or actual.add_value is distinct from expected.add_value
       or actual.rounding_unit is distinct from 1::numeric
       or actual.rounding_mode is distinct from 'nearest'
  ) then
    raise exception '기존 실입고가 수식이 승인된 preview와 다릅니다.';
  end if;

  if exists (select 1 from public.operations_hub_price_rule_assignments where is_active)
    or exists (select 1 from public.operations_hub_inbound_cost_settings where formula_tag_id is not null) then
    raise exception 'preview와 달리 기존 저장 수식에 SKU assignment가 존재합니다.';
  end if;

  if exists (
    select 1 from public.product_tags
    where lower(tag_name) = any(array[
      lower('판매가 +2,000원'), lower('판매가 +3,000원'), lower('판매가 +4,000원'), lower('판매가 +5,000원'),
      lower('스마트스토어 즉시할인 -2,000원'), lower('스마트스토어 즉시할인 -3,000원'),
      lower('스마트스토어 즉시할인 -4,000원'), lower('스마트스토어 즉시할인 -5,000원'),
      lower('에이블리 즉시할인 -1,000원'), lower('에이블리 즉시할인 -2,000원'),
      lower('스스_2000'), lower('스스_3000'), lower('스스_4000'), lower('스스_5000'),
      lower('에이블리_1000'), lower('에이블리_2000'),
      lower('14K_기본'), lower('14K_노볼'), lower('14K_1/2')
    ])
  ) then
    raise exception '승격할 이름과 같은 상품 태그가 preview 이후 생성되었습니다.';
  end if;

  if (select count(*) from operations_private.hub_rules where is_active) <> 11
    or exists (select 1 from operations_private.hub_rules where is_active and tag_id is null) then
    raise exception '새 수식 태그 registry가 preview의 11개 활성 Rule과 다릅니다.';
  end if;

  if (
    select count(*)
    from operations_private.hub_rules
    where is_active
      and target_field = 'platform_discount_price'
      and scope = 'makeshop'
      and name = '기준가격 테스트 · 할인 없음'
      and source_field = 'platform_registration_price'
      and config = '{"steps":[{"op":"add","value":0}]}'::jsonb
  ) <> 1 then
    raise exception '기존 메이크샵 할인 없음 Rule이 preview 이후 변경되었습니다.';
  end if;

  insert into public.product_tags(tag_name, tag_color, tag_group, created_by)
  values
    ('판매가 +2,000원', '#2f6fd1', '가격 수식', v_actor),
    ('판매가 +3,000원', '#2f6fd1', '가격 수식', v_actor),
    ('판매가 +4,000원', '#2f6fd1', '가격 수식', v_actor),
    ('판매가 +5,000원', '#2f6fd1', '가격 수식', v_actor),
    ('스마트스토어 즉시할인 -2,000원', '#16a34a', '가격 수식', v_actor),
    ('스마트스토어 즉시할인 -3,000원', '#16a34a', '가격 수식', v_actor),
    ('스마트스토어 즉시할인 -4,000원', '#16a34a', '가격 수식', v_actor),
    ('스마트스토어 즉시할인 -5,000원', '#16a34a', '가격 수식', v_actor),
    ('에이블리 즉시할인 -1,000원', '#7c3aed', '가격 수식', v_actor),
    ('에이블리 즉시할인 -2,000원', '#7c3aed', '가격 수식', v_actor),
    ('스스_2000', '#16a34a', '가격 수식', v_actor),
    ('스스_3000', '#16a34a', '가격 수식', v_actor),
    ('스스_4000', '#16a34a', '가격 수식', v_actor),
    ('스스_5000', '#16a34a', '가격 수식', v_actor),
    ('에이블리_1000', '#7c3aed', '가격 수식', v_actor),
    ('에이블리_2000', '#7c3aed', '가격 수식', v_actor),
    ('14K_기본', '#d97706', '가격 수식', v_actor),
    ('14K_노볼', '#d97706', '가격 수식', v_actor),
    ('14K_1/2', '#d97706', '가격 수식', v_actor);
  get diagnostics v_inserted = row_count;
  if v_inserted <> 19 then raise exception '수식 태그 생성 건수가 19건이 아닙니다: %', v_inserted; end if;

  with price_defs(tag_name, amount, legacy_id) as (
    values ('판매가 +2,000원', 2000, 54), ('판매가 +3,000원', 3000, 55),
           ('판매가 +4,000원', 4000, 56), ('판매가 +5,000원', 5000, 57)
  ), scopes(scope, label) as (
    values ('smartstore', '스마트스토어'), ('makeshop', '메이크샵'), ('ably', '에이블리')
  )
  insert into operations_private.hub_rules(tag_id, name, target_field, scope, input_origin, source_field, source_scope, config, updated_by)
  select t.tag_id, d.tag_name || ' · ' || s.label, 'platform_registration_price', s.scope, 'self', 'source_base_price', '',
         jsonb_build_object('steps', jsonb_build_array(jsonb_build_object('op','add','value',d.amount), jsonb_build_object('op','round','unit',1,'rounding','nearest')), 'legacy_source','operations_hub_price_rule_tags','legacy_id',d.legacy_id), v_actor
  from price_defs d cross join scopes s join public.product_tags t on t.tag_name=d.tag_name and t.created_by=v_actor;
  get diagnostics v_inserted = row_count;
  if v_inserted <> 12 then raise exception '판매가 수식 생성 건수가 12건이 아닙니다: %', v_inserted; end if;

  with discount_defs(tag_name, scope, amount, legacy_id) as (
    values
      ('스마트스토어 즉시할인 -2,000원', 'smartstore', 2000, 58),
      ('스마트스토어 즉시할인 -3,000원', 'smartstore', 3000, 59),
      ('스마트스토어 즉시할인 -4,000원', 'smartstore', 4000, 60),
      ('스마트스토어 즉시할인 -5,000원', 'smartstore', 5000, 61),
      ('에이블리 즉시할인 -1,000원', 'ably', 1000, 62),
      ('에이블리 즉시할인 -2,000원', 'ably', 2000, 63)
  )
  insert into operations_private.hub_rules(tag_id, name, target_field, scope, input_origin, source_field, source_scope, config, updated_by)
  select t.tag_id, d.tag_name, 'platform_discount_price', d.scope, 'self', 'platform_registration_price', d.scope,
         jsonb_build_object('steps', jsonb_build_array(jsonb_build_object('op','subtract','value',d.amount), jsonb_build_object('op','round','unit',1,'rounding','nearest')), 'discount_mode','numeric','legacy_source','operations_hub_price_rule_tags','legacy_id',d.legacy_id), v_actor
  from discount_defs d join public.product_tags t on t.tag_name=d.tag_name and t.created_by=v_actor;
  get diagnostics v_inserted = row_count;
  if v_inserted <> 6 then raise exception '할인 수식 생성 건수가 6건이 아닙니다: %', v_inserted; end if;

  with set_defs(tag_name, scope, label, add_amount, discount_amount, legacy_id) as (
    values
      ('스스_2000', 'smartstore', '스마트스토어', 2000, 2000, 49),
      ('스스_3000', 'smartstore', '스마트스토어', 3000, 3000, 50),
      ('스스_4000', 'smartstore', '스마트스토어', 4000, 4000, 51),
      ('스스_5000', 'smartstore', '스마트스토어', 5000, 5000, 52),
      ('에이블리_1000', 'ably', '에이블리', 4000, 1000, 53),
      ('에이블리_2000', 'ably', '에이블리', 5000, 2000, 54)
  ), rules as (
    select tag_name, scope, tag_name || ' · ' || label || ' 등록가' name,
           'platform_registration_price' target_field, 'source_base_price' source_field,
           jsonb_build_object('steps',jsonb_build_array(jsonb_build_object('op','add','value',add_amount),jsonb_build_object('op','round','unit',1,'rounding','nearest')),'legacy_source','operations_hub_price_rule_sets','legacy_id',legacy_id) config
    from set_defs
    union all
    select tag_name, scope, tag_name || ' · ' || label || ' 할인',
           'platform_discount_price', 'platform_registration_price',
           jsonb_build_object('steps',jsonb_build_array(jsonb_build_object('op','subtract','value',discount_amount),jsonb_build_object('op','round','unit',1,'rounding','nearest')),'discount_mode','numeric','legacy_source','operations_hub_price_rule_sets','legacy_id',legacy_id)
    from set_defs
  )
  insert into operations_private.hub_rules(tag_id, name, target_field, scope, input_origin, source_field, source_scope, config, updated_by)
  select t.tag_id, r.name, r.target_field, r.scope, 'self', r.source_field,
         case when r.source_field like 'platform_%' then r.scope else '' end, r.config, v_actor
  from rules r join public.product_tags t on t.tag_name=r.tag_name and t.created_by=v_actor;
  get diagnostics v_inserted = row_count;
  if v_inserted <> 12 then raise exception '가격 조합 수식 생성 건수가 12건이 아닙니다: %', v_inserted; end if;

  with inbound_defs(tag_name, steps, legacy_id) as (
    values
      ('14K_기본', jsonb_build_array(jsonb_build_object('op','round','unit',1,'rounding','nearest')), 5),
      ('14K_노볼', jsonb_build_array(jsonb_build_object('op','subtract','value',7500),jsonb_build_object('op','round','unit',1,'rounding','nearest')), 6),
      ('14K_1/2', jsonb_build_array(jsonb_build_object('op','divide','value',2),jsonb_build_object('op','round','unit',1,'rounding','nearest')), 7)
  )
  insert into operations_private.hub_rules(tag_id, name, target_field, scope, input_origin, source_field, source_scope, config, updated_by)
  select t.tag_id, d.tag_name || ' · 실입고가', 'actual_inbound_cost', '', 'self', 'purchase_price', '',
         jsonb_build_object('steps',d.steps,'legacy_source','operations_hub_inbound_cost_formula_tags','legacy_id',d.legacy_id), v_actor
  from inbound_defs d join public.product_tags t on t.tag_name=d.tag_name and t.created_by=v_actor;
  get diagnostics v_inserted = row_count;
  if v_inserted <> 3 then raise exception '실입고가 수식 생성 건수가 3건이 아닙니다: %', v_inserted; end if;

  update operations_private.hub_rules
  set config = jsonb_set(jsonb_set(config, '{steps}', '[]'::jsonb), '{discount_mode}', '"makeshop_code"'::jsonb) || jsonb_build_object('discount_rule_code','NONE'),
      version = version + 1,
      updated_at = clock_timestamp(),
      updated_by = v_actor
  where is_active and name='기준가격 테스트 · 할인 없음' and scope='makeshop' and target_field='platform_discount_price';
  get diagnostics v_updated = row_count;
  if v_updated <> 1 then raise exception '메이크샵 할인 없음 Rule 보강 건수가 1건이 아닙니다: %', v_updated; end if;

  update public.operations_hub_price_rule_set_items
  set is_active=false
  where is_active and price_rule_set_id in (49,50,51,52,53,54);
  get diagnostics v_updated = row_count;
  if v_updated <> 12 then raise exception '기존 가격 조합 항목 보관 처리 건수가 12건이 아닙니다: %', v_updated; end if;

  update public.operations_hub_price_rule_sets set is_active=false, updated_at=clock_timestamp(), updated_by=v_actor
  where is_active and price_rule_set_id in (49,50,51,52,53,54);
  get diagnostics v_updated = row_count;
  if v_updated <> 6 then raise exception '기존 가격 조합 보관 처리 건수가 6건이 아닙니다: %', v_updated; end if;

  update public.operations_hub_price_rule_tags set is_active=false, updated_at=clock_timestamp(), updated_by=v_actor
  where is_active and price_rule_tag_id between 54 and 63;
  get diagnostics v_updated = row_count;
  if v_updated <> 10 then raise exception '기존 계산 태그 보관 처리 건수가 10건이 아닙니다: %', v_updated; end if;

  update public.operations_hub_inbound_cost_formula_tags set is_active=false, updated_at=clock_timestamp()
  where is_active and tag_id in (5,6,7);
  get diagnostics v_updated = row_count;
  if v_updated <> 3 then raise exception '기존 실입고가 수식 보관 처리 건수가 3건이 아닙니다: %', v_updated; end if;

  if (select count(*) from public.product_tags where created_by=v_actor and is_active) <> 19
    or (select count(*) from operations_private.hub_rules where updated_by=v_actor and is_active) <> 34
    or exists (select 1 from operations_private.hub_rules where is_active and tag_id is null)
    or exists (
      select 1 from operations_private.hub_rules
      where is_active and tag_id is not null
      group by tag_id, scope, target_field having count(*) > 1
    ) then
    raise exception '승격 후 수식 태그 invariant 검증에 실패했습니다.';
  end if;
end
$migration$;

alter table operations_private.hub_rules
  add constraint hub_rules_discount_scope_and_mode_check
  check (
    target_field <> 'platform_discount_price'
    or (
      scope in ('smartstore','makeshop','ably')
      and input_origin='self'
      and source_field='platform_registration_price'
      and source_scope in ('',scope)
      and (
        (scope='makeshop'
          and config->>'discount_mode'='makeshop_code'
          and config->>'discount_rule_code' in ('NONE','M10','M15','M20')
          and not (config ?| array['min','max','unit','rounding'])
          and config->'steps' = case config->>'discount_rule_code'
            when 'NONE' then '[]'::jsonb
            when 'M10' then '[{"op":"multiply","value":0.9},{"op":"round","unit":10,"rounding":"down"}]'::jsonb
            when 'M15' then '[{"op":"multiply","value":0.85},{"op":"round","unit":10,"rounding":"down"}]'::jsonb
            when 'M20' then '[{"op":"multiply","value":0.8},{"op":"round","unit":100,"rounding":"down"}]'::jsonb
          end)
        or (scope in ('smartstore','ably')
          and coalesce(config->>'discount_mode','numeric')='numeric'
          and not (config ? 'discount_rule_code'))
      )
    )
  );

create or replace function operations_private.hub_validate_rule_config(p_config jsonb)
returns void language plpgsql set search_path=pg_catalog as $$
declare s jsonb; n numeric; k text;
begin
 if jsonb_typeof(p_config) is distinct from 'object' then raise exception '규칙 설정 객체가 필요합니다.'; end if;
 if jsonb_typeof(p_config->'steps') is distinct from 'array' then raise exception '연산 배열이 필요합니다.'; end if;
 if jsonb_array_length(p_config->'steps')>20 then raise exception '연산은 최대 20개입니다.'; end if;
 if p_config ? 'discount_rule_code' and coalesce(p_config->>'discount_rule_code','') not in ('NONE','M10','M15','M20') then raise exception '메이크샵 할인코드는 NONE, M10, M15, M20 중 하나여야 합니다.'; end if;
 for s in select value from jsonb_array_elements(p_config->'steps') loop
  if jsonb_typeof(s) is distinct from 'object' or s->>'op' is null then raise exception '수식 연산 오류'; end if;
  if s->>'op'='round' then
   if jsonb_typeof(s->'unit') is distinct from 'number' or coalesce(s->>'rounding','') not in ('up','down','nearest') then raise exception '끝자리 처리 오류'; end if;
   n:=(s->>'unit')::numeric;
   if n<1 or n<>trunc(n) or n>9007199254740991 then raise exception '끝자리 단위 오류'; end if;
  else
   if s->>'op' not in ('add','subtract','multiply','divide','set') or jsonb_typeof(s->'value') is distinct from 'number' then raise exception '수식 연산 오류'; end if;
   if s->>'op'='divide' and (s->>'value')::numeric=0 then raise exception '0으로 나눌 수 없습니다.'; end if;
  end if;
 end loop;
 if p_config->>'unit' is not null or p_config->>'rounding' is not null then
  n:=coalesce((p_config->>'unit')::numeric,1);
  if n<1 or n<>trunc(n) or n>9007199254740991 or coalesce(p_config->>'rounding','nearest') not in ('up','down','nearest') then raise exception '끝자리 처리 오류'; end if;
 end if;
 foreach k in array array['min','max'] loop
  if nullif(p_config->>k,'') is not null then
   if jsonb_typeof(p_config->k) not in ('string','number') or (p_config->>k)::numeric<0 then raise exception '가격 범위 오류'; end if;
  end if;
 end loop;
 if nullif(p_config->>'min','')::numeric > nullif(p_config->>'max','')::numeric then raise exception '최저값이 최고값보다 큽니다.'; end if;
end $$;

create or replace function public.hub_tag_rule_save_v1(p_session_token text,p_tag jsonb,p_rule jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare actor jsonb; t public.product_tags%rowtype; rules jsonb; codes text[]; tagid uuid; oldtag uuid;
begin
 actor:=operations_private.require_operations_hub_operator_session(p_session_token);
 perform pg_advisory_xact_lock(hashtextextended('hub-rule-registry',0));
 if jsonb_typeof(p_tag) is distinct from 'object' or coalesce(length(btrim(p_tag->>'name')),0) not between 1 and 200 then raise exception '태그 이름을 입력하세요.';end if;
 tagid:=nullif(p_tag->>'id','')::uuid;
 if tagid is null then
  insert into public.product_tags(tag_name,tag_color,tag_group,created_by) values(btrim(p_tag->>'name'),coalesce(p_tag->>'color','#dbeafe'),coalesce(p_tag->>'group','운영'),actor->>'username') returning * into t;
 else
  update public.product_tags set tag_name=btrim(p_tag->>'name'),tag_color=coalesce(p_tag->>'color',tag_color),updated_at=clock_timestamp() where tag_id=tagid and is_active returning * into t;
  if not found then raise exception '태그를 찾지 못했습니다.';end if;
 end if;
 if nullif(p_rule->>'id','') is not null then
  select tag_id into oldtag from operations_private.hub_rules where id=(p_rule->>'id')::uuid;
  if oldtag is distinct from t.tag_id then raise exception '다른 태그의 수식을 변경할 수 없습니다.';end if;
 end if;
 p_rule:=p_rule||jsonb_build_object('tag_id',t.tag_id);
 if p_rule->>'target_field'='platform_discount_price' and coalesce(p_rule->>'scope','')='' then
  raise exception '할인 수식 태그는 스마트스토어, 메이크샵, 에이블리 중 한 판매처를 선택해야 합니다.';
 end if;
 if p_rule->>'target_field' like 'platform_%' and coalesce(p_rule->>'scope','')='' then
  rules:=public.hub_platform_rule_group_save_v1(p_session_token,p_rule);
 else
  rules:=jsonb_build_array(public.hub_rule_registry_v1(p_session_token,'save',p_rule));
 end if;
 select array_agg(distinct sku) into codes from (
 select a.sellpia_sku_code sku from public.sellpia_tag_assignments a where a.tag_id=t.tag_id and a.is_active and a.tag_scope='option'
 union
 select p.sellpia_sku_code from public.operations_hub_product_profiles p join public.sellpia_tag_assignments a on a.tag_scope='product' and a.sellpia_product_code=p.sellpia_product_code where a.tag_id=t.tag_id and a.is_active
 ) targets;
 if cardinality(codes)>0 then perform operations_private.hub_sync_tag_rules(codes,actor->>'username');end if;
 return jsonb_build_object('tag',to_jsonb(t),'rules',rules);
end $$;
revoke all on function public.hub_tag_rule_save_v1(text,jsonb,jsonb) from public;
grant execute on function public.hub_tag_rule_save_v1(text,jsonb,jsonb) to anon,authenticated;

commit;
