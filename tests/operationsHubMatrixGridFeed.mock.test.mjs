import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const service=fs.readFileSync('mockups/operations-hub/data-service.js','utf8');
const app=fs.readFileSync('mockups/operations-hub/app.js','utf8');
const migration=fs.readFileSync('supabase/migrations/20260920143340_hub_matrix_grid_feed_v2.sql','utf8');
const jsonChunkFix=fs.readFileSync('supabase/migrations/20260920144902_fix_hub_matrix_grid_feed_v2_json_chunks.sql','utf8');
const compactV3=fs.readFileSync('supabase/migrations/20260920151322_hub_matrix_grid_feed_v3.sql','utf8');
const compactV4=fs.readFileSync('supabase/migrations/20260920152623_hub_matrix_grid_feed_v4.sql','utf8');
const compactV5=fs.readFileSync('supabase/migrations/20260921101200_hub_matrix_grid_feed_v5.sql','utf8');

function functionArgumentCounts(sql,functionName){
  const counts=[];
  const needle=`${functionName}(`;
  for(let start=sql.indexOf(needle);start>=0;start=sql.indexOf(needle,start+1)){
    let cursor=start+needle.length;
    let depth=1;
    let quoted=false;
    let count=1;
    for(;cursor<sql.length&&depth;cursor+=1){
      const char=sql[cursor];
      if(quoted){
        if(char==="'"){
          if(sql[cursor+1]==="'")cursor+=1;
          else quoted=false;
        }
        continue;
      }
      if(char==="'"){quoted=true;continue;}
      if(char==='(')depth+=1;
      else if(char===')')depth-=1;
      else if(char===','&&depth===1)count+=1;
    }
    counts.push(count);
  }
  return counts;
}

function gridLoaderContext(responses){
  const calls=[];
  const context={
    console,
    setTimeout:(callback)=>{queueMicrotask(callback);return 1;},
    clearTimeout:()=>{},
    performance:{now:(()=>{let n=0;return()=>++n;})()},
    fullMatrixReadContext:null,
    matrixReadMetrics:{requests:0,bytes:0,networkMs:0},
    cleanText:value=>String(value??'').trim(),
    throwIfAborted:signal=>{if(signal?.aborted)throw Error('aborted');},
    withAbortSignal:query=>query,
    requireOperationsHubSessionToken:()=> 'operator-session',
    readableDatabaseError:error=>Error(error.message||String(error)),
    db:{rpc:async(name,args)=>{calls.push({name,args});if(name==='hub_matrix_grid_link_badges_v1'&&!responses[0]?.badgeResponse)return {data:{contract_version:1,dataset_version:args.p_dataset_version,requested:args.p_skus.length,link_badges:[],server_ms:1},error:null};const next=responses.shift();return next instanceof Error?{error:{message:next.message}}:{data:next?.badgeResponse||next,error:null};}}
  };
  vm.createContext(context);
  const start=service.indexOf('  function decodeMatrixGridV4');
  const end=service.indexOf('  async function loadFullMatrixDataset',start);
  vm.runInContext(service.slice(start,end)+'\nthis.loadMatrixGridDataset=loadMatrixGridDataset;this.normalizeMatrixGridRow=normalizeMatrixGridRow;',context);
  return {context,calls};
}

test('grid feed v2 separates manifest, enforces one cache version, and remains read-only',()=>{
  assert.match(migration,/hub_matrix_grid_manifest_v2/);
  assert.match(migration,/hub_matrix_grid_feed_v2/);
  assert.match(migration,/require_operations_hub_operator_session\(p_session_token\)/);
  assert.match(migration,/sellpia_sku_code > p_after_sku/);
  assert.match(migration,/order by cache\.sellpia_sku_code[\s\S]*?limit p_limit \+ 1/);
  assert.match(migration,/p_limit not between 250 and 5000/);
  assert.match(migration,/v_current_version is distinct from p_dataset_version/);
  assert.doesNotMatch(migration,/cache\.profile_json|cache\.seller_drafts_json/);
  assert.doesNotMatch(migration,/\b(insert|update|delete|merge|truncate)\b/i);
});

test('grid feed row projection stays below PostgreSQL function argument limit',()=>{
  const argumentCounts=functionArgumentCounts(jsonChunkFix,'jsonb_build_object');
  assert.ok(argumentCounts.length>10);
  assert.ok(Math.max(...argumentCounts)<=100,`jsonb_build_object max arguments: ${Math.max(...argumentCounts)}`);
  assert.match(jsonChunkFix,/\)\s*\|\| jsonb_build_object\([\s\S]*?\)\s*\|\| jsonb_build_object\(/);
  assert.doesNotMatch(jsonChunkFix,/\b(insert|update|delete|merge|truncate)\b/i);
});

test('grid feed v3 is additive, read-only, sparse, and keeps the session boundary',()=>{
  assert.match(compactV3,/hub_matrix_grid_manifest_v3/);
  assert.match(compactV3,/hub_matrix_grid_feed_v3/);
  assert.match(compactV3,/require_operations_hub_operator_session\(p_session_token\)/);
  assert.match(compactV3,/sellpia_sku_code > p_after_sku/);
  assert.match(compactV3,/jsonb_strip_nulls/);
  assert.match(compactV3,/tag_catalog/);
  assert.doesNotMatch(compactV3,/__sellerDrafts|__linkSuppressions|activeOutputRules|generationId|calculatedAt/);
  assert.doesNotMatch(compactV3,/\b(insert|update|delete|merge|truncate)\b/i);
});

test('grid feed v4 is additive, positional, read-only, and publishes keyset cursors',()=>{
  assert.match(compactV4,/hub_matrix_grid_manifest_v4/);
  assert.match(compactV4,/hub_matrix_grid_feed_v4/);
  assert.match(compactV4,/require_operations_hub_operator_session\(p_session_token\)/);
  assert.match(compactV4,/sellpia_sku_code > p_after_sku/);
  assert.match(compactV4,/'page_cursors'/);
  assert.match(compactV4,/jsonb_build_array\(\s*effective\.sellpia_sku_code/);
  assert.doesNotMatch(compactV4,/row_json[\s\S]{0,300}__sellerDrafts|__linkSuppressions|activeOutputRules|generationId|calculatedAt/);
  assert.doesNotMatch(compactV4,/\b(insert|update|delete|merge|truncate)\b/i);
});

test('grid feed v5 computes link badges once in the manifest and keeps data pages read-only',()=>{
  assert.match(compactV5,/hub_matrix_grid_manifest_v5/);
  assert.match(compactV5,/hub_matrix_grid_feed_v5/);
  assert.match(compactV5,/hub_matrix_grid_guard_v5/);
  assert.equal((compactV5.match(/get_operations_hub_sku_link_badges_v2/g)||[]).length,1);
  assert.match(compactV5,/'link_badges', v_link_badges/);
  assert.doesNotMatch(compactV5, /link_badge_rows as materialized/);
  assert.doesNotMatch(compactV5,/\b(insert|update|delete|merge|truncate)\b/i);
});

test('grid loader completes manifest plus keyset pages and rechecks the manifest',async()=>{
  const version='2026-09-20T00:00:00Z';
  const first=Array.from({length:250},(_,index)=>({sellpia_sku_code:`${String(index+1).padStart(3,'0')}`,__grid_meta:{}}));
  const {context,calls}=gridLoaderContext([
    {contract_version:6,total:251,dataset_version:version,recommended_chunk_size:250,max_chunk_size:4000,tag_catalog:{},page_cursors:[null,'250']},
    {contract_version:5,rows:first,loaded:250,next_sku:'250',has_more:true,dataset_version:version,server_ms:3,payload_bytes:100},
    {badgeResponse:{contract_version:1,dataset_version:version,requested:250,link_badges:[['001','smartstore',2,'bundle']],server_ms:2}},
    {contract_version:5,rows:[{sellpia_sku_code:'251'}],loaded:1,next_sku:null,has_more:false,dataset_version:version,server_ms:2,payload_bytes:50},
    {contract_version:5,total:251,dataset_version:version}
  ]);
  const result=await context.loadMatrixGridDataset({chunkSize:250});
  assert.equal(result.count,251);
  assert.equal(result.rows.at(-1).sellpia_sku_code,'251');
  assert.equal(JSON.stringify(calls.map(call=>call.name)),JSON.stringify(['hub_matrix_grid_manifest_v6','hub_matrix_grid_feed_v5','hub_matrix_grid_link_badges_v1','hub_matrix_grid_feed_v5','hub_matrix_grid_link_badges_v1','hub_matrix_grid_guard_v5']));
  assert.equal(calls[1].args.p_after_sku,null);
  assert.equal(calls[3].args.p_after_sku,'250');
  assert.equal(calls[1].args.p_dataset_version,version);
  assert.equal(calls[2].args.p_skus.length,250);
  assert.equal(result.rows[0].__linkBadges.smartstore.relation_type,'bundle');
  assert.equal(result.metrics.mode,'grid-feed-v5');
  assert.equal(result.metrics.badgeAttempts,2);
  assert.equal(result.metrics.pageDiagnostics.length,2);
  assert.equal(typeof result.metrics.pageDiagnostics[0].normalizeMs,'number');
});

test('grid loader rejects duplicates, manifest drift, and stalled cursors',async()=>{
  const manifest={contract_version:6,total:2,dataset_version:'2026-09-20T00:00:00Z',recommended_chunk_size:3000,max_chunk_size:4000,tag_catalog:{},page_cursors:[null]};
  let fixture=gridLoaderContext([manifest,{contract_version:5,rows:[{sellpia_sku_code:'1'},{sellpia_sku_code:'1'}],loaded:2,next_sku:null,has_more:false,dataset_version:manifest.dataset_version},{contract_version:5,total:2,dataset_version:manifest.dataset_version}]);
  await assert.rejects(fixture.context.loadMatrixGridDataset(),/중복/);
  fixture=gridLoaderContext([manifest,{contract_version:5,rows:[{sellpia_sku_code:'1'},{sellpia_sku_code:'2'}],loaded:2,next_sku:null,has_more:false,dataset_version:'2026-09-20T00:01:00Z'}]);
  await assert.rejects(fixture.context.loadMatrixGridDataset(),/cache가 변경/);
  fixture=gridLoaderContext([
    {...manifest,total:251,recommended_chunk_size:250,page_cursors:[null,'250']},
    {contract_version:5,rows:[],loaded:0,next_sku:'wrong',has_more:true,dataset_version:manifest.dataset_version},
    {contract_version:5,rows:[{sellpia_sku_code:'251'}],loaded:1,next_sku:null,has_more:false,dataset_version:manifest.dataset_version}
  ]);
  await assert.rejects(fixture.context.loadMatrixGridDataset({chunkSize:250}),/cursor가 진행/);
});

test('grid loader retries only the failed page and never restarts the dataset',async()=>{
  const version='2026-09-20T00:00:00Z';
  const fixture=gridLoaderContext([
    {contract_version:6,total:1,dataset_version:version,recommended_chunk_size:3000,max_chunk_size:4000,tag_catalog:{},page_cursors:[null]},
    new Error('canceling statement due to statement timeout'),
    {contract_version:5,rows:[{sellpia_sku_code:'1'}],loaded:1,next_sku:null,has_more:false,dataset_version:version,server_ms:2},
    {contract_version:5,total:1,dataset_version:version}
  ]);
  const result=await fixture.context.loadMatrixGridDataset();
  assert.equal(result.count,1);
  assert.equal(fixture.calls.filter(call=>call.name==='hub_matrix_grid_feed_v5').length,2);
  assert.equal(fixture.calls.filter(call=>call.name==='hub_matrix_grid_manifest_v6').length,1);
  assert.equal(fixture.calls.filter(call=>call.name==='hub_matrix_grid_guard_v5').length,1);
  assert.equal(result.metrics.pageDiagnostics[0].retries,1);
});

test('bounded badge lookup rejects version drift without publishing a partial Matrix',async()=>{
  const version='2026-09-20T00:00:00Z';
  const fixture=gridLoaderContext([
    {contract_version:6,total:1,dataset_version:version,max_chunk_size:4000,tag_catalog:{},page_cursors:[null]},
    {contract_version:5,rows:[{sellpia_sku_code:'1'}],loaded:1,next_sku:null,has_more:false,dataset_version:version},
    {badgeResponse:{contract_version:1,dataset_version:'2026-09-20T00:01:00Z',requested:1,link_badges:[]}}
  ]);
  await assert.rejects(fixture.context.loadMatrixGridDataset(),/연결 배지 응답 contract/);
  assert.equal(fixture.calls.filter(call=>call.name==='hub_matrix_grid_guard_v5').length,0);
});

test('grid v5 positional row and manifest link catalog restore the existing renderer contract',()=>{
  const fixture=gridLoaderContext([]);
  const positional=Array(35).fill(null);
  positional[0]='5566-1';positional[4]='OWN';positional[25]=['P',null,null,null,'MANUAL_LINKED',2,false,null,null];
  positional[33]=[false,false,true,false,false];
  positional[34]=[
      ['5566',null,null,null,['T1'],['T2']],
      {'smartstore:sellpia_sale_price':{id:'D',status:'pending',b:4000,d:2000,o:0,f:2000}},
      {},null,{smartstore:{b:2800,d:2800,o:0,f:2800}},
      {smartstore:{b:4000,d:2000,o:0,f:2000,n:['가격 Rule']}},
      {calculated_base_price:{v:59000,n:['2.2배'],t:['T2']}}
  ];
  const row=fixture.context.normalizeMatrixGridRow(positional,{T1:{name:'상품 태그',color:'#111',group:'일반'},T2:{name:'2.2배',color:'#222',group:'수식'}},{'5566-1':{smartstore:{max:2,relation:'bundle'}}});
  assert.equal(row.__profile.product_tags[0].tag_name,'상품 태그');
  assert.equal(row.__profile.sku_tags[0].tag_name,'2.2배');
  assert.equal(row.__sellerDrafts['smartstore:sellpia_sale_price'].price_base_after,4000);
  assert.equal(row.__sellerPriceComponents.smartstore.source_final_price,2800);
  assert.equal(row.__hubRulePrices.smartstore.platformFinal,2000);
  assert.equal(row.__hubActivePriceRules.smartstore,true);
  assert.equal(row.__hubInternalPrices.calculated_base_price.activeOutputRules[0].tag_id,'T2');
  assert.equal(row.__linkBadges.smartstore.relation_type,'bundle');
  assert.equal(row.__grid_meta,undefined);
});

test('programming and contract errors do not retry',async()=>{
  const fixture=gridLoaderContext([new Error('cannot pass more than 100 arguments to a function')]);
  await assert.rejects(fixture.context.loadMatrixGridDataset(),/100 arguments/);
  assert.equal(fixture.calls.length,1);
});

test('frontend uses Grid feed without automatic legacy load amplification and lazily hydrates drawer detail',()=>{
  assert.match(app,/hasOwnProperty\.call\(liveData,'loadMatrixGridDataset'\)[\s\S]*?liveData\.loadMatrixGridDataset\(\{onProgress:progress,chunkSize:2000\}\)/);
  assert.doesNotMatch(app,/Grid feed 실패 · 기존 전체 조회로 안전 전환/);
  assert.match(app,/legacy fallback is disabled/);
  assert.match(app,/forceLegacy[\s\S]*?loadFullMatrixDataset/);
  assert.match(app,/if\(liveData\.loadFullMatrixDataset\)[\s\S]*?mode:'legacy-capability'/);
  assert.match(app,/liveProduct\.__grid_compact[\s\S]*?loadProductsBySkus\(\[selectedSku\]\)[\s\S]*?matrixDataset\.patch\(\[details\[0\]\]\)/);
  assert.match(app,/if\(matrixFullLoad\)\{await matrixFullLoad;fullReload=false;\}/);
});

test('grid bootstrap uses stable 2,000-row sequential pages and defers status reads',()=>{
  assert.match(service,/Number\(chunkSize\)\|\|2000/);
  assert.match(service,/const safeChunk=Math\.max\(250,Math\.min\(maxChunk,requestedChunk\)\)/);
  assert.match(service,/length:Math\.min\(1,cursors\.length\)/);
  assert.match(app,/const matrix = shouldLoadMatrix[\s\S]*?await loadLiveMatrix[\s\S]*?const \[source, metrics, mapping\] = await Promise\.all/);
});
