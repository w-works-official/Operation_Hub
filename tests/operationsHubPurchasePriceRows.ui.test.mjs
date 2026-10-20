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
    rows[2].__hubInternalPrices={};
    const rule=(id,target_field,source_field,scope='')=>({id,name:id,target_field,source_field,scope,input_origin:'self',is_active:true,version:1,config:{steps:[]}});
    const rules=[rule('half','actual_inbound_cost','purchase_price'),rule('base','calculated_base_price','actual_inbound_cost'),
      rule('registration','platform_registration_price','calculated_base_price','smartstore'),
      rule('option','platform_option_price','platform_option_input','smartstore'),rule('final','platform_final_price','platform_final_input','smartstore'),
      rule('discount-only','platform_discount_price','platform_registration_price','smartstore')];
    const assignments=['A','B'].flatMap(sku=>rules.filter(rule=>rule.id!=='discount-only').map(rule=>({sku,rule_id:rule.id,scope:rule.scope,target_field:rule.target_field,version:1})));
    assignments.push({sku:'C',rule_id:'discount-only',scope:'smartstore',target_field:'platform_discount_price',version:1});
    const fresh=new Map(rows.map(row=>[row.sellpia_sku_code,structuredClone(row)]));
    const state=window.purchaseRowsFixture={fullReads:0,reads:[],saves:[],calculations:[],otherWrites:[],deferSave:false,releaseSave:null,failCalculation:false,deferRead:false,releaseRead:null,deferFullRead:false,releaseFullRead:null};
    state.registry={rules,assignments,dependencies:[]};state.products=fresh;
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
      ruleRegistry:async()=>structuredClone(state.registry),
      loadRulePlatformSiblings:async(skus,source)=>{
        const codes=new Set(skus.map(sku=>fresh.get(sku)?.[`${source}_product_code`]).filter(Boolean));
        return [...fresh.values()].filter(row=>codes.has(row[`${source}_product_code`])).map(row=>row.sellpia_sku_code);
      },
      loadPendingPurchasePriceRecalculations:async()=>({pendingCount:0,skus:[]}),loadOriginalUploadHistory:async()=>({rows:[],hasMore:false}),
      loadTagCatalog:async()=>({rows:[]}),loadSellerInventoryPolicies:async()=>[],loadPresets:async()=>[]};
    Object.defineProperty(window,'SystemV3Data',{configurable:true,get:()=>new Proxy(api,{get:(target,key)=>key in target?target[key]:/^(save|apply)/.test(String(key))?async(...args)=>{state.otherWrites.push({name:key,args});return {rows:[],count:0};}:async()=>({rows:[],count:0})}),set:()=>{}});
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
async function saveMatrixChanges(page) {
  await page.locator('#save-matrix-changes').click();
}

test('purchase edits wait for explicit Save, then patch dependent prices without reloading the full Matrix',async()=>{
  const fixture=await startFixture(),{page}=fixture;
  try{
    await editPurchase(page,'A',60000);
    await page.waitForTimeout(650);
    assert.equal(await page.evaluate(()=>purchaseRowsFixture.saves.length),0,'Enter commits a pending input without saving it');
    assert.equal(await page.evaluate(()=>purchaseRowsFixture.calculations.length),0,'calculation waits for explicit Save');
    await saveMatrixChanges(page);
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
    assert.equal(await page.locator('#matrix-body tr[data-sku="A"] [data-field-key="system_base_price"]').isDisabled(),true,'formula-owned output cannot edit the separate stored value');
    assert.deepEqual(fixture.errors,[]);
  }finally{await fixture.close();}
});

test('a newer pending purchase and a focused editor survive the previous save and dependent-row repaint',async()=>{
  const fixture=await startFixture(),{page}=fixture;
  try{
    await page.evaluate(()=>{purchaseRowsFixture.deferSave=true;});
    await editPurchase(page,'A',60000);
    await saveMatrixChanges(page);
    await page.waitForFunction(()=>Boolean(purchaseRowsFixture.releaseSave));
    await editPurchase(page,'A',70000);
    const editor=await editPurchase(page,'B',12345,{commit:false});
    await page.evaluate(()=>{window.focusedPurchaseEditor=document.activeElement;purchaseRowsFixture.releaseSave();});
    await page.waitForFunction(()=>HubMatrixClient.dataset.bySku.get('A').__hubInternalPrices.calculated_base_price.value===66000);
    await page.waitForTimeout(650);
    assert.equal(await editor.inputValue(),'12345');
    assert.equal(await page.evaluate(()=>document.activeElement===window.focusedPurchaseEditor),true,'the exact editor node remains connected and focused');
    assert.equal(await purchaseCell(page,'A').getAttribute('data-value'),'70000');
    assert.deepEqual(await page.evaluate(()=>purchaseRowsFixture.saves.map(changes=>changes[0].after)),['60000'],'later edits wait for a second explicit Save');
    assert.equal(await page.evaluate(()=>purchaseRowsFixture.fullReads),1);
    await editor.press('Escape');
    await saveMatrixChanges(page);
    await page.waitForFunction(()=>purchaseRowsFixture.saves.length===2&&HubMatrixClient.dataset.bySku.get('A').__hubInternalPrices.calculated_base_price.value===77000);
    assert.deepEqual(await page.evaluate(()=>purchaseRowsFixture.saves.map(changes=>changes[0].after)),['60000','70000']);
    assert.deepEqual(fixture.errors,[]);
  }finally{await fixture.close();}
});

test('calculation failure retains the saved purchase and refreshes its known affected rows',async()=>{
  const fixture=await startFixture(),{page}=fixture;
  try{
    await page.evaluate(()=>{purchaseRowsFixture.failCalculation=true;});
    await editPurchase(page,'A',60000);
    await saveMatrixChanges(page);
    await page.waitForFunction(()=>HubMatrixClient.dataset.bySku.get('B').__hubInternalPrices.calculated_base_price.error==='합성 계산 오류');
    assert.equal(await purchaseCell(page,'A').getAttribute('data-value'),'60000');
    assert.match(await page.locator('#matrix-body tr[data-sku="A"] [data-field-key="system_base_price"]').innerText(),/계산 오류/);
    await page.locator('#retry-matrix-calculation').waitFor({state:'visible'});
    assert.deepEqual(await page.evaluate(()=>purchaseRowsFixture.reads),[['A','B']]);
    assert.equal(await page.evaluate(()=>purchaseRowsFixture.fullReads),1);
    await editPurchase(page,'A',70000);
    assert.equal(await page.locator('#retry-matrix-calculation').isDisabled(),true,'new pending input must be saved or discarded before retrying an older saved scope');
    await page.locator('#discard-changes').click();
    assert.equal(await page.locator('#retry-matrix-calculation').isEnabled(),true,'discarding a newer input retains the unresolved saved calculation');
    assert.equal(await purchaseCell(page,'A').getAttribute('data-value'),'60000');
    await page.evaluate(()=>{purchaseRowsFixture.failCalculation=false;});
    await page.locator('#retry-matrix-calculation').click();
    await page.waitForFunction(()=>HubMatrixClient.dataset.bySku.get('A').__hubInternalPrices.calculated_base_price.value===66000);
    assert.equal(await page.evaluate(()=>purchaseRowsFixture.saves.length),1,'retry never rewrites the already saved purchase');
    assert.equal(await page.evaluate(()=>purchaseRowsFixture.calculations.length),2);
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
    await saveMatrixChanges(page);
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
    await saveMatrixChanges(page);
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
    await saveMatrixChanges(page);
    await page.waitForFunction(()=>HubMatrixClient.dataset.bySku.get('A').__hubInternalPrices.calculated_base_price.value===66000);
    await editPurchase(page,'A','');
    await saveMatrixChanges(page);
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

test('formula-owned price outputs reject forced edit paths while raw and unowned starting inputs stay editable',async()=>{
  const fixture=await startFixture(),{page}=fixture;
  try{
    await page.waitForFunction(()=>window.HubMatrixPriceEditPolicy?.ready===true);
    const base=page.locator('#matrix-body tr[data-sku="A"] [data-field-key="system_base_price"]');
    const inbound=page.locator('#matrix-body tr[data-sku="A"] [data-inbound-cost-edit]');
    const sellerBase=page.locator('#matrix-body tr[data-sku="A"] [data-source="smartstore"][data-price-component="base"]');
    assert.equal(await base.getAttribute('data-formula-locked'),'true');
    assert.equal(await base.isDisabled(),true);
    const shellBounds=await page.locator('.matrix-shell').boundingBox(),baseBounds=await base.boundingBox();
    assert.ok(baseBounds.x>=shellBounds.x&&baseBounds.x+baseBounds.width<=shellBounds.x+shellBounds.width,'formula markers must not move the sticky calculated price outside the visible Matrix');
    assert.match(await base.innerText(),/59,000/);
    assert.equal(await base.evaluate(element=>getComputedStyle(element.parentElement).position),'sticky');
    await page.evaluate(()=>document.getElementById('matrix-freeze-toggle').click());
    assert.equal(await base.evaluate(element=>getComputedStyle(element.parentElement).position),'static');
    const unfrozenX=(await base.boundingBox()).x;
    await page.locator('.matrix-shell').evaluate(element=>{element.scrollLeft=150;});
    assert.ok((await base.boundingBox()).x<unfrozenX-100,'an unfrozen formula cell moves with the normal horizontal table flow');
    await page.locator('.matrix-shell').evaluate(element=>{element.scrollLeft=0;});
    await page.evaluate(()=>document.getElementById('matrix-freeze-toggle').click());
    assert.equal(await inbound.isDisabled(),true,'intermediate actual inbound cost is a formula output');
    assert.equal(await sellerBase.isDisabled(),true);
    assert.equal(await page.locator('#matrix-body tr[data-sku="A"] [data-source="smartstore"][data-price-component="option"]').isDisabled(),true);
    assert.equal(await page.locator('#matrix-body tr[data-sku="A"] [data-source="smartstore"][data-price-component="final"]').isDisabled(),true);
    await base.dispatchEvent('dblclick');
    await page.evaluate(()=>{
      const cell=document.querySelector('#matrix-body tr[data-sku="A"] [data-field-key="system_base_price"]');
      selectMatrixCell(cell.closest('td'));
      const clipboardData=new DataTransfer();clipboardData.setData('text/plain','999999');
      document.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData}));
      const inbound=document.querySelector('#matrix-body tr[data-sku="A"] [data-inbound-cost-edit]');
      inbound.dispatchEvent(new MouseEvent('click',{bubbles:true}));
      const seller=document.querySelector('#matrix-body tr[data-sku="A"] [data-source="smartstore"][data-price-component="base"]');
      seller.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));
      seller.parentElement.querySelector('[data-price-edit]')?.dispatchEvent(new MouseEvent('click',{bubbles:true}));
      document.querySelector('#matrix-body tr[data-sku="A"] [data-discount-edit][data-source="smartstore"]')?.dispatchEvent(new MouseEvent('click',{bubbles:true}));
    });
    assert.equal(await page.locator('#matrix-body .inline-editor').count(),0);
    assert.equal(await page.locator('#inbound-cost-modal').isVisible(),false);
    assert.equal(await page.locator('#discount-editor-modal').isVisible(),false);
    assert.equal(await page.evaluate(()=>SystemV3MatrixEdits.getState().pendingCount),0,'forced paste cannot stage a locked calculation output');
    assert.equal(await page.evaluate(()=>purchaseRowsFixture.saves.length+purchaseRowsFixture.otherWrites.length),0);
    await page.evaluate(()=>{
      const row=HubMatrixClient.dataset.bySku.get('A');row.__hubInternalPrices.calculated_base_price.error='합성 계산 오류';renderLiveMatrixRows(matrixState.rows);
    });
    assert.equal(await base.isDisabled(),true,'a failed calculated value remains formula owned');
    assert.equal(await purchaseCell(page,'A').isEnabled(),true,'the purchase starting input remains writable');
    await editPurchase(page,'A',60000);
    assert.equal(await page.evaluate(()=>SystemV3MatrixEdits.getState().pendingCount),1);
    await page.locator('#discard-changes').click();

    const unowned=page.locator('#matrix-body tr[data-sku="C"] [data-field-key="system_base_price"]');
    assert.equal(await unowned.isEnabled(),true,'a stored base with no internal formula remains a starting input');
    await unowned.dblclick();await unowned.locator('input').press('Escape');
    const discountOnlyBase=page.locator('#matrix-body tr[data-sku="C"] [data-source="smartstore"][data-price-component="base"]');
    assert.equal(await discountOnlyBase.isEnabled(),true,'a discount-only rule does not own its registration-price starting input');
    await discountOnlyBase.dblclick();await discountOnlyBase.locator('input').press('Escape');
    assert.equal(await page.evaluate(()=>purchaseRowsFixture.saves.length+purchaseRowsFixture.otherWrites.length),0);
    assert.deepEqual(fixture.errors,[]);
  }finally{await fixture.close();}
});

test('a formula on one option locks shared product price outputs for an unassigned sibling',async()=>{
  const fixture=await startFixture(),{page}=fixture;
  try{
    await page.waitForFunction(()=>window.HubMatrixPriceEditPolicy?.ready===true);
    await page.evaluate(()=>{
      const state=purchaseRowsFixture;
      state.registry.assignments=state.registry.assignments.filter(assignment=>!(assignment.sku==='B'&&assignment.scope==='smartstore'));
      state.registry.assignments.push({sku:'A',rule_id:'discount-only',scope:'smartstore',target_field:'platform_discount_price',version:1});
      state.products.get('B').smartstore_product_code='P-A';
      HubMatrixClient.dataset.patch([{...HubMatrixClient.dataset.bySku.get('B'),smartstore_product_code:'P-A'}]);
      matrixState.rows=matrixState.rows.map(row=>HubMatrixClient.dataset.bySku.get(row.sellpia_sku_code)||row);
      HubMatrixPriceEditPolicy.setRegistry(state.registry);renderLiveMatrixRows(matrixState.rows);
    });
    for(const component of ['base','option','final']){
      const control=page.locator(`#matrix-body tr[data-sku="B"] [data-source="smartstore"][data-price-component="${component}"]`);
      if(component==='base'&&await control.count()===0)continue; // A merged product base is rendered once, on A.
      assert.equal(await control.isDisabled(),true,`${component} shares the formula-owned product price`);
      await control.dispatchEvent('dblclick');
    }
    const discount=page.locator('#matrix-body tr[data-sku="B"] [data-discount-edit][data-source="smartstore"]');
    if(await discount.count()){assert.equal(await discount.isDisabled(),true);await discount.dispatchEvent('click');}
    assert.equal(await page.locator('#matrix-body .inline-editor').count(),0);
    assert.equal(await page.locator('#discount-editor-modal').isVisible(),false);
    assert.equal(await page.locator('#matrix-body tr[data-sku="C"] [data-source="smartstore"][data-price-component="base"]').isEnabled(),true);
    assert.equal(await page.evaluate(()=>purchaseRowsFixture.saves.length+purchaseRowsFixture.otherWrites.length),0);
    assert.deepEqual(fixture.errors,[]);
  }finally{await fixture.close();}
});

test('Save rechecks a price that became formula owned after the input was staged',async()=>{
  const fixture=await startFixture(),{page}=fixture;
  try{
    const control=page.locator('#matrix-body tr[data-sku="C"] [data-field-key="system_base_price"]');
    await control.dblclick();await control.locator('input').fill('123000');await control.locator('input').press('Enter');
    assert.equal(await page.evaluate(()=>SystemV3MatrixEdits.getState().pendingCount),1);
    await page.evaluate(()=>{
      purchaseRowsFixture.registry.assignments.push({sku:'C',rule_id:'base',scope:'',target_field:'calculated_base_price',version:1});
      HubMatrixPriceEditPolicy.setRegistry(purchaseRowsFixture.registry);renderLiveMatrixRows(matrixState.rows);
    });
    await saveMatrixChanges(page);
    await page.waitForFunction(()=>SystemV3MatrixEdits.getState().error.includes('수식'));
    assert.equal(await page.evaluate(()=>purchaseRowsFixture.saves.length+purchaseRowsFixture.otherWrites.length),0,'the fresh ownership check runs before any DB input write');
    assert.equal(await page.evaluate(()=>purchaseRowsFixture.calculations.length),0);
    assert.equal(await page.evaluate(()=>SystemV3MatrixEdits.getState().pendingCount),1,'the blocked input stays reviewable until the operator discards it');
    assert.equal(await control.isDisabled(),true);
    assert.equal(await page.evaluate(()=>HubMatrixClient.dataset.bySku.get('C').system_base_price),80000);
    assert.deepEqual(fixture.errors,[]);
    await page.locator('#discard-changes').click();
  }finally{await fixture.close();}
});
