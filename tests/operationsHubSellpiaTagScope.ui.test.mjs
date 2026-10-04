import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';

test('tag scope uses every authoritative assignment and revalidates before carrier download',async()=>{
 const browser=await chromium.launch({channel:'msedge',headless:true});
 try{
  const page=await browser.newPage();page.setDefaultTimeout(10000);
  await page.setContent('<select id="export-scope-mode"><option value="all">all</option><option value="tag">tag</option></select><select id="export-scope-tag"><option value="T">2.2</option></select><div id="export-workflow-v2"><div class="export-channel-grid"></div></div>');
  await page.addScriptTag({path:process.env.XLSX_BROWSER_SCRIPT});await page.addScriptTag({path:'mockups/operations-hub/sellpia-patch-export.js'});
  await page.evaluate(()=>{
   window.codes=Array.from({length:2690},(_,index)=>'SKU-'+index);window.memberReads=0;window.downloads=[];window.recalculations=[];
   window.SystemV3Data={
    loadTagCatalog:async()=>({rows:[{tag_id:'T',tag_name:'14K_실입고가_2.2배율',option_count:2690}]}),
    loadTagMembers:async args=>{memberReads++;return {rows:codes.slice((args.page-1)*1000,args.page*1000).map(sku=>({sellpia_sku_code:sku})),count:codes.length};},
    loadSellpiaPatchRows:async args=>args.skus.map(sku=>({sellpia_sku_code:sku,sellpia_source_stock:3,system_stock:4})),
    loadLatestSellpiaOriginalStatus:async()=>({snapshotId:'S1',available:true,fileNames:['source.csv']}),
    downloadLatestSellpiaOriginals:async()=>({snapshotId:'S1',files:[new File(['source'],'source.csv')]})
   };
   window.SystemV3SellpiaCarrierExport={prepare:async(_files,plan)=>({blocks:[],priceChangeCount:0,stockChangeCount:plan.values.length,purchaseChangeCount:0,warningSkuCount:0,warningIdentityCount:0,excludedIdentityCount:0,changedSkuCount:plan.values.length}),build:async()=>({blob:new Blob(['carrier']),name:'Sellpia_변경분.zip'})};
   window.SystemV3SellerExport={downloadBlob:(_blob,name)=>downloads.push(name)};
   window.HubPriceMaterializer={materialize:async args=>{recalculations.push(args);return {generationId:1,completedSkus:args.skus.length,errorRows:0};}};
   SellpiaPatchExport.mount();
  });
  await page.locator('#export-scope-mode').selectOption('tag');await page.waitForFunction(()=>document.querySelector('#sellpia-patch-tag').options.length===2);
  await page.locator('#export-scope-tag').selectOption('T');await page.waitForFunction(()=>document.querySelector('#sellpia-patch-tag').value==='T');
  assert.equal(await page.locator('#sellpia-patch-skus').isVisible(),false);
  await page.locator('[data-patch-field=base]').uncheck();await page.locator('[data-patch-field=stock]').check();await page.locator('#sellpia-patch-mode').selectOption('changed_only');
  await page.locator('#sellpia-patch-preview-run').click();await page.waitForFunction(()=>document.querySelector('#sellpia-patch-status').textContent.includes('2690 SKU'));
  assert.equal(await page.evaluate(()=>memberReads),3);await page.locator('#sellpia-patch-download').click();await page.waitForFunction(()=>downloads.length===1);assert.equal(await page.evaluate(()=>memberReads),6);
  await page.locator('#sellpia-patch-recalculate').click();await page.waitForFunction(()=>recalculations.length===1);assert.equal(await page.evaluate(()=>recalculations[0].boundedSkus.length),2690);
  await page.locator('#sellpia-patch-preview-run').click();await page.waitForFunction(()=>!document.querySelector('#sellpia-patch-download').disabled);await page.evaluate(()=>codes[2689]='CHANGED-1');
  await page.locator('#sellpia-patch-download').click();await page.waitForFunction(()=>document.querySelector('#sellpia-patch-status').textContent.includes('assignment가 변경'));assert.equal(await page.evaluate(()=>downloads.length),1);assert.equal(await page.locator('#sellpia-patch-download').isDisabled(),true);
 }finally{await browser.close();}
});
