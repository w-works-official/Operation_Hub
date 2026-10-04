-- Seller pricing V2
--
-- Keeps the marketplace's native discount definition separate from the
-- System V3 target base price. V1 drafts remain readable and exportable; new
-- drafts explicitly record whether an operator entered an option adjustment
-- or a final customer price.

alter table public.seller_inventory_snapshot_rows
  add column if not exists discounted_base_price numeric,
  add column if not exists reported_final_price numeric,
  add column if not exists discount_calculation_status text,
  add column if not exists discount_terms jsonb not null default '[]'::jsonb,
  add column if not exists price_calculation_version smallint,
  add column if not exists source_discount_fingerprint text generated always as (md5(discount_terms::text)) stored;

update public.seller_inventory_snapshot_rows row_item
set
  discounted_base_price = coalesce(row_item.discounted_base_price, row_item.base_price, row_item.price),
  reported_final_price = coalesce(row_item.reported_final_price, row_item.final_price, row_item.price),
  discount_calculation_status = coalesce(row_item.discount_calculation_status, 'none'),
  price_calculation_version = coalesce(row_item.price_calculation_version, 1)
where row_item.discounted_base_price is null
   or row_item.reported_final_price is null
   or row_item.discount_calculation_status is null
   or row_item.price_calculation_version is null;

alter table public.seller_inventory_snapshot_rows
  drop constraint if exists seller_inventory_snapshot_rows_discount_terms_check,
  drop constraint if exists seller_inventory_snapshot_rows_discount_status_check,
  drop constraint if exists seller_inventory_snapshot_rows_price_version_check;

alter table public.seller_inventory_snapshot_rows
  add constraint seller_inventory_snapshot_rows_discount_terms_check
    check (jsonb_typeof(discount_terms) = 'array'),
  add constraint seller_inventory_snapshot_rows_discount_status_check
    check (discount_calculation_status is null or discount_calculation_status in (
      'none','calculated','reported','reported_mismatch','conditional','unverified'
    )),
  add constraint seller_inventory_snapshot_rows_price_version_check
    check (price_calculation_version is null or price_calculation_version in (1,2));

comment on column public.seller_inventory_snapshot_rows.discount_terms is
  'Structured native marketplace discounts parsed from the latest uploaded original. Conditional discounts are retained with is_baseline=false.';
comment on column public.seller_inventory_snapshot_rows.discounted_base_price is
  'Base sale price after native marketplace baseline discounts, before the option adjustment.';
comment on column public.seller_inventory_snapshot_rows.reported_final_price is
  'Final price reported by the marketplace original when the source provides one. Audit-only; final_price is the effective System V3 value.';

alter table public.operations_hub_change_queue
  add column if not exists price_discounted_base_before numeric,
  add column if not exists price_discounted_base_after numeric,
  add column if not exists price_calculation_version smallint not null default 1,
  add column if not exists pricing_input_mode text,
  add column if not exists base_price_source text,
  add column if not exists source_snapshot_id uuid references public.seller_inventory_snapshots(snapshot_id) on delete set null,
  add column if not exists source_discount_fingerprint text;

alter table public.operations_hub_change_queue
  drop constraint if exists operations_hub_change_queue_price_version_check,
  drop constraint if exists operations_hub_change_queue_pricing_input_mode_check,
  drop constraint if exists operations_hub_change_queue_base_price_source_check;

alter table public.operations_hub_change_queue
  add constraint operations_hub_change_queue_price_version_check
    check (price_calculation_version in (1,2)),
  add constraint operations_hub_change_queue_pricing_input_mode_check
    check (pricing_input_mode is null or pricing_input_mode in ('legacy_final','option','final')),
  add constraint operations_hub_change_queue_base_price_source_check
    check (base_price_source is null or base_price_source in ('source','tag','manual'));

update public.operations_hub_change_queue queue
set pricing_input_mode = coalesce(queue.pricing_input_mode, 'legacy_final')
where queue.field_key = 'sellpia_sale_price'
  and queue.pricing_input_mode is null;

alter table public.operations_hub_export_items
  add column if not exists target_discounted_base_price numeric,
  add column if not exists price_calculation_version smallint not null default 1,
  add column if not exists pricing_input_mode text,
  add column if not exists base_price_source text,
  add column if not exists source_snapshot_id uuid references public.seller_inventory_snapshots(snapshot_id) on delete set null,
  add column if not exists source_discount_fingerprint text;

alter table public.operations_hub_export_items
  drop constraint if exists operations_hub_export_items_price_version_check,
  drop constraint if exists operations_hub_export_items_pricing_input_mode_check;

alter table public.operations_hub_export_items
  add constraint operations_hub_export_items_price_version_check
    check (price_calculation_version in (1,2)),
  add constraint operations_hub_export_items_pricing_input_mode_check
    check (pricing_input_mode is null or pricing_input_mode in ('legacy_final','option','final'));

create or replace function operations_private.calculate_operations_hub_discounted_base(
  p_source text,
  p_base_price numeric,
  p_discount_terms jsonb,
  p_reported_discounted_price numeric default null
)
returns numeric
language plpgsql
immutable
set search_path = pg_catalog, pg_temp
as $$
declare
  v_price numeric := p_base_price;
  v_term jsonb;
  v_value numeric;
  v_unit numeric;
  v_rounding text;
begin
  if p_base_price is null then return null; end if;
  if jsonb_typeof(coalesce(p_discount_terms, '[]'::jsonb)) <> 'array' then return p_base_price; end if;

  for v_term in
    select term
    from jsonb_array_elements(coalesce(p_discount_terms, '[]'::jsonb)) term
    where coalesce((term ->> 'is_baseline')::boolean, false)
  loop
    v_value := nullif(v_term ->> 'value', '')::numeric;
    if v_value is null then continue; end if;
    if v_term ->> 'unit' = 'percent' then
      v_price := v_price * (1 - abs(v_value) / 100.0);
    elsif v_term ->> 'unit' = 'amount' then
      v_price := v_price - abs(v_value);
    end if;

    v_unit := greatest(coalesce(nullif(v_term ->> 'rounding_unit', '')::numeric, 1), 1);
    v_rounding := coalesce(nullif(v_term ->> 'rounding_mode', ''), 'none');
    v_price := case v_rounding
      when 'down' then floor(v_price / v_unit) * v_unit
      when 'up' then ceil(v_price / v_unit) * v_unit
      when 'nearest' then round(v_price / v_unit) * v_unit
      else v_price
    end;
  end loop;

  if p_source = 'ably' and p_reported_discounted_price is not null
     and jsonb_array_length(coalesce(p_discount_terms, '[]'::jsonb)) = 0 then
    v_price := p_reported_discounted_price;
  end if;
  return greatest(v_price, 0);
end;
$$;

comment on function operations_private.calculate_operations_hub_discounted_base(text,numeric,jsonb,numeric) is
  'Applies only baseline native marketplace discount terms to a seller base price. Conditional terms remain audit metadata.';

create or replace function public.finalize_seller_inventory_snapshot(p_snapshot_id uuid)
returns table(snapshot_id uuid, source_channel text, row_count integer, completed_at timestamptz)
language plpgsql
security invoker
set search_path = public, operations_private, pg_temp
as $$
declare
  v_source text;
  v_selected jsonb;
  v_upload_mode text;
  v_previous uuid;
  v_completed timestamptz := now();
  v_input_row_count integer := 0;
  v_row_count integer := 0;
  v_price_selected boolean;
  v_discount_selected boolean;
begin
  select snapshot.source_channel, snapshot.selected_fields, snapshot.upload_mode
    into v_source, v_selected, v_upload_mode
  from public.seller_inventory_snapshots snapshot
  where snapshot.snapshot_id = p_snapshot_id
    and snapshot.uploaded_by = 'operations_hub_frontend'
    and snapshot.upload_status = 'uploading'
  for update;
  if not found then raise exception '업로드 중인 판매처 스냅샷을 찾을 수 없습니다.'; end if;

  v_price_selected := coalesce((v_selected ->> 'price')::boolean, false);
  v_discount_selected := coalesce((v_selected ->> 'discount')::boolean, v_price_selected);

  select count(*)::integer into v_input_row_count
  from public.seller_inventory_snapshot_rows row_item
  where row_item.snapshot_id = p_snapshot_id;

  select snapshot.snapshot_id into v_previous
  from public.seller_inventory_snapshots snapshot
  where snapshot.source_channel = v_source
    and snapshot.upload_status = 'ready'
    and snapshot.snapshot_id <> p_snapshot_id
  order by snapshot.completed_at desc nulls last, snapshot.created_at desc
  limit 1;

  if v_upload_mode = 'patch' and v_previous is null then
    raise exception '부분 갱신 기준이 되는 이전 판매처 원본이 없습니다. 최초 1회는 전체 업로드가 필요합니다.';
  end if;

  if v_upload_mode = 'patch' then
    update public.seller_inventory_snapshots snapshot
    set base_snapshot_id = v_previous
    where snapshot.snapshot_id = p_snapshot_id;

    insert into public.seller_inventory_snapshot_rows (
      snapshot_id, product_code, option_code, seller_code, product_name,
      option_name, stock, price, base_price, option_price, discounted_base_price,
      final_price, reported_final_price, discount_calculation_status,
      discount_terms, price_calculation_version, sale_status, source_row_no, raw_payload
    )
    select
      p_snapshot_id, previous_row.product_code, previous_row.option_code,
      previous_row.seller_code, previous_row.product_name, previous_row.option_name,
      previous_row.stock, previous_row.price, previous_row.base_price,
      previous_row.option_price, previous_row.discounted_base_price,
      previous_row.final_price, previous_row.reported_final_price,
      previous_row.discount_calculation_status, previous_row.discount_terms,
      previous_row.price_calculation_version, previous_row.sale_status,
      previous_row.source_row_no,
      previous_row.raw_payload || jsonb_build_object(
        '_patch_preserved', true,
        '_patch_preserved_from_snapshot_id', v_previous
      )
    from public.seller_inventory_snapshot_rows previous_row
    where previous_row.snapshot_id = v_previous
      and not exists (
        select 1 from public.seller_inventory_snapshot_rows current_row
        where current_row.snapshot_id = p_snapshot_id
          and current_row.product_code = previous_row.product_code
          and current_row.option_code = previous_row.option_code
      );
  end if;

  if v_previous is not null then
    update public.seller_inventory_snapshot_rows current_row
    set
      seller_code = case when coalesce((v_selected ->> 'basic')::boolean, false) then current_row.seller_code else previous_row.seller_code end,
      product_name = case when coalesce((v_selected ->> 'basic')::boolean, false) then current_row.product_name else previous_row.product_name end,
      option_name = case when coalesce((v_selected ->> 'basic')::boolean, false) then current_row.option_name else previous_row.option_name end,
      stock = case when coalesce((v_selected ->> 'inventory')::boolean, false) then current_row.stock else previous_row.stock end,
      base_price = case when v_price_selected then current_row.base_price else previous_row.base_price end,
      option_price = case when v_price_selected then current_row.option_price else previous_row.option_price end,
      reported_final_price = case when v_discount_selected then current_row.reported_final_price else previous_row.reported_final_price end,
      discount_calculation_status = case when v_discount_selected then current_row.discount_calculation_status else previous_row.discount_calculation_status end,
      discount_terms = case when v_discount_selected then current_row.discount_terms else previous_row.discount_terms end,
      price_calculation_version = greatest(coalesce(current_row.price_calculation_version, 1), coalesce(previous_row.price_calculation_version, 1)),
      sale_status = case when coalesce((v_selected ->> 'status')::boolean, false) then current_row.sale_status else previous_row.sale_status end
    from public.seller_inventory_snapshot_rows previous_row
    where current_row.snapshot_id = p_snapshot_id
      and previous_row.snapshot_id = v_previous
      and previous_row.product_code = current_row.product_code
      and previous_row.option_code = current_row.option_code;
  end if;

  update public.seller_inventory_snapshot_rows row_item
  set
    base_price = coalesce(row_item.base_price, nullif(row_item.raw_payload ->> 'base_price', '')::numeric, row_item.price),
    option_price = coalesce(row_item.option_price, nullif(row_item.raw_payload ->> 'option_price', '')::numeric, 0),
    discounted_base_price = operations_private.calculate_operations_hub_discounted_base(
      v_source,
      coalesce(row_item.base_price, nullif(row_item.raw_payload ->> 'base_price', '')::numeric, row_item.price),
      row_item.discount_terms,
      row_item.discounted_base_price
    ),
    final_price = operations_private.calculate_operations_hub_discounted_base(
      v_source,
      coalesce(row_item.base_price, nullif(row_item.raw_payload ->> 'base_price', '')::numeric, row_item.price),
      row_item.discount_terms,
      row_item.discounted_base_price
    ) + coalesce(row_item.option_price, nullif(row_item.raw_payload ->> 'option_price', '')::numeric, 0),
    price = operations_private.calculate_operations_hub_discounted_base(
      v_source,
      coalesce(row_item.base_price, nullif(row_item.raw_payload ->> 'base_price', '')::numeric, row_item.price),
      row_item.discount_terms,
      row_item.discounted_base_price
    ) + coalesce(row_item.option_price, nullif(row_item.raw_payload ->> 'option_price', '')::numeric, 0),
    discount_calculation_status = coalesce(row_item.discount_calculation_status, 'none'),
    price_calculation_version = coalesce(row_item.price_calculation_version, 2)
  where row_item.snapshot_id = p_snapshot_id;

  select count(*)::integer into v_row_count
  from public.seller_inventory_snapshot_rows row_item
  where row_item.snapshot_id = p_snapshot_id;

  update public.seller_inventory_snapshots snapshot
  set valid_row_count = v_row_count,
      invalid_row_count = greatest(snapshot.source_row_count - v_input_row_count, 0),
      upload_status = 'ready', completed_at = v_completed,
      metadata = snapshot.metadata || jsonb_build_object(
        'upload_mode', v_upload_mode,
        'base_snapshot_id', v_previous,
        'uploaded_row_count', v_input_row_count,
        'effective_row_count', v_row_count,
        'preserved_row_count', greatest(v_row_count - v_input_row_count, 0),
        'price_components', true,
        'seller_discount_terms_v2', true
      )
  where snapshot.snapshot_id = p_snapshot_id;

  return query select p_snapshot_id, v_source, v_row_count, v_completed;
end;
$$;

create or replace view public.operations_hub_active_seller_drafts
with (security_invoker = true)
as
select distinct on (queue.sellpia_sku_code, queue.source_channel, queue.field_key)
  queue.change_id, queue.sellpia_sku_code, queue.source_channel, queue.field_key,
  queue.before_value, queue.after_value, queue.status, queue.updated_at,
  queue.price_base_before, queue.price_base_after,
  queue.price_option_before, queue.price_option_after,
  queue.price_final_before, queue.price_final_after,
  queue.option_price_source, queue.price_rule_set_id,
  queue.price_discounted_base_before, queue.price_discounted_base_after,
  queue.base_price_source, queue.price_calculation_version,
  queue.pricing_input_mode, queue.source_snapshot_id,
  queue.source_discount_fingerprint
from public.operations_hub_change_queue queue
where queue.source_channel in ('smartstore','makeshop','ably')
  and queue.field_key in ('sellpia_current_stock','sellpia_sale_price')
  and queue.status in ('pending','validated','processing','exported','failed')
order by queue.sellpia_sku_code, queue.source_channel, queue.field_key,
         queue.updated_at desc, queue.change_id desc;

grant select on public.operations_hub_active_seller_drafts to anon, authenticated;

drop function if exists public.load_operations_hub_seller_price_components(text[]);
create function public.load_operations_hub_seller_price_components(p_skus text[])
returns table(
  sellpia_sku_code text,
  source_channel text,
  seller_product_code text,
  seller_option_code text,
  source_base_price numeric,
  source_discounted_base_price numeric,
  source_option_price numeric,
  source_final_price numeric,
  source_reported_final_price numeric,
  source_discount_terms jsonb,
  source_discount_calculation_status text,
  source_discount_fingerprint text,
  draft_base_price numeric,
  draft_discounted_base_price numeric,
  draft_option_price numeric,
  draft_final_price numeric,
  option_price_source text,
  base_price_source text,
  price_rule_set_id bigint,
  pricing_input_mode text,
  price_calculation_version smallint,
  draft_change_id bigint,
  draft_status text,
  draft_updated_at timestamptz
)
language sql
stable
security invoker
set search_path = public, operations_private, pg_temp
as $$
  with requested as materialized (
    select distinct btrim(sku) as sellpia_sku_code
    from unnest(coalesce(p_skus, '{}'::text[])) sku
    where nullif(btrim(sku), '') is not null
  ),
  latest_snapshot as materialized (
    select distinct on (snapshot.source_channel)
      snapshot.source_channel, snapshot.snapshot_id
    from public.seller_inventory_snapshots snapshot
    where snapshot.upload_status = 'ready'
      and snapshot.source_channel in ('smartstore','makeshop','ably')
    order by snapshot.source_channel,
             snapshot.completed_at desc nulls last,
             snapshot.created_at desc
  ),
  mapped as materialized (
    select matrix.sellpia_sku_code, source.source_channel,
      case source.source_channel
        when 'smartstore' then matrix.smartstore_product_code
        when 'makeshop' then matrix.makeshop_product_code
        when 'ably' then matrix.ably_product_code
      end as seller_product_code,
      case source.source_channel
        when 'smartstore' then coalesce(matrix.smartstore_option_code, '')
        when 'makeshop' then coalesce(matrix.makeshop_option_code, '')
        when 'ably' then coalesce(matrix.ably_option_code, '')
      end as seller_option_code
    from public.operations_hub_matrix_cached matrix
    join requested using (sellpia_sku_code)
    cross join lateral unnest(array['smartstore','makeshop','ably']::text[]) source(source_channel)
  )
  select
    mapped.sellpia_sku_code, mapped.source_channel,
    mapped.seller_product_code, mapped.seller_option_code,
    coalesce(source_row.base_price, nullif(source_row.raw_payload ->> 'base_price', '')::numeric, source_row.price),
    coalesce(source_row.discounted_base_price, source_row.base_price, source_row.price),
    coalesce(source_row.option_price, nullif(source_row.raw_payload ->> 'option_price', '')::numeric, 0),
    coalesce(source_row.final_price, source_row.price),
    source_row.reported_final_price,
    coalesce(source_row.discount_terms, '[]'::jsonb),
    coalesce(source_row.discount_calculation_status, 'none'),
    source_row.source_discount_fingerprint,
    draft.price_base_after,
    draft.price_discounted_base_after,
    draft.price_option_after,
    coalesce(draft.price_final_after, nullif(draft.after_value #>> '{}', '')::numeric),
    draft.option_price_source,
    draft.base_price_source,
    draft.price_rule_set_id,
    draft.pricing_input_mode,
    draft.price_calculation_version,
    draft.change_id, draft.status, draft.updated_at
  from mapped
  left join latest_snapshot snapshot using (source_channel)
  left join public.seller_inventory_snapshot_rows source_row
    on source_row.snapshot_id = snapshot.snapshot_id
   and source_row.product_code = mapped.seller_product_code
   and source_row.option_code = mapped.seller_option_code
  left join public.operations_hub_active_seller_drafts draft
    on draft.sellpia_sku_code = mapped.sellpia_sku_code
   and draft.source_channel = mapped.source_channel
   and draft.field_key = 'sellpia_sale_price';
$$;

create or replace function public.save_operations_hub_seller_price_draft_v2(
  p_sku text,
  p_source text,
  p_target_base_price numeric,
  p_input_mode text,
  p_option_price numeric default null,
  p_target_final_price numeric default null,
  p_option_price_source text default 'original',
  p_base_price_source text default 'tag',
  p_price_rule_set_id bigint default null,
  p_batch_id uuid default null
)
returns table(
  change_id bigint,
  draft_status text,
  cancelled_count integer,
  change_batch_id uuid,
  source_base_price numeric,
  source_discounted_base_price numeric,
  source_option_price numeric,
  source_final_price numeric,
  draft_base_price numeric,
  draft_discounted_base_price numeric,
  draft_option_price numeric,
  draft_final_price numeric,
  saved_input_mode text,
  saved_at timestamptz
)
language plpgsql
security invoker
set search_path = public, operations_private, pg_temp
as $$
declare
  v_matrix public.operations_hub_matrix_cached%rowtype;
  v_snapshot_id uuid;
  v_source_row public.seller_inventory_snapshot_rows%rowtype;
  v_product_code text;
  v_option_code text;
  v_source_base numeric;
  v_source_discounted numeric;
  v_source_option numeric;
  v_source_final numeric;
  v_target_discounted numeric;
  v_target_option numeric;
  v_target_final numeric;
  v_cancelled integer := 0;
  v_change_id bigint;
  v_batch_id uuid := coalesce(p_batch_id, gen_random_uuid());
  v_saved_at timestamptz := now();
begin
  p_sku := btrim(p_sku);
  p_source := lower(btrim(p_source));
  p_input_mode := lower(btrim(p_input_mode));
  p_option_price_source := lower(coalesce(nullif(btrim(p_option_price_source), ''), 'original'));
  p_base_price_source := lower(coalesce(nullif(btrim(p_base_price_source), ''), 'tag'));

  if p_source not in ('smartstore','makeshop','ably') then raise exception '지원하지 않는 판매처입니다: %', p_source; end if;
  if p_input_mode not in ('option','final') then raise exception '입력 방식은 option 또는 final이어야 합니다.'; end if;
  if p_target_base_price is null or p_target_base_price < 0 then raise exception '태그 계산 판매가는 0 이상의 숫자여야 합니다.'; end if;
  if p_option_price_source not in ('original','manual','tag') then raise exception '옵션가 출처가 올바르지 않습니다.'; end if;
  if p_base_price_source not in ('source','tag','manual') then raise exception '판매가 출처가 올바르지 않습니다.'; end if;

  select * into v_matrix
  from public.operations_hub_matrix_cached matrix
  where matrix.sellpia_sku_code = p_sku;
  if not found then raise exception '매트릭스에 없는 셀피아 SKU입니다: %', p_sku; end if;

  v_product_code := case p_source
    when 'smartstore' then v_matrix.smartstore_product_code
    when 'makeshop' then v_matrix.makeshop_product_code
    when 'ably' then v_matrix.ably_product_code end;
  v_option_code := case p_source
    when 'smartstore' then coalesce(v_matrix.smartstore_option_code, '')
    when 'makeshop' then coalesce(v_matrix.makeshop_option_code, '')
    when 'ably' then coalesce(v_matrix.ably_option_code, '') end;
  if nullif(btrim(v_product_code), '') is null then raise exception '판매처 연결 상품코드가 없습니다.'; end if;

  select snapshot.snapshot_id into v_snapshot_id
  from public.seller_inventory_snapshots snapshot
  where snapshot.source_channel = p_source and snapshot.upload_status = 'ready'
  order by snapshot.completed_at desc nulls last, snapshot.created_at desc limit 1;

  select * into v_source_row
  from public.seller_inventory_snapshot_rows row_item
  where row_item.snapshot_id = v_snapshot_id
    and row_item.product_code = v_product_code
    and row_item.option_code = coalesce(v_option_code, '');
  if not found then raise exception '최신 판매처 원본에서 상품·옵션코드를 찾지 못했습니다.'; end if;

  v_source_base := coalesce(v_source_row.base_price, nullif(v_source_row.raw_payload ->> 'base_price', '')::numeric, v_source_row.price);
  v_source_discounted := coalesce(v_source_row.discounted_base_price, v_source_base);
  v_source_option := coalesce(v_source_row.option_price, nullif(v_source_row.raw_payload ->> 'option_price', '')::numeric, 0);
  v_source_final := coalesce(v_source_row.final_price, v_source_row.price, v_source_discounted + v_source_option);
  v_target_discounted := operations_private.calculate_operations_hub_discounted_base(
    p_source, p_target_base_price, v_source_row.discount_terms, v_source_row.discounted_base_price
  );

  if p_input_mode = 'option' then
    v_target_option := coalesce(p_option_price, v_source_option, 0);
    v_target_final := v_target_discounted + v_target_option;
  else
    if p_target_final_price is null or p_target_final_price < 0 then raise exception '목표 최종구매가는 0 이상의 숫자여야 합니다.'; end if;
    v_target_final := p_target_final_price;
    v_target_option := v_target_final - v_target_discounted;
  end if;

  if p_price_rule_set_id is not null and not exists (
    select 1 from public.operations_hub_price_rule_sets rule_set
    where rule_set.price_rule_set_id = p_price_rule_set_id and rule_set.is_active
  ) then raise exception '활성 가격 조합 태그를 찾을 수 없습니다: %', p_price_rule_set_id; end if;

  update public.operations_hub_change_queue queue
  set status = 'cancelled', cancelled_at = v_saved_at,
      cancelled_by = 'operations_hub_frontend',
      status_message = '더 최신인 판매처 가격 수정으로 대체됨', updated_at = v_saved_at
  where queue.sellpia_sku_code = p_sku
    and queue.source_channel = p_source
    and queue.field_key = 'sellpia_sale_price'
    and queue.status in ('pending','validated','failed');
  get diagnostics v_cancelled = row_count;

  if v_source_base is not distinct from p_target_base_price
     and v_source_option is not distinct from v_target_option
     and v_source_final is not distinct from v_target_final then
    return query select null::bigint, 'unchanged'::text, v_cancelled, v_batch_id,
      v_source_base, v_source_discounted, v_source_option, v_source_final,
      p_target_base_price, v_target_discounted, v_target_option, v_target_final,
      p_input_mode, v_saved_at;
    return;
  end if;

  insert into public.operations_hub_change_queue (
    change_batch_id, sellpia_sku_code, field_key, before_value, after_value,
    target_channels, status, requested_by, requested_at, updated_at,
    source_channel, seller_product_code, seller_option_code, status_message,
    price_base_before, price_base_after,
    price_discounted_base_before, price_discounted_base_after,
    price_option_before, price_option_after,
    price_final_before, price_final_after,
    option_price_source, base_price_source, price_rule_set_id,
    price_calculation_version, pricing_input_mode,
    source_snapshot_id, source_discount_fingerprint
  ) values (
    v_batch_id, p_sku, 'sellpia_sale_price', to_jsonb(v_source_final), to_jsonb(v_target_final),
    array[p_source], 'pending', 'operations_hub_frontend', v_saved_at, v_saved_at,
    p_source, v_product_code, coalesce(v_option_code, ''), 'DB 저장됨 · 판매처 원본 반영 대기',
    v_source_base, p_target_base_price,
    v_source_discounted, v_target_discounted,
    v_source_option, v_target_option,
    v_source_final, v_target_final,
    p_option_price_source, p_base_price_source, p_price_rule_set_id,
    2, p_input_mode, v_snapshot_id, v_source_row.source_discount_fingerprint
  ) returning operations_hub_change_queue.change_id into v_change_id;

  return query select v_change_id, 'pending'::text, v_cancelled, v_batch_id,
    v_source_base, v_source_discounted, v_source_option, v_source_final,
    p_target_base_price, v_target_discounted, v_target_option, v_target_final,
    p_input_mode, v_saved_at;
end;
$$;

comment on function public.save_operations_hub_seller_price_draft_v2(text,text,numeric,text,numeric,numeric,text,text,bigint,uuid) is
  'Stores a V2 seller price proposal as tag-derived base price, native-discounted base, option adjustment, and final customer price.';

revoke all on function public.load_operations_hub_seller_price_components(text[]) from public;
revoke all on function public.save_operations_hub_seller_price_draft_v2(text,text,numeric,text,numeric,numeric,text,text,bigint,uuid) from public;
grant execute on function public.load_operations_hub_seller_price_components(text[]) to anon, authenticated;
grant execute on function public.save_operations_hub_seller_price_draft_v2(text,text,numeric,text,numeric,numeric,text,text,bigint,uuid) to anon, authenticated;

notify pgrst, 'reload schema';
