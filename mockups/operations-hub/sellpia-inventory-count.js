(function (global, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.SystemV3SellpiaInventoryCount = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const REQUIRED_HEADERS = Object.freeze(['상품코드', '가용재고', '재고']);
  const POSTGRES_INTEGER_MIN = -2147483648;
  const POSTGRES_INTEGER_MAX = 2147483647;

  function clean(value) {
    return String(value ?? '').replace(/^\uFEFF/, '').trim();
  }

  function headerMap(header, fileName = '선택한 파일') {
    const map = new Map();
    (header || []).forEach((value, index) => {
      const name = clean(value);
      if (!name) return;
      if (map.has(name)) throw new Error(`${fileName}: 헤더 \`${name}\`가 중복되어 있습니다.`);
      map.set(name, index);
    });
    const missing = REQUIRED_HEADERS.filter(name => !map.has(name));
    if (missing.length) throw new Error(`${fileName}: 필수 컬럼 \`${missing[0]}\`가 없습니다.`);
    return map;
  }

  function integerValue(value) {
    if (value === null || value === undefined || clean(value) === '') return {valid:false, reason:'필수값 누락'};
    if (typeof value === 'number') {
      if (!Number.isSafeInteger(value)) return {valid:false, reason:'정수가 아님'};
      if (value < POSTGRES_INTEGER_MIN || value > POSTGRES_INTEGER_MAX) return {valid:false, reason:'DB 정수 범위 초과'};
      return {valid:true, value};
    }
    const text = clean(value);
    if (!/^-?\d+$/.test(text)) return {valid:false, reason:Number.isFinite(Number(text)) ? '정수가 아님' : '잘못된 숫자'};
    const number = Number(text);
    if (!Number.isSafeInteger(number)) return {valid:false, reason:'안전한 정수 범위 초과'};
    if (number < POSTGRES_INTEGER_MIN || number > POSTGRES_INTEGER_MAX) return {valid:false, reason:'DB 정수 범위 초과'};
    return {valid:true, value:number};
  }

  function parseSheetRows(rows, {fileName = '선택한 파일', fileIndex = 0} = {}) {
    if (!Array.isArray(rows) || !rows.length) throw new Error(`${fileName}: 첫 시트에 데이터가 없습니다.`);
    const columns = headerMap(rows[0], fileName);
    const records = [];
    for (let index = 1; index < rows.length; index += 1) {
      const row = rows[index] || [];
      const rawSku = row[columns.get('상품코드')];
      const rawAvailable = row[columns.get('가용재고')];
      const rawStock = row[columns.get('재고')];
      if ([rawSku, rawAvailable, rawStock].every(value => value === null || value === undefined || clean(value) === '')) continue;
      const sku = clean(rawSku);
      const available = integerValue(rawAvailable);
      const stock = integerValue(rawStock);
      const errors = [];
      if (!sku) errors.push('상품코드 필수값 누락');
      if (!available.valid) errors.push(`가용재고 ${available.reason}`);
      if (!stock.valid) errors.push(`재고 ${stock.reason}`);
      records.push({
        file_name:fileName,
        file_index:fileIndex,
        source_row_no:index + 1,
        sellpia_sku_code:sku,
        available_stock:available.valid ? available.value : null,
        stock:stock.valid ? stock.value : null,
        status:errors.length ? 'invalid' : 'valid',
        reason:errors.join(' · ')
      });
    }
    return {file:{name:fileName, rowCount:records.length, columnCount:(rows[0] || []).length}, records};
  }

  function mergeRecords(parts) {
    const records = (parts || []).flatMap(part => part.records || []);
    const validBySku = new Map();
    for (const row of records.filter(item => item.status === 'valid')) {
      if (!validBySku.has(row.sellpia_sku_code)) validBySku.set(row.sellpia_sku_code, []);
      validBySku.get(row.sellpia_sku_code).push(row);
    }
    const rows = [];
    let duplicateSameCount = 0;
    let duplicateConflictCount = 0;
    for (const [sku, group] of validBySku) {
      const values = new Set(group.map(row => JSON.stringify([row.stock, row.available_stock])));
      if (values.size > 1) {
        duplicateConflictCount += 1;
        rows.push({...group[0], status:'duplicate_conflict', reason:`동일 상품코드가 서로 다른 재고값으로 ${group.length}회 등장`, occurrences:group});
        continue;
      }
      duplicateSameCount += Math.max(0, group.length - 1);
      rows.push({...group[0], status:'valid', reason:group.length > 1 ? `동일값 ${group.length}회 · 중복 제거` : '', occurrences:group});
    }
    rows.push(...records.filter(item => item.status === 'invalid'));
    rows.sort((left, right) => left.file_index - right.file_index || left.source_row_no - right.source_row_no || left.sellpia_sku_code.localeCompare(right.sellpia_sku_code));
    return {
      files:(parts || []).map(part => part.file),
      records,
      rows,
      readRowCount:records.length,
      duplicateSameCount,
      duplicateConflictCount,
      errorRowCount:records.filter(row => row.status === 'invalid').length
    };
  }

  async function parseFiles(files, {XLSX} = {}) {
    const selected = Array.from(files || []);
    if (!selected.length) throw new Error('재고조사 결과 파일을 1개 이상 선택해주세요.');
    if (!XLSX?.read || !XLSX?.utils?.sheet_to_json) throw new Error('XLSX 모듈을 불러오지 못했습니다.');
    const parts = [];
    for (let index = 0; index < selected.length; index += 1) {
      const file = selected[index];
      const workbook = XLSX.read(await file.arrayBuffer(), {type:'array', raw:true, cellDates:false});
      const worksheet = workbook.Sheets[workbook.SheetNames[0]];
      if (!worksheet?.['!ref']) throw new Error(`${file.name}: 첫 시트에 데이터가 없습니다.`);
      const rows = XLSX.utils.sheet_to_json(worksheet, {header:1, raw:true, defval:null, blankrows:false});
      parts.push(parseSheetRows(rows, {fileName:file.name, fileIndex:index}));
    }
    return mergeRecords(parts);
  }

  function stableFingerprint(value) {
    const text = JSON.stringify(value);
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) hash = Math.imul(hash ^ text.charCodeAt(index), 16777619);
    return (hash >>> 0).toString(16).padStart(8, '0');
  }

  function buildPreview(parsed, currentRows, {baseSnapshotId = ''} = {}) {
    const currentBySku = new Map((currentRows || []).map(row => [clean(row.sellpia_sku_code), row]));
    const previewRows = [];
    const changedRows = [];
    for (const row of parsed?.rows || []) {
      if (row.status === 'invalid') {
        previewRows.push({...row, preview_status:'invalid', preview_label:row.reason || '오류 행'});
        continue;
      }
      if (row.status === 'duplicate_conflict') {
        previewRows.push({...row, preview_status:'duplicate_conflict', preview_label:'중복 충돌'});
        continue;
      }
      const current = currentBySku.get(row.sellpia_sku_code);
      if (!current) {
        previewRows.push({...row, preview_status:'unknown_sku', preview_label:'미확인 SKU', old_stock:null, old_available_stock:null});
        continue;
      }
      const oldStock = current.stock;
      const oldAvailable = current.available_stock;
      const changed = Number(oldStock) !== row.stock || Number(oldAvailable) !== row.available_stock;
      const next = {...row, old_stock:oldStock, old_available_stock:oldAvailable, preview_status:changed ? 'changed' : 'unchanged', preview_label:changed ? '변경' : '동일'};
      previewRows.push(next);
      if (changed) changedRows.push({
        sellpia_sku_code:row.sellpia_sku_code,
        stock:row.stock,
        available_stock:row.available_stock,
        source_row_no:row.source_row_no,
        raw_payload:{inventory_count_source_file:row.file_name, inventory_count_source_row:row.source_row_no}
      });
    }
    const summary = {
      fileCount:(parsed?.files || []).length,
      readRowCount:Number(parsed?.readRowCount || 0),
      validSkuCount:previewRows.filter(row => ['changed','unchanged'].includes(row.preview_status)).length,
      changedSkuCount:changedRows.length,
      unchangedSkuCount:previewRows.filter(row => row.preview_status === 'unchanged').length,
      unknownSkuCount:previewRows.filter(row => row.preview_status === 'unknown_sku').length,
      duplicateSameCount:Number(parsed?.duplicateSameCount || 0),
      duplicateConflictCount:previewRows.filter(row => row.preview_status === 'duplicate_conflict').length,
      errorRowCount:previewRows.filter(row => row.preview_status === 'invalid').length
    };
    const fingerprint = stableFingerprint([baseSnapshotId, changedRows.map(row => [row.sellpia_sku_code, row.stock, row.available_stock]), summary]);
    return {baseSnapshotId, files:parsed.files || [], rows:previewRows, changedRows, summary, fingerprint};
  }

  function resolveExportStock(row, stockSource) {
    if (!['stock', 'available_stock'].includes(stockSource)) throw new Error('재고 내보내기 기준을 확인해주세요.');
    const raw = stockSource === 'stock' ? row?.sellpia_current_stock ?? row?.stock : row?.sellpia_available_stock ?? row?.available_stock;
    if (raw === null || raw === undefined || clean(raw) === '' || !Number.isSafeInteger(Number(raw))) return null;
    const value = Number(raw);
    return stockSource === 'available_stock' ? Math.max(0, value) : value;
  }

  return {REQUIRED_HEADERS, clean, headerMap, integerValue, parseSheetRows, mergeRecords, parseFiles, buildPreview, resolveExportStock, stableFingerprint};
});
