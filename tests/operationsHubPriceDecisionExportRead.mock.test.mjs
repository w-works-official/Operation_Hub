import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const service = fs.readFileSync(new URL('../mockups/operations-hub/data-service.js',import.meta.url),'utf8');
const resolver = fs.readFileSync(new URL('../mockups/operations-hub/current-price-export.js',import.meta.url),'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const snapshots = {seller_snapshot_id:'00000000-0000-4000-8000-000000000001',sellpia_snapshot_id:'00000000-0000-4000-8000-000000000002',sellpia_observed_at:'2026-10-21T00:00:00Z'};
const tuple = {base:1000,discounted:1000,option:0,final:1000,terms:[]};

function absent(sku, product = `P-${sku}`) {
  return {source_channel:'smartstore',seller_product_code:product,revision:0,mapping_valid:true,mapping_fingerprint:`map-${product}`,
    snapshot_id:snapshots.seller_snapshot_id,sellpia_snapshot_id:snapshots.sellpia_snapshot_id,source_observed_at:snapshots.sellpia_observed_at,
    sellpia_prices:{[sku]:1000},targets:[{sku,member_skus:[sku],seller_product_code:product,seller_option_code:'1',price:{...tuple},source_row_no:2,source_valid:true,current_state:null}]};
}
function carrierProof(entry){const {revision,mapping_valid,...proof}=plain(entry);return proof;}
function response(skus) {return {rows:[],groups:[],proof_version:'sellpia-export-v2',absence_proofs:skus.map(sku=>absent(sku)),carrier_proofs:skus.map(sku=>carrierProof(absent(sku))),snapshots:{...snapshots}};}

function harness(reply = args => ({data:response(args.p_skus),error:null})) {
  const calls=[],events=[];
  const db={
    async rpc(name,args){calls.push({name,args:plain(args)});assert.equal(name,'hub_price_decision_export_read_v2','the optimized reader cannot silently fall back to the old group reader');return reply(args,calls.length);},
    from(){throw Error('no direct table reads in export decision reader');},
    storage:new Proxy({},{get(){throw Error('no storage access');}})
  };
  const win={supabase:{createClient:()=>db},SystemV3SellerParsers:{},fetch:async()=>{throw Error('network forbidden');}};
  const context={window:win,console,URL,TextEncoder,TextDecoder,performance,AbortController,AbortSignal,Blob,setTimeout,clearTimeout};
  vm.createContext(context);vm.runInContext(service,context);vm.runInContext(resolver,context);
  win.SystemV3Data.setOperationsHubSessionToken('test-session');
  return {api:win.SystemV3Data,resolver:context.HubCurrentPriceDecisionResolver||win.HubCurrentPriceDecisionResolver,calls,events};
}

test('optimized export decision reader executes the actual data service in bounded chunks and retains no-decision proofs',async()=>{
  const {api,calls,events}=harness();
  const skus=Array.from({length:4587},(_,i)=>`SKU-${i}`);
  const result=await api.loadExportCurrentPriceDecisions({source:'smartstore',skus:[...skus,skus[0],' '],onQuery:event=>events.push(event)});
  assert.equal(calls.length,23);
  assert.deepEqual(calls.map(call=>call.args.p_skus.length),[...Array(22).fill(200),187]);
  assert.ok(calls.every(call=>call.args.p_source==='smartstore'&&call.args.p_session_token==='test-session'));
  assert.equal(result.absence_proofs.length,4587);
  assert.equal(result.proof_version,'sellpia-export-v2');
  assert.equal(result.carrier_proofs.length,4587);
  assert.deepEqual(plain(result.snapshots),snapshots);
  assert.ok(events.every(event=>event.full_snapshot===false&&event.status==='ok'));
});

test('reader refuses invalid sources, unauthenticated calls, malformed responses and errors without fallback',async()=>{
  const h=harness();
  await assert.rejects(h.api.loadExportCurrentPriceDecisions({source:'ably',skus:['A']}),/판매처|스마트스토어/);
  h.api.setOperationsHubSessionToken('');
  await assert.rejects(h.api.loadExportCurrentPriceDecisions({source:'smartstore',skus:['A']}),/로그인/);
  assert.equal(h.calls.length,0);
  const failure=harness(()=>({data:null,error:{code:'57014',message:'synthetic timeout'}}));
  await assert.rejects(failure.api.loadExportCurrentPriceDecisions({source:'smartstore',skus:['A']}),/timeout/);
  assert.equal(failure.calls.length,1);
  for(const data of [{rows:[],groups:[]},{...response(['A']),proof_version:'unknown'},{...response(['A']),absence_proofs:null},{...response(['A']),carrier_proofs:null}]){
    const bad=harness(()=>({data,error:null}));
    await assert.rejects(bad.api.loadExportCurrentPriceDecisions({source:'smartstore',skus:['A']}));
    assert.equal(bad.calls.length,1);
  }
});

test('source snapshots changing across chunks or separate files fail closed',async()=>{
  const h=harness((args,index)=>{
    const data=response(args.p_skus);
    if(index>1)data.snapshots.seller_snapshot_id='changed-snapshot';
    return {data,error:null};
  });
  await assert.rejects(h.api.loadExportCurrentPriceDecisions({source:'smartstore',skus:Array.from({length:201},(_,i)=>`S${i}`)}),/변경|일치/);
  const files=harness((args,index)=>({data:{...response(args.p_skus),snapshots:{...snapshots,sellpia_snapshot_id:index===1?snapshots.sellpia_snapshot_id:'new-source'}},error:null}));
  const consistency={};
  await files.api.loadExportCurrentPriceDecisions({source:'smartstore',skus:['A'],consistency});
  await assert.rejects(files.api.loadExportCurrentPriceDecisions({source:'smartstore',skus:['B'],consistency}),/변경|일치/);
});

test('repeated product evidence is canonical and conflicting proof in another file is rejected',async()=>{
  const proof=absent('A','SHARED');proof.targets.push({...proof.targets[0],sku:'B',member_skus:['B'],seller_option_code:'2'});proof.sellpia_prices.B=1000;
  const stable=harness(args=>({data:{...response([]),absence_proofs:[plain(proof)]},error:null}));
  const consistency={};
  await stable.api.loadExportCurrentPriceDecisions({source:'smartstore',skus:['A'],consistency});
  await stable.api.loadExportCurrentPriceDecisions({source:'smartstore',skus:['B'],consistency});
  assert.equal(stable.calls.length,2,'the consistency context never becomes a cached database response');
  const changed=harness((args,index)=>{const entry=plain(proof);if(index>1)entry.mapping_fingerprint='new-mapping';return {data:{...response([]),absence_proofs:[entry]},error:null};});
  const changedConsistency={};
  await changed.api.loadExportCurrentPriceDecisions({source:'smartstore',skus:['A'],consistency:changedConsistency});
  await assert.rejects(changed.api.loadExportCurrentPriceDecisions({source:'smartstore',skus:['B'],consistency:changedConsistency}),/변경|일치/);
});

test('absence becoming an active group between files and aborted requests cannot return partial data',async()=>{
  const change=harness((args,index)=>{
    const entry=absent('A','SHARED');
    return {data:index===1?{...response([]),absence_proofs:[entry]}:{...response([]),groups:[{...entry,revision:1,input_fingerprints:{A:'new'}}]},error:null};
  });
  const consistency={};
  await change.api.loadExportCurrentPriceDecisions({source:'smartstore',skus:['A'],consistency});
  await assert.rejects(change.api.loadExportCurrentPriceDecisions({source:'smartstore',skus:['A'],consistency}),/변경/);
  const controller=new AbortController(),aborted=harness();controller.abort();
  await assert.rejects(aborted.api.loadExportCurrentPriceDecisions({source:'smartstore',skus:['A'],signal:controller.signal}),error=>error.name==='AbortError');
  assert.equal(aborted.calls.length,0);
});

test('cache-only carrier evidence is retained independently and conflicts between files fail closed',async()=>{
  const proof=carrierProof(absent('A','CACHE-ONLY'));
  const h=harness((args,index)=>{
    const carrier=plain(proof);if(index>1)carrier.mapping_fingerprint='changed-cache-mapping';
    return {data:{...response([]),carrier_proofs:[carrier]},error:null};
  });
  const consistency={},first=await h.api.loadExportCurrentPriceDecisions({source:'smartstore',skus:['A'],consistency});
  assert.deepEqual(plain(first.absence_proofs),[]);assert.deepEqual(plain(first.groups),[]);
  assert.equal(first.carrier_proofs[0].seller_product_code,'CACHE-ONLY');
  await assert.rejects(h.api.loadExportCurrentPriceDecisions({source:'smartstore',skus:['A'],consistency}),/변경/);
  const {resolver:api}=harness(),baseline={...response([]),carrier_proofs:[proof]};
  const evidence=value=>api.proof(api.normalize(value,{source:'smartstore',skus:['A']}));
  const expected=evidence(baseline);
  for(const mutate of [entry=>{entry.mapping_fingerprint='changed';},entry=>{entry.sellpia_prices.A=1234;},entry=>{entry.targets[0].price.final=1234;}]){
    const changed=plain(baseline);mutate(changed.carrier_proofs[0]);
    assert.throws(()=>api.assertProof(expected,evidence(changed)),/미리보기/);
  }
});

test('canonical resolver proof captures absence, raw source, snapshot and mapping drift and new or removed decisions',async()=>{
  const {resolver:api}=harness();
  const baseline=response(['A','B']);
  const proof=value=>api.proof(api.normalize(value,{source:'smartstore',skus:['A','B']}));
  const expected=proof(baseline);
  const reordered=plain(baseline);reordered.absence_proofs.reverse();reordered.snapshots=Object.fromEntries(Object.entries(reordered.snapshots).reverse());
  assert.equal(proof(reordered),expected);
  for(const edit of [
    value=>{value.absence_proofs[0].mapping_fingerprint='different';},
    value=>{value.absence_proofs[0].sellpia_prices.A=2000;},
    value=>{value.absence_proofs[0].targets[0].price.final=1500;},
    value=>{value.snapshots.sellpia_snapshot_id='different';for(const entry of [...value.absence_proofs,...value.carrier_proofs])entry.sellpia_snapshot_id='different';},
    value=>{value.snapshots.seller_snapshot_id='different';for(const entry of [...value.absence_proofs,...value.carrier_proofs])entry.snapshot_id='different';},
    value=>{value.absence_proofs.shift();value.rows.push({sku:'A',source_channel:'smartstore',seller_product_code:'P-A',seller_option_code:'1',price:tuple,event_id:1,revision:1,decision_source:'matrix_manual',effective_at:'2026-10-21T00:00:00Z',mapping_valid:true});}
  ]){
    const changed=plain(baseline);edit(changed);
    assert.throws(()=>api.assertProof(expected,proof(changed)),/미리보기/);
  }
  const active=plain(baseline);active.absence_proofs.shift();active.rows=[{sku:'A',source_channel:'smartstore',seller_product_code:'P-A',seller_option_code:'1',price:tuple,event_id:1,revision:1,decision_source:'matrix_manual',effective_at:'2026-10-21T00:00:00Z',mapping_valid:true}];
  assert.throws(()=>api.assertProof(proof(active),expected),/미리보기/);
});
