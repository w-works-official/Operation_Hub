(function (global) {
  'use strict';

  const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0;
  const invalid = detail => new Error(`직접 입력 SKU 조회 응답이 올바르지 않습니다: ${detail}`);

  function parse(raw) {
    if (typeof raw !== 'string') throw new Error('셀피아 SKU를 문자열로 입력해주세요.');
    const codes = [...new Set(raw.split(/[,\s]+/u).filter(Boolean))];
    if (!codes.length) throw new Error('셀피아 SKU를 하나 이상 입력해주세요.');
    return codes.map((code, index) => ({row_no:index + 1, source:'sellpia', code}));
  }

  async function resolve(raw, {resolveEntries} = {}) {
    const inputs = parse(raw);
    if (typeof resolveEntries !== 'function') throw new Error('셀피아 SKU 조회 기능을 불러오지 못했습니다.');
    const byRow = new Map(inputs.map(input => [input.row_no, input]));
    const grouped = new Map();
    // The injected service owns transport/chunking. Keep our expected identities
    // separate from its arguments, including across the asynchronous boundary.
    const response = await resolveEntries(inputs.map(input => ({...input})));
    if (!Array.isArray(response)) throw invalid('결과 목록이 필요합니다.');

    for (const row of response) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) throw invalid('결과 행을 읽을 수 없습니다.');
      const input = Number.isSafeInteger(row.input_row) ? byRow.get(row.input_row) : null;
      if (!input || row.source_channel !== 'sellpia' || row.input_code !== input.code) throw invalid('입력 코드 또는 판매처가 다릅니다.');
      if (row.product_code !== null || row.option_code !== null) throw invalid('셀피아 코드에 판매처 상품 정보가 포함되어 있습니다.');
      if (!['matched', 'not_found'].includes(row.match_status)) throw invalid('지원하지 않는 조회 상태입니다.');

      const scope = row.match_scope, status = row.match_status, sku = row.sellpia_sku_code;
      if (status === 'not_found') {
        if (scope !== 'none' || sku !== null) throw invalid('미발견 코드의 범위 또는 SKU가 다릅니다.');
      } else {
        if (typeof sku !== 'string' || !sku || sku !== sku.trim()) throw invalid('완전한 SKU 문자열이 필요합니다.');
        if (scope === 'sku') {
          if (sku !== input.code) throw invalid('정확한 SKU가 입력 코드와 다릅니다.');
        } else if (scope === 'prefix') {
          const prefix = `${input.code}-`;
          if (input.code.includes('-') || !sku.startsWith(prefix) || sku.length <= prefix.length) throw invalid('SKU 접두어 경계가 다릅니다.');
        } else throw invalid('지원하지 않는 SKU 범위입니다.');
      }

      let entry = grouped.get(input.row_no);
      if (!entry) {
        entry = {inputCode:input.code, matchScope:scope, status, skus:new Set()};
        grouped.set(input.row_no, entry);
      } else if (entry.matchScope !== scope || entry.status !== status) throw invalid('같은 입력의 조회 상태 또는 범위가 서로 다릅니다.');
      if (status === 'matched') entry.skus.add(sku);
    }

    const entries = inputs.map(input => {
      const entry = grouped.get(input.row_no);
      if (!entry) throw invalid(`${input.code}의 조회 결과가 누락되었습니다.`);
      return {...entry, skus:[...entry.skus].sort(compare)};
    });
    const skus = [...new Set(entries.flatMap(entry => entry.skus))].sort(compare);
    const resolved = new Set(skus);
    for (const entry of entries) {
      if (entry.status === 'not_found' && resolved.has(entry.inputCode)
          || entry.matchScope === 'prefix' && resolved.has(entry.inputCode)) throw invalid('정확한 SKU의 존재 여부가 입력 간에 다릅니다.');
    }
    const unresolved = entries.filter(entry => entry.status === 'not_found').map(entry => ({inputCode:entry.inputCode, status:entry.status}));
    // Input order remains available for display; the proof represents the same
    // resolved scope regardless of response order, separators or repeated input.
    const key = JSON.stringify({contract_version:1, source:'sellpia', entries:[...entries].sort((left, right) => compare(left.inputCode, right.inputCode))});
    return {inputs:inputs.map(input => input.code), skus, unresolved, entries, key};
  }

  global.HubManualSkuScope = Object.freeze({parse, resolve});
})(typeof globalThis !== 'undefined' ? globalThis : this);
