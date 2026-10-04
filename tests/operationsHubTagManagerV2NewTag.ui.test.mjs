import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {fileURLToPath} from 'node:url';

const root=new URL('../mockups/operations-hub/',import.meta.url);
const browser=await chromium.launch({channel:'msedge',headless:true});
try{
  const page=await browser.newPage({viewport:{width:1280,height:900}});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.setContent('<main id="attributes"><div class="attributes-title"></div><div class="attributes-quick-actions"></div><div class="attributes-layout"></div></main>');
  await page.addStyleTag({path:fileURLToPath(new URL('tag-management-v2.css',root))});
  await page.evaluate(()=>{
    window.qa={created:[],formulaDrafts:[],tagImports:[],renamed:[],saved:[],calculations:[],searchReads:[],policySaves:[],policyReads:[],policyDocs:{
      policy:{id:'policy-policy',title:'carrier-policy:tag:policy',version:1,body:{version:1,carriers:{ably:{representativeStrategy:'lowest'}}}},
      both:{id:'policy-both',title:'carrier-policy:tag:both',version:1,body:{version:1,carriers:{ably:{representativeStrategy:'lower_middle'}}}}
    },applied:[{sellpia_sku_code:'applied-1',own_sku:'OWN-1',sellpia_product_name:'기존 상품',sellpia_option_name:'블랙'}],catalog:[
      {tag_id:'plain',tag_name:'귀걸이',tag_color:'#eeeeee',tag_group:'운영',rule_count:0,option_count:3},
      {tag_id:'formula',tag_name:'소스_2000',tag_color:'#dbeafe',tag_group:'가격 수식',rule_count:2,option_count:0},
      {tag_id:'policy',tag_name:'에이블리_최저',tag_color:'#dcfce7',tag_group:'운영',rule_count:0,option_count:1},
      {tag_id:'both',tag_name:'공용_정책',tag_color:'#ede9fe',tag_group:'가격 수식',rule_count:1,option_count:1}
    ]};
    window.SystemV3Data={
      loadTagCatalog:async()=>({rows:structuredClone(qa.catalog)}),
      loadTagMembers:async()=>({rows:structuredClone(qa.applied),count:qa.applied.length}),
      loadTagMemberSearch:async payload=>{qa.searchReads.push(structuredClone(payload));return {rows:[{sellpia_sku_code:'applied-1',tag_applied:true},{sellpia_sku_code:'new-2',sellpia_product_name:'추가 상품',sellpia_option_name:'실버',tag_applied:false}],count:2};},
      saveProductProfile:async payload=>{qa.saved.push(structuredClone(payload));qa.applied.push({sellpia_sku_code:payload.sku,sellpia_product_name:'추가 상품',sellpia_option_name:'실버'});qa.catalog.find(tag=>tag.tag_id==='formula').option_count=qa.applied.length;return {};},
      ensureProductProfile:async()=>({sku_tags:[],product_tags:[]}),
      renameProductTag:async payload=>{qa.renamed.push(structuredClone(payload));const tag=qa.catalog.find(item=>item.tag_id===payload.id);
        if(payload.expectedName!==tag.tag_name)throw Error('다른 화면에서 수정되었습니다.');tag.tag_name=payload.name;return structuredClone(tag);},
      ruleRegistry:async()=>({rules:[{id:'formula-rule',tag_id:'formula',name:'소스_2000',scope:'smartstore',target_field:'platform_registration_price',source_field:'source_base_price',config:{steps:[{op:'add',value:2000},{op:'round',unit:1,rounding:'nearest'}]}},{id:'makeshop-rule',tag_id:'formula',name:'메이크샵 M15',scope:'makeshop',source_scope:'makeshop',target_field:'platform_discount_price',source_field:'platform_registration_price',config:{discount_mode:'makeshop_code',discount_rule_code:'M15',steps:[{op:'multiply',value:.85},{op:'round',unit:10,rounding:'down'}]}},{id:'both-rule',tag_id:'both',name:'공용 Rule',scope:'ably',target_field:'platform_registration_price',source_field:'source_base_price',config:{steps:[]}}],assignments:[],dependencies:[]}),
      loadAblyCarrierPolicy:async tagId=>{qa.policyReads.push(tagId);return qa.policyDocs[tagId]?structuredClone(qa.policyDocs[tagId]):null;},
      saveAblyCarrierPolicy:async payload=>{qa.policySaves.push(structuredClone(payload));qa.policyDocs[payload.tagId]={id:'policy-'+payload.tagId,title:'carrier-policy:tag:'+payload.tagId,version:1,body:{version:1,carriers:payload.strategy?{ably:{representativeStrategy:payload.strategy}}:{}}};return {id:'policy-'+payload.tagId,version:1};},
      createProductTag:async payload=>{qa.created.push(structuredClone(payload));const tag={tag_id:'created-'+qa.created.length,tag_name:payload.name,tag_color:payload.color,tag_group:payload.group,rule_count:0,option_count:0};qa.catalog.push(tag);return structuredClone(tag);}
    };
    window.HubPriceWorkspace={openForTag:async tag=>qa.formulaDrafts.push(structuredClone(tag)),openTagImport:options=>qa.tagImports.push(structuredClone(options))};
    window.HubPriceMaterializer={materialize:async payload=>{qa.calculations.push(structuredClone(payload));return {totalSkus:payload.skus.length};}};
  });
  await page.addScriptTag({path:fileURLToPath(new URL('rule-registry.js',root))});
  await page.addScriptTag({path:fileURLToPath(new URL('tag-management-v2.js',root))});
  await page.waitForSelector('[data-tag-view="tag"]');await page.locator('[data-tag-view="tag"]').click();await page.waitForFunction(()=>document.querySelectorAll('#tag-catalog [data-tag-id]').length===4);
  assert.equal(await page.evaluate(()=>qa.policyReads.length),0,'catalog does not fetch carrier policy documents tag by tag');

  assert.equal(await page.locator('#tag-upload-sync').isEnabled(),true,'tag upload stays available without selecting a tag');
  await page.locator('#tag-upload-sync').click();
  assert.deepEqual(await page.evaluate(()=>qa.tagImports[0]),{openFilePicker:true,tagId:null});

  await page.locator('[data-tag-kind="plain"]').click();assert.equal(await page.locator('#tag-catalog [data-tag-id]').count(),2);assert.match(await page.locator('#tag-catalog').innerText(),/귀걸이\s*MATRIX · 가격 계산 없음/);
  await page.locator('[data-tag-id="plain"]').click();await page.waitForFunction(()=>document.getElementById('tag-ably-policy')?.value==='');
  assert.match(await page.locator('#tag-selected-name').innerText(),/일반 태그/);assert.doesNotMatch(await page.locator('#tag-selected-name').innerText(),/MATRIX|ABLY EXPORT/);

  await page.locator('[data-tag-kind="formula"]').click();assert.equal(await page.locator('#tag-catalog [data-tag-id]').count(),2);assert.match(await page.locator('#tag-catalog').innerText(),/소스_2000[\s\S]*MATRIX · 가격 계산/);
  await page.locator('[data-tag-kind="plain"]').click();
  await page.locator('[data-tag-id="policy"]').click();await page.waitForFunction(()=>document.getElementById('tag-ably-policy')?.value==='lowest');
  assert.match(await page.locator('#tag-selected-name').innerText(),/ABLY EXPORT · 대표가 최저/);assert.doesNotMatch(await page.locator('#tag-selected-name').innerText(),/MATRIX|일반 태그/);
  assert.match(await page.locator('[data-tag-id="policy"]').innerText(),/ABLY EXPORT · 대표가 최저/,'selected policy is cached for catalog display without a bulk N+1 read');
  await page.locator('[data-tag-kind="all"]').click();
  await page.locator('[data-tag-id="both"]').click();await page.waitForFunction(()=>document.getElementById('tag-ably-policy')?.value==='lower_middle');
  const bothBadges=await page.locator('#tag-selected-name').innerText();assert.match(bothBadges,/MATRIX · 가격 계산/);assert.match(bothBadges,/ABLY EXPORT · 대표가 중간/);
  await page.evaluate(()=>{qa.catalog.find(tag=>tag.tag_id==='both').rule_count=0;dispatchEvent(new CustomEvent('hub-rules-changed'));});
  await page.waitForFunction(()=>!document.getElementById('tag-selected-name').textContent.includes('MATRIX'));
  assert.match(await page.locator('#tag-selected-name').innerText(),/ABLY EXPORT · 대표가 중간/,'price Rule removal leaves the independent carrier policy intact');
  assert.equal(await page.evaluate(()=>qa.policySaves.length),0,'price Rule refresh must not rewrite carrier policy storage');
  await page.evaluate(()=>{qa.catalog.find(tag=>tag.tag_id==='both').rule_count=1;dispatchEvent(new CustomEvent('hub-rules-changed'));});
  await page.waitForFunction(()=>document.getElementById('tag-selected-name').textContent.includes('MATRIX'));

  await page.locator('[data-tag-kind="formula"]').click();
  await page.locator('[data-tag-id="formula"]').click();await page.waitForFunction(()=>document.querySelectorAll('.tag-rule-formula').length===2);
  assert.match(await page.locator('#tag-selected-name').innerText(),/MATRIX · 가격 계산/);assert.doesNotMatch(await page.locator('#tag-selected-name').innerText(),/ABLY EXPORT/);
  assert.match(await page.locator('.tag-rule-formula').nth(0).innerText(),/계산식\s*셀피아 기준가격 → \+ 2,000원 → 1 단위 반올림/);
  assert.match(await page.locator('.tag-rule-result').nth(0).innerText(),/결과 → 판매처 등록가/);
  assert.match(await page.locator('.tag-rule-formula').nth(1).innerText(),/계산식\s*메이크샵 · 판매처 등록가 → × 0.85 → 10 단위 내림/);
  assert.match(await page.locator('.tag-rule-item-head').nth(1).innerText(),/메이크샵 M15 · M15/);
  assert.equal(await page.locator('#tag-stat-count').innerText(),'1','live member count is the selected tag count source');
  await page.locator('#tag-ably-policy').selectOption('lower_middle');await page.locator('#tag-ably-policy-save').click();await page.waitForFunction(()=>qa.policySaves.length===1);
  assert.deepEqual(await page.evaluate(()=>qa.policySaves[0]),{tagId:'formula',strategy:'lower_middle',document:null});
  assert.match(await page.locator('#tag-selected-name').innerText(),/ABLY EXPORT · 대표가 중간/);
  assert.match(await page.locator('#tag-ably-policy-help').innerText(),/다운로드는 차단/);

  await page.locator('#tag-ably-policy').selectOption('preserve_existing_base');await page.locator('#tag-ably-policy-save').click();await page.waitForFunction(()=>qa.policySaves.length===2);
  assert.equal(await page.evaluate(()=>qa.policySaves[1].strategy),'preserve_existing_base');
  assert.equal(await page.evaluate(()=>qa.policySaves[1].document.body.carriers.ably.representativeStrategy),'lower_middle','policy edits reuse the existing work document');
  assert.match(await page.locator('#tag-selected-name').innerText(),/ABLY EXPORT · 기존 I 유지/);
  await page.locator('#tag-ably-policy').selectOption('lowest');await page.locator('#tag-ably-policy-save').click();await page.waitForFunction(()=>qa.policySaves.length===3);
  assert.equal(await page.evaluate(()=>qa.policySaves[2].strategy),'lowest');
  assert.match(await page.locator('#tag-selected-name').innerText(),/ABLY EXPORT · 대표가 최저/);
  assert.equal(await page.evaluate(()=>qa.calculations.length),0,'carrier policy saves must not recalculate or replace price Rules');

  await page.locator('[data-tag-kind="all"]').click();await page.locator('[data-tag-id="plain"]').click();await page.locator('[data-tag-id="formula"]').click();
  await page.waitForFunction(()=>document.getElementById('tag-ably-policy')?.value==='lowest');
  assert.match(await page.locator('#tag-selected-name').innerText(),/ABLY EXPORT · 대표가 최저/,'saved policy survives tag reload');
  await page.locator('#tag-ably-policy').selectOption('');await page.locator('#tag-ably-policy-save').click();await page.waitForFunction(()=>qa.policySaves.length===4);
  assert.equal(await page.evaluate(()=>qa.policySaves[3].strategy),'');
  assert.equal(await page.locator('#tag-selected-name').innerText().then(text=>text.includes('ABLY EXPORT ·')),false,'inherit removes the explicit Ably badge');
  assert.match(await page.locator('#tag-selected-name').innerText(),/MATRIX · 가격 계산/,'policy deletion keeps the independent Matrix badge');
  assert.match(await page.locator('#tag-ably-policy-help').innerText(),/legacy fallback/);
  assert.equal(await page.evaluate(()=>qa.calculations.length),0,'returning to inheritance must leave price Rules untouched');

  page.once('dialog',dialog=>dialog.accept('소스_2500'));
  await page.locator('#tag-rename').click();await page.waitForFunction(()=>qa.renamed.length===1);
  assert.equal((await page.locator('#tag-selected-name').innerText()).includes('소스_2500'),true);
  assert.deepEqual(await page.evaluate(()=>qa.renamed[0]),{id:'formula',name:'소스_2500',expectedName:'소스_2000'});
  assert.equal(await page.evaluate(()=>qa.calculations.length),0,'rename must not recalculate or replace Rule identity');
  await page.locator('[data-tag-kind="all"]').click();await page.locator('[data-tag-id="plain"]').click();await page.locator('[data-tag-id="formula"]').click();
  await page.waitForFunction(()=>document.getElementById('tag-selected-name').textContent.includes('소스_2500'));
  await page.locator('#tag-member-query').fill('new-2');await page.locator('#tag-member-search button[type="submit"]').click();await page.waitForFunction(()=>document.querySelectorAll('[data-tag-member]').length===2);
  assert.deepEqual(await page.evaluate(()=>qa.searchReads[0]),{tagId:'formula',page:1,pageSize:100,search:'new-2'});
  await page.locator('[data-tag-member="new-2"]').check();assert.equal(await page.locator('#tag-apply-selected').isEnabled(),true);
  await page.locator('#tag-apply-selected').click();await page.waitForFunction(()=>qa.saved.length===1);
  assert.deepEqual(await page.evaluate(()=>qa.saved[0].skuTagIds),['formula']);
  assert.deepEqual(await page.evaluate(()=>qa.calculations[0]),{skus:['new-2'],sources:['smartstore','makeshop','ably'],reason:'tag-manager-apply'});
  await page.waitForFunction(()=>document.getElementById('tag-stat-count')?.textContent==='2');
  assert.equal(await page.locator('#tag-stat-count').innerText(),'2','tag count refreshes from DB after direct apply');

  await page.locator('#tag-new-open').click();await page.locator('#tag-new-name').fill('목걸이');await page.locator('#tag-new-save').click();await page.waitForFunction(()=>qa.created.length===1);
  assert.deepEqual(await page.evaluate(()=>qa.created[0]),{name:'목걸이',color:'#dbeafe',group:'운영'});

  await page.locator('#tag-new-open').click();await page.locator('#tag-new-name').fill('에이블리_1000');await page.locator('#tag-new-formula').check();await page.locator('#tag-new-save').click();await page.waitForFunction(()=>qa.formulaDrafts.length===1);
  assert.equal(await page.evaluate(()=>qa.created.length),1,'formula draft must not create an orphan plain tag');
  assert.deepEqual(await page.evaluate(()=>qa.formulaDrafts[0]),{name:'에이블리_1000',color:'#dbeafe',group:'가격 수식'});
  assert.deepEqual(errors,[]);
  console.log('PASS tag manager filters tags, edits Ably carrier policy, shows separate badges, and preserves existing tag/formula workflows.');
}finally{await browser.close();}
