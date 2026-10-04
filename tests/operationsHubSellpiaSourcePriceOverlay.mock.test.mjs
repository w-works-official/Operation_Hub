import assert from 'node:assert/strict';
import '../mockups/operations-hub/discount-price-math.js';
import '../mockups/operations-hub/seller-export-adapter.js';
import '../mockups/operations-hub/current-price-export.js';

const api=globalThis.HubCurrentPriceExport;
const term=value=>[{term_key:'basic',term_type:'immediate',value,unit:'amount',is_baseline:true,rounding_mode:'nearest',rounding_unit:1}];
function fixture({discount=4000,base=34000,options=[0,3500,9000],selected=['A'],sourcePrices={A:30000},terms=term(discount)}={}){
 const discounted=base-discount;
 const rows=options.map((option,index)=>({product_code:'P',option_code:['A','B','C'][index],base_price:base,discounted_base_price:discounted,option_price:option,final_price:discounted+option,discount_terms:terms,source_row_no:2,raw_payload:{source_file_name:'smartstore.xlsx',smartstore_basic_discount_value:discount||null,smartstore_basic_discount_unit:discount?'원':null,smartstore_mobile_discount_value:null,smartstore_mobile_discount_unit:null,smartstore_reservation_discount_value:null,smartstore_reservation_discount_unit:null,smartstore_multi_buy_discount_value:null,smartstore_multi_buy_discount_unit:null}}));
 const mappings=rows.map(row=>({sku:row.option_code,product_code:row.product_code,option_code:row.option_code}));
 const prices=new Map(Object.entries(sourcePrices));
 return {rows,mappings,prices,selected};
}
function plan(f){return api.prepareSellpiaSourcePricePlan('smartstore','smartstore.xlsx',f.rows,f.mappings,f.prices,f.selected);}
function assertFinals(p,expected){assert.deepEqual(p.preview.map(row=>row.diff.price.after.final),expected);for(const row of p.preview){assert.equal(row.diff.price.after.discounted+row.diff.price.after.option,row.diff.price.after.final);assert.deepEqual(row.diff.price.after.discount_terms,row.diff.price.before.discount_terms);assert.ok(row.diff.price.after.option>=0);}}

{
 const p=plan(fixture());assertFinals(p,[30000,33500,39000]);assert.equal(p.preview[0].diff.price.after.base,34000);assert.equal(p.preview.filter(row=>row.preserve_unmapped).length,2);
 assert.equal(p.operations.length,0,'matching source price and original finals require no workbook edit');
}
{
 const p=plan(fixture({sourcePrices:{A:32000}}));assertFinals(p,[32000,33500,39000]);assert.equal(p.preview[0].diff.price.after.base,36000);assert.equal(p.operations.length,3,'shared registration change rewrites every sibling option');assert.equal(p.operations.filter(item=>item.preserve_unmapped).length,2);
 assert.deepEqual(p.operations.map(item=>item.target_final_price),[32000,33500,39000]);assert.ok(p.operations.every(item=>item.pricing_input_mode==='sellpia_source'));
}
{
 const p=plan(fixture({selected:['B'],sourcePrices:{B:28000}}));assertFinals(p,[30000,28000,39000]);assert.equal(p.preview[1].diff.price.after.base,32000);assert.deepEqual(p.preview.map(row=>row.diff.price.after.option),[2000,0,11000]);
}
{
 const p=plan(fixture({discount:0,base:30000,terms:[],options:[0],sourcePrices:{A:31000}}));assertFinals(p,[31000]);assert.equal(p.preview[0].diff.price.after.base,31000);
}
{
 const p=plan(fixture({discount:116000,base:146000,options:[0,3500,9000],sourcePrices:{A:33000}}));assertFinals(p,[33000,33500,39000]);assert.equal(p.preview[0].diff.price.after.base,149000);assert.equal(p.preview[0].diff.price.before.discount_terms[0].value,116000);
}
{
 const blocked=(f,reason)=>{const p=plan(f);assert.equal(p.operations.length,0);assert.equal(p.summary.blocked,f.rows.length);assert.match(p.preview[0].reason,reason);assert.equal(p.excludedItems.length,f.rows.length);};
 blocked(fixture({sourcePrices:{}}),/최신 셀피아 원본 판매가/);
 const duplicate=fixture();duplicate.mappings.push({sku:'X',product_code:'P',option_code:'A'});blocked(duplicate,/여러 SKU/);
 const duplicateCarrier=fixture();duplicateCarrier.rows.push({...duplicateCarrier.rows[0],source_row_no:5});const duplicatePlan=plan(duplicateCarrier);assert.equal(duplicatePlan.summary.blocked,4);assert.equal(duplicatePlan.preview.filter(row=>row.source_row_no===5&&row.status==='blocked').length,1,'every duplicate physical carrier row remains visible as blocked');
 const unrelated=fixture();unrelated.rows.push({...unrelated.rows[0],product_code:'OTHER',option_code:'X'});unrelated.mappings.push({sku:'X',product_code:'OTHER',option_code:'X'},{sku:'Y',product_code:'OTHER',option_code:'X'});assert.equal(plan(unrelated).summary.selected,1,'unrelated product mapping ambiguity does not block the selected product');
 const multi=fixture();multi.mappings.push({sku:'A',product_code:'P',option_code:'B'});blocked(multi,/identity가 여러|여러 SKU/);
 const missing=fixture();missing.rows[0].discount_terms=null;blocked(missing,/할인을 읽지/);
 const unreadable=fixture();unreadable.rows[0].raw_payload.smartstore_basic_discount_unit=null;blocked(unreadable,/할인정보가 불완전/);
 const absent=fixture();delete absent.rows[0].raw_payload.smartstore_basic_discount_value;blocked(absent,/할인정보를 읽지/);
 const inconsistent=fixture();inconsistent.rows[1].base_price=35000;blocked(inconsistent,/등록가·할인조건/);
 const badLocation=fixture();badLocation.rows[0].source_row_no=null;blocked(badLocation,/행 위치/);
 const wrongDiscount=fixture();wrongDiscount.rows[0].discounted_base_price=12345;blocked(wrongDiscount,/할인조건과 할인 후 가격/);
 const invalidPrice=fixture({sourcePrices:{A:-1}});blocked(invalidPrice,/원본 판매가/);
 const mixed=fixture({sourcePrices:{A:32000,Q:45000}});mixed.rows.push({...mixed.rows[0],product_code:'Q',option_code:'Q',source_row_no:3});mixed.mappings.push({sku:'Q',product_code:'Q',option_code:'Q'});mixed.selected.push('Q');mixed.mappings.push({sku:'X',product_code:'P',option_code:'A'});const partial=plan(mixed);
 assert.equal(partial.summary.blocked,3,'ambiguous P siblings stay original');assert.equal(partial.summary.selected,1,'independent Q remains exportable');assert.equal(partial.operations.length,1);assert.equal(partial.operations[0].seller_product_code,'Q');
 assert.throws(()=>api.prepareSellpiaSourcePricePlan('ably','smartstore.xlsx',[],[],new Map(),['A']),/스마트스토어·메이크샵/);
}
{
 const cases=[
  {product:'6695',base:63000,discount:27000,anchor:36000,option:31750,afterBase:63500,afterDiscount:27500},
  {product:'6698',base:205750,discount:109500,anchor:96250,option:119500,afterBase:239000,afterDiscount:142750},
  {product:'5648',base:91250,discount:15000,anchor:76250,option:53000,afterBase:106000,afterDiscount:29750},
  {product:'9328',base:139000,discount:41500,anchor:97500,option:70250,afterBase:140500,afterDiscount:43000},
  {product:'round-up-after-check',base:63000,discount:27000,anchor:36000,option:31721,afterBase:63500,afterDiscount:27500},
  {product:'round-nearest-safe',base:63000,discount:27000,anchor:36000,option:31726,afterBase:63500,afterDiscount:27500}
 ];
 for(const value of cases){
  const f=fixture({base:value.base,discount:value.discount,options:[0,value.option],sourcePrices:{A:value.anchor}}),p=plan(f);
  assert.equal(p.summary.blocked,0,value.product);assert.equal(p.preview.length,2,value.product);
  assert.equal(p.preview[0].diff.price.after.base,value.afterBase,value.product);
  assert.equal(p.preview[0].diff.price.after.discount_terms[0].value,value.afterDiscount,value.product);
  assert.equal(p.preview[0].diff.price.before.discount_terms[0].value,value.discount,value.product);
  assert.equal(p.preview[0].diff.price.after.discounted,value.anchor,value.product);
  assert.equal(p.preview[1].diff.price.after.final,value.anchor+value.option,`${value.product}: unselected sibling final`);
  assert.equal(p.preview[1].diff.price.before.final,p.preview[1].diff.price.after.final,value.product);
  assert.ok(p.operations.every(item=>item.target_option_price<=Math.floor(item.target_base_price*0.5/10)*10),value.product);
  assert.equal(p.preview[0].option_limit_adjustment.allowed_option,Math.floor(value.afterBase*0.5/10)*10,value.product);
 }
 const within=plan(fixture({base:63000,discount:27000,options:[0,31000],sourcePrices:{A:36000}}));
 assert.equal(within.preview[0].diff.price.after.base,63000);assert.equal(within.preview[0].diff.price.after.discount_terms[0].value,27000);assert.equal(within.preview[0].option_limit_adjustment,null);
 const blocked=(f,reason)=>{const p=plan(f);assert.equal(p.operations.length,0);assert.equal(p.summary.blocked,f.rows.length);assert.match(p.preview[0].reason,reason);};
 blocked(fixture({base:72000,discount:36000,options:[0,40000],sourcePrices:{A:36000},terms:[{term_key:'basic',value:50,unit:'percent',is_baseline:true}]}),/기본할인 구조/);
 const noBasic=fixture({base:63000,discount:27000,options:[0,40000],sourcePrices:{A:36000},terms:[{term_key:'mobile',value:27000,unit:'amount',is_baseline:true}]});
 for(const row of noBasic.rows){row.raw_payload.smartstore_basic_discount_value=null;row.raw_payload.smartstore_basic_discount_unit=null;row.raw_payload.smartstore_mobile_discount_value=27000;row.raw_payload.smartstore_mobile_discount_unit='원';}
 blocked(noBasic,/기본할인 구조/);
 blocked(fixture({base:73000,discount:37000,options:[0,40000],sourcePrices:{A:36000},terms:[...term(27000),...term(10000)]}),/기본할인 구조/);
 blocked(fixture({base:72000,discount:36000,options:[0,40000],sourcePrices:{A:36000},terms:[{term_key:'mobile',value:50,unit:'percent',is_baseline:true},...term(0)]}),/기준 최종가가 일치/);
 blocked(fixture({base:63000,discount:27000,options:[0,40000],sourcePrices:{A:36000},terms:[{...term(27000)[0],value:Number.NaN}]}),/할인조건과 할인 후 가격/);
 blocked(fixture({sourcePrices:{A:Number.NaN}}),/원본 판매가/);
 blocked(fixture({sourcePrices:{A:Number.MAX_SAFE_INTEGER+1}}),/원본 판매가/);
}
{
 const terms=[{term_key:'period',term_type:'period',value:10,unit:'percent',rounding_mode:'nearest',rounding_unit:10,is_baseline:true,raw_text:'10% 십원반올림'}];
 const rows=[['',0,2],['B',1000,3],['C',2000,4]].map(([option,price,rowNo])=>({product_code:'M',option_code:option,base_price:10000,discounted_base_price:9000,option_price:price,final_price:9000+price,discount_terms:terms,source_row_no:rowNo,raw_payload:{source_file_name:'make.xlsx',makeshop_discount_price:'10% 십원반올림',makeshop_membership_discount:0}}));
 const mappings=[{sku:'B',product_code:'M',option_code:'B'},{sku:'C',product_code:'M',option_code:'C'}];
 const p=api.prepareSellpiaSourcePricePlan('makeshop','make.xlsx',rows,mappings,new Map([['B',8500]]),['B']);
 assertFinals(p,[9000,8500,11000]);assert.equal(p.summary.selected,1);assert.equal(p.summary.preserved,2);
 assert.equal(p.operations.length,3,'a shared MakeShop base change rewrites every sibling option');
 assert.ok(p.preview.every(row=>row.diff.price.after.base===p.preview[0].diff.price.after.base));
 assert.ok(p.preview.every(row=>row.diff.price.after.option>=0));
 const parts=new Map([
  ['xl/workbook.xml','<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="수정" sheetId="1" r:id="rId1"/></sheets></workbook>'],
  ['xl/_rels/workbook.xml.rels','<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'],
  ['xl/styles.xml','<styleSheet><fonts count="1"><font><sz val="11"/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs></styleSheet>'],
  ['xl/worksheets/sheet1.xml','<worksheet><sheetData><row r="2"><c r="E2" t="inlineStr"><is><t>M</t></is></c><c r="U2" t="inlineStr"><is><t>B,C</t></is></c><c r="V2" t="inlineStr"><is><t>1000,2000</t></is></c><c r="AS2"><v>10000</v></c><c r="DD2" t="inlineStr"><is><t>10% 십원반올림</t></is></c></row><row r="3"><c r="AD3" t="inlineStr"><is><t>B</t></is></c><c r="AR3" t="inlineStr"><is><t>B</t></is></c><c r="AF3"><v>1000</v></c></row><row r="4"><c r="AD4" t="inlineStr"><is><t>C</t></is></c><c r="AR4" t="inlineStr"><is><t>C</t></is></c><c r="AF4"><v>2000</v></c></row></sheetData></worksheet>']
 ]);
 const zip={file(name,value){if(value!==undefined){parts.set(name,value);return this;}return parts.has(name)?{async:async()=>parts.get(name)}:null;},async generateAsync(){return new Blob([JSON.stringify([...parts])]);}};
 const saved=globalThis.JSZip;globalThis.JSZip={loadAsync:async()=>zip};
 try{
  const result=await globalThis.SystemV3SellerExport.transformSellerFile({name:'make.xlsx',arrayBuffer:async()=>new ArrayBuffer(0)},p.operations);
  assert.equal(result.skippedItems.length,0);assert.equal(result.appliedItems.length,3);
  const sheet=parts.get('xl/worksheets/sheet1.xml'),cell=globalThis.SystemV3SellerExport.cellValue;
  assert.equal(Number(cell(sheet,'AS2',[])),p.preview[0].diff.price.after.base);
  assert.equal(Number(cell(sheet,'AF3',[])),0);assert.equal(Number(cell(sheet,'AF4',[])),2500);
  assert.equal(cell(sheet,'V2',[]),'0,2500','comma-separated option prices match the combination prices');
  assert.equal(cell(sheet,'DD2',[]),'10% 십원반올림','the original period discount is retained');
  assert.match(parts.get('xl/styles.xml'),/FFFFFF00/);assert.match(parts.get('xl/styles.xml'),/<b\b/);
 }finally{globalThis.JSZip=saved;}
 const missing=structuredClone(rows);missing[0].raw_payload.makeshop_discount_price='invalid';missing[0].discount_terms=[];
 assert.match(api.prepareSellpiaSourcePricePlan('makeshop','make.xlsx',missing,mappings,new Map([['B',8500]]),['B']).preview[0].reason,/할인조건과 할인 후 가격|할인정보/);
}
{
 const first=plan(fixture({sourcePrices:{A:32000}})),second=plan(fixture({sourcePrices:{A:32500}}));assert.notEqual(first.version_token,second.version_token,'a new source price invalidates a preview');
 assert.equal(api.matrixPriceTarget({}),null,'the default rules resolver remains independent');
}
{
 const changed=Array.from({length:2646},(_,index)=>({status:'ready',changed:true,product_code:`CHANGED-${index}`,source_row_no:index+2}));
 const noChange=Array.from({length:44},(_,index)=>({status:'ready',changed:false,product_code:`NO-CHANGE-${index}`,source_row_no:index+3000}));
 const blockedProducts=[...Array(36).fill('2084923'),...Array(6).fill('2080413'),...Array(2).fill('2085509')];
 const blockedRows=blockedProducts.map((product,index)=>({status:'blocked',changed:false,product_code:product,source_row_no:index+4000,reason:`blocked-${product}`}));
 const plans=[{preview:[...changed,...noChange,...blockedRows]}],before=JSON.stringify(plans);
 const summary=api.summarizeSourcePricePreview(plans);
 assert.deepEqual(summary,{total:2734,changed:2646,noChange:44,blocked:44,unclassified:0,complete:true});
 assert.equal(summary.changed+summary.noChange+summary.blocked,summary.total,'row-state counts are mutually exclusive and exhaustive');
 assert.deepEqual(Object.fromEntries([...new Set(blockedProducts)].map(product=>[product,blockedRows.filter(row=>row.product_code===product).length])),{'2084923':36,'2080413':6,'2085509':2});
 const excluded=blockedRows.map((row,index)=>({item:{source_channel:'makeshop',sellpia_sku_code:'',field_key:'sellpia_sale_price',seller_product_code:row.product_code,seller_option_code:'',source_file_name:'makeshop.xlsx',source_row_no:row.source_row_no,export_item_id:-index-1},reason:row.reason}));
 const warningCsv=globalThis.SystemV3SellerExport.conflictCsv(excluded),warningLines=warningCsv.replace(/^\uFEFF/,'').trim().split(/\r?\n/);
 assert.equal(warningLines.length-1,summary.blocked,'warning CSV contains exactly the blocked rows');
 assert.ok(noChange.every(row=>!warningCsv.includes(row.product_code)),'NO_CHANGE rows never enter warning CSV');
 assert.equal(JSON.stringify(plans),before,'preview classification must not mutate the transformation plan or XLSX operations');
}
{
 const parts=new Map([
  ['xl/workbook.xml','<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="수정" sheetId="1" r:id="rId1"/></sheets></workbook>'],
  ['xl/_rels/workbook.xml.rels','<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'],
  ['xl/styles.xml','<styleSheet><fonts count="1"><font><sz val="11"/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs></styleSheet>'],
  ['xl/worksheets/sheet1.xml','<worksheet><dimension ref="A1:CP3"/><sheetData><row r="2"><c r="F2"><v>34000</v></c><c r="BF2"><v>4000</v></c><c r="BG2" t="inlineStr"><is><t>원</t></is></c></row><row r="3"><c r="F3"><v>50000</v></c></row></sheetData></worksheet>']
 ]);
 const zip={file(name,value){if(value!==undefined){parts.set(name,value);return this;}return parts.has(name)?{async:async()=>parts.get(name)}:null;},async generateAsync(){return new Blob([JSON.stringify([...parts])]);}};
 const saved=globalThis.JSZip;globalThis.JSZip={loadAsync:async()=>zip};
 try{
  const adapter=globalThis.SystemV3SellerExport,file={name:'smartstore.xlsx',arrayBuffer:async()=>new ArrayBuffer(0)};
  const scoped=await adapter.transformSellerFile(file,[],{dataRowNumbers:new Set([2,3]),keepOnlyRows:new Set([2])});
  assert.equal(scoped.appliedItems.length,0);assert.doesNotMatch(parts.get('xl/worksheets/sheet1.xml'),/row r="3"/,'warning-only changed export excludes unrelated rows');
  await adapter.markCarrierWarnings(scoped.blob,'smartstore',[{status:'blocked',source_row_no:2,product_code:'P',option_code:'A'}]);
  assert.match(parts.get('xl/styles.xml'),/FFFFC7CE/,'blocked source row is red');
  assert.match(adapter.conflictCsv([{item:{source_channel:'smartstore',sellpia_sku_code:'A',field_key:'sellpia_sale_price',seller_product_code:'P',option_code:'A',source_file_name:'smartstore.xlsx',source_row_no:2},reason:'연결 모호'}]),/연결 모호/,'blocked row is in separate warning CSV');
 }finally{globalThis.JSZip=saved;}
}
{
 const p=plan(fixture({sourcePrices:{A:32000}}));
 const parts=new Map([
  ['xl/workbook.xml','<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="수정" sheetId="1" r:id="rId1"/></sheets></workbook>'],
  ['xl/_rels/workbook.xml.rels','<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'],
  ['xl/styles.xml','<styleSheet><fonts count="1"><font><sz val="11"/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs></styleSheet>'],
  ['xl/worksheets/sheet1.xml','<worksheet><sheetData><row r="2"><c r="D2" t="inlineStr"><is><t>원본 상품명</t></is></c><c r="F2"><v>34000</v></c><c r="P2" t="inlineStr"><is><t>A\nB\nC</t></is></c><c r="R2" t="inlineStr"><is><t>0\n3500\n9000</t></is></c><c r="S2" t="inlineStr"><is><t>5\n6\n7</t></is></c><c r="BF2"><v>4000</v></c><c r="BG2" t="inlineStr"><is><t>원</t></is></c></row></sheetData></worksheet>']
 ]);
 const zip={file(name,value){if(value!==undefined){parts.set(name,value);return this;}return parts.has(name)?{async:async()=>parts.get(name)}:null;},async generateAsync(){return new Blob([JSON.stringify([...parts])]);}};
 const saved=globalThis.JSZip;globalThis.JSZip={loadAsync:async()=>zip};
 try{
  const file={name:'smartstore.xlsx',arrayBuffer:async()=>new ArrayBuffer(0)},result=await globalThis.SystemV3SellerExport.transformSellerFile(file,p.operations);
  assert.equal(result.skippedItems.length,0);assert.equal(result.appliedItems.length,3);
  const sheet=parts.get('xl/worksheets/sheet1.xml'),styles=parts.get('xl/styles.xml');
  assert.equal(Number(globalThis.SystemV3SellerExport.cellValue(sheet,'F2',[])),36000);
  assert.equal(globalThis.SystemV3SellerExport.cellValue(sheet,'R2',[]),'0\n1500\n7000');
  assert.equal(Number(globalThis.SystemV3SellerExport.cellValue(sheet,'BF2',[])),4000);
  assert.equal(globalThis.SystemV3SellerExport.cellValue(sheet,'BG2',[]),'원');
  assert.equal(globalThis.SystemV3SellerExport.cellValue(sheet,'D2',[]),'원본 상품명');
  assert.equal(globalThis.SystemV3SellerExport.cellValue(sheet,'S2',[]),'5\n6\n7');
  assert.match(styles,/FFFFFF00/,'edited price cells receive the yellow style');assert.match(styles,/<b\b/,'edited price cells receive bold style');
 }finally{globalThis.JSZip=saved;}
}
{
 const p=plan(fixture({base:63000,discount:27000,options:[0,31750],sourcePrices:{A:36000}}));
 const parts=new Map([
  ['xl/workbook.xml','<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="수정" sheetId="1" r:id="rId1"/></sheets></workbook>'],
  ['xl/_rels/workbook.xml.rels','<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'],
  ['xl/styles.xml','<styleSheet><fonts count="1"><font><sz val="11"/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs></styleSheet>'],
  ['xl/worksheets/sheet1.xml','<worksheet><sheetData><row r="2"><c r="F2"><v>63000</v></c><c r="P2" t="inlineStr"><is><t>A\nB</t></is></c><c r="R2" t="inlineStr"><is><t>0\n31750</t></is></c><c r="BF2"><v>27000</v></c><c r="BG2" t="inlineStr"><is><t>원</t></is></c></row></sheetData></worksheet>']
 ]);
 const zip={file(name,value){if(value!==undefined){parts.set(name,value);return this;}return parts.has(name)?{async:async()=>parts.get(name)}:null;},async generateAsync(){return new Blob([JSON.stringify([...parts])]);}};
 const saved=globalThis.JSZip;globalThis.JSZip={loadAsync:async()=>zip};
 try{
  const result=await globalThis.SystemV3SellerExport.transformSellerFile({name:'smartstore.xlsx',arrayBuffer:async()=>new ArrayBuffer(0)},p.operations);
  assert.equal(result.skippedItems.length,0);assert.equal(result.appliedItems.length,2);
  const sheet=parts.get('xl/worksheets/sheet1.xml'),cell=globalThis.SystemV3SellerExport.cellValue;
  assert.equal(Number(cell(sheet,'F2',[])),63500,'registration price is raised');
  assert.equal(Number(cell(sheet,'BF2',[])),27500,'basic immediate discount is raised equally');
  assert.equal(cell(sheet,'BG2',[]),'원');assert.equal(cell(sheet,'R2',[]),'0\n31750','option finals remain unchanged');
  assert.match(sheet,/<c r="F2"[^>]*\bs="\d+"/);assert.match(sheet,/<c r="BF2"[^>]*\bs="\d+"/);
  assert.match(parts.get('xl/styles.xml'),/FFFFFF00/);assert.match(parts.get('xl/styles.xml'),/<b\b/);
  const bad=structuredClone(p.operations);bad[0].target_option_price=31800;
  const rejected=await globalThis.SystemV3SellerExport.transformSellerFile({name:'smartstore.xlsx',arrayBuffer:async()=>new ArrayBuffer(0)},bad);
  assert.ok(rejected.skippedItems.length>0,'serialization preflight rejects an out-of-range option');
 }finally{globalThis.JSZip=saved;}
}
console.log('PASS Sellpia source overlay: discounts, partial siblings, lowest/reverse, source identity, exact finals, preview drift, default rules isolation.');
