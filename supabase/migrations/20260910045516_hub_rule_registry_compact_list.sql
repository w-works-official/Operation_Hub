-- Compact read endpoint; existing v1 clients and all write paths stay compatible.
create function public.hub_rule_registry_list_v2(p_session_token text)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
begin
 perform operations_private.require_operations_hub_operator_session(p_session_token);
 return jsonb_build_object(
  'rules',(select coalesce(jsonb_agg(to_jsonb(t) order by name),'[]') from operations_private.hub_rules t),
  'assignment_groups',(select coalesce(jsonb_agg(jsonb_build_object('rule_id',g.rule_id,'target_field',g.target_field,'scope',g.scope,'assigned_tag_id',g.assigned_tag_id,'entries',g.entries)),'[]') from (
   select rule_id,target_field,scope,assigned_tag_id,jsonb_agg(jsonb_build_array(sku,version) order by sku) entries
   from operations_private.hub_rule_assignments group by rule_id,target_field,scope,assigned_tag_id
  ) g),
  'dependencies',(select coalesce(jsonb_agg(to_jsonb(t)||jsonb_build_object('relation_valid',t.relation_edge_id is null or exists(
   select 1 from public.operations_hub_relation_edges e join public.operations_hub_relation_nodes p on p.node_id=e.parent_node_id join public.operations_hub_relation_nodes c on c.node_id=e.child_node_id
   where e.edge_id=t.relation_edge_id and e.is_active and p.is_active and c.is_active and p.sellpia_sku_code=t.parent_sku and c.sellpia_sku_code=t.child_sku))),'[]') from operations_private.hub_field_references t)
 );
end $$;
revoke all on function public.hub_rule_registry_list_v2(text) from public;
grant execute on function public.hub_rule_registry_list_v2(text) to anon,authenticated;
notify pgrst,'reload schema';
