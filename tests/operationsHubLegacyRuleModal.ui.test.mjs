import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';

const root=new URL('../mockups/operations-hub/',import.meta.url),html=await readFile(new URL('index.html',root),'utf8');
const legacy=html.slice(html.indexOf('<div id="price-rules"'),html.indexOf('<div id="jobs"'));
const browser=await chromium.launch({channel:'msedge',headless:true});
try{
 const page=await browser.newPage({viewport:{width:1440,height:1000}});await page.route('**/*',route=>route.abort());
 await page.setContent(legacy+'<div id="toast"></div>');
 await page.addStyleTag({path:fileURLToPath(new URL('rule-workspace.css',root))});
 await page.evaluate(()=>{
  window.qa={legacyReads:0};
  window.SystemV3Data={
   ruleRegistry:async()=>({rules:[{id:'formula-1',tag_id:'tag-1',name:'판매가 +2,000원 · 스마트스토어',version:1,is_active:true,target_field:'platform_registration_price',scope:'smartstore',input_origin:'self',source_field:'source_base_price',source_scope:'',config:{steps:[{op:'add',value:2000}]}}],assignments:[],dependencies:[]}),
   loadTags:async()=>[{tag_id:'tag-1',tag_name:'판매가 +2,000원',tag_color:'#2f6fd1',tag_group:'가격 수식'}],
   loadPriceRuleTags:async()=>{qa.legacyReads++;return[];},
   loadInboundCostFormulaTags:async()=>{qa.legacyReads++;return[];}
  };
 });
 for(const file of ['rule-registry.js','rule-workspace.js'])await page.addScriptTag({path:fileURLToPath(new URL(file,root))});
 await page.evaluate(()=>HubPriceWorkspace.refresh());await page.waitForFunction(()=>!HubPriceWorkspace.state.busy);
 assert.equal(await page.locator('#rw-legacy-open').count(),0,'legacy editor entry is removed');
 assert.equal(await page.locator('#rw-legacy-backdrop').count(),0,'legacy editor modal is removed');
 assert.equal(await page.locator('.rw-legacy').isVisible(),false,'old form nodes remain inert and hidden for compatibility');
 assert.equal(await page.evaluate(()=>qa.legacyReads),0,'new workspace never reads legacy formula tables');
 assert.equal(await page.locator('#rw-list [data-rule="formula-1"]').count(),1);
 assert.match(await page.locator('#rw-list').innerText(),/판매가 \+2,000원/);
 await page.locator('#rw-legacy-load').click();await page.waitForFunction(()=>!HubPriceWorkspace.state.busy);
 assert.equal(await page.evaluate(()=>qa.legacyReads),0,'formula tag refresh only reloads the unified registry');
 assert.equal(await page.locator('#rw-legacy-rules option').filter({hasText:'판매가 +2,000원'}).count(),1);
 console.log('PASS legacy editor is no longer exposed; old DOM is inert; formula list and step picker read only unified formula tags.');
}finally{await browser.close();}
