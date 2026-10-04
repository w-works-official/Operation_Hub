create or replace function public.resolve_operations_hub_relation_import_codes(
  p_codes jsonb default '[]'::jsonb
)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog, public
set statement_timeout = '8s'
as $$
  with inputs as materialized (
    select btrim(value #>> '{}') as input_code, ordinality
    from jsonb_array_elements(coalesce(p_codes, '[]'::jsonb)) with ordinality
    where jsonb_typeof(value) = 'string'
      and nullif(btrim(value #>> '{}'), '') is not null
    limit 500
  ), candidates as materialized (
    select
      input.input_code,
      input.ordinality,
      'sellpia'::text as source_channel,
      'sellpia_sku'::text as node_type,
      latest.sellpia_product_code as product_code,
      latest.sellpia_sku_code as option_identity,
      latest.sellpia_sku_code as sellpia_sku_code,
      null::bigint as listing_id,
      node.node_id,
      concat_ws(' · ', nullif(btrim(coalesce(latest.sellpia_product_name, '')), ''), nullif(btrim(coalesce(latest.sellpia_option_name, '')), '')) as display_name,
      true as relation_ready
    from inputs input
    join public.sellpia_stock_latest latest
      on latest.sellpia_sku_code = input.input_code
    left join public.operations_hub_relation_nodes node
      on node.is_active and node.node_type = 'sellpia_sku'
     and lower(btrim(node.sellpia_sku_code)) = lower(btrim(latest.sellpia_sku_code))

    union all

    select
      input.input_code,
      input.ordinality,
      latest.source_channel,
      'seller_listing'::text,
      latest.product_code,
      latest.option_code,
      null::text,
      listing.listing_id,
      node.node_id,
      concat_ws(' · ', nullif(btrim(coalesce(latest.product_name, '')), ''), nullif(btrim(coalesce(latest.option_name, '')), '')),
      listing.listing_id is not null
    from inputs input
    join public.seller_inventory_latest latest
      on case when latest.option_code = '' then latest.product_code
              else latest.product_code || '-' || latest.option_code end = input.input_code
    left join public.operations_hub_seller_listings listing
      on listing.is_active
     and listing.source_channel = latest.source_channel
     and listing.product_code = latest.product_code
     and listing.option_code = latest.option_code
    left join public.operations_hub_relation_nodes node
      on node.is_active and node.node_type = 'seller_listing'
     and node.listing_id = listing.listing_id
  ), grouped as (
    select
      input.input_code,
      input.ordinality,
      count(candidate.input_code)::integer as candidate_count,
      count(candidate.input_code) filter (where candidate.relation_ready)::integer as ready_count,
      coalesce(jsonb_agg(jsonb_build_object(
        'source', candidate.source_channel,
        'nodeType', candidate.node_type,
        'productCode', candidate.product_code,
        'optionCode', candidate.option_identity,
        'sellpiaSkuCode', candidate.sellpia_sku_code,
        'listingId', candidate.listing_id,
        'nodeId', candidate.node_id,
        'displayName', coalesce(nullif(candidate.display_name, ''), input.input_code),
        'relationReady', candidate.relation_ready
      ) order by candidate.source_channel, candidate.product_code, candidate.option_identity)
        filter (where candidate.input_code is not null), '[]'::jsonb) as candidates
    from inputs input
    left join candidates candidate
      on candidate.ordinality = input.ordinality
    group by input.input_code, input.ordinality
  )
  select jsonb_build_object(
    'items', coalesce(jsonb_agg(jsonb_build_object(
      'inputCode', grouped.input_code,
      'status', case
        when grouped.candidate_count = 0 then 'not_found'
        when grouped.candidate_count > 1 then 'ambiguous'
        when grouped.ready_count = 0 then 'unlinked'
        else 'matched'
      end,
      'candidateCount', grouped.candidate_count,
      'candidates', grouped.candidates
    ) order by grouped.ordinality), '[]'::jsonb)
  )
  from grouped;
$$;

revoke all on function public.resolve_operations_hub_relation_import_codes(jsonb) from public;
grant execute on function public.resolve_operations_hub_relation_import_codes(jsonb) to anon, authenticated;

comment on function public.resolve_operations_hub_relation_import_codes(jsonb) is
  'Resolves exact product-code-option-code cells across current Sellpia and seller sources for relation import. Ambiguous and unlinked seller identities are returned but never auto-selected.';
