(function initOriginalUploadHistory(global) {
  'use strict';

  const panel = document.getElementById('original-upload-history');
  if (!panel) return;
  const list = document.getElementById('original-upload-history-list');
  const status = document.getElementById('original-upload-history-status');
  const title = document.getElementById('original-upload-history-title');
  const refreshButton = document.getElementById('original-upload-history-refresh');
  const moreButton = document.getElementById('original-upload-history-more');
  const state = {active:false, rows:[], nextOffset:0, hasMore:false, loading:false, generation:0, controller:null};
  const RECENT_LIMIT = 6;
  const PAGE_LIMIT = 20;
  const HISTORY_LIMIT = 900;
  const channels = {
    sellpia:{label:'셀피아 원본', initial:'S', cls:'sellpia'},
    smartstore:{label:'스마트스토어', initial:'N', cls:'smart'},
    makeshop:{label:'메이크샵', initial:'M', cls:'make'},
    ably:{label:'에이블리', initial:'A', cls:'ably'}
  };
  const statuses = {ready:['완료','done'], uploading:['업로드 중','wait'], failed:['실패','failed'], cancelled:['취소','muted'], archived:['보관됨','muted']};
  const modes = {full:'전체 교체', patch:'부분 갱신', inventory_count:'재고조사'};
  const dateFormatter = new Intl.DateTimeFormat('en-GB', {
    timeZone:'Asia/Seoul', year:'numeric', month:'2-digit', day:'2-digit',
    hour:'2-digit', minute:'2-digit', second:'2-digit', hourCycle:'h23'
  });

  function escape(value) {
    return String(value ?? '').replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
  }

  function count(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0
      ? value.toLocaleString('ko-KR') : null;
  }

  function date(value) {
    if (!value) return null;
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return null;
    const parts = Object.fromEntries(dateFormatter.formatToParts(parsed).map(part => [part.type, part.value]));
    return {parsed, text:`${parts.year}.${parts.month}.${parts.day} ${parts.hour}:${parts.minute}:${parts.second} KST`};
  }

  function timeMarkup(label, value) {
    const formatted = date(value);
    return formatted
      ? `<time datetime="${escape(formatted.parsed.toISOString())}">${label} ${formatted.text}</time>`
      : `<span>${label} 시각 확인 불가</span>`;
  }

  function rowMarkup(row) {
    const channel = channels[row.source] || {label:row.source || '원본 종류 확인 불가', initial:'?', cls:'sellpia'};
    const [statusLabel, statusClass] = statuses[row.status] || ['확인 필요','muted'];
    const files = count(row.fileCount);
    const uploaded = count(row.uploadedRows);
    const effective = count(row.effectiveRows);
    const invalid = count(row.invalidRows);
    const rowLabel = row.status === 'ready' ? '업로드' : '대상';
    const summary = [files === null ? '파일 수 확인 불가' : `파일 ${files}개`, uploaded === null ? `${rowLabel} 행 수 확인 불가` : `${rowLabel} ${uploaded}행`];
    if (row.status === 'ready' && effective !== null && row.effectiveRows !== row.uploadedRows) summary.push(`반영 후 총 ${effective}행`);
    if (invalid !== null && row.invalidRows > 0) summary.push(`오류 ${invalid}행`);
    const fileNames = Array.isArray(row.fileNames) ? row.fileNames.map(String) : [];
    const names = fileNames.length ? fileNames.join(' · ') : '파일명 확인 불가';
    const start = date(row.createdAt);
    const end = date(row.completedAt);
    const duration = start && end && end.parsed >= start.parsed
      ? `처리 ${Math.round((end.parsed - start.parsed) / 1000).toLocaleString('ko-KR')}초` : '';
    return `<article data-upload-id="${escape(row.id || row.snapshotId || '')}">
      <div><span class="channel-logo ${channel.cls}" aria-hidden="true">${channel.initial}</span><p><b>${escape(channel.label)}</b><em>${escape(summary.join(' · '))}</em></p><strong class="status ${statusClass}">${statusLabel}</strong></div>
      ${modes[row.uploadMode] ? `<p class="upload-history-detail">${modes[row.uploadMode]}</p>` : ''}
      <p class="upload-history-files" title="${escape(names)}"><span class="upload-history-field">원본 파일</span> ${escape(names)}</p>
      <p class="upload-history-times">${timeMarkup('시작', row.createdAt)}${row.completedAt ? timeMarkup(row.status === 'ready' ? '완료' : '종료', row.completedAt) : ''}${duration ? `<span>${duration}</span>` : ''}</p>
      ${row.status === 'failed' ? `<p class="upload-history-error">${escape(row.errorMessage || '실패 원인이 기록되지 않았습니다.')}</p>` : ''}
    </article>`;
  }

  function render(message = '') {
    panel.setAttribute('aria-busy', String(state.loading));
    refreshButton.disabled = state.loading || !state.active;
    moreButton.disabled = state.loading;
    moreButton.hidden = !state.hasMore || state.nextOffset >= HISTORY_LIMIT;
    title.textContent = state.rows.length > RECENT_LIMIT ? '업로드 이력' : '최근 업로드';
    list.innerHTML = state.rows.length
      ? state.rows.map(rowMarkup).join('')
      : `<p class="upload-history-empty">${escape(message || (state.loading ? 'DB 업로드 이력을 조회하고 있습니다.' : state.active ? '등록된 업로드 이력이 없습니다.' : '로그인 후 실제 업로드 이력을 조회합니다.'))}</p>`;
    status.textContent = message || (state.loading ? 'DB 조회 중…' : state.nextOffset >= HISTORY_LIMIT && state.hasMore
      ? `최근 조회 범위 ${HISTORY_LIMIT}건 중 ${state.rows.length.toLocaleString('ko-KR')}건을 표시합니다.` : state.rows.length ? `DB 업로드 기록 ${state.rows.length.toLocaleString('ko-KR')}건 · 시작 시각 최신순` : '');
  }

  async function refresh({append = false} = {}) {
    if (!state.active || (append && (state.loading || !state.hasMore || state.nextOffset >= HISTORY_LIMIT))) return false;
    const generation = ++state.generation;
    state.controller?.abort();
    const controller = new AbortController();
    state.controller = controller;
    state.loading = true;
    render();
    try {
      if (typeof global.SystemV3Data?.loadOriginalUploadHistory !== 'function') throw Error('업로드 이력 조회 모듈을 불러오지 못했습니다. 새로고침 후 다시 확인해주세요.');
      const offset = append ? state.nextOffset : 0;
      const limit = append ? Math.min(PAGE_LIMIT, HISTORY_LIMIT - offset) : RECENT_LIMIT;
      const result = await global.SystemV3Data.loadOriginalUploadHistory({limit, offset, signal:controller.signal});
      if (generation !== state.generation || !state.active) return false;
      if (!result || !Array.isArray(result.rows)) throw Error('업로드 이력 응답을 확인할 수 없습니다.');
      const seen = new Set();
      state.rows = (append ? [...state.rows, ...result.rows] : result.rows).filter(row => {
        const key = row.id || row.snapshotId;
        if (!key) return true;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      state.nextOffset = offset + result.rows.length;
      state.hasMore = Boolean(result.hasMore && result.rows.length);
      state.loading = false;
      render();
      return true;
    } catch (error) {
      if (generation !== state.generation || !state.active) return false;
      state.rows = [];
      state.nextOffset = 0;
      state.hasMore = false;
      state.loading = false;
      render(`업로드 이력을 불러오지 못했습니다. ${error?.message || '다시 조회해주세요.'}`);
      return false;
    } finally {
      if (generation === state.generation) state.controller = null;
    }
  }

  function reset() {
    state.active = false;
    state.generation += 1;
    state.controller?.abort();
    state.controller = null;
    state.rows = [];
    state.nextOffset = 0;
    state.hasMore = false;
    state.loading = false;
    render();
  }

  refreshButton.addEventListener('click', () => { void refresh(); });
  moreButton.addEventListener('click', () => { void refresh({append:true}); });
  global.SystemV3OriginalUploadHistory = {activate(){ state.active = true; render(); }, reset, refresh};
  render();
})(window);
