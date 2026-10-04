import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

let PGlite;
try { ({PGlite}=await import('@electric-sql/pglite')); } catch {}

test('tag retirement atomically detaches option, product, legacy and Rule links', {skip:!PGlite}, async()=>{
 const db=new PGlite();
 const tag='11111111-1111-4111-8111-111111111111';
 const other='22222222-2222-4222-8222-222222222222';
 const rule='33333333-3333-4333-8333-333333333333';
 const productRule='44444444-4444-4444-8444-444444444444';
 try{
  await db.exec(`create role anon; create role authenticated; create schema operations_private;
  create table public.product_tags(tag_id uuid primary key,tag_name text,is_active boolean,updated_at timestamptz);
  create table public.sellpia_tag_assignments(tag_id uuid,tag_scope text,sellpia_sku_code text,sellpia_product_code text,is_active boolean,reviewer text,updated_at timestamptz);
  create table public.product_tag_assignments(tag_id uuid,sellpia_sku_code text,is_active boolean,reviewer text,updated_at timestamptz);
  create table public.sellpia_stock_latest(sellpia_sku_code text,sellpia_product_code text);
  create table operations_private.hub_rules(id uuid primary key,tag_id uuid,is_active boolean,version integer,updated_at timestamptz,updated_by text);
  create table operations_private.hub_rule_assignments(sku text,rule_id uuid,assigned_tag_id uuid);
  create table operations_private.hub_product_price_rules(id uuid primary key,tag_id uuid,is_active boolean,version integer,updated_at timestamptz,updated_by text);
  create table operations_private.hub_product_price_assignments(rule_id uuid,product_code text);
  create table operations_private.hub_rule_events(action text,before_value jsonb,after_value jsonb,actor text);
  create function operations_private.require_operations_hub_operator_session(token text) returns jsonb
  language plpgsql as $$ begin if token is distinct from 'operator' then raise exception 'unauthorized'; end if; return '{"username":"tester"}'::jsonb; end $$;
  insert into public.product_tags values('${tag}','Remove me',true,now()),('${other}','Keep me',true,now());
  insert into public.sellpia_stock_latest values('A','P1'),('B','P2'),('C','P3'),('D','P4');
  insert into public.sellpia_tag_assignments values('${tag}','option','A',null,true,null,now()),('${tag}','product',null,'P2',true,null,now()),('${other}','option','D',null,true,null,now());
  insert into public.product_tag_assignments values('${tag}','C',true,null,now());
  insert into operations_private.hub_rules values('${rule}','${tag}',true,1,now(),null);
  insert into operations_private.hub_rule_assignments values('A','${rule}','${tag}');
  insert into operations_private.hub_product_price_rules values('${productRule}','${tag}',true,1,now(),null);
  insert into operations_private.hub_product_price_assignments values('${productRule}','P2');`);
  await db.exec(fs.readFileSync('supabase/migrations/20260921064352_hub_product_tag_retire_cascade_v2.sql','utf8'));
  const call=async(token,preview,optionCount=null,productCount=null,ruleCount=null)=>{
   const result=await db.query('select public.hub_product_tag_retire_cascade_v2($1,$2,$3,$4,$5,$6,$7) as value',[token,tag,'Remove me',preview,optionCount,productCount,ruleCount]);
   return result.rows[0].value;
  };
  await assert.rejects(call('',true),/unauthorized/);
  const preview=await call('operator',true);
  assert.deepEqual([preview.option_count,preview.product_count,preview.legacy_count,preview.rule_count,preview.product_rule_count,preview.affected_sku_count],[1,1,1,1,1,3]);
  await assert.rejects(call('operator',false,0,1,2),/미리보기 이후 변경/);
  assert.equal((await db.query('select is_active from public.product_tags where tag_id=$1',[tag])).rows[0].is_active,true);
  const done=await call('operator',false,1,1,2);
  assert.deepEqual(done.affected_skus,['A','B','C']);
  assert.equal(done.rule_assignments_removed,1);
  assert.equal(done.product_assignments_removed,1);
  assert.equal((await db.query('select is_active from public.product_tags where tag_id=$1',[tag])).rows[0].is_active,false);
  assert.equal((await db.query('select count(*)::int n from public.sellpia_tag_assignments where tag_id=$1 and is_active',[tag])).rows[0].n,0);
  assert.equal((await db.query('select count(*)::int n from public.product_tag_assignments where tag_id=$1 and is_active',[tag])).rows[0].n,0);
  assert.equal((await db.query('select count(*)::int n from operations_private.hub_rule_assignments')).rows[0].n,0);
  assert.equal((await db.query('select count(*)::int n from operations_private.hub_product_price_assignments')).rows[0].n,0);
  assert.equal((await db.query('select is_active from public.product_tags where tag_id=$1',[other])).rows[0].is_active,true);
  assert.equal((await db.query('select count(*)::int n from public.sellpia_tag_assignments where tag_id=$1 and is_active',[other])).rows[0].n,1);
  await assert.rejects(call('operator',false,1,1,2),/활성 태그를 찾지/);
 }finally{await db.close();}
});
