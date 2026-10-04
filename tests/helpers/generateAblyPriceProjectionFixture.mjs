import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {chromium} from 'playwright';

const require=createRequire(import.meta.url),JSZip=require('jszip');
const output=path.resolve(process.argv[2]||'tests/fixtures/ably/ably-price-projection-synthetic.xlsx');
const xlsxScript=process.env.XLSX_BROWSER_SCRIPT&&fs.existsSync(process.env.XLSX_BROWSER_SCRIPT)
 ?fs.readFileSync(process.env.XLSX_BROWSER_SCRIPT,'utf8')
 :await (await fetch('https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js')).text();

const cases=[
 {id:'A',title:'3옵션 정상',base:40000,prices:[0,10000,20000],skus:['CASE-A-1','CASE-A-2','CASE-A-3'],values:['골드=기본','실버=기본','블랙=기본']},
 {id:'B',title:'짝수 옵션 lower-middle',base:40000,prices:[0,10000,20000,30000],skus:['CASE-B-1','CASE-B-2','CASE-B-3','CASE-B-4']},
 {id:'C',title:'부분 export 핵심 회귀',base:30000,prices:[0,3500,9000],skus:['CASE-C-1','CASE-C-2','CASE-C-3']},
 {id:'D',title:'동일 SKU carrier-local variant',base:75000,prices:[0,15000],skus:['CASE-D-1','CASE-D-1'],values:['골드=no-ball','골드=heavy locking ball']},
 {id:'E',title:'옵션 하나',base:50000,prices:[0],skus:['CASE-E-1']},
 {id:'F',title:'모든 옵션 동일 가격',base:50000,prices:[0,0,0],skus:['CASE-F-1','CASE-F-2','CASE-F-3']},
 {id:'G',title:'중복 가격 포함',base:40000,prices:[0,0,10000,10000,20000],skus:['CASE-G-1','CASE-G-2','CASE-G-3','CASE-G-4','CASE-G-5']},
 {id:'H',title:'큰 가격차',base:10000,prices:[0,90000],skus:['CASE-H-1','CASE-H-2']},
 {id:'I',title:'identity 누락',base:30000,prices:[0,1000],skus:['CASE-I-1','BROKEN-SKU']},
 {id:'J',title:'중복 identity',base:30000,prices:[0,1000],skus:['CASE-J-1','CASE-J-2'],values:['same=기본','same=기본']},
 {id:'K',title:'no-ball anchor 없음',base:75000,prices:[0,15000],skus:['CASE-K-1','CASE-K-1'],values:['골드=heavy','골드=18K heavy']},
 {id:'L',title:'no-ball anchor 2개',base:75000,prices:[0,15000],skus:['CASE-L-1','CASE-L-1'],values:['골드=no-ball','골드=노볼']},
 {id:'M',title:'음수 carrier add-on',base:75000,prices:[15000,0],skus:['CASE-M-1','CASE-M-1'],values:['골드=no-ball','골드=heavy']},
 {id:'N1',title:'동일 SKU 다른 physical product 1',base:30000,prices:[0],skus:['CASE-N-1']},
 {id:'N2',title:'동일 SKU 다른 physical product 2',base:31000,prices:[0],skus:['CASE-N-1']},
 {id:'O',title:'policy conflict',base:40000,prices:[0,10000],skus:['CASE-O-1','CASE-O-2']},
 {id:'P',title:'동일 policy 중복',base:40000,prices:[0,10000],skus:['CASE-P-1','CASE-P-2']},
 {id:'Q',title:'관련 없는 일반 태그',base:40000,prices:[0,10000],skus:['CASE-Q-1','CASE-Q-2']},
 {id:'R',title:'비활성 태그',base:40000,prices:[0,10000],skus:['CASE-R-1','CASE-R-2']}
];

const browser=await chromium.launch({channel:'msedge',headless:true});
let bytes;
try{
 const page=await browser.newPage();await page.setContent('<!doctype html><title>Ably synthetic fixture generator</title>');await page.addScriptTag({content:xlsxScript});
 bytes=Buffer.from(await page.evaluate(cases=>{
  const headers=Array.from({length:22},(_,index)=>`보존열-${String.fromCharCode(65+index)}`);
  Object.assign(headers,{0:'판매자관리코드',1:'쇼핑몰(계정)',2:'온라인 상품명',5:'쇼핑몰 상품번호',8:'판매가',13:'옵션',15:'SKU',19:'옵션 추가금액',20:'QA 병합 메타',21:''});
  const rows=cases.map((entry,index)=>{
   const values=entry.values||entry.skus.map((_,optionIndex)=>`옵션${optionIndex+1}=기본`),row=Array(22).fill('');
   row[0]=`sellpia_CASE-${entry.id}`;row[1]='에이블리=synthetic@example.test';row[2]=`${entry.id} · ${entry.title}`;row[3]=`보존-D-${entry.id}`;row[4]=index%2?`TEXT-${index}`:index;
   row[5]=`ABLY-${String(index+1).padStart(5,'0')}`;row[6]=true;row[7]=45000+index;row[8]=entry.base;row[10]=1234.5+index;row[12]=`보존-M-${entry.id}`;
   row[13]=values.join('\n');row[14]=`fixture:${entry.id}`;row[15]=entry.skus.map(sku=>sku.startsWith('BROKEN')?sku:`sellpia_${sku}`).join('\n');row[16]=index%2?'mixed-text':index;row[18]=index+1;row[19]=entry.prices.join('\n');row[20]=`case-${entry.id}`;
   return row;
  });
  const book=XLSX.utils.book_new(),sheet=XLSX.utils.aoa_to_sheet([headers,...rows],{cellDates:true});
  sheet['!cols']=Array.from({length:22},(_,index)=>({wch:[0,2,13,15,19].includes(index)?24:12}));sheet['!rows']=[{hpt:28},...rows.map((_,index)=>({hpt:index%2?24:36}))];sheet['!merges']=[XLSX.utils.decode_range('U1:V1')];
  for(let rowIndex=2;rowIndex<=rows.length+1;rowIndex++){
   sheet[`J${rowIndex}`]={t:'n',f:`I${rowIndex}+100`,v:Number(sheet[`I${rowIndex}`].v)+100,z:'#,##0"원"'};
   sheet[`S${rowIndex}`]={t:'n',f:`I${rowIndex}+SUM(1,2)`,v:Number(sheet[`I${rowIndex}`].v)+3};sheet[`I${rowIndex}`].z='#,##0"원"';sheet[`K${rowIndex}`].z='#,##0.00';
  }
  XLSX.utils.book_append_sheet(book,sheet,'쇼핑몰상품');
  const meta=XLSX.utils.aoa_to_sheet([['fixture_version',1],['case_count',cases.length],['purpose','Ably price projection synthetic QA'],...cases.map(entry=>[entry.id,entry.title])]);
  XLSX.utils.book_append_sheet(book,meta,'QA_META');book.Workbook={Sheets:[{name:'쇼핑몰상품',Hidden:0},{name:'QA_META',Hidden:1}]};
  book.Props={Title:'System V3 Ably Synthetic QA',Subject:'Price projection roundtrip',Author:'Codex local QA',Company:'Local fixture only',CreatedDate:new Date('2026-10-01T00:00:00.000Z')};
  book.Custprops={fixture_id:'ably-price-projection-v1',case_count:cases.length,production_data:false};
  return Array.from(new Uint8Array(XLSX.write(book,{bookType:'xlsx',type:'array',cellStyles:true,bookSST:true,compression:true})));
 },cases));
}finally{await browser.close();}

const zip=await JSZip.loadAsync(bytes),sheetPath='xl/worksheets/sheet1.xml';let sheetXml=await zip.file(sheetPath).async('string');
if(!/<pane\b/.test(sheetXml)){
 sheetXml=sheetXml.replace(/<sheetView([^>]*)\/>/,`<sheetView$1><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView>`);
 zip.file(sheetPath,sheetXml,{createFolders:false});
}
zip.file('qa/fixture-manifest.json',JSON.stringify({version:1,generated_at:'2026-10-01T00:00:00.000Z',cases:cases.map(({id,title})=>({id,title})),production_data:false},null,2));
fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,await zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'}));
console.log(`${output} (${fs.statSync(output).size} bytes, ${cases.length} cases)`);
