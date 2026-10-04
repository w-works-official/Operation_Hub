(function initSystemV3MatrixCsv(global) {
  'use strict';

  const CHANNELS = [
    ['smartstore', '스마트스토어'],
    ['makeshop', '메이크샵'],
    ['ably', '에이블리']
  ];
  const STATUS_LABELS = {connected:'연결 완료', review:'연결 완료', unmatched:'미매칭'};
  const CODE_LIST_STATUS_LABELS = {matched:'정상 매칭', expanded:'상품 단위 확장', unmapped:'매핑 필요', missing:'코드 없음', conflict:'SKU 불일치'};

  function text(value) {
    return value === null || value === undefined ? '' : String(value);
  }

  function profileValue(row, key) {
    return row?.__profile?.[key] ?? row?.[key] ?? '';
  }

  function sellerState(row, source) {
    const tier = text(row?.[`${source}_match_tier`]);
    if (!tier) return '미매칭';
    return '연결 완료';
  }

  function projectedSellerValue(row, source, fieldKey, rawKey) {
    const draft = row?.__sellerDrafts?.[`${source}:${fieldKey}`];
    return draft ? draft.after_value : row?.[rawKey];
  }

  function sellerDraftStatus(row, source) {
    const stock = row?.__sellerDrafts?.[`${source}:sellpia_current_stock`];
    const price = row?.__sellerDrafts?.[`${source}:sellpia_sale_price`];
    return [stock?.status, price?.status].filter(Boolean).join(' / ');
  }

  function sellerPriceComponent(row, source, component, projected = true) {
    const layer = row?.__sellerPriceComponents?.[source] || {};
    const draft = row?.__sellerDrafts?.[`${source}:sellpia_sale_price`];
    const sourceKey = `source_${component}_price`;
    const draftKey = `draft_${component}_price`;
    const queueDraftKey = `price_${component}_after`;
    const fallback = component === 'option' ? 0 : row?.[`${source}_price`];
    if (projected) return layer[draftKey] ?? draft?.[queueDraftKey] ?? layer[sourceKey] ?? row?.[`${source}_${component}_price`] ?? fallback;
    return layer[sourceKey] ?? row?.[`${source}_${component}_price`] ?? fallback;
  }

  function sellerDiscountInformation(row, source) {
    const layer = row?.__sellerPriceComponents?.[source] || {};
    const draft = row?.__sellerDrafts?.[`${source}:sellpia_sale_price`];
    const sourceTerms = layer.source_discount_terms ?? row?.[`${source}_discount_terms`] ?? [];
    const terms = draft ? (layer.draft_discount_terms ?? draft.price_discount_terms_after ?? sourceTerms) : sourceTerms;
    const activeTerms = (Array.isArray(terms) ? terms : []).filter(term => {
      const value = Math.abs(Number(term?.value));
      return term && term.enabled !== false && Number.isFinite(value) && value > 0;
    });
    const basePrice = sellerPriceComponent(row, source, 'base');
    const discountedBasePrice = sellerPriceComponent(row, source, 'discounted_base');
    const labels = activeTerms.map(term => `${term.title || '할인'} ${Number(term.value).toLocaleString('ko-KR')}${term.unit === 'percent' ? '%' : '원'}${term.is_baseline ? '' : ' (조건부)'}`);
    const reportedDiscount = Number.isFinite(Number(basePrice))
      && Number.isFinite(Number(discountedBasePrice))
      && Number(discountedBasePrice) < Number(basePrice);
    if (!labels.length && !reportedDiscount) return '할인 없음';
    const summary = labels.length ? labels.join(' · ') : '판매처 할인가';
    return Number.isFinite(Number(discountedBasePrice))
      ? `${summary} · 적용가 ${Number(discountedBasePrice).toLocaleString('ko-KR')}원`
      : summary;
  }

  function codeListColumns() {
    return [
      {key:'input_row', label:'입력 행', type:'number', value:row => row?.__codeList?.input_row},
      {key:'input_source', label:'입력 판매처', value:row => ({sellpia:'셀피아', smartstore:'스마트스토어', makeshop:'메이크샵', ably:'에이블리'})[row?.__codeList?.source_channel] || row?.__codeList?.source_channel},
      {key:'input_code', label:'입력 코드', type:'code', value:row => row?.__codeList?.input_code},
      {key:'input_status', label:'조회 결과', value:row => CODE_LIST_STATUS_LABELS[row?.__codeList?.match_status] || row?.__codeList?.match_status},
      {key:'input_reason', label:'조회 설명', value:row => row?.__codeList?.reason}
    ];
  }

  function sellpiaColumns(scope, view) {
    const all = scope === 'all';
    const columns = [
      {key:'sellpia_sku_code', label:'셀피아 SKU', type:'code'},
      {key:'sellpia_own_code', label:'셀피아 자사코드', type:'code', value:row => row?.sellpia_own_code || row?.own_code},
      {key:'sellpia_product_name', label:'셀피아 상품명', value:row => row?.sellpia_product_name || row?.display_name},
      {key:'sellpia_option_name', label:'셀피아 옵션명'},
      {key:'system_stock', label:'시스템 기준재고', type:'number'},
      {key:'sellpia_source_stock', label:'셀피아 원본재고', type:'number', value:row => row?.sellpia_source_stock ?? row?.sellpia_current_stock},
      {key:'system_base_price', label:'시스템 기준가격', type:'number'},
      {key:'sellpia_source_sale_price', label:'셀피아 원본 판매가', type:'number', value:row => row?.sellpia_source_sale_price ?? row?.sellpia_sale_price},
      {key:'sellpia_source_updated_at', label:'셀피아 원본 갱신시각', value:row => row?.sellpia_source_updated_at ?? row?.sellpia_inventory_at},
      {key:'sellpia_purchase_price', label:'셀피아 매입가', type:'number'},
      {key:'sellpia_order_unit', label:'셀피아 발주단위', type:'number'},
      {key:'sellpia_minimum_order_unit', label:'셀피아 최소발주단위', type:'number'},
      {key:'actual_inbound_cost', label:'실입고가', type:'number'},
      {key:'inbound_cost_formula_tag_name', label:'실입고가 수식태그'}
    ];
    if (all) columns.splice(2, 0, {key:'image_url', label:'이미지 URL', value:row => row?.sellpia_override_image_url || row?.image_url});
    if (all) columns.push(
      {key:'sellpia_available_stock', label:'셀피아 가용재고', type:'number'},
      {key:'sellpia_safety_stock', label:'셀피아 안전재고', type:'number'},
      {key:'sellpia_inventory_at', label:'셀피아 재고기준시각'}
    );
    return columns.filter(column => {
      if (!all && view?.showInventory === false && ['system_stock','sellpia_source_stock'].includes(column.key)) return false;
      if (!all && view?.showPrice === false && ['system_base_price','sellpia_source_sale_price'].includes(column.key)) return false;
      return true;
    });
  }

  function sellerColumns(source, label, scope, view) {
    const all = scope === 'all';
    if (!all && view?.channels?.[source] === false) return [];
    const columns = [];
    if (all) columns.push({key:`${source}_connection`, label:`${label} 연결상태`, value:row => sellerState(row, source)});
    if (all || view?.showCodes !== false) columns.push(
      {key:`${source}_product_code`, label:`${label} 상품코드`, type:'code'},
      {key:`${source}_option_code`, label:`${label} 옵션코드`, type:'code'}
    );
    if (all || view?.showSellerNames !== false) columns.push(
      {key:`${source}_name`, label:`${label} 상품명`},
      {key:`${source}_option_name`, label:`${label} 옵션명`}
    );
    if (all || view?.showInventory !== false) columns.push({
      key:`${source}_stock_projected`, label:`${label} 판매처재고`, type:'number',
      value:row => projectedSellerValue(row, source, 'sellpia_current_stock', `${source}_stock`)
    });
    if (all || view?.showPrice !== false) columns.push(
      {key:`${source}_base_price_projected`, label:`${label} 판매가`, type:'number', value:row => sellerPriceComponent(row, source, 'base')},
      {key:`${source}_option_price_projected`, label:`${label} 옵션가`, type:'number', value:row => sellerPriceComponent(row, source, 'option')},
      {key:`${source}_final_price_projected`, label:`${label} 최종구매가`, type:'number', value:row => sellerPriceComponent(row, source, 'final')}
    );
    if (all || (view?.showDiscount ?? view?.showPrice ?? true)) {
      const discountColumn = {key:`${source}_discount_information`, label:`${label} 할인정보`, value:row => sellerDiscountInformation(row, source)};
      const baseIndex = columns.findIndex(column => column.key === `${source}_base_price_projected`);
      if (baseIndex >= 0) columns.splice(baseIndex + 1, 0, discountColumn);
      else columns.push(discountColumn);
    }
    if (all) columns.push(
      {key:`${source}_sale_status`, label:`${label} 판매상태`},
      {key:`${source}_stock`, label:`${label} 원본재고`, type:'number'},
      {key:`${source}_base_price`, label:`${label} 원본 판매가`, type:'number', value:row => sellerPriceComponent(row, source, 'base', false)},
      {key:`${source}_option_price`, label:`${label} 원본 옵션가`, type:'number', value:row => sellerPriceComponent(row, source, 'option', false)},
      {key:`${source}_final_price`, label:`${label} 원본 최종구매가`, type:'number', value:row => sellerPriceComponent(row, source, 'final', false)},
      {key:`${source}_draft_status`, label:`${label} 수정안상태`, value:row => sellerDraftStatus(row, source)},
      {key:`${source}_inventory_at`, label:`${label} 재고기준시각`}
    );
    return columns;
  }

  function operationalColumns(scope, view) {
    const all = scope === 'all';
    const columns = [];
    if (all || view?.showAttributes !== false) columns.push(
      {key:'material', label:'소재', value:row => profileValue(row, 'material')},
      {key:'product_group', label:'상품군', value:row => profileValue(row, 'product_group')},
      {key:'shape', label:'형태', value:row => profileValue(row, 'shape')},
      {key:'tag_summary', label:'태그', value:row => profileValue(row, 'tag_summary')}
    );
    if (all) columns.push({key:'overall_status', label:'전체 연결상태', value:row => STATUS_LABELS[row?.overall_status] || row?.overall_status});
    if (all || view?.showSync !== false) columns.push({key:'updated_at', label:'최근 동기화', value:row => profileValue(row, 'updated_at') || row?.updated_at});
    return columns;
  }

  function buildColumns({scope = 'visible', view = {}, codeListMode = false} = {}) {
    return [
      ...(codeListMode ? codeListColumns() : []),
      ...sellpiaColumns(scope, view),
      ...CHANNELS.flatMap(([source, label]) => sellerColumns(source, label, scope, view)),
      ...operationalColumns(scope, view)
    ];
  }

  function csvCell(value, type = 'text') {
    if (value === null || value === undefined || value === '') return '""';
    if (type === 'number' && Number.isFinite(Number(value))) return String(Number(value));
    let output = text(value).replace(/\r\n|\r|\n/g, ' ');
    if (type === 'code') output = `="${output.replace(/"/g, '""')}"`;
    else if (/^[=+\-@\t\r]/.test(output)) output = `'${output}`;
    return `"${output.replace(/"/g, '""')}"`;
  }

  function valueFor(row, column) {
    return column.value ? column.value(row) : row?.[column.key];
  }

  function serializeHeader(columns, {bom = true} = {}) {
    return `${bom ? '\ufeff' : ''}${columns.map(column => csvCell(column.label)).join(',')}\r\n`;
  }

  function serializeRows(rows, columns) {
    return (rows || []).map(row => columns.map(column => csvCell(valueFor(row, column), column.type)).join(',')).join('\r\n') + ((rows || []).length ? '\r\n' : '');
  }

  function downloadChunks(chunks, filename) {
    const blob = new Blob(chunks, {type:'text/csv;charset=utf-8'});
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    return blob.size;
  }

  global.SystemV3MatrixCsv = Object.freeze({
    buildColumns,
    csvCell,
    serializeHeader,
    serializeRows,
    downloadChunks
  });
})(window);
