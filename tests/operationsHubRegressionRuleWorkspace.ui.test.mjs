import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const browser=await chromium.launch({channel:'msedge',headless:true});
const errors=[];
try{
 const page=await browser.newPage({viewport:{width:1440,height:900}});
 page.on('pageerror',error=>errors.push(error.message));
 await page.route('**/*',route=>route.abort());
 await page.setContent('<html><head><style>body{font-family:Arial;margin:20px}.btn{padding:6px 10px}</style></head><body><div id="attributes" hidden></div><main id="price-rules"></main></body></html>');
 await page.addStyleTag({path:path.join(root,'mockups/operations-hub/rule-workspace.css')});
 await page.evaluate(()=>{window.XLSX={read(bytes){const rows=new TextDecoder().decode(bytes).replace(/^\ufeff/,'').trimEnd().split(/\r?\n/).map(line=>line.split(','));return {SheetNames:['Sheet1'],Sheets:{Sheet1:rows}};},utils:{sheet_to_json:sheet=>sheet,decode_range:()=>({s:{r:0,c:0},e:{r:0,c:1}}),encode_range:range=>`A1:B${range.e.r+1}`,aoa_to_sheet:rows=>rows,book_append_sheet(book,sheet,name){book.SheetNames.push(name);book.Sheets[name]=sheet;}}};});
 await page.evaluate(()=>{
  const copy=v=>structuredClone(v);
  const rule=(id,target,source,steps,extra={})=>({id,tag_id:'tag-'+id,name:id,version:1,is_active:true,target_field:target,source_field:source,input_origin:'self',scope:'',config:{steps},...extra});
  const q=window.qa={calls:[],writes:[],purchase:5000,stored:{},internal:{},registry:{rules:[
   rule('inbound','actual_inbound_cost','purchase_price',[{op:'multiply',value:1}]),
   rule('base','calculated_base_price','actual_inbound_cost',[{op:'multiply',value:3}]),
   rule('child','calculated_base_price','calculated_base_price',[{op:'add',value:2000}],{input_origin:'parent'}),
   rule('register','platform_registration_price','calculated_base_price',[{op:'add',value:2000}],{scope:'ably'}),
   rule('discount','platform_discount_price','platform_registration_price',[{op:'subtract',value:2000}],{scope:'ably'}),
  ],assignments:[
   {sku:'six',rule_id:'inbound',target_field:'actual_inbound_cost',scope:'',version:1},
   {sku:'six',rule_id:'base',target_field:'calculated_base_price',scope:'',version:1},
   {sku:'loose',rule_id:'inbound',target_field:'actual_inbound_cost',scope:'',version:1},
  ],dependencies:[]},tags:[],docs:[{id:'platform1',version:2,title:'registry-platform:ably',body:{source:'ably',anchor:'lowest',mode:'forward',registration_rule_id:'register',discount_rule_id:'discount'}}]};
  const products=()=>['six','eight','loose'].map(sku=>({sellpia_sku_code:sku,display_name:sku+' product',sellpia_source_purchase_price:q.purchase,actual_inbound_cost:q.purchase,system_base_price:1000,__sellerPriceComponents:{ably:{seller_product_code:sku==='loose'?'other':'same',seller_option_code:sku,source_final_price:9000,source_discount_terms:[]}}}));
  window.SystemV3AttributesPage={init(){},async refresh(){}};
  window.SystemV3Data={
   async ruleRegistry(action,r){q.calls.push('registry:'+action);if(action==='list')return copy(q.registry);if(action==='save'){const saved={...r,id:r.id||'qa-rule',version:(r.version||0)+1,is_active:true};q.registry.rules=q.registry.rules.filter(x=>x.id!==saved.id);q.registry.rules.push(copy(saved));q.writes.push({action:'rule-save',value:copy(saved)});return copy(saved);}throw Error('Unexpected registry action');},
   async saveTagRule({tag,rule}){const id=tag.id||'qa-tag',savedTag={tag_id:id,tag_name:tag.name,tag_color:tag.color,tag_group:tag.group},saved={...rule,id:rule.id||'qa-rule',tag_id:id,version:(rule.version||0)+1,is_active:true};q.registry.rules=q.registry.rules.filter(x=>x.id!==saved.id);q.registry.rules.push(copy(saved));q.tags=q.tags.filter(x=>x.tag_id!==id);q.tags.push(savedTag);q.writes.push({action:'tag-rule-save',tag:copy(savedTag),value:copy(saved)});return copy({tag:savedTag,rules:[saved]});},
   async assignRules(action,entries){q.writes.push({action,entries:copy(entries)});for(const e of entries){const r=q.registry.rules.find(r=>r.id===e.rule_id);if(action==='remove'){q.registry.assignments=q.registry.assignments.filter(a=>!(a.sku===e.sku&&a.rule_id===e.rule_id));continue;}q.registry.assignments=q.registry.assignments.filter(a=>!(a.sku===e.sku&&a.target_field===r.target_field&&a.scope===r.scope));q.registry.assignments.push({sku:e.sku,rule_id:r.id,target_field:r.target_field,scope:r.scope,version:1});if(e.reference){q.registry.dependencies=q.registry.dependencies.filter(d=>!(d.child_sku===e.sku&&d.target_field===r.target_field&&d.scope===r.scope));q.registry.dependencies.push({...e.reference,child_sku:e.sku,target_field:r.target_field,rule_id:r.id,scope:r.scope,relation_valid:true});}}return {};},
   async loadFormulaProducts(skus){q.calls.push('products');return copy(products().filter(p=>skus.includes(p.sellpia_sku_code)));},
   async loadProducts({search}){return {rows:copy(products().filter(p=>p.display_name.includes(search)))};},
   async loadAllFilteredSkus(){return {skus:products().map(product=>product.sellpia_sku_code),total:products().length};},
   async loadRulePlatformSiblings(skus){return skus.some(s=>['six','eight'].includes(s))?['six','eight']:[];},
   async loadStoredMatrixPrices({sources,skus}){const rows=sources.flatMap(source=>(q.stored[source]||[]).filter(row=>skus.includes(row.sellpia_sku_code)));return {rows:copy(rows),missing:[]};},
   async loadCalculatedResults({skus}){return {rows:skus.filter(sku=>q.internal[sku]!==undefined).map(sku=>({sku,value:q.internal[sku],status:'calculated'})),missing:[],missingSkus:[]};},
   async workDocument(action,kind,payload){if(action==='list')return copy(q.docs);if(action==='get')return copy(q.docs.find(d=>d.id===payload.id));if(action==='get_title')return copy(q.docs.find(d=>d.title===payload.title));if(action==='save'){const d={...payload,id:payload.id||'new-doc',version:(payload.version||0)+1};q.docs=q.docs.filter(x=>x.id!==d.id);q.docs.push(copy(d));q.writes.push({action:'document-save',value:copy(d)});return copy(d);}throw Error('Unexpected document action');},
   async loadLatestSellerOriginalStatus(){q.calls.push('latest-file-status');return [{source:'ably',available:true,files:[{name:'fixture-latest.xlsx'}]}];},
   async loadTags(){const linked=q.registry.rules.map(r=>({tag_id:r.tag_id,tag_name:'수식 '+r.id,tag_color:'#dbeafe',tag_group:'가격 수식'}));return copy([...new Map([...linked,...q.tags,{tag_id:'tag-one',tag_name:'공통 태그'},{tag_id:'tag-two',tag_name:'행별 태그'},{tag_id:'tag-slash',tag_name:'14K_1/2'}].map(tag=>[tag.tag_id,tag])).values()]);},
   async bulkImportTags({rows,tagId,preview}){const tags={'tag-one':'공통 태그','tag-two':'행별 태그','tag-slash':'14K_1/2'},byName=Object.fromEntries(Object.entries(tags).map(([id,name])=>[name,id])),seen=new Set(),previewRows=[],valid=[];rows.forEach((row,index)=>{const resolved=tagId||byName[row.tag_name],exists=products().some(product=>product.sellpia_sku_code===row.sku),key=row.sku+'|'+resolved,error=!resolved?'태그명을 찾지 못했습니다.':!exists?'셀피아 원본에 없는 SKU입니다.':'',is_duplicate=!error&&seen.has(key);seen.add(key);previewRows.push({row_no:index+1,sku:row.sku,tag_name:tags[resolved]||row.tag_name,error:error||null,is_duplicate});if(!error&&!is_duplicate)valid.push({sku:row.sku,tag_id:resolved});});const result={mode:tagId?'single_tag':'per_row',row_count:rows.length,valid_count:valid.length,error_count:previewRows.filter(row=>row.error).length,duplicate_count:previewRows.filter(row=>row.is_duplicate).length,sku_count:new Set(valid.map(row=>row.sku)).size,tag_count:new Set(valid.map(row=>row.tag_id)).size,inserted_tag_count:valid.length,rule_assignment_count:0,preview_rows:previewRows.slice(0,200)};result.row_results=previewRows.map((row,i)=>({...row,source_row_no:rows[i].source_row_no,source_file:rows[i].source_file,state:row.error?'INVALID':row.is_duplicate?'NOOP':'APPLY',reason:row.error,issues:[]}));result.apply_count=valid.length;result.noop_count=result.duplicate_count;result.blocked_count=0;result.invalid_count=result.error_count;result.applied_count=preview?0:valid.length;result.applied_skus=preview?[]:valid.map(row=>row.sku);if(!preview){q.writes.push({action:'tag-excel-import',tagId,rows:copy(rows)});}return result;},
   async loadPriceRuleTags(){return [];},
   async loadInboundCostFormulaTags(){return [{tag_id:'legacy',tag_name:'legacy divide',multiply_value:3,divide_value:2,add_value:100,rounding_unit:100,rounding_mode:'up'}];},
  };
  window.HubPriceMaterializer={async materialize({skus,sources}){if(q.failMaterialize)throw Error('forced calculation timeout');let persistedRows=0,errorRows=0;for(const source of sources){if(source!=='ably')continue;const result=await HubPlatformRules.calculate(skus,source);for(const row of result.rows)q.internal[row.sku]=row.value;q.stored[source]=result.rows.map(row=>({sellpia_sku_code:row.sku,source_channel:source,seller_product_code:row.component.seller_product_code,seller_option_code:row.component.seller_option_code,base_price:row.platformBase,discounted_base_price:row.platformBase-row.platformDiscount,option_price:row.platformOption,final_price:row.platformFinal,discount_terms:row.platformTerms||[],rule_versions:row.versions||[],status:row.error?'error':'calculated',error:row.error||''}));persistedRows+=q.stored[source].length*4;errorRows+=result.errors.length*4;}return {totalSkus:skus.length,persistedRows,errorRows,status:errorRows?'partial':'complete'};}};
 });
 for(const file of ['rule-registry.js','tag-price-workspace.js','discount-price-math.js','platform-rule-service.js','rule-workspace.js'])await page.addScriptTag({path:path.join(root,'mockups/operations-hub',file)});
 const idle=()=>page.waitForFunction(()=>!HubPriceWorkspace.state.busy);
 const tagImportReady=()=>page.waitForFunction(()=>document.querySelector('#rw-tag-import-mode')?.textContent!=='파일을 선택하면 형식을 자동 판별합니다.');
 await page.evaluate(()=>HubPriceWorkspace.refresh());await idle();
 assert.deepEqual(errors,[],'initial scripts must mount without page errors');
 await page.locator('#rw-new').click();await page.locator('#rw-tag-name').fill('QA ordered tag');await page.locator('#rw-name').fill('QA ordered rule');
 await page.locator('#rw-add-op').click();await page.locator('.rw-op').nth(0).locator('input').fill('100');
 await page.locator('#rw-add-op').click();await page.locator('.rw-op').nth(1).locator('select').first().selectOption('multiply');await page.locator('.rw-op').nth(1).locator('input').fill('2');
 await page.locator('.rw-op').nth(1).locator('[data-up]').click();
 await page.locator('#rw-save').click();await idle();
 assert.deepEqual(await page.evaluate(()=>qa.registry.rules.find(r=>r.id==='qa-rule').config.steps),[{op:'multiply',value:2},{op:'add',value:100}]);
 await page.locator('#rw-refresh').click();await idle();
 assert.deepEqual(await page.locator('.rw-op').locator('input').evaluateAll(inputs=>inputs.map(x=>x.value)),['2','100'],'saved operation order survives refresh');
 await page.locator('#rw-bulk').click();await idle();
 await page.locator('#rw-bulk-file').setInputFiles({name:'fixture.csv',mimeType:'text/csv',buffer:Buffer.from('SKU\nloose\nsix\nmissing\n')});await idle();
 await page.waitForFunction(()=>document.querySelectorAll('#rw-bulk-rows tr').length===3,{},{timeout:3000});
 assert.match(await page.locator('#rw-bulk-rows').innerText(),/같은 단계 수식 충돌/);
 assert.match(await page.locator('#rw-bulk-rows').innerText(),/없는 SKU/);
 await page.locator('#rw-bulk-rows [data-sku="six"]').check();await page.locator('#rw-apply').click();await idle();
 assert.match(await page.locator('#rw-drawer-status').innerText(),/충돌/);
 assert.equal(await page.evaluate(()=>qa.writes.filter(w=>w.action==='apply').length),0,'conflict blocks assignment');
 await page.locator('#rw-bulk-rows [data-sku="six"]').uncheck();await page.locator('#rw-bulk-rows [data-sku="loose"]').check();
 await page.locator('#rw-apply').click();await idle();
 assert.deepEqual(await page.evaluate(()=>qa.registry.assignments.filter(a=>a.sku==='loose').map(a=>a.rule_id).sort()),['inbound','qa-rule']);
 await page.locator('#rw-remove').click();await idle();
 assert.deepEqual(await page.evaluate(()=>qa.registry.assignments.filter(a=>a.sku==='loose').map(a=>a.rule_id)),['inbound']);
 await page.locator('#rw-close').click();
 await page.locator('.rw-tabs [data-tab="dependencies"]').click();await page.locator('#rw-dep-import').click();
 await page.locator('#rw-dep-paste').fill('eight\tcalculated_base_price\teight\tcalculated_base_price\tchild');await page.locator('#rw-dep-parse').click();await idle();
 assert.equal(await page.locator('#rw-dep-import-save').isDisabled(),true);assert.match(await page.locator('#rw-dep-import-rows').innerText(),/자기 참조/);
 await page.locator('#rw-dep-file').setInputFiles({name:'relations.csv',mimeType:'text/csv',buffer:Buffer.from('parent_sku,source_field,child_sku,target_field,rule_id\nsix,calculated_base_price,eight,calculated_base_price,child\n')});await idle();
 await page.locator('#rw-dep-parse').click();await idle();
 assert.equal(await page.locator('#rw-dep-import-save').isDisabled(),false,await page.locator('#rw-dep-import-rows').innerText());
 await page.locator('#rw-dep-import-save').click();await idle();
 assert.equal(await page.evaluate(()=>qa.registry.dependencies[0].parent_sku),'six');
 await page.locator('#rw-dep-import').click();await page.locator('#rw-dep-paste').fill('six\tcalculated_base_price\teight\tcalculated_base_price\tchild');await page.locator('#rw-dep-parse').click();await idle();
 assert.equal(await page.locator('#rw-dep-import-save').isDisabled(),false,'reimport of an existing relation should preview its replacement: '+await page.locator('#rw-dep-import-rows').innerText());
 await page.locator('#rw-close').click();
 await page.locator('.rw-tabs [data-tab="platform"]').click();await idle();
 assert.equal(await page.locator('#rw-registration').inputValue(),'register');assert.equal(await page.locator('#rw-discount').inputValue(),'discount');
 await page.locator('#rw-platform-skus').fill('eight');await page.locator('#rw-platform-preview').click();await idle();
 assert.match(await page.locator('#rw-platform-rows').innerText(),/17,000/);assert.match(await page.locator('#rw-platform-rows').innerText(),/15,000/);
 await page.evaluate(()=>{qa.purchase=6000;});await page.locator('#rw-platform-preview').click();await idle();
 assert.match(await page.locator('#rw-platform-rows').innerText(),/20,000/);assert.match(await page.locator('#rw-platform-rows').innerText(),/18,000/);
 await page.locator('#rw-anchor').selectOption('middle');await page.locator('#rw-platform-save').click();await idle();
 assert.equal(await page.evaluate(()=>qa.docs.find(d=>d.title==='registry-platform:ably').body.anchor),'middle');
 await page.locator('#rw-platform-source').selectOption('smartstore');await idle();
 assert.equal(await page.locator('#rw-registration option').count(),1,'Ably registration rule must not appear in Smartstore');
 await page.locator('#rw-platform-source').selectOption('ably');await idle();assert.equal(await page.locator('#rw-anchor').inputValue(),'middle');
 await page.locator('.rw-tabs [data-tab="export"]').click();await idle();
 assert.equal(await page.locator('#rw-export-file option').count(),2,'latest original file list initializes on tab entry');
 await page.locator('.rw-tabs [data-tab="rules"]').click();await page.evaluate(()=>{HubPriceWorkspace.state.tagContext=null;return HubPriceWorkspace.refresh();});await idle();await page.locator('#rw-list [data-rule="base"]').click();await idle();
 const geometry=await page.evaluate(()=>{const box=document.querySelector('.rw').getBoundingClientRect();return {width:box.width,height:box.height,viewport:innerHeight,bodyWidth:document.body.scrollWidth};});
 assert.ok(geometry.bodyWidth<=1440,'workspace must fit desktop width');assert.ok(geometry.height<geometry.viewport,'workspace must fit desktop height');
 const beforeFormulaWrites=await page.evaluate(()=>qa.writes.length);
 const beforeFormulaTarget=await page.locator('#rw-target').inputValue();
 await page.locator('#rw-legacy-load').click();await idle();await page.locator('#rw-legacy-rules').selectOption('shared:register');
 assert.equal(await page.locator('#rw-name').inputValue(),'base','importing formula-tag steps must keep the current formula identity');
 assert.equal(await page.locator('#rw-target').inputValue(),beforeFormulaTarget,'loading formula-tag steps must preserve the separately selected destination');
 assert.deepEqual(await page.locator('.rw-op').locator('input').evaluateAll(inputs=>inputs.map(x=>x.value)),['2000']);
 assert.equal(await page.evaluate(()=>qa.writes.length),beforeFormulaWrites,'copying formula-tag steps must not persist until save');
 assert.deepEqual(await page.evaluate(()=>{const resolved=HubPriceWorkspace.resolveTagImportTag({metadata:{tagId:'tag-one',tagName:'다른 이름'},fileName:'없는_일괄적용.xlsx'});return {status:resolved.status,source:resolved.source,tag:resolved.tag.tag_name};}),{status:'resolved',source:'metadata_id',tag:'공통 태그'},'stable workbook tag_id must have priority over display filename');
 assert.deepEqual(await page.evaluate(()=>{const resolved=HubPriceWorkspace.resolveTagImportTag({fileName:'14K_1_2_일괄적용.xlsx'});return {status:resolved.status,source:resolved.source,tag:resolved.tag.tag_name};}),{status:'resolved',source:'filename_normalized',tag:'14K_1/2'},'Windows-safe separators resolve only a unique canonical tag');
 assert.equal(await page.evaluate(()=>{HubPriceWorkspace.state.tags.push({tag_id:'tag-dash',tag_name:'14K-1-2'});const result=HubPriceWorkspace.resolveTagImportTag({fileName:'14K_1_2_일괄적용.xlsx'}).status;HubPriceWorkspace.state.tags.pop();return result;}),'ambiguous','separator normalization must fail closed when multiple tags collide');
 assert.deepEqual(await page.evaluate(()=>{const sheet={'!ref':'A1:B2',A1:{t:'s',v:'셀피아 SKU'},A2:{t:'s',v:'00123-4'}};HubPriceWorkspace.formatTagWorkbookSkuColumn(sheet,5000);return {value:sheet.A2.v,type:sheet.A2.t,format:sheet.A2.z,blankFormat:sheet.A5000.z,ref:sheet['!ref']};}),{value:'00123-4',type:'s',format:'@',blankFormat:'@',ref:'A1:B5000'},'template SKU cells must remain text through row 5000');
 assert.deepEqual(await page.evaluate(()=>{const book={SheetNames:['태그일괄적용'],Sheets:{태그일괄적용:{}}};HubPriceWorkspace.addTagWorkbookMetadata(book,{tag_id:'tag-one',tag_name:'공통 태그'});return {names:book.SheetNames,rows:book.Sheets.__SYSTEM_V3_TAG__,hidden:book.Workbook.Sheets};}),{names:['태그일괄적용','__SYSTEM_V3_TAG__'],rows:[['system_v3_tag_import','1'],['tag_id','tag-one'],['tag_name','공통 태그']],hidden:[{name:'태그일괄적용',Hidden:0},{name:'__SYSTEM_V3_TAG__',Hidden:1}]},'generated template must preserve a hidden stable tag identity');
 assert.deepEqual(await page.evaluate(()=>HubPriceWorkspace.parseTagImportRows([['셀피아 SKU'],['six'],['loose']])),{mode:'single_tag',rows:[{sku:'six',tag_name:'',source_row_no:2},{sku:'loose',tag_name:'',source_row_no:3}]});
 assert.deepEqual(await page.evaluate(()=>HubPriceWorkspace.parseTagImportRows([['셀피아 SKU','태그명'],['six','공통 태그'],['loose','행별 태그']])),{mode:'per_row',rows:[{sku:'six',tag_name:'공통 태그',source_row_no:2},{sku:'loose',tag_name:'행별 태그',source_row_no:3}]});
 assert.deepEqual(await page.evaluate(()=>HubPriceWorkspace.parseTagImportRows([['셀피아 SKU','메모'],['six','무시'],['loose','무시']],{fileName:'공통 태그_일괄적용.xlsx'})),{mode:'filename_tag',filenameTagName:'공통 태그',rows:[{sku:'six',tag_name:'',source_row_no:2},{sku:'loose',tag_name:'',source_row_no:3}]});
 await page.locator('.rw-tabs [data-tab="bulk"]').click();await idle();
 await page.locator('#rw-tag-import-file').setInputFiles({name:'one-column.csv',mimeType:'text/csv',buffer:Buffer.from('\ufeff셀피아 SKU\nsix\nloose\n')});await tagImportReady();await idle();
 assert.match(await page.locator('#rw-tag-import-mode').innerText(),/공통 태그 선택/);assert.equal(await page.locator('#rw-tag-import-apply').isDisabled(),true);
 await page.locator('#rw-tag-import-tag').selectOption('tag-one');await idle();assert.equal(await page.locator('#rw-tag-import-apply').isDisabled(),false,(await page.locator('#rw-tag-import-summary').innerText())+' | '+(await page.locator('#rw-drawer-status').innerText())+' | '+(await page.locator('#rw-tag-import-rows').innerText()));
 await page.locator('#rw-tag-import-apply').click();await idle();assert.equal(await page.evaluate(()=>qa.writes.filter(write=>write.action==='tag-excel-import').length),1);
 await page.locator('#rw-close').click();await page.locator('.rw-tabs [data-tab="bulk"]').click();await idle();
 await page.locator('#rw-tag-import-file').setInputFiles({name:'two-column.csv',mimeType:'text/csv',buffer:Buffer.from('\ufeff셀피아 SKU,태그명\nsix,공통 태그\nloose,행별 태그\n')});await tagImportReady();await idle();
 assert.match(await page.locator('#rw-tag-import-mode').innerText(),/B열 태그명/);assert.equal(await page.locator('#rw-tag-import-tag').isDisabled(),true);assert.equal(await page.locator('#rw-tag-import-apply').isDisabled(),false);
 await page.locator('#rw-tag-import-apply').click();await idle();assert.equal(await page.evaluate(()=>qa.writes.filter(write=>write.action==='tag-excel-import').length),2);
 await page.locator('#rw-close').click();await page.locator('.rw-tabs [data-tab="bulk"]').click();await idle();
 await page.locator('#rw-tag-import-file').setInputFiles({name:'공통 태그_일괄적용.csv',mimeType:'text/csv',buffer:Buffer.from('\ufeff셀피아 SKU\nsix\nloose\n')});await tagImportReady();await idle();
 assert.match(await page.locator('#rw-tag-import-mode').innerText(),/파일명 태그 자동 인식 · 공통 태그/);assert.equal(await page.locator('#rw-tag-import-tag').isDisabled(),true);assert.equal(await page.locator('#rw-tag-import-tag').inputValue(),'');assert.equal(await page.locator('#rw-tag-import-apply').isDisabled(),false);
 await page.locator('#rw-tag-import-apply').click();await idle();assert.equal(await page.evaluate(()=>qa.writes.filter(write=>write.action==='tag-excel-import').length),3);
 await page.locator('#rw-close').click();await page.locator('.rw-tabs [data-tab="bulk"]').click();await idle();
 const beforeMultiWrites=await page.evaluate(()=>qa.writes.filter(write=>write.action==='tag-excel-import').length);
 await page.locator('#rw-tag-import-file').setInputFiles([{name:'14K_1_2_일괄적용.csv',mimeType:'text/csv',buffer:Buffer.from('\ufeff셀피아 SKU\nsix\n')},{name:'행별.csv',mimeType:'text/csv',buffer:Buffer.from('\ufeff셀피아 SKU,태그명\nloose,행별 태그\n')}]);await tagImportReady();await idle();
 assert.match(await page.locator('#rw-tag-import-mode').innerText(),/2개 파일/);assert.match(await page.locator('#rw-tag-import-files').innerText(),/14K_1_2_일괄적용\.csv/);assert.match(await page.locator('#rw-tag-import-files').innerText(),/14K_1\/2/);assert.equal(await page.locator('#rw-tag-import-apply').isDisabled(),false);assert.equal(await page.evaluate(()=>qa.writes.filter(write=>write.action==='tag-excel-import').length),beforeMultiWrites,'multi-file validation must not write before explicit apply');
 await page.locator('#rw-tag-import-apply').click();await idle();assert.equal(await page.evaluate(()=>qa.writes.filter(write=>write.action==='tag-excel-import').length),beforeMultiWrites+1,'all validated files must use one atomic apply call');
 await page.locator('#rw-close').click();await page.evaluate(()=>{qa.failMaterialize=true;qa.registry.rules.find(rule=>rule.id==='base').tag_id='tag-one';});await page.locator('.rw-tabs [data-tab="bulk"]').click();await idle();
 await page.locator('#rw-tag-import-file').setInputFiles({name:'공통 태그_일괄적용.csv',mimeType:'text/csv',buffer:Buffer.from('\ufeff셀피아 SKU\nsix\n')});await tagImportReady();await idle();
 await page.locator('#rw-tag-import-apply').click();await idle();assert.match(await page.locator('#rw-drawer-status').innerText(),/태그 DB 저장 완료/);assert.match(await page.locator('#rw-drawer-status').innerText(),/가격 재계산 실패\(태그 적용은 유지됨\)/);assert.equal(await page.evaluate(()=>qa.writes.filter(write=>write.action==='tag-excel-import').length),5,'formula refresh failure must not hide the completed tag DB write');
 assert.deepEqual(errors,[]);
 console.log('PASS formula-tag workspace browser flow: ordered save/reload, selected formula bulk action, one-column and two-column Excel tag import, dependency CSV validation/save, live calculation refresh, scoped platform settings, formula-step copy, export file load, desktop density; fixture adapter only');
}finally{await browser.close();}
