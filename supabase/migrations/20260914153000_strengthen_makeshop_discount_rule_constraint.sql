begin;

do $migration$
begin
  perform pg_advisory_xact_lock(hashtextextended('hub-rule-registry', 0));
  if exists (
    select 1
    from operations_private.hub_rules
    where target_field='platform_discount_price'
      and scope='makeshop'
      and (
        config->>'discount_mode' is distinct from 'makeshop_code'
        or config->>'discount_rule_code' not in ('NONE','M10','M15','M20')
        or config ?| array['min','max','unit','rounding']
        or config->'steps' is distinct from case config->>'discount_rule_code'
          when 'NONE' then '[]'::jsonb
          when 'M10' then '[{"op":"multiply","value":0.9},{"op":"round","unit":10,"rounding":"down"}]'::jsonb
          when 'M15' then '[{"op":"multiply","value":0.85},{"op":"round","unit":10,"rounding":"down"}]'::jsonb
          when 'M20' then '[{"op":"multiply","value":0.8},{"op":"round","unit":100,"rounding":"down"}]'::jsonb
        end
      )
  ) then
    raise exception '기존 메이크샵 할인 Rule이 코드별 계산 invariant와 다릅니다.';
  end if;
end
$migration$;

alter table operations_private.hub_rules
  drop constraint hub_rules_discount_scope_and_mode_check;

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

commit;
