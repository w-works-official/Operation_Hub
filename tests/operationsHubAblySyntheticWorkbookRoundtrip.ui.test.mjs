import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {createRequire} from 'node:module';
import {chromium} from 'playwright';

const require=createRequire(import.meta.url),JSZip=require('jszip');
const root=path.resolve('mockups/operations-hub'),fixturePath=path.resolve('tests/fixtures/ably/ably-price-projection-synthetic.xlsx');
const xlsxScript=process.env.XLSX_BROWSER_SCRIPT&&fs.existsSync(process.env.XLSX_BROWSER_SCRIPT)
 ?fs.readFileSync(process.env.XLSX_BROWSER_SCRIPT,'utf8')
 :await (await fetch('https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js')).text();
const fixture=fs.readFileSync(fixturePath);

function cells(xml){const result=new Map();for(const match of String(xml).matchAll(/<c\b[^>]*\br="([A-Z]+\d+)"[^>]*(?:\/>|>[\s\S]*?<\/c>)/g))result.set(match[1],match[0]);return result;}
function entryBytes(zip,name){return zip.file(name)?.async('nodebuffer');}
function caseItems(items,id){return items.filter(item=>item.caseId===id).sort((a,b)=>a.optionIndex-b.optionIndex);}

test('synthetic PlayAuto workbook survives preview-plan-write-reparse roundtrip with only intended I/T XML changes',async()=>{
 const browser=await chromium.launch({channel:'msedge',headless:true});
 try{
  const page=await browser.newPage();await page.setContent('<!doctype html><title>Ably synthetic workbook roundtrip</title>');
  await page.addScriptTag({content:xlsxScript});await page.addScriptTag({content:fs.readFileSync(require.resolve('jszip/dist/jszip.min.js'),'utf8')});
  for(const script of ['ably-stock-export.js','seller-export-adapter.js','ably-price-projection.js','ably-playauto-export.js'])await page.addScriptTag({path:path.join(root,script)});
  const results=await page.evaluate(async bytes=>{
   const original=new Uint8Array(bytes),makePolicy=(strategy,id)=>({tag_id:id,tag_name:id,strategy,document_id:'doc-'+id,document_version:3,active:true});
   async function run(priceMode){
    const file=new File([original],'ably-price-projection-synthetic.xlsx'),parsed=await AblyPlayautoExport.readTemplate(file);
    const prepared=parsed.items.map(item=>{
     const sku=item.direct_sellpia_sku_code||'',caseId=String(item.seller_management_code).replace(/^sellpia_CASE-/,''),selected=caseId==='C'?item.option_index===0:caseId==='I'?Boolean(sku):Boolean(sku);
     return {...item,caseId,resolution:sku?{sku,method:'direct_sku'}:{sku:null,method:'direct_sku_invalid',error:item.direct_sellpia_sku_error||'synthetic identity missing'},_inScope:selected,_status:'ready',_error:'',_changedFields:[]};
    });
    const targetFinalBySku=new Map(),byRow=new Map();for(const item of prepared){if(!byRow.has(item.source_row_no))byRow.set(item.source_row_no,[]);byRow.get(item.source_row_no).push(item);}
    for(const item of prepared.filter(item=>item._inScope)){
     let target=Number(item.base_price)+Number(item.option_price);
     if(item.caseId==='C')target=32000;if(item.caseId==='D'||['K','L','M'].includes(item.caseId))target=82000;if(item.caseId==='E')target=55000;
     if(!targetFinalBySku.has(item.resolution.sku)||item.caseId!=='D')targetFinalBySku.set(item.resolution.sku,target);
    }
    const policyByRow=new Map(),legacyRulesBaseBySku=new Map();
    for(const [rowNo,group] of byRow){
     const caseId=group[0].caseId;
     if(caseId==='B')policyByRow.set(rowNo,AblyPriceProjection.resolveCarrierPolicy({tagPolicies:[makePolicy('lower_middle','middle')]}));
     if(caseId==='E')policyByRow.set(rowNo,AblyPriceProjection.resolveCarrierPolicy({tagPolicies:[makePolicy('preserve_existing_base','preserve')]}));
     if(caseId==='O')policyByRow.set(rowNo,AblyPriceProjection.resolveCarrierPolicy({tagPolicies:[makePolicy('lowest','low'),makePolicy('lower_middle','middle')]}));
     if(caseId==='P')policyByRow.set(rowNo,AblyPriceProjection.resolveCarrierPolicy({tagPolicies:[makePolicy('lowest','low-a'),makePolicy('lowest','low-b')]}));
     if(caseId==='R')policyByRow.set(rowNo,AblyPriceProjection.resolveCarrierPolicy({tagPolicies:[{...makePolicy('lower_middle','inactive'),active:false}],fallbackStrategy:priceMode==='rules'?'legacy_rules':'lowest'}));
     if(priceMode==='rules'){
      const selected=group.filter(item=>item._inScope&&item.resolution?.sku),candidateFinals=group.map(item=>item._inScope&&item.resolution?.sku?targetFinalBySku.get(item.resolution.sku):Number(item.base_price)+Number(item.option_price)).filter(Number.isFinite),base=Math.min(...candidateFinals);
      for(const item of selected)legacyRulesBaseBySku.set(item.resolution.sku,base);
     }
    }
    AblyPriceProjection.projectProductRows(prepared,{priceMode,targetFinalBySku,policyByRow,legacyRulesBaseBySku,allowLowerMiddle:false});
    const writeItems=prepared.map(item=>({...item,
     target_base_price:item._status==='ready'&&Number(item.target_base_price)!==Number(item.base_price)?item.target_base_price:null,
     target_option_price:item._status==='ready'&&Number(item.target_option_price)!==Number(item.option_price)?item.target_option_price:null
    }));
    const blob=await AblyPlayautoExport.buildProductPriceOption(file,writeItems),outputFile=new File([blob],`output-${priceMode}.xlsx`),reparsed=await AblyPlayautoExport.readTemplate(outputFile);
    return {priceMode,bytes:Array.from(new Uint8Array(await blob.arrayBuffer())),planned:prepared.map(item=>({caseId:item.caseId,optionIndex:item.option_index,sku:item.resolution?.sku||'',status:item._status,error:item._error||'',oldBase:item.base_price,oldOption:item.option_price,targetBase:item.target_base_price??null,targetOption:item.target_option_price??null,targetFinal:item._projectionTargetFinal??null,policy:item._projection?.policy?.strategy||'',minDelta:item._projection?.minDelta??null})),reparsed:reparsed.items.map(item=>({caseId:String(item.seller_management_code).replace(/^sellpia_CASE-/,''),optionIndex:item.option_index,base:item.base_price,option:item.option_price,sku:item.direct_sellpia_sku_code||''}))};
   }
   return {source:await run('sellpia_source'),rules:await run('rules')};
  },Array.from(fixture));

  for(const result of [results.source,results.rules]){
   assert.deepEqual(caseItems(result.reparsed,'C').map(item=>item.base),[32000,32000,32000]);assert.deepEqual(caseItems(result.reparsed,'C').map(item=>item.option),[0,1500,7000]);
   assert.deepEqual(caseItems(result.reparsed,'D').map(item=>item.base),[82000,82000]);assert.deepEqual(caseItems(result.reparsed,'D').map(item=>item.option),[0,15000]);
   assert.deepEqual(caseItems(result.reparsed,'E').map(item=>[item.base,item.option]),[[50000,5000]]);
   for(const id of ['B','I','J','K','L','M','N1','N2','O'])assert.ok(caseItems(result.planned,id).every(item=>item.status==='conflict'),`${result.priceMode}/${id}`);
   assert.ok(caseItems(result.planned,'B').every(item=>item.policy==='lower_middle'&&item.minDelta<0));assert.match(caseItems(result.planned,'O')[0].error,/정책 충돌/);
   assert.ok(caseItems(result.planned,'P').every(item=>item.status==='ready'&&item.policy==='lowest'));
  }

  const beforeZip=await JSZip.loadAsync(fixture),afterZip=await JSZip.loadAsync(Buffer.from(results.source.bytes));
  assert.deepEqual(Object.keys(afterZip.files).sort(),Object.keys(beforeZip.files).sort(),'ZIP entry inventory must be preserved');
  for(const name of Object.keys(beforeZip.files).filter(name=>!beforeZip.files[name].dir&&!['xl/worksheets/sheet1.xml','xl/styles.xml'].includes(name))){
   assert.deepEqual(await entryBytes(afterZip,name),await entryBytes(beforeZip,name),`${name} must remain byte-identical after decompression`);
  }
  const beforeXml=(await beforeZip.file('xl/worksheets/sheet1.xml').async('string')),afterXml=(await afterZip.file('xl/worksheets/sheet1.xml').async('string'));
  assert.match(afterXml,/<pane\b[^>]*state="frozen"/);assert.match(afterXml,/<mergeCell ref="U1:V1"/);assert.match(afterXml,/<cols>/);
  const beforeCells=cells(beforeXml),afterCells=cells(afterXml);assert.deepEqual([...afterCells.keys()].sort(),[...beforeCells.keys()].sort());
  for(const [ref,xml] of beforeCells)if(!/^[IT]\d+$/.test(ref))assert.equal(afterCells.get(ref),xml,`${ref} must remain byte-identical`);
  for(const ref of ['J2','S2','J10','S10'])assert.match(afterCells.get(ref)||'',/<f>/,`${ref} formula must survive`);
  assert.notEqual(afterCells.get('I4'),beforeCells.get('I4'),'Case C I must change');assert.notEqual(afterCells.get('T4'),beforeCells.get('T4'),'Case C T must change');
  assert.equal((await afterZip.file('qa/fixture-manifest.json').async('string')),(await beforeZip.file('qa/fixture-manifest.json').async('string')));
 }finally{await browser.close();}
});
