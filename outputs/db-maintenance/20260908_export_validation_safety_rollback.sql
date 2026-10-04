CREATE OR REPLACE FUNCTION public.validate_operations_hub_changes(p_change_ids bigint[])
 RETURNS TABLE(validated_count integer, failed_count integer)
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_row public.operations_hub_change_queue%rowtype;
  v_errors jsonb;
  v_validated integer := 0;
  v_failed integer := 0;
  v_after text;
begin
  if cardinality(coalesce(p_change_ids, '{}'::bigint[])) = 0 then
    raise exception '검증할 변경사항을 선택해주세요.';
  end if;
  for v_row in
    select * from public.operations_hub_change_queue queue
    where queue.change_id = any(p_change_ids)
      and queue.status in ('pending', 'failed')
    order by queue.change_id
    for update skip locked
  loop
    v_errors := '[]'::jsonb;
    v_after := v_row.after_value #>> '{}';
    if v_row.before_value is not distinct from v_row.after_value then
      v_errors := v_errors || jsonb_build_array('변경 전후 값이 같습니다.');
    end if;
    if v_row.field_key in ('sellpia_current_stock', 'sellpia_sale_price')
       and (coalesce(v_after, '') !~ '^\d+(\.\d+)?$' or v_after::numeric < 0) then
      v_errors := v_errors || jsonb_build_array('재고와 판매가는 0 이상의 숫자여야 합니다.');
    end if;
    if v_row.field_key in ('sellpia_current_stock', 'sellpia_sale_price', 'seller_product_name', 'seller_option_name')
       and cardinality(v_row.target_channels) = 0 then
      v_errors := v_errors || jsonb_build_array('반영할 판매처가 없습니다.');
    end if;
    if v_row.field_key in ('seller_product_name', 'seller_option_name')
       and (v_row.source_channel is null or v_row.seller_product_code is null) then
      v_errors := v_errors || jsonb_build_array('판매처 상품 식별자가 없습니다.');
    end if;

    if jsonb_array_length(v_errors) = 0 then
      update public.operations_hub_change_queue
      set status = 'validated', validation_errors = '[]'::jsonb, validated_at = now(),
          error_message = null, status_message = '검증 완료', updated_at = now()
      where change_id = v_row.change_id;
      v_validated := v_validated + 1;
    else
      update public.operations_hub_change_queue
      set status = 'failed', validation_errors = v_errors, validated_at = now(),
          error_message = v_errors ->> 0, status_message = '검증 실패', updated_at = now()
      where change_id = v_row.change_id;
      v_failed := v_failed + 1;
    end if;
  end loop;
  return query select v_validated, v_failed;
end;
$function$
;
