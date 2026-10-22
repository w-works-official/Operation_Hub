import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source=fs.readFileSync(new URL('../mockups/operations-hub/data-service.js',import.meta.url),'utf8');
const plain=value=>JSON.parse(JSON.stringify(value));
const uuid='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',timestamp='2026-10-22T04:45:48Z';
const row=(productCode,revision=1,basePrice=9000,basicDiscount=2000)=>({source_channel:'smartstore',product_code:productCode,base_price:basePrice,basic_discount:basicDiscount,revision,updated_at:timestamp,updated_by:'operator'});
const setting=(productCode,expectedRevision=0,basePrice=9000,basicDiscount=2000)=>({productCode,basePrice,basicDiscount,expectedRevision});
function harness(handler=(_name,args)=>({data:{contract_version:1,source:'smartstore',settings:args.p_product_codes.map(code=>row(code))},error:null})){
 const calls=[],signals=[],events=[];
 const db={rpc(name,args){const index=calls.length;calls.push({name,args:plain(args)});const request={abortSignal(signal){signals.push(signal);return request;},then(resolve,reject){return Promise.resolve().then(()=>handler(name,args,index)).then(resolve,reject);}};return request;},from(){throw Error('Direct table reads/writes are forbidden in settings service tests');},storage:new Proxy({},{get(){throw Error('Storage is forbidden');}})};
 const win={supabase:{createClient:()=>db},crypto:{randomUUID:()=>uuid},dispatchEvent(event){events.push(event);},CustomEvent:class CustomEvent{constructor(type,init){this.type=type;this.detail=init?.detail;}}};
 const context=vm.createContext({window:win,URL,TextEncoder,TextDecoder,AbortController,AbortSignal,Blob,File:globalThis.File,performance,crypto:win.crypto,CustomEvent:win.CustomEvent,console,setTimeout,clearTimeout,structuredClone});
 vm.runInContext(source,context,{filename:'data-service.js'});win.SystemV3Data.setOperationsHubSessionToken('test-session');
 return {api:win.SystemV3Data,calls,signals,events};
}
const savedResponse=(args,{idempotent=false}={})=>({data:{contract_version:1,source:'smartstore',request_id:args.p_request_id,idempotent,settings:args.p_settings.map(value=>row(value.product_code,value.expected_revision+1,value.base_price,value.basic_discount))},error:null});

test('actual settings reader batches 200 sorted unique products, maps strict metadata and issues no write RPC',async()=>{
 const h=harness(),codes=Array.from({length:401},(_,index)=>`P${String(index).padStart(4,'0')}`).reverse(),input=[...codes,codes[0]],before=[...input],queries=[],controller=new AbortController();
 const result=await h.api.loadProductPriceSettings({source:'smartstore',productCodes:input,signal:controller.signal,onQuery:query=>queries.push(query)});
 assert.equal(result.contractVersion,1);assert.equal(result.source,'smartstore');assert.equal(result.settings.length,401);
 assert.deepEqual(h.calls.map(call=>call.args.p_product_codes.length),[200,200,1]);assert.ok(h.calls.every(call=>call.name==='hub_product_price_settings_read_v1'&&call.args.p_session_token==='test-session'&&call.args.p_source==='smartstore'));
 assert.equal(h.signals.length,3);assert.ok(h.signals.every(signal=>signal===controller.signal));assert.deepEqual(queries.map(query=>query.scope_count),[200,200,1]);
 assert.ok(queries.every(query=>query.query==='product_price_settings'&&Number.isFinite(query.latency_ms)));
 assert.deepEqual(plain(result.settings[0]),{productCode:'P0000',basePrice:9000,basicDiscount:2000,revision:1,updatedAt:timestamp});assert.deepEqual(input,before);
 const empty=await h.api.loadProductPriceSettings({source:'smartstore',productCodes:[]});assert.deepEqual(plain(empty.settings),[]);assert.equal(h.calls.length,3);
});

test('read aborts before transport or between batches and keeps the last asynchronous response out of results',async()=>{
 const h=harness(),before=new AbortController();before.abort();
 await assert.rejects(h.api.loadProductPriceSettings({source:'smartstore',productCodes:['P'],signal:before.signal}),error=>error.name==='AbortError');assert.equal(h.calls.length,0);
 const controller=new AbortController(),during=harness(async(_name,args)=>{controller.abort();return {data:{contract_version:1,source:'smartstore',settings:args.p_product_codes.map(code=>row(code))},error:null};});
 await assert.rejects(during.api.loadProductPriceSettings({source:'smartstore',productCodes:Array.from({length:201},(_,i)=>`P${i}`),signal:controller.signal}),error=>error.name==='AbortError');assert.equal(during.calls.length,1);
});

test('read rejects wrong contracts, repeated/out-of-scope products and invalid persisted numbers or metadata',async()=>{
 for(const mutate of [
  data=>{data.contract_version=2;},data=>{data.source='makeshop';},data=>{data.settings=null;},data=>{data.settings.push(row('P'));},
  data=>{data.settings[0].product_code='OTHER';},data=>{data.settings[0].source_channel='ably';},data=>{data.settings[0].product_code='x'.repeat(129);},
  ...[null,'',true,-1,1.5,Number.MAX_SAFE_INTEGER+1].map(value=>data=>{data.settings[0].base_price=value;}),
  data=>{data.settings[0].basic_discount=10000;},data=>{data.settings[0].revision=0;},data=>{data.settings[0].updated_at='invalid-time';},
 ]){
  const h=harness(()=>{const data={contract_version:1,source:'smartstore',settings:[row('P')]};mutate(data);return {data,error:null};});
  await assert.rejects(h.api.loadProductPriceSettings({source:'smartstore',productCodes:['P']}));assert.equal(h.calls.length,1);
 }
 for(const productCodes of [[null],[''],[' P'],['x'.repeat(129)],{}]){
  const h=harness();await assert.rejects(h.api.loadProductPriceSettings({source:'smartstore',productCodes}));assert.equal(h.calls.length,0);
 }
});

test('explicit save sends one atomic sorted CAS batch and returns canonical persisted settings without mutating input',async()=>{
 const h=harness((name,args)=>{assert.equal(name,'hub_product_price_settings_save_v1');return savedResponse(args);});
 const settings=[setting('P2',3,10000,3000),setting('P1')],before=structuredClone(settings);
 const result=await h.api.saveProductPriceSettings({source:'smartstore',settings,requestId:uuid});
 assert.equal(h.calls.length,1);assert.deepEqual(h.calls[0].args,{p_session_token:'test-session',p_source:'smartstore',p_request_id:uuid,p_settings:[{product_code:'P1',base_price:9000,basic_discount:2000,expected_revision:0},{product_code:'P2',base_price:10000,basic_discount:3000,expected_revision:3}]});
 assert.equal(result.saved,true);assert.equal(result.requestId,uuid);assert.equal(result.idempotent,false);assert.deepEqual(plain(result.settings.map(value=>[value.productCode,value.revision])),[['P1',1],['P2',4]]);assert.deepEqual(settings,before);
 assert.ok(!h.calls.some(call=>/apply|current_price|mapping|snapshot/.test(call.name)),'saving B/basic does not write effective final prices or source/mapping tables');
});

test('an explicit request UUID is reused unchanged after an unknown transport outcome and replay does not invent a new revision',async()=>{
 const h=harness((_name,args,index)=>{if(index===0)throw Error('synthetic network result unknown');return savedResponse(args,{idempotent:true});});
 const options={source:'smartstore',settings:[setting('P')],requestId:uuid};
 await assert.rejects(h.api.saveProductPriceSettings(options),/network result unknown/);
 const replay=await h.api.saveProductPriceSettings(options);assert.equal(replay.idempotent,true);assert.equal(replay.settings[0].revision,1);assert.deepEqual(h.calls[0],h.calls[1]);
});

test('invalid settings, duplicate products, unsupported source and malformed UUID are rejected before an RPC',async()=>{
 const invalid=[[],Array.from({length:501},(_,i)=>setting(`P${i}`)),[setting('P'),setting('P')],[setting('')],[setting(' P')],[setting('x'.repeat(129))],
  [{...setting('P'),final:7000}],[{...setting('P'),basePrice:'9000'}],[setting('P',0,0,1)],[setting('P',Number.MAX_SAFE_INTEGER)],
  ...[null,true,-1,1.1,Infinity,Number.MAX_SAFE_INTEGER+1].map(value=>[{...setting('P'),expectedRevision:value}])];
 for(const settings of invalid){const h=harness();await assert.rejects(h.api.saveProductPriceSettings({source:'smartstore',settings,requestId:uuid}));assert.equal(h.calls.length,0);}
 for(const options of [{source:'makeshop',settings:[setting('P')],requestId:uuid},{source:'smartstore',settings:[setting('P')],requestId:'invalid'}]){const h=harness();await assert.rejects(h.api.saveProductPriceSettings(options));assert.equal(h.calls.length,0);}
});

test('save fails closed on a wrong or partial response, different CAS values and missing idempotency evidence',async()=>{
 for(const mutate of [
  data=>{data.contract_version=2;},data=>{data.source='ably';},data=>{data.request_id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';},data=>{data.settings=[];},
  data=>{data.settings[0].product_code='OTHER';},data=>{data.settings[0].base_price++;},data=>{data.settings[0].basic_discount++;},data=>{data.settings[0].revision++;},
  data=>{delete data.idempotent;},data=>{data.idempotent='yes';},
 ]){const h=harness((_name,args)=>{const result=savedResponse(args);mutate(result.data);return result;});await assert.rejects(h.api.saveProductPriceSettings({source:'smartstore',settings:[setting('P')],requestId:uuid}));}
 const duplicate=harness((_name,args)=>{const result=savedResponse(args);result.data.settings[1]=result.data.settings[0];return result;});
 await assert.rejects(duplicate.api.saveProductPriceSettings({source:'smartstore',settings:[setting('P'),setting('Q')],requestId:uuid}));
});

test('missing sessions and server CAS or auth failures never fall back to source or effective-price writes',async()=>{
 const h=harness();h.api.setOperationsHubSessionToken('');await assert.rejects(h.api.loadProductPriceSettings({source:'smartstore',productCodes:['P']}),/로그인/);await assert.rejects(h.api.saveProductPriceSettings({source:'smartstore',settings:[setting('P')],requestId:uuid}),/로그인/);assert.equal(h.calls.length,0);
 for(const code of ['40001','42501']){const fail=harness(()=>({data:null,error:{code,message:code==='40001'?'다른 작업에서 설정 변경':'운영 세션 만료'}}));await assert.rejects(fail.api.saveProductPriceSettings({source:'smartstore',settings:[setting('P')],requestId:uuid}));assert.equal(fail.calls.length,1);assert.equal(fail.calls[0].name,'hub_product_price_settings_save_v1');}
});
