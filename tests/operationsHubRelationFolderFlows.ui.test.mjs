import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import {chromium} from 'playwright';

// Load the real application and markup; only the authenticated data transport is
// synthetic. No requests or writes can reach the operations database.
async function fixture(t, {large = false} = {}) {
  const root = path.resolve('mockups/operations-hub');
  const server = http.createServer((request, response) => {
    const file = path.resolve(root, '.' + decodeURIComponent(new URL(request.url, 'http://localhost').pathname));
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { response.writeHead(404).end(); return; }
    response.setHeader('Content-Type', path.extname(file) === '.js' ? 'text/javascript' : path.extname(file) === '.css' ? 'text/css' : 'text/html');
    response.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({headless:true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? {executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH} : process.platform === 'win32' ? {channel:'msedge'} : {})});
  const page = await browser.newPage({viewport:{width:1700,height:1100}}), errors = [];
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => dialog.accept());
  t.after(async () => { await browser.close(); await new Promise(resolve => server.close(resolve)); assert.deepEqual(errors, []); });
  await page.route('https://**/*', route => route.fulfill({contentType:'text/javascript',body:'window.supabase={createClient:()=>({rpc:async()=>({data:{}})})};'}));
  await page.addInitScript(({large}) => {
    const node = (id, folderId) => ({nodeId:id,nodeType:'sellpia_sku',sellpiaSkuCode:`${10000 + id}-1`,displayName:`관계 항목 ${id}`,folderId,relationKind:'collection'});
    const nodes = large ? Array.from({length:1700}, (_, index) => node(index + 1, 1)) : [node(1,3),node(2,3),node(3,2),node(4,2),node(5,null),node(6,null)];
    const edges = large ? Array.from({length:851}, (_, index) => ({edgeId:index+1,parentNodeId:index+1,childNodeId:index+2,sortOrder:100})) : [{edgeId:11,parentNodeId:1,childNodeId:2},{edgeId:12,parentNodeId:3,childNodeId:4},{edgeId:13,parentNodeId:5,childNodeId:6}];
    const state = window.relationFolderFixture = {nodes,edges,folders:[{folderId:1,name:'모음전 관리',kind:'collection',parentFolderId:null,sortOrder:17},{folderId:2,name:'다른 폴더',kind:'custom',parentFolderId:null,sortOrder:42},...large?[]:[{folderId:3,name:'하위 폴더',kind:'collection',parentFolderId:1,sortOrder:23}]],calls:[],writes:[],pendingGraphs:[],pendingFolders:[],pendingSaves:[],deferGraph:false,deferFolder:false,deferSave:false,failFolderReads:0,failSave:false,mutationWarning:false};
    const graph = () => ({nodes:structuredClone(state.nodes),edges:structuredClone(state.edges),complete:true,nodeCount:state.nodes.length,edgeCount:state.edges.length,version:'fixture-v1'});
    const folders = () => ({folders:state.folders.map(folder => {
      const descendants = new Set([folder.folderId]); let changed = true;
      while (changed) { changed = false; for (const candidate of state.folders) if (descendants.has(candidate.parentFolderId) && !descendants.has(candidate.folderId)) { descendants.add(candidate.folderId); changed = true; } }
      return {...folder,directNodeCount:state.nodes.filter(node=>node.folderId===folder.folderId).length,descendantNodeCount:state.nodes.filter(node=>descendants.has(node.folderId)).length};
    }),organizedCount:state.nodes.filter(node=>node.folderId!==null).length,unorganizedExplicitCount:state.nodes.filter(node=>node.folderId===null).length});
    const notify = () => window.dispatchEvent(new CustomEvent('hub-relations-changed',{detail:{skus:['10001-1','10002-1'],complete:!state.mutationWarning,warning:state.mutationWarning?'post-read timeout':''}}));
    const expiresAt = new Date(Date.now()+3600000).toISOString();
    sessionStorage.setItem('system-v3-operations-session-v1',JSON.stringify({token:'a'.repeat(64),expiresAt}));
    const api = {mode:'live',pageSize:200,setOperationsHubSessionToken:()=>{},checkOperationsHubSession:async()=>({authenticated:true,expiresAt}),
      loadMatrixGridDataset:async()=>({rows:[],count:0,metrics:{requests:1}}),loadDashboardMetrics:async()=>({total_sku:0}),loadMappingSyncStatus:async()=>({}),loadSourceStatus:async()=>({events:[],latest:{}}),ruleRegistry:async()=>({rules:[],assignments:[],dependencies:[]}),loadOriginalUploadHistory:async()=>({rows:[],hasMore:false}),loadTagCatalog:async()=>({rows:[]}),loadSellerInventoryPolicies:async()=>[],loadPresets:async()=>[],loadPendingPurchasePriceRecalculations:async()=>({pendingCount:0,skus:[]}),
      loadSellpiaRelationVisuals:async skus=>{const key=skus.includes('SET-1')?'deferBundleVisuals':'deferRelationVisuals';if(state[key]){state[key]=false;return new Promise((resolve,reject)=>(state.pendingVisuals||=[]).push({resolve,reject,key}));}return [];},
      loadRelationNodes:async(...args)=>{state.calls.push({method:'graph',args});if(state.failGraphRead){state.failGraphRead=false;throw Error('current graph read failed');}const value=graph(); if(state.deferGraph){state.deferGraph=false;return new Promise((resolve,reject)=>state.pendingGraphs.push({resolve,reject,value}));} return value;},
      loadRelationFolders:async()=>{state.calls.push({method:'folders'});if(state.failFolderReads>0){state.failFolderReads--;throw Error('folder list timeout');}const value=folders();if(state.deferFolder){state.deferFolder=false;return new Promise((resolve,reject)=>state.pendingFolders.push({resolve,reject,value}));}return value;},
      listBundleGraph:async query=>{state.calls.push({method:'bundles',query});if(state.failBundleRead){state.failBundleRead=false;throw Error('current bundle read failed');}return {bundles:[{bundleSkuCode:'SET-1',productName:state.bundleName||'독립 세트',components:[{componentId:91,componentSkuCode:'PART-1',productName:'구성품',qty:state.bundleQty??2}]}]};},
      listSellerBundleGraph:async args=>{state.calls.push({method:'sellerBundle',args});return {source:args.source,productCode:args.query,optionCode:'O1',productName:'판매처 전용',bundleType:'set',components:[{componentId:92,sku:'PART-1',qty:3}]};},
      loadRelationEdgeHistory:async()=>({events:[]}),
      saveRelationFolder:async args=>{
        state.writes.push({method:'saveFolder',args:structuredClone(args)});
        if(state.failSave)throw Error('folder write rejected');
        if(state.deferSave){state.deferSave=false;await new Promise((resolve,reject)=>state.pendingSaves.push({resolve,reject}));}
        const id=args.folderId?Number(args.folderId):99;
        const existing=state.folders.find(folder=>folder.folderId===id);
        const value={folderId:id,name:args.name,kind:args.kind,parentFolderId:args.parentFolderId?Number(args.parentFolderId):null,sortOrder:args.sortOrder};
        if(existing)Object.assign(existing,value);else state.folders.push(value);
        return {folder_id:id,folder_name:args.name};
      },
      archiveRelationFolder:async id=>{state.writes.push({method:'archiveFolder',id});state.folders=state.folders.filter(folder=>folder.folderId!==id);let count=0;for(const node of state.nodes)if(node.folderId===id){node.folderId=null;count++;}return {unassignedNodes:count};},
      updateRelationEdge:async args=>{state.writes.push({method:'updateEdge',args});Object.assign(state.edges.find(edge=>Number(edge.edgeId)===Number(args.edgeId)),{parentNodeId:Number(args.parentNodeId),childNodeId:Number(args.childNodeId)});notify();return state.mutationWarning?{relationRefreshWarning:'post-read timeout',affected_scope_complete:false}:{affected_scope_complete:true};},
      saveRelationEdge:async args=>{state.writes.push({method:'saveEdge',args});state.edges.push({edgeId:99,parentNodeId:Number(args.parentNodeId),childNodeId:Number(args.childNodeId)});notify();return state.mutationWarning?{relationRefreshWarning:'post-read timeout',affected_scope_complete:false}:{};},
      removeRelationEdge:async id=>{state.writes.push({method:'removeEdge',id});state.edges=state.edges.filter(edge=>Number(edge.edgeId)!==Number(id));notify();return {};}
    };
    Object.defineProperty(window,'SystemV3Data',{configurable:true,get:()=>new Proxy(api,{get:(target,key)=>key in target?target[key]:/^(save|apply|upsert|upload|remove|delete)/.test(String(key))?async(...args)=>{state.writes.push({method:key,args});return {};}:async()=>({rows:[],count:0})}),set:()=>{}});
  },{large});
  await page.goto(`http://127.0.0.1:${server.address().port}/index.html`);
  await page.waitForFunction(()=>operationsAuthState.authenticated);
  await page.locator('[data-page="multi-links"]').first().click();
  await page.waitForFunction(()=>multiLinkWorkspaceState.allLoaded&&!relationGraphState.loading&&!bundleGraphState.loading);
  return page;
}

const folder = id => `#relation-folder-list [data-relation-folder="${id}"]`;
const form = '#relation-folder-form';
const save = `${form} button[type="submit"]`;
const settled = page => page.waitForFunction(()=>!relationGraphState.loading&&!bundleGraphState.loading&&!relationFolderFormState.saving);

test('all view loads 1700 relation items and 851 edges, keeps server folder counts, and renders folder clicks instead of a stuck loading row', async t => {
  const page=await fixture(t,{large:true});
  assert.equal(await page.locator('#multi-link-body .relation-connection-row').count(),851);
  assert.equal(await page.locator('#multi-link-body .bundle-connection-row').count(),1);
  assert.equal(await page.locator(`${folder(1)} b`).innerText(),'1,700');
  assert.deepEqual(await page.evaluate(()=>relationFolderFixture.calls.filter(call=>call.method==='graph').map(call=>call.args)),[[]]);
  await page.locator(folder(1)).click();await settled(page);
  assert.equal(await page.locator('#multi-link-body .relation-connection-row').count(),851);
  assert.equal(await page.locator('#multi-link-body .bundle-connection-row').count(),0);
  assert.equal(await page.locator('#multi-link-body .loading').count(),0);
  await page.locator(folder('unorganized')).click();await settled(page);
  assert.match(await page.locator('#multi-link-body').innerText(),/조회 조건에 해당하는 전체 연결이 없습니다/);
  await page.locator(folder('all')).click();await settled(page);
  assert.equal(await page.locator('#multi-link-body .bundle-connection-row').count(),1);
  assert.equal(await page.evaluate(()=>relationFolderFixture.writes.length),0);
});

test('moving a child folder rerenders the selected ancestor scope and preserves its sort order', async t => {
  const page=await fixture(t);await page.locator('[data-multi-link-tab="relation"]').click();await settled(page);
  await page.locator(folder(1)).click();await settled(page);
  assert.equal(await page.locator('#relation-edge-list tr[data-relation-edge-id="11"]').count(),1);
  await page.locator('[data-folder-id="3"] [data-folder-edit]').click();
  await page.locator('#relation-folder-parent').selectOption('2');await page.locator(save).click();await settled(page);
  assert.equal(await page.locator(form).isHidden(),true);
  assert.equal(await page.locator('#relation-edge-list tr[data-relation-edge-id="11"]').count(),0);
  assert.match(await page.locator('#relation-edge-list').innerText(),/이 분류에 등록된 관계가 없습니다/);
  assert.equal(await page.locator(`${folder(1)} b`).innerText(),'0');assert.equal(await page.locator(`${folder(2)} b`).innerText(),'4');
  assert.equal(await page.evaluate(()=>relationFolderFixture.writes[0].args.sortOrder),23);
  await page.locator(folder(2)).click();await settled(page);assert.equal(await page.locator('#relation-edge-list tr[data-relation-edge-id]').count(),2);
});

test('folder archive refreshes selected scope and authoritative counts without changing relations or bundle quantities', async t => {
  const page=await fixture(t);await page.locator(folder(3)).click();await settled(page);
  await page.locator('[data-folder-id="3"] [data-folder-archive]').click();await settled(page);
  assert.equal(await page.locator(folder(3)).count(),0);assert.equal(await page.locator(folder('unorganized')).getAttribute('class'),'active');
  assert.equal(await page.locator(`${folder('unorganized')} b`).innerText(),'4');
  assert.equal(await page.locator('#multi-link-body .relation-connection-row').count(),2);
  assert.deepEqual(await page.evaluate(()=>({edges:relationFolderFixture.edges.length,writes:relationFolderFixture.writes.map(row=>row.method),qty:bundleGraphState.bundles[0].components[0].qty})),{edges:3,writes:['archiveFolder'],qty:2});
});

test('late folder results and obsolete graph failures cannot replace a newer successful view', async t => {
  const page=await fixture(t);
  await page.evaluate(()=>{relationFolderFixture.deferFolder=true;window.oldFolders=loadRelationFolders({force:true});});
  await page.evaluate(async()=>{relationFolderFixture.folders.push({folderId:99,name:'최신 폴더',kind:'custom',parentFolderId:1});await loadRelationFolders({force:true});});
  await page.evaluate(async()=>{const pending=relationFolderFixture.pendingFolders.shift();pending.resolve(pending.value);await window.oldFolders;});
  assert.equal(await page.locator(folder(99)).count(),1);
  await page.evaluate(()=>{relationFolderFixture.deferGraph=true;window.oldGraph=loadRelationGraph();});
  await page.evaluate(async()=>{relationFolderFixture.nodes[0].displayName='최신 관계 항목';await loadRelationGraph();});
  await page.evaluate(async()=>{relationFolderFixture.pendingGraphs.shift().reject(Error('obsolete graph failure'));await window.oldGraph;});
  assert.match(await page.locator('#relation-edge-list').innerText(),/최신 관계 항목/);
  assert.doesNotMatch(await page.locator('#relation-edge-list').innerText(),/obsolete graph failure/);
  assert.equal(await page.evaluate(()=>relationGraphState.nodes[0].displayName),'최신 관계 항목');
});

test('obsolete relation visual rejection cannot publish pending nodes or overwrite the latest graph failure', async t => {
  const page=await fixture(t);
  await page.evaluate(()=>{relationFolderFixture.nodes[0].displayName='obsolete pending node';relationFolderFixture.deferRelationVisuals=true;window.oldVisualGraph=loadRelationGraph();});
  await page.waitForFunction(()=>relationFolderFixture.pendingVisuals?.length===1);
  assert.equal(await page.evaluate(()=>relationGraphState.nodes[0].displayName),'관계 항목 1');
  await page.evaluate(async()=>{relationFolderFixture.failGraphRead=true;await loadRelationGraph();});
  assert.match(await page.locator('#relation-edge-list').innerText(),/current graph read failed/);
  await page.evaluate(async()=>{relationFolderFixture.pendingVisuals.shift().reject(Error('obsolete visual failure'));await window.oldVisualGraph;});
  assert.match(await page.locator('#relation-edge-list').innerText(),/current graph read failed/);
  assert.deepEqual(await page.evaluate(()=>({node:relationGraphState.nodes[0].displayName,error:relationGraphState.error,stale:multiLinkWorkspaceState.stale})),{node:'관계 항목 1',error:'current graph read failed',stale:true});
});

test('obsolete bundle visual rejection cannot replace a newer bundle success or failure', async t => {
  const page=await fixture(t);
  await page.evaluate(()=>{relationFolderFixture.bundleName='obsolete pending bundle';relationFolderFixture.deferBundleVisuals=true;window.oldVisualBundle=loadBundleGraph({query:'old'});});
  await page.waitForFunction(()=>relationFolderFixture.pendingVisuals?.length===1);
  assert.equal(await page.evaluate(()=>bundleGraphState.bundles[0].productName),'독립 세트');
  await page.evaluate(async()=>{relationFolderFixture.failBundleRead=true;await loadBundleGraph({query:'new'});});
  assert.match(await page.locator('#bundle-graph-list').innerText(),/current bundle read failed/);
  await page.evaluate(async()=>{relationFolderFixture.pendingVisuals.shift().reject(Error('obsolete bundle visual failure'));await window.oldVisualBundle;});
  assert.match(await page.locator('#bundle-graph-list').innerText(),/current bundle read failed/);
  assert.deepEqual(await page.evaluate(()=>({count:bundleGraphState.bundles.length,error:bundleGraphState.error,query:bundleGraphState.query})),{count:0,error:'current bundle read failed',query:'new'});
  await page.evaluate(()=>{relationFolderFixture.bundleName='OLD';relationFolderFixture.deferBundleVisuals=true;window.oldVisualBundle=loadBundleGraph({query:'OLD'});});
  await page.waitForFunction(()=>relationFolderFixture.pendingVisuals?.length===1);
  await page.evaluate(async()=>{relationFolderFixture.bundleName='NEW';relationFolderFixture.bundleQty=9;await loadBundleGraph({query:'NEW'});});
  await page.evaluate(async()=>{relationFolderFixture.pendingVisuals.shift().reject(Error('obsolete visual after success'));await window.oldVisualBundle;});
  assert.deepEqual(await page.evaluate(()=>({query:bundleGraphState.query,name:bundleGraphState.bundles[0].productName,qty:bundleGraphState.bundles[0].components[0].qty,error:bundleGraphState.error})),{query:'NEW',name:'NEW',qty:9,error:''});
  assert.match(await page.locator('#bundle-graph-list').innerText(),/NEW/);
  assert.equal(await page.locator('#bundle-graph-list [data-bundle-component-qty]').inputValue(),'9');
});

test('successful create plus failed reload retains the saved identity and retry only reloads, while a rejected save remains editable', async t => {
  const page=await fixture(t);await page.locator('#relation-folder-new').click();await page.locator('#relation-folder-name').fill('새 폴더');
  await page.evaluate(()=>{relationFolderFixture.failFolderReads=1;});await page.locator(save).click();
  await page.waitForFunction(()=>relationFolderFormState.savedPendingReload&&!relationFolderFormState.saving);
  assert.equal(await page.locator('#relation-folder-id').inputValue(),'99');assert.equal(await page.locator(form).isVisible(),true);
  assert.match(await page.locator('#relation-folder-form-status').innerText(),/폴더는 저장됐습니다/);
  assert.match(await page.locator(save).innerText(),/목록 다시 조회/);
  await page.locator(save).click();await settled(page);assert.equal(await page.locator(form).isHidden(),true);
  assert.equal(await page.evaluate(()=>relationFolderFixture.writes.filter(row=>row.method==='saveFolder').length),1);
  assert.equal(await page.locator(folder(99)).count(),1);
  await page.locator('#relation-folder-new').click();await page.locator('#relation-folder-name').fill('거절될 폴더');await page.evaluate(()=>{relationFolderFixture.failSave=true;});await page.locator(save).click();await settled(page);
  assert.equal(await page.locator(form).isVisible(),true);assert.equal(await page.locator('#relation-folder-name').inputValue(),'거절될 폴더');
  assert.match(await page.locator('#relation-folder-form-status').innerText(),/폴더 저장 실패: folder write rejected/);
  assert.equal(await page.locator(save).isEnabled(),true);
});

test('in-flight folder saves lock cancellation and other folder actions, then release controls after confirmation', async t => {
  const page=await fixture(t);await page.locator('#relation-folder-new').click();await page.locator('#relation-folder-name').fill('저장 대기');
  await page.evaluate(()=>{relationFolderFixture.deferSave=true;});await page.locator(save).click();await page.waitForFunction(()=>relationFolderFixture.pendingSaves.length===1);
  for(const selector of ['#relation-folder-cancel','#relation-folder-new',folder(1),'[data-folder-id="1"] [data-folder-edit]'])assert.equal(await page.locator(selector).isDisabled(),true);
  await page.locator('#relation-folder-cancel').dispatchEvent('click');assert.equal(await page.locator(form).isVisible(),true);
  await page.evaluate(()=>relationFolderFixture.pendingSaves.shift().resolve());await settled(page);
  assert.equal(await page.locator(form).isHidden(),true);assert.equal(await page.locator('#relation-folder-new').isEnabled(),true);
  assert.equal(await page.evaluate(()=>relationFolderFixture.writes.length),1);
});

test('folder filters leave canonical and seller-specific bundle searches and quantities intact', async t => {
  const page=await fixture(t);await page.locator(folder(1)).click();await settled(page);
  await page.locator('[data-multi-link-tab="bundle"]').click();await settled(page);
  assert.equal(await page.locator('#bundle-graph-list .bundle-component-row').count(),1);assert.equal(await page.locator('#bundle-graph-list [data-bundle-component-qty]').inputValue(),'2');
  await page.locator('#bundle-search').fill('SET-1');await page.locator('#bundle-search-form button[type="submit"]').click();await settled(page);
  assert.equal(await page.evaluate(()=>relationFolderFixture.calls.filter(row=>row.method==='bundles').at(-1).query),'SET-1');
  await page.locator('#bundle-target-seller').click();await page.locator('#seller-bundle-product-code').fill('SELLER-P');await page.locator('#seller-bundle-option-code').fill('O1');await page.locator('#seller-bundle-target-form button[type="submit"]').click();
  await page.waitForFunction(()=>sellerBundleState.target!==null&&!sellerBundleState.loading);
  assert.equal(await page.evaluate(()=>sellerBundleState.target.components[0].qty),3);
  assert.deepEqual(await page.evaluate(()=>relationFolderFixture.calls.filter(row=>row.method==='sellerBundle').at(-1).args),{source:'smartstore',query:'SELLER-P'});
  assert.equal(await page.evaluate(()=>relationFolderFixture.writes.length),0);
});

test('a committed relation with uncertain post-read reports refresh needed and preserves pending Matrix edits', async t => {
  const page=await fixture(t);await page.locator('[data-multi-link-tab="relation"]').click();await settled(page);
  await page.evaluate(()=>{pendingChanges.push({sku:'10001-1',field:'sellpia_purchase_price',after:60000});relationFolderFixture.mutationWarning=true;openRelationEdgeEditor(11);});
  await page.locator('#relation-edge-editor-child').selectOption('3');await page.locator('#relation-edge-editor-save').click();await settled(page);
  assert.equal(await page.evaluate(()=>relationFolderFixture.writes.filter(row=>row.method==='updateEdge').length),1);
  assert.deepEqual(await page.evaluate(()=>({pending:pendingChanges.length,after:pendingChanges[0].after,fullRead:matrixSourceReloadNeeded,edge:relationGraphState.edges.find(edge=>edge.edgeId===11).childNodeId})),{pending:1,after:60000,fullRead:true,edge:3});
  assert.match(await page.locator('#toast').innerText(),/수정했습니다.*화면 갱신이 필요/);
});
