(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SystemV3ChannelsPage = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  const SOURCE_ORDER = ['sellpia', 'smartstore', 'makeshop', 'ably'];
  const SOURCE_META = {
    sellpia:{name:'셀피아 기준 원본', initial:'S', className:'sellpia', role:'시스템 비교 기준'},
    smartstore:{name:'스마트스토어', initial:'N', className:'smart', role:'판매처 원본'},
    makeshop:{name:'메이크샵', initial:'M', className:'make', role:'판매처 원본'},
    ably:{name:'에이블리', initial:'A', className:'ably', role:'판매처 원본'}
  };
  const EVENT_LABELS = {
    SOURCE_UPLOAD:'원본 업로드',
    CACHE_COMMIT:'원본 캐시 반영',
    INVENTORY_MATCH:'재고 대조',
    MAPPING_SYNC:'상품 연결 갱신',
    PRICE_SYNC:'가격 데이터 갱신',
    INVENTORY_SYNC:'재고 데이터 갱신'
  };

  let pageElement = null;
  let dataService = null;
  let requestSequence = 0;
  let mounted = false;
  let lastLoadedAt = 0;
  const PASSIVE_REFRESH_INTERVAL_MS = 15000;

  function cleanText(value) {
    return String(value ?? '').trim();
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function formatNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number.toLocaleString('ko-KR') : '-';
  }

  function normalizeSource(value) {
    const normalized = cleanText(value).toLowerCase().replaceAll('-', '').replaceAll('_', '');
    if (['sellpia', 'sellpiasource'].includes(normalized)) return 'sellpia';
    if (['smartstore', 'naver', 'naversmartstore'].includes(normalized)) return 'smartstore';
    if (['makeshop', 'make'].includes(normalized)) return 'makeshop';
    if (['ably', 'a-bly'].includes(normalized)) return 'ably';
    return cleanText(value).toLowerCase();
  }

  function eventStatus(status) {
    const normalized = cleanText(status).toLowerCase();
    if (/success|complete|completed|done|ok|normal/.test(normalized)) {
      return {key:'done', label:'정상'};
    }
    if (/running|processing|progress/.test(normalized)) {
      return {key:'running', label:'진행 중'};
    }
    if (/pending|queued|waiting|ready/.test(normalized)) {
      return {key:'waiting', label:'대기'};
    }
    if (/fail|error|timeout|cancel/.test(normalized)) {
      return {key:'failed', label:'실패'};
    }
    return normalized ? {key:'unknown', label:cleanText(status)} : {key:'unknown', label:'상태 미확인'};
  }

  function formatTime(value, includeDate = true) {
    if (!value) return '-';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return cleanText(value) || '-';
    const options = includeDate
      ? {month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false}
      : {hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false};
    return new Intl.DateTimeFormat('ko-KR', options).format(date);
  }

  function formatDuration(value) {
    const milliseconds = Number(value);
    if (!Number.isFinite(milliseconds) || milliseconds < 0) return '-';
    if (milliseconds < 1000) return `${Math.round(milliseconds)}ms`;
    if (milliseconds < 60000) return `${(milliseconds / 1000).toFixed(milliseconds < 10000 ? 1 : 0)}초`;
    const minutes = Math.floor(milliseconds / 60000);
    const seconds = Math.round((milliseconds % 60000) / 1000);
    return `${minutes}분 ${seconds}초`;
  }

  function eventRowsLabel(event) {
    const processed = Number(event?.processed_rows);
    const total = Number(event?.total_rows);
    const output = Number(event?.output_rows);
    if (Number.isFinite(processed) && Number.isFinite(total) && total > 0) {
      return `${formatNumber(processed)} / ${formatNumber(total)}행`;
    }
    if (Number.isFinite(output) && output >= 0) return `${formatNumber(output)}행`;
    if (Number.isFinite(processed) && processed >= 0) return `${formatNumber(processed)}행`;
    return '-';
  }

  function buildViewModel(sourceResult, queueStats) {
    const events = Array.isArray(sourceResult?.events) ? sourceResult.events : [];
    const latestBySource = {};
    for (const [source, event] of Object.entries(sourceResult?.latest || {})) {
      latestBySource[normalizeSource(source)] = event;
    }
    for (const event of events) {
      const source = normalizeSource(event?.source);
      if (SOURCE_META[source] && !latestBySource[source]) latestBySource[source] = event;
    }
    return {
      sources:SOURCE_ORDER.map(source => ({source, ...SOURCE_META[source], event:latestBySource[source] || null})),
      events:events.filter(event => SOURCE_META[normalizeSource(event?.source)]).slice(0, 20),
      queue:{
        active:Number(queueStats?.active || 0),
        pending:Number(queueStats?.pending || 0),
        validated:Number(queueStats?.validated || 0),
        failed:Number(queueStats?.failed || 0),
        applied:Number(queueStats?.applied || 0),
        saved:Number(queueStats?.saved || 0),
        cancelled:Number(queueStats?.cancelled || 0)
      }
    };
  }

  function shellMarkup() {
    return `
      <div class="page-head channels-page-head">
        <div><h2>판매처 동기화</h2><p>판매처 원본과 내보내기 준비 상태를 DB 기록 기준으로 조회합니다.</p></div>
        <div class="head-actions">
          <span id="channels-live-status" class="live-data-badge loading">DB 조회 중</span>
          <button id="channels-refresh" class="btn" type="button">DB 새로고침</button>
          <button class="btn primary" type="button" data-page="jobs">내보내기 준비·로그</button>
        </div>
      </div>
      <div class="channels-readonly-note"><b>조회 전용 운영 화면</b><span>이 화면에서는 쇼핑몰 갱신이나 전송을 실행하지 않습니다. 실제 반영 전 검토 대상은 내보내기·로그에서 확인하세요.</span></div>
      <section class="channels-source-grid" id="channels-source-grid" aria-label="판매처별 최근 원본 상태"></section>
      <section class="panel channels-queue-panel">
        <div class="panel-title"><div><h3>내보내기 준비 현황</h3><p>시스템에 저장된 변경 대기와 검증 결과를 합산합니다.</p></div><button class="text-btn" type="button" data-page="jobs">전체 내역 보기</button></div>
        <div class="channels-queue-metrics" id="channels-queue-metrics"></div>
      </section>
      <section class="panel channels-events-panel">
        <div class="panel-title"><div><h3>최근 원본·대조 이력</h3><p>판매처별 업로드와 DB 대조 이벤트를 최근 순으로 표시합니다.</p></div><time id="channels-refreshed-at">마지막 조회 -</time></div>
        <div class="channels-events-wrap">
          <table class="data-table channels-events-table">
            <thead><tr><th>판매처</th><th>이벤트</th><th>처리 행</th><th>소요시간</th><th>발생 시각</th><th>상태</th></tr></thead>
            <tbody id="channels-events-body"><tr><td colspan="6" class="channels-empty">DB 기록을 불러오는 중입니다.</td></tr></tbody>
          </table>
        </div>
      </section>
      <div id="channels-error" class="channels-error" hidden></div>`;
  }

  function sourceCardsMarkup(sources) {
    return sources.map(item => {
      const state = item.event ? eventStatus(item.event.status) : {key:'empty', label:'기록 없음'};
      const eventLabel = item.event ? (EVENT_LABELS[item.event.event_type] || cleanText(item.event.event_type) || '최근 이벤트') : '등록된 원본 이벤트 없음';
      return `<article class="channels-source-card ${escapeHtml(state.key)}">
        <div class="channels-source-card-head"><span class="channel-logo ${escapeHtml(item.className)}">${escapeHtml(item.initial)}</span><p><b>${escapeHtml(item.name)}</b><em>${escapeHtml(item.role)}</em></p><strong class="channels-state ${escapeHtml(state.key)}">${escapeHtml(state.label)}</strong></div>
        <dl><div><dt>최근 작업</dt><dd>${escapeHtml(eventLabel)}</dd></div><div><dt>처리 행</dt><dd>${escapeHtml(eventRowsLabel(item.event))}</dd></div><div><dt>최근 시각</dt><dd>${escapeHtml(formatTime(item.event?.event_at))}</dd></div></dl>
      </article>`;
    }).join('');
  }

  function queueMetricsMarkup(queue) {
    return [
      ['현재 검토 대상', queue.active, 'active'],
      ['저장 대기', queue.pending, 'pending'],
      ['검증 완료', queue.validated, 'validated'],
      ['실패', queue.failed, queue.failed ? 'failed' : 'done'],
      ['반영 확인', queue.applied, 'done']
    ].map(([label, value, className]) => `<article class="${className}"><span>${escapeHtml(label)}</span><strong>${formatNumber(value)}</strong></article>`).join('');
  }

  function eventsMarkup(events) {
    if (!events.length) return '<tr><td colspan="6" class="channels-empty">등록된 원본·대조 이벤트가 없습니다.</td></tr>';
    return events.map(event => {
      const source = normalizeSource(event.source);
      const meta = SOURCE_META[source] || {name:source || '-', initial:'?', className:'sellpia'};
      const state = eventStatus(event.status);
      return `<tr>
        <td><span class="channels-table-source"><i class="channel-logo ${escapeHtml(meta.className)}">${escapeHtml(meta.initial)}</i><b>${escapeHtml(meta.name)}</b></span></td>
        <td>${escapeHtml(EVENT_LABELS[event.event_type] || cleanText(event.event_type) || '-')}</td>
        <td>${escapeHtml(eventRowsLabel(event))}</td>
        <td>${escapeHtml(formatDuration(event.duration_ms))}</td>
        <td>${escapeHtml(formatTime(event.event_at))}</td>
        <td><span class="channels-state ${escapeHtml(state.key)}">${escapeHtml(state.label)}</span></td>
      </tr>`;
    }).join('');
  }

  function setBadge(className, label) {
    const badge = pageElement?.querySelector('#channels-live-status');
    if (!badge) return;
    badge.className = `live-data-badge ${className}`;
    badge.textContent = label;
  }

  function renderPartialError(messages) {
    const error = pageElement?.querySelector('#channels-error');
    if (!error) return;
    error.hidden = !messages.length;
    error.innerHTML = messages.length
      ? `<b>일부 DB 정보를 불러오지 못했습니다.</b><span>${messages.map(escapeHtml).join(' · ')}</span>`
      : '';
  }

  async function refresh(options = {}) {
    if (!mounted || !pageElement || !dataService) return null;
    const sequence = ++requestSequence;
    const silent = options.silent === true;
    if (!silent) setBadge('loading', 'DB 조회 중');

    const results = await Promise.allSettled([
      dataService.loadSourceStatus(),
      dataService.loadChangeQueueStats()
    ]);
    if (sequence !== requestSequence) return null;

    const sourceResult = results[0].status === 'fulfilled' ? results[0].value : null;
    const queueStats = results[1].status === 'fulfilled' ? results[1].value : null;
    const errors = results
      .filter(result => result.status === 'rejected')
      .map(result => cleanText(result.reason?.message || result.reason) || '알 수 없는 DB 오류');
    const view = buildViewModel(sourceResult, queueStats);

    if (sourceResult) {
      pageElement.querySelector('#channels-source-grid').innerHTML = sourceCardsMarkup(view.sources);
      pageElement.querySelector('#channels-events-body').innerHTML = eventsMarkup(view.events);
    } else {
      pageElement.querySelector('#channels-source-grid').innerHTML = '<div class="channels-empty-card">판매처 원본 상태를 불러오지 못했습니다.</div>';
      pageElement.querySelector('#channels-events-body').innerHTML = '<tr><td colspan="6" class="channels-empty">최근 원본 이력을 불러오지 못했습니다.</td></tr>';
    }
    if (queueStats) {
      pageElement.querySelector('#channels-queue-metrics').innerHTML = queueMetricsMarkup(view.queue);
    } else {
      pageElement.querySelector('#channels-queue-metrics').innerHTML = '<div class="channels-empty-card">내보내기 준비 현황을 불러오지 못했습니다.</div>';
    }
    pageElement.querySelector('#channels-refreshed-at').textContent = `마지막 조회 ${formatTime(new Date().toISOString(), false)}`;
    renderPartialError(errors);
    if (!errors.length) setBadge('connected', 'LIVE · 조회 완료');
    else if (sourceResult || queueStats) setBadge('warning', '일부 조회 실패');
    else setBadge('error', 'DB 조회 실패');
    if (sourceResult || queueStats) lastLoadedAt = Date.now();
    return {view, errors};
  }

  function mount(element, service) {
    pageElement = element || (typeof document !== 'undefined' ? document.getElementById('channels') : null);
    dataService = service || (typeof window !== 'undefined' ? window.SystemV3Data : null);
    if (!pageElement || !dataService) return false;
    if (!mounted) {
      pageElement.innerHTML = shellMarkup();
      pageElement.querySelector('#channels-refresh').addEventListener('click', () => refresh());
      mounted = true;
    }
    refresh();
    return true;
  }

  function ensureMounted() {
    if (mounted) return true;
    return mount();
  }

  function show() {
    if (!mounted) return mount();
    if (Date.now() - lastLoadedAt >= PASSIVE_REFRESH_INTERVAL_MS) refresh({silent:true});
    return true;
  }

  return {
    SOURCE_META,
    normalizeSource,
    eventStatus,
    eventRowsLabel,
    formatDuration,
    buildViewModel,
    PASSIVE_REFRESH_INTERVAL_MS,
    mount,
    ensureMounted,
    show,
    refresh
  };
});
