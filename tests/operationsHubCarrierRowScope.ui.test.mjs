import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';

// Browser XML parser and real ZIP roundtrip; no production data or network calls.
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const runtime='C:/Users/hihi0/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules';
const browser=await chromium.launch({channel:'msedge',headless:true});
try{
  const page=await browser.newPage();
  await page.route('**/*',route=>route.abort());
  await page.setContent('<html><body>Isolated Smartstore XLSX XML QA</body></html>');
  await page.addScriptTag({path:path.join(runtime,'jszip/dist/jszip.min.js')});
  await page.addScriptTag({path:path.join(root,'mockups/operations-hub/seller-export-adapter.js')});
  const result=await page.evaluate(async()=>{
    const rows=Array.from({length:1759},(_,index)=>{
      const row=index+1;
      return `<row r="${row}"><c r="D${row}" t="inlineStr"><is><t>상품${row}</t></is></c><c r="F${row}"><v>30000</v></c></row>`;
    }).join('');
    const sheet=`<worksheet><dimension ref="A1:CP1759"/><sheetData>${rows}</sheetData></worksheet>`;
    const zip=new JSZip();
    zip.file('xl/workbook.xml','<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="일괄수정" sheetId="1" r:id="rId1"/></sheets></workbook>');
    zip.file('xl/_rels/workbook.xml.rels','<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>');
    zip.file('xl/styles.xml','<styleSheet><fonts count="1"><font><sz val="11"/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs></styleSheet>');
    zip.file('xl/worksheets/sheet1.xml',sheet);
    const source=new File([await zip.generateAsync({type:'blob'})],'smartstore.xlsx');
    const scope={dataRowNumbers:new Set(Array.from({length:1758},(_,index)=>index+2)),keepOnlyRows:new Set(Array.from({length:8},(_,index)=>index+2))};
    const result=await SystemV3SellerExport.transformTabularXlsx(source,[{row:2,column:'F',value:32000,numeric:true}],scope);
    const output=await JSZip.loadAsync(await result.blob.arrayBuffer());
    const xml=await output.file('xl/worksheets/sheet1.xml').async('string');
    const styles=await output.file('xl/styles.xml').async('string');
    const parsed=new DOMParser().parseFromString(xml,'application/xml');
    if(parsed.getElementsByTagName('parsererror').length)throw Error('Generated worksheet XML does not parse');
    const badZip=await JSZip.loadAsync(await source.arrayBuffer());
    badZip.file('xl/worksheets/sheet1.xml',sheet.replace('</worksheet>',''));
    const badFile=new File([await badZip.generateAsync({type:'blob'})],'bad.xlsx');
    let badRejected=false;
    try{await SystemV3SellerExport.transformTabularXlsx(badFile,[{row:2,column:'F',value:32000,numeric:true}],scope);}catch(error){badRejected=/worksheet XML/.test(String(error));}
    return {dimension:xml.match(/<dimension\b[^>]*>/)?.[0],rows:parsed.getElementsByTagName('row').length,sku:parsed.getElementsByTagName('row')[1]?.getElementsByTagName('t')[0]?.textContent,price:SystemV3SellerExport.cellValue(xml,'F2',[]),yellow:styles.includes('FFFFFF00'),bold:/<b\b/.test(styles),badRejected};
  });
  assert.equal(result.dimension,'<dimension ref="A1:CP9"/>');
  assert.equal(result.rows,9);
  assert.equal(result.sku,'상품2');
  assert.equal(Number(result.price),32000);
  assert.equal(result.yellow,true);
  assert.equal(result.bold,true);
  assert.equal(result.badRejected,true);
  console.log('PASS Smartstore changed-only XLSX XML roundtrip: '+JSON.stringify(result));
}finally{await browser.close();}
