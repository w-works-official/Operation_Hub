import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import {chromium} from 'playwright';

const modulePath=path.resolve('mockups/operations-hub/ably-mapping-management.js');
const browserOptions={headless:true,...(process.env.PLAYWRIGHT_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH}:process.platform==='win32'?{channel:'msedge'}:{})};
const header=['상품 번호','옵션 번호','기타','(신) 솔루션사 고유코드 (셀피아코드)','재고수량','안전재고'];

test('Ably mapping panel invalidates stale previews and imports the selected file snapshot once',{timeout:60_000},async()=>{
  const browser=await chromium.launch(browserOptions);
  try{
    const page=await browser.newPage();
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.setContent('<!doctype html><html><body><div id="ably-mapping-management"></div></body></html>');
    await page.evaluate(({header})=>{
      const matrixByKey={
        A:[header,['PRODUCT-A','OPTION-A','','sellpia_SKU-A',5,0]],
        B:[header,['PRODUCT-B','OPTION-B','','sellpia_SKU-B',8,1]]
      };
      window.XLSX={read(buffer){const key=new TextDecoder().decode(buffer).trim();return {SheetNames:[key],Sheets:{[key]:{key}}};},utils:{sheet_to_json(sheet){return matrixByKey[sheet.key];}}};
      Object.defineProperty(window.crypto,'subtle',{configurable:true,value:{async digest(_algorithm,buffer){const bytes=new Uint8Array(buffer),mark=bytes[0]===66?0xbb:0xaa;return new Uint8Array(32).fill(mark).buffer;}}});
      let resolveA;
      window.mappingTest={contextCalls:[],importCalls:[],loadCalls:0,resolveA:null,resolveImport:null,deferNextA:false};
      const contextFor=(rows)=>({manualMappings:[{product_code:rows[0].product_code,option_code:rows[0].option_code,sellpia_sku_code:rows[0].solution_code.slice(8),mapping_origin:'manual'}],matrixStock:{[rows[0].solution_code.slice(8)]:rows[0].source_stock},suppressions:[]});
      window.SystemV3Data={
        async loadAblyInventoryMappings(){mappingTest.loadCalls++;return {rows:[{product_code:'SAVED-PRODUCT',option_code:'SAVED-OPTION',solution_code:'sellpia_SAVED-SKU',sellpia_sku_code:'SAVED-SKU',mapping_state:'verified',stock_policy:'shared',is_active:true,review_reasons:[]}]};},
        async loadAblyInventoryMappingContext({rows}){const key=rows[0].product_code==='PRODUCT-A'?'A':'B';mappingTest.contextCalls.push({key,rows:structuredClone(rows)});if(key==='A'&&mappingTest.deferNextA){mappingTest.deferNextA=false;return await new Promise(resolve=>{resolveA=resolve;mappingTest.resolveA=()=>resolve(contextFor(rows));});}return contextFor(rows);},
        async importAblyInventoryMappings(args){mappingTest.importCalls.push(structuredClone(args));return await new Promise(resolve=>{mappingTest.resolveImport=resolve;});},
        async updateAblyInventoryMapping(){throw new Error('mapping edit is outside this test');}
      };
    },{header});
    await page.addScriptTag({path:modulePath});
    await page.waitForFunction(()=>document.querySelector('#ably-map-rows')?.textContent.includes('SAVED-PRODUCT'));
    assert.equal(await page.evaluate(()=>mappingTest.loadCalls),1,'initial server list loads after mount');

    const fileInput=page.locator('#ably-map-file'),preview=page.locator('#ably-map-preview'),importButton=page.locator('#ably-map-import');
    await fileInput.setInputFiles({name:'A.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:Buffer.from('A')});
    await preview.click();
    await page.waitForFunction(()=>document.querySelector('#ably-map-status')?.textContent.includes('A.xlsx')&&document.querySelector('#ably-map-import')?.disabled===false);
    assert.match(await page.locator('#ably-map-rows').textContent(),/PRODUCT-A/,'first preview is rendered');

    await page.evaluate(()=>{mappingTest.deferNextA=true;});
    await preview.click();
    await page.waitForFunction(()=>Boolean(mappingTest.resolveA),'second preview of the old file is pending');
    await fileInput.setInputFiles({name:'B.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:Buffer.from('B')});
    assert.equal(await importButton.isDisabled(),true,'changing the selected file invalidates the previously completed preview immediately');
    await preview.click();
    await page.waitForFunction(()=>document.querySelector('#ably-map-status')?.textContent.includes('B.xlsx')&&document.querySelector('#ably-map-import')?.disabled===false);
    assert.match(await page.locator('#ably-map-rows').textContent(),/PRODUCT-B/,'new file preview is rendered');

    await page.evaluate(()=>mappingTest.resolveA());
    await page.waitForTimeout(20);
    assert.match(await page.locator('#ably-map-status').textContent(),/B\.xlsx/,'late result from the previous file cannot replace current preview status');
    assert.match(await page.locator('#ably-map-rows').textContent(),/PRODUCT-B/,'late previous preview cannot replace the new file rows');
    assert.doesNotMatch(await page.locator('#ably-map-rows').textContent(),/PRODUCT-A/);

    await importButton.click();
    await page.waitForFunction(()=>mappingTest.importCalls.length===1,'captured file reaches server adapter');
    const call=await page.evaluate(()=>mappingTest.importCalls[0]);
    assert.equal(call.fileName,'B.xlsx');
    assert.equal(call.sha256,'bb'.repeat(32),'SHA-256 must be calculated from the captured selected file bytes');
    assert.equal(call.batchKey,call.sha256);
    assert.deepEqual(call.rows.map(row=>[row.product_code,row.option_code,row.solution_code,row.source_stock]),[['PRODUCT-B','OPTION-B','sellpia_SKU-B',8]],'rows passed for import match the file hashed for import');
    assert.equal(await fileInput.isDisabled(),true,'file changes are locked during import');
    assert.equal(await preview.isDisabled(),true,'preview controls are locked during import');
    assert.equal(await importButton.isDisabled(),true,'import button is locked during import');
    await importButton.evaluate(button=>button.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true})));
    await page.waitForTimeout(30);
    assert.equal(await page.evaluate(()=>mappingTest.importCalls.length),1,'double click cannot dispatch a second import');

    await page.evaluate(()=>mappingTest.resolveImport({inserted:1,verified:1,review:0,conflict:0}));
    await page.waitForFunction(()=>document.querySelector('#ably-map-status')?.textContent.includes('저장 완료'));
    assert.equal(await page.evaluate(()=>mappingTest.importCalls.length),1);
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});
