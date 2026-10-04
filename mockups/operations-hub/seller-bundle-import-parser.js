(function (global, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.SellerBundleImportParser = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const HEADER_ALIASES = Object.freeze({
    '판매처': Object.freeze(['판매처', '채널', '판매채널']),
    '판매처 상품코드': Object.freeze(['판매처 상품코드', '상품코드']),
    '판매처 옵션코드': Object.freeze(['판매처 옵션코드', '옵션코드']),
    '구성품 상품코드-옵션코드': Object.freeze(['구성품 상품코드-옵션코드', '구성품 SKU', '구성품SKU']),
    '구성수량': Object.freeze(['구성수량', '수량']),
    '구성유형': Object.freeze(['구성유형', '유형'])
  });
  const REQUIRED_HEADERS = Object.freeze(Object.keys(HEADER_ALIASES));
  const SELLER_ALIASES = Object.freeze({
    smartstore: Object.freeze(['smartstore', 'smart store', '스마트스토어', '스마트 스토어', '스스']),
    makeshop: Object.freeze(['makeshop', 'make shop', '메이크샵']),
    ably: Object.freeze(['ably', '에이블리'])
  });
  const TYPE_ALIASES = Object.freeze({
    one_plus_one: Object.freeze(['1+1', '1＋1', 'one_plus_one', 'one-plus-one', 'one plus one']),
    set: Object.freeze(['set', '세트', '세트상품', 'bundle'])
  });

  function normalizeText(value) {
    return String(value ?? '').replace(/\uFEFF/g, '').trim();
  }

  function normalizeHeader(value) {
    return normalizeText(value).replace(/\s+/g, ' ');
  }

  function normalizedAliasKey(value) {
    return normalizeText(value).toLowerCase().replace(/\s+/g, ' ');
  }

  function resolveAlias(value, aliases) {
    const input = normalizedAliasKey(value);
    for (const [canonical, values] of Object.entries(aliases)) {
      if (values.some(alias => normalizedAliasKey(alias) === input)) return canonical;
    }
    return null;
  }

  function normalizeSeller(value) {
    return resolveAlias(value, SELLER_ALIASES);
  }

  function normalizeCompositionType(value) {
    return resolveAlias(value, TYPE_ALIASES);
  }

  function parsePositiveInteger(value) {
    const normalized = normalizeText(value);
    if (!/^[1-9]\d*$/.test(normalized)) return null;
    const quantity = Number(normalized);
    return Number.isSafeInteger(quantity) ? quantity : null;
  }

  function mapHeaders(rawHeaders, errors) {
    const headerIndexes = new Map();
    (Array.isArray(rawHeaders) ? rawHeaders : []).forEach((value, columnIndex) => {
      const normalized = normalizeHeader(value);
      if (!normalized) return;
      const canonical = REQUIRED_HEADERS.find(header => HEADER_ALIASES[header].some(alias => normalizeHeader(alias) === normalized));
      if (!canonical) return;
      if (headerIndexes.has(canonical)) {
        errors.push(`1행에 '${canonical}'로 해석되는 헤더가 두 개 이상입니다.`);
        return;
      }
      headerIndexes.set(canonical, columnIndex);
    });
    REQUIRED_HEADERS.forEach(header => {
      if (!headerIndexes.has(header)) {
        errors.push(`1행에 필수 헤더 '${header}'가 필요합니다. 허용 별칭: ${HEADER_ALIASES[header].join(' / ')}`);
      }
    });
    return headerIndexes;
  }

  function parseSellerBundleRows(inputRows, options = {}) {
    const maxRows = Math.max(1, Number(options.maxRows) || 1000);
    const maxCodes = Math.max(1, Number(options.maxCodes) || 500);
    const matrix = Array.isArray(inputRows) ? inputRows : [];
    const errors = [];
    if (!matrix.length) {
      return {
        valid:false, rows:[], targets:[], codes:[], errors:['첫 번째 시트가 비어 있습니다.'], duplicateCount:0,
        summary:{inputRowCount:0, validRowCount:0, targetCount:0, componentCodeCount:0, duplicateCount:0, errorCount:1}
      };
    }

    const headerIndexes = mapHeaders(matrix[0], errors);
    const requiredIndexes = [...headerIndexes.values()];
    const parsedRows = [];
    const rowMap = new Map();
    const targetMap = new Map();
    const componentCodes = new Set();
    let inputRowCount = 0;
    let duplicateCount = 0;

    for (let index = 1; index < matrix.length; index += 1) {
      const sourceRow = Array.isArray(matrix[index]) ? matrix[index] : [];
      const hasValue = requiredIndexes.length
        ? requiredIndexes.some(columnIndex => normalizeText(sourceRow[columnIndex]))
        : sourceRow.some(value => normalizeText(value));
      if (!hasValue) continue;
      inputRowCount += 1;
      if (!REQUIRED_HEADERS.every(header => headerIndexes.has(header))) continue;

      const rowNo = index + 1;
      const values = Object.fromEntries(REQUIRED_HEADERS.map(header => [header, normalizeText(sourceRow[headerIndexes.get(header)])]));
      const missing = REQUIRED_HEADERS.filter(header => !values[header]);
      if (missing.length) {
        const optionMissing = missing.includes('판매처 옵션코드');
        errors.push(optionMissing
          ? `${rowNo}행 판매처 옵션코드가 비어 있습니다. 옵션이 없는 상품도 DB에 저장된 정확한 옵션코드를 입력해야 모호한 판매처 대상을 방지할 수 있습니다.`
          : `${rowNo}행에 필수 값이 누락되었습니다: ${missing.join(', ')}`);
        continue;
      }

      const seller = normalizeSeller(values['판매처']);
      if (!seller) {
        errors.push(`${rowNo}행 판매처 '${values['판매처']}'를 해석할 수 없습니다. 허용: 스마트스토어/smartstore, 메이크샵/makeshop, 에이블리/ably`);
        continue;
      }
      const compositionType = normalizeCompositionType(values['구성유형']);
      if (!compositionType) {
        errors.push(`${rowNo}행 구성유형 '${values['구성유형']}'은 1+1 또는 set/세트만 사용할 수 있습니다.`);
        continue;
      }
      const quantity = parsePositiveInteger(values['구성수량']);
      if (quantity === null) {
        errors.push(`${rowNo}행 구성수량은 1 이상의 정수여야 합니다: '${values['구성수량']}'`);
        continue;
      }

      const sellerProductCode = values['판매처 상품코드'];
      const sellerOptionCode = values['판매처 옵션코드'];
      const componentCode = values['구성품 상품코드-옵션코드'];
      const targetKey = `${seller}\u0000${sellerProductCode}\u0000${sellerOptionCode}`;
      const target = targetMap.get(targetKey);
      if (target && target.compositionType !== compositionType) {
        errors.push(`${rowNo}행의 판매처 대상 ${seller}/${sellerProductCode}/${sellerOptionCode}이 ${target.rowNo}행의 ${target.compositionType}과 다른 ${compositionType}으로 지정되어 모호합니다.`);
        continue;
      }
      if (!target) targetMap.set(targetKey, {seller, sellerProductCode, sellerOptionCode, compositionType, rowNo});

      const duplicateKey = `${targetKey}\u0000${componentCode}`;
      const existing = rowMap.get(duplicateKey);
      if (existing) {
        if (existing.quantity !== quantity) {
          errors.push(`${rowNo}행의 중복 구성품 ${componentCode} 수량 ${quantity}이 ${existing.rowNo}행의 수량 ${existing.quantity}과 달라 모호합니다.`);
          continue;
        }
        duplicateCount += 1;
        continue;
      }

      const parsed = {seller, sellerProductCode, sellerOptionCode, componentCode, quantity, compositionType, rowNo};
      rowMap.set(duplicateKey, parsed);
      parsedRows.push(parsed);
      componentCodes.add(componentCode);
    }

    if (inputRowCount > maxRows) errors.push(`판매처 세트 구성은 한 번에 최대 ${maxRows}행까지 등록할 수 있습니다. 현재 ${inputRowCount}행입니다.`);
    const codes = [...componentCodes];
    if (codes.length > maxCodes) errors.push(`고유 구성품 코드는 한 번에 최대 ${maxCodes}개까지 등록할 수 있습니다. 현재 ${codes.length}개입니다.`);
    if (!parsedRows.length && !errors.length) errors.push('등록할 판매처 세트 구성 행이 없습니다.');
    const targets = [...targetMap.values()];
    const summary = {
      inputRowCount,
      validRowCount:parsedRows.length,
      targetCount:targets.length,
      componentCodeCount:codes.length,
      duplicateCount,
      errorCount:errors.length
    };
    return {valid:errors.length === 0, rows:parsedRows, targets, codes, errors, duplicateCount, summary};
  }

  return {
    HEADER_ALIASES,
    REQUIRED_HEADERS,
    SELLER_ALIASES,
    TYPE_ALIASES,
    normalizeText,
    normalizeHeader,
    normalizeSeller,
    normalizeCompositionType,
    parsePositiveInteger,
    parseSellerBundleRows
  };
});
