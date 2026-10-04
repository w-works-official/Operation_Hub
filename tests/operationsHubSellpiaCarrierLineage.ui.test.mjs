import test from 'node:test';
import assert from 'node:assert/strict';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');

test('Sellpia purchase export targets operational price and rejects a changed target before download',async()=>{
 const browser=await chromium.launch({channel:'msedge',headless:true});
 try{
  const page=await browser.newPage();
  await page.setContent('<div id="export-workflow-v2"><div class="export-channel-grid"></div></div>');
  await page.addScriptTag({path:'mockups/operations-hub/sellpia-patch-export.js'});
  await page.evaluate(()=>{
   window.stateId='PATCH';window.currentPurchase=35000;window.downloads=[];window.reads=[];
   window.SystemV3Data={
    loadLatestSellpiaOriginalStatus:async()=>({snapshotId:'FULL',stateSnapshotId:stateId,available:true,fileNames:['one.csv','two.csv','three.csv']}),
    downloadLatestSellpiaOriginals:async()=>({snapshotId:'FULL',stateSnapshotId:stateId,files:[new File(['carrier'],'one.csv')]}),
    loadSellpiaPatchRows:async args=>{reads.push(args);return args.skus.map(sku=>({sellpia_sku_code:sku,sellpia_source_purchase_price:30000,sellpia_purchase_price:currentPurchase}));}
   };
   window.SystemV3SellpiaCarrierExport={prepare:async()=>({blocks:[],priceChangeCount:0,stockChangeCount:0,purchaseChangeCount:1,warningSkuCount:0,warningIdentityCount:0,excludedIdentityCount:0,changedSkuCount:1}),build:async()=>({blob:new Blob(['ready']),name:'Sellpia.xlsx'})};
   window.SystemV3SellerExport={downloadBlob:(blob,name)=>downloads.push(name)};
   SellpiaPatchExport.mount();
  });
  await page.locator('[data-patch-field="base"]').uncheck();
  await page.locator('[data-patch-field="purchase"]').check();
  await page.locator('#sellpia-patch-skus').fill('5566-1');
  await page.locator('#sellpia-patch-preview-run').click();
  await page.waitForFunction(()=>document.querySelector('#sellpia-patch-status').textContent.includes('매입가 변경 1'));
  assert.match(await page.locator('#sellpia-patch-preview').innerText(),/30,?000|30000/);
  assert.match(await page.locator('#sellpia-patch-preview').innerText(),/35,?000|35000/);
  assert.equal(await page.evaluate(()=>reads[0].stateSnapshotId),'PATCH');
  await page.evaluate(()=>currentPurchase=36000);
  await page.locator('#sellpia-patch-download').click();
  await page.waitForFunction(()=>document.querySelector('#sellpia-patch-status').textContent.includes('미리보기를 다시'));
  assert.equal(await page.evaluate(()=>downloads.length),0);
  assert.equal(await page.locator('#sellpia-patch-download').isDisabled(),true);
  await page.locator('#sellpia-patch-preview-run').click();
  await page.waitForFunction(()=>document.querySelector('#sellpia-patch-status').textContent.includes('매입가 변경 1'));
  await page.evaluate(()=>stateId='PATCH2');
  await page.locator('#sellpia-patch-download').click();
  await page.waitForFunction(()=>document.querySelector('#sellpia-patch-status').textContent.includes('원본 또는 현재 상태가 변경'));
  assert.equal(await page.evaluate(()=>downloads.length),0,'a new PATCH must invalidate a preview even if the FULL carrier is unchanged');
 }finally{await browser.close();}
});
