(function initTagManagementV2(global){
 'use strict';
 const D=()=>global.SystemV3Data;
 const state={mode:'all',kind:'all',catalog:[],catalogSearch:'',selectedTagId:'',tag:null,page:1,pageSize:100,count:0,appliedCount:0,rows:[],memberSearch:'',selected:new Set(),rules:[],carrierPolicyDocument:null,carrierPolicyLoading:false,carrierPolicyLoadedTagIds:new Set(),carrierPolicyStrategies:new Map(),loading:false};
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const n=v=>Number(v||0).toLocaleString('ko-KR');
 const number=v=>Number.isFinite(Number(v))?Number(v).toLocaleString('ko-KR'):String(v??'—');
 const safeName=v=>String(v||'태그').replace(/[\\/:*?"<>|]+/g,'_').trim().slice(0,80)||'태그';
 const sellerNames={smartstore:'스마트스토어',makeshop:'메이크샵',ably:'에이블리'};
 const carrierPolicyLabels={lowest:'대표가 최저',lower_middle:'대표가 중간',preserve_existing_base:'기존 I 유지'};
 const hasPriceRule=tag=>Number(tag?.rule_count||0)>0;
 const hasCarrierPolicy=tag=>Boolean(state.carrierPolicyStrategies.get(String(tag?.tag_id||'')));
 function badgeMarkup(tag,{catalog=false}={}){
  if(!tag)return '';
  const badges=[];
  if(hasPriceRule(tag))badges.push('<small class="tag-kind matrix">MATRIX · 가격 계산</small>');
  if(hasCarrierPolicy(tag)){
   const strategy=state.carrierPolicyStrategies.get(String(tag.tag_id))||'';
   badges.push(`<small class="tag-kind carrier">ABLY EXPORT · ${esc(strategy?carrierPolicyLabels[strategy]||strategy:catalog?'정책 있음':'내보내기 정책')}</small>`);
  }
  if(!badges.length)badges.push(`<small class="tag-kind plain">${catalog&&!state.carrierPolicyLoadedTagIds.has(String(tag.tag_id))?'MATRIX · 가격 계산 없음':'일반 태그'}</small>`);
  return badges.join(' ');
 }
 function formulaText(source,rule){
  const operations={add:'+',subtract:'−',multiply:'×',divide:'÷',set:'='};
  const rounding={nearest:'반올림',up:'올림',down:'내림'};
  const steps=rule.config?.steps||[];
  if(!steps.length)return `${source} → 그대로 사용`;
  let text=source;
  for(const step of steps){
   if(step.op==='round')text+=` → ${number(step.unit)} 단위 ${rounding[step.rounding]||'반올림'}`;
   else {
    const identity=(step.op==='add'||step.op==='subtract')&&Number(step.value)===0||(step.op==='multiply'||step.op==='divide')&&Number(step.value)===1;
    const unit=['add','subtract','set'].includes(step.op)?'원':'';
    text+=identity?' → 그대로 사용':` → ${operations[step.op]||step.op} ${number(step.value)}${unit}`;
   }
  }
  return text;
 }
 function ruleDisplay(rule){
  const M=global.HubRuleRegistry||{},labels=M.fields||{};
  const sourceLabel=labels[rule.source_field]||rule.source_field||'시작값';
  const targetLabel=labels[rule.target_field]||rule.target_field||'저장값';
  const sourceSeller=M.isPlatform?.(rule.source_field)?(sellerNames[rule.source_scope||rule.scope]||'저장 판매처와 동일'):'';
  const destination=M.isPlatform?.(rule.target_field)?(sellerNames[rule.scope]||'전체 판매처'):'공통';
  const source=`${sourceSeller?sourceSeller+' · ':''}${sourceLabel}`;
  return {source,target:targetLabel,destination,formula:formulaText(source,rule),code:rule.scope==='makeshop'&&rule.target_field==='platform_discount_price'?rule.config?.discount_rule_code||'':''};
 }
 function host(){return document.getElementById('attributes');}
 function pageCount(){return Math.max(1,Math.ceil(state.count/state.pageSize));}
 function setStatus(text,kind=''){const el=document.getElementById('tag-manager-status');if(!el)return;el.className=`tag-manager-status ${kind}`.trim();el.textContent=text;}
 function currentTag(){return state.catalog.find(tag=>String(tag.tag_id)===String(state.selectedTagId))||null;}

 function ensureShell(){
  const h=host(),title=h?.querySelector('.attributes-title');
  if(!h||!title||h.querySelector('.attributes-view-tabs'))return;
  const tabs=document.createElement('nav');
  tabs.className='attributes-view-tabs';
  tabs.setAttribute('aria-label','상품 태그 보기');
  tabs.innerHTML='<button type="button" data-tag-view="all" aria-selected="true">전체 SKU</button><button type="button" data-tag-view="tag" aria-selected="false">태그별 관리</button>';
  title.insertAdjacentElement('afterend',tabs);
  const manager=document.createElement('section');
  manager.id='tag-manager-v2';
  manager.className='tag-manager-v2';
  manager.hidden=true;
  manager.innerHTML=`
   <aside class="tag-manager-panel">
    <div class="tag-manager-head"><div><h3>태그 목록</h3><p>목록에서는 Matrix 가격 계산 여부를 표시합니다. Ably 내보내기 정책은 태그를 선택하면 정확히 표시됩니다.</p></div><button class="btn" id="tag-new-open" type="button">새 태그</button></div>
    <form id="tag-new-form" class="tag-manager-new" hidden>
      <label>태그 이름<input id="tag-new-name" maxlength="32" placeholder="예: 소스_2000"></label>
      <label>색상<input id="tag-new-color" type="color" value="#dbeafe"></label>
      <label class="tag-manager-formula-check"><input id="tag-new-formula" type="checkbox"> 가격 수식 사용</label>
      <div><button class="btn primary" id="tag-new-save" type="submit">저장</button><button class="btn" id="tag-new-cancel" type="button">취소</button></div>
    </form>
    <nav class="tag-kind-tabs" aria-label="태그 종류"><button type="button" data-tag-kind="all" aria-selected="true">전체</button><button type="button" data-tag-kind="plain" aria-selected="false">가격 계산 없음</button><button type="button" data-tag-kind="formula" aria-selected="false">가격 계산</button></nav>
    <form id="tag-catalog-search" class="tag-manager-search"><input id="tag-catalog-query" placeholder="태그 이름 검색"><button class="btn" type="submit">검색</button></form>
    <div id="tag-catalog" class="tag-catalog"></div>
   </aside>
   <section class="tag-manager-panel">
    <div class="tag-manager-head"><div><h3 id="tag-member-title">태그를 선택하세요</h3><p id="tag-member-copy">저장된 태그 적용 내역을 조회·수정할 수 있습니다.</p></div><button class="btn" id="tag-member-refresh" type="button">새로고침</button></div>
    <form id="tag-member-search" class="tag-manager-search"><input id="tag-member-query" placeholder="새로 적용할 SKU / 자사코드 / 상품명 / 옵션명 검색"><button class="btn primary" type="submit">전체 SKU 검색</button><button class="btn" id="tag-member-search-clear" type="button">적용 목록</button></form>
    <div class="tag-manager-selection-actions"><span id="tag-member-selection-copy">태그 적용 SKU 목록</span><div><button class="btn" id="tag-recalculate-selected" type="button" disabled>선택 SKU 내부 수식 재계산</button><button class="btn primary" id="tag-apply-selected" type="button" disabled>선택 SKU에 현재 태그 적용</button></div></div>
    <div class="tag-manager-table-wrap"><table class="tag-manager-table"><thead><tr><th class="check"><input id="tag-member-select-page" type="checkbox" aria-label="현재 페이지 전체 선택"></th><th class="sku">SKU</th><th class="code">자사코드</th><th>상품 / 옵션</th><th class="state">적용 상태</th></tr></thead><tbody id="tag-member-rows"></tbody></table></div>
    <nav class="tag-manager-pagination"><button class="btn" id="tag-member-prev" type="button">이전</button><span id="tag-member-page">1 / 1</span><button class="btn" id="tag-member-next" type="button">다음</button></nav>
   </section>
   <aside class="tag-manager-panel tag-manager-side">
    <div class="tag-selected-card"><div><h3 id="tag-selected-name">태그 미선택</h3><button class="btn" id="tag-rename" type="button" disabled>태그 이름 수정</button></div><p id="tag-selected-group">왼쪽에서 태그를 선택하세요.</p></div>
     <div class="tag-stat-grid"><div><span>적용 SKU</span><b id="tag-stat-count">-</b></div><div><span>가격 Rule</span><b id="tag-stat-rules">-</b></div></div>
     <div class="tag-rule-summary"><span>가격 계산 · MATRIX</span><p>Price Rule이 Matrix의 계산 가격을 만듭니다. 내보내기에서 '수식 적용'을 선택하면 이 결과가 목표가격으로 사용됩니다.</p><div id="tag-rule-list"><i>태그를 선택하면 표시됩니다.</i></div></div>
     <div class="tag-carrier-policy"><span>내보내기 정책 · ABLY</span><p>Matrix 가격 자체는 변경하지 않습니다. 이미 결정된 옵션 최종가격을 PlayAuto 판매가(I)와 옵션 추가금액(T)으로 표현하는 방식만 결정합니다.</p><label>대표가 정책<select id="tag-ably-policy" disabled><option value="">기본값 상속</option><option value="lowest">최저가</option><option value="lower_middle">중간값 (lower-middle)</option><option value="preserve_existing_base">기존 판매가 I 유지</option></select></label><small id="tag-ably-policy-help">태그를 선택하면 설정할 수 있습니다.</small><button class="btn" id="tag-ably-policy-save" type="button" disabled>내보내기 정책 저장</button></div>
    <div class="tag-manager-actions">
      <button class="btn wide" id="tag-download-current" type="button" disabled>현재 적용 목록 XLSX</button>
      <button class="btn" id="tag-download-blank" type="button" disabled>빈 템플릿</button>
      <button class="btn" id="tag-upload-sync" type="button">엑셀 업로드</button>
      <button class="btn" id="tag-edit-rule" type="button" disabled>수식 관리</button>
      <button class="btn tag-manager-danger" id="tag-remove-selected" type="button" disabled>선택 해제</button>
      <button class="btn tag-manager-danger" id="tag-clear-all" type="button" disabled>전체 적용 해제</button>
      <button class="btn tag-manager-danger" id="tag-delete-unused" type="button" disabled>태그 삭제</button>
    </div>
    <div id="tag-manager-status" class="tag-manager-status">태그를 선택하세요.</div>
   </aside>`;
  const quick=h.querySelector('.attributes-quick-actions'),layout=h.querySelector('.attributes-layout');
  (quick||layout)?.insertAdjacentElement('afterend',manager);
  bind();
 }

 function setMode(mode){
  state.mode=mode;
  const h=host(),manager=document.getElementById('tag-manager-v2');
  h?.classList.toggle('tag-manager-mode',mode==='tag');
  if(manager)manager.hidden=mode!=='tag';
  h?.querySelectorAll('[data-tag-view]').forEach(btn=>btn.setAttribute('aria-selected',String(btn.dataset.tagView===mode)));
  if(mode==='tag'&&!state.catalog.length)void loadCatalog();
 }

 async function loadCatalog({keepSelection=true}={}){
  if(state.loading)return;
  state.loading=true;setStatus('태그 목록을 불러오는 중…');
  try{
   const result=await D().loadTagCatalog({search:state.catalogSearch});
   state.catalog=result.rows||[];
   if(!keepSelection||!state.catalog.some(t=>String(t.tag_id)===String(state.selectedTagId))){state.selectedTagId='';state.tag=null;state.rows=[];state.count=0;state.appliedCount=0;state.selected.clear();state.carrierPolicyDocument=null;}
   else state.appliedCount=Number(currentTag()?.option_count||0);
   renderCatalog();renderSelected();
   if(state.selectedTagId)await loadMembers();
   else setStatus(`활성 태그 ${n(state.catalog.length)}개`);
  }catch(error){setStatus(`태그 목록 조회 실패: ${error?.message||error}`,'error');}
  finally{state.loading=false;}
 }

 function renderCatalog(){
  const box=document.getElementById('tag-catalog');if(!box)return;
  const matchesKind=tag=>state.kind==='all'||state.kind==='formula'&&hasPriceRule(tag)||state.kind==='plain'&&!hasPriceRule(tag);
  const visible=state.catalog.filter(matchesKind);
  box.innerHTML=visible.map(tag=>`<button type="button" data-tag-id="${esc(tag.tag_id)}" class="${String(tag.tag_id)===String(state.selectedTagId)?'active':''}" style="--tag-color:${esc(tag.tag_color||'#dbeafe')}"><span class="tag-color-dot"></span><span class="tag-catalog-name"><b>${esc(tag.tag_name)}</b><span class="tag-catalog-badges">${badgeMarkup(tag,{catalog:true})}</span></span><em>${n(tag.option_count)}</em></button>`).join('')||'<p class="tag-manager-empty">해당 종류의 태그가 없습니다.</p>';
  box.querySelectorAll('[data-tag-id]').forEach(btn=>btn.onclick=()=>selectTag(btn.dataset.tagId));
 }

 async function selectTag(tagId){
  state.selectedTagId=tagId;state.tag=currentTag();state.page=1;state.memberSearch='';state.appliedCount=Number(state.tag?.option_count||0);state.selected.clear();
  const q=document.getElementById('tag-member-query');if(q)q.value='';
   state.carrierPolicyDocument=null;renderCatalog();renderSelected();await Promise.all([loadMembers(),loadRules(),loadCarrierPolicy()]);
  }

  async function loadCarrierPolicy(){
   if(!state.selectedTagId||!D().loadAblyCarrierPolicy)return;
   state.carrierPolicyLoading=true;renderSelected();
   try{
    const tagId=String(state.selectedTagId),document=await D().loadAblyCarrierPolicy(tagId),strategy=document?.body?.carriers?.ably?.representativeStrategy||'';
    state.carrierPolicyDocument=document;
    state.carrierPolicyLoadedTagIds.add(tagId);
    if(strategy)state.carrierPolicyStrategies.set(tagId,strategy);else state.carrierPolicyStrategies.delete(tagId);
   }
   catch(error){state.carrierPolicyDocument=null;setStatus(`에이블리 내보내기 정책 조회 실패: ${error?.message||error}`,'error');}
   finally{state.carrierPolicyLoading=false;renderCatalog();renderSelected();}
  }

  async function saveCarrierPolicy(){
   const tag=currentTag(),select=document.getElementById('tag-ably-policy');if(!tag||!select||!D().saveAblyCarrierPolicy)return;
   select.disabled=true;document.getElementById('tag-ably-policy-save').disabled=true;setStatus('에이블리 내보내기 정책을 저장하는 중…');
   try{
    await D().saveAblyCarrierPolicy({tagId:tag.tag_id,strategy:select.value,document:state.carrierPolicyDocument});
    state.carrierPolicyDocument=await D().loadAblyCarrierPolicy(tag.tag_id);
    const tagId=String(tag.tag_id),strategy=state.carrierPolicyDocument?.body?.carriers?.ably?.representativeStrategy||'';
    state.carrierPolicyLoadedTagIds.add(tagId);
    if(strategy)state.carrierPolicyStrategies.set(tagId,strategy);else state.carrierPolicyStrategies.delete(tagId);
    renderCatalog();renderSelected();
    setStatus(select.value==='lower_middle'?'lower-middle 정책을 저장했습니다. 실제 다운로드는 허용범위 확인 전까지 차단됩니다.':'에이블리 내보내기 정책을 저장했습니다.','success');
    global.dispatchEvent(new CustomEvent('hub-tags-changed',{detail:{tagId:tag.tag_id,carrierPolicy:true}}));
   }catch(error){setStatus(`에이블리 내보내기 정책 저장 실패: ${error?.message||error}`,'error');}
   finally{renderSelected();}
  }

 async function loadRules(){
  if(!state.selectedTagId)return;
  try{
   const registry=await D().ruleRegistry('list');
   state.rules=(registry.rules||[]).filter(rule=>String(rule.tag_id)===String(state.selectedTagId));
  }catch{state.rules=[];}
  renderSelected();
 }

 async function loadMembers(){
  if(!state.selectedTagId)return;
  setStatus('저장된 적용 SKU를 불러오는 중…');
  try{
   let result;
   if(state.memberSearch){
    result=await D().loadTagMemberSearch({tagId:state.selectedTagId,page:state.page,pageSize:state.pageSize,search:state.memberSearch});
    state.rows=(result.rows||[]).map(row=>({...row,__tagApplied:row.tag_applied===true}));
   }else{
    result=await D().loadTagMembers({tagId:state.selectedTagId,page:state.page,pageSize:state.pageSize,search:''});
    state.rows=(result.rows||[]).map(row=>({...row,__tagApplied:true}));state.appliedCount=Number(result.count||0);
    const tag=currentTag();if(tag)tag.option_count=state.appliedCount;
   }
   state.count=Number(result.count||0);state.selected.clear();
   renderCatalog();renderMembers();renderSelected();setStatus(state.memberSearch?`검색 결과 ${n(state.count)}개 · 태그 적용 상태를 확인하고 선택하세요.`:`${n(state.appliedCount)}개 적용 SKU · 현재 ${n(state.rows.length)}개 표시`,'success');
  }catch(error){state.rows=[];state.count=0;renderMembers();setStatus(`적용 SKU 조회 실패: ${error?.message||error}`,'error');}
 }

 function renderMembers(){
  const body=document.getElementById('tag-member-rows');if(!body)return;
  body.innerHTML=state.rows.map(row=>`<tr class="${row.__tagApplied?'tag-applied':''}"><td class="check"><input type="checkbox" data-tag-member="${esc(row.sellpia_sku_code)}" ${state.selected.has(row.sellpia_sku_code)?'checked':''}></td><td><b>${esc(row.sellpia_sku_code)}</b></td><td>${esc(row.own_sku||row.sellpia_own_code||'—')}</td><td class="product"><b>${esc(row.sellpia_product_name||row.display_name||'상품명 없음')}</b><span>${esc(row.sellpia_option_name||'옵션 없음')}</span></td><td class="tag-member-state"><b>${row.__tagApplied?'적용됨':'미적용'}</b></td></tr>`).join('')||'<tr><td colspan="5" class="tag-manager-empty">'+(state.memberSearch?'검색과 일치하는 SKU가 없습니다.':'적용된 SKU가 없습니다.')+'</td></tr>';
  body.querySelectorAll('[data-tag-member]').forEach(input=>input.onchange=()=>{input.checked?state.selected.add(input.dataset.tagMember):state.selected.delete(input.dataset.tagMember);renderSelected();});
  const p=pageCount(),label=document.getElementById('tag-member-page');if(label)label.textContent=`${state.page} / ${p}`;
  document.getElementById('tag-member-prev').disabled=state.page<=1;
  document.getElementById('tag-member-next').disabled=state.page>=p;
  const selectPage=document.getElementById('tag-member-select-page');
  if(selectPage){selectPage.checked=state.rows.length>0&&state.rows.every(r=>state.selected.has(r.sellpia_sku_code));selectPage.indeterminate=state.rows.some(r=>state.selected.has(r.sellpia_sku_code))&&!selectPage.checked;}
  const selectionCopy=document.getElementById('tag-member-selection-copy');if(selectionCopy)selectionCopy.textContent=state.memberSearch?`전체 SKU 검색 결과 ${n(state.count)}개`:`태그 적용 SKU ${n(state.appliedCount)}개`;
 }

  function renderSelected(){
   const tag=currentTag();
   const policy=state.carrierPolicyDocument?.body?.carriers?.ably?.representativeStrategy||'';
   const name=document.getElementById('tag-selected-name'),group=document.getElementById('tag-selected-group');
   if(name)name.innerHTML=tag?`${esc(tag.tag_name)} ${badgeMarkup(tag)}`:'태그 미선택';
  if(group){
   const roles=[hasPriceRule(tag)?'Matrix 가격 계산':'',hasCarrierPolicy(tag)?'Ably 내보내기 정책':''].filter(Boolean);
   group.textContent=tag?`${tag.tag_group||'운영'} · ${roles.join(' + ')||'분류·운영용 태그'} · 저장 기준 option 태그`:'왼쪽에서 태그를 선택하세요.';
  }
  const title=document.getElementById('tag-member-title'),copy=document.getElementById('tag-member-copy');
  if(title)title.textContent=tag?tag.tag_name:'태그를 선택하세요';
  if(copy)copy.textContent=tag?`현재 DB에 저장된 ${n(state.appliedCount)}개 SKU 적용 내역`:'저장된 태그 적용 내역을 조회·수정할 수 있습니다.';
  document.getElementById('tag-stat-count').textContent=tag?n(state.appliedCount):'-';
  document.getElementById('tag-stat-rules').textContent=tag?n(state.rules.length||tag.rule_count):'-';
   const ruleList=document.getElementById('tag-rule-list');
   if(ruleList)ruleList.innerHTML=tag?(state.rules.length?state.rules.map(rule=>{const view=ruleDisplay(rule);return `<i class="tag-rule-item"><span class="tag-rule-item-head"><b class="tag-rule-destination">${esc(view.destination)} 저장</b><small>${esc(rule.name)}${view.code?' · '+esc(view.code):''}</small></span><strong class="tag-rule-formula"><small>계산식</small>${esc(view.formula)}</strong><span class="tag-rule-result">결과 → ${esc(view.target)}</span></i>`;}).join(''):'<i>연결된 수식 없음</i>'):'<i>태그를 선택하면 표시됩니다.</i>';
   const policySelect=document.getElementById('tag-ably-policy'),policySave=document.getElementById('tag-ably-policy-save'),policyHelp=document.getElementById('tag-ably-policy-help');
   if(policySelect){policySelect.value=policy;policySelect.disabled=!tag||state.carrierPolicyLoading;}
   if(policySave)policySave.disabled=!tag||state.carrierPolicyLoading||!D().saveAblyCarrierPolicy;
   if(policyHelp)policyHelp.textContent=!tag?'태그를 선택하면 설정할 수 있습니다.':state.carrierPolicyLoading?'정책을 불러오는 중…':policy==='lower_middle'?'계산과 미리보기만 가능합니다. PlayAuto/Ably 옵션가 허용 규칙 확인 전까지 실제 다운로드는 차단됩니다.':policy?'이 태그가 적용된 Ably 상품의 PlayAuto I/T 표현에만 적용됩니다. Matrix 가격은 변경하지 않습니다.':'명시적 policy가 없습니다. rules는 기존 platformBase, sellpia_source는 lowest legacy fallback을 유지합니다.';
  for(const id of ['tag-download-current','tag-download-blank','tag-edit-rule','tag-clear-all','tag-rename'])document.getElementById(id).disabled=!tag;
  const deleteButton=document.getElementById('tag-delete-unused');
  if(deleteButton){
   deleteButton.disabled=!tag;
   deleteButton.title=!tag?'태그를 먼저 선택하세요.':'미리보기 후 연결된 SKU·상품·수식을 한 번에 해제하고 태그를 비활성화합니다. 과거 기록은 보존됩니다.';
  }
  document.getElementById('tag-upload-sync').disabled=false;
  const chosen=state.rows.filter(row=>state.selected.has(row.sellpia_sku_code));
  document.getElementById('tag-recalculate-selected').disabled=!tag||!chosen.length;
  document.getElementById('tag-apply-selected').disabled=!tag||!chosen.some(row=>!row.__tagApplied);
  document.getElementById('tag-remove-selected').disabled=!tag||!chosen.some(row=>row.__tagApplied);
 }

 async function allMembers(){
  if(!state.selectedTagId)return[];
  const rows=[];let page=1;const pageSize=1000;
  while(true){
   const result=await D().loadTagMembers({tagId:state.selectedTagId,page,pageSize,search:''});
   rows.push(...(result.rows||[]));
   if(rows.length>=Number(result.count||0)||(result.rows||[]).length<pageSize)break;
   page++;
  }
  return rows;
 }

 function workbook(rows,fileName,tag){
  if(!global.XLSX)throw Error('XLSX 모듈을 불러오지 못했습니다.');
  const data=[['셀피아 SKU','상품명(메모)','옵션명(메모)','자사코드(메모)','메모'],...rows.map(row=>[row.sellpia_sku_code||'',row.sellpia_product_name||'',row.sellpia_option_name||'',row.own_sku||'',row.memo||''])];
  const book=global.XLSX.utils.book_new(),sheet=global.XLSX.utils.aoa_to_sheet(data);
  sheet['!cols']=[{wch:18},{wch:42},{wch:34},{wch:22},{wch:28}];
  global.HubPriceWorkspace?.formatTagWorkbookSkuColumn?.(sheet,5000);
  global.XLSX.utils.book_append_sheet(book,sheet,'태그일괄적용');
  global.HubPriceWorkspace?.addTagWorkbookMetadata?.(book,{tag_id:tag?.tag_id||'',tag_name:tag?.tag_name||''});
  global.XLSX.writeFile(book,fileName);
 }

 async function downloadCurrent(){
  const tag=currentTag();if(!tag)return;
  setStatus('현재 저장된 태그 적용 목록을 XLSX로 만드는 중…');
  try{const rows=await allMembers();workbook(rows,`${safeName(tag.tag_name)}_일괄적용.xlsx`,tag);setStatus(`${n(rows.length)}개 저장 내역 XLSX 다운로드 완료`,'success');}
  catch(error){setStatus(`XLSX 생성 실패: ${error?.message||error}`,'error');}
 }

 function downloadBlank(){
  const tag=currentTag();if(!tag)return;
  workbook([],`${safeName(tag.tag_name)}_일괄적용.xlsx`,tag);
  setStatus('빈 동기화 템플릿을 다운로드했습니다. A열을 비운 채 파일 기준 동기화하면 전체 해제할 수 있습니다.','success');
 }

 function openUpload(){
  const tag=currentTag();
  setStatus(tag?`'${tag.tag_name}'을 공통 태그로 미리 선택했습니다. '<태그명>_일괄적용.xlsx' 파일은 파일명을 우선 자동 인식합니다.`:`'<태그명>_일괄적용.xlsx' 파일은 태그를 선택하지 않아도 파일명으로 자동 인식합니다.`);
  const openTagImport=global.HubPriceWorkspace?.openTagImport;
  if(typeof openTagImport!=='function'){setStatus('엑셀 일괄등록 화면을 불러오지 못했습니다. 페이지를 새로고침해 주세요.','error');return;}
  openTagImport({openFilePicker:true,tagId:tag?.tag_id||null});
 }

 async function editRule(){
  const tag=currentTag();if(!tag)return;
  if(!global.HubPriceWorkspace?.openForTag){setStatus('수식 편집기를 불러오지 못했습니다.','error');return;}
  await global.HubPriceWorkspace.openForTag({id:tag.tag_id,name:tag.tag_name,color:tag.tag_color,group:tag.tag_group});
 }

 function toggleNewTag(open){
  const form=document.getElementById('tag-new-form');if(!form)return;
  form.hidden=!open;
  if(open)document.getElementById('tag-new-name').focus();
 }

 async function createTag(event){
  event.preventDefault();
  const name=document.getElementById('tag-new-name').value.trim(),color=document.getElementById('tag-new-color').value,formula=document.getElementById('tag-new-formula').checked;
  if(!name){setStatus('새 태그 이름을 입력하세요.','error');document.getElementById('tag-new-name').focus();return;}
  const button=document.getElementById('tag-new-save');button.disabled=true;
  try{
   if(formula){
    if(!global.HubPriceWorkspace?.openForTag)throw Error('수식 편집기를 불러오지 못했습니다.');
    toggleNewTag(false);await global.HubPriceWorkspace.openForTag({name,color,group:'가격 수식'});return;
   }
   const created=await D().createProductTag({name,color,group:'운영'});
   state.catalogSearch='';state.selectedTagId=created.tag_id;state.kind='all';
   const query=document.getElementById('tag-catalog-query');if(query)query.value='';
   document.querySelectorAll('[data-tag-kind]').forEach(item=>item.setAttribute('aria-selected',String(item.dataset.tagKind==='all')));
   toggleNewTag(false);await loadCatalog({keepSelection:true});await selectTag(created.tag_id);setStatus(`${created.tag_name} 일반 태그를 저장했습니다.`,'success');
  }catch(error){setStatus(`태그 저장 실패: ${error?.message||error}`,'error');}
  finally{button.disabled=false;}
 }

 async function recalc(skus,reason,sources=['smartstore','makeshop','ably']){
  if(!skus.length||!global.HubPriceMaterializer?.materialize)return {skipped:true};
  try{return {result:await global.HubPriceMaterializer.materialize({skus:[...new Set(skus)],sources,reason})};}
  catch(error){return {error:error?.message||String(error)};}
 }

 async function applySelected(){
  const tag=currentTag(),rows=state.rows.filter(row=>state.selected.has(row.sellpia_sku_code)&&!row.__tagApplied);if(!tag||!rows.length)return;
  setStatus(`선택한 ${n(rows.length)}개 SKU에 '${tag.tag_name}' 태그를 적용하는 중…`);
  try{
   for(const row of rows){
    const profile=row.__profile||await D().ensureProductProfile(row.sellpia_sku_code),skuTags=profile?.sku_tags||[];
    await D().saveProductProfile({sku:row.sellpia_sku_code,material:profile?.material||'',productGroup:profile?.product_group||'',shape:profile?.shape||'',productTagIds:(profile?.product_tags||[]).map(item=>item.tag_id),skuTagIds:[...new Set([...skuTags.map(item=>item.tag_id),tag.tag_id])]});
   }
   const skus=rows.map(row=>row.sellpia_sku_code),calculation=await recalc(skus,'tag-manager-apply');await loadCatalog({keepSelection:true});
   setStatus(calculation.error?`태그 적용 ${n(rows.length)}개 완료 · 수식 계산 확인 필요: ${calculation.error}`:`${n(rows.length)}개 SKU에 '${tag.tag_name}' 태그를 적용하고 수식을 계산했습니다.`,calculation.error?'error':'success');global.dispatchEvent(new CustomEvent('hub-tags-changed',{detail:{tagId:tag.tag_id,skus}}));
  }catch(error){setStatus(`태그 적용 실패: ${error?.message||error}`,'error');}
 }

 async function recalculateSelected(){
  const skus=state.rows.filter(row=>state.selected.has(row.sellpia_sku_code)).map(row=>row.sellpia_sku_code);
  if(!skus.length)return;
  const button=document.getElementById('tag-recalculate-selected');button.disabled=true;
  setStatus('선택 SKU 내부 수식을 재계산하는 중…');
  try{
   const calculation=await recalc(skus,'tag-manager-internal-retry',[]);
   const failed=calculation.error||calculation.skipped||calculation.result?.errorRows;
   setStatus(failed?'내부 수식 재계산 확인 필요: '+(calculation.error||'계산 오류/미실행'):
    '내부 수식 재계산 완료 · 영향 SKU '+n(calculation.result.totalSkus)+'개 · 저장 '+n(calculation.result.persistedRows)+'개',failed?'error':'success');
   global.dispatchEvent(new CustomEvent('hub-tags-changed',{detail:{skus}}));
  }finally{renderSelected();}
 }

 async function renameTag(){
  const tag=currentTag();if(!tag)return;
  const next=global.prompt('새 태그 이름을 입력하세요.',tag.tag_name);if(next===null)return;
  const name=String(next).trim();if(!name){setStatus('태그 이름을 비울 수 없습니다.','error');return;}
  try{await D().renameProductTag({id:tag.tag_id,name,expectedName:tag.tag_name});await loadCatalog({keepSelection:true});setStatus(`태그 이름을 '${name}'(으)로 수정했습니다.`,'success');global.dispatchEvent(new CustomEvent('hub-tags-changed',{detail:{tagId:tag.tag_id,renamed:true}}));}
  catch(error){setStatus(`태그 이름 수정 실패: ${error?.message||error}`,'error');}
 }

 async function deleteUnusedTag(){
  const tag=currentTag();if(!tag)return;
  const button=document.getElementById('tag-delete-unused');button.disabled=true;
  let retired=false;
  try{
   setStatus(`'${tag.tag_name}' 태그의 연결 범위를 확인하는 중…`);
   const preview=await D().retireProductTagCascade({id:tag.tag_id,expectedName:tag.tag_name,preview:true});
   const rules=Number(preview.rule_count||0)+Number(preview.product_rule_count||0);
   const prompt=`'${tag.tag_name}' 태그를 삭제할까요?\n\n연결된 옵션 SKU ${n(preview.option_count)}건, 상품 ${n(preview.product_count)}건, 기존 연결 ${n(preview.legacy_count)}건과 수식 ${n(rules)}개를 한 번에 해제합니다.\n영향 SKU ${n(preview.affected_sku_count)}개를 다시 계산합니다. 과거 기록은 보존됩니다.`;
   if(!global.confirm(prompt)){setStatus('태그 삭제를 취소했습니다.');return;}
   const result=await D().retireProductTagCascade({id:tag.tag_id,expectedName:tag.tag_name,preview:false,expectedOptionCount:preview.option_count,expectedProductCount:preview.product_count,expectedRuleCount:rules});
   retired=true;
   const skus=result.affected_skus||[];
   setStatus(`태그 연결 해제 완료 · 영향 SKU ${n(skus.length)}개 수식 재계산 중…`);
   const calculation=await recalc(skus,'tag-manager-retire-cascade');
   const calculationError=calculation.error||(calculation.result?.errorRows?`${n(calculation.result.errorRows)}개 계산 결과 오류`:null);
   state.selectedTagId='';state.tag=null;state.selected.clear();state.rules=[];
   await loadCatalog({keepSelection:false});
   setStatus(calculationError?`'${tag.tag_name}' 태그 연결은 해제됐습니다. 영향 SKU 계산 확인 필요: ${calculationError}`:`'${tag.tag_name}' 태그와 모든 연결을 해제하고 영향 SKU ${n(skus.length)}개를 다시 계산했습니다.`,calculationError?'error':'success');
   global.dispatchEvent(new CustomEvent('hub-tags-changed',{detail:{tagId:tag.tag_id,deleted:true,skus}}));
  }catch(error){setStatus(`${retired?'태그 연결은 해제됐지만 후속 새로고침/계산 실패':'태그 삭제 실패'}: ${error?.message||error}`,'error');renderSelected();}
  finally{renderSelected();}
 }

 async function removeSelected(){
  const tag=currentTag(),skus=state.rows.filter(row=>row.__tagApplied&&state.selected.has(row.sellpia_sku_code)).map(row=>row.sellpia_sku_code);if(!tag||!skus.length)return;
  if(!global.confirm(`${tag.tag_name} 태그를 선택한 ${n(skus.length)}개 SKU에서 해제할까요? 태그와 수식 자체는 삭제하지 않습니다.`))return;
  setStatus('선택 SKU에서 태그를 해제하는 중…');
  try{const result=await D().removeTagMembers({tagId:tag.tag_id,skus}),calculation=await recalc(skus,'tag-manager-remove');await loadCatalog();setStatus(calculation.error?`태그 해제 ${n(result.removed_count)}개 완료 · 수식 계산 확인 필요: ${calculation.error}`:`${n(result.removed_count)}개 SKU에서 태그 적용을 해제하고 수식을 다시 계산했습니다.`,calculation.error?'error':'success');global.dispatchEvent(new CustomEvent('hub-tags-changed',{detail:{tagId:tag.tag_id,skus}}));}
  catch(error){setStatus(`태그 해제 실패: ${error?.message||error}`,'error');}
 }

 async function clearAll(){
  const tag=currentTag();if(!tag)return;
  const preview=await D().syncTagAssignments({tagId:tag.tag_id,skus:[],preview:true});
  const count=Number(preview.remove_count||0);
  if(!count){setStatus('현재 해제할 SKU가 없습니다.');return;}
  if(!global.confirm(`${tag.tag_name} 태그의 현재 적용 ${n(count)}개를 전부 해제할까요?\n태그 자체와 연결 수식은 삭제하지 않습니다.`))return;
  setStatus(`${n(count)}개 전체 해제 중…`);
  try{
   const members=await allMembers();
   const result=await D().syncTagAssignments({tagId:tag.tag_id,skus:[],preview:false});
   const calculation=await recalc(members.map(row=>row.sellpia_sku_code),'tag-manager-clear-all');
   global.dispatchEvent(new CustomEvent('hub-tags-changed',{detail:{tagId:tag.tag_id,clearAll:true}}));await loadCatalog({keepSelection:true});
   setStatus(calculation.error?`전체 태그 해제 ${n(result.remove_count)}개 완료 · 수식 계산 확인 필요: ${calculation.error}`:`${n(result.remove_count)}개 SKU에서 태그 적용을 전부 해제하고 수식을 다시 계산했습니다.`,calculation.error?'error':'success');
  }catch(error){setStatus(`전체 해제 실패: ${error?.message||error}`,'error');}
 }

 function bind(){
  const h=host();
  h.querySelectorAll('[data-tag-view]').forEach(btn=>btn.onclick=()=>setMode(btn.dataset.tagView));
  document.getElementById('tag-catalog-search').onsubmit=e=>{e.preventDefault();state.catalogSearch=document.getElementById('tag-catalog-query').value.trim();void loadCatalog({keepSelection:false});};
  document.querySelectorAll('[data-tag-kind]').forEach(btn=>btn.onclick=()=>{state.kind=btn.dataset.tagKind;document.querySelectorAll('[data-tag-kind]').forEach(item=>item.setAttribute('aria-selected',String(item===btn)));renderCatalog();});
  document.getElementById('tag-new-open').onclick=()=>toggleNewTag(true);
  document.getElementById('tag-new-cancel').onclick=()=>toggleNewTag(false);
  document.getElementById('tag-new-form').onsubmit=createTag;
  document.getElementById('tag-member-search').onsubmit=e=>{e.preventDefault();state.memberSearch=document.getElementById('tag-member-query').value.trim();state.page=1;void loadMembers();};
  document.getElementById('tag-member-search-clear').onclick=()=>{state.memberSearch='';state.page=1;document.getElementById('tag-member-query').value='';void loadMembers();};
  document.getElementById('tag-member-refresh').onclick=()=>void loadCatalog();
  document.getElementById('tag-member-prev').onclick=()=>{if(state.page>1){state.page--;void loadMembers();}};
  document.getElementById('tag-member-next').onclick=()=>{if(state.page<pageCount()){state.page++;void loadMembers();}};
  document.getElementById('tag-member-select-page').onchange=e=>{state.rows.forEach(row=>e.target.checked?state.selected.add(row.sellpia_sku_code):state.selected.delete(row.sellpia_sku_code));renderMembers();renderSelected();};
  document.getElementById('tag-download-current').onclick=()=>void downloadCurrent();
  document.getElementById('tag-download-blank').onclick=downloadBlank;
  document.getElementById('tag-upload-sync').onclick=openUpload;
  document.getElementById('tag-apply-selected').onclick=()=>void applySelected();
  document.getElementById('tag-recalculate-selected').onclick=()=>void recalculateSelected();
  document.getElementById('tag-rename').onclick=()=>void renameTag();
  document.getElementById('tag-edit-rule').onclick=()=>void editRule();
  document.getElementById('tag-remove-selected').onclick=()=>void removeSelected();
  document.getElementById('tag-clear-all').onclick=()=>void clearAll();
   document.getElementById('tag-delete-unused').onclick=()=>void deleteUnusedTag();
   document.getElementById('tag-ably-policy-save').onclick=()=>void saveCarrierPolicy();
  }

 async function openTag(tagId){
  setMode('tag');
  if(!state.catalog.length)await loadCatalog();
  if(state.catalog.some(tag=>String(tag.tag_id)===String(tagId)))await selectTag(tagId);
 }

 function tick(){ensureShell();}
 const observer=new MutationObserver(()=>queueMicrotask(tick));
 observer.observe(document.documentElement,{childList:true,subtree:true});
 global.addEventListener('hub-rules-changed',()=>{if(state.mode==='tag')void loadCatalog({keepSelection:true});});
 global.SystemV3TagManager=Object.freeze({openTag,refresh:()=>loadCatalog({keepSelection:true})});
 global.addEventListener('load',tick);tick();
})(window);
