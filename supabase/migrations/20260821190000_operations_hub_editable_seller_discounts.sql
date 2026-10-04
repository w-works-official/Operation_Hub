-- Editable marketplace-native discount terms.
-- Discount definitions stay attached to the reviewed price draft so a later
-- source upload cannot silently change the calculation used for export.

alter table public.operations_hub_change_queue
  add column if not exists price_discount_terms_before jsonb,
  add column if not exists price_discount_terms_after jsonb;

alter table public.operations_hub_export_items
  add column if not exists source_discount_terms jsonb,
  add column if not exists target_discount_terms jsonb;

alter table public.operations_hub_change_queue
  drop constraint if exists operations_hub_change_queue_price_discount_terms_check;
alter table public.operations_hub_change_queue
  add constraint operations_hub_change_queue_price_discount_terms_check check (
    (price_discount_terms_before is null or jsonb_typeof(price_discount_terms_before) = 'array')
    and (price_discount_terms_after is null or jsonb_typeof(price_discount_terms_after) = 'array')
  );

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
  queue.source_discount_fingerprint,
  queue.price_discount_terms_before, queue.price_discount_terms_after
from public.operations_hub_change_queue queue
where queue.source_channel in ('smartstore','makeshop','ably')
  and queue.field_key in ('sellpia_current_stock','sellpia_sale_price')
  and queue.status in ('pending','validated','processing','exported','failed')
order by queue.sellpia_sku_code, queue.source_channel, queue.field_key,
         queue.updated_at desc, queue.change_id desc;

grant select on public.operations_hub_active_seller_drafts to anon, authenticated;

create or replace function public.save_operations_hub_seller_discount_draft(
  p_sku text,
  p_source text,
  p_discount_terms jsonb,
  p_input_mode text default 'option',
  p_option_price numeric default null,
  p_target_final_price numeric default null,
  p_batch_id uuid default null
)
returns table(
  change_id bigint, draft_status text, cancelled_count integer, change_batch_id uuid,
  source_base_price numeric, source_discounted_base_price numeric,
  source_option_price numeric, source_final_price numeric,
  draft_base_price numeric, draft_discounted_base_price numeric,
  draft_option_price numeric, draft_final_price numeric,
  saved_input_mode text, saved_at timestamptz,
  draft_discount_terms jsonb
)
language plpgsql
security invoker
set search_path = public, operations_private, pg_temp
as $$
declare
  v_matrix public.operations_hub_matrix_cached%rowtype;
  v_snapshot_id uuid;
  v_source_row public.seller_inventory_snapshot_rows%rowtype;
  v_existing public.operations_hub_change_queue%rowtype;
  v_product_code text;
  v_option_code text;
  v_source_base numeric;
  v_source_discounted numeric;
  v_source_option numeric;
  v_source_final numeric;
  v_target_base numeric;
  v_target_discounted numeric;
  v_target_option numeric;
  v_target_final numeric;
  v_cancelled integer := 0;
  v_change_id bigint;
  v_batch_id uuid := coalesce(p_batch_id, gen_random_uuid());
  v_saved_at timestamptz := now();
begin
  p_sku := btrim(coalesce(p_sku, ''));
  p_source := lower(btrim(coalesce(p_source, '')));
  p_input_mode := lower(btrim(coalesce(p_input_mode, 'option')));
  p_discount_terms := coalesce(p_discount_terms, '[]'::jsonb);
  if p_source not in ('smartstore','makeshop','ably') then raise exception '지원하지 않는 판매처입니다.'; end if;
  if p_input_mode not in ('option','final') then raise exception '입력 방식은 option 또는 final이어야 합니다.'; end if;
  if jsonb_typeof(p_discount_terms) <> 'array' then raise exception '할인조건은 JSON 배열이어야 합니다.'; end if;
  if exists (
    select 1 from jsonb_array_elements(p_discount_terms) term
    where nullif(term ->> 'value', '') is not null
      and ((term ->> 'value')::numeric < 0 or term ->> 'unit' not in ('percent','amount'))
  ) then raise exception '할인값과 단위를 확인해주세요.'; end if;

  select * into v_matrix from public.operations_hub_matrix_cached matrix where matrix.sellpia_sku_code = p_sku;
  if not found then raise exception '매트릭스에 없는 셀피아 SKU입니다: %', p_sku; end if;
  v_product_code := case p_source when 'smartstore' then v_matrix.smartstore_product_code when 'makeshop' then v_matrix.makeshop_product_code when 'ably' then v_matrix.ably_product_code end;
  v_option_code := case p_source when 'smartstore' then coalesce(v_matrix.smartstore_option_code, '') when 'makeshop' then coalesce(v_matrix.makeshop_option_code, '') when 'ably' then coalesce(v_matrix.ably_option_code, '') end;
  if nullif(btrim(v_product_code), '') is null then raise exception '판매처 연결 상품코드가 없습니다.'; end if;

  select snapshot.snapshot_id into v_snapshot_id
  from public.seller_inventory_snapshots snapshot
  where snapshot.source_channel = p_source and snapshot.upload_status = 'ready'
  order by snapshot.completed_at desc nulls last, snapshot.created_at desc limit 1;
  select * into v_source_row from public.seller_inventory_snapshot_rows row_item
  where row_item.snapshot_id = v_snapshot_id and row_item.product_code = v_product_code
    and row_item.option_code = coalesce(v_option_code, '');
  if not found then raise exception '최신 판매처 원본에서 상품·옵션코드를 찾지 못했습니다.'; end if;

  select * into v_existing from public.operations_hub_change_queue queue
  where queue.sellpia_sku_code = p_sku and queue.source_channel = p_source
    and queue.field_key = 'sellpia_sale_price' and queue.status in ('pending','validated','failed')
  order by queue.updated_at desc, queue.change_id desc limit 1;

  v_source_base := coalesce(v_source_row.base_price, nullif(v_source_row.raw_payload ->> 'base_price', '')::numeric, v_source_row.price);
  v_source_discounted := coalesce(v_source_row.discounted_base_price, v_source_base);
  v_source_option := coalesce(v_source_row.option_price, nullif(v_source_row.raw_payload ->> 'option_price', '')::numeric, 0);
  v_source_final := coalesce(v_source_row.final_price, v_source_row.price, v_source_discounted + v_source_option);
  v_target_base := coalesce(v_existing.price_base_after, v_source_base);
  v_target_discounted := operations_private.calculate_operations_hub_discounted_base(p_source, v_target_base, p_discount_terms, null);
  if p_input_mode = 'final' then
    v_target_final := coalesce(p_target_final_price, v_existing.price_final_after, v_source_final);
    v_target_option := v_target_final - v_target_discounted;
  else
    v_target_option := coalesce(p_option_price, v_existing.price_option_after, v_source_option, 0);
    v_target_final := v_target_discounted + v_target_option;
  end if;
  if v_target_final < 0 then raise exception '최종구매가는 0 이상이어야 합니다.'; end if;

  update public.operations_hub_change_queue queue
  set status='cancelled', cancelled_at=v_saved_at, cancelled_by='operations_hub_frontend',
      status_message='더 최신인 할인조건 수정으로 대체됨', updated_at=v_saved_at
  where queue.sellpia_sku_code=p_sku and queue.source_channel=p_source
    and queue.field_key='sellpia_sale_price' and queue.status in ('pending','validated','failed');
  get diagnostics v_cancelled = row_count;

  if v_source_base is not distinct from v_target_base
     and v_source_option is not distinct from v_target_option
     and v_source_final is not distinct from v_target_final
     and coalesce(v_source_row.discount_terms, '[]'::jsonb) = p_discount_terms then
    return query select null::bigint, 'unchanged'::text, v_cancelled, v_batch_id,
      v_source_base, v_source_discounted, v_source_option, v_source_final,
      v_target_base, v_target_discounted, v_target_option, v_target_final,
      p_input_mode, v_saved_at, p_discount_terms;
    return;
  end if;

  insert into public.operations_hub_change_queue(
    change_batch_id,sellpia_sku_code,field_key,before_value,after_value,target_channels,status,
    requested_by,requested_at,updated_at,source_channel,seller_product_code,seller_option_code,status_message,
    price_base_before,price_base_after,price_discounted_base_before,price_discounted_base_after,
    price_option_before,price_option_after,price_final_before,price_final_after,
    option_price_source,base_price_source,price_rule_set_id,price_calculation_version,pricing_input_mode,
    source_snapshot_id,source_discount_fingerprint,price_discount_terms_before,price_discount_terms_after
  ) values (
    v_batch_id,p_sku,'sellpia_sale_price',to_jsonb(v_source_final),to_jsonb(v_target_final),array[p_source],'pending',
    'operations_hub_frontend',v_saved_at,v_saved_at,p_source,v_product_code,coalesce(v_option_code,''),'DB 저장됨 · 할인조건 포함 원본 반영 대기',
    v_source_base,v_target_base,v_source_discounted,v_target_discounted,
    v_source_option,v_target_option,v_source_final,v_target_final,
    coalesce(v_existing.option_price_source,'original'),coalesce(v_existing.base_price_source,'source'),v_existing.price_rule_set_id,2,p_input_mode,
    v_snapshot_id,v_source_row.source_discount_fingerprint,coalesce(v_source_row.discount_terms,'[]'::jsonb),p_discount_terms
  ) returning operations_hub_change_queue.change_id into v_change_id;

  return query select v_change_id,'pending'::text,v_cancelled,v_batch_id,
    v_source_base,v_source_discounted,v_source_option,v_source_final,
    v_target_base,v_target_discounted,v_target_option,v_target_final,
    p_input_mode,v_saved_at,p_discount_terms;
end;
$$;

revoke all on function public.save_operations_hub_seller_discount_draft(text,text,jsonb,text,numeric,numeric,uuid) from public;
grant execute on function public.save_operations_hub_seller_discount_draft(text,text,jsonb,text,numeric,numeric,uuid) to anon, authenticated;

create or replace function public.hydrate_operations_hub_export_price_v2()
returns trigger
language plpgsql
security invoker
set search_path = public, operations_private, pg_temp
as $$
declare
  v_queue public.operations_hub_change_queue%rowtype;
  v_latest_snapshot uuid;
  v_source_row public.seller_inventory_snapshot_rows%rowtype;
  v_source_base numeric;
  v_source_option numeric;
  v_source_final numeric;
begin
  if new.change_id is null or new.field_key <> 'sellpia_sale_price' then return new; end if;
  select * into v_queue from public.operations_hub_change_queue queue where queue.change_id = new.change_id;
  if not found then return new; end if;
  new.target_discounted_base_price := coalesce(v_queue.price_discounted_base_after,new.target_base_price);
  new.price_calculation_version := coalesce(v_queue.price_calculation_version,1);
  new.pricing_input_mode := coalesce(v_queue.pricing_input_mode,'legacy_final');
  new.base_price_source := v_queue.base_price_source;
  new.source_snapshot_id := v_queue.source_snapshot_id;
  new.source_discount_fingerprint := v_queue.source_discount_fingerprint;
  new.source_discount_terms := v_queue.price_discount_terms_before;
  new.target_discount_terms := v_queue.price_discount_terms_after;
  if new.price_calculation_version <> 2 then return new; end if;
  select snapshot.snapshot_id into v_latest_snapshot from public.seller_inventory_snapshots snapshot
  where snapshot.source_channel=new.source_channel and snapshot.upload_status='ready'
  order by snapshot.completed_at desc nulls last,snapshot.created_at desc limit 1;
  select * into v_source_row from public.seller_inventory_snapshot_rows row_item
  where row_item.snapshot_id=v_latest_snapshot and row_item.product_code=new.seller_product_code
    and row_item.option_code=coalesce(new.seller_option_code,'');
  if not found then new.blocking_reason:=coalesce(new.blocking_reason,'최신 판매처 원본에서 가격 검증 대상을 찾지 못했습니다.'); return new; end if;
  new.source_discount_terms := coalesce(new.source_discount_terms,v_source_row.discount_terms,'[]'::jsonb);
  new.target_discount_terms := coalesce(new.target_discount_terms,v_source_row.discount_terms,'[]'::jsonb);
  v_source_base:=coalesce(v_source_row.base_price,nullif(v_source_row.raw_payload->>'base_price','')::numeric,v_source_row.price);
  v_source_option:=coalesce(v_source_row.option_price,nullif(v_source_row.raw_payload->>'option_price','')::numeric,0);
  v_source_final:=coalesce(v_source_row.final_price,v_source_row.price,v_source_row.discounted_base_price+v_source_option);
  if v_queue.source_discount_fingerprint is distinct from v_source_row.source_discount_fingerprint
     or v_queue.price_base_before is distinct from v_source_base
     or v_queue.price_option_before is distinct from v_source_option
     or v_queue.price_final_before is distinct from v_source_final then
    new.blocking_reason:=coalesce(new.blocking_reason,'가격 수정안을 저장한 뒤 판매처 원본의 판매가·할인·옵션가가 변경되었습니다. 최신 원본에서 다시 검토해주세요.');
  end if;
  return new;
end;
$$;

notify pgrst, 'reload schema';
