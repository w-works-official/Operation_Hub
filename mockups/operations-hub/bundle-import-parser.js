(function (global, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.BundleImportParser = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const REQUIRED_HEADERS = Object.freeze([
    '세트 상품코드-옵션코드',
    '구성품 상품코드-옵션코드',
    '구성수량'
  ]);
  // 2026-09: 역할 선택은 폐기했습니다. 예전 템플릿의 `역할` 열은
  // 업로드 호환을 위해 읽기만 하고, 모든 새 구성은 component로 정규화합니다.
  const LEGACY_HEADERS = Object.freeze(['역할']);
  const MAX_QUANTITY = 2147483647;

  function normalizeText(value) {
    return String(value ?? '').replace(/\uFEFF/g, '').trim();
  }

  function normalizeHeader(value) {
    return normalizeText(value).replace(/\s+/g, ' ');
  }

  function parsePositiveInteger(value) {
    const normalized = normalizeText(value);
    if (!/^[1-9]\d*$/.test(normalized)) return null;
    const quantity = Number(normalized);
    return Number.isSafeInteger(quantity) ? quantity : null;
  }

  function normalizeRole() {
    return 'component';
  }

  function findBundleCycle(rows) {
    const next = new Map();
    (Array.isArray(rows) ? rows : []).forEach(row => {
      const bundleCode = normalizeText(row?.bundleCode);
      const componentCode = normalizeText(row?.componentCode);
      if (!bundleCode || !componentCode || bundleCode === componentCode) return;
      if (!next.has(bundleCode)) next.set(bundleCode, []);
      next.get(bundleCode).push(componentCode);
    });

    const visiting = new Set();
    const visited = new Set();
    const path = [];
    function visit(code) {
      if (visiting.has(code)) {
        const start = path.indexOf(code);
        return [...path.slice(Math.max(0, start)), code];
      }
      if (visited.has(code)) return null;
      visiting.add(code);
      path.push(code);
      for (const child of next.get(code) || []) {
        const cycle = visit(child);
        if (cycle) return cycle;
      }
      path.pop();
      visiting.delete(code);
      visited.add(code);
      return null;
    }

    for (const code of next.keys()) {
      const cycle = visit(code);
      if (cycle) return cycle;
    }
    return null;
  }

  function parseBundleCompositionRows(inputRows, options = {}) {
    const maxRows = Math.max(1, Number(options.maxRows) || 1000);
    const maxCodes = Math.max(1, Number(options.maxCodes) || 500);
    const matrix = Array.isArray(inputRows) ? inputRows : [];
    const errors = [];
    const emptySummary = {
      inputRowCount: 0,
      validRowCount: 0,
      bundleCount: 0,
      componentCount: 0,
      uniqueCodeCount: 0,
      duplicateCount: 0,
      errorCount: 1,
      cycleValidation: 'file-only',
      requiresServerCycleValidation: true
    };
    if (!matrix.length) {
      return {
        valid: false,
        rows: [],
        codes: [],
        errors: ['첫 번째 시트가 비어 있습니다.'],
        duplicateCount: 0,
        summary: emptySummary
      };
    }

    const rawHeaders = Array.isArray(matrix[0]) ? matrix[0] : [];
    const headerIndexes = new Map();
    rawHeaders.forEach((value, columnIndex) => {
      const header = normalizeHeader(value);
      if (!header) return;
      if (headerIndexes.has(header)) {
        errors.push(`1행에 '${header}' 헤더가 중복되어 있습니다.`);
        return;
      }
      headerIndexes.set(header, columnIndex);
    });
    REQUIRED_HEADERS.forEach(header => {
      if (!headerIndexes.has(header)) errors.push(`1행에 필수 헤더 '${header}'가 필요합니다.`);
    });

    const parsedRows = [];
    const rowMap = new Map();
    const codeSet = new Set();
    let duplicateCount = 0;
    let inputRowCount = 0;
    const knownHeaders = [...REQUIRED_HEADERS, ...LEGACY_HEADERS];
    const inspectedColumns = knownHeaders
      .filter(header => headerIndexes.has(header))
      .map(header => headerIndexes.get(header));

    for (let index = 1; index < matrix.length; index += 1) {
      const sourceRow = Array.isArray(matrix[index]) ? matrix[index] : [];
      const hasValue = inspectedColumns.length
        ? inspectedColumns.some(columnIndex => normalizeText(sourceRow[columnIndex]))
        : sourceRow.some(value => normalizeText(value));
      if (!hasValue) continue;
      inputRowCount += 1;

      if (!REQUIRED_HEADERS.every(header => headerIndexes.has(header))) continue;
      const rowNo = index + 1;
      const bundleCode = normalizeText(sourceRow[headerIndexes.get(REQUIRED_HEADERS[0])]);
      const componentCode = normalizeText(sourceRow[headerIndexes.get(REQUIRED_HEADERS[1])]);
      const rawQuantity = sourceRow[headerIndexes.get(REQUIRED_HEADERS[2])];
      const quantityText = normalizeText(rawQuantity);
      const role = 'component';
      const missing = [];
      if (!bundleCode) missing.push(REQUIRED_HEADERS[0]);
      if (!componentCode) missing.push(REQUIRED_HEADERS[1]);
      if (!quantityText) missing.push(REQUIRED_HEADERS[2]);
      if (missing.length) {
        errors.push(`${rowNo}행에 필수 값이 누락되었습니다: ${missing.join(', ')}`);
        continue;
      }

      const quantity = parsePositiveInteger(rawQuantity);
      if (quantity === null || quantity > MAX_QUANTITY) {
        errors.push(`${rowNo}행 구성수량은 1 이상 ${MAX_QUANTITY.toLocaleString('en-US')} 이하의 정수여야 합니다: '${quantityText}'`);
        continue;
      }
      if (bundleCode === componentCode) {
        errors.push(`${rowNo}행은 세트와 구성품에 같은 코드 '${bundleCode}'를 사용할 수 없습니다.`);
        continue;
      }

      const key = `${bundleCode}\u0000${componentCode}`;
      const existing = rowMap.get(key);
      if (existing) {
        if (existing.quantity !== quantity) {
          errors.push(`${rowNo}행의 '${bundleCode} → ${componentCode}' 구성수량 ${quantity}이 ${existing.rowNo}행의 구성수량 ${existing.quantity}과 다릅니다.`);
          continue;
        }
        duplicateCount += 1;
        continue;
      }

      const parsed = {bundleCode, componentCode, quantity, role, rowNo};
      rowMap.set(key, parsed);
      parsedRows.push(parsed);
      codeSet.add(bundleCode);
      codeSet.add(componentCode);
    }

    if (inputRowCount > maxRows) {
      errors.push(`데이터 행은 한 번에 최대 ${maxRows}행까지 등록할 수 있습니다. 현재 ${inputRowCount}행입니다.`);
    }
    if (!parsedRows.length && !errors.length) errors.push('등록할 세트 구성 행이 없습니다.');
    const codes = [...codeSet];
    if (codes.length > maxCodes) {
      errors.push(`고유 코드는 한 번에 최대 ${maxCodes}개까지 등록할 수 있습니다. 현재 ${codes.length}개입니다.`);
    }
    const cycle = findBundleCycle(parsedRows);
    if (cycle) errors.push(`파일 안에 순환 세트 구성이 있습니다: ${cycle.join(' → ')}`);

    const bundleCount = new Set(parsedRows.map(row => row.bundleCode)).size;
    const componentCount = new Set(parsedRows.map(row => row.componentCode)).size;
    const summary = {
      inputRowCount,
      validRowCount: parsedRows.length,
      bundleCount,
      componentCount,
      uniqueCodeCount: codes.length,
      duplicateCount,
      errorCount: errors.length,
      cycleValidation: 'file-only',
      requiresServerCycleValidation: true
    };
    return {valid:errors.length === 0, rows:parsedRows, codes, errors, duplicateCount, summary};
  }

  return {
    REQUIRED_HEADERS,
    LEGACY_HEADERS,
    MAX_QUANTITY,
    normalizeText,
    normalizeHeader,
    parsePositiveInteger,
    normalizeRole,
    findBundleCycle,
    parseBundleCompositionRows
  };
});
