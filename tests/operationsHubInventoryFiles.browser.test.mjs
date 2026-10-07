import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {createRequire} from 'node:module';

assert.ok(process.env.CODEX_NODE_MODULES,'CODEX_NODE_MODULES must point to the bundled runtime dependencies');
const nodeModules=process.env.CODEX_NODE_MODULES;
const require=createRequire(path.join(nodeModules,'operations-hub-inventory-files.cjs'));
const {chromium}=require('playwright');
const JSZip=require('jszip');
const root=new URL('../mockups/operations-hub/',import.meta.url);
const vendor=process.env.XLSX_BROWSER_SCRIPT||path.resolve('work/inventory-qa/xlsx.full.min.js');

test('three seller channels produce separate stock-only XLSX files from synthetic inputs',async()=>{
  assert.ok(fs.existsSync(vendor),`SheetJS browser bundle not found: ${vendor}`);
  const browser=await chromium.launch({channel:'msedge',headless:true});
  try{
    const page=await browser.newPage();
    await page.route('**/*',route=>route.abort());
    await page.setContent('<!doctype html><title>Offline inventory XLSX contract</title>');
    await page.addScriptTag({content:fs.readFileSync(vendor,'utf8')});
    await page.addScriptTag({content:fs.readFileSync(require.resolve('jszip/dist/jszip.min.js'),'utf8')});
    for(const name of [
      'seller-source-parsers.js','sellpia-inventory-count.js','current-price-export.js',
      'seller-export-adapter.js','ably-stock-export.js','ably-playauto-export.js'
    ]) await page.addScriptTag({content:fs.readFileSync(new URL(name,root),'utf8')});

    const results=await page.evaluate(async()=>{
      const makeWorkbook=(sheetName,rows)=>{
        const book=XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet(rows),sheetName);
        const bytes=XLSX.write(book,{bookType:'xlsx',type:'array'});
        return new File([bytes],`${sheetName}.xlsx`,{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
      };
      const rowsOf=async file=>{
        const book=XLSX.read(await file.arrayBuffer(),{type:'array',raw:true});
        return XLSX.utils.sheet_to_json(book.Sheets[book.SheetNames[0]],{header:1,raw:true,defval:null});
      };
      const fixed=(row,width)=>Array.from({length:width},(_,i)=>row?.[i]??null);
      const standard=async({source,headers,data,stockSource,matrixStock,matrixAvailable,stockColumn,width})=>{
        const file=makeWorkbook(`${source}-sheet`,[headers,data]);
        const parsed=await SystemV3SellerParsers.parseSellerFiles(source,[file],{price:false,discount:false,inventory:true});
        if(parsed.normalizedRows.length!==1)throw Error(`${source}: expected one parsed carrier row, got ${parsed.normalizedRows.length}`);
        const carrier=parsed.normalizedRows[0];
        const snapshot=[{sku:`SKU-${source}`,product_code:carrier.product_code,option_code:carrier.option_code,
          sellpia_current_stock:matrixStock,sellpia_available_stock:matrixAvailable}];
        const plan=HubCurrentPriceExport.prepareCarrierItems(source,file.name,parsed.normalizedRows,snapshot,
          {includePrice:false,includeStock:true,stockSource});
        if(plan.operations.length!==1||plan.operations[0].field_key!=='sellpia_current_stock')throw Error(`${source}: stock-only plan did not contain exactly one stock write`);
        const transformed=await SystemV3SellerExport.transformSellerFile(file,plan.operations);
        if(transformed.skippedItems.length||transformed.appliedItems.length!==1)throw Error(`${source}: serializer did not apply exactly one planned write`);
        const output=new File([transformed.blob],`${source}_SystemV3재고_${stockSource}.xlsx`,{type:file.type});
        const [beforeRows,afterRows]=await Promise.all([rowsOf(file),rowsOf(output)]);
        return {source,stockSource,filename:output.name,before:fixed(beforeRows[1],width),after:fixed(afterRows[1],width),
          beforeHeader:fixed(beforeRows[0],width),afterHeader:fixed(afterRows[0],width),rowCountBefore:beforeRows.length,rowCountAfter:afterRows.length,stockColumn,
          target:plan.operations[0].after_value,fieldKeys:plan.operations.map(item=>item.field_key),applied:transformed.appliedItems.length,
          bytes:Array.from(new Uint8Array(await transformed.blob.arrayBuffer()))};
      };

      const smartHeaders=Array(68).fill('');
      smartHeaders[0]='상품번호';smartHeaders[1]='판매자 상품코드';smartHeaders[18]='옵션 재고수량';
      const smartRow=Array(68).fill('');
      Object.assign(smartRow,{0:'12345',1:'SELL-SMART',3:'Smart fixture product',4:'판매중',5:12000,15:'OPT-SMART',16:'red',17:250,18:'7',19:'사용'});
      const smartAvailable=await standard({source:'smartstore',headers:smartHeaders,data:smartRow,stockSource:'available_stock',matrixStock:14,matrixAvailable:-5,stockColumn:18,width:68});
      const smartPhysical=await standard({source:'smartstore',headers:smartHeaders,data:smartRow,stockSource:'stock',matrixStock:14,matrixAvailable:-5,stockColumn:18,width:68});

      const makeHeaders=Array(124).fill('');
      makeHeaders[4]='product_uid';makeHeaders[32]='sto_stock';makeHeaders[44]='sell_price';
      const makeRow=Array(124).fill('');
      Object.assign(makeRow,{4:'MAKE-001',12:'Make fixture product',31:300,32:6,39:'SELL-MAKE',41:'Y',43:'OPT-MAKE',44:18000,47:99});
      const makePhysical=await standard({source:'makeshop',headers:makeHeaders,data:makeRow,stockSource:'stock',matrixStock:13,matrixAvailable:-8,stockColumn:32,width:124});
      const makeAvailable=await standard({source:'makeshop',headers:makeHeaders,data:makeRow,stockSource:'available_stock',matrixStock:13,matrixAvailable:-8,stockColumn:32,width:124});

      const ablyRows=Array.from({length:2},()=>Array(35).fill(''));
      ablyRows[0]=AblyStockExport.headers.slice();
      const ablyRow=Array(35).fill('');
      Object.assign(ablyRow,{0:'에이블리',1:'fixture-account',2:'sellpia-ABLY',3:'Ably fixture product',4:'40337964',5:5200,
        9:'조합형',10:'색상',11:'빨강',16:'sellpia-ABLY-1',17:'sellpia-ABLY-1',21:400,22:55,23:4,24:9,34:'판매중'});
      ablyRows[1]=ablyRow;
      const ablyFile=makeWorkbook('옵션기본',ablyRows);
      const ablyParsed=await AblyPlayautoExport.readTemplate(ablyFile);
      if(ablyParsed.type!=='option_price_stock'||ablyParsed.items.length!==1)throw Error('ably: expected one parsed PlayAuto option row');
      const ablyItem=ablyParsed.items[0];
      const ablyRowsForBase=async stockSource=>{
        const target=SystemV3SellpiaInventoryCount.resolveExportStock({sellpia_current_stock:12,sellpia_available_stock:-6},stockSource);
        const blob=await AblyPlayautoExport.buildOptionPriceStock(ablyFile,[{...ablyItem,target_stock:target,_status:'ready'}]);
        const output=new File([blob],`ably_SystemV3_재고_${stockSource}.xlsx`,{type:ablyFile.type});
        const [beforeRows,afterRows]=await Promise.all([rowsOf(ablyFile),rowsOf(output)]);
        return {source:'ably',stockSource,filename:output.name,before:fixed(beforeRows[1],35),after:fixed(afterRows[1],35),
          beforeHeader:fixed(beforeRows[0],35),afterHeader:fixed(afterRows[0],35),rowCountBefore:beforeRows.length,rowCountAfter:afterRows.length,stockColumn:23,
          target,fieldKeys:['sellpia_current_stock'],applied:1,bytes:Array.from(new Uint8Array(await blob.arrayBuffer()))};
      };
      const [ablyAvailable,ablyPhysical]=await Promise.all([ablyRowsForBase('available_stock'),ablyRowsForBase('stock')]);
      return [smartAvailable,smartPhysical,makePhysical,makeAvailable,ablyAvailable,ablyPhysical];
    });

    assert.equal(results.length,6);
    assert.deepEqual(results.map(result=>result.source),['smartstore','smartstore','makeshop','makeshop','ably','ably']);
    assert.equal(new Set(results.map(result=>result.filename)).size,6,'each channel/basis must yield a separate named XLSX output');
    assert.deepEqual(results.map(result=>result.applied),[1,1,1,1,1,1]);
    assert.deepEqual(results.map(result=>result.fieldKeys),Array.from({length:6},()=>['sellpia_current_stock']));
    assert.deepEqual(results.map(result=>result.target),[0,14,13,0,0,12],'available_stock clamps negative input to zero; selected physical stock remains physical');
    for(const result of results){
      assert.deepEqual(result.afterHeader,result.beforeHeader,`${result.source}: workbook header/layout must remain unchanged`);
      assert.equal(result.rowCountAfter,result.rowCountBefore,`${result.source}: XLSX row layout must remain unchanged`);
      assert.notEqual(result.before[result.stockColumn],result.after[result.stockColumn],`${result.source}: stock cell must change`);
      for(let column=0;column<result.before.length;column++)if(column!==result.stockColumn){
        assert.equal(result.after[column],result.before[column],`${result.source}: non-stock column ${column} must remain unchanged`);
      }
    }

    // Check the generated blobs remain valid XLSX ZIP packages and can be reopened by SheetJS.
    for(const result of results){
      const zip=await JSZip.loadAsync(Uint8Array.from(result.bytes));
      assert.ok(zip.file('xl/workbook.xml'),`${result.source}: workbook.xml is present`);
    }
    if(process.env.INVENTORY_QA_OUTPUT){
      const outputDir=path.resolve(process.env.INVENTORY_QA_OUTPUT);
      fs.mkdirSync(outputDir,{recursive:true});
      for(const result of results)fs.writeFileSync(path.join(outputDir,result.filename),Uint8Array.from(result.bytes));
      fs.writeFileSync(path.join(outputDir,'metadata.json'),JSON.stringify({
        synthetic_test_data:true,
        generated_by:'tests/operationsHubInventoryFiles.browser.test.mjs',
        note:'Offline synthetic XLSX outputs for serializer QA; contains no production seller or inventory data.',
        outputs:results.map(({source,stockSource,filename,target,stockColumn})=>({source,stockSource,filename,target,stockColumn}))
      },null,2)+'\n','utf8');
    }
  }finally{await browser.close();}
});
