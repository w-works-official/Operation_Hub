create or replace view public.operations_hub_products
with (security_invoker = true)
as
select
  p_code as sellpia_sku_code,
  nullif(btrim(own_code), '') as own_code,
  coalesce(
    nullif(raw_payload ->> 'storage_public_url', ''),
    case
      when nullif(raw_payload ->> 'storage_path', '') is not null
      then 'https://bpgvqmtsjgegnrdzmpep.supabase.co/storage/v1/object/public/product-images/' || (raw_payload ->> 'storage_path')
      else null
    end,
    nullif(legacy_image_url, '')
  ) as image_url,
  source_updated_at,
  updated_at
from catalog.sellpia_products;

comment on view public.operations_hub_products is
  'Read-only operations hub SKU projection. Source of truth remains catalog.sellpia_products.';

revoke all on public.operations_hub_products from public;
grant select on public.operations_hub_products to anon, authenticated;

drop policy if exists "operations hub source status readable" on public.source_sync_events;
create policy "operations hub source status readable"
on public.source_sync_events
for select
to anon, authenticated
using (event_at >= now() - interval '30 days');

revoke all on public.source_sync_events from anon, authenticated;
grant select (
  source,
  event_type,
  status,
  event_at,
  duration_ms,
  processed_rows,
  total_rows,
  output_rows,
  payload
) on public.source_sync_events to anon, authenticated;

create or replace view public.operations_hub_source_status
with (security_invoker = true)
as
select
  source,
  event_type,
  status,
  event_at,
  duration_ms,
  processed_rows,
  total_rows,
  output_rows,
  payload
from public.source_sync_events
where event_at >= now() - interval '30 days';

comment on view public.operations_hub_source_status is
  'Sanitized recent source processing status for the public operations hub client.';

revoke all on public.operations_hub_source_status from public;
grant select on public.operations_hub_source_status to anon, authenticated;

notify pgrst, 'reload schema';

alter table review.final_excel_mapping_import enable row level security;

drop policy if exists "operations hub final mappings readable" on review.final_excel_mapping_import;
create policy "operations hub final mappings readable"
on review.final_excel_mapping_import
for select
to anon, authenticated
using (nullif(btrim(sellpia_sku), '') is not null);

alter table review.review_user_allowlist enable row level security;

drop policy if exists "review users can read own allowlist row" on review.review_user_allowlist;
create policy "review users can read own allowlist row"
on review.review_user_allowlist
for select
to authenticated
using ((select auth.uid()) = user_id);

notify pgrst, 'reload schema';

create index if not exists final_excel_mapping_import_channel_sku_idx
on review.final_excel_mapping_import (source_channel, sellpia_sku, import_id desc)
where sellpia_sku is not null;

drop policy if exists "operations hub manual mappings readable" on review.sheet_manual_mappings;
create policy "operations hub manual mappings readable"
on review.sheet_manual_mappings
for select
to anon, authenticated
using (true);

grant select (
  manual_mapping_id,
  source_channel,
  sellpia_sku,
  channel_code,
  channel_product_name,
  channel_option_name,
  match_tier,
  match_score,
  confirmed_at,
  updated_at
) on review.sheet_manual_mappings to anon, authenticated;

grant select (
  import_id,
  source_channel,
  sellpia_sku,
  channel_code,
  channel_product_name,
  channel_option_name,
  match_tier,
  match_score,
  imported_at
) on review.final_excel_mapping_import to anon, authenticated;

create or replace view public.operations_hub_matrix
with (security_invoker = true)
as
with all_skus as (
  select p_code as sellpia_sku
  from catalog.sellpia_products
  union
  select sellpia_sku
  from review.final_excel_mapping_import
  where nullif(btrim(sellpia_sku), '') is not null
  union
  select sellpia_sku
  from review.sheet_manual_mappings
  where nullif(btrim(sellpia_sku), '') is not null
),
mapping_candidates as (
  select
    source_channel,
    sellpia_sku,
    channel_code,
    channel_product_name,
    channel_option_name,
    match_tier,
    match_score,
    imported_at as mapped_at,
    1 as source_priority,
    import_id as source_id
  from review.final_excel_mapping_import
  where nullif(btrim(sellpia_sku), '') is not null
  union all
  select
    source_channel,
    sellpia_sku,
    channel_code,
    channel_product_name,
    channel_option_name,
    match_tier,
    match_score,
    coalesce(updated_at, confirmed_at) as mapped_at,
    0 as source_priority,
    manual_mapping_id as source_id
  from review.sheet_manual_mappings
  where nullif(btrim(sellpia_sku), '') is not null
),
ranked as (
  select
    mapping_candidates.*,
    row_number() over (
      partition by source_channel, sellpia_sku
      order by source_priority, match_score desc nulls last, mapped_at desc nulls last, source_id desc
    ) as choice_rank,
    count(*) over (partition by source_channel, sellpia_sku) as listing_count
  from mapping_candidates
),
chosen as (
  select * from ranked where choice_rank = 1
)
select
  sk.sellpia_sku as sellpia_sku_code,
  nullif(btrim(p.own_code), '') as own_code,
  coalesce(
    nullif(p.raw_payload ->> 'storage_public_url', ''),
    case
      when nullif(p.raw_payload ->> 'storage_path', '') is not null
      then 'https://bpgvqmtsjgegnrdzmpep.supabase.co/storage/v1/object/public/product-images/' || (p.raw_payload ->> 'storage_path')
      else null
    end,
    nullif(p.legacy_image_url, '')
  ) as image_url,
  coalesce(
    nullif(smart.channel_product_name, ''),
    nullif(makeshop.channel_product_name, ''),
    nullif(ably.channel_product_name, ''),
    nullif(ably.channel_option_name, '')
  ) as display_name,
  smart.channel_product_name as smartstore_name,
  split_part(smart.channel_code, '-', 1) as smartstore_product_code,
  nullif(substring(smart.channel_code from position('-' in smart.channel_code) + 1), smart.channel_code) as smartstore_option_code,
  smart.match_tier as smartstore_match_tier,
  smart.match_score as smartstore_match_score,
  smart.listing_count as smartstore_listing_count,
  makeshop.channel_product_name as makeshop_name,
  split_part(makeshop.channel_code, '-', 1) as makeshop_product_code,
  nullif(substring(makeshop.channel_code from position('-' in makeshop.channel_code) + 1), makeshop.channel_code) as makeshop_option_code,
  makeshop.match_tier as makeshop_match_tier,
  makeshop.match_score as makeshop_match_score,
  makeshop.listing_count as makeshop_listing_count,
  coalesce(ably.channel_product_name, ably.channel_option_name) as ably_name,
  split_part(ably.channel_code, '-', 1) as ably_product_code,
  nullif(substring(ably.channel_code from position('-' in ably.channel_code) + 1), ably.channel_code) as ably_option_code,
  ably.match_tier as ably_match_tier,
  ably.match_score as ably_match_score,
  ably.listing_count as ably_listing_count,
  greatest(
    coalesce(p.updated_at, '-infinity'::timestamptz),
    coalesce(smart.mapped_at, '-infinity'::timestamptz),
    coalesce(makeshop.mapped_at, '-infinity'::timestamptz),
    coalesce(ably.mapped_at, '-infinity'::timestamptz)
  ) as updated_at
from all_skus sk
left join catalog.sellpia_products p on p.p_code = sk.sellpia_sku
left join chosen smart on smart.sellpia_sku = sk.sellpia_sku and smart.source_channel = 'smartstore'
left join chosen makeshop on makeshop.sellpia_sku = sk.sellpia_sku and makeshop.source_channel = 'makeshop'
left join chosen ably on ably.sellpia_sku = sk.sellpia_sku and ably.source_channel = 'ably';

comment on view public.operations_hub_matrix is
  'Read-only SKU matrix joining image catalog and approved/review seller mappings. Inventory and price are intentionally omitted until normalized source rows are persisted.';

revoke all on public.operations_hub_matrix from public;
grant select on public.operations_hub_matrix to anon, authenticated;

notify pgrst, 'reload schema';
