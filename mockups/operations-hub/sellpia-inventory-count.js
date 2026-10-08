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
        raw_available_stock:rawAvailable,
        raw_stock:rawStock,
        status:errors.length ? 'invalid' : 'valid',
        reason:errors.join(' · ')
      });
    }
    return {file:{name:fileName, rowCount:records.length, columnCount:(rows[0] || []).length}, records};
  }

  function mergeRecords(parts) {
    const records = (parts || []).flatMap(part => part.records || []);
    const groupsBySku = new Map();
    const uniqueRows = [];
    const tupleValue = (row, field, rawField) => row.status === 'valid'
      ? row[field]
      : {invalid:clean(row[rawField])};
    for (const row of records) {
      const sku = clean(row.sellpia_sku_code);
      if (!sku) { uniqueRows.push(row); continue; }
      if (!groupsBySku.has(sku)) groupsBySku.set(sku, []);
      groupsBySku.get(sku).push(row);
    }
    const rows = [...uniqueRows];
    let duplicateSameCount = 0;
    let duplicateConflictCount = 0;
    for (const [sku, group] of groupsBySku) {
      if (group.length === 1) { rows.push(group[0]); continue; }
      const values = new Set(group.map(row => JSON.stringify([
        tupleValue(row, 'stock', 'raw_stock'), tupleValue(row, 'available_stock', 'raw_available_stock')
      ])));
      const duplicateKind = values.size > 1 ? 'conflict' : 'same';
      if (duplicateKind === 'conflict') duplicateConflictCount += 1;
      else duplicateSameCount += 1;
      const detail = duplicateKind === 'conflict' ? '서로 다른 재고값' : '동일한 재고값';
      rows.push({...group[0], status:'duplicate_sku', duplicate_kind:duplicateKind,
        reason:`동일 SKU가 ${detail}으로 ${group.length}회 등장 · SKU 전체 차단`, occurrences:group});
    }
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

  function blockedInventoryRow(row, {status, reason} = {}) {
    return {
      stage:'inventory_input', source:'sellpia', file_name:row.file_name || '', file_index:row.file_index ?? null,
      source_row_no:row.source_row_no ?? null, sellpia_sku_code:clean(row.sellpia_sku_code),
      stock:row.stock ?? null, available_stock:row.available_stock ?? null,
      raw_stock:row.raw_stock ?? '', raw_available_stock:row.raw_available_stock ?? '',
      status:status || row.status || 'blocked', reason:reason || row.reason || '재고 행이 차단되었습니다.',
      product_code:row.product_code ?? '', option_code:row.option_code ?? '', solution_code:row.solution_code ?? ''
    };
  }

  const BLOCKED_WORKBOOK_HEADERS = Object.freeze([
    '단계','판매처','상태','재고 정책','사유','SKU','원본 파일','원본 행','상품코드','옵션 번호','솔루션사 고유코드',
    '재고','가용재고','원본 재고 입력값','원본 가용재고 입력값'
  ]);

  function buildBlockedWorkbook(rows, {XLSX} = {}) {
    if (!XLSX?.utils?.aoa_to_sheet || !XLSX?.utils?.book_new || !XLSX?.utils?.book_append_sheet || !XLSX?.write) {
      throw new Error('차단 목록 XLSX 생성 모듈을 불러오지 못했습니다.');
    }
    const blocked = Array.from(rows || []);
    const numericCell = value => value === null || value === undefined || clean(value) === '' || !Number.isSafeInteger(Number(value)) ? '' : Number(value);
    const stageLabels={inventory_input:'재고조사 입력',seller_export:'판매처 파일'};
    const sourceLabels={sellpia:'셀피아',smartstore:'스마트스토어',makeshop:'메이크샵',ably:'에이블리'};
    const statusLabels={duplicate_sku:'중복 SKU',invalid:'재고값 오류',unknown_sku:'미확인 SKU',inventory_input_blocked:'입력 SKU 차단',
      snapshot_sku_missing:'최신 재고 SKU 없음',invalid_quantity:'수량 확인 필요',review:'검토 필요',conflict:'충돌',excluded:'자동 반영 제외',
      inactive:'비활성',suppressed:'억제 중',verified:'연결 확인됨'};
    const policyLabels={shared:'Sellpia 재고 공유',individual:'개별 수량',excluded:'재고 자동 반영 제외',review:'재고 정책 검토'};
    const values = [BLOCKED_WORKBOOK_HEADERS, ...blocked.map(row => [
      stageLabels[row.stage] || String(row.stage ?? ''), sourceLabels[row.source] || String(row.source ?? ''), statusLabels[row.status] || String(row.status ?? ''),
      policyLabels[row.stock_policy] || String(row.stock_policy ?? ''), String(row.reason ?? ''),
      String(row.sellpia_sku_code ?? ''), String(row.file_name ?? ''),
      numericCell(row.source_row_no),
      String(row.product_code ?? ''), String(row.option_code ?? ''), String(row.solution_code ?? row.code ?? ''),
      numericCell(row.stock), numericCell(row.available_stock),
      row.raw_stock == null ? '' : String(row.raw_stock), row.raw_available_stock == null ? '' : String(row.raw_available_stock)
    ])];
    const sheet = XLSX.utils.aoa_to_sheet(values);
    sheet['!cols']=[{wch:20},{wch:16},{wch:20},{wch:22},{wch:60},{wch:20},{wch:35},{wch:12},{wch:20},{wch:20},{wch:25},{wch:12},{wch:12},{wch:20},{wch:20}];
    sheet['!autofilter']={ref:`A1:O${Math.max(1,blocked.length+1)}`};
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, sheet, '차단목록');
    const output = XLSX.write(book, {bookType:'xlsx', type:'array'});
    const blob = new Blob([output], {type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
    return {blob, fileName:'재고_차단목록.xlsx', rowCount:blocked.length};
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
      const rows = XLSX.utils.sheet_to_json(worksheet, {header:1, raw:true, defval:null, blankrows:true});
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
    const blockedRows = [];
    for (const row of parsed?.rows || []) {
      if (row.status === 'duplicate_sku') {
        previewRows.push({...row, preview_status:'duplicate_sku', preview_label:'중복 SKU 전체 차단'});
        for (const occurrence of row.occurrences || [row]) blockedRows.push(blockedInventoryRow(occurrence,{status:'duplicate_sku',reason:row.reason}));
        continue;
      }
      if (row.status === 'invalid') {
        const preview={...row, preview_status:'invalid', preview_label:row.reason || '오류 행'};
        previewRows.push(preview);blockedRows.push(blockedInventoryRow(row,{status:'invalid',reason:row.reason}));
        continue;
      }
      const current = currentBySku.get(row.sellpia_sku_code);
      if (!current) {
        const preview={...row, preview_status:'unknown_sku', preview_label:'미확인 SKU', old_stock:null, old_available_stock:null};
        previewRows.push(preview);blockedRows.push(blockedInventoryRow(row,{status:'unknown_sku',reason:'Sellpia 재고 snapshot에서 SKU를 찾지 못했습니다.'}));
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
    const blockedSkus=[...new Set(blockedRows.map(row=>clean(row.sellpia_sku_code)).filter(Boolean))];
    const summary = {
      fileCount:(parsed?.files || []).length,
      readRowCount:Number(parsed?.readRowCount || 0),
      validSkuCount:previewRows.filter(row => ['changed','unchanged'].includes(row.preview_status)).length,
      changedSkuCount:changedRows.length,
      unchangedSkuCount:previewRows.filter(row => row.preview_status === 'unchanged').length,
      unknownSkuCount:previewRows.filter(row => row.preview_status === 'unknown_sku').length,
      duplicateSameCount:Number(parsed?.duplicateSameCount || 0),
      duplicateConflictCount:Number(parsed?.duplicateConflictCount || 0),
      errorRowCount:Number(parsed?.errorRowCount ?? previewRows.filter(row => row.preview_status === 'invalid').length),
      blockedSkuCount:blockedSkus.length,
      blockedRowCount:blockedRows.length
    };
    const logicalRecords=(parsed?.records || []).map(row=>[
      row.file_name,row.file_index,row.source_row_no,row.sellpia_sku_code,row.stock,row.available_stock,
      row.raw_stock,row.raw_available_stock,row.status,row.reason
    ]);
    const fingerprint = stableFingerprint([baseSnapshotId,parsed?.files||[],logicalRecords,
      blockedRows.map(row=>[row.stage,row.source,row.file_name,row.source_row_no,row.sellpia_sku_code,row.stock,row.available_stock,row.raw_stock,row.raw_available_stock,row.status,row.reason]),
      changedRows.map(row => [row.sellpia_sku_code, row.stock, row.available_stock]),summary]);
    return {baseSnapshotId, files:parsed.files || [], rows:previewRows, changedRows, blockedRows, blockedSkus, summary, fingerprint};
  }

  function resolveExportStock(row, stockSource) {
    if (!['stock', 'available_stock'].includes(stockSource)) throw new Error('재고 내보내기 기준을 확인해주세요.');
    const raw = stockSource === 'stock' ? row?.sellpia_current_stock ?? row?.stock : row?.sellpia_available_stock ?? row?.available_stock;
    if (raw === null || raw === undefined || clean(raw) === '' || !Number.isSafeInteger(Number(raw))) return null;
    const value = Number(raw);
    return stockSource === 'available_stock' ? Math.max(0, value) : value;
  }

  return {REQUIRED_HEADERS, BLOCKED_WORKBOOK_HEADERS, clean, headerMap, integerValue, parseSheetRows, mergeRecords, parseFiles, buildPreview, buildBlockedWorkbook, resolveExportStock, stableFingerprint};
});
