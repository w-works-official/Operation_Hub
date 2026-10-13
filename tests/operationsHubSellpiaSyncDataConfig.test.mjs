import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
const source=fs.readFileSync(new URL('../mockups/operations-hub/data-service.js',import.meta.url),'utf8');
function fixture(config,href='http://127.0.0.1:9133/hub'){
  const connections=[],requests=[];
  const context={console,URL,File,Blob,TextEncoder,TextDecoder,Uint8Array,ArrayBuffer,AbortController,crypto:webcrypto,performance,setTimeout,clearTimeout,atob,
    location:{href},supabase:{createClient:(url,key)=>{connections.push({url,key});return {};}},
    fetch:async(url,options)=>{requests.push({url:String(url),options});return new Response(JSON.stringify({ok:true,enabled:true,applyEnabled:false}));}};
  if(config!==undefined)context.SystemV3DataConfig=config;
  context.window=context;context.globalThis=context;vm.createContext(context);
  return {context,connections,requests,load(){vm.runInContext(source,context);return context.SystemV3Data;}};
}
const publicConfig={mode:'local-qa',supabaseUrl:'http://127.0.0.1:54321',publishableKey:'sb_publishable_synthetic_local_only'};
test('default configuration keeps the existing company backend without a QA override',()=>{
  const f=fixture(undefined,'https://w-works-official.github.io/Operation_Hub/');f.load();
  assert.equal(f.connections[0].url,'https://bpgvqmtsjgegnrdzmpep.supabase.co');assert.equal(f.requests.length,0);
});
test('explicit loopback QA config keeps database and sync HTTP calls on the same local backend',async()=>{
  const f=fixture(publicConfig),data=f.load();data.setOperationsHubSessionToken('s'.repeat(64));
  assert.equal(data.hasOperationsHubSession(),true);await data.sellpiaSyncRequest('availability',{});
  assert.equal(f.connections[0].url,'http://127.0.0.1:54321');assert.equal(f.requests[0].url,'http://127.0.0.1:54321/functions/v1/operations-hub-sellpia-sync');
  assert.equal(f.requests[0].options.headers.apikey,publicConfig.publishableKey);assert.equal(f.requests[0].options.headers['x-sellpia-sync-worker-token'],undefined);
  data.setOperationsHubSessionToken('');assert.equal(data.hasOperationsHubSession(),false);
});
for(const url of ['https://remote.example','http://127.0.0.1.evil.example','http://operator:secret@localhost:54321','http://localhost:54321/?key=synthetic','http://localhost:54321/#key','http://localhost:54321/rest/v1/'])test(`QA URL rejects unsafe host or URL components: ${url.replace(/operator:secret@/,'redacted@')}`,()=>{
  const f=fixture({...publicConfig,supabaseUrl:url});assert.throws(()=>f.load(),/localhost/);assert.equal(f.connections.length,0);assert.equal(f.requests.length,0);
});
test('remote frontend cannot redirect operator sessions to an override backend',()=>{
  const f=fixture(publicConfig,'https://w-works-official.github.io/Operation_Hub/');assert.throws(()=>f.load(),/localhost/);assert.equal(f.connections.length,0);
});
test('QA injection rejects privileged credentials and accepts only a synthetic anon JWT or publishable key',()=>{
  const token=role=>`${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({role})).toString('base64url')}.synthetic`;
  for(const key of ['sb_secret_synthetic_only',token('service_role')])assert.throws(()=>fixture({...publicConfig,publishableKey:key}).load(),/공개 anon/);
  assert.equal(fixture({...publicConfig,publishableKey:token('anon')}).load().hasOperationsHubSession(),false);
});
test('existing upload normalizes either sale-price alias and includes base-price changes in affected-SKU calculation',async()=>{
  for(const fields of [{price:true,basePrice:false},{price:false,basePrice:true}]){
    const f=fixture(publicConfig),requests=[],rpcCalls=[],file=new File(['synthetic source bytes'],'source.csv');
    f.context.SystemV3SellpiaSourceParser={parseSellpiaFiles:async selected=>({valid:true,rows:[{sellpia_sku_code:'0001-1',source_row_no:1}],files:selected.map(source=>({name:source.name,encoding:'UTF-8',columnCount:24,rowCount:1,minRowNo:1,maxRowNo:1}))})};
    f.context.supabase.createClient=()=>({storage:{from:()=>({uploadToSignedUrl:async()=>({error:null})})},rpc:async(name,args)=>{rpcCalls.push({name,args});return {data:name==='hub_sellpia_upload_complete_v1'?{status:'ready',row_count:1}:name==='operations_hub_sellpia_patch_price_affected_skus'?['0001-1']:null,error:null};}});
    f.context.fetch=async(_url,options)=>{const body=JSON.parse(options.body);requests.push(body);return new Response(JSON.stringify({ok:true,data:body.action==='upload-init'?{intent_id:'intent-synthetic',snapshot_id:'snapshot-synthetic',manifest:[{ordinal:1,path:'synthetic-only',token:'synthetic-signed-upload-token'}]}:{status:'uploaded'}}));};
    const data=f.load();data.setOperationsHubSessionToken('s'.repeat(64));const result=await data.uploadSellpiaSnapshot([file],{...fields,mode:'patch',requestId:'synthetic-request'});
    const selected=requests.find(request=>request.action==='upload-init').selected_fields;assert.equal(selected.price,true);assert.equal(selected.basePrice,true);
    const affected=rpcCalls.find(call=>call.name==='operations_hub_sellpia_patch_price_affected_skus');assert.ok(affected);assert.equal(affected.args.p_selected_fields.price,true);assert.equal(affected.args.p_selected_fields.basePrice,true);assert.deepEqual(Array.from(result.affectedSkus),['0001-1']);
  }
});
