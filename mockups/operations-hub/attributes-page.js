(function initAttributesPage(global) {
  'use strict';

  const PAGE_SIZE = 50;
  const MAX_SELECTED = 50;
  const ATTRIBUTE_OPTIONS = Object.freeze({
    material:['14K','925 실버','써지컬','티타늄','아크릴/투명','실버','기타'],
    productGroup:['부품/소모품','피어싱','귀걸이','목걸이','반지','팔찌/발찌','헤어/잡화','기타'],
    shape:['세트','링','바벨/바','볼','진주','큐빅/스톤','투명/리테이너','체인','모티브','기타']
  });

  const state = {
    initialized:false,
    loading:false,
    saving:false,
    page:1,
    count:0,
    rows:[],
    tags:[],
    selected:new Set(),
    search:'',
    requestId:0,
    lastLoadedAt:0
  };

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function cleanError(error) {
    const message = String(error?.message || error || '알 수 없는 오류');
    return message
      .replace(/https?:\/\/[^\s]+/gi, '[URL 숨김]')
      .replace(/(?:eyJ|sb_)[A-Za-z0-9._-]{12,}/g, '[인증정보 숨김]')
      .slice(0, 360);
  }

  function profileOf(row) {
    return row?.__profile || {};
  }

  function tagIds(profile, field) {
    return (Array.isArray(profile?.[field]) ? profile[field] : [])
      .map(tag => String(tag?.tag_id ?? tag))
      .filter(Boolean);
  }

  function pageCount() {
    return Math.max(1, Math.ceil(state.count / PAGE_SIZE));
  }

  function status(message, kind = 'info') {
    const node = document.getElementById('attributes-status');
    if (!node) return;
    node.className = `attributes-status ${kind}`;
    node.textContent = message;
  }

  function setProgress(current, total, detail) {
    const region = document.getElementById('attributes-save-progress');
    if (!region) return;
    const percent = total ? Math.round((current / total) * 100) : 0;
    region.hidden = false;
    region.querySelector('b').textContent = detail;
    region.querySelector('span').textContent = `${current}/${total}`;
    region.querySelector('i > em').style.width = `${percent}%`;
  }

  function renderTagChoices(scope) {
    if (!state.tags.length) return '<p class="attributes-tags-empty">등록된 태그가 없습니다.</p>';
    return state.tags.map(tag => `<label class="attributes-tag" style="--tag-color:${escapeHtml(tag.tag_color || '#dbeafe')}">
      <input type="checkbox" data-attributes-tag="${scope}" value="${escapeHtml(tag.tag_id)}">
      <span>${escapeHtml(tag.tag_name)}</span><em>${escapeHtml(tag.tag_group || '운영')}</em>
    </label>`).join('');
  }

  function selectOptions(values) {
    return values.map(value => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join('');
  }

  function renderShell(host) {
    host.classList.remove('table-page');
    host.classList.add('attributes-live-page');
    host.innerHTML = `<div class="page-title attributes-title">
      <div><h2>상품 태그</h2><p>태그를 만들고 선택한 SKU에 직접 붙입니다. 가격 계산은 태그 설정에서 선택할 수 있습니다.</p></div>
      <span class="attributes-live-badge"><i></i>실제 DB 연결</span>
    </div>
    <section class="attributes-toolbar" aria-label="상품 속성 검색">
      <form id="attributes-search-form"><input id="attributes-search" type="search" maxlength="80" placeholder="셀피아 SKU / 자사코드 / 상품명 / 옵션명 검색"><button class="btn primary" type="submit">검색</button></form>
      <button class="btn" id="attributes-refresh" type="button">새로고침</button>
      <span id="attributes-count">0개 SKU</span>
    </section>
    <div id="attributes-status" class="attributes-status info" role="status">상품 속성을 불러올 준비가 되었습니다.</div>
    <div class="attributes-layout">
      <section class="attributes-list-panel">
        <div class="attributes-selection-head"><label><input id="attributes-select-page" type="checkbox">현재 페이지 전체 선택</label><b id="attributes-selected-count">0개 선택</b><button class="btn" id="attributes-clear-selection" type="button">선택 해제</button></div>
        <div class="attributes-table-wrap"><table class="attributes-table"><thead><tr><th class="check">선택</th><th>SKU / 자사코드</th><th>상품명 / 옵션명</th><th>태그</th></tr></thead><tbody id="attributes-rows"></tbody></table></div>
        <nav class="attributes-pagination" aria-label="속성 목록 페이지"><button class="btn" id="attributes-prev" type="button">이전</button><span id="attributes-page-label">1 / 1</span><button class="btn" id="attributes-next" type="button">다음</button></nav>
      </section>
      <aside class="attributes-editor" aria-label="선택 SKU 속성 편집">
        <div class="attributes-editor-head"><div><span>선택 SKU 일괄 편집</span><h3 id="attributes-editor-count">0개 SKU</h3></div><small>최대 ${MAX_SELECTED}개</small></div>
        <p class="attributes-editor-guide">체크한 항목만 기존 값에서 교체됩니다. 저장 전에는 DB를 변경하지 않습니다.</p>
        <fieldset class="attributes-fieldset" hidden><legend>분류 속성</legend>
          <label class="attributes-apply"><input type="checkbox" data-attributes-apply="material"><span>소재 적용</span><select id="attributes-material" disabled>${selectOptions(ATTRIBUTE_OPTIONS.material)}</select></label>
          <label class="attributes-apply"><input type="checkbox" data-attributes-apply="productGroup"><span>상품군 적용</span><select id="attributes-product-group" disabled>${selectOptions(ATTRIBUTE_OPTIONS.productGroup)}</select></label>
          <label class="attributes-apply"><input type="checkbox" data-attributes-apply="shape"><span>형태 적용</span><select id="attributes-shape" disabled>${selectOptions(ATTRIBUTE_OPTIONS.shape)}</select></label>
        </fieldset>
        <fieldset class="attributes-fieldset" hidden><legend><label><input type="checkbox" data-attributes-apply="productTags">상품 공통 태그 교체</label></legend><div class="attributes-tag-grid" data-attributes-tags="product" aria-disabled="true">${renderTagChoices('product')}</div></fieldset>
        <fieldset class="attributes-fieldset"><legend><label><input type="checkbox" data-attributes-apply="skuTags">선택 SKU 태그 교체</label></legend><div class="attributes-tag-grid" data-attributes-tags="sku" aria-disabled="true">${renderTagChoices('sku')}</div></fieldset>
        <div class="attributes-tag-formula"><label>상품 태그의 수식 확인<select id="attributes-formula-tag" aria-label="수식을 확인하거나 편집할 상품 태그"></select></label><button class="btn" id="attributes-edit-tag-formula" type="button">연결 수식 확인·편집</button><small>수식 태그를 선택하면 입력값, 계산 순서와 적용 SKU 수를 확인합니다. 일반 태그도 필요할 때 수식을 연결할 수 있습니다.</small></div><details class="attributes-new-tag"><summary>새 태그</summary><div><input id="attributes-new-tag-name" maxlength="32" placeholder="태그 이름"><input id="attributes-new-tag-color" type="color" value="#dbeafe"><label><input id="attributes-new-tag-formula" type="checkbox"> 가격 수식 사용</label><button class="btn" id="attributes-create-tag" type="button">태그 생성(DB 저장)</button></div></details>
        <div id="attributes-save-progress" class="attributes-save-progress" hidden><div><b>저장 준비</b><span>0/0</span></div><i><em></em></i></div>
        <button class="btn primary attributes-save" id="attributes-save" type="button" disabled>선택 SKU에 저장</button>
      </aside>
    </div>`;
  }

  function renderRows() {
    const body = document.getElementById('attributes-rows');
    if (!body) return;
    if (!state.rows.length) {
      body.innerHTML = '<tr><td colspan="4" class="attributes-empty">조건에 맞는 SKU가 없습니다.</td></tr>';
    } else {
      body.innerHTML = state.rows.map(row => {
        const sku = String(row.sellpia_sku_code || '');
        const profile = profileOf(row);
        const tags = [...(profile.product_tags || []), ...(profile.sku_tags || [])];
        const tagNames = [...new Set(tags.map(tag => tag?.tag_name).filter(Boolean))];
        return `<tr data-attributes-sku="${escapeHtml(sku)}" class="${state.selected.has(sku) ? 'selected' : ''}">
          <td class="check"><input type="checkbox" data-attributes-select="${escapeHtml(sku)}" ${state.selected.has(sku) ? 'checked' : ''} aria-label="${escapeHtml(sku)} 선택"></td>
          <td><b>${escapeHtml(sku || '-')}</b><span>${escapeHtml(row.sellpia_own_code || row.own_code || '-')}</span></td>
          <td class="product"><b>${escapeHtml(row.sellpia_product_name || row.display_name || '상품명 없음')}</b><span>${escapeHtml(row.sellpia_option_name || '옵션명 없음')}</span></td>
          <td class="tags">${tagNames.length ? tagNames.slice(0, 3).map(name => `<i>${escapeHtml(name)}</i>`).join('') + (tagNames.length > 3 ? `<em>+${tagNames.length - 3}</em>` : '') : '<span>태그 없음</span>'}</td>
        </tr>`;
      }).join('');
    }
    const totalPages = pageCount();
    document.getElementById('attributes-count').textContent = `${state.count.toLocaleString('ko-KR')}개 SKU`;
    document.getElementById('attributes-page-label').textContent = `${state.page.toLocaleString('ko-KR')} / ${totalPages.toLocaleString('ko-KR')}`;
    document.getElementById('attributes-prev').disabled = state.loading || state.page <= 1;
    document.getElementById('attributes-next').disabled = state.loading || state.page >= totalPages;
    updateSelectionUi();
  }

  function selectedRows() {
    return state.rows.filter(row => state.selected.has(String(row.sellpia_sku_code || '')));
  }

  function updateSelectionUi() {
    const count = state.selected.size;
    const pageSkus = state.rows.map(row => String(row.sellpia_sku_code || '')).filter(Boolean);
    const selectPage = document.getElementById('attributes-select-page');
    if (selectPage) {
      selectPage.checked = Boolean(pageSkus.length) && pageSkus.every(sku => state.selected.has(sku));
      selectPage.indeterminate = pageSkus.some(sku => state.selected.has(sku)) && !selectPage.checked;
      selectPage.disabled = state.saving || !pageSkus.length;
    }
    document.getElementById('attributes-selected-count').textContent = `${count}개 선택`;
    document.getElementById('attributes-editor-count').textContent = `${count}개 SKU`;
    document.getElementById('attributes-save').disabled = state.saving || count === 0;
    document.querySelectorAll('[data-attributes-sku]').forEach(row => row.classList.toggle('selected', state.selected.has(row.dataset.attributesSku)));
  }

  function applyFirstSelectedToEditor() {
    const first = selectedRows()[0];
    if (!first) return;
    const profile = profileOf(first);
    document.getElementById('attributes-material').value = profile.material || '기타';
    document.getElementById('attributes-product-group').value = profile.product_group || '기타';
    document.getElementById('attributes-shape').value = profile.shape || '기타';
    const productTags = new Set(tagIds(profile, 'product_tags'));
    const skuTags = new Set(tagIds(profile, 'sku_tags'));
    document.querySelectorAll('[data-attributes-tag="product"]').forEach(input => { input.checked = productTags.has(input.value); });
    document.querySelectorAll('[data-attributes-tag="sku"]').forEach(input => { input.checked = skuTags.has(input.value); });
  }

  async function loadPage({resetSelection = true} = {}) {
    if (state.loading || state.saving) return;
    const requestId = ++state.requestId;
    state.loading = true;
    if (resetSelection) state.selected.clear();
    status('저장된 상품 프로필과 태그를 조회하는 중입니다.', 'loading');
    renderRows();
    try {
      const [result, tags] = await Promise.all([
        global.SystemV3Data.loadProducts({page:state.page, pageSize:PAGE_SIZE, search:state.search, searchSources:['sellpia'], status:'all', sort:'sku_asc'}),
        global.SystemV3Data.loadTags()
      ]);
      if (requestId !== state.requestId) return;
      state.rows = result.rows || [];
      state.count = Number(result.count || 0);
      state.tags = tags || [];
      renderFormulaTags();
      state.lastLoadedAt = Date.now();
      const tagHosts = document.querySelectorAll('[data-attributes-tags]');
      tagHosts.forEach(host => { host.innerHTML = renderTagChoices(host.dataset.attributesTags); });
      if (state.page > pageCount()) state.page = pageCount();
      renderRows();
      status(`${state.rows.length}개 SKU를 확인했습니다. 편집할 행을 선택해주세요.`, 'success');
    } catch (error) {
      if (requestId !== state.requestId) return;
      state.rows = [];
      state.count = 0;
      renderRows();
      status(`상품 속성 조회 실패: ${cleanError(error)}`, 'error');
    } finally {
      if (requestId === state.requestId) state.loading = false;
      renderRows();
    }
  }

  function readEditor() {
    const applies = new Set([...document.querySelectorAll('[data-attributes-apply]:checked')].map(input => input.dataset.attributesApply));
    return {
      applies,
      material:document.getElementById('attributes-material').value,
      productGroup:document.getElementById('attributes-product-group').value,
      shape:document.getElementById('attributes-shape').value,
      productTagIds:[...document.querySelectorAll('[data-attributes-tag="product"]:checked')].map(input => input.value),
      skuTagIds:[...document.querySelectorAll('[data-attributes-tag="sku"]:checked')].map(input => input.value)
    };
  }

  async function saveSelected() {
    if (state.saving || !state.selected.size) return;
    const rows = selectedRows();
    const draft = readEditor();
    if (!draft.applies.size) {
      status('적용할 속성 또는 태그 교체 항목을 하나 이상 체크해주세요.', 'error');
      return;
    }
    state.saving = true;
    updateSelectionUi();
    const errors = [];
    let saved = 0;
    const savedSkus = [];
    setProgress(0, rows.length, 'DB 저장 시작');
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const profile = profileOf(row);
      const sku = String(row.sellpia_sku_code || '');
      setProgress(index, rows.length, `${sku} 저장 중`);
      try {
        const result = await global.SystemV3Data.saveProductProfile({
          sku,
          material:draft.applies.has('material') ? draft.material : (profile.material || ''),
          productGroup:draft.applies.has('productGroup') ? draft.productGroup : (profile.product_group || ''),
          shape:draft.applies.has('shape') ? draft.shape : (profile.shape || ''),
          productTagIds:draft.applies.has('productTags') ? draft.productTagIds : tagIds(profile, 'product_tags'),
          skuTagIds:draft.applies.has('skuTags') ? draft.skuTagIds : tagIds(profile, 'sku_tags')
        });
        row.__profile = result || profile;
        saved += 1;
        savedSkus.push(sku);
      } catch (error) {
        errors.push(`${sku}: ${cleanError(error)}`);
      }
      setProgress(index + 1, rows.length, errors.length ? `${saved}건 저장 · ${errors.length}건 실패` : `${saved}건 저장 완료`);
    }
    state.saving = false;
    updateSelectionUi();
    let calculationError = '';
    if (savedSkus.length && (draft.applies.has('productTags') || draft.applies.has('skuTags')) && global.HubPriceMaterializer?.materialize) {
      setProgress(savedSkus.length, savedSkus.length, '태그 수식 계산 중');
      try {
        await global.HubPriceMaterializer.materialize({skus:[...new Set(savedSkus)], sources:['smartstore','makeshop','ably'], reason:'attributes-tag-save'});
      } catch (error) {
        calculationError = cleanError(error);
      }
    }
    if (errors.length) {
      status(`속성 저장 ${saved}건 완료 · ${errors.length}건 실패 — ${errors.slice(0, 2).join(' / ')}`, 'error');
    } else if (calculationError) {
      status(`태그 DB 저장 ${saved}건 완료 · 수식 계산 확인 필요 — ${calculationError}`, 'error');
    } else {
      status(`선택한 ${saved}개 SKU의 속성·태그 저장과 수식 계산을 완료했습니다.`, 'success');
    }
    if (savedSkus.length) global.dispatchEvent(new CustomEvent('hub-tags-changed', {detail:{skus:savedSkus}}));
    await loadPage({resetSelection:false});
  }

  async function createTag() {
    if (state.saving) return;
    const input = document.getElementById('attributes-new-tag-name');
    const color = document.getElementById('attributes-new-tag-color').value;
    const name = input.value.trim();
    if (!name) {
      status('새 태그 이름을 입력해주세요.', 'error');
      input.focus();
      return;
    }
    if(document.getElementById('attributes-new-tag-formula').checked){
      await openTagFormula({name,color,group:'가격 수식'});
      return;
    }
    const button = document.getElementById('attributes-create-tag');
    const checkedProductTags = new Set([...document.querySelectorAll('[data-attributes-tag="product"]:checked')].map(item => item.value));
    const checkedSkuTags = new Set([...document.querySelectorAll('[data-attributes-tag="sku"]:checked')].map(item => item.value));
    button.disabled = true;
    try {
      const created = await global.SystemV3Data.createProductTag({name, color, group:'운영'});
      state.tags = await global.SystemV3Data.loadTags();
      renderFormulaTags();
      void global.TagPriceWorkspace?.refresh();
      document.querySelectorAll('[data-attributes-tags]').forEach(host => { host.innerHTML = renderTagChoices(host.dataset.attributesTags); });
      document.querySelectorAll('[data-attributes-tag="product"]').forEach(item => { item.checked = checkedProductTags.has(item.value); });
      document.querySelectorAll('[data-attributes-tag="sku"]').forEach(item => { item.checked = checkedSkuTags.has(item.value); });
      input.value = '';
      status(`${created.tag_name} 태그를 생성했습니다. 상품 적용은 교체 항목 체크 후 저장해주세요.`, 'success');
    } catch (error) {
      status(`태그 생성 실패: ${cleanError(error)}`, 'error');
    } finally {
      button.disabled = false;
    }
  }

  function renderFormulaTags() {
    const select=document.getElementById('attributes-formula-tag');if(!select)return;
    const previous=select.value;select.innerHTML='<option value="">태그 선택</option>'+state.tags.map(tag=>`<option value="${escapeHtml(tag.tag_id)}">${escapeHtml(tag.tag_name)}</option>`).join('');
    if(state.tags.some(tag=>String(tag.tag_id)===previous))select.value=previous;
  }
  async function openTagFormula(tag) {
    if(!tag?.name?.trim()){status('수식을 설정할 태그 이름을 입력하거나 기존 태그를 선택하세요.','error');return;}
    if(!global.HubPriceWorkspace?.openForTag){status('공통 수식 편집기를 불러오지 못했습니다. 새로고침 후 다시 시도하세요.','error');return;}
    try{await global.HubPriceWorkspace.openForTag(tag);}catch(error){status(cleanError(error),'error');}
  }

  function bindEvents(host) {
    host.querySelector('#attributes-search-form').addEventListener('submit', event => {
      event.preventDefault();
      state.search = document.getElementById('attributes-search').value.trim();
      state.page = 1;
      void loadPage();
    });
    host.querySelector('#attributes-refresh').addEventListener('click', () => { state.tags = []; void loadPage(); });
    host.querySelector('#attributes-prev').addEventListener('click', () => { if (state.page > 1) { state.page -= 1; void loadPage(); } });
    host.querySelector('#attributes-next').addEventListener('click', () => { if (state.page < pageCount()) { state.page += 1; void loadPage(); } });
    host.querySelector('#attributes-clear-selection').addEventListener('click', () => { state.selected.clear(); renderRows(); });
    host.querySelector('#attributes-select-page').addEventListener('change', event => {
      const skus = state.rows.map(row => String(row.sellpia_sku_code || '')).filter(Boolean);
      skus.forEach(sku => event.target.checked ? state.selected.add(sku) : state.selected.delete(sku));
      if (state.selected.size > MAX_SELECTED) {
        state.selected = new Set([...state.selected].slice(0, MAX_SELECTED));
        status(`한 번에 최대 ${MAX_SELECTED}개 SKU만 선택할 수 있습니다.`, 'error');
      }
      renderRows();
      applyFirstSelectedToEditor();
    });
    host.querySelector('#attributes-rows').addEventListener('change', event => {
      const input = event.target.closest('[data-attributes-select]');
      if (!input) return;
      const sku = input.dataset.attributesSelect;
      if (input.checked && state.selected.size >= MAX_SELECTED) {
        input.checked = false;
        status(`한 번에 최대 ${MAX_SELECTED}개 SKU만 선택할 수 있습니다.`, 'error');
        return;
      }
      input.checked ? state.selected.add(sku) : state.selected.delete(sku);
      renderRows();
      applyFirstSelectedToEditor();
    });
    host.querySelectorAll('[data-attributes-apply]').forEach(input => input.addEventListener('change', () => {
      const field = input.dataset.attributesApply;
      const select = {material:'attributes-material', productGroup:'attributes-product-group', shape:'attributes-shape'}[field];
      if (select) document.getElementById(select).disabled = !input.checked;
      const tags = {productTags:'product', skuTags:'sku'}[field];
      if (tags) document.querySelector(`[data-attributes-tags="${tags}"]`).setAttribute('aria-disabled', String(!input.checked));
    }));
    host.querySelector('#attributes-save').addEventListener('click', () => void saveSelected());
    host.querySelector('#attributes-create-tag').addEventListener('click', () => void createTag());
    host.querySelector('#attributes-edit-tag-formula').addEventListener('click', () => {const tag=state.tags.find(t=>String(t.tag_id)===document.getElementById('attributes-formula-tag').value);void openTagFormula(tag?{id:tag.tag_id,name:tag.tag_name,color:tag.tag_color,group:tag.tag_group}:null);});
  }

  function init() {
    if (state.initialized) return;
    const host = document.getElementById('attributes');
    if (!host || !global.SystemV3Data) return;
    state.initialized = true;
    renderShell(host);
    bindEvents(host);
    if (host.classList.contains('active-page')) void loadPage();
  }

  function show() {
    init();
    if (state.loading || (state.rows.length && Date.now() - state.lastLoadedAt < 15000)) return Promise.resolve();
    return loadPage();
  }

  global.SystemV3AttributesPage = Object.freeze({init, show, refresh:() => loadPage(), MAX_SELECTED});
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, {once:true});
  else init();
})(window);
