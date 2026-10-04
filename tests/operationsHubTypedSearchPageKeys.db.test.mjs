import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
test('typed search pages identities without losing count, exactness, sources, status, sorts or advanced-filter delegation',async()=>{
 const {PGlite}=await import(process.env.PGLITE_MODULE||'@electric-sql/pglite'),db=new PGlite();try{
 await db.exec(`create role anon;create role authenticated;create schema operations_private;
 create table operations_private.operations_hub_matrix_export_cache(sellpia_sku_code text primary key,sellpia_own_code text,own_code text,sellpia_product_name text,sellpia_option_name text,smartstore_name text,smartstore_option_name text,makeshop_name text,makeshop_option_name text,ably_name text,ably_option_name text,sellpia_current_stock numeric,sellpia_sale_price numeric,overall_status text,updated_at timestamptz);
 create table public.operations_hub_sku_operational_master(sellpia_sku_code text primary key,stock_quantity numeric,base_price numeric);
 create table public.operations_hub_listing_components(sellpia_sku_code text,is_active boolean,parent_component_id text);
 create function public.load_operations_hub_matrix_filtered_v4(p_page integer,p_page_size integer,p_search text,p_search_sources text[],p_status text,p_sort text,p_filter jsonb,p_skus text[],p_exclude_dependent boolean) returns jsonb language sql as $$select jsonb_build_object('rows',coalesce((select jsonb_agg(jsonb_build_object('sku',sku)) from unnest(p_skus) sku),'[]'),'count',cardinality(p_skus),'page',p_page,'pageSize',p_page_size,'delegated_filter',p_filter,'delegated_status',p_status,'delegated_skus',p_skus)$$;
 insert into operations_private.operations_hub_matrix_export_cache(sellpia_sku_code,sellpia_own_code,sellpia_product_name,sellpia_option_name,smartstore_name,smartstore_option_name,sellpia_current_stock,sellpia_sale_price,overall_status,updated_at) values
 ('2-1','CODE-A','14K product','red','seller special','red',1,1000,'connected','2026-09-01'),
 ('2-2','CODE-B','14K product','blue','seller special','blue',2,2000,'unmatched','2026-09-02'),
 ('10-1','CODE-C','14K product','red','seller special','red',3,3000,'connected','2026-09-03');
 insert into public.operations_hub_sku_operational_master values('2-1',20,10000);
 insert into public.operations_hub_listing_components values('2-2',true,'parent');`);
 await db.exec(fs.readFileSync('supabase/migrations/20260918081116_hub_typed_search_page_keys.sql','utf8'));
 const call=async({page=1,size=1,term='14K',type='name',sources=['sellpia'],status='all',sort='sku_asc',filter={conditions:[],logic:'and'},exclude=false}={})=>(await db.query('select public.load_operations_hub_matrix_search_mvp($1,$2,$3,$4,$5,$6,$7,$8,$9) result',[page,size,term,type,sources,status,sort,filter,exclude])).rows[0].result;
 let r=await call();assert.equal(r.count,3);assert.deepEqual(r.delegated_skus,['2-1']);assert.equal(r.page,1);
 r=await call({page:2});assert.equal(r.count,3);assert.deepEqual(r.delegated_skus,['2-2']);assert.equal(r.page,2);
 r=await call({page:4});assert.equal(r.count,3);assert.deepEqual(r.rows,[]);assert.equal(r.page,4);
 r=await call({term:'2-1',type:'sku',size:200});assert.equal(r.count,1);assert.equal(r.matchMode,'exact');assert.deepEqual(r.delegated_skus,['2-1']);
 r=await call({term:'2-',type:'sku',size:200});assert.equal(r.count,2);assert.equal(r.matchMode,'prefix');
 r=await call({term:'CODE-B',type:'own_code'});assert.equal(r.count,1);assert.deepEqual(r.delegated_skus,['2-2']);
 r=await call({term:'CODE-',type:'own_code'});assert.equal(r.count,3);
 r=await call({term:'CODE%',type:'own_code'});assert.equal(r.count,0,'literal wildcard must remain literal');
 r=await call({term:'seller special',sources:['sellpia']});assert.equal(r.count,0);
 r=await call({term:'seller special/red',sources:['smartstore'],size:200});assert.equal(r.count,2);
 r=await call({status:'connected',size:200});assert.equal(r.count,2);assert.deepEqual(r.delegated_skus,['2-1','10-1']);
 r=await call({status:'unmatched'});assert.equal(r.count,1);assert.deepEqual(r.delegated_skus,['2-2']);
 r=await call({exclude:true,size:200});assert.equal(r.count,2);
 r=await call({sort:'stock_desc'});assert.deepEqual(r.delegated_skus,['2-1']);
 r=await call({sort:'price_desc'});assert.deepEqual(r.delegated_skus,['2-1']);
 r=await call({sort:'updated_desc'});assert.deepEqual(r.delegated_skus,['10-1']);
 const filter={logic:'and',conditions:[{field:'sellpia_current_stock',operator:'gt',value:'1'}]};r=await call({page:2,filter});assert.deepEqual(r.delegated_filter,filter);assert.equal(r.delegated_skus.length,3,'advanced filter must receive full candidate set');assert.equal(r.page,2);
 await assert.rejects(call({type:'unknown'}),/검색 유형/);
 }finally{await db.close();}
});
