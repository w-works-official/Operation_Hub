import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {fileURLToPath} from 'node:url';
const root=new URL('../mockups/operations-hub/',import.meta.url),browser=await chromium.launch({channel:'msedge',headless:true});
try{
 const page=await browser.newPage({viewport:{width:1440,height:900}});await page.route('**/*',r=>r.abort());await page.setContent('<html><body><main id="price-rules"></main></body></html>');
 await page.addStyleTag({path:fileURLToPath(new URL('rule-workspace.css',root))});
 await page.evaluate(()=>{
  const copy=v=>structuredClone(v);window.qa={registry:{rules:[],assignments:[],dependencies:[]},groupCalls:[],singleCalls:[],filterCalls:[],storedCalls:[],defer:false};
  window.SystemV3Data={
   ruleRegistry:async(action,rule)=>{if(action==='list')return copy(qa.registry);qa.singleCalls.push(copy(rule));const saved={...rule,version:2};qa.registry.rules=qa.registry.rules.map(r=>r.id===saved.id?saved:r);return copy(saved);},
   savePlatformRuleGroup:async rule=>{qa.groupCalls.push(copy(rule));if(qa.defer)await new Promise(resolve=>qa.release=resolve);if(qa.registry.rules.some(r=>r.name===rule.name))throw Error('같은 이름의 규칙이 이미 있습니다.');const saved=['smartstore','makeshop','ably'].map(scope=>({...copy(rule),id:scope+'-'+qa.groupCalls.length,scope,source_scope:HubRuleRegistry.isPlatform(rule.source_field)?rule.source_scope||scope:'',version:1,is_active:true}));qa.registry.rules.push(...saved);return copy(saved);},
   loadFormulaProducts:async()=>[],loadLatestSellerOriginalStatus:async()=>[{source:'ably',available:true,files:[{name:'latest.xlsx'}]}],downloadLatestSellerOriginals:async()=>new Map([['ably',[new File(['fixture'],'latest.xlsx')]]]),workDocument:async()=>[],
   filterRulePlatformSkus:async(skus,source)=>{qa.filterCalls.push({count:skus.length,source,crossPlatform:skus.some(s=>s.startsWith('makeshop-')||s.startsWith('smartstore-'))});return ['linked-1'];}
  };
  window.HubPlatformRules={calculate:async()=>({rows:[],errors:[]})};
  window.HubPriceMaterializer={materialize:async({skus})=>({totalSkus:skus.length,persistedRows:0,errorRows:0,status:'complete'})};
  window.HubCurrentPriceExport={refreshItems:async(items,files,{sources,skus})=>{qa.storedCalls.push({skus,sources});return {items:[],excludedItems:[]};}};
 });
 for(const name of ['rule-registry.js','rule-workspace.js'])await page.addScriptTag({path:fileURLToPath(new URL(name,root))});
 const idle=()=>page.waitForFunction(()=>!HubPriceWorkspace.state.busy);
 await page.evaluate(()=>HubPriceWorkspace.refresh());await idle();
 const prepare=async(name,source='source_base_price')=>{await page.locator('#rw-new').click();await page.locator('#rw-name').fill(name);await page.locator('#rw-target').selectOption('platform_registration_price');await page.locator('#rw-source-field').selectOption(source);await page.locator('#rw-add-op').click();};
 const userName='기준가격 그대로 상품판매가';await prepare(userName);
 assert.equal(await page.locator('#rw-scope').inputValue(),'');assert.equal(await page.locator('#rw-scope option:checked').innerText(),'전체판매처(스마트스토어·메이크샵·에이블리)');
 await page.evaluate(()=>{qa.defer=true;});await page.locator('#rw-save').click();await page.waitForFunction(()=>document.getElementById('rw-save').getAttribute('aria-busy')==='true');
 assert.equal(await page.locator('#rw-save').isDisabled(),true);assert.equal(await page.locator('#rw-name').isDisabled(),true);assert.match(await page.locator('#rw-save-status').innerText(),/함께 저장/);assert.equal(await page.evaluate(()=>qa.registry.rules.length),0);
 await page.evaluate(()=>{qa.defer=false;qa.release();});await idle();
 assert.equal(await page.locator('#rw-list [data-rule]').count(),3);assert.match(await page.locator('#rw-save-status').innerText(),/전체판매처 저장 완료/);
 assert.deepEqual(await page.evaluate(()=>qa.registry.rules.map(r=>[r.name,r.scope,r.target_field,r.source_field,r.config.steps])),['smartstore','makeshop','ably'].map(scope=>[userName,scope,'platform_registration_price','source_base_price',[{op:'add',value:0}]]));
 assert.equal(await page.evaluate(()=>qa.groupCalls.length),1);assert.equal(await page.evaluate(()=>qa.singleCalls.length),0);
 // Existing platform rule edits retain their independent scope and normal save API.
 assert.equal(await page.locator('#rw-scope option[value=""]').count(),0);await page.locator('.rw-op input').fill('100');await page.locator('#rw-save').click();await idle();assert.equal(await page.evaluate(()=>qa.singleCalls.length),1);assert.equal(await page.evaluate(()=>qa.groupCalls.length),1);
 await prepare(userName);await page.locator('#rw-save').click();await idle();
 assert.match(await page.locator('#rw-save-status').innerText(),/같은 이름/);assert.equal(await page.locator('#rw-name').inputValue(),userName);assert.equal(await page.locator('#rw-scope').inputValue(),'');assert.equal(await page.locator('.rw-op input').inputValue(),'0');assert.equal(await page.locator('#rw-save').isDisabled(),false);assert.equal(await page.evaluate(()=>qa.registry.rules.length),3);
 const geometry=await page.evaluate(()=>{const b=document.getElementById('rw-save').getBoundingClientRect(),e=document.getElementById('rw-save-status').getBoundingClientRect();return {distance:e.top-b.bottom,height:e.height,visible:e.bottom<=innerHeight};});assert.ok(geometry.distance<45&&geometry.height>0&&geometry.visible,'error stays visible next to save button');
 await page.locator('#rw-name').fill('플랫폼 입력을 각 판매처에서 참조');await page.locator('#rw-source-field').selectOption('platform_final_price');assert.equal(await page.locator('#rw-source-scope').inputValue(),'');await page.locator('#rw-save').click();await idle();
 assert.deepEqual(await page.evaluate(()=>qa.registry.rules.slice(3).map(r=>[r.scope,r.source_scope])),[['smartstore','smartstore'],['makeshop','makeshop'],['ably','ably']]);
 await prepare('missing atomic API');await page.evaluate(()=>{qa.groupApi=SystemV3Data.savePlatformRuleGroup;delete SystemV3Data.savePlatformRuleGroup;});await page.locator('#rw-save').click();await idle();assert.match(await page.locator('#rw-save-status').innerText(),/전체판매처 저장 기능/);assert.equal(await page.locator('#rw-name').inputValue(),'missing atomic API');assert.equal(await page.evaluate(()=>qa.singleCalls.length),1,'missing atomic API must never fall back to partial single saves');
 await page.evaluate(()=>{SystemV3Data.savePlatformRuleGroup=qa.groupApi;qa.registry.assignments=Array.from({length:80000},(_,i)=>{const scope=['','ably','makeshop','smartstore'][i%4];return {sku:(scope||'common')+'-'+i,scope,rule_id:'no-rendered-rule'};});HubPriceWorkspace.state.registry=qa.registry;});
 await page.locator('.rw-tabs [data-tab="export"]').click();await page.locator('#rw-export-scope').selectOption('assigned');await page.locator('#rw-export-preview').click();await idle();
 assert.deepEqual(await page.evaluate(()=>qa.filterCalls),[{count:40000,source:'ably',crossPlatform:false}]);assert.deepEqual(await page.evaluate(()=>qa.storedCalls),[{skus:['linked-1'],sources:['ably']}]);
 console.log('PASS user exact all-platform +0 rule save -> atomic3 definitions; source scope per platform; single edit unchanged; loading/duplicate/missing API preserve inputs with visible errors;80000 assignment sourcefilter reduces40000 then reads linked-only stored prices.');
}finally{await browser.close();}
