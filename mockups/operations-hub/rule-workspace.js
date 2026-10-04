(function(g){
 'use strict';
 const $=id=>document.getElementById('rw-'+id),M=g.HubRuleRegistry,D=g.SystemV3Data;
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const money=v=>Number.isFinite(v)?v.toLocaleString('ko-KR'):v??'—';
 const sources={ably:'에이블리',smartstore:'스마트스토어',makeshop:'메이크샵'};
 const fieldLabels={...M.fields,calculated_base_price:'시스템 기준가격 · 매트릭스',basis_sku_price:'이전 계산 결과'};
 const fieldHelp={
  representative_base_price:'전체 현재 옵션의 유효 기준가에서 계산한 상품 대표가입니다. 해당 SKU의 판매처 등록가 수식에서만 명시적으로 선택합니다.',
  purchase_price:'셀피아 원본에서 읽은 매입가입니다.',
  source_base_price:'셀피아 원본 파일의 판매가이며, 기존 저장 수식에서 “판매가”로 부르던 기준값입니다.',
  actual_inbound_cost:'매입가에 쌍/낱개 환산·보정 등을 적용한 실제 입고 단가입니다.',
  basis_sku_price:'다단계 계산 연결용 값입니다. 첫 수식 결과를 다음 수식의 시작값으로 이어줄 때만 사용합니다. 직접 값을 입력하는 항목이 아닙니다.',
  calculated_base_price:'통합 매트릭스에서 실제 기준가격으로 쓰는 값입니다. 일반적인 SKU 가격 수식은 보통 여기에 저장합니다.',
  system_stock:'현재 시스템이 기준으로 사용하는 재고입니다.',
  calculated_stock:'재고 수식으로 계산한 결과입니다.',
  platform_registration_price:'판매처에 올릴 상품 기본 등록가입니다.',
  platform_option_price:'판매처 옵션 추가금액입니다.',
  platform_discount_price:'등록가에 할인만 적용한 값입니다. 옵션가는 아직 반영되지 않았습니다.',
  platform_final_price:'할인과 옵션가까지 모두 반영된 실제 최종 판매가입니다.',
  platform_price:'기존 수식 호환용 필드입니다. 새 수식에서는 등록가·옵션가·최종가를 직접 선택하는 편이 명확합니다.',
  platform_option_input:'옵션가 계산 연결용 내부 입력값입니다. 일반적인 수식에서는 선택하지 않아도 됩니다.',
  platform_final_input:'최종가 계산 연결용 내부 입력값입니다. 일반적인 수식에서는 선택하지 않아도 됩니다.'
 };
 const sourceFieldOptions=(selected,multiStep)=>option(Object.fromEntries(Object.entries(fieldLabels).filter(([key])=>multiStep||key!=='basis_sku_price')),selected);
 const targetFieldOptions=(selected,multiStep)=>option(Object.fromEntries(M.targets.filter(key=>multiStep||key!=='basis_sku_price').map(key=>[key,fieldLabels[key]])),selected);
 const option=(values,selected)=>Object.entries(values).map(([v,label])=>`<option value="${esc(v)}" ${v===selected?'selected':''}>${esc(label)}</option>`).join('');
 const state={registry:{rules:[],assignments:[],dependencies:[]},tags:[],selected:null,steps:[],products:{},bulk:[],checks:new Set(),tab:'rules',busy:false,platformDoc:null,requested:[],tagContext:null,tagImport:null};
 const host=document.getElementById('price-rules');if(!host)return;
 const legacy=document.createElement('div');legacy.className='rw-legacy';legacy.hidden=true;while(host.firstChild)legacy.append(host.firstChild);
 host.innerHTML=`<div class="rw"><div class="rw-bar"><h2>가격 수식 관리</h2><button class="btn" id="rw-refresh">최신값 불러오기</button><button class="btn primary" id="rw-new">새 수식 태그</button></div><section class="rw-tag-context" id="rw-tag-context" hidden></section><nav class="rw-bar rw-tabs" aria-label="가격 수식 작업"><button data-tab="rules" aria-selected="true">수식 관리</button><button data-tab="bulk">SKU 일괄적용</button><button data-tab="dependencies">종속관계</button><button data-tab="platform">플랫폼 가격</button><button data-tab="export">내보내기</button></nav><div class="rw-content" id="rw-content"></div><p class="rw-status" id="rw-status" role="status">수식을 불러오세요.</p><div class="rw-drawer-backdrop" id="rw-backdrop" hidden><section class="rw-drawer" role="dialog" aria-modal="true" aria-labelledby="rw-drawer-title"><div class="rw-bar"><h3 id="rw-drawer-title"></h3><button class="btn" id="rw-close">닫기</button></div><div id="rw-drawer-body" class="rw-page"></div><p class="rw-status" id="rw-drawer-status" role="status"></p></section></div></div>`;
 host.append(legacy);
 document.body.appendChild($('backdrop'));
 const representativeTab=document.createElement('button');representativeTab.dataset.tab='representative';representativeTab.textContent='상품 대표가';host.querySelector('.rw-tabs').append(representativeTab);
 function status(text){$('status').textContent=text;}
 function progressStatus(text){status(text);const drawerStatus=$('drawer-status');if(drawerStatus&&!$('backdrop').hidden)drawerStatus.textContent=text;}
 async function run(fn){if(state.busy)return;state.busy=true;try{await fn();}catch(e){status(e.message);$('drawer-status').textContent=e.message;}finally{state.busy=false;}}
 async function materialize(skus,{sources:targetSources=Object.keys(sources),reason='price-rule-change'}={}){
  const uniqueSkus=[...new Set((skus||[]).map(value=>String(value||'').trim()).filter(Boolean))];
  if(!uniqueSkus.length)return {totalSkus:0,persistedRows:0,errorRows:0,status:'complete'};
  if(typeof g.HubPriceMaterializer?.materialize!=='function')throw Error('가격 계산 결과 저장 모듈을 불러오지 못했습니다. 새로고침 후 다시 시도하세요.');
  return g.HubPriceMaterializer.materialize({skus:uniqueSkus,sources:targetSources,reason,onProgress:progress=>progressStatus(`계산 결과 저장 중 · 영향 SKU ${Number(progress.totalSkus||0).toLocaleString('ko-KR')}개 · 저장값 ${Number(progress.persistedRows||0).toLocaleString('ko-KR')}개`)});
 }
 const calculationState=result=>result?.status==='partial'?`오류값 ${Number(result.errorRows||0).toLocaleString('ko-KR')}개 · 내보내기 제외`:`영향 ${Number(result?.totalSkus||0).toLocaleString('ko-KR')}개 SKU 가격 저장`;
 async function allSkus(){const result=await D.loadAllFilteredSkus({status:'all'},{onProgress:progress=>status(progress?.message||'전체 SKU 목록을 읽는 중…')});return result.skus||[];}
 const sourcesForRules=rules=>rules.some(rule=>!M.isPlatform(rule.target_field))?Object.keys(sources):[...new Set(rules.map(rule=>rule.scope).filter(Boolean))];
 async function configuredSourcesForRuleIds(ruleIds){
  if(!ruleIds.size||typeof g.HubPlatformRules?.settings!=='function')return [];
  const configured=[];
  for(const source of Object.keys(sources)){const document=await g.HubPlatformRules.settings(source),body=document?.body||{};if(ruleIds.has(body.registration_rule_id)||ruleIds.has(body.discount_rule_id))configured.push(source);}
  return configured;
 }
 function current(){return state.registry.rules.find(r=>r.id===state.selected);}
 function name(id){return state.registry.rules.find(r=>r.id===id)?.name||'없음';}
 function tagName(rule){
  if(!rule?.tag_id)return '';
  if(state.tagContext&&String(state.tagContext.id)===String(rule.tag_id))return state.tagContext.name;
  return state.tags.find(tag=>String(tag.tag_id)===String(rule.tag_id))?.tag_name||'연결된 상품 태그';
 }
 function linkedTagContext(rule){
  if(!rule?.tag_id)return null;
  const tag=state.tags.find(item=>String(item.tag_id)===String(rule.tag_id));
  return tag?{id:tag.tag_id,name:tag.tag_name,color:tag.tag_color||'#dbeafe',group:tag.tag_group||'가격 수식',returnAfterSave:false}:null;
 }
 function operationSummary(rule){
  if(rule?.target_field==='platform_discount_price'&&rule?.scope==='makeshop')return `메이크샵 ${rule.config?.discount_rule_code||'할인코드 미지정'}${M.makeshopDiscountCatalog?.[rule.config?.discount_rule_code]?.label?' · '+M.makeshopDiscountCatalog[rule.config.discount_rule_code].label:''}`;
  const steps=rule?.config?.steps||[];
  return steps.map(step=>step.op==='round'?`${money(step.unit)} 단위 ${{nearest:'반올림',up:'올림',down:'내림'}[step.rounding]||'반올림'}`:`${{add:'+ ',subtract:'− ',multiply:'× ',divide:'÷ ',set:'값 지정 '}[step.op]||''}${money(step.value)}`).join(' → ')||'입력값 그대로';
 }
 function ruleSummary(rule){
  const sourceSeller=M.isPlatform(rule.source_field)?(sources[rule.source_scope||rule.scope]||'저장 판매처와 동일'):'';
  const targetSeller=M.isPlatform(rule.target_field)?(sources[rule.scope]||'전체 판매처'):'공통';
  return `${rule.input_origin==='parent'?'상위 SKU':'해당 SKU'} ${sourceSeller?sourceSeller+' · ':''}${fieldLabels[rule.source_field]||rule.source_field} → ${operationSummary(rule)} → ${targetSeller} 저장 · ${fieldLabels[rule.target_field]||rule.target_field}`;
 }
 async function refresh(){const [registry,tags]=await Promise.all([D.ruleRegistry('list'),typeof D.loadTags==='function'?D.loadTags():Promise.resolve(state.tags)]);state.registry=registry;state.tags=tags||[];if(state.selected&&!current())state.selected=null;renderTab();status(`수식 ${state.registry.rules.length}개 · 적용 ${state.registry.assignments.length}개 · 종속 ${state.registry.dependencies.length}개`);if(state.tab==='rules')await preview();}
 function select(id){readTagContext();state.selected=id;renderRules();void run(preview);}
 function renderTab(){renderTagContext();document.querySelectorAll('.rw-tabs button').forEach(b=>b.setAttribute('aria-selected',String(b.dataset.tab===state.tab)));if(state.tab==='rules')renderRules();if(state.tab==='dependencies')renderDependencies();if(state.tab==='platform')renderPlatform();if(state.tab==='export')renderExport();if(state.tab==='representative'){state.tagContext=null;$('tag-context').hidden=true;void g.HubRepresentativeWorkspace.mount($('content')).catch(e=>status(e.message));}}
 function renderRules(){
  renderTagContext();
  const r=current()||{name:state.tagContext?state.tagContext.name+' 수식':'',target_field:'calculated_base_price',input_origin:'self',source_field:'actual_inbound_cost',scope:'',config:{steps:[]}};const multistep=r.source_field==='basis_sku_price'||r.target_field==='basis_sku_price';state.steps=structuredClone(r.config.steps||[]);state.importConfig=null;
  $('content').innerHTML=`<div class="rw-top"><aside class="rw-registry"><input id="rw-filter" placeholder="수식·태그 이름 검색" aria-label="수식 또는 태그 이름 검색"><div id="rw-list"></div></aside><section class="rw-editor"><div class="rw-rule-heading"><label>수식 이름<input id="rw-name" value="${esc(r.name)}"></label><div class="rw-rule-link"><b>연결 상품 태그</b><span>${esc(tagName(r)||(state.tagContext?.name?'새 수식 태그 · '+state.tagContext.name:'태그 선택 필요'))}</span><small>${esc(ruleSummary(r))}</small></div></div><label class="rw-multistep-toggle"><input id="rw-multistep" type="checkbox" ${multistep?'checked':''}><span><b>다단계 계산 연결</b><small>켜면 첫 수식 결과를 “이전 계산 결과”에 저장하고 다음 수식의 시작값으로 이어갈 수 있습니다. 일반적인 한 단계 가격 수식은 끈 상태로 사용하세요.</small></span></label><div class="rw-pipeline"><section class="rw-pipeline-step"><header><b>1</b><div><h3>계산 시작점 선택</h3><small>어느 SKU의 어떤 값을 가져올지 정합니다.</small></div></header><div class="rw-start-fields"><label>SKU 위치<select id="rw-origin" aria-describedby="rw-stage-note">${option({self:'해당 SKU',parent:'상위 SKU'},r.input_origin)}</select></label><label>시작값<select id="rw-source-field">${sourceFieldOptions(r.source_field,multistep)}</select><small class="rw-field-help" id="rw-source-help"></small></label><label id="rw-source-scope-wrap">시작값 판매처<select id="rw-source-scope">${option({'':'저장 판매처와 같음',...sources},r.source_scope||'')}</select><small class="rw-field-help">판매처 가격을 시작값으로 선택했을 때, 어느 판매처 값을 읽을지 지정합니다.</small></label></div></section><i class="rw-pipeline-arrow" aria-hidden="true">→</i><section class="rw-pipeline-step rw-formula-step"><header><b>2</b><div><h3>수식 만들기</h3><small>미리 만든 수식 태그의 계산 단계를 복사하거나 직접 만듭니다.</small></div><button class="btn" id="rw-add-op">+ 연산 추가</button></header><div class="rw-formula-library" id="rw-formula-library"><label>수식 태그 단계 가져오기<select id="rw-legacy-rules" aria-label="수식 태그 단계 가져오기"><option value="">수식 태그 선택</option></select></label><button class="btn" id="rw-legacy-load" type="button">태그 목록 새로고침</button></div><div class="rw-makeshop-discount" id="rw-makeshop-discount" hidden><label>메이크샵 할인코드<select id="rw-makeshop-discount-code">${option(Object.fromEntries(Object.entries(M.makeshopDiscountCatalog||{}).map(([code,item])=>[code,`${code} · ${item.label}`])),r.config?.discount_rule_code||'NONE')}</select></label><small>메이크샵은 임의 할인액이 아니라 저장된 기간 할인코드를 판매가에 적용합니다.</small></div><div class="rw-ops" id="rw-ops"></div></section><i class="rw-pipeline-arrow" aria-hidden="true">→</i><section class="rw-pipeline-step"><header><b>3</b><div><h3>계산 적용점 선택</h3><small>계산 결과가 저장될 위치를 정합니다.</small></div></header><div class="rw-end-fields"><label>저장 위치<select id="rw-target" aria-describedby="rw-stage-note rw-target-help">${targetFieldOptions(r.target_field,multistep)}</select><small class="rw-field-help" id="rw-target-help"></small></label><label id="rw-scope-wrap">저장 판매처<select id="rw-scope" aria-describedby="rw-stage-note">${option({'':'공통',...sources},r.scope)}</select><small class="rw-field-help">할인은 반드시 한 판매처를 선택합니다. 메이크샵 할인은 할인코드로 저장됩니다.</small></label></div><p id="rw-stage-note" class="rw-stage-note" hidden></p></section></div><div class="rw-flow" aria-live="polite"><p id="rw-flow-summary"></p><p id="rw-flow-effect"></p></div><div class="rw-bar"><button class="btn" id="rw-bulk">${r.tag_id?'이 수식 태그를 SKU에 적용':'SKU 일괄적용'}</button><button class="btn primary" id="rw-save">수식 태그 저장</button></div><p id="rw-save-status" class="rw-save-status" role="status" aria-live="polite"></p></section></div><section class="rw-preview"><div class="rw-bar"><h3>적용 SKU · 저장값 미리보기</h3><input id="rw-preview-filter" placeholder="적용 SKU 검색 · 조회한 상품명" aria-label="적용 SKU 검색"><span id="rw-preview-count"></span></div><p id="rw-preview-state" class="rw-preview-state" role="status"></p><div class="rw-scroll"><table><thead><tr><th>SKU</th><th>상품 / 옵션</th><th>입력값</th><th>계산값</th><th>적용 수식</th><th>상태</th></tr></thead><tbody id="rw-preview"></tbody></table></div></section>`;
  renderList();renderFormulaLibrary();renderOps();updateRuleScopes();$('target').onchange=updateRuleScopes;$('scope').onchange=updateRuleScopes;$('source-field').onchange=updateRuleScopes;$('makeshop-discount-code').onchange=()=>{state.steps=M.makeshopDiscountConfig($('makeshop-discount-code').value).steps;renderOps();};$('multistep').onchange=()=>{const enabled=$('multistep').checked,source=$('source-field'),target=$('target');let sourceValue=source.value,targetValue=target.value;if(!enabled&&sourceValue==='basis_sku_price')sourceValue='actual_inbound_cost';if(!enabled&&targetValue==='basis_sku_price')targetValue='calculated_base_price';source.innerHTML=sourceFieldOptions(sourceValue,enabled);target.innerHTML=targetFieldOptions(targetValue,enabled);source.value=sourceValue;target.value=targetValue;updateRuleScopes();};$('filter').oninput=renderList;$('add-op').onclick=()=>{readOps();state.steps.push({op:'add',value:0});renderOps();};$('save').onclick=()=>run(saveRule);$('bulk').onclick=()=>run(openBulk);$('legacy-load').onclick=()=>run(reloadFormulaTags);$('legacy-rules').onchange=importFormulaSteps;$('preview-filter').oninput=()=>run(preview);
  $('content').oninput=e=>{if(e.target.closest('.rw-editor'))updateRuleFlow();};$('content').onchange=e=>{if(e.target.closest('.rw-editor'))updateRuleFlow();};
 }
 function renderList(){const q=$('filter').value.toLowerCase(),counts=new Map();for(const a of state.registry.assignments)counts.set(a.rule_id,(counts.get(a.rule_id)||0)+1);$('list').innerHTML=state.registry.rules.filter(r=>(!state.tagContext||state.tagContext.id&&String(r.tag_id)===String(state.tagContext.id))&&`${r.name} ${tagName(r)}`.toLowerCase().includes(q)).map(r=>`<button data-rule="${r.id}" aria-current="${r.id===state.selected}"><strong>${esc(r.name)}</strong><span class="rw-linked-tag ${r.tag_id?'':'rw-muted'}">${r.tag_id?'태그 · '+esc(tagName(r)):'연결 태그 없음'}</span><small>${esc(ruleSummary(r))}</small><small>적용 ${Number(counts.get(r.id)||0).toLocaleString('ko-KR')} SKU</small></button>`).join('')||'<p class="rw-empty">등록된 수식이 없습니다.</p>';$('list').querySelectorAll('button').forEach(b=>b.onclick=()=>select(b.dataset.rule));}
 function readOps(){state.steps=[...$('ops').children].map(row=>{const op=row.querySelector('select').value;return op==='round'?{op,unit:Number(row.querySelector('input').value),rounding:row.querySelector('[data-round]').value}:{op,value:Number(row.querySelector('input').value)};});}
 function moveOp(from,to){readOps();if(to<0||to>=state.steps.length)return;state.steps.splice(to,0,state.steps.splice(from,1)[0]);renderOps();}
 function renderOps(){ $('ops').innerHTML=state.steps.map((s,i)=>`<div class="rw-op" draggable="true" data-index="${i}"><span>${i+1}</span><select aria-label="${i+1}번 연산">${option({add:'+ 더하기',subtract:'− 빼기',multiply:'× 곱하기',divide:'÷ 나누기',set:'값 지정',round:'끝자리 처리'},s.op)}</select><input type="number" value="${s.op==='round'?s.unit:s.value}" aria-label="${i+1}번 연산값"><select data-round ${s.op==='round'?'':'hidden'} aria-label="끝자리 방식">${option({nearest:'반올림',up:'올림',down:'내림'},s.rounding||'nearest')}</select><button data-up aria-label="위로">↑</button><button data-down aria-label="아래로">↓</button><button data-delete aria-label="삭제">×</button></div>`).join('');
  $('ops').querySelectorAll('.rw-op').forEach((row,i)=>{row.querySelector('select').onchange=()=>{readOps();if(state.steps[i].op==='round'&&!state.steps[i].unit)state.steps[i].unit=100;renderOps();};row.querySelector('[data-up]').onclick=()=>moveOp(i,i-1);row.querySelector('[data-down]').onclick=()=>moveOp(i,i+1);row.querySelector('[data-delete]').onclick=()=>{readOps();state.steps.splice(i,1);renderOps();};row.ondragstart=e=>e.dataTransfer.setData('text/plain',String(i));row.ondragover=e=>e.preventDefault();row.ondrop=e=>{e.preventDefault();moveOp(Number(e.dataTransfer.getData('text/plain')),i);};});
  updateRuleFlow();
 }
 function assignedRuleCount(){const r=current();return r?state.registry.assignments.filter(a=>a.rule_id===r.id).length:0;}
 function updateRuleFlow(){
  if(!$('flow-summary'))return;readOps();
  const r=current(),target=$('target').value,origin=$('origin').value,source=$('source-field').value;
  const makeshopDiscount=target==='platform_discount_price'&&$('scope').value==='makeshop';
  const operations=makeshopDiscount?`메이크샵 ${$('makeshop-discount-code').value} · ${M.makeshopDiscountCatalog[$('makeshop-discount-code').value]?.label||'할인코드'}`:state.steps.map(s=>s.op==='round'?`${money(s.unit)} 단위 ${{nearest:'반올림',up:'올림',down:'내림'}[s.rounding]}`:`${{add:'+ ',subtract:'− ',multiply:'× ',divide:'÷ ',set:'값 지정 '}[s.op]}${money(s.value)}`).join(' → ')||'입력값 그대로';
  const sourceSeller=M.isPlatform(source)?($('source-scope').value||$('scope').value):'',targetSeller=M.isPlatform(target)?$('scope').value:'';
  $('flow-summary').textContent=`${origin==='parent'?'상위 SKU':'해당 SKU'} ${sourceSeller?(sources[sourceSeller]||sourceSeller)+' · ':''}${fieldLabels[source]} → ${operations} → ${M.isPlatform(target)?(targetSeller?(sources[targetSeller]||targetSeller):'전체 판매처')+' · ':''}${fieldLabels[target]}`;
  if($('source-help'))$('source-help').textContent=fieldHelp[source]||'';
  if($('target-help'))$('target-help').textContent=fieldHelp[target]||'';
  $('flow-effect').textContent=target==='calculated_base_price'?'통합 매트릭스에서 실제 기준가격으로 쓰는 값입니다. 일반적인 SKU 가격 수식은 보통 여기까지 계산하면 됩니다. 이후 판매처 가격은 각 판매처 수식에서 이어서 계산합니다.':target==='basis_sku_price'?'다단계 계산 연결용 값입니다. 첫 수식 결과를 여기에 저장한 뒤 다음 수식에서 “이전 계산 결과”를 시작값으로 선택합니다. 직접 값을 입력하는 항목이 아닙니다.':target==='platform_discount_price'?'선택한 저장 판매처의 등록가에 할인만 적용한 단계입니다. 옵션가는 아직 반영되지 않습니다.':target==='platform_final_price'?'선택한 저장 판매처에서 할인과 옵션가까지 모두 반영한 최종 판매가입니다.':M.isPlatform(target)?'선택한 저장 판매처의 가격 단계에 계산 결과를 저장합니다.':'입력값에 계산 순서를 적용해 공통 시스템 값으로 저장합니다. 이 값을 참조하는 후속 수식은 결과를 이어받을 수 있습니다.';
  const draft=!r||r.name!==$('name').value.trim()||r.target_field!==target||r.input_origin!==origin||r.source_field!==source||(r.scope||'')!==$('scope').value||(r.source_scope||'')!==(M.isPlatform(source)?$('source-scope').value:'')||JSON.stringify(r.config.steps||[])!==JSON.stringify(state.steps)||!!state.importConfig;
  $('preview-state').textContent=!r?'아직 저장하지 않은 수식입니다. 저장하고 SKU에 적용하면 결과를 조회할 수 있습니다.':`아래 표는 저장된 수식 v${r.version||1} 기준입니다.${draft?' 편집 중인 입력값·계산 순서는 저장 전이며, 아래 표에 반영되지 않았습니다.':' 위 계산 순서와 저장된 수식이 같습니다.'}`;
  $('preview-state').classList.toggle('rw-draft',draft);
 }
 function navigate(page){if(typeof g.showPage==='function')g.showPage(page);else document.querySelector(`.nav-item[data-page="${page}"]`)?.click();}
 function readTagContext(){
  if(!state.tagContext)return null;
  if($('tag-name'))Object.assign(state.tagContext,{name:$('tag-name').value,color:$('tag-color').value,group:$('tag-group').value,returnAfterSave:$('tag-return').checked});
  return {...state.tagContext};
 }
 function renderTagContext(){
  const region=$('tag-context'),tag=state.tagContext;if($('new'))$('new').textContent=tag?.id?'이 태그에 수식 추가':'새 수식 태그';region.hidden=!tag;if(!tag){region.innerHTML='';return;}
  const related=state.registry.rules.filter(r=>tag.id&&String(r.tag_id)===String(tag.id));
  region.innerHTML=`<div class="rw-bar"><b>상품태그 수식 · ${esc(tag.name)}</b><button class="btn" id="rw-tag-back">← 상품태그로 돌아가기</button></div><div class="rw-tag-fields"><label>태그 이름<input id="rw-tag-name" maxlength="32" value="${esc(tag.name)}"></label><label>색상<input type="color" id="rw-tag-color" value="${esc(tag.color||'#dbeafe')}"></label><label>태그 그룹<input id="rw-tag-group" value="${esc(tag.group||'운영')}"></label><label>이 태그의 수식<select id="rw-tag-rule">${option({'':'새 수식',...Object.fromEntries(related.map(r=>[r.id,r.name+' · '+(sources[r.scope]||fieldLabels[r.target_field])]))},state.selected||'')}</select></label></div><label class="rw-tag-return"><input type="checkbox" id="rw-tag-return" ${tag.returnAfterSave?'checked':''}>저장 후 상품태그로 돌아가기</label>`;
  $('tag-back').onclick=()=>run(returnToTags);$('tag-rule').onchange=()=>{readTagContext();state.selected=$('tag-rule').value||null;renderRules();void run(preview);};
  region.querySelectorAll('input').forEach(input=>input.oninput=readTagContext);
 }
 async function returnToTags(){state.tagContext=null;$('tag-context').hidden=true;navigate('attributes');await g.SystemV3AttributesPage?.refresh();}
 async function openForTag(tag){return run(async()=>{
  state.registry=await D.ruleRegistry('list');
  if(tag.id||tag.tag_id){const productRules=typeof D.productPrice==='function'?(await D.productPrice('rules')).rules:[];if(productRules.some(r=>r.tag_id===(tag.id||tag.tag_id))){state.tagContext=null;state.tab='representative';navigate('price-rules');document.querySelectorAll('.rw-tabs button').forEach(b=>b.setAttribute('aria-selected',String(b.dataset.tab===state.tab)));await g.HubRepresentativeWorkspace.mount($('content'),{tagId:tag.id||tag.tag_id});return;}}
  state.tagContext={id:tag.id||tag.tag_id||null,name:tag.name||tag.tag_name||'',color:tag.color||tag.tag_color||'#dbeafe',group:tag.group||tag.tag_group||'운영',returnAfterSave:false};
  if(state.tagContext.id&&!state.tags.some(item=>String(item.tag_id)===String(state.tagContext.id)))state.tags.push({tag_id:state.tagContext.id,tag_name:state.tagContext.name,tag_color:state.tagContext.color,tag_group:state.tagContext.group});
  state.selected=state.registry.rules.find(r=>state.tagContext.id&&String(r.tag_id)===String(state.tagContext.id))?.id||null;
  state.tab='rules';navigate('price-rules');renderTab();await preview();status('태그와 수식을 함께 저장합니다. SKU 목록을 따로 입력할 필요가 없습니다.');
 });}
 function newFormulaTag(){
  const tag=readTagContext();
  state.tagContext=tag?.id?tag:{id:null,name:'',color:'#dbeafe',group:'가격 수식',returnAfterSave:false};
  state.selected=null;state.tab='rules';renderTab();
  if($('tag-name'))$('tag-name').focus();
  status(tag?.id?'이 태그에 저장 위치가 다른 수식을 추가합니다.':'태그 이름과 계산식을 함께 저장합니다.');
 }
 function updateRuleScopes(){
  const target=$('target').value,platform=M.isPlatform(target),discount=target==='platform_discount_price',previous=$('scope').value;if(discount){$('source-field').value='platform_registration_price';$('source-scope').value='';}const sourcePlatform=M.isPlatform($('source-field').value);
  const choices=platform?(discount?{'':'판매처 선택',...sources}:{...(!current()?{'':'전체 판매처(스마트스토어·메이크샵·에이블리)'}:{}),...sources}):{'':'공통'};
  $('scope').innerHTML=option(choices,previous);$('scope').disabled=!platform;
  $('source-field').disabled=discount;
  if($('scope-wrap'))$('scope-wrap').hidden=!platform;
  $('source-scope').disabled=!sourcePlatform;
  if($('source-scope-wrap'))$('source-scope-wrap').hidden=!sourcePlatform||discount;
  if(!sourcePlatform)$('source-scope').value='';
  const count=assignedRuleCount(),hasAssignments=count>0;$('target').disabled=false;$('origin').disabled=hasAssignments;$('scope').disabled=!platform;
  const makeshopDiscount=discount&&$('scope').value==='makeshop';$('makeshop-discount').hidden=!makeshopDiscount;$('formula-library').hidden=makeshopDiscount;$('add-op').hidden=makeshopDiscount;$('ops').hidden=makeshopDiscount;
  if(makeshopDiscount){const code=current()?.scope==='makeshop'&&current()?.target_field==='platform_discount_price'?current().config?.discount_rule_code||'NONE':$('makeshop-discount-code').value||'NONE',steps=M.makeshopDiscountConfig(code).steps;$('makeshop-discount-code').value=code;if(JSON.stringify(state.steps)!==JSON.stringify(steps)){state.steps=steps;renderOps();}}
  $('stage-note').hidden=!hasAssignments;$('stage-note').textContent=hasAssignments?`현재 ${count.toLocaleString('ko-KR')}개 SKU에 적용 중입니다. 도착값이나 판매처를 바꾸면 연결 정보도 새 위치로 함께 이동합니다. 같은 위치에 다른 수식이 있는 SKU가 발견되면 전체 저장을 취소합니다. 상위 SKU 참조 전환은 종속관계가 필요하므로 SKU 적용을 해제한 뒤 설정하세요.`:'';
  updateRuleFlow();
 }
 async function saveRule(){
  const button=$('save'),controls=[...document.querySelectorAll('.rw button,.rw input,.rw select,.rw textarea')].map(el=>({el,disabled:el.disabled}));
  const show=(message,error=false)=>{const node=$('save-status');if(node){node.textContent=message;node.classList.toggle('rw-error',error);}};
  try{
   readOps();const config={...(current()?.config||{}),...(state.importConfig||{}),steps:state.steps};delete config.discount_mode;delete config.discount_rule_code;const target=$('target').value,scope=$('scope').value;if(target==='platform_discount_price'){if(!scope)throw Error('할인 수식 태그의 저장 판매처를 선택하세요.');if(scope==='makeshop'){for(const key of ['min','max','unit','rounding'])delete config[key];Object.assign(config,M.makeshopDiscountConfig($('makeshop-discount-code').value));}else config.discount_mode='numeric';}const rule={...current(),name:$('name').value.trim(),target_field:target,scope,input_origin:$('origin').value,source_field:$('source-field').value,source_scope:M.isPlatform($('source-field').value)?$('source-scope').value:'',config};
   if(!rule.name)throw Error('수식 이름을 입력하세요.');
   const explicitTag=readTagContext(),tag=explicitTag||linkedTagContext(current());
   if(!tag?.name?.trim())throw Error('수식 태그를 먼저 만들거나 선택하세요.');
   if(typeof D.saveTagRule!=='function')throw Error('태그·수식 통합 저장 기능을 불러오지 못했습니다. 입력 내용은 유지됩니다.');
   const allPlatforms=M.isPlatform(rule.target_field)&&!rule.scope;
   if(allPlatforms){
    if(rule.id)throw Error('전체 판매처 수식은 새 수식 태그에서 등록하세요. 기존 수식은 해당 판매처에서 수정합니다.');
    for(const scope of Object.keys(sources))M.validateRule({...rule,scope,source_scope:M.isPlatform(rule.source_field)?rule.source_scope||scope:''});
   }else M.validateRule(rule);
   controls.forEach(({el})=>el.disabled=true);button.textContent='저장 중…';button.setAttribute('aria-busy','true');show('태그와 수식을 함께 저장하고 있습니다.');
   const result=await D.saveTagRule({tag:{id:tag.id,name:tag.name.trim(),color:tag.color,group:tag.group},rule:{...rule,tag_id:tag.id||null}});
   const saved=result?.rules;
   if(!result?.tag?.tag_id)throw Error('태그 저장 응답을 확인하지 못했습니다.');
   if(explicitTag)state.tagContext={...tag,id:result.tag.tag_id,name:result.tag.tag_name,color:result.tag.tag_color,group:result.tag.tag_group};
   if(!Array.isArray(saved)||saved.length!==(allPlatforms?3:1)||saved.some(r=>!r.id)||(allPlatforms&&new Set(saved.map(r=>r.scope)).size!==3))throw Error('저장 응답을 확인하지 못했습니다. 입력 내용은 유지됩니다.');
    state.selected=saved[0].id;await refresh();
    const savedIds=new Set(saved.map(item=>item.id)),affected=new Set(state.registry.assignments.filter(item=>savedIds.has(item.rule_id)).map(item=>item.sku));
    const configuredSources=await configuredSourcesForRuleIds(savedIds);if(configuredSources.length)(await allSkus()).forEach(sku=>affected.add(sku));
    const calculation=await materialize([...affected],{sources:[...new Set([...sourcesForRules(saved),...configuredSources])],reason:`rule-save:${saved.map(item=>item.id).join(',')}`});
    const message=`태그와 수식 저장 완료${allPlatforms?' · 3개 판매처 수식':''} · ${calculationState(calculation)}`;
    show(message);status(message);g.dispatchEvent(new CustomEvent('hub-rules-changed',{detail:{persisted:true}}));
   g.dispatchEvent(new Event('hub-tags-changed'));await g.SystemV3AttributesPage?.refresh();if(tag.returnAfterSave)await returnToTags();
  }catch(error){show(error.message,true);throw error;}
  finally{controls.forEach(({el,disabled})=>el.disabled=disabled);button.textContent='수식 태그 저장';button.removeAttribute('aria-busy');}
 }
 async function preview(){
  if(!$('preview'))return;
  const r=current(),query=$('preview-filter').value.trim().toLowerCase();
  if(!r){state.previewMeta={total:0,matched:0};state.preview=[];renderPreview([]);return;}
  const assigned=[...new Set(state.registry.assignments.filter(a=>a.rule_id===r.id).map(a=>a.sku))];
  const matches=query?assigned.filter(sku=>sku.toLowerCase().includes(query)||String(state.products[sku]?.display_name||'').toLowerCase().includes(query)):assigned;
  const skus=matches.slice(0,200),selected=new Set(skus);
  state.previewMeta={total:assigned.length,matched:matches.length,query};
  $('preview-count').textContent=`전체 ${assigned.length.toLocaleString('ko-KR')} SKU · 미리보기 ${skus.length}개 조회 중`;
  const stale=()=>state.tab!=='rules'||current()?.id!==r.id||!$('preview-filter');
  let rows;
  if(M.isPlatform(r.target_field)&&skus.length){
   const result=await g.HubPlatformRules.calculate(skus,r.scope);if(stale())return;
   Object.assign(state.products,Object.fromEntries(result.rows.map(row=>[row.sku,row.product])));
   const column={platform_registration_price:'platformBase',platform_option_price:'platformOption',platform_discount_price:'discounted',platform_final_price:'platformFinal',platform_price:'platformFinal'}[r.target_field];
   const errors=new Map(result.errors.filter(row=>selected.has(row.sku)).map(row=>[row.sku,row]));
   rows=result.rows.filter(row=>selected.has(row.sku)&&!errors.has(row.sku)).map(row=>({sku:row.sku,base:row.value,value:column==='discounted'?row.platformBase-row.platformDiscount:row[column],error:row.error}));
   rows.push(...errors.values());
   state.previewMeta.relatedErrors=result.errors.filter(row=>!selected.has(row.sku)).length;
  }else{
   const products=await D.loadFormulaProducts(M.expandSkus(skus,state.registry.dependencies));if(stale())return;
   Object.assign(state.products,Object.fromEntries(products.map(p=>[p.sellpia_sku_code,p])));
   const evaluator=M.createEvaluator({...state.registry,products:Object.fromEntries(products.map(p=>[p.sellpia_sku_code,p]))});
   rows=skus.map(sku=>{try{return {sku,...evaluator.evaluate(sku,r.target_field,r.scope)};}catch(e){return {sku,error:e.message};}});
  }
  if($('preview-filter').value.trim().toLowerCase()!==query){await preview();return;}
  state.preview=rows;renderPreview(rows);
 }
 function renderPreview(rows){
  const meta=state.previewMeta||{total:rows.length,matched:rows.length};
  $('preview-count').textContent=`전체 ${meta.total.toLocaleString('ko-KR')} SKU · ${meta.query?'검색 '+meta.matched.toLocaleString('ko-KR')+'개 · ':''}미리보기 ${rows.length}개(최대 200) · 표시 결과 오류 ${rows.filter(r=>r.error).length}`+(meta.relatedErrors?` · 연관 옵션 오류 ${meta.relatedErrors}`:'');
  $('preview').innerHTML=rows.map(r=>`<tr><td>${esc(r.sku)}</td><td>${esc(state.products[r.sku]?.display_name)}</td><td>${money(r.base)}</td><td>${money(r.value)}</td><td>${esc(name(state.selected))}</td><td class="${r.error?'rw-error':''}">${esc(r.error||'정상')}</td></tr>`).join('')||'<tr><td colspan="6" class="rw-empty">'+(meta.query?'검색과 일치하는 적용 SKU가 없습니다.':'적용된 SKU가 없습니다.')+'</td></tr>';
 }
 function renderFormulaLibrary(){
  if(!$('legacy-rules'))return;
  const shared=state.registry.rules.filter(rule=>rule.tag_id),selected=current()?.tag_id?`shared:${current().id}`:'';
  $('legacy-rules').innerHTML='<option value="">수식 태그 선택</option>'+(shared.length?`<optgroup label="수식 태그">${shared.map(rule=>`<option value="shared:${esc(rule.id)}">${esc(tagName(rule))} · ${esc(sources[rule.scope]||'공통')} ${esc(fieldLabels[rule.target_field]||rule.target_field)} · ${esc(operationSummary(rule))}</option>`).join('')}</optgroup>`:'');
  if(selected&&shared.some(rule=>`shared:${rule.id}`===selected))$('legacy-rules').value=selected;
 }
 async function reloadFormulaTags(){const [registry,tags]=await Promise.all([D.ruleRegistry('list'),D.loadTags()]);state.registry=registry;state.tags=tags||[];renderFormulaLibrary();status(`수식 태그 ${new Set(state.registry.rules.filter(rule=>rule.tag_id).map(rule=>rule.tag_id)).size}개를 불러왔습니다.`);}
 function importFormulaSteps(){const value=$('legacy-rules').value;if(!value?.startsWith('shared:'))return;readOps();const imported=state.registry.rules.find(rule=>rule.id===value.slice(7));if(!imported)return;if(imported.scope==='makeshop'&&imported.target_field==='platform_discount_price'){status('메이크샵 할인코드는 메이크샵 할인 수식에서 직접 선택하세요. 숫자 계산 단계만 복사할 수 있습니다.');$('legacy-rules').value='';return;}state.steps=structuredClone(imported.config?.steps||[]);renderOps();updateRuleFlow();status(`${tagName(imported)}의 계산 단계 ${state.steps.length}개를 가져왔습니다. 현재 수식의 시작값과 저장 위치는 유지되며, 저장 전까지 DB는 변경되지 않습니다.`);}
 function drawer(title,html){$('drawer-title').textContent=title;$('drawer-body').innerHTML=html;$('drawer-status').textContent='';$('backdrop').hidden=false;$('close').focus();}
 const skuText=v=>[...new Set(String(v).split(/[\s,;]+/).map(s=>s.trim()).filter(s=>s&&!['SKU','sku','sellpia_sku_code'].includes(s)))];
 const TAG_IMPORT_MAX_ROWS=50000,TAG_IMPORT_MAX_BYTES=20*1024*1024,TAG_IMPORT_METADATA_SHEET='__SYSTEM_V3_TAG__';
 const nextPaint=()=>new Promise(resolve=>typeof g.requestAnimationFrame==='function'?g.requestAnimationFrame(()=>resolve()):g.setTimeout(resolve,0));
 function tagWorkbookMetadata(book){
  const sheet=book?.Sheets?.[TAG_IMPORT_METADATA_SHEET];if(!sheet)return{};
  const entries=Object.fromEntries((g.XLSX.utils.sheet_to_json(sheet,{header:1,defval:'',raw:false})||[]).map(row=>[String(row?.[0]||'').trim(),String(row?.[1]||'').trim()]));
  if(entries.system_v3_tag_import!=='1')return{};
  return {tagId:entries.tag_id||'',tagName:entries.tag_name||''};
 }
 function formatTagWorkbookSkuColumn(sheet,lastRow=5000){
  if(!sheet||!g.XLSX?.utils)return sheet;
  const end=Math.max(2,Number(lastRow)||5000);
  for(let row=2;row<=end;row++){
   const address=`A${row}`,cell=sheet[address]||{t:'s',v:''};
   cell.t='s';cell.v=String(cell.v??'');cell.z='@';sheet[address]=cell;
  }
  const range=g.XLSX.utils.decode_range(sheet['!ref']||'A1:A1');range.e.r=Math.max(range.e.r,end-1);range.e.c=Math.max(range.e.c,0);sheet['!ref']=g.XLSX.utils.encode_range(range);
  return sheet;
 }
 function addTagWorkbookMetadata(book,tag={}){
  if(!book||!g.XLSX?.utils)return book;
  if(book.SheetNames?.includes(TAG_IMPORT_METADATA_SHEET)){delete book.Sheets[TAG_IMPORT_METADATA_SHEET];book.SheetNames=book.SheetNames.filter(name=>name!==TAG_IMPORT_METADATA_SHEET);}
  const sheet=g.XLSX.utils.aoa_to_sheet([['system_v3_tag_import','1'],['tag_id',String(tag.tag_id||tag.id||'')],['tag_name',String(tag.tag_name||tag.name||'')]]);
  g.XLSX.utils.book_append_sheet(book,sheet,TAG_IMPORT_METADATA_SHEET);
  book.Workbook=book.Workbook||{};book.Workbook.Sheets=book.Workbook.Sheets||[];
  const index=book.SheetNames.indexOf(TAG_IMPORT_METADATA_SHEET);while(book.Workbook.Sheets.length<book.SheetNames.length)book.Workbook.Sheets.push({});
  book.Workbook.Sheets=book.Workbook.Sheets.map((entry,sheetIndex)=>({name:book.SheetNames[sheetIndex],Hidden:0,...(entry||{})}));
  book.Workbook.Sheets[index]={...(book.Workbook.Sheets[index]||{}),name:TAG_IMPORT_METADATA_SHEET,Hidden:1};
  return book;
 }
 async function fileRows(file,{tagImport=false,withMetadata=false}={}){
  if(!file)return[];
  if(tagImport&&Number(file.size||0)>TAG_IMPORT_MAX_BYTES)throw Error('태그 파일은 최대 20MB까지 업로드할 수 있습니다. 필요한 A/B열만 남겨 다시 저장해 주세요.');
  const book=g.XLSX.read(await file.arrayBuffer(),{type:'array',...(tagImport?{dense:true,sheetRows:TAG_IMPORT_MAX_ROWS+2,raw:true,...(/\.csv$/i.test(file.name||'')?{codepage:65001}:{})}:{})}),sheet=book.Sheets[book.SheetNames.find(name=>name!==TAG_IMPORT_METADATA_SHEET)||book.SheetNames[0]];
  if(!sheet)return withMetadata?{rows:[],metadata:tagWorkbookMetadata(book)}:[];
  if(!tagImport){const rows=g.XLSX.utils.sheet_to_json(sheet,{header:1,defval:''});return withMetadata?{rows,metadata:tagWorkbookMetadata(book)}:rows;}
  const fullRange=g.XLSX.utils.decode_range(sheet['!fullref']||sheet['!ref']||'A1:A1');
  if(fullRange.e.r+1>TAG_IMPORT_MAX_ROWS+1)throw Error(`한 번에 최대 ${TAG_IMPORT_MAX_ROWS.toLocaleString('ko-KR')}행까지 등록할 수 있습니다.`);
  const endRow=Math.min(fullRange.e.r,TAG_IMPORT_MAX_ROWS),range={s:{r:0,c:0},e:{r:endRow,c:1}};
  const rows=g.XLSX.utils.sheet_to_json(sheet,{header:1,defval:'',range,blankrows:true});
  for(let r=0;r<=endRow;r++)for(let c=0;c<=1;c++){const cell=Array.isArray(sheet)?sheet[r]?.[c]:sheet[g.XLSX.utils.encode_cell({r,c})];if(cell?.t==='e'){rows[r]=rows[r]||[];rows[r][c]=cell.w||`Excel error ${cell.v}`;}}
  return withMetadata?{rows,metadata:tagWorkbookMetadata(book)}:rows;
 }
 function tagNameFromFilename(fileName){
  const name=String(fileName||'').split(/[\\/]/).pop()||'',match=name.match(/^(.+)_일괄적용\.(xlsx|xls|csv)$/i);
  return match?match[1].trim():'';
 }
 const normalizeTagName=value=>String(value||'').normalize('NFKC').trim().toLowerCase().replace(/[\s_\-/\\]+/g,'');
 function parseTagImportRows(sourceRows,{fileName='',metadata={}}={}){
  const filenameTagName=tagNameFromFilename(fileName),normalized=normalizeTagName,metadataTagId=String(metadata.tagId||''),metadataTagName=String(metadata.tagName||'');
  if(metadataTagId||metadataTagName||filenameTagName){
   const cells=(sourceRows||[]).map((row,index)=>({sku:String((Array.isArray(row)?row:[row])[0]??'').trim(),source_row_no:index+1})).filter(row=>row.sku);
   if(cells.length&&['sku','셀피아sku','셀피아코드','sellpiaskucode'].includes(normalized(cells[0].sku)))cells.shift();
   return {mode:metadataTagId||metadataTagName?'metadata_tag':'filename_tag',...(filenameTagName?{filenameTagName}:{}),...(metadataTagId?{metadataTagId}:{}),...(metadataTagName?{metadataTagName}:{}),rows:cells.map(row=>({...row,tag_name:''}))};
  }
  const cells=(sourceRows||[]).map((row,index)=>({sku:String((Array.isArray(row)?row:[row])[0]??'').trim(),tag_name:String((Array.isArray(row)?row:[row])[1]??'').trim(),source_row_no:index+1})).filter(row=>row.sku||row.tag_name);
  if(cells.length&&['sku','셀피아sku','셀피아코드','sellpiaskucode'].includes(normalized(cells[0].sku)))cells.shift();
  const mode=cells.some(row=>row.tag_name)?'per_row':'single_tag';
  return {mode,rows:cells.map(row=>({...row,tag_name:mode==='per_row'?row.tag_name:''}))};
 }
 function importTagByName(value){const matches=state.tags.filter(tag=>String(tag.tag_name||'').trim().toLowerCase()===String(value||'').trim().toLowerCase());return matches.length===1?matches[0]:null;}
 function resolveTagImportTag({metadata={},fileName='',manualTagId=''}={}){
  const byId=value=>state.tags.filter(tag=>String(tag.tag_id)===String(value||'')),byExactName=value=>state.tags.filter(tag=>String(tag.tag_name||'').trim().toLowerCase()===String(value||'').trim().toLowerCase());
  const detectedName=String(metadata.tagName||'').trim()||tagNameFromFilename(fileName),manual=byId(manualTagId);
  for(const [source,matches] of [['metadata_id',byId(metadata.tagId)],['metadata_name',byExactName(metadata.tagName)],['filename_exact',byExactName(tagNameFromFilename(fileName))]]){
   if(matches.length===1)return {status:'resolved',source,tag:matches[0],detectedName};
   if(matches.length>1){if(manual.length===1)return {status:'resolved',source:'manual',tag:manual[0],detectedName};return {status:'ambiguous',source,detectedName,message:`'${detectedName}'과 정확히 일치하는 활성 태그가 여러 개입니다.`};}
  }
  if(detectedName){const key=normalizeTagName(detectedName),matches=key?state.tags.filter(tag=>normalizeTagName(tag.tag_name)===key):[];
   if(matches.length===1)return {status:'resolved',source:'filename_normalized',tag:matches[0],detectedName};
   if(matches.length>1){if(manual.length===1)return {status:'resolved',source:'manual',tag:manual[0],detectedName};return {status:'ambiguous',source:'filename_normalized',detectedName,message:`'${detectedName}'과 구분자가 같은 태그가 여러 개입니다. 적용 태그를 직접 선택하세요.`};}
  }
  if(manual.length===1)return {status:'resolved',source:'manual',tag:manual[0],detectedName};
  return {status:'needs_choice',source:'manual',detectedName,message:detectedName?`'${detectedName}' 태그를 자동으로 확정하지 못했습니다.`:'적용할 태그를 선택하세요.'};
 }
 function analyzeTagImport(rows,selectedTagId){
  const errors=new Map(),existing=new Map(state.registry.assignments.map(assignment=>[M.key(assignment.sku,assignment.target_field,assignment.scope),assignment])),proposed=new Map(),seen=new Set();
  const selectedTag=selectedTagId?state.tags.find(item=>String(item.tag_id)===String(selectedTagId)):null,tagsByName=new Map(),rulesByTag=new Map();
  for(const tag of state.tags){const key=String(tag.tag_name||'').trim().toLowerCase();tagsByName.set(key,tagsByName.has(key)?null:tag);}
  for(const rule of state.registry.rules){const key=String(rule.tag_id||'');if(!key)continue;if(!rulesByTag.has(key))rulesByTag.set(key,[]);rulesByTag.get(key).push(rule);}
  rows.forEach((row,index)=>{
   const tag=selectedTagId?selectedTag:tagsByName.get(String(row.tag_name||'').trim().toLowerCase()),duplicateKey=`${row.sku}\u0000${tag?.tag_id||row.tag_name.toLowerCase()}`;
   if(seen.has(duplicateKey))return;seen.add(duplicateKey);if(!tag)return;
   for(const rule of rulesByTag.get(String(tag.tag_id))||[]){
    const key=M.key(row.sku,rule.target_field,rule.scope),assigned=existing.get(key),earlier=proposed.get(key);
    if(assigned&&assigned.rule_id!==rule.id){errors.set(index+1,`같은 계산 적용점에 이미 '${name(assigned.rule_id)}' 수식이 있습니다.`);break;}
    if(earlier&&earlier!==rule.id){errors.set(index+1,'이 파일 안에서 같은 계산 적용점의 서로 다른 수식이 겹칩니다.');break;}
    if(rule.input_origin==='parent'&&!state.registry.dependencies.some(dep=>dep.child_sku===row.sku&&dep.rule_id===rule.id)){errors.set(index+1,'상위 SKU 입력 수식은 종속관계를 먼저 등록해야 합니다.');break;}
    proposed.set(key,rule.id);
   }
  });
  return errors;
 }
 function importTextRows(value){return String(value||'').split(/\r?\n/).map(line=>line.includes('\t')?line.split('\t'):line.split(','));}
 const tagResolutionLabel=source=>({metadata_id:'템플릿 tag_id',metadata_name:'템플릿 태그명',filename_exact:'파일명 정확 일치',filename_normalized:'파일명 구분자 자동 추정',manual:'사용자 선택',per_row:'A열 SKU + B열 태그명'}[source]||'');
 async function validatePreparedTagImports(prepared,{preferredTagId=''}={}){
  const files=[];let totalRows=0;
  for(let fileIndex=0;fileIndex<prepared.length;fileIndex++){
   const source=prepared[fileIndex];
   if(source.error){files.push({...source,fileIndex,status:'error',message:source.error,rows:[],localErrors:new Map(),server:null});continue;}
   const parsed=parseTagImportRows(source.sourceRows,{fileName:source.fileName,metadata:source.metadata});totalRows+=parsed.rows.length;
   const manualTagId=source.manualTagId||(parsed.mode==='single_tag'?preferredTagId:'');
   const resolution=parsed.mode==='per_row'?{status:'resolved',source:'per_row',tag:null}:resolveTagImportTag({metadata:source.metadata,fileName:source.fileName,manualTagId});
   const rows=resolution.status==='resolved'&&resolution.tag?parsed.rows.map(row=>({...row,tag_name:resolution.tag.tag_name})):parsed.rows;
   const status=resolution.status==='resolved'?(rows.length?'ready':'error'):'needs_choice',message=resolution.status==='resolved'?(rows.length?tagResolutionLabel(resolution.source):'필수 SKU 열에서 읽은 행이 없습니다.'):resolution.message||'';
   files.push({...source,fileIndex,parsed,rows:rows.map(row=>({...row,source_file:source.fileName})),resolution,manualTagId,status,message});
   await nextPaint();
  }
  if(totalRows>TAG_IMPORT_MAX_ROWS)throw Error(`여러 파일을 합쳐 최대 ${TAG_IMPORT_MAX_ROWS.toLocaleString('ko-KR')}행까지 등록할 수 있습니다.`);
  const ready=files.filter(file=>file.status==='ready'),rows=ready.flatMap(file=>file.rows);
  const server=rows.length?await D.bulkImportTags({rows,tagId:null,preview:true,partial:true}):{row_count:0,row_results:[],apply_count:0,noop_count:0,blocked_count:0,invalid_count:0};
  if(rows.length&&(!Array.isArray(server.row_results)||server.row_results.length!==rows.length))throw Error('부분 적용 검사 결과가 완전하지 않아 저장을 차단했습니다.');
  state.tagImport={mode:files.length>1?'multi_file':files[0]?.parsed?.mode||'single_tag',prepared,files,rows,server,filter:'all',applied:false,canApply:Number(server.apply_count||0)>0};
  renderTagImport();
  const needs=files.filter(file=>file.status==='needs_choice').length,errors=files.filter(file=>file.status==='error').length;
  $('drawer-status').textContent=`검사 완료 · APPLY ${server.apply_count||0} · BLOCK ${server.blocked_count||0} · NOOP ${server.noop_count||0} · INVALID ${server.invalid_count||0}${needs||errors?` · 판별/읽기 불가 ${needs+errors}파일은 전체 제외`:''}. 정상 APPLY 행만 하나의 transaction으로 저장합니다.`;
  return state.tagImport;
 }
 async function previewTagImportFiles(fileList,{preferredTagId=''}={}){
  const files=[...(fileList||[])];if(!files.length)return;
  const prepared=[];
  for(let index=0;index<files.length;index++){
   const file=files[index];$('drawer-status').textContent=`${index+1}/${files.length} · ${file.name} 읽는 중…`;await nextPaint();
   try{const result=await fileRows(file,{tagImport:true,withMetadata:true});prepared.push({fileName:file.name,sourceRows:result.rows,metadata:result.metadata||{},manualTagId:''});}
   catch(error){prepared.push({fileName:file.name,sourceRows:[],metadata:{},manualTagId:'',error:error?.message||String(error)});}
  }
  return validatePreparedTagImports(prepared,{preferredTagId});
 }
 function renderTagImport(){
  const data=state.tagImport||{mode:'single_tag',files:[],rows:[],server:null,canApply:false},server=data.server||{},files=data.files||[];
  $('tag-import-mode').textContent=files.length?(files.length>1?`${files.length}개 파일을 각각 판별했습니다.`:files[0].parsed?.mode==='single_tag'&&files[0].status!=='ready'?`${files[0].fileName} · 공통 태그 선택 필요`:files[0].resolution?.source==='filename_exact'?`파일명 태그 자동 인식 · ${files[0].resolution.tag?.tag_name||files[0].resolution.detectedName}`:files[0].resolution?.source==='filename_normalized'?`파일명 태그 자동 추정 · ${files[0].resolution.tag?.tag_name||files[0].resolution.detectedName}`:`${files[0].fileName} · ${files[0].status==='ready'?tagResolutionLabel(files[0].resolution?.source):'태그 확인 필요'}`):'파일을 선택하면 형식을 자동 판별합니다.';
  const hasGenericFile=files.some(file=>file.parsed?.mode==='single_tag');$('tag-import-tag').disabled=files.length>0&&!hasGenericFile;$('tag-import-tag-wrap').classList.toggle('rw-disabled',files.length>0&&!hasGenericFile);
  const count=value=>Number(value||0).toLocaleString('ko-KR');
  $('tag-import-summary').textContent=files.length?`전체 ${count(server.row_count)} · ${data.applied?'적용':'적용 가능'} ${count(data.applied?server.applied_count:server.apply_count)} · 변경 없음 ${count(server.noop_count)} · 차단 ${count(server.blocked_count)} · 오류 ${count(server.invalid_count)} · 파일 전체 제외 ${files.filter(file=>file.status!=='ready').length}`:'아직 읽은 행이 없습니다.';
  const fileRowsHtml=files.map(file=>{const auto=file.resolution?.status==='resolved',needs=file.status==='needs_choice',kind=file.status==='ready'?(file.resolution?.source==='filename_normalized'?'자동 추정':'정상'):needs?'확인 필요':'적용 불가',tag=auto?file.resolution.tag?.tag_name:'';return `<tr><td>${esc(file.fileName)}</td><td>${esc(tag||file.resolution?.detectedName||'—')}</td><td>${Number(file.rows?.length||0).toLocaleString('ko-KR')}</td><td class="${file.status==='ready'?'':'rw-error'}">${esc(kind)}${file.message?' · '+esc(file.message):''}${needs?`<br><select data-import-file-tag="${file.fileIndex}"><option value="">태그 선택</option>${option(Object.fromEntries(state.tags.map(item=>[item.tag_id,item.tag_name])),file.manualTagId||'')}</select>`:''}</td></tr>`;}).join('');
  if($('tag-import-files'))$('tag-import-files').innerHTML=fileRowsHtml||'<tr><td colspan="4" class="rw-empty">선택한 파일이 없습니다.</td></tr>';
  const rejected=row=>['BLOCK','INVALID'].includes(row.state),detail=(server.row_results||[]).filter(row=>data.filter!=='blocked'||rejected(row)).slice(0,200);
  $('tag-import-rows').innerHTML=detail.map(row=>`<tr data-import-state="${esc(row.state)}"><td>${esc(row.source_file||'—')}</td><td>${row.source_row_no}</td><td>${esc(row.sku||'—')}</td><td>${esc(row.tag_name||'—')}</td><td class="${rejected(row)?'rw-error':row.state==='NOOP'?'rw-muted':''}">${esc(row.state)} · ${row.state==='APPLY'?(data.applied?'적용 완료':'정상'):esc(row.reason||'변경 없음')}${(row.issues||[]).map(issue=>`<br>기존: ${esc(issue.existing_tag||'—')} · stage: ${esc(issue.stage)} · output: ${esc(issue.output_field)} · ${esc(issue.reason)}`).join('')}</td></tr>`).join('')||'<tr><td colspan="5" class="rw-empty">표시할 행이 없습니다.</td></tr>';
  if($('tag-import-filter')){$('tag-import-filter').textContent=`${data.filter==='blocked'?'전체 보기':'차단만 보기'} · 오류/차단 ${count(Number(server.blocked_count||0)+Number(server.invalid_count||0))}건`;$('tag-import-filter').onclick=()=>{data.filter=data.filter==='blocked'?'all':'blocked';renderTagImport();};}
  if($('tag-import-download')){$('tag-import-download').disabled=!(server.row_results||[]).some(rejected);$('tag-import-download').onclick=downloadBlockedTagRows;}
  $('tag-import-apply').disabled=!data.canApply||data.applied;
  $('tag-import-files')?.querySelectorAll('[data-import-file-tag]').forEach(select=>select.onchange=()=>{const prepared=data.prepared.map(item=>({...item})),index=Number(select.dataset.importFileTag);prepared[index].manualTagId=select.value;void run(()=>validatePreparedTagImports(prepared,{preferredTagId:$('tag-import-tag').value}));});
 }
 function blockedTagWorkbook(data=state.tagImport){
  const rows=(data?.server?.row_results||[]).filter(row=>['BLOCK','INVALID'].includes(row.state)),book=g.XLSX.utils.book_new();
  const retry=g.XLSX.utils.aoa_to_sheet([['셀피아 SKU','태그명'],...rows.map(row=>[String(row.sku||''),String(row.tag_name||'')])]);
  formatTagWorkbookSkuColumn(retry,Math.max(1,rows.length+1));g.XLSX.utils.book_append_sheet(book,retry,'재등록');
  const details=[['원본 행번호','Sellpia SKU','요청 태그','기존 태그','stage','output_field','exclusive_group','상태','차단 사유','원본 파일']];
  for(const row of rows){const issues=row.issues||[],join=field=>[...new Set(issues.map(issue=>issue[field]).filter(Boolean))].join(' / ');details.push([row.source_row_no,String(row.sku||''),row.tag_name,join('existing_tag'),join('stage'),join('output_field'),join('exclusive_group'),row.state,join('reason')||row.reason,row.source_file]);}
  g.XLSX.utils.book_append_sheet(book,g.XLSX.utils.aoa_to_sheet(details),'차단 상세');return book;
 }
 function downloadBlockedTagRows(){
  const data=state.tagImport,tagNames=[...new Set((data.server.row_results||[]).filter(row=>['BLOCK','INVALID'].includes(row.state)).map(row=>row.tag_name))];
  g.XLSX.writeFile(blockedTagWorkbook(data),`${(tagNames.length===1?tagNames[0]:'태그').replace(/[\\/:*?"<>|]/g,'_')}_차단행_${new Date().toISOString().slice(0,10).replaceAll('-','')}.xlsx`);
 }
 async function previewTagImport(sourceRows,{fileName=''}={}){
  return validatePreparedTagImports([{fileName:fileName||'붙여넣기',sourceRows,metadata:{},manualTagId:''}],{preferredTagId:$('tag-import-tag').value});
 } async function openTagImport({openFilePicker=false,tagId=null}={}){
  state.tagImport=null;drawer('태그 일괄등록 검사',`<div class="rw-import-guide"><b>파일을 먼저 선택해도 됩니다.</b><span><strong>자동 판별</strong> 템플릿 tag_id → 템플릿 태그명 → &lt;태그명&gt;_일괄적용.xlsx 순서로 확인</span><span><strong>파일명 호환</strong> /, _, -, 공백 차이는 후보가 하나일 때만 같은 태그로 판단</span><span><strong>행별 지정</strong> A열 셀피아 SKU + B열 태그명</span><small>여러 파일은 각각 검사한 뒤 한 번에 저장합니다. 정상 APPLY 행만 저장합니다. BLOCK/INVALID 행과 판별·읽기 불가 파일은 제외합니다.</small></div><div class="rw-config rw-import-controls" id="rw-tag-import-drop"><label>엑셀 파일 여러 개<input id="rw-tag-import-file" type="file" accept=".xlsx,.xls,.csv" multiple aria-label="태그 일괄등록 엑셀 업로드"></label><label id="rw-tag-import-tag-wrap">태그 정보 없는 A열 파일의 공통 태그<select id="rw-tag-import-tag"><option value="">태그 선택</option>${option(Object.fromEntries(state.tags.map(tag=>[tag.tag_id,tag.tag_name])),'')}</select></label><div><b>판별된 형식</b><p id="rw-tag-import-mode" class="rw-import-mode">파일을 선택하면 형식을 자동 판별합니다.</p></div></div><p class="rw-muted">여기로 XLSX/XLS/CSV 파일을 여러 개 끌어다 놓을 수도 있습니다.</p><details class="rw-import-paste"><summary>엑셀 두 열을 복사해서 붙여넣기</summary><textarea id="rw-tag-import-paste" placeholder="셀피아 SKU&#9;태그명"></textarea><button class="btn" id="rw-tag-import-parse" type="button">붙여넣은 내용 검사</button></details><div id="rw-tag-import-summary" class="rw-rule-summary">아직 읽은 행이 없습니다.</div><h4>파일별 검사 결과</h4><div class="rw-scroll"><table><thead><tr><th>파일</th><th>감지 태그</th><th>입력 SKU</th><th>상태</th></tr></thead><tbody id="rw-tag-import-files"></tbody></table></div><h4>행 미리보기</h4><div class="rw-bar"><button class="btn" id="rw-tag-import-filter">차단만 보기</button><button class="btn" id="rw-tag-import-download" disabled>차단행 XLSX 다운로드</button></div><div class="rw-scroll"><table><thead><tr><th>파일</th><th>행</th><th>셀피아 SKU</th><th>적용 태그</th><th>검사 결과</th></tr></thead><tbody id="rw-tag-import-rows"></tbody></table></div><div class="rw-bar"><span class="rw-muted">표시는 최대 200행 · 저장은 검사한 파일 전체</span><button class="btn primary" id="rw-tag-import-apply" disabled>검사된 APPLY 행 태그 적용</button></div>`);
  renderTagImport();const fileInput=$('tag-import-file'),tagSelect=$('tag-import-tag'),drop=$('tag-import-drop');if(tagId&&state.tags.some(tag=>String(tag.tag_id)===String(tagId)))tagSelect.value=String(tagId);
  const process=files=>run(()=>previewTagImportFiles(files,{preferredTagId:tagSelect.value}));fileInput.onchange=()=>process(fileInput.files);drop.ondragover=event=>{event.preventDefault();};drop.ondrop=event=>{event.preventDefault();process(event.dataTransfer?.files);};
  $('tag-import-parse').onclick=()=>run(()=>previewTagImport(importTextRows($('tag-import-paste').value)));tagSelect.onchange=()=>{if(state.tagImport?.prepared?.length)void run(()=>validatePreparedTagImports(state.tagImport.prepared.map(item=>({...item,manualTagId:item.manualTagId||''})),{preferredTagId:tagSelect.value}));};$('tag-import-apply').onclick=()=>run(applyTagImport);if(openFilePicker)fileInput.click();
 }
 async function applyTagImport(){
  const data=state.tagImport,tagId=null;if(!data?.rows.length||!data.server)throw Error('먼저 파일 검사를 완료하세요.');if(!data.canApply||data.applied)throw Error('저장할 APPLY 행이 없습니다.');
  const candidates=data.server.row_results.filter(row=>row.state==='APPLY'),rows=candidates.map(row=>data.rows[row.row_no-1]);
  progressStatus(`1/3 · APPLY ${rows.length.toLocaleString('ko-KR')}행을 재검사하고 DB에 저장하는 중…`);
  const result=await D.bulkImportTags({rows,tagId,preview:false,partial:true});
  const merged=[...data.server.row_results];for(const row of result.row_results||[]){const original=candidates[row.row_no-1];merged[original.row_no-1]={...row,row_no:original.row_no};}
  data.server={...result,row_count:merged.length,row_results:merged,noop_count:merged.filter(row=>row.state==='NOOP').length,blocked_count:merged.filter(row=>row.state==='BLOCK').length,invalid_count:merged.filter(row=>row.state==='INVALID').length};data.applied=true;data.canApply=false;renderTagImport();
  const skus=result.applied_skus||[];
  const importedTagIds=new Set((result.row_results||[]).filter(row=>row.state==='APPLY').map(row=>importTagByName(row.tag_name)?.tag_id).filter(Boolean));
  progressStatus(`2/3 · 태그 DB 저장 완료 · SKU ${result.sku_count.toLocaleString('ko-KR')}개 · 연결 ${result.inserted_tag_count.toLocaleString('ko-KR')}개`);
  state.registry=await D.ruleRegistry('list');
  const rules=state.registry.rules.filter(rule=>importedTagIds.has(rule.tag_id));
  let calculation=null,calculationError=null;
  if(rules.length&&skus.length){
   progressStatus('3/3 · 수식 태그 가격을 다시 계산하는 중…');
   try{calculation=await materialize(skus,{sources:sourcesForRules(rules),reason:'tag-excel-import'});}
   catch(error){calculationError=error?.message||String(error);}
  }
  const message=`태그 DB 저장 완료 · 전체 ${merged.length.toLocaleString('ko-KR')} · 적용 ${result.applied_count||0} · 변경 없음 ${data.server.noop_count} · 차단 ${data.server.blocked_count} · 오류 ${data.server.invalid_count}${calculation?' · '+calculationState(calculation):''}${calculationError?` · 가격 재계산 실패(태그 적용은 유지됨): ${calculationError}`:''}`;
  status(message);$('drawer-status').textContent=message;g.dispatchEvent(new CustomEvent('hub-rules-changed',{detail:{persisted:true}}));
 }
 async function openBulk(){if(!current())throw Error('먼저 저장된 수식을 선택하세요.');state.checks=new Set();drawer('SKU 일괄적용',`<div class="rw-rule-summary">${esc(current().name)} · ${esc(fieldLabels[current().target_field])}</div><div class="rw-bar"><input id="rw-search" placeholder="SKU 또는 상품명" aria-label="SKU 또는 상품 검색"><button class="btn" id="rw-search-go">검색</button><input type="file" id="rw-bulk-file" accept=".xlsx,.xls,.csv" aria-label="SKU 엑셀 업로드"></div><textarea id="rw-paste" placeholder="SKU 목록 붙여넣기" aria-label="SKU 목록 붙여넣기"></textarea><div class="rw-bar"><button class="btn" id="rw-paste-go">붙여넣기 조회</button><button class="btn" id="rw-select-all">전체 선택</button><span id="rw-selected-count">0개 선택</span></div><div class="rw-scroll"><table><thead><tr><th></th><th>SKU</th><th>상품 / 옵션</th><th>현재 수식</th><th>적용 후 수식</th><th>충돌</th></tr></thead><tbody id="rw-bulk-rows"></tbody></table></div><div class="rw-bar"><button class="btn" id="rw-remove">선택 수식만 제거</button><button class="btn primary" id="rw-apply">선택 SKU에 적용</button></div>`);
  $('search-go').onclick=()=>run(async()=>{const result=await D.loadProducts({search:$('search').value,pageSize:100});setBulk(result.rows);});$('paste-go').onclick=()=>run(async()=>{const skus=skuText($('paste').value);if(skus.length>1000)throw Error('한 번에 최대 1,000 SKU입니다.');const rows=await D.loadFormulaProducts(skus);const map=new Map(rows.map(p=>[p.sellpia_sku_code,p]));setBulk(skus.map(sku=>map.get(sku)||{sellpia_sku_code:sku,missing:true}));});$('bulk-file').onchange=()=>run(async()=>{$('paste').value=(await fileRows($('bulk-file').files[0])).map(r=>r[0]).join('\n');const skus=skuText($('paste').value);const rows=await D.loadFormulaProducts(skus);const found=new Map(rows.map(p=>[p.sellpia_sku_code,p]));setBulk(skus.map(sku=>found.get(sku)||{sellpia_sku_code:sku,missing:true}));});$('select-all').onclick=()=>{state.bulk.forEach(p=>state.checks.add(p.sellpia_sku_code));renderBulk();};$('apply').onclick=()=>run(()=>applyBulk('apply'));$('remove').onclick=()=>run(()=>applyBulk('remove'));
 }
 function setBulk(rows){state.bulk=rows;state.checks=new Set();renderBulk();}
 function bulkConflict(p){const r=current(),a=state.registry.assignments.find(a=>a.sku===p.sellpia_sku_code&&a.target_field===r.target_field&&a.scope===r.scope);return p.missing?'없는 SKU':a&&a.rule_id!==r.id?'같은 단계 수식 충돌':r.input_origin==='parent'&&!state.registry.dependencies.some(d=>d.child_sku===p.sellpia_sku_code&&d.rule_id===r.id)?'종속관계에서 상위 참조 지정':'';}
 function renderBulk(){const r=current();$('selected-count').textContent=state.checks.size+'개 선택';$('bulk-rows').innerHTML=state.bulk.map(p=>{const sku=p.sellpia_sku_code,a=state.registry.assignments.filter(a=>a.sku===sku);return `<tr><td><input type="checkbox" data-sku="${esc(sku)}" ${state.checks.has(sku)?'checked':''} aria-label="${esc(sku)} 선택"></td><td>${esc(sku)}</td><td>${esc(p.display_name||p.sellpia_product_name)}</td><td>${esc(a.map(a=>name(a.rule_id)).join(', ')||'없음')}</td><td>${esc(r.name)}</td><td class="rw-error">${esc(bulkConflict(p))}</td></tr>`;}).join('');$('bulk-rows').querySelectorAll('input').forEach(x=>x.onchange=()=>{x.checked?state.checks.add(x.dataset.sku):state.checks.delete(x.dataset.sku);$('selected-count').textContent=state.checks.size+'개 선택';});}
 async function applyBulk(action){const selected=state.bulk.filter(p=>state.checks.has(p.sellpia_sku_code));if(!selected.length)throw Error('SKU를 선택하세요.');if(action==='apply'&&selected.some(bulkConflict))throw Error('충돌 표시를 확인하세요. 다른 단계의 수식은 유지됩니다.');const rule=current(),assignments=selected.map(p=>{const sku=p.sellpia_sku_code,reference=state.registry.dependencies.find(d=>d.child_sku===sku&&d.rule_id===state.selected);return {sku,rule_id:state.selected,...(reference?{reference}: {})};});await D.assignRules(action,assignments);state.registry=await D.ruleRegistry('list');const calculation=await materialize(selected.map(item=>item.sellpia_sku_code),{sources:sourcesForRules([rule]),reason:`rule-${action}:${rule.id}`});renderBulk();if($('target'))updateRuleScopes();status(`${selected.length} SKU ${action==='apply'?'적용':'선택 수식 제거'} 완료 · ${calculationState(calculation)}`);$('drawer-status').textContent=$('status').textContent;await preview();g.dispatchEvent(new CustomEvent('hub-rules-changed',{detail:{persisted:true}}));}
 function renderDependencies(){ $('content').innerHTML=`<section class="rw-page"><div class="rw-bar"><h3>종속관계 · 필드 참조</h3><button class="btn" id="rw-dep-import">엑셀 일괄등록</button><button class="btn primary" id="rw-dep-new">새 종속관계</button></div><div class="rw-scroll"><table><thead><tr><th>상위 SKU</th><th>참조 필드</th><th>→ 하위 SKU</th><th>적용 필드</th><th>적용 수식</th><th>상태</th></tr></thead><tbody>${state.registry.dependencies.map((d,i)=>`<tr data-dep="${i}" tabindex="0"><td>${esc(d.parent_sku)}</td><td>${esc(fieldLabels[d.source_field])}</td><td>→ ${esc(d.child_sku)}</td><td>${esc(fieldLabels[d.target_field])}</td><td>${esc(name(d.rule_id))}</td><td>${d.relation_valid===false?'관계 해제':'정상'}</td></tr>`).join('')}</tbody></table></div></section>`;$('dep-new').onclick=()=>openDependency();$('dep-import').onclick=openDependencyImport;$('content').querySelectorAll('[data-dep]').forEach(r=>{r.onclick=()=>openDependency(state.registry.dependencies[Number(r.dataset.dep)]);r.onkeydown=e=>{if(e.key==='Enter')r.click();};}); }
 function dependencyRuleOptions(id){return option(Object.fromEntries(state.registry.rules.filter(r=>r.input_origin==='parent').map(r=>[r.id,r.name])),id);}
 function openDependency(d={}){drawer('종속관계 설정',`<div class="rw-fields"><label>상위 SKU<input id="rw-dep-parent" value="${esc(d.parent_sku)}"></label><label>참조 필드<select id="rw-dep-source">${option(fieldLabels,d.source_field||'calculated_base_price')}</select></label><label>참조 판매처<select id="rw-dep-source-scope">${option({'':'적용 판매처와 같음',...sources},d.source_scope||'')}</select></label><label>하위 SKU<input id="rw-dep-child" value="${esc(d.child_sku)}"></label><label>적용 수식<select id="rw-dep-rule">${dependencyRuleOptions(d.rule_id)}</select></label><label>적용 위치<input id="rw-dep-target" readonly></label></div><div class="rw-bar"><button class="btn primary" id="rw-dep-save">저장</button></div>`);const update=()=>{$('dep-target').value=M.fields[state.registry.rules.find(r=>r.id===$('dep-rule').value)?.target_field]||'상위 SKU 입력 수식을 먼저 생성하세요.';};update();$('dep-rule').onchange=update;$('dep-save').onclick=()=>run(async()=>{const child=$('dep-child').value.trim(),rule=state.registry.rules.find(item=>item.id===$('dep-rule').value);await D.assignRules('apply',[{sku:child,rule_id:rule.id,reference:{parent_sku:$('dep-parent').value.trim(),source_field:$('dep-source').value,source_scope:M.isPlatform($('dep-source').value)?$('dep-source-scope').value:'',create_relation:true}}]);await refresh();const calculation=await materialize([child],{sources:sourcesForRules([rule]),reason:`dependency-save:${child}`});$('backdrop').hidden=true;status(`종속관계 저장 완료 · 영향 ${calculation.totalSkus.toLocaleString('ko-KR')}개 가격 저장`);g.dispatchEvent(new CustomEvent('hub-rules-changed',{detail:{persisted:true}}));});}
  function openDependencyImport(){drawer('종속관계 엑셀 일괄등록',`<div class="rw-rule-summary">상위 SKU | 참조 필드 | 하위 SKU | 적용 필드 | 수식 이름 또는 ID</div><div class="rw-bar"><input id="rw-dep-file" type="file" accept=".xlsx,.xls,.csv" aria-label="종속관계 엑셀 업로드"><button class="btn" id="rw-dep-parse">미리보기</button></div><textarea id="rw-dep-paste" placeholder="parent_sku\tsource_field\tchild_sku\ttarget_field\trule_id" aria-label="종속관계 붙여넣기"></textarea><div class="rw-scroll"><table><thead><tr><th>상위</th><th>참조 필드</th><th>하위</th><th>적용 필드</th><th>수식</th><th>검사</th></tr></thead><tbody id="rw-dep-import-rows"></tbody></table></div><div class="rw-bar"><button class="btn primary" id="rw-dep-import-save" disabled>검사된 관계 등록</button></div>`);let entries=[];$('dep-file').onchange=()=>run(async()=>{$('dep-paste').value=(await fileRows($('dep-file').files[0])).map(r=>r.join('\t')).join('\n');});$('dep-parse').onclick=()=>run(async()=>{const rows=$('dep-paste').value.trim().split(/\r?\n/).map(l=>l.split(/\t|,/).map(x=>x.trim())).filter(r=>r[0]&&!['parent_sku','상위 SKU'].includes(r[0]));entries=rows.map(r=>{const rule=state.registry.rules.find(x=>x.id===r[4]||x.name===r[4]);return {sku:r[2],rule_id:rule?.id,reference:{parent_sku:r[0],source_field:r[1],target_field:r[3],source_scope:r[5]||'',create_relation:true},error:!rule?'없는 수식':rule.input_origin!=='parent'?'상위 입력 수식 필요':rule.target_field!==r[3]?'적용 필드 불일치':''};});const products=Object.fromEntries((await D.loadFormulaProducts([...new Set(entries.flatMap(e=>[e.sku,e.reference.parent_sku]))])).map(p=>[p.sellpia_sku_code,p]));for(const e of entries){if(!products[e.sku]||!products[e.reference.parent_sku])e.error='없는 SKU';if(e.sku===e.reference.parent_sku)e.error='자기 참조';}if(!entries.some(e=>e.error)){try{const changes=entries.map(e=>({...e,target_field:e.reference.target_field,scope:state.registry.rules.find(r=>r.id===e.rule_id).scope}));const assignments=[...state.registry.assignments,...changes.filter(e=>!state.registry.assignments.some(a=>a.sku===e.sku&&a.rule_id===e.rule_id))];const dependencies=[...state.registry.dependencies.filter(d=>!changes.some(e=>e.sku===d.child_sku&&e.rule_id===d.rule_id&&e.reference.parent_sku===d.parent_sku)),...changes.map(e=>({...e.reference,child_sku:e.sku,rule_id:e.rule_id,scope:e.scope}))];validateGraphLinks(assignments,dependencies);}catch(error){entries.forEach(e=>e.error=error.message);}}$('dep-import-rows').innerHTML=entries.map(e=>`<tr>${[e.reference.parent_sku,e.reference.source_field,e.sku,e.reference.target_field,name(e.rule_id),e.error||'정상'].map(x=>`<td>${esc(x)}</td>`).join('')}</tr>`).join('');$('dep-import-save').disabled=!entries.length||entries.some(e=>e.error);});$('dep-paste').oninput=()=>{$('dep-import-save').disabled=true;};$('dep-import-save').onclick=()=>run(async()=>{const payload=entries.map(({error,...entry})=>entry),children=payload.map(entry=>entry.sku),rules=payload.map(entry=>state.registry.rules.find(rule=>rule.id===entry.rule_id)).filter(Boolean);await D.assignRules('apply',payload);await refresh();const calculation=await materialize(children,{sources:sourcesForRules(rules),reason:'dependency-import'});$('backdrop').hidden=true;status(`종속관계 ${payload.length.toLocaleString('ko-KR')}개 등록 · 영향 ${calculation.totalSkus.toLocaleString('ko-KR')}개 가격 저장`);g.dispatchEvent(new CustomEvent('hub-rules-changed',{detail:{persisted:true}}));});}

 function validateGraphLinks(assignments,dependencies){
  const slots=new Map(),refs=new Map(),edges=new Map();
  for(const d of dependencies){const k=M.key(d.child_sku,d.target_field,d.scope);if(refs.has(k))throw Error(d.child_sku+': 같은 단계에 상위 참조가 여러 개입니다.');if(d.parent_sku===d.child_sku)throw Error('자기 참조');if(!M.fields[d.source_field])throw Error('알 수 없는 참조 필드');refs.set(k,d);}
  for(const a of assignments){const k=M.key(a.sku,a.target_field,a.scope);if(slots.has(k))throw Error(a.sku+': 같은 단계 수식 충돌');slots.set(k,a);const r=state.registry.rules.find(r=>r.id===a.rule_id);if(!r)throw Error('없는 수식');const d=refs.get(k);if(r.input_origin==='parent'&&!d)throw Error(a.sku+': 상위 참조 없음');const field=d?.source_field||r.source_field;edges.set(k,M.key(d?.parent_sku||a.sku,field,M.isPlatform(field)?d?.source_scope||r.source_scope||r.scope:''));}
  for(const sku of new Set(assignments.map(a=>a.sku))){const inbound=M.key(sku,'actual_inbound_cost'),basis=M.key(sku,'basis_sku_price'),base=M.key(sku,'calculated_base_price');if(slots.has(inbound)&&!slots.has(basis))edges.set(basis,inbound);if((slots.has(inbound)||slots.has(basis))&&!slots.has(base))edges.set(base,basis);}
  const done=new Set();function visit(k,path=[]){if(path.includes(k)||path.length>=64)throw Error('필드 참조 순환 또는 64단계 초과');if(done.has(k))return;if(edges.has(k))visit(edges.get(k),[...path,k]);done.add(k);}for(const k of edges.keys())visit(k);
 }
 function platformSelectors(){return `<label>판매처<select id="rw-platform-source">${option(sources,'ably')}</select></label><label>대상 SKU 목록<input id="rw-platform-skus" placeholder="SKU를 쉼표로 구분" value="${esc(state.requested.join(', '))}"></label>`;}
 function renderPlatform(){ $('content').innerHTML=`<section class="rw-page"><div class="rw-config">${platformSelectors()}<label>상품가격 기준<select id="rw-anchor">${option({lowest:'전체 옵션 중 최저가',middle:'전체 옵션 중 중간가격'},'lowest')}</select></label><label>등록가격 수식<select id="rw-registration"></select></label><label>할인 수식<select id="rw-discount"></select></label><label>계산 방식<select id="rw-mode">${option({reverse:'자동 역산 · 목표 최종가 유지',forward:'등록가격 수식 적용 후 할인'},'reverse')}</select></label><label>옵션가 계산<input readonly value="각 옵션 계산가 − 상품 기준가"></label></div><div class="rw-bar"><button class="btn" id="rw-edit-registration">등록가 수식 편집</button><button class="btn" id="rw-edit-discount">할인 수식 편집</button><button class="btn" id="rw-platform-save">판매처 설정 저장</button><button class="btn" id="rw-platform-refresh-all">전체 저장가격 갱신</button><button class="btn primary" id="rw-platform-preview">입력 SKU 계산·저장</button></div><div class="rw-scroll"><table><thead><tr><th>SKU</th><th>내부 기준가격</th><th>플랫폼 상품가격</th><th>옵션가</th><th>할인</th><th>최종가격</th><th>상태</th></tr></thead><tbody id="rw-platform-rows"></tbody></table></div></section>`;$('platform-source').onchange=()=>run(loadPlatform);$('platform-save').onclick=()=>run(savePlatform);$('platform-preview').onclick=()=>run(platformPreview);$('platform-refresh-all').onclick=()=>run(materializeAll);for(const kind of ['registration','discount'])$('edit-'+kind).onclick=()=>{const id=$(kind).value;if(!id){status('편집할 수식을 선택하세요.');return;}state.tab='rules';state.selected=id;renderTab();};void loadPlatform().catch(e=>status(e.message));}
 async function loadPlatform(){const source=$('platform-source').value;state.platformDoc=await g.HubPlatformRules.settings(source);const f=state.platformDoc.body;for(const kind of ['registration','discount'])$(kind).innerHTML='<option value="">'+(kind==='discount'?'원본 할인 유지':'내부 기준가 그대로')+'</option>'+option(Object.fromEntries(state.registry.rules.filter(r=>r.scope===source&&r.target_field==='platform_'+kind+'_price'&&r.input_origin==='self').map(r=>[r.id,r.name])),f[kind+'_rule_id']);$('anchor').value=f.anchor;$('mode').value=f.mode;}
 async function savePlatform(){const source=$('platform-source').value;state.platformDoc=await D.workDocument('save','formula',{...state.platformDoc,title:'registry-platform:'+source,body:{source,anchor:$('anchor').value,mode:$('mode').value,registration_rule_id:$('registration').value||null,discount_rule_id:$('discount').value||null}});const skus=await allSkus(),calculation=await materialize(skus,{sources:[source],reason:`platform-settings:${source}`});status(`판매처 수식 연결 저장 완료 · ${calculationState(calculation)}`);g.dispatchEvent(new CustomEvent('hub-rules-changed',{detail:{persisted:true}}));if(skuText($('platform-skus').value).length)await showStoredPlatformRows();}
 async function materializeAll(){const skus=await allSkus(),calculation=await materialize(skus,{reason:'manual-full-price-refresh'});status(`전체 저장가격 갱신 완료 · 영향 ${calculation.totalSkus.toLocaleString('ko-KR')}개 SKU · 오류값 ${calculation.errorRows.toLocaleString('ko-KR')}개`);g.dispatchEvent(new CustomEvent('hub-rules-changed',{detail:{persisted:true}}));if(skuText($('platform-skus').value).length)await showStoredPlatformRows();}
 async function showStoredPlatformRows(){
  const source=$('platform-source').value,requested=skuText($('platform-skus').value),siblings=await D.loadRulePlatformSiblings(requested,source),displaySkus=[...new Set([...requested,...siblings])];
  const [stored,internal]=await Promise.all([D.loadStoredMatrixPrices({sources:[source],skus:displaySkus}),D.loadCalculatedResults({skus:displaySkus,scope:'',fields:['calculated_base_price']})]);
  const internalBySku=new Map(internal.rows.map(row=>[row.sku,row])),missing=new Map(stored.missing.map(row=>[row.sellpia_sku_code,row]));
  const rows=[...stored.rows,...displaySkus.filter(sku=>!stored.rows.some(row=>row.sellpia_sku_code===sku)).map(sku=>({sellpia_sku_code:sku,error:missing.get(sku)?.reason||'저장값 없음'}))];
  $('platform-rows').innerHTML=rows.map(row=>`<tr>${[row.sellpia_sku_code,money(internalBySku.get(row.sellpia_sku_code)?.value),money(row.base_price),money(row.option_price),row.base_price!=null&&row.discounted_base_price!=null?'−'+money(Number(row.base_price)-Number(row.discounted_base_price)):'—',money(row.final_price),row.error||internalBySku.get(row.sellpia_sku_code)?.error||'정상'].map(value=>`<td>${esc(value)}</td>`).join('')}</tr>`).join('');status(`${stored.rows.length} SKU 저장 가격 조회 · 누락 ${stored.missing.length}`);
 }
 async function platformPreview(){state.requested=skuText($('platform-skus').value);if(!state.requested.length)throw Error('대상 SKU를 입력하세요.');const source=$('platform-source').value,calculation=await materialize(state.requested,{sources:[source],reason:`platform-preview:${source}`});await showStoredPlatformRows();status(`${calculation.totalSkus.toLocaleString('ko-KR')}개 영향 SKU 계산·저장 · 오류값 ${calculation.errorRows.toLocaleString('ko-KR')}개`);g.dispatchEvent(new CustomEvent('hub-rules-changed',{detail:{persisted:true}}));}
 async function exportTargetSkus(){
  if($('export-scope').value!=='assigned')return skuText($('platform-skus').value);
  const source=$('platform-source').value,candidates=[...new Set(state.registry.assignments.filter(a=>!a.scope||a.scope===source).map(a=>a.sku))];
  if(!candidates.length)return [];
  if(typeof D.filterRulePlatformSkus!=='function')throw Error('판매처 연결 SKU 조회 기능을 불러오지 못했습니다. 새로고침 후 다시 시도하세요.');
  return D.filterRulePlatformSkus(candidates,source);
 }
 async function prepareStoredExport(){
  const source=$('platform-source').value,skus=await exportTargetSkus();if(!skus.length)throw Error('내보낼 SKU가 없습니다. 대상 SKU를 입력하거나 적용된 전체 SKU를 선택하세요.');
  status('최신 보관 원본을 불러오는 중…');const files=await D.downloadLatestSellerOriginals([source],progress=>status(`원본 파일 ${progress.completed||0} / ${progress.total||0}개 불러오는 중`));
  const selectedName=$('export-file').value,selectedFiles=(files.get(source)||[]).filter(file=>!selectedName||file.name===selectedName);if(!selectedFiles.length)throw Error('선택한 최신 원본 파일을 확인하지 못했습니다.');
  const filesBySource=new Map([[source,selectedFiles]]);status('매트릭스에 저장된 가격을 읽어 원본 행과 연결하는 중…');
  const refreshed=await g.HubCurrentPriceExport.refreshItems([],filesBySource,{sources:[source],skus,includeRules:true,onProgress:status});
  return {source,skus,filesBySource,...refreshed};
 }
 async function previewStoredExport(){
  const prepared=await prepareStoredExport(),rows=prepared.items.filter(item=>item.field_key==='sellpia_sale_price'&&!item.preserve_unmapped);
  const previewRows=[
   ...rows.map(item=>({sku:item.sellpia_sku_code,before:item.before_value,after:item.after_value,detail:[[item.base_price,item.target_base_price,'등록가격'],[item.option_price,item.target_option_price,'옵션가'],[item.before_value,item.after_value,'최종가격']].filter(([before,after])=>before==null||Number(before)!==Number(after)).map(([, ,label])=>label).join(' / ')||'변경 없음'})),
   ...prepared.excludedItems.map(entry=>({sku:entry.item?.sellpia_sku_code||'',before:'—',after:'—',detail:'제외 · '+entry.reason}))
  ];
  $('export-rows').innerHTML=previewRows.map(row=>`<tr>${[row.sku,money(row.before),money(row.after),row.detail].map(value=>`<td>${esc(value)}</td>`).join('')}</tr>`).join('')||'<tr><td colspan="4" class="rw-empty">연결된 저장 가격이 없습니다.</td></tr>';
  status(`저장 가격 미리보기 · 적용 ${rows.length.toLocaleString('ko-KR')}건 · 제외 ${prepared.excludedItems.length.toLocaleString('ko-KR')}건`);
 }
 async function runStoredExport(){
  const prepared=await prepareStoredExport();status('저장 가격을 최신 원본 양식에 기록하는 중…');
  const result=await g.HubCurrentPriceExport.buildArchive(prepared.filesBySource,prepared.items,(percent,detail)=>status(`${Math.round(percent)}% · ${detail}`),prepared.excludedItems);
  const applied=result.appliedItems.filter(item=>item.stored_matrix_price&&!item.preserve_unmapped&&item.sellpia_sku_code),versions=[...new Map(applied.flatMap(item=>item.rule_versions||[]).map(version=>[version.id,version])).values()];
  await D.workDocument('save','formula',{title:'registry-export:'+g.crypto.randomUUID(),body:{source:prepared.source,created_at:new Date().toISOString(),rule_versions:versions,generation_ids:[...new Set(applied.map(item=>item.generation_id).filter(Boolean))],sku_count:new Set(applied.map(item=>item.sellpia_sku_code)).size,manifest:result.manifest,skipped_count:result.skippedItems.length}});
  g.SystemV3SellerExport.downloadBlob(result.blob,`SystemV3_${prepared.source}_저장가격_${new Date().toISOString().slice(0,10)}.zip`);status(`XLSX 생성 완료 · 저장 가격 반영 ${applied.length.toLocaleString('ko-KR')}건 · 제외 ${result.skippedItems.length.toLocaleString('ko-KR')}건`);await loadHistory();
 }
 function renderExport(){
  $('content').innerHTML=`<section class="rw-page"><div class="rw-config">${platformSelectors()}<label>대상 범위<select id="rw-export-scope">${option({entered:'입력 SKU와 같은 상품의 전체 옵션',assigned:'수식이 적용된 전체 SKU'},'entered')}</select></label><label>원본 파일<select id="rw-export-file"><option value="">최신 보관 원본 전체</option></select></label></div><p class="rw-stage-note">내보내기에서는 수식을 다시 계산하지 않습니다. 매트릭스에 저장된 판매처 가격을 결과만 최신 보관 원본 양식에 기록합니다.</p><div class="rw-bar"><button class="btn" id="rw-export-preview">원본값 / 저장값 미리보기</button><button class="btn primary" id="rw-export-run">저장값으로 XLSX 생성</button></div><div class="rw-scroll"><table><thead><tr><th>SKU</th><th>원본값</th><th>저장값</th><th>변경 항목</th></tr></thead><tbody id="rw-export-rows"></tbody></table><h3 style="padding:14px">최근 생성 이력</h3><table><thead><tr><th>생성 시각</th><th>판매처</th><th>SKU</th><th>적용 수식 버전</th></tr></thead><tbody id="rw-history"></tbody></table></div></section>`;
  $('export-preview').onclick=()=>run(previewStoredExport);$('export-run').onclick=()=>run(runStoredExport);$('platform-source').onchange=()=>run(loadOriginals);void (async()=>{await loadOriginals();await loadHistory();})().catch(error=>status(error.message));
 }
 async function loadOriginals(){const files=await D.loadLatestSellerOriginalStatus();const source=$('platform-source').value;const entry=files.find(r=>r.source===source);$('export-file').innerHTML='<option value="">최신 보관 원본 전체</option>'+option(Object.fromEntries((entry?.files||[]).map(f=>[f.name,f.name])), '');}
 async function loadHistory(){const docs=(await D.workDocument('list','formula')).filter(d=>d.title.startsWith('registry-export:')).slice(0,20);const history=await Promise.all(docs.map(d=>D.workDocument('get','formula',{id:d.id})));if(!$('history'))return;$('history').innerHTML=history.map(d=>`<tr><td>${esc(d.body.created_at)}</td><td>${esc(sources[d.body.source])}</td><td>${d.body.sku_count}</td><td>${esc((d.body.rule_versions||[]).map(r=>name(r.id)+' v'+r.version).join(', '))}</td></tr>`).join('');}
 $('new').onclick=newFormulaTag;$('refresh').onclick=()=>run(refresh);$('close').onclick=()=>{$('backdrop').hidden=true;};$('backdrop').onclick=e=>{if(e.target===$('backdrop'))$('backdrop').hidden=true;};document.addEventListener('keydown',e=>{if(e.key==='Escape')$('backdrop').hidden=true;});document.querySelectorAll('.rw-tabs button').forEach(b=>b.onclick=()=>{if(b.dataset.tab==='bulk'){void run(openTagImport);return;}state.tab=b.dataset.tab;renderTab();});
 g.HubPriceWorkspace={blockedTagWorkbook,refresh:()=>run(refresh),openForTag,state,parseTagImportRows,tagNameFromFilename,normalizeTagName,resolveTagImportTag,formatTagWorkbookSkuColumn,addTagWorkbookMetadata,openTagImport:options=>run(()=>openTagImport(options))};g.TagPriceWorkspace=g.HubPriceWorkspace;renderTab();
})(window);
