import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {chromium} from 'playwright';

async function startFixture() {
  const root=path.resolve('mockups/operations-hub');
  const server=http.createServer((request,response)=>{
    const file=path.resolve(root,'.'+decodeURIComponent(new URL(request.url,'http://localhost').pathname));
    if(!file.startsWith(root+path.sep)||!fs.existsSync(file)||fs.statSync(file).isDirectory()){response.writeHead(404).end();return;}
    const extension=path.extname(file);response.setHeader('Content-Type',extension==='.js'?'text/javascript':extension==='.css'?'text/css':'text/html');response.end(fs.readFileSync(file));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH}:process.platform==='win32'?{channel:'msedge'}:{})});
  const page=await browser.newPage({viewport:{width:1700,height:1000}});
  page.setDefaultTimeout(15000);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.route('https://**/*',route=>route.fulfill({contentType:'text/javascript',body:'window.supabase={createClient:()=>({rpc:async()=>({data:{}})})};'}));
  await page.addInitScript(()=>{
    const base=sku=>({sellpia_sku_code:sku,sellpia_product_name:'매입가 연쇄 계산',sellpia_option_name:sku,system_stock:10,system_base_price:80000,
      sellpia_purchase_price:53500,sellpia_source_purchase_price:53500,sellpia_source_sale_price:80000,sellpia_source_stock:10,
      smartstore_product_code:'P-'+sku,smartstore_option_code:'O-'+sku,smartstore_match_tier:'EXACT',smartstore_stock:10,smartstore_price:59000,
      smartstore_base_price:59000,smartstore_option_price:0,smartstore_final_price:59000,
      __hubInternalPrices:{actual_inbound_cost:{value:26750,activeOutputRules:[{id:'half'}]},calculated_base_price:{value:59000,activeOutputRules:[{id:'base'}]}},
      __hubActivePriceRules:{smartstore:true,makeshop:false,ably:false},
      __hubRulePrices:{smartstore:{platformBase:59000,platformOption:0,platformFinal:59000,platformDiscount:0,platformTerms:[],ruleNames:['가격 수식']}}});
    const rows=['A','B','C'].map(base);
    const fresh=new Map(rows.map(row=>[row.sellpia_sku_code,structuredClone(row)]));
    const state=window.purchaseRowsFixture={fullReads:0,reads:[],saves:[],calculations:[],deferSave:false,releaseSave:null,failCalculation:false,deferRead:false,releaseRead:null,deferFullRead:false,releaseFullRead:null};
    const clone=skus=>skus.map(sku=>structuredClone(fresh.get(sku))).filter(Boolean);
    const expiresAt=new Date(Date.now()+3600000).toISOString();
    sessionStorage.setItem('system-v3-operations-session-v1',JSON.stringify({token:'a'.repeat(64),expiresAt}));
    const api={mode:'live',pageSize:200,setOperationsHubSessionToken:()=>{},checkOperationsHubSession:async()=>({authenticated:true,expiresAt}),loginOperationsHub:async()=>({authenticated:true,expiresAt}),logoutOperationsHub:async()=>{},
      loadMatrixGridDataset:async()=>{
        state.fullReads++;const result={rows:clone([...fresh.keys()]),count:rows.length,elapsed:1,metrics:{requests:1,bytes:1}};
        if(state.deferFullRead){state.deferFullRead=false;await new Promise(resolve=>state.releaseFullRead=()=>{state.releaseFullRead=null;resolve();});}
        return result;
      },
      loadMatrixGridRowsBySkus:async skus=>{
        state.reads.push([...skus]);const result=clone(skus);
        if(state.deferRead){state.deferRead=false;await new Promise(resolve=>state.releaseRead=()=>{state.releaseRead=null;resolve();});}
        return result;
      },
      saveSellpiaChanges:async changes=>{
        state.saves.push(structuredClone(changes));
        if(state.deferSave){state.deferSave=false;await new Promise(resolve=>state.releaseSave=()=>{state.releaseSave=null;resolve();});}
        for(const change of changes){
          const row=fresh.get(change.sku);
          row[change.fieldKey]=change.after===''&&change.fieldKey==='sellpia_purchase_price'?row.sellpia_source_purchase_price:change.after===''?null:Number(change.after);
        }
        return {savedCount:changes.length,queuedCount:0,systemRows:clone([...new Set(changes.map(change=>change.sku))])};
      },
      loadMappingSyncStatus:async()=>({}),loadSourceStatus:async()=>({events:[],latest:{}}),loadDashboardMetrics:async()=>({total_sku:rows.length}),
      loadPendingPurchasePriceRecalculations:async()=>({pendingCount:0,skus:[]}),loadOriginalUploadHistory:async()=>({rows:[],hasMore:false}),
      loadTagCatalog:async()=>({rows:[]}),loadSellerInventoryPolicies:async()=>[],loadPresets:async()=>[]};
    Object.defineProperty(window,'SystemV3Data',{configurable:true,get:()=>new Proxy(api,{get:(target,key)=>key in target?target[key]:async()=>({rows:[],count:0})}),set:()=>{}});
    Object.defineProperty(window,'HubPriceMaterializer',{configurable:true,get:()=>({materialize:async request=>{
      state.calculations.push(structuredClone(request));
      const purchase=Number(fresh.get('A').sellpia_purchase_price),inbound=purchase/2,price=Math.round(inbound*2.2);
      for(const [sku,value] of [['A',price],['B',price+1000]]){
        const row=fresh.get(sku);row.__hubInternalPrices={actual_inbound_cost:{value:inbound,activeOutputRules:[{id:'half'}]},calculated_base_price:{value,activeOutputRules:[{id:'base'}]}};
        row.__hubRulePrices.smartstore={platformBase:value,platformOption:0,platformFinal:value,platformDiscount:0,platformTerms:[],ruleNames:['가격 수식']};
        if(state.failCalculation){row.__hubInternalPrices.calculated_base_price={value:null,error:'합성 계산 오류',activeOutputRules:[{id:'base'}]};}
      }
      if(state.failCalculation)throw Object.assign(Error('합성 계산 오류'),{affectedSkus:['A','B']});
      return {status:'complete',affectedSkus:['A','B'],persistedRows:4,errorRows:0};
    }}),set:()=>{}});
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/index.html`);
  await page.locator('[data-page="matching"]').first().click();
  await page.waitForFunction(()=>window.HubMatrixClient?.dataset?.rows.length===3&&document.querySelectorAll('#matrix-body tr[data-sku]').length===3);
  await page.evaluate(()=>{window.untouchedPurchaseRow=HubMatrixClient.dataset.bySku.get('C');});
  return {page,errors,async close(){await browser.close();await new Promise(resolve=>server.close(resolve));}};
}

const purchaseCell=(page,sku)=>page.locator(`#matrix-body tr[data-sku="${sku}"] [data-field-key="sellpia_purchase_price"]`);
async function editPurchase(page,sku,value,{commit=true}={}) {
  await purchaseCell(page,sku).dblclick();
  const editor=purchaseCell(page,sku).locator('input');await editor.fill(String(value));
  if(commit)await editor.press('Enter');
  return editor;
}

test('purchase autosave patches its row and dependent prices without reloading the full Matrix',async()=>{
  const fixture=await startFixture(),{page}=fixture;
  try{
    await editPurchase(page,'A',60000);
    await page.waitForFunction(()=>HubMatrixClient.dataset.bySku.get('B').__hubInternalPrices.calculated_base_price.value===67000);
    assert.equal(await purchaseCell(page,'A').getAttribute('data-value'),'60000');
    assert.match(await page.locator('#matrix-body tr[data-sku="A"] [data-field-key="system_base_price"]').innerText(),/66,000/);
    assert.match(await page.locator('#matrix-body tr[data-sku="B"] [data-field-key="system_base_price"]').innerText(),/67,000/);
    assert.equal(await page.locator('#matrix-body tr[data-sku="A"] [data-source="smartstore"][data-price-component="base"]').getAttribute('data-value'),'66000');
    assert.equal(await page.locator('#matrix-body tr[data-sku="B"] [data-source="smartstore"][data-price-component="base"]').getAttribute('data-value'),'67000');
    assert.deepEqual(await page.evaluate(()=>purchaseRowsFixture.calculations[0].sources),['smartstore','makeshop','ably'],'normal edits refresh the bounded linked platform tuples as well as internal prices');
    assert.deepEqual(await page.evaluate(()=>purchaseRowsFixture.reads),[['A','B']]);
    assert.equal(await page.evaluate(()=>purchaseRowsFixture.fullReads),1);
    assert.equal(await page.evaluate(()=>HubMatrixClient.dataset.bySku.get('C')===untouchedPurchaseRow),true);
    assert.equal(await page.locator('#matrix-body tr[data-sku="A"] [data-field-key="system_base_price"]').isEnabled(),true,'formula output still permits editing the separate stored base value');
    assert.deepEqual(fixture.errors,[]);
  }finally{await fixture.close();}
});

test('a newer pending purchase and a focused editor survive the previous save and dependent-row repaint',async()=>{
  const fixture=await startFixture(),{page}=fixture;
  try{
    await page.evaluate(()=>{purchaseRowsFixture.deferSave=true;});
    await editPurchase(page,'A',60000);
    await page.waitForFunction(()=>Boolean(purchaseRowsFixture.releaseSave));
    await editPurchase(page,'A',70000);
    const editor=await editPurchase(page,'B',12345,{commit:false});
    await page.evaluate(()=>{window.focusedPurchaseEditor=document.activeElement;purchaseRowsFixture.releaseSave();});
    await page.waitForFunction(()=>purchaseRowsFixture.saves.length===2&&HubMatrixClient.dataset.bySku.get('A').__hubInternalPrices.calculated_base_price.value===77000);
    assert.equal(await editor.inputValue(),'12345');
    assert.equal(await page.evaluate(()=>document.activeElement===window.focusedPurchaseEditor),true,'the exact editor node remains connected and focused');
    assert.equal(await purchaseCell(page,'A').getAttribute('data-value'),'70000');
    assert.deepEqual(await page.evaluate(()=>purchaseRowsFixture.saves.map(changes=>changes[0].after)),['60000','70000']);
    assert.equal(await page.evaluate(()=>purchaseRowsFixture.fullReads),1);
    await editor.press('Escape');
    assert.deepEqual(fixture.errors,[]);
  }finally{await fixture.close();}
});

test('calculation failure retains the saved purchase and refreshes its known affected rows',async()=>{
  const fixture=await startFixture(),{page}=fixture;
  try{
    await page.evaluate(()=>{purchaseRowsFixture.failCalculation=true;});
    await editPurchase(page,'A',60000);
    await page.waitForFunction(()=>HubMatrixClient.dataset.bySku.get('B').__hubInternalPrices.calculated_base_price.error==='합성 계산 오류');
    assert.equal(await purchaseCell(page,'A').getAttribute('data-value'),'60000');
    assert.match(await page.locator('#matrix-body tr[data-sku="A"] [data-field-key="system_base_price"]').innerText(),/계산 오류/);
    await page.waitForFunction(()=>document.getElementById('toast').textContent.includes('기준값은 저장됐지만'));
    assert.deepEqual(await page.evaluate(()=>purchaseRowsFixture.reads),[['A','B']]);
    assert.equal(await page.evaluate(()=>purchaseRowsFixture.fullReads),1);
    assert.deepEqual(fixture.errors,[]);
  }finally{await fixture.close();}
});

test('an older scoped read cannot overwrite a newer read or its pending input',async()=>{
  const fixture=await startFixture(),{page}=fixture;
  try{
    await page.evaluate(()=>{purchaseRowsFixture.deferRead=true;window.oldPurchaseRead=refreshMatrixSkus(['A']);});
    await page.waitForFunction(()=>Boolean(purchaseRowsFixture.releaseRead));
    await page.evaluate(()=>{purchaseRowsFixture.deferSave=true;});
    await editPurchase(page,'A',60000);
    await page.waitForFunction(()=>Boolean(purchaseRowsFixture.releaseSave));
    await page.evaluate(async()=>{await refreshMatrixSkus(['A']);purchaseRowsFixture.releaseRead();await window.oldPurchaseRead;});
    assert.equal(await purchaseCell(page,'A').getAttribute('data-value'),'60000','the in-flight manual input overlays the older DB projection');
    await page.evaluate(()=>purchaseRowsFixture.releaseSave());
    await page.waitForFunction(()=>HubMatrixClient.dataset.bySku.get('A').__hubInternalPrices.calculated_base_price.value===66000);
    assert.equal(await purchaseCell(page,'A').getAttribute('data-value'),'60000');
    assert.equal(await page.evaluate(()=>purchaseRowsFixture.fullReads),1);
    assert.deepEqual(fixture.errors,[]);
  }finally{await fixture.close();}
});

test('discarding a pending purchase restores the authoritative cached DB value after an overlapping read',async()=>{
  const fixture=await startFixture(),{page}=fixture;
  try{
    await page.evaluate(async()=>{
      const cell=document.querySelector('#matrix-body tr[data-sku="A"] [data-field-key="sellpia_purchase_price"]');
      commitEditableCellValue(cell,'60000');
      clearTimeout(sellpiaAutosaveTimer);sellpiaAutosaveTimer=null;
      await refreshMatrixSkus(['A']);
    });
    assert.equal(await purchaseCell(page,'A').getAttribute('data-value'),'60000','the pending input stays visible');
    assert.equal(await page.evaluate(()=>HubMatrixClient.dataset.bySku.get('A').sellpia_purchase_price),53500,'render overlays never enter the authoritative dataset');
    await page.locator('#discard-changes').click();
    await page.waitForFunction(()=>document.querySelector('#matrix-body tr[data-sku="A"] [data-field-key="sellpia_purchase_price"]')?.dataset.value==='53500');
    assert.equal(await page.evaluate(()=>purchaseRowsFixture.saves.length),0);
    assert.equal(await page.evaluate(()=>purchaseRowsFixture.fullReads),1,'discard can safely reuse the DB projection already in memory');
    assert.deepEqual(fixture.errors,[]);
  }finally{await fixture.close();}
});

test('a late full feed cannot undo a purchase save that finished while the feed was in flight',async()=>{
  const fixture=await startFixture(),{page}=fixture;
  try{
    await page.evaluate(()=>{purchaseRowsFixture.deferFullRead=true;window.pendingFullMatrixRead=loadLiveMatrix({fullReload:true});});
    await page.waitForFunction(()=>Boolean(purchaseRowsFixture.releaseFullRead));
    await editPurchase(page,'A',60000);
    await page.waitForFunction(()=>HubMatrixClient.dataset.bySku.get('B').__hubInternalPrices.calculated_base_price.value===67000);
    assert.equal(await page.evaluate(()=>HubMatrixClient.affected.has('A')),true,'the saved row stays dirty until the older full read settles');
    await page.evaluate(async()=>{purchaseRowsFixture.releaseFullRead();await window.pendingFullMatrixRead;});
    assert.equal(await purchaseCell(page,'A').getAttribute('data-value'),'60000');
    assert.equal(await page.evaluate(()=>HubMatrixClient.dataset.bySku.get('A').__hubInternalPrices.calculated_base_price.value),66000);
    assert.equal(await page.locator('#matrix-body tr[data-sku="A"] [data-source="smartstore"][data-price-component="base"]').getAttribute('data-value'),'66000');
    assert.equal(await page.evaluate(()=>HubMatrixClient.dataset.bySku.get('B').__hubInternalPrices.calculated_base_price.value),67000);
    assert.deepEqual(await page.evaluate(()=>purchaseRowsFixture.reads),[['A','B'],['A','B']],'bootstrap re-reads only the saved and immediately related rows');
    assert.equal(await page.evaluate(()=>purchaseRowsFixture.fullReads),2,'the second full read is the explicit user refresh only');
    assert.equal(await page.evaluate(()=>HubMatrixClient.affected.size),0);
    assert.deepEqual(fixture.errors,[]);
  }finally{await fixture.close();}
});

test('clearing a purchase override displays the normalized DB fallback and its recalculated prices',async()=>{
  const fixture=await startFixture(),{page}=fixture;
  try{
    await editPurchase(page,'A',60000);
    await page.waitForFunction(()=>HubMatrixClient.dataset.bySku.get('A').__hubInternalPrices.calculated_base_price.value===66000);
    await editPurchase(page,'A','');
    await page.waitForFunction(()=>HubMatrixClient.dataset.bySku.get('A').__hubInternalPrices.calculated_base_price.value===58850);
    assert.equal(await purchaseCell(page,'A').getAttribute('data-value'),'53500','the saved empty override is replaced by the authoritative effective source fallback');
    assert.match(await purchaseCell(page,'A').innerText(),/53,500/);
    assert.equal(await page.evaluate(()=>HubMatrixClient.dataset.bySku.get('A').sellpia_purchase_price),53500);
    assert.equal(await page.locator('#matrix-body tr[data-sku="A"] [data-source="smartstore"][data-price-component="base"]').getAttribute('data-value'),'58850');
    assert.deepEqual(await page.evaluate(()=>purchaseRowsFixture.saves.map(changes=>changes[0].after)),['60000','']);
    assert.equal(await page.evaluate(()=>purchaseRowsFixture.fullReads),1);
    assert.deepEqual(fixture.errors,[]);
  }finally{await fixture.close();}
});
