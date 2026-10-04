import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {createRequire} from 'node:module';

const nodeModules=process.env.CODEX_NODE_MODULES;
assert.ok(nodeModules,'CODEX_NODE_MODULES must point to bundled runtime dependencies');
const require=createRequire(path.join(nodeModules,'ably-stock-contract.cjs'));
const {chromium}=require('playwright');
const JSZip=require('jszip');
const scripts=new URL('../mockups/operations-hub/',import.meta.url);

function cells(xml){
  const result=new Map();
  String(xml).replace(/<c\b([^>]*?\br="([A-Z]+\d+)"[^>]*?)(?:\/>|>[\s\S]*?<\/c>)/g,(cell,attributes,reference)=>{result.set(reference,cell);return cell;});
  return result;
}
function numeric(cell){return Number(String(cell).match(/<v>([^<]+)<\/v>/)?.[1]);}

test('Ably stock write contract uses X and preserves W across carrier, 1+1 and quick export',async t=>{
  const vendor=process.env.XLSX_BROWSER_SCRIPT;
  const response=vendor?null:await fetch('https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js');
  if(response)assert.ok(response.ok,'SheetJS CDN read failed');
  const sheetJs=vendor?fs.readFileSync(vendor,'utf8'):await response.text();
  const browser=await chromium.launch({channel:'msedge',headless:true});
  try{
    const page=await browser.newPage();
    await page.route('**/*',route=>route.abort());
    await page.setContent('<!doctype html><title>Offline Ably stock contract fixture</title>');
    await page.addScriptTag({content:sheetJs});
    await page.addScriptTag({content:fs.readFileSync(require.resolve('jszip/dist/jszip.min.js'),'utf8')});
    for(const name of ['seller-export-adapter.js','ably-stock-export.js','ably-playauto-export.js'])await page.addScriptTag({content:fs.readFileSync(new URL(name,scripts),'utf8')});
    await page.evaluate(async()=>{
      const rows=Array.from({length:3},(_,index)=>{
        const row=Array(35).fill('');
        row[0]='에이블리';row[1]='fixture-account';row[2]='sellpia_10000';row[3]='원본 상품';row[4]='40337964';row[5]=2800;
        row[9]='조합형';row[10]='옵션';row[11]=['별','나비(바변경불가)[PM-7-02]','볼'][index];
        row[16]=`sellpia_10000-${index+1}`;row[17]=`sellpia_10000-${index+1}`;row[21]=index*100;
        row[22]=index===2?'':[30,20][index];row[23]=[3,2,1][index];row[24]=10+index;row[34]='판매중';
        return row;
      });
      const book=XLSX.utils.book_new();XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([AblyStockExport.headers,...rows]),'옵션기본');
      const zip=await JSZip.loadAsync(XLSX.write(book,{bookType:'xlsx',type:'array'}));
      const xml=await zip.file('xl/worksheets/sheet1.xml').async('string');
      zip.file('xl/worksheets/sheet1.xml',xml.replace('<row r="2">','<row r="2" ht="31" customHeight="1">'));
      window.fixtureBytes=await zip.generateAsync({type:'uint8array'});
      window.fixtureRows=rows;window.fixtureFile=new File([fixtureBytes],'ably-stock-contract.xlsx');
    });
    const original=Buffer.from(await page.evaluate(()=>Array.from(fixtureBytes)));
    const originalZip=await JSZip.loadAsync(original);
    const beforeXml=await originalZip.file('xl/worksheets/sheet1.xml').async('string');
    const before=cells(beforeXml);

    async function output(kind){
      return Buffer.from(await page.evaluate(async kind=>{
        const targets=[0,7,11];let blob;
        if(kind==='carrier')blob=await AblyPlayautoExport.buildOptionPriceStock(fixtureFile,fixtureRows.map((row,index)=>({source_row_no:index+2,target_option_price:index===1?1234:null,target_stock:targets[index]})));
        else if(kind==='quick'){
          const rows=fixtureRows.map((row,index)=>{const next=[...row];next[22]=9999;next[23]=targets[index];return next;});
          blob=await AblyStockExport.buildFromTemplate(fixtureFile,rows,[2,3,4]);
        }else{
          const items=fixtureRows.map((row,index)=>({row:[...row],line:index+2,memoText:row[16]}));
          // Failed rows keep their original X value rather than erasing stock.
          blob=await AblyStockExport.build({file:fixtureFile,items,results:[{value:0},{value:7},{error:'fixture failure'}],test:kind==='pair-test'});
        }
        return Array.from(new Uint8Array(await blob.arrayBuffer()));
      },kind));
    }

    for(const kind of ['carrier','pair','pair-test','quick'])await t.test(kind,async()=>{
      const bytes=await output(kind),zip=await JSZip.loadAsync(bytes),xml=await zip.file('xl/worksheets/sheet1.xml').async('string'),after=cells(xml);
      const expected=kind.startsWith('pair')?[0,7,1]:[0,7,11];
      for(let index=0;index<3;index++)assert.equal(numeric(after.get(`X${index+2}`)),expected[index],`${kind}: actual stock must be written to X, including zero`);
      assert.equal((xml.match(/<row\b/g)||[]).length,4,`${kind}: no row added or removed`);
      if(kind==='pair-test'){
        const data=await page.evaluate(bytes=>{
          const book=XLSX.read(new Uint8Array(bytes),{type:'array'});
          return XLSX.utils.sheet_to_json(book.Sheets['옵션기본'],{header:1,defval:'',raw:true});
        },Array.from(bytes));
        const rows=await page.evaluate(()=>fixtureRows);
        for(let row=0;row<3;row++)for(let column=0;column<35;column++)if(column!==23)assert.equal(data[row+1][column],rows[row][column],`${kind}: non-target column ${column} row ${row} changed`);
      }else{
        const allowed=new Set(['X2','X3','X4',...(kind==='carrier'?['V3']:[])]);
        for(const [reference,cell] of before)if(!allowed.has(reference))assert.equal(after.get(reference),cell,`${kind}: ${reference} must remain byte-identical`);
        for(const reference of after.keys())if(!before.has(reference))assert.ok(allowed.has(reference),`${kind}: unexpected new cell ${reference}`);
        for(const reference of ['W2','W3','W4'])assert.equal(after.get(reference),before.get(reference),`${kind}: W must preserve available stock, including blank`);
        for(const entry of Object.values(originalZip.files))if(!entry.dir&&!['xl/worksheets/sheet1.xml','xl/styles.xml'].includes(entry.name))assert.deepEqual(Buffer.from(await zip.file(entry.name).async('uint8array')),Buffer.from(await entry.async('uint8array')),`${kind}: ${entry.name} changed`);
        if(kind==='carrier')assert.equal(numeric(after.get('V3')),1234,'option extra price continues to use V');
      }
    });
  }finally{await browser.close();}
});
