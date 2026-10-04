import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const context={console};context.globalThis=context;vm.createContext(context);
vm.runInContext(fs.readFileSync('mockups/operations-hub/ably-price-projection.js','utf8'),context);
vm.runInContext(fs.readFileSync('mockups/operations-hub/ably-playauto-export.js','utf8'),context);
const A=context.AblyPlayautoExport;
const headers=['판매자관리코드','쇼핑몰(계정)','온라인 상품명','판매가','옵션','SKU','옵션 추가금액'];
const option=(color,value)=>`${color}/6mm바[GPA-1-11_4]=${value}=2개 귀걸이 세트`;
const sourceRow=(sku='11445',options=[option('옐로우골드','no-ball(기본)'),option('옐로우골드','14K 헤비 잠금볼')],skus=['11445-1','11445-1'],prices=[0,15000],base=75000)=>
 [`sellpia_${sku}`,'에이블리=pink_rocket@naver.com','14K 상품',base,options.join('\n'),skus.map(value=>`sellpia_${value}`).join('\n'),prices.map(String).join('\n')];
const catalog=['11445-1','11445-2','11446-1'].map(sku=>({sellpia_product_code:sku.split('-')[0],sellpia_sku_code:sku,sellpia_option_name:sku.endsWith('-2')?'로즈골드/6mm바[GPA-1-11_4]':'옐로우골드/6mm바[GPA-1-11_4]'}));
function items(rows,selected=['11445-1'],prices={"11445-1":82000}){
 const resolved=A.resolveRows(A.parseProductRows([headers,...rows]),catalog);
 const chosen=new Set(selected);
 const prepared=resolved.map(item=>({...item,_inScope:chosen.has(item.resolution?.sku),_status:'ready',_error:''}));
 A.prepareSellpiaSourceProductRows(prepared,new Map(Object.entries(prices)));
 return prepared;
}
const finals=rows=>Array.from(rows,row=>row.target_base_price+row.target_option_price);
const blocked=rows=>{assert.ok(rows.every(row=>row._status==='conflict'));assert.ok(rows.every(row=>row.target_base_price===undefined&&row.target_option_price===undefined));};

assert.equal(A.isNoBallAnchor('NO BALL(기본)'),true);
assert.equal(A.isNoBallAnchor('no-ball'),true);
assert.equal(A.isNoBallAnchor('noball'),true);
assert.equal(A.isNoBallAnchor('노볼'),true);
assert.equal(A.isNoBallAnchor('(기본)'),false);
assert.equal(A.isNoBallAnchor('14K 헤비 잠금볼'),false);

{
 const productCatalog=['11360-1','11360-2'].map(sku=>({sellpia_product_code:'11360',sellpia_sku_code:sku}));
 const source=A.parseProductRows([headers,sourceRow('11360',[
  option('옐로우골드','일반'),option('로즈골드','일반')
 ],['11360-1','11360-2'],[0,0])]).map(item=>({...item,seller_product_code:'66356790'}));
 const staleMapping=[{product_code:'66356790',option_code:'',sku:'11360-2'}];
 assert.deepEqual(Array.from(A.resolveRows(source,productCatalog,staleMapping),item=>item.resolution.sku),['11360-2','11360-2'],'Rules mode keeps the existing mapping precedence');
 const resolved=A.resolveRows(source,productCatalog,staleMapping,{preferDirectProductSku:true});
 assert.deepEqual(Array.from(resolved,item=>item.resolution.sku),['11360-1','11360-2']);
 assert.equal(resolved[0].resolution.mapping_override,true);
 assert.equal(resolved[0].resolution.mapped_sku,'11360-2');
 const planned=resolved.map(item=>({...item,_inScope:true,_status:'ready',_error:''}));
 A.prepareSellpiaSourceProductRows(planned,new Map([['11360-1',62500],['11360-2',75500]]));
 assert.deepEqual(finals(planned),[62500,75500]);assert.ok(planned.every(item=>item._status==='ready'));
 const wrongProduct=A.resolveSellpiaSku({...source[0],direct_sellpia_sku_code:'11359-1'},[...productCatalog,{sellpia_product_code:'11359',sellpia_sku_code:'11359-1'}],staleMapping,{preferDirectProductSku:true});
 assert.equal(wrongProduct.method,'direct_sku_invalid');assert.match(wrongProduct.error,/해당 셀피아 상품/);
 const missing=A.resolveSellpiaSku({...source[0],direct_sellpia_sku_code:'11360-99'},productCatalog,staleMapping,{preferDirectProductSku:true});
 assert.equal(missing.method,'direct_sku_invalid');
 const duplicate=A.resolveSellpiaSku(source[0],[productCatalog[0],productCatalog[0]],staleMapping,{preferDirectProductSku:true});
 assert.equal(duplicate.method,'direct_sku_invalid');
 const malformed=A.resolveSellpiaSku({...source[0],direct_sellpia_sku_code:'',direct_sellpia_sku_error:'P열 SKU 형식 오류'},productCatalog,staleMapping,{preferDirectProductSku:true});
 assert.equal(malformed.method,'direct_sku_invalid');
 const noDirect=A.resolveSellpiaSku({...source[0],direct_sellpia_sku_code:''},productCatalog,staleMapping,{preferDirectProductSku:true});
 assert.equal(noDirect.sku,'11360-2','blank P value keeps legacy mapping fallback');
}
{
 const productCatalog=['11043-1','11043-2','11043-3','11043-4'].map(sku=>({sellpia_product_code:'11043',sellpia_sku_code:sku}));
 const source=A.parseProductRows([headers,sourceRow('11043',[
  option('골드/6mm','no-ball'),option('골드/8mm','no-ball'),option('핑크골드/6mm','no-ball'),option('핑크골드/8mm','no-ball'),
  option('골드/6mm','14K 헤비 잠금볼'),option('골드/8mm','14K 헤비 잠금볼'),option('핑크골드/6mm','14K 헤비 잠금볼'),option('핑크골드/8mm','14K 헤비 잠금볼')
 ],['11043-1','11043-2','11043-3','11043-4','11043-1','11043-2','11043-3','11043-4'],[0,3500,0,3500,15000,18500,15000,18500],92500)]).map(item=>({...item,seller_product_code:'27992202'}));
 const resolved=A.resolveRows(source,productCatalog,[{product_code:'27992202',option_code:'',sku:'11043-1'}],{preferDirectProductSku:true});
 assert.deepEqual(Array.from(resolved,item=>item.resolution.sku),['11043-1','11043-2','11043-3','11043-4','11043-1','11043-2','11043-3','11043-4']);
 const prepared=resolved.map(item=>({...item,_inScope:item.resolution.sku==='11043-2',_status:'ready',_error:''}));
 A.prepareSellpiaSourceProductRows(prepared,new Map([['11043-2',100000]]));
 assert.ok(prepared.every(item=>item._status==='ready'));
 assert.deepEqual(finals(prepared),[92500,100000,92500,96000,107500,115000,107500,111000]);
}

{
 const rows=items([sourceRow()]);
 assert.deepEqual(finals(rows),[82000,97000]);assert.deepEqual(Array.from(rows,row=>row.carrier_variant_role),['anchor','addon']);
 assert.equal(rows[1].carrier_anchor_sku,'11445-1');assert.equal(rows[1].carrier_addon_delta,15000);
 assert.ok(rows.every(row=>row._status==='ready'));
}
{
 const rows=items([sourceRow('11445',undefined,undefined,[3000,18000])]);
 assert.deepEqual(finals(rows),[82000,97000]);assert.equal(rows[1].carrier_addon_delta,15000);
}
{
 const rows=items([sourceRow('11445',[
  option('옐로우골드','no-ball'),option('옐로우골드','14K 헤비 잠금볼'),
  option('로즈골드','노볼'),option('로즈골드','14K 헤비 잠금볼')
 ],['11445-1','11445-1','11445-2','11445-2'],[0,15000,0,15000])],['11445-1','11445-2'],{'11445-1':82000,'11445-2':90000});
 assert.deepEqual(finals(rows),[82000,97000,90000,105000]);
 assert.deepEqual(Array.from(rows,row=>row.target_option_price),[0,15000,8000,23000]);
}
{
 const rows=items([sourceRow('11445',[
  option('옐로우골드','no-ball'),option('옐로우골드','14K 헤비 잠금볼'),
  option('로즈골드','노볼'),option('로즈골드','14K 헤비 잠금볼')
 ],['11445-1','11445-1','11445-2','11445-2'],[0,15000,0,15000])],['11445-1'],{'11445-1':82000});
 assert.deepEqual(finals(rows),[82000,97000,75000,90000]);
 assert.deepEqual(Array.from(rows,row=>row.target_option_price),[7000,22000,0,15000]);
 assert.equal(rows[2]._preserveUnselected,true);assert.equal(rows[3]._preserveUnselected,true);
}
{
 const rows=items([sourceRow('11445',[option('옐로우골드','14K 헤비 잠금볼'),option('옐로우골드','18K 헤비 잠금볼')])]);
 blocked(rows);assert.match(rows[0]._error,/기준 노볼 옵션을 찾을 수 없습니다/);
}
{
 const rows=items([sourceRow('11445',[option('옐로우골드','no-ball'),option('옐로우골드','노볼')])]);
 blocked(rows);assert.match(rows[0]._error,/기준 노볼 옵션이 중복/);
}
{
 const rows=items([sourceRow('11445',undefined,undefined,[0,''])]);
 blocked(rows);assert.match(rows[0]._error,/원본 추가금액을 읽을 수 없습니다/);
}
{
 const rows=items([sourceRow('11445',undefined,undefined,[18000,3000])]);
 blocked(rows);assert.match(rows[0]._error,/차이가 비정상/);
}
{
 const rows=items([sourceRow(),sourceRow()]);
 blocked(rows);assert.match(rows[0]._error,/서로 다른 PlayAuto 상품 행에 중복/);
}
{
 const rows=items([sourceRow('11445',[option('옐로우골드','no-ball'),option('옐로우골드','no-ball')])]);
 blocked(rows);assert.match(rows[0]._error,/옵션값이 파일에 중복/);
}
{
 const rows=items([sourceRow('11445',[option('옐로우골드','일반')],['11445-1'],[0])]);
 assert.deepEqual(finals(rows),[82000]);assert.equal(rows[0]._status,'ready');
}
{
 const rows=A.resolveRows(A.parseProductRows([headers,sourceRow('11445',undefined,['11445-1','11445-2'])]),catalog).map(item=>({...item,_inScope:true,_status:'ready',_error:''}));
 rows[1].resolution={sku:'11445-1',method:'seller_mapping_exact'};
 A.prepareSellpiaSourceProductRows(rows,new Map([['11445-1',82000]]));
 blocked(rows);assert.match(rows[0]._error,/P열 직접 SKU.*충돌/);
}
assert.match(fs.readFileSync('mockups/operations-hub/seller-file-workflow-v2.js','utf8'),/P\(\)\.projectProductRows\(prepared,\{priceMode,targetFinalBySku,policyByRow,legacyRulesBaseBySku/,'rules and sellpia_source share one physical-product projection');
{
 vm.runInContext(fs.readFileSync('mockups/operations-hub/ably-stock-export.js','utf8'),context);
 vm.runInContext(fs.readFileSync('mockups/operations-hub/seller-export-adapter.js','utf8'),context);
 const planned=items([sourceRow('11445',[
  option('옐로우골드','no-ball'),option('옐로우골드','14K 헤비 잠금볼'),
  option('로즈골드','노볼'),option('로즈골드','14K 헤비 잠금볼')
 ],['11445-1','11445-1','11445-2','11445-2'],[0,15000,0,15000])],['11445-1','11445-2'],{'11445-1':82000,'11445-2':85000});
 const parts=new Map([
  ['xl/workbook.xml','<workbook><sheets><sheet name="쇼핑몰상품" sheetId="1" r:id="rId1"/></sheets></workbook>'],
  ['xl/_rels/workbook.xml.rels','<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'],
  ['xl/styles.xml','<styleSheet><fonts count="1"><font><sz val="11"/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs></styleSheet>'],
  ['xl/worksheets/sheet1.xml','<worksheet><sheetData><row r="2"><c r="I2"><v>75000</v></c><c r="T2" t="inlineStr"><is><t>0\n15000\n0\n15000</t></is></c><c r="U2"><v>7</v></c></row></sheetData></worksheet>']
 ]);
 context.JSZip={loadAsync:async()=>({file(name,value){if(value!==undefined){parts.set(name,value);return this;}return parts.has(name)?{async:async()=>parts.get(name)}:null;},async generateAsync(){return parts;}})};
 context.XLSX={read:()=>({Sheets:{쇼핑몰상품:{T2:{v:'0\n15000\n0\n15000'}}}})};
 await A.buildProductPriceOption({name:'playauto.xlsx',arrayBuffer:async()=>new ArrayBuffer(1)},planned);
 const sheet=parts.get('xl/worksheets/sheet1.xml'),styles=parts.get('xl/styles.xml');
 assert.match(sheet,/<c r="I2"[^>]*><v>82000<\/v><\/c>/);
 const optionCell=sheet.match(/<c r="T2"[\s\S]*?<\/c>/)?.[0]||'';
 assert.equal([...optionCell.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(match=>match[1]).join(''),'0\n15000\n3000\n18000','T option lines keep their original order and per-SKU add-on delta');
 assert.match(sheet,/<c r="U2"><v>7<\/v><\/c>/,'unrelated source cell is preserved');
 assert.match(styles,/FFFFFF00/,'changed cells retain yellow highlighting');
 assert.match(styles,/<b\b/,'changed cells retain bold highlighting');
}
console.log('PASS Ably Sellpia carrier variants: anchors, deltas, multi-SKU, partial siblings and fail-closed guards.');
