import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(`${process.env.CODEX_NODE_MODULES}/medium-ui.cjs`),{chromium}=require('playwright');
const JSZip=require('jszip');
const cellStylesOnly=xml=>xml.replace(/(<c\b[^>]*?)\s+s="[^"]*"/g,'$1');
const withoutStockCells=(xml,source)=>cellStylesOnly(xml).replace(new RegExp(`<c\\b(?=[^>]*\\br="${source==='smartstore'?'S':'AG'}\\d+")[^>]*(?:\\/>|>[\\s\\S]*?<\\/c>)`,'g'),'');
function redReferences(xml,styles){
 const xfs=[...(styles.match(/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/)?.[1]||'').matchAll(/<xf\b[^>]*?(?:\/>|>[\s\S]*?<\/xf>)/g)].map(m=>m[0]);
 const fills=[...(styles.match(/<fills\b[^>]*>([\s\S]*?)<\/fills>/)?.[1]||'').matchAll(/<fill\b[^>]*>[\s\S]*?<\/fill>/g)].map(m=>m[0]);
 return [...xml.matchAll(/<c\b([^>]*?)(?:\/>|>[\s\S]*?<\/c>)/g)].filter(m=>{const style=Number(m[1].match(/\bs="(\d+)"/)?.[1]||0),fill=Number(xfs[style]?.match(/\bfillId="(\d+)"/)?.[1]||0);return fills[fill]?.includes('FFFFC7CE');}).map(m=>m[1].match(/\br="([^"]+)"/)?.[1]);
}
const root='mockups/operations-hub/',read=name=>fs.readFileSync(root+name+'.js','utf8');
const fixture=JSON.parse(fs.readFileSync('tests/fixtures/sellerMedium1181.json','utf8')).rows;
const app=read('app'),prepare=app.slice(app.indexOf('async function prepareStandardCarrierExport('),app.indexOf('async function prepareChangedOnlyExport('));
const methods=app.slice(app.indexOf('  async previewCarrier('),app.indexOf('  async run({source,skus=null,includeStock=false}'));
const browser=await chromium.launch({channel:'msedge',headless:true});
try{
 const page=await browser.newPage({viewport:{width:1600,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',route=>route.abort());
 await page.setContent('<main id="jobs"><div class="page-head">Medium carrier QA (mock read-only targets)</div></main>');
 for(const name of ['style','ui-scale-base','ui-cleanup-v1','seller-file-workflow-v2'])await page.addStyleTag({content:fs.readFileSync(root+name+'.css','utf8')});
 await page.addScriptTag({content:fs.readFileSync(require.resolve('jszip/dist/jszip.min.js'),'utf8')});
 await page.addScriptTag({content:await(await fetch('https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js')).text()});
 for(const name of ['discount-price-math','seller-source-parsers','seller-export-adapter','current-price-export','ably-stock-export','ably-playauto-export'])await page.addScriptTag({content:read(name)});
 await page.evaluate(rows=>{
  window.fixture=rows;window.downloads=[];window.ablyCatalog=[];window.ablyTargets=[];
  window.SystemV3Data={loadAuxiliarySellerFiles:async()=>({rows:[]}),loadLatestSellerOriginalStatus:async()=>[],loadCarrierSellerMappings:async({source})=>({rows:source==='ably'?[]:fixture.map(([sku,smartOption])=>({sku,product_code:source==='smartstore'?'7577001822':'38323',option_code:source==='smartstore'?smartOption:sku.split('-')[1]}))}),loadMatrixExportSnapshot:async()=>{throw Error('carrier must never request whole snapshot');},loadPlayautoSellpiaCatalog:async()=>ablyCatalog,loadCarrierMatrixTargets:async({source})=>({rows:source==='ably'?ablyTargets:fixture.map(([sku,smartOption,smartStock,makeStock])=>({sku,seller_stock:source==='smartstore'?smartStock:makeStock,active_price_rule:false}))})};
  window.SystemV3SellerExport={...SystemV3SellerExport,downloadBlob:(blob,name)=>downloads.push({blob,name})};
 },fixture);
 await page.addScriptTag({content:`const liveData=window.SystemV3Data,sellerExport=window.SystemV3SellerExport,formatNumber=value=>Number(value||0).toLocaleString('ko-KR');${prepare}\nwindow.SystemV3SellerExportBridge={${methods}};`});
 await page.addScriptTag({content:read('seller-file-workflow-v2')});
 for(const [source,env] of [['smartstore','SMARTSTORE_MEDIUM_SAMPLE'],['makeshop','MAKESHOP_MEDIUM_SAMPLE']]){
  for(let repeat=0;repeat<5;repeat++){
  await page.locator(`[data-standard-carrier-input="${source}"]`).setInputFiles(process.env[env]);
  await page.waitForFunction(source=>document.querySelector(`[data-standard-result="${source}"]`).textContent.includes('TransformationPlan'),source);
  assert.match(await page.locator(`[data-standard-result="${source}"]`).innerText(),/31/);
  const count=await page.evaluate(()=>downloads.length);await page.locator(`[data-standard-carrier-run="${source}"]`).click();
  await page.waitForFunction(count=>downloads.length>count,count);
  assert.ok(await page.evaluate(async()=>{const d=downloads.at(-1),p=await SystemV3SellerParsers.parseSellerFiles(d.name.startsWith('메')?'makeshop':'smartstore',[new File([d.blob],d.name)],{inventory:true,price:true});return p.normalizedRows.length===31;}));
  }
  console.log(source+': actual medium file preview -> XLSX 5/5 PASS (mock targets)');
  // Exercise warnings through the real UI/bridge/serializer, without writes or price recalculation.
  for(const mode of ['missing','error','stale']){
   await page.evaluate(({source,mode})=>{
    SystemV3Data.loadCarrierMatrixTargets=async({source:channel})=>({rows:fixture.map(([sku,smartOption,smartStock,makeStock],index)=>({sku,seller_stock:channel==='smartstore'?smartStock:makeStock,active_price_rule:index!==0?false:true,...(index===0&&mode==='error'?{registration_status:'error',registration_error:'statement timeout'}:{}),...(index===0&&mode==='stale'?{latest_generation_id:99,registration_price:4000,discount_price:4000,option_price:0,final_price:4000,registration_status:'calculated',discount_status:'calculated',option_status:'calculated',final_status:'calculated',registration_generation_id:98,discount_generation_id:98,option_generation_id:98,final_generation_id:98}:{})}))});
   },{source,mode});
   await page.locator(`[data-standard-carrier-input="${source}"]`).setInputFiles(process.env[env]);
   await page.waitForFunction(source=>document.querySelector(`[data-standard-result="${source}"]`).textContent.includes('원본 유지 경고 1'),source);
   assert.equal(await page.locator(`[data-standard-result="${source}"] .export-row-warning`).count(),1);
   assert.equal(await page.locator(`[data-standard-carrier-run="${source}"]`).getAttribute('aria-disabled'),'false');
   const count=await page.evaluate(()=>downloads.length);await page.locator(`[data-standard-carrier-run="${source}"]`).click();
   await page.waitForFunction(count=>downloads.length>count,count);
   const output=await page.evaluate(async count=>[...new Uint8Array(await downloads[count].blob.arrayBuffer())],count);
   const beforeZip=await JSZip.loadAsync(fs.readFileSync(process.env[env])),afterZip=await JSZip.loadAsync(Buffer.from(output));
   const beforeXml=await beforeZip.file('xl/worksheets/sheet1.xml').async('string'),afterXml=await afterZip.file('xl/worksheets/sheet1.xml').async('string');
    assert.equal(withoutStockCells(afterXml,source),withoutStockCells(beforeXml,source),source+' '+mode+' all non-stock cell values/formulas/text preserved; only stock and style IDs change');
   assert.ok(redReferences(afterXml,await afterZip.file('xl/styles.xml').async('string')).length>0,source+' warnings must be red INSIDE the same XLSX');
   for(const [name,entry] of Object.entries(beforeZip.files))if(!entry.dir&&!['xl/styles.xml','xl/worksheets/sheet1.xml'].includes(name))assert.deepEqual(await afterZip.file(name).async('uint8array'),await entry.async('uint8array'),source+' preserves '+name);
   assert.equal(await page.evaluate(()=>downloads.length),count+1,'never create a separate warning CSV');
  }
  // Restore normal scoped targets for the next seller and Ably round.
  await page.evaluate(()=>{SystemV3Data.loadCarrierMatrixTargets=async({source})=>({rows:source==='ably'?ablyTargets:fixture.map(([sku,smartOption,smartStock,makeStock])=>({sku,seller_stock:source==='smartstore'?smartStock:makeStock,active_price_rule:false}))});});
   console.log(source+': one active target missing/error/stale -> warning 1 -> same XLSX red cell/original values/no CSV PASS');
  // Ambiguity remains a file-level hard blocker, even though other options are safe.
  await page.evaluate(()=>{
   window.normalMappingReader=SystemV3Data.loadCarrierSellerMappings;
   SystemV3Data.loadCarrierSellerMappings=async args=>{const result=await normalMappingReader(args);return {...result,rows:[...result.rows,{...result.rows[0],sku:'ambiguous-other-sku'}]};};
  });
  await page.locator(`[data-standard-carrier-input="${source}"]`).setInputFiles(process.env[env]);
  await page.waitForFunction(source=>document.querySelector(`[data-standard-result="${source}"]`).textContent.includes('치명적 차단 1'),source);
  assert.equal(await page.locator(`[data-standard-result="${source}"] .export-row-blocker`).count(),1);
  const blockedCount=await page.evaluate(()=>downloads.length);await page.locator(`[data-standard-carrier-run="${source}"]`).click({force:true});
  assert.match(await page.locator(`[data-standard-result="${source}"]`).innerText(),/치명적 차단/);assert.equal(await page.evaluate(()=>downloads.length),blockedCount);
  await page.evaluate(()=>{SystemV3Data.loadCarrierSellerMappings=normalMappingReader;});
  // A target changed AFTER preview is not the same thing as a stale generation already in preview.
  await page.locator(`[data-standard-carrier-input="${source}"]`).setInputFiles(process.env[env]);
  await page.waitForFunction(source=>document.querySelector(`[data-standard-result="${source}"]`).textContent.includes('TransformationPlan')&&document.querySelector(`[data-standard-carrier-run="${source}"]`).getAttribute('aria-disabled')==='false',source);
  await page.evaluate(()=>{window.normalTargetReader=SystemV3Data.loadCarrierMatrixTargets;SystemV3Data.loadCarrierMatrixTargets=async args=>{const result=await normalTargetReader(args);return {...result,rows:result.rows.map((row,index)=>index?row:{...row,seller_stock:1000})};};});
  await page.locator(`[data-standard-carrier-run="${source}"]`).click();
  await page.waitForFunction(source=>document.querySelector(`[data-standard-result="${source}"]`).textContent.includes('가격/재고 상태가 변경되었습니다.'),source);
  assert.equal(await page.evaluate(()=>downloads.length),blockedCount);
  await page.evaluate(()=>{SystemV3Data.loadCarrierMatrixTargets=normalTargetReader;});
  console.log(source+': ambiguity hard blocker and post-preview target-change revalidation PASS');
 }
 if(process.env.ABLY_CARRIER_SAMPLE){
  const bytes=[...fs.readFileSync(process.env.ABLY_CARRIER_SAMPLE)];
  await page.evaluate(async bytes=>{
   const parsed=await AblyPlayautoExport.readTemplate(new File([new Uint8Array(bytes)],'ably-medium.xlsx'));
   ablyCatalog=parsed.items.map((item,index)=>({sellpia_sku_code:item.direct_sellpia_sku_code||item.sellpia_product_code+'-fixture-'+index,sellpia_product_code:item.sellpia_product_code,sellpia_option_name:item.primary_option_name}));
   ablyTargets=ablyCatalog.map((row,index)=>({sku:row.sellpia_sku_code,seller_stock:index%7,active_price_rule:false}));
  },bytes);
  await page.locator('[data-carrier-input="playauto_option"]').setInputFiles(process.env.ABLY_CARRIER_SAMPLE);
  await page.waitForFunction(()=>document.querySelector('[data-ably-progress]')?.dataset.state==='done');
  assert.match(await page.locator('#export-preview-counts').innerText(),/355/);
  assert.match(await page.locator('[data-ably-progress-detail]').innerText(),/parse \d+ms/);
  assert.ok(await page.locator('#export-preview-rows tr').count()<=100);
  if(process.env.CARRIER_QA_SCREENSHOT)await page.screenshot({path:process.env.CARRIER_QA_SCREENSHOT,fullPage:true});
  const count=await page.evaluate(()=>downloads.length);await page.locator('#export-preview-generate').click();
  await page.waitForFunction(count=>downloads.length>count,count);
  console.log('Ably browser phase timing:',await page.locator('[data-ably-progress-detail]').innerText());
  await page.evaluate(()=>{ablyTargets[0]={...ablyTargets[0],active_price_rule:true,registration_status:'error',registration_error:'statement timeout'};});
  await page.locator('[data-carrier-input="playauto_option"]').setInputFiles(process.env.ABLY_CARRIER_SAMPLE);
  await page.waitForFunction(()=>document.querySelector('[data-ably-progress]')?.dataset.state==='done');
  assert.match(await page.locator('#export-preview-counts').innerText(),/원본 유지 경고 1/);
  assert.equal(await page.locator('#export-preview-generate').isEnabled(),true);
  if(process.env.CARRIER_QA_SCREENSHOT)await page.screenshot({path:process.env.CARRIER_QA_SCREENSHOT,fullPage:true});
  const warningCount=await page.evaluate(()=>downloads.length);await page.locator('#export-preview-generate').click();
  await page.waitForFunction(count=>downloads.length>count,warningCount);
  const comparison=await page.evaluate(async({count,bytes})=>{
   const beforeZip=await JSZip.loadAsync(new Uint8Array(bytes)),afterZip=await JSZip.loadAsync(await downloads[count].blob.arrayBuffer());
   const cells=xml=>new Map([...xml.matchAll(/<c\b([^>]*?\br="([A-Z]+\d+)"[^>]*?)(?:\/>|>[\s\S]*?<\/c>)/g)].map(m=>[m[2],m[0]]));
   const before=cells(await beforeZip.file('xl/worksheets/sheet1.xml').async('string')),after=cells(await afterZip.file('xl/worksheets/sheet1.xml').async('string'));
   const parsed=await AblyPlayautoExport.readTemplate(new File([new Uint8Array(bytes)],'before.xlsx')),warnRow=parsed.items[0].source_row_no;
   const unexpected=[...before].filter(([ref,cell])=>!/^([VX])\d+$/.test(ref)&&after.get(ref)!==cell).map(([ref])=>ref);
   const removeStyle=cell=>cell?.replace(/(<c\b[^>]*?)\s+s="[^"]*"/,'$1');
   const warningChanges=[...before].filter(([ref,cell])=>new RegExp('^[A-Z]+'+warnRow+'$').test(ref)&&removeStyle(after.get(ref))!==removeStyle(cell)).map(([ref])=>ref);
   const output=await AblyPlayautoExport.readTemplate(new File([downloads[count].blob],'after.xlsx'));
   return {unexpected,warningChanges,rows:output.items.length,changes:[...before].filter(([ref,cell])=>after.get(ref)!==cell).length};
  },{count:warningCount,bytes});
  assert.deepEqual(comparison.unexpected,[]);assert.deepEqual(comparison.warningChanges,[]);assert.equal(comparison.rows,355);assert.ok(comparison.changes>0);
  const ablyOutput=await page.evaluate(async count=>[...new Uint8Array(await downloads[count].blob.arrayBuffer())],warningCount),ablyZip=await JSZip.loadAsync(Buffer.from(ablyOutput));
  const redCells=redReferences(await ablyZip.file('xl/worksheets/sheet1.xml').async('string'),await ablyZip.file('xl/styles.xml').async('string'));
  assert.equal(redCells.length,2);assert.ok(redCells.some(ref=>ref.startsWith('V')));assert.ok(redCells.some(ref=>ref.startsWith('X')));assert.equal(await page.evaluate(()=>downloads.length),warningCount+1);
  console.log('Ably actual 355 mixed warnings: warned V/X red with original values; safe X mutations; W/non-target cells unchanged; one XLSX PASS');
 }
 assert.deepEqual(errors,[]);console.log('Medium browser UI: actual Smartstore/Makeshop files -> automatic preview -> XLSX download PASS; Ably 355 preview/pagination/progress/download PASS (mock targets, network writes blocked).');
}finally{await browser.close();}
