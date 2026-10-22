-- Scoped, read-only SKU dependencies for opt-in export price inheritance.
-- No source, relation, formula, decision, mapping or export rows are written.
set local lock_timeout = '2s';
set local statement_timeout = '30s';

create function operations_private.hub_export_sku_graph_edges_v1()
returns table(
 edge_id bigint,parent_node_id bigint,child_node_id bigint,
 parent_type text,child_type text,parent_sku text,child_sku text,
 parent_key text,child_key text,sort_order integer,
 edge_updated_at timestamptz,parent_updated_at timestamptz,child_updated_at timestamptz
)
language sql stable security invoker set search_path=pg_catalog
as $edges$
select e.edge_id,e.parent_node_id,e.child_node_id,p.node_type,c.node_type,
 case when p.node_type='sellpia_sku' then nullif(btrim(p.sellpia_sku_code),'')end,
 case when c.node_type='sellpia_sku' then nullif(btrim(c.sellpia_sku_code),'')end,
 case when p.node_type='sellpia_sku'and nullif(btrim(p.sellpia_sku_code),'')is not null
  then 'sku:'||btrim(p.sellpia_sku_code)else 'node:'||p.node_id::text end,
 case when c.node_type='sellpia_sku'and nullif(btrim(c.sellpia_sku_code),'')is not null
  then 'sku:'||btrim(c.sellpia_sku_code)else 'node:'||c.node_id::text end,
 e.sort_order,e.updated_at,p.updated_at,c.updated_at
from public.operations_hub_relation_edges e
join public.operations_hub_relation_nodes p on p.node_id=e.parent_node_id and p.is_active
join public.operations_hub_relation_nodes c on c.node_id=e.child_node_id and c.is_active
where e.is_active;
$edges$;

create function operations_private.hub_export_sku_dependencies_payload_v1(
 p_skus text[],p_expected_version text default null
)
returns jsonb language plpgsql stable security invoker
set search_path=pg_catalog set timezone='UTC' set datestyle='ISO, YMD'
as $payload$
declare
 v_requested text[];v_selected text[];v_reference text[];v_required text[];
 v_desc_keys text[];v_required_keys text[];v_bad text;v_parents text;
 v_snapshot uuid;v_edges jsonb;v_edge_proof jsonb;v_version text;v_covered integer;
begin
 if p_skus is not null and(cardinality(p_skus)=0 or cardinality(p_skus)>50000)then
  raise exception using errcode='22023',message='종속관계 조회는 SKU 1~50,000개 또는 전체 범위(null)만 지원합니다.';
 end if;
 if p_skus is not null and exists(
  select 1 from unnest(p_skus)s(sku)where sku is null or length(btrim(sku))not between 1 and 128
 )then raise exception using errcode='22023',message='유효한 SKU 코드를 지정하세요.';end if;

 select snapshot_id into v_snapshot from public.sellpia_stock_snapshots
 where upload_status='ready'order by created_at desc limit 1;
 if v_snapshot is null then
  raise exception using errcode='22023',message='최신 셀피아 원본이 없어 종속관계를 확인할 수 없습니다.';
 end if;
 if p_skus is null then
  select coalesce(array_agg(sellpia_sku_code order by sellpia_sku_code),'{}')into v_requested
  from public.sellpia_stock_latest;
 else
  select array_agg(sku order by sku)into v_requested
  from(select distinct btrim(sku)sku from unnest(p_skus)s(sku))s;
 end if;
 if cardinality(v_requested)>50000 then
  raise exception using errcode='22023',message='종속관계 조회 범위가 50,000개 SKU를 넘습니다.';
 end if;
 select r.sku into v_bad from unnest(v_requested)r(sku)
 left join public.sellpia_stock_latest s on s.sellpia_sku_code=r.sku
 where s.sellpia_sku_code is null order by r.sku limit 1;
 if v_bad is not null then
  raise exception using errcode='22023',message=format('선택 SKU %s가 최신 셀피아 원본에 없습니다.',v_bad);
 end if;

 -- SKU keys merge equivalent SKU nodes without deriving SKU from product/listing nodes.
 with recursive graph as materialized(select *from operations_private.hub_export_sku_graph_edges_v1()),
 descendants(node_key)as(
  select 'sku:'||sku from unnest(v_requested)r(sku)
  union
  select e.child_key from descendants d join graph e on e.parent_key=d.node_key
 )
 select coalesce(array_agg(node_key),'{}')into v_desc_keys
 from(select node_key from descendants limit 50001)d;
 if cardinality(v_desc_keys)>50000 then
  raise exception using errcode='22023',message='하위 종속관계를 포함한 범위가 50,000개 SKU를 넘습니다.';
 end if;
 select node_key into v_bad from unnest(v_desc_keys)d(node_key)
 where node_key not like 'sku:%'order by node_key limit 1;
 if v_bad is not null then
  raise exception using errcode='22023',
   message=format('가격 종속관계는 SKU 노드만 지원합니다. 상품·판매처·사용자 노드 %s를 SKU 관계로 확인하세요.',v_bad);
 end if;
 select coalesce(array_agg(substring(node_key from 5)order by substring(node_key from 5)),'{}')
 into v_selected from unnest(v_desc_keys)d(node_key);

 -- Ancestors are input-only; their unrelated children do not become output targets.
 with recursive graph as materialized(select *from operations_private.hub_export_sku_graph_edges_v1()),
 ancestors(node_key)as(
  select node_key from unnest(v_desc_keys)d(node_key)
  union
  select e.parent_key from ancestors a join graph e on e.child_key=a.node_key
 )
 select coalesce(array_agg(node_key),'{}')into v_required_keys
 from(select node_key from ancestors limit 50001)a;
 if cardinality(v_required_keys)>50000 then
  raise exception using errcode='22023',message='상위 참조를 포함한 종속관계 범위가 50,000개 SKU를 넘습니다.';
 end if;
 select node_key into v_bad from unnest(v_required_keys)d(node_key)
 where node_key not like 'sku:%'order by node_key limit 1;
 if v_bad is not null then
  raise exception using errcode='22023',
   message=format('가격 종속관계는 SKU 노드만 지원합니다. 상위 상품·판매처·사용자 노드 %s를 SKU 관계로 확인하세요.',v_bad);
 end if;
 select coalesce(array_agg(substring(node_key from 5)order by substring(node_key from 5)),'{}')
 into v_required from unnest(v_required_keys)d(node_key);
 select r.sku into v_bad from unnest(v_required)r(sku)
 left join public.sellpia_stock_latest s on s.sellpia_sku_code=r.sku
 where s.sellpia_sku_code is null order by r.sku limit 1;
 if v_bad is not null then
  raise exception using errcode='22023',message=format('종속관계 SKU %s가 최신 셀피아 원본에 없습니다. 관계를 확인하세요.',v_bad);
 end if;
 select coalesce(array_agg(substring(r.node_key from 5)order by substring(r.node_key from 5)),'{}')
 into v_reference from unnest(v_required_keys)r(node_key)
 left join unnest(v_desc_keys)s(node_key)using(node_key)where s.node_key is null;

 with graph as materialized(select *from operations_private.hub_export_sku_graph_edges_v1()),
 required as materialized(select node_key from unnest(v_required_keys)r(node_key)),
 scoped as(
  select e.*from graph e join required p on p.node_key=e.parent_key
  join required c on c.node_key=e.child_key limit 100001
 )
 select coalesce(jsonb_agg(to_jsonb(e)order by e.parent_sku,e.child_sku,e.edge_id),'[]')
 into v_edge_proof from scoped e;
 if jsonb_array_length(v_edge_proof)>100000 then
  raise exception using errcode='22023',message='종속관계가 100,000개를 넘습니다. 조회 범위를 나누세요.';
 end if;
 select coalesce(jsonb_agg(jsonb_build_object(
  'edge_id',e.edge_id,'parent_node_id',e.parent_node_id,'child_node_id',e.child_node_id,
  'parent_sku',e.parent_sku,'child_sku',e.child_sku
 )order by e.parent_sku,e.child_sku,e.edge_id),'[]')
 into v_edges from jsonb_to_recordset(v_edge_proof)e(
  edge_id bigint,parent_node_id bigint,child_node_id bigint,parent_sku text,child_sku text
 );
 select parent_sku into v_bad from jsonb_to_recordset(v_edges)e(parent_sku text,child_sku text)
 where parent_sku=child_sku order by parent_sku limit 1;
 if v_bad is not null then
  raise exception using errcode='22023',message=format('SKU %s의 자기 참조 종속관계는 사용할 수 없습니다.',v_bad);
 end if;
 select child_sku,string_agg(distinct parent_sku,', 'order by parent_sku)into v_bad,v_parents
 from jsonb_to_recordset(v_edges)e(parent_sku text,child_sku text)
 group by child_sku having count(distinct parent_sku)>1 order by child_sku limit 1;
 if v_bad is not null then
  raise exception using errcode='22023',message=format('SKU %s에 상위 SKU가 여러 개입니다: %s. 가격 기준을 하나로 정하세요.',v_bad,v_parents);
 end if;

 -- With at most one distinct parent per SKU, a cyclic component has no root.
 with recursive graph as materialized(
  select distinct parent_sku,child_sku from jsonb_to_recordset(v_edges)e(parent_sku text,child_sku text)
 ),roots as(
  select r.sku from unnest(v_required)r(sku)
  left join graph g on g.child_sku=r.sku where g.child_sku is null
 ),reachable(sku)as(
  select sku from roots union select g.child_sku from reachable r join graph g on g.parent_sku=r.sku
 )
 select count(*)::integer into v_covered from reachable;
 if v_covered<>cardinality(v_required)then
  raise exception using errcode='22023',message='순환 종속관계가 있어 가격을 상속할 수 없습니다. 관계를 확인하세요.';
 end if;

 v_version:='export-sku-dependencies-v1:'||md5(jsonb_build_object(
  'snapshot_id',v_snapshot,'requested_skus',v_requested,'selected_skus',v_selected,
  'reference_skus',v_reference,'edges',v_edge_proof
 )::text);
 if p_expected_version is not null and p_expected_version<>v_version then
  raise exception using errcode='40001',message='조회 중 SKU 종속관계 또는 셀피아 원본이 변경되었습니다. 미리보기를 다시 만드세요.';
 end if;
 return jsonb_build_object(
  'contract_version',1,'version',v_version,'snapshot_id',v_snapshot,
  'requested_skus',v_requested,'selected_skus',v_selected,'reference_skus',v_reference,'edges',v_edges
 );
end;
$payload$;

create function operations_private.hub_export_sku_dependencies_read_session_v1(
 p_session_token text,p_skus text[],p_expected_version text
)
returns jsonb language plpgsql stable security definer
set search_path=pg_catalog set statement_timeout='20s'
as $session$
begin
 perform operations_private.require_operations_hub_operator_session(p_session_token);
 return operations_private.hub_export_sku_dependencies_payload_v1(p_skus,p_expected_version);
end;
$session$;

create function public.hub_export_sku_dependencies_read_v1(
 p_session_token text,p_skus text[],p_expected_version text default null
)
returns jsonb language sql stable security invoker
set search_path=pg_catalog set statement_timeout='20s'
as $rpc$
 select operations_private.hub_export_sku_dependencies_read_session_v1(p_session_token,p_skus,p_expected_version);
$rpc$;

revoke all on function operations_private.hub_export_sku_graph_edges_v1(),
 operations_private.hub_export_sku_dependencies_payload_v1(text[],text)
 from public,anon,authenticated,service_role;
revoke all on function operations_private.hub_export_sku_dependencies_read_session_v1(text,text[],text),
 public.hub_export_sku_dependencies_read_v1(text,text[],text)
 from public,anon,authenticated,service_role;
grant execute on function operations_private.hub_export_sku_dependencies_read_session_v1(text,text[],text),
 public.hub_export_sku_dependencies_read_v1(text,text[],text)to anon,authenticated;
notify pgrst,'reload schema';

