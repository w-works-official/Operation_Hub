-- Return every optional matrix decoration in one bounded request. The caller
-- still applies the existing projection order in JavaScript so manual links,
-- price components, and link suppressions retain their established semantics.
create or replace function public.load_operations_hub_matrix_metadata_v1(
  p_skus text[]
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_skus text[];
begin
  select coalesce(array_agg(distinct btrim(sku)), '{}'::text[])
  into v_skus
  from unnest(coalesce(p_skus, '{}'::text[])) sku
  where nullif(btrim(sku), '') is not null;

  if coalesce(cardinality(v_skus), 0) > 200 then
    raise exception '한 번에 최대 200개 SKU의 부가정보만 조회할 수 있습니다.';
  end if;

  return jsonb_build_object(
    'inbound_costs', coalesce((
      select jsonb_agg(to_jsonb(detail) order by detail.sellpia_sku_code)
      from public.operations_hub_inbound_cost_live detail
      where detail.sellpia_sku_code = any(v_skus)
    ), '[]'::jsonb),
    'operational_details', coalesce((
      select jsonb_agg(to_jsonb(detail) order by detail.sellpia_sku_code)
      from public.operations_hub_sku_operational_live detail
      where detail.sellpia_sku_code = any(v_skus)
    ), '[]'::jsonb),
    'product_link_drafts', coalesce((
      select jsonb_agg(to_jsonb(draft) order by draft.sellpia_sku_code, draft.source_channel)
      from public.operations_hub_product_link_drafts draft
      where draft.sellpia_sku_code = any(v_skus)
    ), '[]'::jsonb),
    'manual_links', coalesce((
      select jsonb_agg(to_jsonb(link) order by link.sellpia_sku_code, link.source_channel)
      from public.operations_hub_manual_links link
      where link.sellpia_sku_code = any(v_skus)
    ), '[]'::jsonb),
    'profiles', coalesce((
      select jsonb_agg(to_jsonb(profile) order by profile.sellpia_sku_code)
      from public.operations_hub_product_profiles profile
      where profile.sellpia_sku_code = any(v_skus)
    ), '[]'::jsonb),
    'link_badges', coalesce((
      select jsonb_agg(to_jsonb(badge) order by badge.sellpia_sku_code, badge.source_channel)
      from public.get_operations_hub_sku_link_badges(v_skus) badge
    ), '[]'::jsonb),
    'seller_price_components', coalesce((
      select jsonb_agg(to_jsonb(component) order by component.sellpia_sku_code, component.source_channel)
      from public.load_operations_hub_seller_price_components(v_skus) component
    ), '[]'::jsonb),
    'seller_drafts', coalesce((
      select jsonb_agg(to_jsonb(draft) order by draft.updated_at desc, draft.change_id desc)
      from public.operations_hub_active_seller_drafts draft
      where draft.sellpia_sku_code = any(v_skus)
    ), '[]'::jsonb),
    'price_rule_assignments', coalesce((
      select jsonb_agg(to_jsonb(assignment) order by assignment.sellpia_sku_code, assignment.source_channel)
      from public.operations_hub_price_rule_assignments assignment
      where assignment.target_type = 'sellpia_sku'
        and assignment.is_active
        and assignment.sellpia_sku_code = any(v_skus)
    ), '[]'::jsonb),
    'price_rule_sets', coalesce((
      select jsonb_agg(to_jsonb(rule_set) order by rule_set.price_rule_set_id)
      from public.operations_hub_price_rule_sets rule_set
      where rule_set.is_active
        and rule_set.price_rule_set_id in (
          select assignment.price_rule_set_id
          from public.operations_hub_price_rule_assignments assignment
          where assignment.target_type = 'sellpia_sku'
            and assignment.is_active
            and assignment.sellpia_sku_code = any(v_skus)
        )
    ), '[]'::jsonb),
    'link_suppressions', coalesce((
      select jsonb_agg(to_jsonb(suppression) order by suppression.sellpia_sku_code, suppression.source_channel)
      from public.operations_hub_link_suppressions suppression
      where suppression.sellpia_sku_code = any(v_skus)
    ), '[]'::jsonb)
  );
end;
$$;

comment on function public.load_operations_hub_matrix_metadata_v1(text[]) is
  'Bounded metadata bundle for one Operations Hub matrix page.';

revoke all on function public.load_operations_hub_matrix_metadata_v1(text[]) from public;
grant execute on function public.load_operations_hub_matrix_metadata_v1(text[]) to anon, authenticated;

notify pgrst, 'reload schema';
