import assert from 'node:assert/strict';
import test from 'node:test';
import '../mockups/operations-hub/seller-export-adapter.js';

const apply=globalThis.SystemV3SellerExport.applyChangeHighlights;
const warningRefs=globalThis.SystemV3SellerExport.carrierWarningReferences;
const warningOptions={fillColor:'FFFF0000',preserveText:true};
const styles='<styleSheet><numFmts count="1"><numFmt numFmtId="165" formatCode="#,##0.00;[Red]-#,##0.00"/></numFmts><fonts count="2"><font><name val="맑은 고딕"/><sz val="10"/><color rgb="FF334455"/></font><font><i/><name val="Arial"/><sz val="12"/><color theme="1"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="2"><border/><border><left style="thin"><color rgb="FF123456"/></left></border></borders><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="165" fontId="1" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="right" wrapText="1"/></xf><xf numFmtId="49" fontId="0" fillId="0" borderId="1" xfId="0" applyProtection="1"><protection locked="0"/></xf></cellXfs></styleSheet>';
const cells=[
 '<c r="A2" s="1"><v>2800.00</v></c>',
 '<c r="B2" s="2" t="s"><v>4</v></c>',
 '<c r="C2" s="2" t="inlineStr"><is><r><rPr><i/><color rgb="FF123456"/><rFont val="Arial"/></rPr><t xml:space="preserve">첫째 &amp; 값&#xa;</t></r><r><rPr><b/><u/></rPr><t>나비 [PM-7-02]</t></r></is></c>',
 '<c r="D2" s="1"><f t="shared" si="0" ref="D2:D3">A2*2</f><v>5600</v></c>',
 '<c r="E2" s="2"/>',
 '<c r="F2"/>',
 '<c r="G2" s="1"><v>777</v></c>',
 '<c r="H2" t="inlineStr"><is><t xml:space="preserve"> untouched &lt;text&gt; </t></is></c>'
];
const prefix='<worksheet><sheetFormatPr defaultRowHeight="15"/><sheetData><row r="2" ht="21" hidden="1">';
const suffix='</row></sheetData><mergeCells count="1"><mergeCell ref="J2:K2"/></mergeCells><autoFilter ref="A1:H2"/></worksheet>';
const sheet=prefix+cells.join('')+suffix;

function section(xml,tag){return xml.match(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`))?.[0];}
function nodes(xml,tag){return [...String(xml).matchAll(new RegExp(`<${tag}\\b[^>]*?(?:\\/>|>[\\s\\S]*?<\\/${tag}>)`,'g'))].map(match=>match[0]);}
function cell(xml,reference){return xml.match(new RegExp(`<c\\b(?=[^>]*\\br="${reference}")[^>]*?(?:\\/>|>[\\s\\S]*?<\\/c>)`))?.[0];}
function attr(xml,name){return xml.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];}
function withoutStyle(cellXml){return cellXml.replace(/^<c\b[^>]*>/,opening=>opening.replace(/\s+s="[^"]*"/,''));}
function xfFor(result,reference){const id=Number(attr(cell(result.sheetXml,reference),'s')||0);return nodes(section(result.stylesXml,'cellXfs'),'xf')[id];}
function fillFor(result,reference){const xf=xfFor(result,reference);return nodes(section(result.stylesXml,'fills'),'fill')[Number(attr(xf,'fillId')||0)];}

test('warning red fill changes only cell style attributes while preserving original values and cell XML bodies',()=>{
 const result=apply(sheet,styles,['A2','B2','C2','D2','E2','F2'],warningOptions);
 assert.match(result.stylesXml,/<fgColor rgb="FFFF0000"\/>/);
 for(const reference of ['A2','B2','C2','D2','E2','F2']){
  assert.equal(withoutStyle(cell(result.sheetXml,reference)),withoutStyle(cell(sheet,reference)),`${reference}: original value/type/formula/text must be byte-preserved`);
  assert.match(fillFor(result,reference),/<fgColor rgb="FFFF0000"\/>/);
 }
 assert.equal(cell(result.sheetXml,'G2'),cells[6],'unselected numeric cell is exactly unchanged');
 assert.equal(cell(result.sheetXml,'H2'),cells[7],'unselected inline text cell is exactly unchanged');
 assert.ok(result.sheetXml.startsWith(prefix));
 assert.ok(result.sheetXml.endsWith(suffix));
 assert.match(cell(result.sheetXml,'E2'),/\/>$/,'selected self-closing blank remains a self-closing cell');
 assert.match(cell(result.sheetXml,'F2'),/\/>$/);
});

test('warning fill preserves fonts, custom number formats, borders, alignment and protection',()=>{
 const result=apply(sheet,styles,['A2','B2','C2','D2','E2','F2'],warningOptions);
 for(const tag of ['fonts','numFmts','borders'])assert.equal(section(result.stylesXml,tag),section(styles,tag),`${tag} cannot change for preserveText warning fill`);
 const originalXfs=nodes(section(styles,'cellXfs'),'xf');
 for(const reference of ['A2','B2','C2','D2','E2','F2']){
  const base=originalXfs[Number(attr(cell(sheet,reference),'s')||0)],derived=xfFor(result,reference);
  for(const attribute of ['fontId','numFmtId','borderId','xfId','applyNumberFormat','applyAlignment','applyProtection'])assert.equal(attr(derived,attribute),attr(base,attribute),`${reference}: ${attribute} must be preserved`);
  assert.equal(derived.match(/<alignment\b[^>]*\/>/)?.[0],base.match(/<alignment\b[^>]*\/>/)?.[0]);
  assert.equal(derived.match(/<protection\b[^>]*\/>/)?.[0],base.match(/<protection\b[^>]*\/>/)?.[0]);
 }
 assert.equal((result.stylesXml.match(/fgColor rgb="FFFF0000"/g)||[]).length,1,'same warning fill is reused across all selected cells');
});

test('partial-line warning refs preserve all inline rich text runs and shared-string indices',()=>{
 const result=apply(sheet,styles,[{reference:'C2',lineIndex:1},{reference:'B2',lineIndex:0}],warningOptions);
 assert.equal(withoutStyle(cell(result.sheetXml,'C2')),withoutStyle(cells[2]),'warning cannot rebuild runs or make source text bold');
 assert.equal(withoutStyle(cell(result.sheetXml,'B2')),withoutStyle(cells[1]),'shared string index and t="s" are preserved');
 assert.equal(section(result.stylesXml,'fonts'),section(styles,'fonts'));
 assert.equal(cell(result.sheetXml,'D2'),cells[3],'unselected formula cell is exactly unchanged');
});

test('red warning pass leaves safe yellow highlights intact and wins for overlapping refs',()=>{
 const yellow=apply(sheet,styles,['A2','C2','D2']);
 const result=apply(yellow.sheetXml,yellow.stylesXml,['B2','C2'],warningOptions);
 assert.equal(cell(result.sheetXml,'A2'),cell(yellow.sheetXml,'A2'),'safe numeric yellow highlight is untouched');
 assert.equal(cell(result.sheetXml,'D2'),cell(yellow.sheetXml,'D2'),'safe formula yellow highlight is untouched');
 assert.match(fillFor(result,'A2'),/<fgColor rgb="FFFFFF00"\/>/);
 assert.match(fillFor(result,'D2'),/<fgColor rgb="FFFFFF00"\/>/);
 assert.match(fillFor(result,'B2'),/<fgColor rgb="FFFF0000"\/>/);
 assert.match(fillFor(result,'C2'),/<fgColor rgb="FFFF0000"\/>/,'overlapping warning has red priority');
 assert.equal(withoutStyle(cell(result.sheetXml,'C2')),withoutStyle(cell(yellow.sheetXml,'C2')),'red pass preserves the pre-existing highlighted rich text body');
 assert.equal(attr(xfFor(result,'C2'),'fontId'),attr(xfFor(yellow,'C2'),'fontId'));
 assert.equal(section(result.stylesXml,'fonts'),section(yellow.stylesXml,'fonts'),'warning pass does not alter or add fonts');
 assert.equal(cell(result.sheetXml,'G2'),cells[6]);
 assert.equal(cell(result.sheetXml,'H2'),cells[7]);
});

test('duplicate warning refs do not duplicate fills or change originals, empty refs are an exact no-op',()=>{
 const result=apply(sheet,styles,['A2','A2',{reference:'A2',lineIndex:1}],warningOptions);
 assert.equal((result.stylesXml.match(/fgColor rgb="FFFF0000"/g)||[]).length,1);
 assert.equal(withoutStyle(cell(result.sheetXml,'A2')),withoutStyle(cells[0]));
 assert.deepEqual(apply(sheet,styles,[],warningOptions),{sheetXml:sheet,stylesXml:styles});
});

test('price-only warnings leave independent stock cells available for yellow change highlighting',()=>{
 assert.deepEqual(warningRefs('smartstore',{source_row_no:7,option_code:'O',warning_field:'price'}),['F7','BF7','BG7','R7']);
 assert.equal(warningRefs('smartstore',{source_row_no:7,option_code:'O',warning_field:'price'}).includes('S7'),false,'Smartstore stock S must not be painted red by a price warning');
 assert.deepEqual(warningRefs('makeshop',{source_row_no:8,product_code:'P',option_code:'O',warning_field:'price'},new Map([['P',3]])),['AF8','AS3','DD3','AT3']);
 assert.equal(warningRefs('makeshop',{source_row_no:8,product_code:'P',option_code:'O',warning_field:'price'},new Map([['P',3]])).includes('AG8'),false,'Makeshop stock AG must not be painted red by a price warning');
 assert.ok(warningRefs('smartstore',{source_row_no:7,option_code:'O'}).includes('S7'),'identity-wide warnings still mark the stock cell');
});
