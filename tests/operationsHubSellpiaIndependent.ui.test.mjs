import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {chromium} from 'playwright';

test('Sellpia UI requires the stored original carrier and separates counters and blocked rows',async()=>{
 const browser=await chromium.launch({channel:'msedge',headless:true});
 try{
  const page=await browser.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.setContent('<div id="export-workflow-v2"><div class="export-channel-grid"><article>SMARTSTORE</article></div></div>');
  await page.addScriptTag({path:process.env.XLSX_BROWSER_SCRIPT});
  await page.addScriptTag({path:'mockups/operations-hub/sellpia-patch-export.js'});
  await page.evaluate(()=>{
   window.downloads=[];window.carrierAvailable=false;
   const fixture=sku=>({sellpia_sku_code:sku,sellpia_source_sale_price:1000,system_base_price:1500,sellpia_source_stock:3,system_stock:4,__activeBaseOwner:true,__hubInternalPrices:{calculated_base_price:{value:1500,activeOutputRules:[{id:'R'}]}}});
   window.SystemV3Data={
    loadLatestSellpiaOriginalStatus:async()=>({snapshotId:'S1',available:carrierAvailable,fileNames:['original.xlsx'],reason:'최신 Sellpia 전체 스냅샷은 DB 행만 저장되어 원본 carrier 파일이 없습니다.'}),
    downloadLatestSellpiaOriginals:async()=>{if(!carrierAvailable)throw Error('최신 Sellpia 전체 스냅샷은 DB 행만 저장되어 원본 carrier 파일이 없습니다.');return {snapshotId:'S1',files:[new File(['x'],'original.xlsx')]};},
    loadSellpiaPatchRows:async args=>args.skus.map(fixture),
    loadTagCatalog:async()=>({rows:[]})
   };
   window.SystemV3SellpiaCarrierExport={
    prepare:async(_files,plan)=>({blocks:[{sku:'90000-2',field:'identity',before:'',reason:'carrier mismatch'}],priceChangeCount:1,stockChangeCount:1,purchaseChangeCount:0,warningSkuCount:0,warningIdentityCount:0,excludedIdentityCount:1,changedSkuCount:1}),
    build:async()=>({blob:new Blob(['carrier']),'name':'original_SystemV3반영.xlsx'})
   };
   window.SystemV3SellerExport={downloadBlob:(blob,name)=>downloads.push({blob:blob.size,name})};
   window.HubPriceMaterializer={materialize:async()=>({generationId:1,completedSkus:1,errorRows:0})};
   SellpiaPatchExport.mount();
  });
  assert.match(await page.locator('#sellpia-patch-status').innerText(),/DB 행만 저장/);
  await page.locator('#sellpia-patch-skus').fill('90000-1 90000-2');await page.locator('#sellpia-patch-preview-run').click();
  await page.waitForFunction(()=>document.querySelector('#sellpia-patch-status').textContent.includes('실패: 최신 Sellpia'));
  assert.equal(await page.locator('#sellpia-patch-download').isDisabled(),true);
  await page.evaluate(()=>carrierAvailable=true);await page.locator('#sellpia-patch-skus').fill('90000-1 90000-2');await page.locator('#sellpia-patch-preview-run').click();
  await page.waitForFunction(()=>document.querySelector('#sellpia-patch-status').textContent.includes('가격 변경 1'));
  assert.match(await page.locator('#sellpia-patch-status').innerText(),/재고 변경 1/);assert.match(await page.locator('#sellpia-patch-status').innerText(),/scope 제외 1/);
  assert.equal(await page.locator('#sellpia-patch-blocked-download').isDisabled(),false);assert.match(await page.locator('#sellpia-patch-preview').innerText(),/carrier mismatch/);
  await page.locator('#sellpia-patch-download').click();await page.waitForFunction(()=>downloads.length===1);assert.equal(await page.evaluate(()=>downloads[0].name),'original_SystemV3반영.xlsx');
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});

test('fingerprint timeout retry keeps all exact stamps; permission failures remain failures',async()=>{
 const code=fs.readFileSync('mockups/operations-hub/data-service.js','utf8'),calls=[];
 const context={fullMatrixReadContext:null,requireOperationsHubSessionToken:()=> 'operator',throwOperationsHubRpcError:error=>{if(error)throw Error(error.message);},db:{rpc:async(_name,args)=>{calls.push(args.p_skus);return args.p_skus.length>4?{error:{message:'canceling statement due to statement timeout'}}:{data:Object.fromEntries(args.p_skus.map(sku=>[sku,'exact-'+sku]))};}}};
 vm.createContext(context);vm.runInContext(code.slice(code.indexOf('  async function loadInputFingerprints('),code.indexOf('  async function loadSourceSnapshotPair(')),context);
 const skus=Array.from({length:57},(_,index)=>''+index),stamps=await context.loadInputFingerprints(skus,'');assert.equal(Object.keys(stamps).length,57);assert.ok(skus.every(sku=>stamps[sku]==='exact-'+sku));
 context.db.rpc=async()=>({error:{message:'permission denied'}});await assert.rejects(context.loadInputFingerprints(skus,''),/permission denied/);
});
