(function initPriceRuleLab(global) {
  'use strict';

  const data = global.SystemV3Data;
  const page = document.getElementById('price-rules');
  const openButton = document.getElementById('price-rule-lab-open');
  if (!data || !page || !openButton) return;

  const state = {tags:[], sets:[], selectedTagIds:[], loading:false};
  const byId = id => document.getElementById(id);
  const escapeHtml = value => String(value ?? '').replace(/[&<>"]/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[character]));
  const money = value => Number(value || 0).toLocaleString('ko-KR') + '원';
  const cleanNumber = value => value === '' || value === null || value === undefined ? null : Number(value);

  function toast(message) {
    const host = byId('toast');
    if (!host) return;
    host.textContent = message;
    host.classList.add('show');
    global.setTimeout(() => host.classList.remove('show'), 2200);
  }

  function atomicMode(tag) {
    if (tag.replace_price !== null && tag.replace_price !== undefined) return {mode:'fixed', value:Number(tag.replace_price)};
    if (tag.modify_type === 'percent') return {mode:Number(tag.modify_value) < 0 ? 'percent_discount' : 'percent_markup', value:Math.abs(Number(tag.modify_value))};
    if (tag.modify_type === 'add') return {mode:Number(tag.modify_value) < 0 ? 'amount_discount' : 'amount_add', value:Math.abs(Number(tag.modify_value))};
    return {mode:'none', value:0};
  }

  function modePayload(mode, value) {
    const amount = Math.abs(Number(value || 0));
    if (mode === 'fixed') return {replacePrice:amount, modifyType:'none', modifyValue:0};
    if (mode === 'percent_discount') return {replacePrice:null, modifyType:'percent', modifyValue:-amount};
    if (mode === 'percent_markup') return {replacePrice:null, modifyType:'percent', modifyValue:amount};
    if (mode === 'amount_discount') return {replacePrice:null, modifyType:'add', modifyValue:-amount};
    if (mode === 'amount_add') return {replacePrice:null, modifyType:'add', modifyValue:amount};
    return {replacePrice:null, modifyType:'none', modifyValue:0};
  }

  function atomicSummary(tag) {
    const {mode, value} = atomicMode(tag);
    const labels = {
      none:'기준가 그대로', fixed:`${money(value)} 고정`,
      percent_discount:`${value}% 할인`, percent_markup:`${value}% 인상`,
      amount_discount:`${money(value)} 할인`, amount_add:`${money(value)} 추가`
    };
    const guards = [];
    if (tag.min_price !== null) guards.push(`최저 ${money(tag.min_price)}`);
    if (tag.max_price !== null) guards.push(`최고 ${money(tag.max_price)}`);
    if (Number(tag.rounding_unit || 1) > 1) guards.push(`${money(tag.rounding_unit)} 단위 ${tag.rounding_mode === 'up' ? '올림' : tag.rounding_mode === 'down' ? '내림' : '반올림'}`);
    const channelLabels = {smartstore:'스마트스토어', makeshop:'메이크샵', ably:'에이블리'};
    const role = tag.tag_role === 'discount'
      ? `할인 · ${channelLabels[tag.discount_source_channel] || '판매처'}`
      : '판매가';
    return [role, labels[mode], ...guards].filter(Boolean).join(' · ');
  }

  function syncTagRoleForm() {
    const isDiscount = byId('price-rule-tag-role').value === 'discount';
    byId('price-rule-tag-source-field').hidden = !isDiscount;
    const mode = byId('price-rule-tag-mode');
    [...mode.options].forEach(option => {
      option.disabled = isDiscount && !['amount_discount','percent_discount'].includes(option.value);
    });
    if (isDiscount && !['amount_discount','percent_discount'].includes(mode.value)) mode.value = 'amount_discount';
    if (!isDiscount && mode.value === 'amount_discount') return;
  }

  function renderTags() {
    byId('price-rule-tag-list').innerHTML = state.tags.map(tag => `
      <button type="button" class="price-rule-tag-card" data-tag-id="${tag.price_rule_tag_id}">
        <i style="--tag-color:${escapeHtml(tag.color)}"></i><span><b>${escapeHtml(tag.tag_name)}</b><em>${escapeHtml(atomicSummary(tag))}</em></span>
      </button>`).join('') || '<p class="price-rule-empty">저장된 계산 태그가 없습니다.</p>';
    byId('price-rule-set-add').innerHTML = '<option value="">계산 태그 추가…</option>' + state.tags.map(tag => `<option value="${tag.price_rule_tag_id}">${escapeHtml(tag.tag_name)}</option>`).join('');
  }

  function renderSets() {
    byId('price-rule-set-list').innerHTML = state.sets.map(ruleSet => `
      <button type="button" class="price-rule-set-card" data-set-id="${ruleSet.price_rule_set_id}">
        <i style="--set-color:${escapeHtml(ruleSet.color)}"></i><span><b>${escapeHtml(ruleSet.set_name)}</b><em>${(ruleSet.tags || []).map(tag => escapeHtml(tag.tag_name)).join(' → ')}</em></span>
      </button>`).join('') || '<p class="price-rule-empty">저장된 가격 조합이 없습니다.</p>';
  }

  function renderSelectedTags() {
    const tagsById = new Map(state.tags.map(tag => [Number(tag.price_rule_tag_id), tag]));
    byId('price-rule-set-selected').innerHTML = state.selectedTagIds.map((tagId, index) => {
      const tag = tagsById.get(Number(tagId));
      if (!tag) return '';
      return `<article data-selected-tag-index="${index}"><strong>${index + 1}</strong><span><b>${escapeHtml(tag.tag_name)}</b><em>${escapeHtml(atomicSummary(tag))}</em></span><div><button type="button" data-move="up" aria-label="위로">↑</button><button type="button" data-move="down" aria-label="아래로">↓</button><button type="button" data-remove aria-label="삭제">×</button></div></article>`;
    }).join('') || '<p class="price-rule-empty">아래 목록에서 계산 태그를 추가하세요.</p>';
  }

  function renderAll() {
    byId('price-rule-tag-count').textContent = `${state.tags.length}개`;
    byId('price-rule-set-count').textContent = `${state.sets.length}개`;
    renderTags();
    renderSets();
    renderSelectedTags();
  }

  async function refresh() {
    if (state.loading) return;
    state.loading = true;
    byId('price-rule-lab-error').hidden = true;
    byId('price-rule-lab-refresh').disabled = true;
    try {
      [state.tags, state.sets] = await Promise.all([
        data.loadPriceRuleTags(), data.loadPriceRuleSets()
      ]);
      renderAll();
    } catch (error) {
      console.error('price rule lab load failed', error);
      const host = byId('price-rule-lab-error');
      host.textContent = `가격 규칙을 불러오지 못했습니다: ${error?.message || error}`;
      host.hidden = false;
    } finally {
      state.loading = false;
      byId('price-rule-lab-refresh').disabled = false;
    }
  }

  function resetTagForm() {
    byId('price-rule-tag-id').value = '';
    byId('price-rule-tag-name').value = '';
    byId('price-rule-tag-role').value = 'price';
    byId('price-rule-tag-source').value = 'smartstore';
    byId('price-rule-tag-mode').value = 'none';
    byId('price-rule-tag-value').value = '0';
    byId('price-rule-tag-color').value = '#2f6fd1';
    byId('price-rule-tag-min').value = '';
    byId('price-rule-tag-max').value = '';
    byId('price-rule-tag-round-unit').value = '1';
    byId('price-rule-tag-round-mode').value = 'nearest';
    byId('price-rule-tag-delete').hidden = true;
    syncTagRoleForm();
  }

  function editTag(tagId) {
    const tag = state.tags.find(item => Number(item.price_rule_tag_id) === Number(tagId));
    if (!tag) return;
    const simple = atomicMode(tag);
    byId('price-rule-tag-id').value = tag.price_rule_tag_id;
    byId('price-rule-tag-name').value = tag.tag_name;
    byId('price-rule-tag-role').value = tag.tag_role || 'price';
    byId('price-rule-tag-source').value = tag.discount_source_channel || 'smartstore';
    byId('price-rule-tag-mode').value = simple.mode;
    byId('price-rule-tag-value').value = simple.value;
    byId('price-rule-tag-color').value = tag.color;
    byId('price-rule-tag-min').value = tag.min_price ?? '';
    byId('price-rule-tag-max').value = tag.max_price ?? '';
    byId('price-rule-tag-round-unit').value = tag.rounding_unit ?? 1;
    byId('price-rule-tag-round-mode').value = tag.rounding_mode || 'nearest';
    byId('price-rule-tag-delete').hidden = false;
    syncTagRoleForm();
  }

  function resetSetForm() {
    byId('price-rule-set-id').value = '';
    byId('price-rule-set-name').value = '';
    byId('price-rule-set-color').value = '#1558c0';
    state.selectedTagIds = [];
    renderSelectedTags();
    byId('price-rule-set-delete').hidden = true;
  }

  function editSet(setId) {
    const ruleSet = state.sets.find(item => Number(item.price_rule_set_id) === Number(setId));
    if (!ruleSet) return;
    byId('price-rule-set-id').value = ruleSet.price_rule_set_id;
    byId('price-rule-set-name').value = ruleSet.set_name;
    byId('price-rule-set-color').value = ruleSet.color;
    state.selectedTagIds = (ruleSet.tags || []).slice().sort((left, right) => Number(left.order) - Number(right.order)).map(tag => Number(tag.tag_id));
    renderSelectedTags();
    byId('price-rule-set-delete').hidden = false;
  }

  openButton.addEventListener('click', () => global.showPage?.('price-rules'));
  byId('price-rule-lab-done').addEventListener('click', () => global.showPage?.('matching'));
  byId('price-rule-lab-refresh').addEventListener('click', refresh);
  byId('price-rule-tag-reset').addEventListener('click', resetTagForm);
  byId('price-rule-tag-role').addEventListener('change', syncTagRoleForm);
  byId('price-rule-set-reset').addEventListener('click', resetSetForm);
  byId('price-rule-tag-delete').addEventListener('click', async () => {
    const tagId = cleanNumber(byId('price-rule-tag-id').value);
    const tag = state.tags.find(item => Number(item.price_rule_tag_id) === Number(tagId));
    if (!tagId || !tag || !global.confirm(`계산 태그 “${tag.tag_name}”을 삭제할까요?\n사용 중인 가격 조합이 있으면 삭제되지 않습니다.`)) return;
    const button = byId('price-rule-tag-delete');
    button.disabled = true;
    try {
      await data.deletePriceRuleTag(tagId);
      resetTagForm();
      await refresh();
      toast('작은 가격 태그를 삭제했습니다.');
    } catch (error) { toast(error?.message || '계산 태그 삭제에 실패했습니다.'); }
    finally { button.disabled = false; }
  });
  byId('price-rule-set-delete').addEventListener('click', async () => {
    const ruleSetId = cleanNumber(byId('price-rule-set-id').value);
    const ruleSet = state.sets.find(item => Number(item.price_rule_set_id) === Number(ruleSetId));
    if (!ruleSetId || !ruleSet || !global.confirm(`가격 조합 “${ruleSet.set_name}”을 삭제할까요?\n상품에 배정되어 있으면 삭제되지 않습니다.`)) return;
    const button = byId('price-rule-set-delete');
    button.disabled = true;
    try {
      await data.deletePriceRuleSet(ruleSetId);
      resetSetForm();
      await refresh();
      toast('큰 가격 태그를 삭제했습니다.');
    } catch (error) { toast(error?.message || '가격 조합 삭제에 실패했습니다.'); }
    finally { button.disabled = false; }
  });
  byId('price-rule-tag-list').addEventListener('click', event => editTag(event.target.closest('[data-tag-id]')?.dataset.tagId));
  byId('price-rule-set-list').addEventListener('click', event => editSet(event.target.closest('[data-set-id]')?.dataset.setId));
  byId('price-rule-set-add').addEventListener('change', event => {
    const tagId = Number(event.target.value);
    if (tagId && !state.selectedTagIds.includes(tagId)) state.selectedTagIds.push(tagId);
    event.target.value = '';
    renderSelectedTags();
  });
  byId('price-rule-set-selected').addEventListener('click', event => {
    const row = event.target.closest('[data-selected-tag-index]');
    if (!row) return;
    const index = Number(row.dataset.selectedTagIndex);
    if (event.target.matches('[data-remove]')) state.selectedTagIds.splice(index, 1);
    if (event.target.dataset.move === 'up' && index > 0) [state.selectedTagIds[index - 1], state.selectedTagIds[index]] = [state.selectedTagIds[index], state.selectedTagIds[index - 1]];
    if (event.target.dataset.move === 'down' && index < state.selectedTagIds.length - 1) [state.selectedTagIds[index + 1], state.selectedTagIds[index]] = [state.selectedTagIds[index], state.selectedTagIds[index + 1]];
    renderSelectedTags();
  });
  byId('price-rule-tag-form').addEventListener('submit', async event => {
    event.preventDefault();
    const submit = event.submitter;
    submit.disabled = true;
    try {
      const calc = modePayload(byId('price-rule-tag-mode').value, byId('price-rule-tag-value').value);
      const tagRole = byId('price-rule-tag-role').value;
      const previousTag = state.tags.find(tag => Number(tag.price_rule_tag_id) === cleanNumber(byId('price-rule-tag-id').value));
      const sameDiscount = tagRole === 'discount' && previousTag?.tag_role === 'discount'
        && previousTag.discount_source_channel === byId('price-rule-tag-source').value
        && previousTag.modify_type === calc.modifyType && Number(previousTag.modify_value) === calc.modifyValue;
      if (tagRole === 'discount' && !['amount_discount','percent_discount'].includes(byId('price-rule-tag-mode').value)) {
        throw new Error('할인 태그는 금액 할인 또는 퍼센트 할인만 선택할 수 있습니다.');
      }
      await data.savePriceRuleTag({
        tagId:cleanNumber(byId('price-rule-tag-id').value), tagName:byId('price-rule-tag-name').value,
        color:byId('price-rule-tag-color').value, tagRole,
        discountSource:tagRole === 'discount' ? byId('price-rule-tag-source').value : null,
        discountRuleCode:sameDiscount ? previousTag.discount_rule_code : null, note:previousTag?.note || '', ...calc,
        minPrice:cleanNumber(byId('price-rule-tag-min').value), maxPrice:cleanNumber(byId('price-rule-tag-max').value),
        roundingUnit:cleanNumber(byId('price-rule-tag-round-unit').value) || 1,
        roundingMode:byId('price-rule-tag-round-mode').value
      });
      resetTagForm();
      await refresh();
      toast('작은 가격 태그를 저장했습니다.');
    } catch (error) { toast(error?.message || '계산 태그 저장에 실패했습니다.'); }
    finally { submit.disabled = false; }
  });
  byId('price-rule-set-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (!state.selectedTagIds.length) { toast('계산 태그를 한 개 이상 추가하세요.'); return; }
    const submit = event.submitter;
    submit.disabled = true;
    try {
      await data.savePriceRuleSet({
        ruleSetId:cleanNumber(byId('price-rule-set-id').value), setName:byId('price-rule-set-name').value,
        color:byId('price-rule-set-color').value, tagIds:state.selectedTagIds
      });
      resetSetForm();
      await refresh();
      toast('큰 가격 태그와 계산 순서를 저장했습니다.');
    } catch (error) { toast(error?.message || '가격 조합 저장에 실패했습니다.'); }
    finally { submit.disabled = false; }
  });
  global.SystemV3PriceRuleLab = {refresh};
})(window);
