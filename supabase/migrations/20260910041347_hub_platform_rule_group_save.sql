create function public.hub_platform_rule_group_save_v1(p_session_token text,p_rule jsonb)
returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare result jsonb:='[]'::jsonb; source text; saved jsonb;
begin
 if jsonb_typeof(p_rule) is distinct from 'object' or nullif(p_rule->>'id','') is not null or coalesce(p_rule->>'scope','')<>'' then raise exception '전체 판매처 저장은 새 공통 수식에서 사용하세요.'; end if;
 if coalesce(p_rule->>'target_field','') not in ('platform_registration_price','platform_option_price','platform_discount_price','platform_final_price','platform_price') then raise exception '플랫폼 계산 단계를 선택하세요.'; end if;
 foreach source in array array['smartstore','makeshop','ably'] loop
  saved:=public.hub_rule_registry_v1(p_session_token,'save',p_rule||jsonb_build_object('scope',source));
  result:=result||jsonb_build_array(saved);
 end loop;
 return result;
end $$;
revoke all on function public.hub_platform_rule_group_save_v1(text,jsonb) from public;
grant execute on function public.hub_platform_rule_group_save_v1(text,jsonb) to anon,authenticated;

