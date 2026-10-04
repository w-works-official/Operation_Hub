(function initSystemV3UiCleanup(global){
  'use strict';
  const byId=id=>document.getElementById(id);
  const navButton=page=>document.querySelector(`.nav-item[data-page="${page}"]`);
  const clickPage=page=>navButton(page)?.click();

  function cleanSidebar(){
    const nav=document.querySelector('.nav-list');
    if(!nav||nav.dataset.cleaned==='1')return;
    nav.dataset.cleaned='1';
    nav.querySelectorAll('.nav-section-label').forEach(node=>node.remove());
    const sections=[
      ['dashboard','운영'],
      ['upload','데이터'],
      ['multi-links','상품'],
      ['price-rules','가격'],
      ['jobs','내보내기']
    ];
    for(const [page,label] of sections){
      const button=nav.querySelector(`.nav-item[data-page="${page}"]`);
      if(!button)continue;
      const title=document.createElement('p');
      title.className='nav-section-label';
      title.textContent=label;
      nav.insertBefore(title,button);
    }
    const names={
      dashboard:'운영 현황',
      upload:'원본 업로드',
      matching:'통합 매트릭스',
      'multi-links':'상품 관계·조합',
      'ably-combinations':'에이블리 조합',
      attributes:'상품 태그',
      'price-rules':'가격 수식',
      jobs:'판매처 내보내기'
    };
    for(const [page,label] of Object.entries(names)){
      const span=nav.querySelector(`.nav-item[data-page="${page}"] span`);
      if(span)span.textContent=label;
    }
  }

  function downloadBlankTagTemplate(){
    if(!global.XLSX){alert('XLSX 모듈을 불러오지 못했습니다.');return;}
    const rows=[
      ['셀피아 SKU','상품명(메모)','옵션명(메모)','메모'],
      ['','','','']
    ];
    const book=global.XLSX.utils.book_new();
    const sheet=global.XLSX.utils.aoa_to_sheet(rows);
    global.XLSX.utils.book_append_sheet(book,sheet,'태그일괄적용');
    global.XLSX.writeFile(book,'태그명_일괄적용.xlsx');
  }

  function openBulkTagImport(){
    if(global.HubPriceWorkspace?.openTagImport){
      global.HubPriceWorkspace.openTagImport();
      return;
    }
    clickPage('price-rules');
    setTimeout(()=>document.querySelector('#price-rules .rw-tabs button[data-tab="bulk"]')?.click(),50);
  }

  function ensureAttributeActions(){
    const host=byId('attributes');
    const toolbar=host?.querySelector('.attributes-toolbar');
    if(!toolbar||host.querySelector('.attributes-quick-actions'))return;
    const section=document.createElement('section');
    section.className='attributes-quick-actions';
    section.setAttribute('aria-label','상품 태그 빠른 작업');
    section.innerHTML=`
      <article class="attributes-quick-card">
        <span>↥</span><div><b>태그 일괄 적용</b><small>&lt;태그명&gt;_일괄적용.xlsx · A열만 SKU로 읽고 나머지는 메모로 유지</small></div>
        <button class="btn primary" id="ui-open-tag-bulk" type="button">엑셀 업로드</button>
      </article>
      <article class="attributes-quick-card">
        <span>ƒ</span><div><b>가격 수식 관리</b><small>태그에 연결된 Rule과 계산 순서·적용 위치를 확인합니다.</small></div>
        <button class="btn" id="ui-open-price-rules" type="button">수식 관리</button>
      </article>
      <article class="attributes-quick-card">
        <span>▦</span><div><b>빈 일괄적용 템플릿</b><small>파일명을 실제 태그명으로 바꿔 사용합니다. B열 이후는 자유 메모입니다.</small></div>
        <button class="btn" id="ui-download-tag-template" type="button">템플릿</button>
      </article>`;
    toolbar.insertAdjacentElement('afterend',section);
    byId('ui-open-tag-bulk').onclick=openBulkTagImport;
    byId('ui-open-price-rules').onclick=()=>clickPage('price-rules');
    byId('ui-download-tag-template').onclick=downloadBlankTagTemplate;
  }

  function ensureExportHub(){
    const page=byId('jobs');
    if(!page||page.querySelector('.export-hub')||page.querySelector('#export-workflow-v2'))return;
    const anchor=page.querySelector('.queue-batch-workspace,.queue-summary');
    if(!anchor)return;
    const pageTitle=page.querySelector('.page-head h2');
    const pageCopy=page.querySelector('.page-head p');
    if(pageTitle)pageTitle.textContent='판매처 내보내기·작업이력';
    if(pageCopy)pageCopy.textContent='검증된 가격·재고를 판매처 양식으로 내보내고, 생성·검증·완료 이력을 확인합니다.';
    const section=document.createElement('section');
    section.className='export-hub';
    section.innerHTML=`
      <div class="export-hub-head"><div><h3>판매처 파일 내보내기</h3><p>가격·재고 계산과 파일 생성은 분리합니다. 검증된 저장값만 내보냅니다.</p></div></div>
      <div class="export-hub-grid">
        <article class="export-hub-card">
          <header><h4>스마트스토어 · 메이크샵</h4><span class="export-hub-badge ready">사용 가능</span></header>
          <p>보관된 판매처 원본을 기준으로 저장된 가격/재고를 반영해 수정본을 생성합니다.</p>
          <button class="btn primary" id="ui-export-standard" type="button">원본 양식 내보내기</button>
        </article>
        <article class="export-hub-card">
          <header><h4>에이블리 · 판매가 + 옵션가</h4><span class="export-hub-badge prep">PlayAuto 준비</span></header>
          <p>‘쇼핑몰상품’ 양식. 판매자관리코드 sellpia_상품코드 + 옵션명으로 SKU를 확인합니다.</p>
          <button class="btn" type="button" disabled>연결 준비됨</button>
        </article>
        <article class="export-hub-card">
          <header><h4>에이블리 · 옵션가 + 실제재고</h4><span class="export-hub-badge prep">PlayAuto 준비</span></header>
          <p>‘옵션기본’ 양식. V=옵션가, X=실제 판매수량. W 판매가능재고는 메모값으로 보존합니다.</p>
          <button class="btn" type="button" disabled>연결 준비됨</button>
        </article>
      </div>`;
    page.insertBefore(section,anchor);
    byId('ui-export-standard').onclick=()=>byId('queue-export')?.click();
  }

  function sourceScopesForRules(rules){
    const M=global.HubRuleRegistry;
    if(!rules.length)return [];
    if(rules.some(rule=>!M?.isPlatform?.(rule.target_field)))return ['smartstore','makeshop','ably'];
    return [...new Set(rules.map(rule=>rule.scope).filter(Boolean))];
  }

  function tagSyncContext(data){
    if(!data)return null;
    if(data.mode==='filename_tag'&&data.resolvedTagId){
      return {tagId:data.resolvedTagId,rows:data.rows||[]};
    }
    const files=data.files||[];
    if(files.length!==1)return null;
    const file=files[0],tagId=file.resolution?.tag?.tag_id;
    if(!tagId||!['metadata_tag','filename_tag'].includes(file.parsed?.mode))return null;
    return {tagId,rows:file.rows||[]};
  }

  async function refreshSyncPreview(panel){
    const workspace=global.HubPriceWorkspace,D=global.SystemV3Data,data=workspace?.state?.tagImport;
    const context=tagSyncContext(data);
    if(!context||typeof D?.syncTagAssignments!=='function'){
      if(!panel.hidden)panel.hidden=true;
      return;
    }
    if(panel.hidden)panel.hidden=false;
    if(data._syncPreviewLoading)return;
    if(!data.syncPreview){
      data._syncPreviewLoading=true;
      panel.querySelector('[data-sync-copy]').textContent='현재 적용대상을 비교하는 중…';
      try{
        data.syncPreview=await D.syncTagAssignments({
          tagId:context.tagId,
          skus:context.rows.map(row=>row.sku).filter(Boolean),
          preview:true
        });
      }catch(error){
        data.syncPreviewError=error?.message||String(error);
      }finally{
        data._syncPreviewLoading=false;
      }
    }
    const preview=data.syncPreview;
    const copy=panel.querySelector('[data-sync-copy]');
    const counts=panel.querySelector('.ui-tag-sync-counts');
    const button=panel.querySelector('[data-sync-apply]');
    if(data.syncPreviewError){
      copy.textContent=`동기화 미리보기 사용 불가: ${data.syncPreviewError}`;
      counts.innerHTML='';
      button.disabled=true;
      return;
    }
    if(!preview){button.disabled=true;return;}
    copy.textContent='추가 적용과 달리, 이 파일을 해당 태그의 최종 SKU 목록으로 사용합니다.';
    counts.innerHTML=`
      <span>현재 ${Number(preview.current_count||0).toLocaleString('ko-KR')}</span>
      <span>파일 ${Number(preview.target_count||0).toLocaleString('ko-KR')}</span>
      <span>추가 ${Number(preview.add_count||0).toLocaleString('ko-KR')}</span>
      <span>해제 ${Number(preview.remove_count||0).toLocaleString('ko-KR')}</span>`;
    button.disabled=false;
    button.textContent=Number(preview.target_count||0)===0?'이 태그 전체 해제':'파일 기준 동기화';
  }

  async function applyTagSync(panel){
    const workspace=global.HubPriceWorkspace,D=global.SystemV3Data,M=global.HubRuleRegistry,data=workspace?.state?.tagImport;
    const context=tagSyncContext(data);
    if(!context||!data.syncPreview)return;
    const removeCount=Number(data.syncPreview.remove_count||0),targetCount=Number(data.syncPreview.target_count||0);
    const prompt=targetCount===0
      ? `파일의 A열 SKU가 비어 있습니다. 현재 이 태그에 연결된 ${removeCount.toLocaleString('ko-KR')}개 SKU를 전부 해제합니다. 계속할까요?`
      : `파일을 최종 목록으로 사용합니다. 목록에 없는 ${removeCount.toLocaleString('ko-KR')}개 SKU에서는 태그를 해제합니다. 계속할까요?`;
    if(removeCount>0&&!global.confirm(prompt))return;

    const tagId=context.tagId;
    const rules=workspace.state.registry.rules.filter(rule=>String(rule.tag_id)===String(tagId));
    const ruleIds=new Set(rules.map(rule=>rule.id));
    const previousSkus=workspace.state.registry.assignments.filter(a=>ruleIds.has(a.rule_id)).map(a=>a.sku);
    const fileSkus=context.rows.map(row=>row.sku).filter(Boolean);
    const affected=[...new Set([...previousSkus,...fileSkus])];

    const button=panel.querySelector('[data-sync-apply]');
    button.disabled=true;button.textContent='동기화 중…';
    const status=byId('rw-drawer-status');
    try{
      const result=await D.syncTagAssignments({tagId,skus:fileSkus,preview:false});
      await workspace.refresh();
      if(rules.length&&affected.length&&global.HubPriceMaterializer?.materialize){
        await global.HubPriceMaterializer.materialize({
          skus:affected,
          sources:sourceScopesForRules(rules),
          reason:'tag-file-sync'
        });
      }
      data.syncPreview=null;
      if(status)status.textContent=`태그 적용대상 동기화 완료 · 추가 ${Number(result.add_count||0).toLocaleString('ko-KR')} · 해제 ${Number(result.remove_count||0).toLocaleString('ko-KR')}`;
      global.dispatchEvent(new CustomEvent('hub-rules-changed',{detail:{persisted:true}}));
      await refreshSyncPreview(panel);
    }catch(error){
      if(status)status.textContent=`동기화 실패: ${error?.message||error}`;
      button.disabled=false;
    }
  }

  function ensureTagSyncPanel(){
    const backdrop=byId('rw-backdrop');
    if(!backdrop||backdrop.hidden)return;
    const title=byId('rw-drawer-title');
    if(!title||!title.textContent.includes('태그 일괄등록'))return;
    let panel=backdrop.querySelector('.ui-tag-sync-panel');
    if(!panel){
      panel=document.createElement('section');
      panel.className='ui-tag-sync-panel';
      panel.hidden=true;
      panel.innerHTML=`
        <div><div><b>파일 기준 동기화</b><p data-sync-copy>현재 적용대상을 비교합니다.</p></div></div>
        <div class="ui-tag-sync-counts"></div>
        <div class="ui-tag-sync-actions"><button class="btn danger-soft" type="button" data-sync-apply disabled>파일 기준 동기화</button></div>`;
      const body=byId('rw-drawer-body');
      body?.appendChild(panel);
      panel.querySelector('[data-sync-apply]').onclick=()=>applyTagSync(panel);
    }
    const importState=global.HubPriceWorkspace?.state?.tagImport||null;
    if(panel._systemV3TagImportState===importState)return;
    panel._systemV3TagImportState=importState;
    void refreshSyncPreview(panel);
  }

  function tick(){
    cleanSidebar();
    ensureAttributeActions();
    ensureExportHub();
    ensureTagSyncPanel();
  }

  const observer=new MutationObserver(()=>queueMicrotask(tick));
  observer.observe(document.documentElement,{childList:true,subtree:true,attributes:true,attributeFilter:['hidden','class']});
  global.addEventListener('load',tick);
  tick();
})(window);
