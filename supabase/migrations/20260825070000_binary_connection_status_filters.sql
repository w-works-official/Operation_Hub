do $$
declare
  v_signature regprocedure;
  v_definition text;
  v_rewritten text;
begin
  foreach v_signature in array array[
    'public.load_operations_hub_matrix_filtered_fast(integer,integer,text,text[],text,text,jsonb,text[])'::regprocedure,
    'public.load_operations_hub_matrix_filtered_with_profiles(integer,integer,text,text[],text,text,jsonb,text[])'::regprocedure,
    'public.export_operations_hub_matrix_chunk(integer,integer,text,text[],text,text,jsonb,text[])'::regprocedure
  ]
  loop
    v_definition := pg_get_functiondef(v_signature);
    v_rewritten := replace(
      v_definition,
      $old$and (
        v_status = 'all'
        or (v_status = 'attention' and matrix.overall_status = any(array['review','unmatched']))
        or matrix.overall_status = v_status
      )$old$,
      $new$and (
        v_status = 'all'
        or (v_status in ('connected','review') and matrix.overall_status <> 'unmatched')
        or (v_status in ('unmatched','attention') and matrix.overall_status = 'unmatched')
      )$new$
    );
    v_rewritten := replace(
      v_rewritten,
      $old$and (v_status = 'all' or (v_status = 'attention' and matrix.overall_status = any(array['review','unmatched'])) or matrix.overall_status = v_status)$old$,
      $new$and (v_status = 'all' or (v_status in ('connected','review') and matrix.overall_status <> 'unmatched') or (v_status in ('unmatched','attention') and matrix.overall_status = 'unmatched'))$new$
    );
    if v_rewritten = v_definition then
      raise exception '연결상태 필터 정의를 찾지 못했습니다: %', v_signature;
    end if;
    execute v_rewritten;
  end loop;
end;
$$;

comment on function public.load_operations_hub_matrix_filtered(integer, integer, text, text[], text, text, jsonb, text[]) is
  'Loads matrix rows with binary operational connection filters: connected includes legacy review rows; unmatched includes only rows without links.';

notify pgrst, 'reload schema';
