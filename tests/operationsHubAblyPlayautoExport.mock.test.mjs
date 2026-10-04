import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync('mockups/operations-hub/ably-playauto-export.js','utf8');
const context={console};context.globalThis=context;vm.createContext(context);vm.runInContext(source,context);
const A=context.AblyPlayautoExport;
assert.ok(A,'AblyPlayautoExport must be exported');
assert.equal(A.PRODUCT_BASE_PRICE_COLUMN,'I');
assert.equal(A.PRODUCT_OPTION_PRICE_COLUMN,'T');
assert.equal(A.OPTION_PRICE_COLUMN,'V');
assert.equal(A.OPTION_STOCK_COLUMN,'X','PlayAuto carrier real stock is *판매수량 in X');
assert.equal(A.OPTION_SALES_QUANTITY_COLUMN,'X','sales quantity is the stock write target');

const productRows=[
 ['판매자관리코드','쇼핑몰(계정)','온라인 상품명','판매가','옵션','SKU','옵션 추가금액'],
 ['sellpia_11541','에이블리=pink_rocket@naver.com','상품',90500,'[옵션=사은품]\n옐로우골드/6mm바[GPA-4-07_2]=사은품\n로즈골드/6mm바[GPA-4-07_2]=사은품','109\n109','0\n1000']
];
const parsedProduct=A.parseProductRows(productRows);
assert.equal(parsedProduct.length,2);
assert.equal(parsedProduct[0].sellpia_product_code,'11541');
assert.equal(parsedProduct[0].primary_option_name,'옐로우골드/6mm바[GPA-4-07_2]');
assert.equal(parsedProduct[1].option_price,1000);

const optionRows=[
 ['*쇼핑몰','*계정','*판매자관리코드','온라인 상품명','옵션1 명칭','옵션1 값','추가 금액','판매가능재고','*판매수량'],
 ['에이블리','pink_rocket@naver.com','sellpia_11541','상품','옵션','옐로우골드/6mm바[GPA-4-07_2]','0','0',100]
];
const parsedOption=A.parseOptionRows(optionRows);
assert.equal(parsedOption.length,1);
assert.equal(parsedOption[0].available_stock,0,'stock zero must not become blank');
assert.equal(parsedOption[0].sales_quantity,100,'sales quantity supplies preview and stock target');

const catalog=[
 {sellpia_product_code:'11541',sellpia_sku_code:'11541-1',sellpia_option_name:'옐로우골드/6mm바[GPA-4-07_2]'},
 {sellpia_product_code:'11541',sellpia_sku_code:'11541-2',sellpia_option_name:'로즈골드/6mm바[GPA-4-07_2]'}
];
assert.equal(A.resolveSellpiaSku(parsedOption[0],catalog).sku,'11541-1');
assert.equal(A.resolveSellpiaSku(parsedProduct[1],catalog).sku,'11541-2');
assert.match(A.resolveSellpiaSku({...parsedOption[0],option_candidates:['다른 옵션']},[catalog[0]]).error,/옵션명/,'carrier rows must not fall back to a single SKU when option values do not match exactly');
const mappingItem={...parsedOption[0],seller_product_code:'ABLY-P',seller_option_code:'ABLY-O',option_candidates:['표기가 다른 옵션']};
const mappings=[{product_code:'ABLY-P',option_code:'ABLY-O',sku:'11541-2'}];
assert.deepEqual(JSON.parse(JSON.stringify(A.resolveSellpiaSku(mappingItem,catalog,mappings))),{sku:'11541-2',method:'seller_mapping_exact',row:mappings[0]},'verified seller mapping must win over display-name differences');
assert.match(A.resolveSellpiaSku(mappingItem,catalog,[...mappings,{...mappings[0],sku:'11541-1'}]).error,/여러 SKU/,'ambiguous seller mapping must fail closed');
const productOnlyMappings=[{product_code:'ABLY-P',option_code:'',sku:'11541-1'},{product_code:'ABLY-P',option_code:'',sku:'11541-2'}];
assert.equal(A.resolveSellpiaSku({...parsedOption[0],seller_product_code:'ABLY-P'},catalog,productOnlyMappings).sku,'11541-1','missing seller option identity may use strict option-name fallback within a multiply mapped product');
assert.match(A.resolveSellpiaSku({...parsedOption[0],seller_product_code:'ABLY-P',option_candidates:['없는 옵션']},catalog,productOnlyMappings).error,/여러 SKU/,'unresolved multiply mapped products remain ambiguous');
assert.equal(A.resolveSellpiaSku({...mappingItem,seller_product_code:'NO-MAPPING'},catalog,[]).error.includes('옵션명'),true,'missing mapping falls back to strict option-name matching');
const crossTemplateMappings=[
 {product_code:'ABLY-10000',option_code:'OPT-1',sku:'10000-1'},
 {product_code:'ABLY-10000',option_code:'OPT-2',sku:'10000-2'},
 {product_code:'ABLY-10000',option_code:'OPT-3',sku:'10000-3'}
];
const productTemplate10000={...parsedProduct[1],direct_sellpia_sku_code:'10000-2',seller_product_code:'ABLY-10000',seller_option_code:'OPT-2'};
const optionTemplate10000={...parsedOption[0],sellpia_product_code:'10000',seller_product_code:'ABLY-10000',seller_option_code:'OPT-2',option_sku_code:'',option_candidates:['표기가 달라도 기존 연결 우선']};
assert.equal(A.resolveSellpiaSku(productTemplate10000,[],crossTemplateMappings).sku,'10000-2','price+option carrier resolves the mapped SKU');
assert.equal(A.resolveSellpiaSku(optionTemplate10000,[],crossTemplateMappings).sku,'10000-2','option+stock carrier uses the same seller identity before option text');

const directOptionRows=[
 ['*쇼핑몰','*계정','*판매자관리코드','온라인 상품명','쇼핑몰상품코드','옵션1 명칭','옵션1 값','옵션관리코드','옵션 SKU 코드','추가 금액','판매가능재고','*판매수량'],
 ['에이블리','pink_rocket@naver.com','sellpia_10000','상품','40337964','옵션','별[PM-7-01]','sellpia_10000-1','sellpia_10000-1',0,3,0],
 ['에이블리','pink_rocket@naver.com','sellpia_10000','상품','40337964','옵션','나비(바변경불가)[PM-7-02]','sellpia_10000-2','sellpia_10000-2',0,2,0],
 ['에이블리','pink_rocket@naver.com','sellpia_10000','상품','40337964','옵션','볼[PM-7-03]','sellpia_10000-3','sellpia_10000-3',0,1,0]
];
const directItems=A.parseOptionRows(directOptionRows);
const catalog10000=[
 {sellpia_product_code:'10000',sellpia_sku_code:'10000-1',sellpia_option_name:'별[PM-7-01]'},
 {sellpia_product_code:'10000',sellpia_sku_code:'10000-2',sellpia_option_name:'나비[PM-7-02]'},
 {sellpia_product_code:'10000',sellpia_sku_code:'10000-3',sellpia_option_name:'볼[PM-7-03]'}
];
assert.deepEqual(directItems.map(item=>item.direct_sellpia_sku_code),['10000-1','10000-2','10000-3'],'both option identity columns expose the same explicit sellpia SKU');
assert.deepEqual(directItems.map(item=>A.resolveSellpiaSku(item,catalog10000).method),['direct_sku','direct_sku','direct_sku']);
assert.deepEqual(directItems.map(item=>A.resolveSellpiaSku(item,catalog10000).sku),['10000-1','10000-2','10000-3']);
assert.equal(A.resolveSellpiaSku(directItems[1],catalog10000).sku,'10000-2','explicit direct SKU wins even when the carrier display name contains an operational suffix');

const directConflict=A.parseOptionRows([
 directOptionRows[0],
 [...directOptionRows[1].slice(0,7),'sellpia_10000-1','sellpia_10000-2',0,3,0]
])[0];
assert.match(A.resolveSellpiaSku(directConflict,catalog10000).error,/서로 다른/,'conflicting explicit direct SKU columns must fail closed');
assert.equal(A.resolveSellpiaSku(directConflict,catalog10000).method,'direct_sku_ambiguous');

const missingDirect={...directItems[0],direct_sellpia_sku_code:'10000-9'};
assert.match(A.resolveSellpiaSku(missingDirect,catalog10000).error,/카탈로그/,'unknown direct SKU must be blocked');
const otherProductDirect={...directItems[0],direct_sellpia_sku_code:'99999-1'};
assert.match(A.resolveSellpiaSku(otherProductDirect,[...catalog10000,{sellpia_product_code:'99999',sellpia_sku_code:'99999-1'}]).error,/속하지/,'direct SKU from another product must be blocked');

const directMappingConflict={...directItems[1],seller_option_code:'309683801'};
const mappings10000=[
 {product_code:'40337964',option_code:'309683801',sku:'10000-1'},
 {product_code:'40337964',option_code:'309685687',sku:'10000-2'},
 {product_code:'40337964',option_code:'309683803',sku:'10000-3'}
];
assert.match(A.resolveSellpiaSku(directMappingConflict,catalog10000,mappings10000).error,/충돌/,'direct SKU and verified seller mapping conflict must fail closed');
assert.equal(A.resolveSellpiaSku(directMappingConflict,catalog10000,mappings10000).method,'direct_sku_mapping_conflict');
const numericMappingOnly={...directItems[0],direct_sellpia_sku_code:'',seller_option_code:'309683801',option_sku_code:'',option_candidates:['표기가 달라짐']};
assert.equal(A.resolveSellpiaSku(numericMappingOnly,catalog10000,mappings10000).method,'seller_mapping_exact','numeric Ably option code keeps the existing mapping path');
assert.equal(A.resolveSellpiaSku({...parsedProduct[0],direct_sellpia_sku_code:'',option_candidates:[]},[{sellpia_product_code:'11541',sellpia_sku_code:'11541-1'}]).method,'single_product_sku','optionless single-product behavior remains unchanged');
{
 const stockSource=fs.readFileSync('mockups/operations-hub/ably-stock-export.js','utf8');vm.runInContext(stockSource,context);
 const changes=[],parts=new Map([
  ['xl/workbook.xml','<workbook><sheets><sheet name="쇼핑몰상품" sheetId="1" r:id="rId1"/></sheets></workbook>'],
  ['xl/_rels/workbook.xml.rels','<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'],
  ['xl/worksheets/sheet1.xml','<worksheet><sheetData><row r="6"><c r="I6"><v>30000</v></c><c r="T6" t="inlineStr"><is><t>0\n3500\n9000</t></is></c><c r="U6"><v>99</v></c></row></sheetData></worksheet>'],
  ['xl/styles.xml','<styleSheet/>']
 ]);
 const zip={file(name,value){if(value!==undefined){parts.set(name,value);return this;}return parts.has(name)?{async:async()=>parts.get(name)}:null;},async generateAsync(){return new Blob([parts.get('xl/worksheets/sheet1.xml')]);}};
 context.JSZip={loadAsync:async()=>zip};context.XLSX={read:()=>({Sheets:{쇼핑몰상품:{T6:{v:'0\n3500\n9000'}}}})};
 context.SystemV3SellerExport={applyChangeHighlights:(xml,styles,refs)=>{changes.push(...refs);return {sheetXml:xml,stylesXml:styles};}};
 const edits=[0,1,2].map((index)=>({source_row_no:6,option_index:index,target_base_price:32000,target_option_price:[0,1500,7000][index]}));
 await A.buildProductPriceOption({name:'playauto.xlsx',arrayBuffer:async()=>new ArrayBuffer(1)},edits);
 const xml=parts.get('xl/worksheets/sheet1.xml');
 assert.match(xml,/<c r="I6"[^>]*><v>32000<\/v><\/c>/);assert.match(xml,/0\n1500\n7000/);assert.match(xml,/<c r="U6"><v>99<\/v><\/c>/);
 assert.ok(changes.includes('I6'));assert.equal(changes.filter(change=>change.reference==='T6').length,3);
 const red=[];context.SystemV3SellerExport.applyChangeHighlights=(sheet,styles,refs,options)=>{if(options?.fillColor==='FFFFC7CE')red.push(...refs);return {sheetXml:sheet,stylesXml:styles};};
 await A.buildProductPriceOption({name:'playauto.xlsx',arrayBuffer:async()=>new ArrayBuffer(1)},[{source_row_no:6,option_index:0,_status:'conflict'}]);
 assert.ok(red.includes('I6')&&red.includes('T6'),'blocked PlayAuto row retains original values and is marked red');
}
console.log('PASS Ably PlayAuto templates: existing seller mapping wins, strict option fallback remains, and V/X contract preserves W.');
