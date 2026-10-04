begin;

do $migration$
declare
  v_registration_tag_id uuid;
  v_discount_tag_id uuid;
  v_smartstore_chain_tag_id uuid;
  v_changed integer;
  v_backfilled integer;
begin
  perform pg_advisory_xact_lock(hashtextextended('hub-rule-registry', 0));

  if (
    select count(*)
    from operations_private.hub_rules
    where is_active and tag_id is null
  ) <> 9 then
    raise exception 'formula Rule 승격 대상이 preview의 9개와 다릅니다.';
  end if;

  if exists (
    select 1
    from operations_private.hub_rules r
    where r.is_active
      and r.tag_id is null
      and not exists (
        select 1
        from (
          values
            ('기준가격 그대로 상품판매가', 'smartstore', 'platform_registration_price'),
            ('기준가격 그대로 상품판매가', 'makeshop', 'platform_registration_price'),
            ('기준가격 그대로 상품판매가', 'ably', 'platform_registration_price'),
            ('기준가격 테스트 · 할인 없음', 'smartstore', 'platform_discount_price'),
            ('기준가격 테스트 · 할인 없음', 'makeshop', 'platform_discount_price'),
            ('기준가격 테스트 · 할인 없음', 'ably', 'platform_discount_price'),
            ('매입가 2배', '', 'basis_sku_price'),
            ('스스 +2000원', 'smartstore', 'platform_registration_price'),
            ('스스 할인 2000원', 'smartstore', 'platform_discount_price')
        ) as expected(name, scope, target_field)
        where expected.name = r.name
          and expected.scope = r.scope
          and expected.target_field = r.target_field
      )
  ) then
    raise exception 'preview에 없던 tag_id 없는 활성 Rule이 발견되었습니다.';
  end if;

  if exists (
    select 1
    from operations_private.hub_rule_assignments a
    join operations_private.hub_rules r on r.id = a.rule_id
    where r.is_active and r.tag_id is null
  ) then
    raise exception 'preview와 달리 승격 대상 Rule에 SKU assignment가 존재합니다.';
  end if;

  if exists (
    select 1
    from operations_private.hub_rules r
    where r.is_active and r.tag_id is not null
    group by r.tag_id, r.scope, r.target_field
    having count(*) > 1
  ) then
    raise exception '기존 수식 태그에 동일 output target 활성 Rule 충돌이 있습니다.';
  end if;

  if (
    select count(*)
    from public.product_tags
    where tag_name in ('기준가격 그대로 상품판매가', '기준가격 테스트 · 할인 없음')
  ) <> 0 then
    raise exception '신규 생성 예정 이름과 같은 태그가 preview 이후 생성되었습니다.';
  end if;

  if (
    select count(*)
    from public.product_tags
    where tag_name = '매입가 2배 + 스스 2000원 추가 + 스스 2000할인'
      and is_active
  ) <> 1 then
    raise exception '기존 스마트스토어 계산 묶음 태그가 preview 상태와 다릅니다.';
  end if;

  select tag_id
  into v_smartstore_chain_tag_id
  from public.product_tags
  where tag_name = '매입가 2배 + 스스 2000원 추가 + 스스 2000할인'
    and is_active;

  if exists (
    select 1
    from operations_private.hub_rules
    where tag_id = v_smartstore_chain_tag_id
  ) or exists (
    select 1
    from public.sellpia_tag_assignments
    where tag_id = v_smartstore_chain_tag_id and is_active
  ) then
    raise exception '기존 스마트스토어 계산 묶음 태그의 Rule 또는 SKU 연결이 preview 이후 변경되었습니다.';
  end if;

  insert into public.product_tags(tag_name, tag_color, tag_group, created_by)
  values ('기준가격 그대로 상품판매가', '#dbeafe', '가격 수식', 'formula-rule-tag-migration-20260914')
  returning tag_id into v_registration_tag_id;

  insert into public.product_tags(tag_name, tag_color, tag_group, created_by)
  values ('기준가격 테스트 · 할인 없음', '#dbeafe', '가격 수식', 'formula-rule-tag-migration-20260914')
  returning tag_id into v_discount_tag_id;

  update operations_private.hub_rules
  set tag_id = v_registration_tag_id,
      updated_at = clock_timestamp(),
      updated_by = 'formula-rule-tag-migration-20260914'
  where is_active
    and tag_id is null
    and name = '기준가격 그대로 상품판매가'
    and target_field = 'platform_registration_price'
    and scope in ('smartstore', 'makeshop', 'ably');
  get diagnostics v_changed = row_count;
  if v_changed <> 3 then
    raise exception '등록가 Rule 승격 건수가 3건이 아닙니다: %', v_changed;
  end if;

  update operations_private.hub_rules
  set tag_id = v_discount_tag_id,
      updated_at = clock_timestamp(),
      updated_by = 'formula-rule-tag-migration-20260914'
  where is_active
    and tag_id is null
    and name = '기준가격 테스트 · 할인 없음'
    and target_field = 'platform_discount_price'
    and scope in ('smartstore', 'makeshop', 'ably');
  get diagnostics v_changed = row_count;
  if v_changed <> 3 then
    raise exception '할인가 Rule 승격 건수가 3건이 아닙니다: %', v_changed;
  end if;

  update operations_private.hub_rules
  set tag_id = v_smartstore_chain_tag_id,
      updated_at = clock_timestamp(),
      updated_by = 'formula-rule-tag-migration-20260914'
  where is_active
    and tag_id is null
    and (
      (name = '매입가 2배' and scope = '' and target_field = 'basis_sku_price')
      or (name = '스스 +2000원' and scope = 'smartstore' and target_field = 'platform_registration_price')
      or (name = '스스 할인 2000원' and scope = 'smartstore' and target_field = 'platform_discount_price')
    );
  get diagnostics v_changed = row_count;
  if v_changed <> 3 then
    raise exception '스마트스토어 계산 묶음 Rule 승격 건수가 3건이 아닙니다: %', v_changed;
  end if;

  update operations_private.hub_rule_assignments a
  set assigned_tag_id = r.tag_id,
      updated_at = clock_timestamp(),
      updated_by = 'formula-rule-tag-migration-20260914'
  from operations_private.hub_rules r
  where r.id = a.rule_id
    and r.tag_id in (v_registration_tag_id, v_discount_tag_id, v_smartstore_chain_tag_id)
    and a.assigned_tag_id is distinct from r.tag_id;

  insert into public.sellpia_tag_assignments(
    tag_id,
    tag_scope,
    sellpia_sku_code,
    reviewer,
    memo,
    is_active
  )
  select distinct
    r.tag_id,
    'option',
    a.sku,
    'formula-rule-tag-migration-20260914',
    'Rule assignment에서 수식 태그 적용 보강',
    true
  from operations_private.hub_rule_assignments a
  join operations_private.hub_rules r on r.id = a.rule_id
  where r.tag_id in (v_registration_tag_id, v_discount_tag_id, v_smartstore_chain_tag_id)
    and not exists (
      select 1
      from public.sellpia_tag_assignments existing
      where existing.tag_id = r.tag_id
        and existing.tag_scope = 'option'
        and existing.sellpia_sku_code = a.sku
        and existing.is_active
    );
  get diagnostics v_backfilled = row_count;

  if v_backfilled <> 0 then
    raise exception 'preview와 달리 SKU tag assignment 보강이 %건 발생했습니다.', v_backfilled;
  end if;

  if exists (
    select 1
    from operations_private.hub_rules
    where is_active and tag_id is null
  ) then
    raise exception '승격 후에도 tag_id 없는 활성 Rule이 남아 있습니다.';
  end if;

  if exists (
    select 1
    from operations_private.hub_rules r
    where r.is_active and r.tag_id is not null
    group by r.tag_id, r.scope, r.target_field
    having count(*) > 1
  ) then
    raise exception '승격 결과 동일 output target 활성 Rule 충돌이 발생했습니다.';
  end if;
end
$migration$;

create unique index hub_rules_active_tag_output_target_uidx
on operations_private.hub_rules(tag_id, scope, target_field)
where is_active and tag_id is not null;

alter table operations_private.hub_rules
  add constraint hub_rules_active_tag_required
  check (not is_active or tag_id is not null);

commit;
