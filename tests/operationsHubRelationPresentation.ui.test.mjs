import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {pathToFileURL} from 'node:url';
const app=fs.readFileSync(new URL('../mockups/operations-hub/app.js',import.meta.url),'utf8');
const context={
  normalizeMatrixRelationContext:raw=>raw||{},
  escapeHtml:v=>String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;'),
  clearMatrixCellSelection(){},matrixRowsBySku:new Map(),matrixBody:{innerHTML:''},
  buildSellerBaseMerges:()=>new Map(),buildProductIdentityMerges:()=>new Map(),
  normalizeConnectionStatus:()=> 'connected',sellpiaProductGroupKey:p=>p.sellpia_sku_code.split('-')[0],
  matrixImage:()=>'<span style="display:grid;place-items:center;width:72px;height:56px;background:#eef2f6;color:#94a3b8;border-radius:4px">이미지</span>',
  sellpiaEditor:()=>'',systemOperationalCell:()=>'',inboundCostCell:()=>'',channelInventoryCells:()=>'',formatLiveTime:()=>'',applyColumnVisibility(){},activeView:{}
};
vm.createContext(context);
vm.runInContext(app.slice(app.indexOf('function matrixAppliedTagChips('),app.indexOf('function formatLiveTime(')),context);
vm.runInContext(app.slice(app.indexOf('function matrixRelationContext('),app.indexOf('function inboundCostCell(')),context);
vm.runInContext(app.slice(app.indexOf('function renderLiveMatrixRows('),app.indexOf('function setMatrixConnection(')),context);
const root=(sku,name)=>({sellpia_sku_code:sku,sellpia_product_name:name,matrix_context:{kind:'direct',rootSku:sku}});
const child=(sku,name,direction='bundle_component',depth=1)=>({sellpia_sku_code:sku,sellpia_product_name:name,matrix_context:{kind:'related',rootSku:'10959-1',relationshipFamily:'canonical_bundle',direction,depth,pathSkus:['10959-1',sku]}});
const rows=[root('10959-1','[4개set] 실버925 클로버 투핀 은 피어싱 세트'),child('10897-4','실버 925 물&링 체인 투핀 피어싱 4종'),child('10898-3','실버 925 미니 클로버 피어싱'),child('7274-81','925 실버 컬러 큐빅 피어싱 120종'),child('7296-1','실버925 진주 미니 체인 피어싱','descendant',2),root('10959-2','[4개set] 실버925 클로버 투핀 은 피어싱 세트')];
context.renderLiveMatrixRows(rows);
assert.equal(context.matrixRowsBySku.size,6);
assert.equal((context.matrixBody.innerHTML.match(/class="matrix-related-context-badge"/g)||[]).length,4);
assert.ok(!/<td class="sticky-col sellpia-name-col[^]*?matrix-related-context-badge[^]*?<\/td>/.test(context.matrixBody.innerHTML.split('</tr>')[1].split('sellpia-option-name-col')[0].split('<td class="sticky-col sellpia-name-col')[1]||''),'no duplicate badge under product name');
for(const [direction,label] of [['ancestor','상위'],['descendant','하위'],['bundle_parent','세트'],['bundle_component','구성품'],['seller_bundle_sibling','함께 구성']]){
  const html=context.matrixRelationPathBadge(child('sku','name',direction));
  assert.ok(html.endsWith('↳ '+label+'</em>'));
  assert.match(html,/title="공통 세트/);
  assert.match(html,/10959-1 → sku/);
}
assert.equal(context.matrixRelationPathBadge(root('1','direct')),'');
const {chromium}=await import(pathToFileURL('C:/Users/hihi0/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs'));
const browser=await chromium.launch({channel:'msedge',headless:true});
try{
  const page=await browser.newPage({viewport:{width:1000,height:760}});
  await page.route('**/*',route=>route.abort());
  const css=['style.css','ui-scale-base.css','ui-scale-matrix.css'].map(f=>fs.readFileSync(new URL('../mockups/operations-hub/'+f,import.meta.url),'utf8')).join('\n');
  await page.setContent('<html lang="ko"><head><style>'+css+'</style><style>body{padding:24px}.matrix-table{width:900px}.matrix-table td:nth-child(n+5){display:none}.matrix-table .select-col{display:none}.matrix-table .image-col{width:96px;position:static}.matrix-table .sellpia-sku-col{width:110px;position:static}.matrix-table .sellpia-name-col{width:650px;position:static}</style></head><body><table class="matrix-table"><thead><tr><th style="width:96px">이미지</th><th style="width:110px">SKU</th><th>상품명</th></tr></thead><tbody>'+context.matrixBody.innerHTML+'</tbody></table></body></html>');
  await page.addStyleTag({content:'.matrix-table{min-width:0!important;width:900px!important} .matrix-table .sellpia-name-col{width:650px!important;min-width:0!important;max-width:none!important}'});
  const measurements=await page.locator('tr.matrix-related-context-row').evaluateAll(rows=>rows.map(row=>({
    badgeCount:row.querySelectorAll('.matrix-related-context-badge').length,
    nameBadgeCount:row.querySelector('.sellpia-name-col').querySelectorAll('em').length,
    border:getComputedStyle(row.querySelector('.sellpia-name-col')).borderTopWidth,
    badgeBorder:getComputedStyle(row.querySelector('em')).borderWidth,
    clipped:row.querySelector('em').scrollWidth>row.querySelector('em').clientWidth
  })));
  assert.ok(measurements.every(r=>r.badgeCount===1&&r.nameBadgeCount===0&&r.border==='1px'&&r.badgeBorder==='0px'&&!r.clipped),JSON.stringify(measurements));
  await fs.promises.mkdir(new URL('../outputs/ui-qa/',import.meta.url),{recursive:true});
  await page.screenshot({path:new URL('../outputs/ui-qa/20260908-relation-presentation.png',import.meta.url).pathname.replace(/^\/([A-Za-z]:)/,'$1')});
  console.log('Relation UI: 5 direction labels, preserved details/rows, single SKU label, thin separators, no clipping — browser checks passed');
}finally{await browser.close();}
