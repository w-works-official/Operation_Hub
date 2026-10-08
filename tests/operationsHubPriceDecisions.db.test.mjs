import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const migrationPath = new URL('../supabase/migrations/20261008022010_hub_price_decisions_v1.sql', import.meta.url);
const migration = await readFile(migrationPath, 'utf8');
const db = new PGlite();

try {
  await db.exec(`
    create role anon;
    create role authenticated;
    create schema operations_private;
    create function operations_private.require_operations_hub_operator_session(p_session_token text)
    returns jsonb language plpgsql as $$ begin
      if p_session_token <> 'test-session' then raise exception 'operator session required'; end if;
      return jsonb_build_object('username','qa-operator');
    end $$;
    create function public.hub_input_fingerprints_v1(p_session_token text,p_skus text[],p_source text)
    returns jsonb language sql stable as $$
      select coalesce(jsonb_object_agg(sku,'fp-'||sku),'{}'::jsonb) from unnest(p_skus) sku
    $$;
    create function operations_private.calculate_operations_hub_discounted_base(
      p_source text,p_base_price numeric,p_discount_terms jsonb,p_reported_discounted_price numeric default null
    ) returns numeric language sql immutable as $$
      select case when jsonb_array_length(coalesce(p_discount_terms,'[]'::jsonb))=0 then p_base_price
        else p_base_price-(p_discount_terms->0->>'value')::numeric end
    $$;
    create function public.save_operations_hub_seller_price_draft_v2(
      p_sku text,p_source text,p_target_base_price numeric,p_input_mode text,p_option_price numeric,
      p_target_final_price numeric,p_option_price_source text,p_base_price_source text,p_price_rule_set_id bigint,p_batch_id uuid
    ) returns table(change_id bigint,draft_status text,cancelled_count integer,change_batch_id uuid,
      source_base_price numeric,source_discounted_base_price numeric,source_option_price numeric,source_final_price numeric,
      draft_base_price numeric,draft_discounted_base_price numeric,draft_option_price numeric,draft_final_price numeric,
      saved_input_mode text,saved_at timestamptz)
    language sql as $$ select 1::bigint,'pending'::text,0,p_batch_id,100::numeric,90::numeric,0::numeric,90::numeric,
      p_target_base_price,p_target_base_price-10,coalesce(p_option_price,0),p_target_base_price-10+coalesce(p_option_price,0),p_input_mode,now() $$;
    create function public.save_operations_hub_seller_discount_draft(
      p_sku text,p_source text,p_discount_terms jsonb,p_input_mode text,p_option_price numeric,p_target_final_price numeric,p_batch_id uuid
    ) returns table(change_id bigint,draft_status text,cancelled_count integer,change_batch_id uuid,
      source_base_price numeric,source_discounted_base_price numeric,source_option_price numeric,source_final_price numeric,
      draft_base_price numeric,draft_discounted_base_price numeric,draft_option_price numeric,draft_final_price numeric,
      saved_input_mode text,saved_at timestamptz,draft_discount_terms jsonb)
    language sql as $$ select 1::bigint,'pending'::text,0,p_batch_id,100::numeric,90::numeric,0::numeric,90::numeric,
      100::numeric,90::numeric,coalesce(p_option_price,0),90+coalesce(p_option_price,0),p_input_mode,now(),p_discount_terms $$;
    create function public.save_operations_hub_seller_product_discount_mode_v1(
      p_source text,p_product_code text,p_anchor_sku text,p_discount_terms jsonb,p_rule_code text,p_calculation_mode text,p_batch_id uuid
    ) returns table(sellpia_sku_code text,change_id bigint,draft_status text,cancelled_count integer,change_batch_id uuid,
      source_base_price numeric,source_discounted_base_price numeric,source_option_price numeric,source_final_price numeric,
      draft_base_price numeric,draft_discounted_base_price numeric,draft_option_price numeric,draft_final_price numeric,
      saved_input_mode text,saved_at timestamptz,draft_discount_terms jsonb,affected_sku_count integer,rule_code text)
    language sql as $$ select 'SKU-1'::text,1::bigint,'pending'::text,0,p_batch_id,100::numeric,90::numeric,0::numeric,90::numeric,
      100::numeric,90::numeric,0::numeric,90::numeric,p_calculation_mode,now(),p_discount_terms,1,p_rule_code $$;
    create table public.operations_hub_listing_component_projection(
      mapping_source text,listing_id text,component_id text,source_channel text not null,
      product_code text not null,option_code text,sellpia_sku_code text not null,
      component_qty numeric,component_role text,updated_at timestamptz default now()
    );
    create table public.operations_hub_matrix_cached(
      sellpia_sku_code text,smartstore_product_code text,smartstore_option_code text,
      makeshop_product_code text,makeshop_option_code text,ably_product_code text,ably_option_code text
    );
    create table public.seller_inventory_snapshots(
      snapshot_id uuid primary key,source_channel text,upload_status text,completed_at timestamptz,created_at timestamptz
    );
    create table public.seller_inventory_snapshot_rows(
      snapshot_id uuid,product_code text,option_code text not null default '',price numeric,
      base_price numeric,discounted_base_price numeric,option_price numeric,final_price numeric,
      discount_terms jsonb,source_row_no integer,raw_payload jsonb not null default '{}',
      primary key(snapshot_id,product_code,option_code)
    );
    create table public.sellpia_stock_snapshots(
      snapshot_id uuid primary key,upload_status text,completed_at timestamptz,created_at timestamptz
    );
    create table public.sellpia_stock_snapshot_rows(snapshot_id uuid,sellpia_sku_code text,price numeric,raw_payload jsonb);
    create table public.operations_hub_change_queue(
      change_id bigint,source_channel text,seller_product_code text,seller_option_code_normalized text,field_key text,status text,
      price_base_after numeric,price_discounted_base_after numeric,price_option_after numeric,price_final_after numeric,
      price_discount_terms_after jsonb,after_value jsonb
    );
    insert into public.operations_hub_listing_component_projection
      (mapping_source,listing_id,component_id,source_channel,product_code,option_code,sellpia_sku_code,component_qty,component_role)
    values ('manual','listing-1','component-1','smartstore','P-1','O-1','SKU-1',1,'primary'),
           ('manual','listing-1','component-alt','smartstore','P-1','O-1','SKU-ALT',1,'primary'),
           ('manual','listing-1','component-2','smartstore','P-1','O-2','SKU-2',1,'primary');
    insert into public.operations_hub_matrix_cached(sellpia_sku_code,smartstore_product_code,smartstore_option_code)
    values ('SKU-1','P-1','O-1'),('SKU-ALT','P-1','O-1'),('SKU-2','P-1','O-2');
    insert into public.seller_inventory_snapshots values
      ('00000000-0000-0000-0000-000000000001','smartstore','ready',now(),now());
    insert into public.seller_inventory_snapshot_rows values
      ('00000000-0000-0000-0000-000000000001','P-1','O-1',90,100,90,0,90,'[{"term_key":"sale","unit":"amount","value":10,"is_baseline":true}]',1,'{}'),
      ('00000000-0000-0000-0000-000000000001','P-1','O-2',100,100,90,10,100,'[{"term_key":"sale","unit":"amount","value":10,"is_baseline":true}]',2,'{}');
    insert into public.sellpia_stock_snapshots values
      ('00000000-0000-0000-0000-000000000002','ready',now(),now());
    insert into public.sellpia_stock_snapshot_rows values
      ('00000000-0000-0000-0000-000000000002','SKU-1',120,'{"sell_price":"120"}'),
      ('00000000-0000-0000-0000-000000000002','SKU-2',120,'{"sell_price":"120"}');
  `);
  await db.exec(migration);

  const read = await db.query(`select public.hub_price_decision_read_v1('test-session','smartstore',array['SKU-1']) as result`);
  const initial = read.rows[0].result;
  assert.equal(initial.rows.length, 0, 'unaccepted decisions read empty');
  assert.equal(initial.groups.length, 1);
  const group = initial.groups[0];
  assert.equal(group.targets.length, 2, 'a single requested SKU expands to all seller options');
  assert.equal(group.targets[1].price.final, 100);
  assert.equal(group.targets[1].source_row_no, 2);

  const requestId = '11111111-1111-4111-8111-111111111111';
  const body = {
    source: 'smartstore', decision_source: 'pricing_rule', reason: 'synthetic acceptance',
    groups: [{
      seller_product_code: 'P-1', expected_revision: 0,
      mapping_fingerprint: group.mapping_fingerprint,
      input_fingerprints: group.input_fingerprints,
      snapshot_id: group.snapshot_id,
      sellpia_snapshot_id: group.sellpia_snapshot_id,
      targets: group.targets.map((target, index) => ({
        sku: target.sku, seller_product_code: 'P-1', seller_option_code: target.seller_option_code,
        price: { base: 100, discounted: 90, option: index * 10, final: 90 + index * 10,
          terms: [{ term_key: 'sale', unit: 'amount', value: 10, is_baseline: true }] },
        intent: { rule: 'synthetic' }
      }))
    }]
  };
  const apply = await db.query(
    `select public.hub_price_decision_apply_v1('test-session',$1::uuid,$2::jsonb) as result`,
    [requestId, JSON.stringify(body)]
  );
  assert.equal(apply.rows[0].result.rows.length, 2);
  assert.ok(apply.rows[0].result.rows.every(row => row.revision === 1));

  const replay = await db.query(
    `select public.hub_price_decision_apply_v1('test-session',$1::uuid,$2::jsonb) as result`,
    [requestId, JSON.stringify(body)]
  );
  assert.deepEqual(replay.rows[0].result, apply.rows[0].result, 'same request returns stored result');
  const counts = await db.query(`select
    (select count(*) from operations_private.hub_price_decision_events) as events,
    (select revision from operations_private.hub_price_decision_groups where seller_product_code='P-1') as revision`);
  assert.equal(Number(counts.rows[0].events), 2);
  assert.equal(Number(counts.rows[0].revision), 1);

  const manualRead = (await db.query(`select public.hub_price_decision_read_v1('test-session','smartstore',array['SKU-1']) as result`)).rows[0].result;
  const manualGroup = manualRead.groups[0];
  const manualBody = {
    source: 'smartstore', decision_source: 'matrix_manual', reason: 'manual price edit',
    groups: [{ seller_product_code: 'P-1', expected_revision: 1,
      mapping_fingerprint: manualGroup.mapping_fingerprint,input_fingerprints: manualGroup.input_fingerprints,
      snapshot_id: manualGroup.snapshot_id,sellpia_snapshot_id: manualGroup.sellpia_snapshot_id,
      targets: manualGroup.targets.map(target => ({ sku: target.sku,member_skus:target.member_skus,seller_product_code: 'P-1',
        seller_option_code: target.seller_option_code,price: target.current_state?.price || target.price })) }],
    manual_actions: [{ sku: 'SKU-ALT',seller_product_code:'P-1',seller_option_code:'O-1',kind: 'price',target_base_price: 100,input_mode: 'option',option_price: 5,
      option_price_source: 'manual',base_price_source: 'manual' }]
  };
  const manualApply=await db.query(`select public.hub_price_decision_apply_v1('test-session',$1::uuid,$2::jsonb) as result`,
    ['33333333-3333-4333-8333-333333333333',JSON.stringify(manualBody)]);
  assert.equal(manualApply.rows[0].result.rows[0].sku,'SKU-1',
    'an aliased action SKU resolves to the Matrix primary seller tuple but event remains on canonical group target');
  const manualAliasRows=manualApply.rows[0].result.rows.filter(row=>row.seller_product_code==='P-1'&&row.seller_option_code==='O-1');
  assert.ok(manualAliasRows.some(row=>row.sku==='SKU-ALT'),'apply response rereads alias SKUs for local Matrix decision metadata');
  assert.equal(new Set(manualAliasRows.map(row=>row.event_id)).size,1,'canonical and alias rows share the same exact carrier event');
  const manualCounts = await db.query(`select count(*) as events,
    (select revision from operations_private.hub_price_decision_groups where seller_product_code='P-1') as revision
    from operations_private.hub_price_decision_events`);
  assert.equal(Number(manualCounts.rows[0].events), 3, 'manual edit creates an event only for its affected option');
  assert.equal(Number(manualCounts.rows[0].revision), 2, 'manual edit advances the whole product revision');

  const oneOptionHistory = (await db.query(`select event_id,price from operations_private.hub_price_decision_events
    where request_id='33333333-3333-4333-8333-333333333333'::uuid and seller_option_code='O-1'`)).rows[0];
  const oneOptionRollbackRead=(await db.query(`select public.hub_price_decision_read_v1('test-session','smartstore',array['SKU-1']) as result`)).rows[0].result;
  const oneOptionRollbackBody={source:'smartstore',decision_source:'rollback',reason:'restore one edited option',
    rollback_event_id:Number(oneOptionHistory.event_id),groups:[{seller_product_code:'P-1',expected_revision:2,
      mapping_fingerprint:oneOptionRollbackRead.groups[0].mapping_fingerprint,
      input_fingerprints:oneOptionRollbackRead.groups[0].input_fingerprints,
      snapshot_id:oneOptionRollbackRead.groups[0].snapshot_id,sellpia_snapshot_id:oneOptionRollbackRead.groups[0].sellpia_snapshot_id,
      targets:oneOptionRollbackRead.groups[0].targets.map(target=>({sku:target.sku,seller_product_code:'P-1',
        seller_option_code:target.seller_option_code,
        price:target.seller_option_code==='O-1'?oneOptionHistory.price:target.current_state.price}))}]};
  const oneOptionRollback=await db.query(`select public.hub_price_decision_apply_v1('test-session',$1::uuid,$2::jsonb) as result`,
    ['eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',JSON.stringify(oneOptionRollbackBody)]);
  assert.equal(new Set(oneOptionRollback.rows[0].result.rows.map(row=>row.seller_option_code)).size,1,
    'rollback only emits the option changed by its referenced request');
  assert.equal(new Set(oneOptionRollback.rows[0].result.rows.map(row=>row.event_id)).size,1,
    'rollback alias read rows share one newly appended event');
  assert.equal(oneOptionRollback.rows[0].result.groups[0].revision,3);

  const baseRead = (await db.query(`select public.hub_price_decision_read_v1('test-session','smartstore',array['SKU-1']) as result`)).rows[0].result;
  const baseGroup = baseRead.groups[0];
  const baseBody = {
    source: 'smartstore', decision_source: 'matrix_manual', reason: 'product base edit',
    groups: [{ seller_product_code: 'P-1', expected_revision: 3,
      mapping_fingerprint: baseGroup.mapping_fingerprint,input_fingerprints: baseGroup.input_fingerprints,
      snapshot_id: baseGroup.snapshot_id,sellpia_snapshot_id: baseGroup.sellpia_snapshot_id,
      targets: baseGroup.targets.map(target => ({ sku: target.sku,seller_product_code: 'P-1',
        seller_option_code: target.seller_option_code,price: target.current_state?.price || target.price })) }],
    manual_actions: [
      { sku: 'SKU-1',seller_product_code:'P-1',seller_option_code:'O-1',kind: 'price',target_base_price: 120,input_mode: 'option',option_price: 5,
        option_price_source: 'manual',base_price_source: 'manual' },
      { sku: 'SKU-2',seller_product_code:'P-1',seller_option_code:'O-2',kind: 'price',target_base_price: 120,input_mode: 'option',option_price: 10,
        option_price_source: 'manual',base_price_source: 'manual' }
    ]
  };
  await db.query(`select public.hub_price_decision_apply_v1('test-session',$1::uuid,$2::jsonb)`,
    ['44444444-4444-4444-8444-444444444444',JSON.stringify(baseBody)]);
  const baseCounts = await db.query(`select count(*) as events,
    (select revision from operations_private.hub_price_decision_groups where seller_product_code='P-1') as revision
    from operations_private.hub_price_decision_events`);
  assert.equal(Number(baseCounts.rows[0].events), 6, 'product base edit accepts all options');
  assert.equal(Number(baseCounts.rows[0].revision), 4);

  const sellpiaRead = (await db.query(`select public.hub_price_decision_read_v1('test-session','smartstore',array['SKU-1']) as result`)).rows[0].result;
  const sellpiaGroup = sellpiaRead.groups[0];
  const observedAt = (await db.query(`select completed_at from public.sellpia_stock_snapshots where snapshot_id=$1::uuid`,
    [sellpiaGroup.sellpia_snapshot_id])).rows[0].completed_at;
  const sellpiaIntent = { input_mode: 'explicit_sellpia',source_prices: { 'SKU-1': 120,'SKU-2': 120 },source_observed_at: observedAt };
  const sellpiaBody = {
    source: 'smartstore',decision_source: 'sellpia_apply',reason: 'confirmed Sellpia candidate',
    groups: [{ seller_product_code: 'P-1',expected_revision: 4,mapping_fingerprint: sellpiaGroup.mapping_fingerprint,
      input_fingerprints: sellpiaGroup.input_fingerprints,snapshot_id: sellpiaGroup.snapshot_id,
      sellpia_snapshot_id: sellpiaGroup.sellpia_snapshot_id,
      targets: sellpiaGroup.targets.map(target => ({ sku: target.sku,seller_product_code: 'P-1',
        seller_option_code: target.seller_option_code,price: { base: 120,discounted: 110,
          option: target.current_state.price.option,final: 110+target.current_state.price.option,
          terms: target.current_state.price.terms },intent: sellpiaIntent })) }]
  };
  const sellpiaApply = await db.query(`select public.hub_price_decision_apply_v1('test-session',$1::uuid,$2::jsonb) as result`,
    ['55555555-5555-4555-8555-555555555555',JSON.stringify(sellpiaBody)]);
  assert.equal(new Set(sellpiaApply.rows[0].result.rows.map(row=>row.seller_option_code)).size, 2);
  assert.ok(sellpiaApply.rows[0].result.rows.every(row => row.decision_source === 'sellpia_apply'));

  const rollbackRead = (await db.query(`select public.hub_price_decision_read_v1('test-session','smartstore',array['SKU-1']) as result`)).rows[0].result;
  const originalEvents = (await db.query(`select seller_option_code,price,event_id from operations_private.hub_price_decision_events
    where request_id=$1::uuid order by seller_option_code`,[requestId])).rows;
  const rollbackBody = {
    source:'smartstore',decision_source:'rollback',reason:'restore earlier accepted decision',
    rollback_event_id:Number(originalEvents[0].event_id),
    groups:[{seller_product_code:'P-1',expected_revision:5,mapping_fingerprint:rollbackRead.groups[0].mapping_fingerprint,
      input_fingerprints:rollbackRead.groups[0].input_fingerprints,snapshot_id:rollbackRead.groups[0].snapshot_id,
      sellpia_snapshot_id:rollbackRead.groups[0].sellpia_snapshot_id,
      targets:rollbackRead.groups[0].targets.map(target=>({sku:target.sku,seller_product_code:'P-1',
        seller_option_code:target.seller_option_code,price:originalEvents.find(event=>event.seller_option_code===target.seller_option_code).price}))}]
  };
  const rollbackApply=await db.query(`select public.hub_price_decision_apply_v1('test-session',$1::uuid,$2::jsonb) as result`,
    ['99999999-9999-4999-8999-999999999999',JSON.stringify(rollbackBody)]);
  assert.equal(new Set(rollbackApply.rows[0].result.rows.map(row=>row.seller_option_code)).size,2);
  assert.ok(rollbackApply.rows[0].result.rows.every(row=>row.decision_source==='rollback'));

  const tamperedSellpia = structuredClone(sellpiaBody);
  tamperedSellpia.groups[0].expected_revision = 6;
  tamperedSellpia.groups[0].targets[0].intent.source_prices['SKU-1'] = 999;
  await assert.rejects(db.query(`select public.hub_price_decision_apply_v1('test-session',$1::uuid,$2::jsonb)`,
    ['66666666-6666-4666-8666-666666666666',JSON.stringify(tamperedSellpia)]),/Sellpia/i,
    'Sellpia candidate value must match the latest raw row');

  const replayMismatch = structuredClone(body);
  replayMismatch.reason = 'same id with different intent';
  await assert.rejects(db.query(`select public.hub_price_decision_apply_v1('test-session',$1::uuid,$2::jsonb)`,
    [requestId,JSON.stringify(replayMismatch)]),/payload/i,'request ID cannot be reused with another payload');
  await assert.rejects(db.query(`select public.hub_price_decision_matrix_read_v1('wrong-session',array['SKU-1'])`),
    /operator session/i,'reads require the authenticated operator session');
  await assert.rejects(db.query(`delete from operations_private.hub_price_decision_events where event_id=1`),
    /append-only/i,'accepted events reject mutation');

  await db.exec(`
    insert into public.operations_hub_listing_component_projection
      (mapping_source,listing_id,component_id,source_channel,product_code,option_code,sellpia_sku_code,component_qty,component_role)
    values ('manual','listing-m','component-m','makeshop','PM-1','M-1','SKU-1',1,'primary'),
           ('manual','listing-a','component-a','ably','PA-1','A-1','SKU-1',1,'primary');
    insert into public.seller_inventory_snapshots values
      ('00000000-0000-0000-0000-000000000003','makeshop','ready',now(),now()),
      ('00000000-0000-0000-0000-000000000004','ably','ready',now(),now());
    insert into public.seller_inventory_snapshot_rows values
      ('00000000-0000-0000-0000-000000000003','PM-1','M-1',21500,21500,21500,0,21500,'[]',3,'{}'),
      ('00000000-0000-0000-0000-000000000004','PA-1','A-1',19900,19900,19900,0,19900,'[]',4,'{}');
  `);
  const sourceRead = async source => (await db.query(`select public.hub_price_decision_read_v1('test-session',$1,array['SKU-1']) as result`,[source])).rows[0].result.groups[0];
  const applyRule = async (source,group,base,request) => db.query(
    `select public.hub_price_decision_apply_v1('test-session',$1::uuid,$2::jsonb) as result`,
    [request,JSON.stringify({source,decision_source:'pricing_rule',reason:`synthetic ${source} rule`,groups:[{
      seller_product_code:group.seller_product_code,expected_revision:group.revision,
      mapping_fingerprint:group.mapping_fingerprint,input_fingerprints:group.input_fingerprints,
      snapshot_id:group.snapshot_id,sellpia_snapshot_id:group.sellpia_snapshot_id,
      targets:group.targets.map(target=>({sku:target.sku,seller_product_code:group.seller_product_code,
        seller_option_code:target.seller_option_code,price:{base,discounted:base,option:0,final:base,terms:[]},intent:{rule:'synthetic'}}))
    }]})]
  );
  const makeGroup=await sourceRead('makeshop');
  const makeResult=await applyRule('makeshop',makeGroup,21500,'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  assert.equal(makeResult.rows[0].result.rows[0].price.base,21500);
  const ablyGroup=await sourceRead('ably');
  const ablyInitial=await applyRule('ably',ablyGroup,19900,'cccccccc-cccc-4ccc-8ccc-cccccccccccc');
  assert.equal(ablyInitial.rows[0].result.rows[0].price.base,19900);
  const ablyFreshGroup=await sourceRead('ably');
  const ablyFresh=await applyRule('ably',ablyFreshGroup,22000,'dddddddd-dddd-4ddd-8ddd-dddddddddddd');
  assert.equal(ablyFresh.rows[0].result.rows[0].price.base,22000,'new explicit Ably Rule supersedes the older accepted candidate');
  const allSources = (await db.query(`select public.hub_price_decision_matrix_read_v1('test-session',array['SKU-1']) as result`)).rows[0].result.rows;
  assert.ok(['smartstore','makeshop','ably'].every(source=>allSources.some(row=>row.source_channel===source)),
    'Matrix read projects accepted current states across all three source channels');
  const scopedHeavy = (await db.query(`select public.hub_price_decision_read_v1('test-session','smartstore',array['SKU-1']) as result`)).rows[0].result;
  assert.ok(scopedHeavy.rows.length > 0 && scopedHeavy.rows.every(row => row.source_channel === 'smartstore'),
    'heavy product read only returns the requested source');

  await db.exec(`
    insert into public.operations_hub_listing_component_projection
      (mapping_source,listing_id,component_id,source_channel,product_code,option_code,sellpia_sku_code,component_qty,component_role)
    values ('manual','listing-s2','component-s2','smartstore','P-S2','S2','SKU-3',1,'primary'),
           ('manual','listing-norm','component-norm-null','smartstore','P-NORM',null,'SKU-N1',1,'primary'),
           ('manual','listing-norm','component-norm-empty','smartstore','P-NORM','','SKU-N2',1,'primary'),
           ('manual','listing-norm','component-norm-space','smartstore','P-NORM','   ','SKU-N3',1,'primary'),
           ('manual','listing-old','component-old-a','smartstore','P-OLD','OLD','SKU-A',1,'primary'),
           ('manual','listing-old','component-old-b','smartstore','P-OLD','OLD','SKU-B',1,'primary');
    insert into public.operations_hub_matrix_cached(sellpia_sku_code,smartstore_product_code,smartstore_option_code)
    values ('SKU-N1','P-NORM',''),('SKU-N2','P-NORM',''),('SKU-N3','P-NORM',''),
           ('SKU-A','P-OLD','OLD'),('SKU-B','P-OLD','OLD');
    insert into public.seller_inventory_snapshot_rows values
      ('00000000-0000-0000-0000-000000000001','P-S2','S2',18900,18900,18900,0,18900,'[]',3,'{}'),
      ('00000000-0000-0000-0000-000000000001','P-NORM','',500,500,500,0,500,'[]',4,'{}'),
      ('00000000-0000-0000-0000-000000000001','P-OLD','OLD',700,700,700,0,700,'[]',5,'{}');
    insert into public.sellpia_stock_snapshot_rows values
      ('00000000-0000-0000-0000-000000000002','SKU-3',18900,'{"sell_price":"18900"}'),
      ('00000000-0000-0000-0000-000000000002','SKU-N1',500,'{"sell_price":"500"}'),
      ('00000000-0000-0000-0000-000000000002','SKU-N2',500,'{"sell_price":"500"}'),
      ('00000000-0000-0000-0000-000000000002','SKU-N3',500,'{"sell_price":"500"}'),
      ('00000000-0000-0000-0000-000000000002','SKU-A',700,'{"sell_price":"700"}'),
      ('00000000-0000-0000-0000-000000000002','SKU-B',700,'{"sell_price":"700"}');
  `);
  const smartstoreBaseline=(await db.query(`select public.hub_price_decision_read_v1('test-session','smartstore',array['SKU-3']) as result`)).rows[0].result.groups[0];
  const baselineResult=await applyRule('smartstore',smartstoreBaseline,18900,'eeeeeeee-1111-4eee-8111-eeeeeeeeeeee');
  assert.equal(baselineResult.rows[0].result.rows[0].price.base,18900,
    'the three-channel database sequence includes the 18,900 accepted baseline tuple');

  const normalizedGroup=(await db.query(`select public.hub_price_decision_read_v1('test-session','smartstore',array['SKU-N1']) as result`)).rows[0].result.groups[0];
  assert.equal(normalizedGroup.targets.length,1,'NULL, blank, and whitespace option codes normalize to one carrier identity');
  assert.deepEqual(normalizedGroup.targets[0].member_skus,['SKU-N1','SKU-N2','SKU-N3']);
  const normalizedApply=await applyRule('smartstore',normalizedGroup,500,'eeeeeeee-2222-4eee-8222-eeeeeeeeeeee');
  assert.equal(normalizedApply.rows[0].result.groups[0].revision,1,'normalized option identity accepts one stable initial carrier');

  const oldAliasGroup=(await db.query(`select public.hub_price_decision_read_v1('test-session','smartstore',array['SKU-A']) as result`)).rows[0].result.groups[0];
  const oldCarrierApply=await applyRule('smartstore',oldAliasGroup,700,'eeeeeeee-3333-4eee-8333-eeeeeeeeeeee');
  assert.equal(oldCarrierApply.rows[0].result.rows[0].price.base,700);
  await db.exec(`
    delete from public.operations_hub_listing_component_projection where component_id='component-old-a';
    insert into public.operations_hub_listing_component_projection
      (mapping_source,listing_id,component_id,source_channel,product_code,option_code,sellpia_sku_code,component_qty,component_role)
    values ('manual','listing-new','component-new-a','smartstore','P-NEW','NEW','SKU-A',1,'primary');
    update public.operations_hub_matrix_cached set smartstore_product_code='P-NEW',smartstore_option_code='NEW'
    where sellpia_sku_code='SKU-A';
    insert into public.seller_inventory_snapshot_rows values
      ('00000000-0000-0000-0000-000000000001','P-NEW','NEW',800,800,800,0,800,'[]',6,'{}');
    insert into public.sellpia_stock_snapshot_rows values
      ('00000000-0000-0000-0000-000000000002','SKU-A',800,'{"sell_price":"800"}');
  `);
  const movedCanonical=(await db.query(`select public.hub_price_decision_read_v1('test-session','smartstore',array['SKU-A']) as result`)).rows[0].result.groups[0];
  const movedApply=await applyRule('smartstore',movedCanonical,800,'eeeeeeee-4444-4eee-8444-eeeeeeeeeeee');
  assert.equal(movedApply.rows[0].result.rows[0].price.base,800);
  const retainedAlias=(await db.query(`select public.hub_price_decision_matrix_read_v1('test-session',array['SKU-B']) as result`)).rows[0].result.rows;
  assert.ok(retainedAlias.some(row=>row.seller_product_code==='P-OLD'&&row.seller_option_code==='OLD'
    &&row.price.base===700&&row.mapping_valid===false),
    'reassigning the canonical SKU does not prune a still-active old carrier option represented by another alias');

  const stale = structuredClone(body);
  stale.groups[0].expected_revision = 0;
  await assert.rejects(
    db.query(`select public.hub_price_decision_apply_v1('test-session',$1::uuid,$2::jsonb)`,
      ['22222222-2222-4222-8222-222222222222', JSON.stringify(stale)]),
    /revision/i,
    'stale group revision is rejected'
  );

  await db.exec(`update public.operations_hub_listing_component_projection set component_qty=2 where component_id='component-1'`);
  const driftRead = (await db.query(`select public.hub_price_decision_matrix_read_v1('test-session',array['SKU-1']) as result`)).rows[0].result;
  assert.ok(driftRead.rows.some(row => row.sku === 'SKU-1' && row.mapping_valid === false),
    'current matrix read surfaces known state with changed mapping as invalid');
  const invalidGroup = (await db.query(`select public.hub_price_decision_read_v1('test-session','smartstore',array['SKU-1']) as result`)).rows[0].result.groups[0];
  assert.equal(invalidGroup.mapping_valid,false);
  const invalidMappingBody = {
    source:'smartstore',decision_source:'matrix_manual',reason:'reject partial manual after mapping drift',
    groups:[{seller_product_code:'P-1',expected_revision:6,mapping_fingerprint:invalidGroup.mapping_fingerprint,
      input_fingerprints:invalidGroup.input_fingerprints,snapshot_id:invalidGroup.snapshot_id,
      sellpia_snapshot_id:invalidGroup.sellpia_snapshot_id,
      targets:invalidGroup.targets.map(target=>({sku:target.sku,seller_product_code:'P-1',
        seller_option_code:target.seller_option_code,price:target.current_state.price}))}],
    manual_actions:[{sku:'SKU-1',seller_product_code:'P-1',seller_option_code:'O-1',kind:'price',target_base_price:120,input_mode:'option',option_price:5,
      option_price_source:'manual',base_price_source:'manual'}]
  };
  await assert.rejects(db.query(`select public.hub_price_decision_apply_v1('test-session',$1::uuid,$2::jsonb)`,
    ['88888888-8888-4888-8888-888888888888',JSON.stringify(invalidMappingBody)]),/전체 옵션/i,
    'partial manual action cannot rebase a stale accepted group');

  const refreshedGroup=(await db.query(`select public.hub_price_decision_read_v1('test-session','smartstore',array['SKU-1']) as result`)).rows[0].result.groups[0];
  const recoveryBody={source:'smartstore',decision_source:'pricing_rule',reason:'explicit full-group rebase',groups:[{
    seller_product_code:'P-1',expected_revision:6,mapping_fingerprint:refreshedGroup.mapping_fingerprint,
    input_fingerprints:refreshedGroup.input_fingerprints,snapshot_id:refreshedGroup.snapshot_id,
    sellpia_snapshot_id:refreshedGroup.sellpia_snapshot_id,
    targets:refreshedGroup.targets.map(target=>({sku:target.sku,seller_product_code:'P-1',
      seller_option_code:target.seller_option_code,price:target.current_state.price,intent:{rule:'fresh'}}))
  }]};
  const recovered=await db.query(`select public.hub_price_decision_apply_v1('test-session',$1::uuid,$2::jsonb) as result`,
    ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',JSON.stringify(recoveryBody)]);
  assert.equal(new Set(recovered.rows[0].result.rows.map(row=>row.seller_option_code)).size,2,'fresh explicit full-group Rule can rebase mapping proof');
  assert.ok(recovered.rows[0].result.rows.every(row=>row.revision===7));

  assert.equal(Number((await db.query(`select count(*) as n from operations_private.hub_price_decision_events`)).rows[0].n), 19);
  console.log('Price decision DB contract: PASS');
} catch (error) {
  console.error(error.message);
  throw error;
} finally {
  await db.close();
}
