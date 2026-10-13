(function (global, factory) {
  const api = factory(global);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.SystemV3SellpiaSyncContract = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (global) {
  'use strict';

  const FULL_FIELDS = Object.freeze({inventory:true, price:true, basePrice:true, purchasePrice:true, basic:true, status:true});
  const clean = value => String(value ?? '').trim();
  const positiveInteger = value => Number.isSafeInteger(value) && value > 0;
  const hashPattern = /^[0-9a-f]{64}$/i;
  const requestPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const MAX_FILE_BYTES = 25 * 1024 * 1024, MAX_TOTAL_BYTES = 60 * 1024 * 1024;

  function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
    return value;
  }
  function copyBytes(value) {
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
    if (Object.prototype.toString.call(value) === '[object ArrayBuffer]') return new Uint8Array(value).slice();
    throw new Error('원본 파일의 bytes를 읽지 못했습니다.');
  }
  async function digest(bytes, options) {
    let hash;
    if (typeof options.sha256 === 'function') hash = await options.sha256(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    else {
      const crypto = options.crypto || global.crypto;
      if (!crypto?.subtle?.digest) throw new Error('SHA-256 검증 기능을 사용할 수 없습니다.');
      const result = await crypto.subtle.digest('SHA-256', bytes);
      hash = [...new Uint8Array(result)].map(value => value.toString(16).padStart(2, '0')).join('');
    }
    if (typeof hash !== 'string' || !hashPattern.test(hash)) throw new Error('SHA-256 검증 결과가 올바르지 않습니다.');
    return hash.toLowerCase();
  }
  function sourceParser(options) {
    if (options.parser?.parseSellpiaFiles) return options.parser;
    if (global.SystemV3SellpiaSourceParser?.parseSellpiaFiles) return global.SystemV3SellpiaSourceParser;
    if (typeof require === 'function') return require('./sellpia-source-parser.js');
    throw new Error('기존 셀피아 원본 파서를 불러오지 못했습니다.');
  }
  function fieldPolicy(mode, supplied, errors) {
    if (supplied !== undefined && (!supplied || typeof supplied !== 'object' || Array.isArray(supplied))) {
      errors.push('선택 필드 정책이 올바르지 않습니다.');
      return {...FULL_FIELDS};
    }
    if (supplied) for (const key of Object.keys(supplied)) {
      if (!Object.hasOwn(FULL_FIELDS, key) || typeof supplied[key] !== 'boolean') errors.push(`선택 필드 ${key}를 확인해주세요.`);
    }
    if (mode === 'full') {
      if (supplied && Object.keys(FULL_FIELDS).some(key => supplied[key] !== true)) errors.push('전체 원본 동기화는 재고·판매가·매입가·기본정보·상태를 모두 갱신해야 합니다.');
      return {...FULL_FIELDS};
    }
    if (supplied === undefined) errors.push('부분 갱신의 선택 필드 정책을 명시해주세요.');
    const fields = Object.fromEntries(Object.keys(FULL_FIELDS).map(key => [key, supplied?.[key] === true]));
    // price is the legacy alias of the same Sellpia sale/base-price source.
    fields.price=fields.basePrice=fields.price||fields.basePrice;
    if (!Object.values(fields).some(Boolean)) errors.push('부분 갱신 필드를 하나 이상 선택해주세요.');
    return fields;
  }

  // This contract only reads files and validates a collection proof. It never
  // creates an upload intent, stores rows, approves a job, or applies a snapshot.
  async function prepare(files, options = {}, onProgress) {
    const errors = [], selected = Array.from(files || []), mode = options.mode ?? 'full';
    const fields = fieldPolicy(mode, options.fields, errors);
    let parsed = null, sourceFingerprint = null;
    const filesManifest = [];
    const baselineSnapshotId = options.baselineSnapshotId == null ? null : clean(options.baselineSnapshotId);
    const baselineRowCount = options.baselineRowCount == null ? null : options.baselineRowCount;
    let requestId = options.requestId;
    if (!requestId) requestId = (options.crypto || global.crypto)?.randomUUID?.();
    if (typeof requestId !== 'string' || !requestPattern.test(requestId)) errors.push('유효한 동기화 requestId가 필요합니다.');
    if (!['full','patch'].includes(mode)) errors.push('셀피아 동기화 mode는 full 또는 patch여야 합니다.');
    if (mode === 'full' && selected.length !== 3) errors.push('전체 원본 동기화는 파일 3개가 모두 필요합니다.');
    if (mode === 'patch' && (selected.length < 1 || selected.length > 3)) errors.push('부분 갱신은 파일 1~3개가 필요합니다.');
    if (baselineRowCount !== null && (!Number.isSafeInteger(baselineRowCount) || baselineRowCount < 0)) errors.push('기준 원본 행 수를 확인해주세요.');
    if (baselineSnapshotId !== null && (typeof options.baselineSnapshotId !== 'string' || !requestPattern.test(baselineSnapshotId))) errors.push('기준 snapshot UUID를 확인해주세요.');
    const ratio = options.rowDropReviewRatio ?? 0.2;
    if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1) errors.push('행 수 급감 검토 기준은 0~1 사이 숫자여야 합니다.');
    if (selected.some(file => file?.size > MAX_FILE_BYTES) || selected.reduce((sum,file) => sum + Number(file?.size || 0),0) > MAX_TOTAL_BYTES) errors.push('셀피아 원본은 파일당 25 MiB, 전체 60 MiB 이하여야 합니다.');

    const manifest = options.manifest;
    const proofValid = manifest && typeof manifest === 'object' && !Array.isArray(manifest);
    const expectedRowCount = proofValid ? manifest.expectedRowCount : null;
    if (!proofValid) errors.push('공식 내려받기의 독립적인 수집 manifest가 필요합니다.');
    else {
      if (manifest.source !== 'sellpia' || manifest.collectionMode !== 'official_download' || manifest.mode !== mode) errors.push('셀피아 공식 내려받기 scope 증명이 일치하지 않습니다.');
      if (!positiveInteger(expectedRowCount)) errors.push('수집 화면에서 확인한 전체 행 수가 필요합니다.');
      if (mode === 'full' && (manifest.includeAll !== true || !Array.isArray(manifest.filters) || manifest.filters.length !== 0)) errors.push('전체 원본은 전체 포함·필터 없음의 수집 증명이 필요합니다.');
      if (!Array.isArray(manifest.files) || manifest.files.length !== selected.length) errors.push('수집 manifest의 파일 수가 일치하지 않습니다.');
    }

    const snapshotFiles = [], seenNames = new Set();
    if (!errors.length) {
      for (let index = 0; index < selected.length; index += 1) {
        const file = selected[index], declared = manifest.files[index];
        const name = file?.name;
        if (typeof name !== 'string' || !name || /[\\/\u0000-\u001f]/.test(name) || seenNames.has(name)) {
          errors.push(`${index + 1}번 원본 파일 이름이 올바르지 않거나 중복됩니다.`); continue;
        }
        seenNames.add(name);
        if (!declared || declared.ordinal !== index + 1 || declared.name !== name || !positiveInteger(declared.size) || declared.size > MAX_FILE_BYTES || typeof declared.sha256 !== 'string' || !hashPattern.test(declared.sha256)) {
          errors.push(`${name}: 파일 ordinal·이름·크기·SHA-256 manifest를 확인해주세요.`); continue;
        }
        try {
          const bytes = copyBytes(await file.arrayBuffer());
          if (bytes.byteLength !== declared.size || file.size !== declared.size) throw new Error('원본 bytes 크기가 수집 manifest와 다릅니다.');
          const hash = await digest(bytes, options);
          if (hash !== declared.sha256.toLowerCase()) throw new Error('원본 SHA-256이 수집 manifest와 다릅니다.');
          filesManifest.push({ordinal:index + 1, name, size:bytes.byteLength, sha256:hash, mime_type:file.type || 'application/octet-stream'});
          // Parsing consumes the exact bytes that were hashed, even if the
          // caller's original file object changes while this async work runs.
          snapshotFiles.push({name, size:bytes.byteLength, type:file.type || '', arrayBuffer:async() => bytes.slice().buffer});
          onProgress?.({percent:Math.round(((index + 1) / selected.length) * 20), title:'수집 원본 검증 중', detail:`${index + 1}/${selected.length} 파일 크기·SHA-256 검증 완료`});
        } catch (error) { errors.push(`${name}: ${error?.message || '원본 파일 검증에 실패했습니다.'}`); }
      }
    }
    if (!errors.length) {
      try {
        parsed = await sourceParser(options).parseSellpiaFiles(snapshotFiles, {mode, XLSX:options.XLSX, strictNumeric:true}, onProgress);
        if (!parsed?.valid) errors.push(...(parsed?.errors?.length ? parsed.errors : ['셀피아 원본 사전검사에 실패했습니다.']));
        else if (parsed.rowCount !== expectedRowCount || parsed.rows?.length !== expectedRowCount) errors.push('수집 화면의 전체 행 수와 원본의 실제 행 수가 다릅니다.');
        if (parsed?.valid) for (let index = 0; index < filesManifest.length; index += 1) {
          const meta = parsed.files?.[index];
          if (!meta || meta.name !== filesManifest[index].name) { errors.push('파서의 파일별 결과가 수집 manifest와 다릅니다.'); break; }
          Object.assign(filesManifest[index], {encoding:meta.encoding, columnCount:meta.columnCount, rowCount:meta.rowCount, minRowNo:meta.minRowNo, maxRowNo:meta.maxRowNo});
        }
      } catch (error) { errors.push(error?.message || '셀피아 원본 사전검사에 실패했습니다.'); }
    }
    const rowCount = parsed?.valid ? parsed.rowCount : 0;
    const reviewRequired = mode === 'full' && baselineRowCount > 0 && Number.isFinite(ratio) && ratio >= 0 && ratio <= 1 && rowCount < baselineRowCount * (1 - ratio);
    const summary = {
      source:'sellpia', mode, fileCount:filesManifest.length, rowCount, expectedRowCount,
      baselineRowCount, deltaRowCount:baselineRowCount === null ? null : rowCount - baselineRowCount,
      fieldPolicy:mode === 'full' ? 'sellpia-full-source-v1' : 'sellpia-selected-fields-v1',
      strictNumeric:true, productionApply:false, reviewRequired,
      reviewReasons:reviewRequired ? ['source_row_count_drop'] : []
    };
    if (!errors.length) {
      try {
        const body = JSON.stringify(canonical({source:'sellpia', mode, fields, baselineSnapshotId, expectedRowCount, files:filesManifest}));
        const Encoder = options.TextEncoder || global.TextEncoder;
        if (typeof Encoder !== 'function') throw new Error('원본 fingerprint 인코더를 사용할 수 없습니다.');
        sourceFingerprint = await digest(new Encoder().encode(body), options);
      } catch (error) { errors.push(error?.message || '원본 fingerprint를 생성하지 못했습니다.'); }
    }
    return {valid:errors.length === 0, errors, parsed, rowCount, fields, mode, filesManifest, requestId:requestId || null, baselineSnapshotId, sourceFingerprint, summary};
  }
  const COMPARISON_FIELDS = Object.freeze({
    inventory:[['stock',true],['available_stock',true],['integrated_available_stock',true],['safety_stock',true]],
    price:[['raw_payload.base_price',true,'raw_payload.sell_price'],['raw_payload.sell_price',true,'raw_payload.base_price']],
    purchasePrice:[['purchase_price',true,'raw_payload.purchase_price'],['raw_payload.purchase_price',true,'purchase_price'],['raw_payload.commission'],['raw_payload.purchase_vat']],
    basic:[['sellpia_product_code'],['sellpia_product_name'],['sellpia_option_name'],['own_sku'],
      ['supplier_code'],['supplier_name'],['supplier_group'],['supplier_address'],['supplier_market_name'],['supplier_phone'],
      ['purchase_product_name'],['purchase_option_name'],['order_unit',true,'raw_payload.order_unit'],['minimum_order_unit',true,'raw_payload.minimum_order_unit']],
    status:[['raw_payload.sale_status']]
  });
  function pathValue(row, path) {
    const keys = path.split('.');
    let value = row;
    for (const key of keys) {
      if (!value || typeof value !== 'object' || !Object.hasOwn(value,key)) return {known:false};
      value = value[key];
    }
    return value === undefined ? {known:false} : {known:true,value};
  }
  function comparisonValue(row, [path, numeric, fallback]) {
    let result = pathValue(row,path);
    if (!result.known && fallback) result = pathValue(row,fallback);
    if (!result.known) return result;
    const value = result.value;
    if (value === null) return {known:true,value:null};
    if (!numeric) return typeof value === 'string' ? {known:true,value:clean(value) || null} : {known:false};
    if (typeof value !== 'number' && typeof value !== 'string') return {known:false};
    const text = typeof value === 'string' ? value.trim() : '';
    if (typeof value === 'string' && !/^[+-]?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(text)) return {known:false};
    const parsed = typeof value === 'number' ? value : Number(text.replace(/,/g,''));
    return Number.isFinite(parsed) && Math.abs(parsed) <= Number.MAX_SAFE_INTEGER ? {known:true,value:parsed} : {known:false};
  }

  // Only source columns are compared. Snapshot/file lineage, manual overrides,
  // current price decisions and formula outputs cannot change these counters.
  function compareRows(newRows, baselineRows, options = {}) {
    const errors = [], mode = options.mode ?? 'full', fields = fieldPolicy(mode,options.fields,errors);
    if (!['full','patch'].includes(mode)) errors.push('셀피아 비교 mode는 full 또는 patch여야 합니다.');
    const baselineAvailable = Array.isArray(baselineRows), nextAvailable = Array.isArray(newRows);
    if (!nextAvailable) errors.push('새 원본 행을 확인하지 못했습니다.');
    if (!baselineAvailable) errors.push('기준 원본 행을 확인하지 못했습니다. 비교 건수를 0으로 추정하지 않습니다.');
    const selectedGroups = Object.keys(COMPARISON_FIELDS).filter(key => fields[key] || key === 'price' && fields.basePrice);
    const indexed = (entries, label) => {
      const index = new Map();
      for (const row of entries || []) {
        const sku = typeof row?.sellpia_sku_code === 'string' ? clean(row.sellpia_sku_code) : '';
        if (!sku || index.has(sku)) errors.push(`${label}: SKU가 비어 있거나 중복됩니다.`);
        else index.set(sku,row);
      }
      return index;
    };
    const next = indexed(nextAvailable ? newRows : [],'새 원본'), baseline = indexed(baselineAvailable ? baselineRows : [],'기준 원본');
    const summary = {newRowCount:nextAvailable ? newRows.length : null,baselineRowCount:baselineAvailable ? baselineRows.length : null,
      changedCount:null,unchangedCount:null,addedCount:null,removedCount:null,preservedCount:null,unknownCount:null,
      knownChangedCount:0,knownUnchangedCount:0,fieldCounts:Object.fromEntries(selectedGroups.map(key => [key,0]))};
    const rows = [];
    if (errors.length) {
      for (const [sku] of next) rows.push({sku,sellpia_sku_code:sku,status:'baseline_unknown',changedFields:[],unknownFields:selectedGroups});
      summary.unknownCount=nextAvailable ? newRows.length : null;
      return {valid:false,errors,baselineAvailable,mode,fields,rows,summary,...summary};
    }
    let addedCount=0,removedCount=0,preservedCount=0,unknownCount=0;
    for (const [sku,row] of next) {
      if (!baseline.has(sku)) {
        addedCount++;
        rows.push({sku,sellpia_sku_code:sku,status:'added',changedFields:[...selectedGroups],unknownFields:[]});
        continue;
      }
      const before = baseline.get(sku), changedFields=[], unknownFields=[], changes={};
      for (const group of selectedGroups) {
        const differences=[];
        let unknown=false;
        for (const descriptor of COMPARISON_FIELDS[group]) {
          const oldValue=comparisonValue(before,descriptor), newValue=comparisonValue(row,descriptor);
          if (!oldValue.known || !newValue.known) { unknown=true; continue; }
          if (oldValue.value !== newValue.value) differences.push({field:descriptor[0],before:oldValue.value,after:newValue.value});
        }
        if (unknown) unknownFields.push(group);
        if (differences.length) { changedFields.push(group); changes[group]=differences; summary.fieldCounts[group]++; }
      }
      const status = unknownFields.length ? 'unknown' : changedFields.length ? 'changed' : 'unchanged';
      if (status==='unknown') unknownCount++;
      else if (status==='changed') summary.knownChangedCount++;
      else summary.knownUnchangedCount++;
      rows.push({sku,sellpia_sku_code:sku,status,changedFields,unknownFields,changes});
    }
    for (const [sku] of baseline) if (!next.has(sku)) {
      if (mode==='full') removedCount++;
      else preservedCount++;
      rows.push({sku,sellpia_sku_code:sku,status:mode==='full'?'removed':'preserved',changedFields:[],unknownFields:[]});
    }
    if (unknownCount) errors.push('일부 기준/새 원본 필드가 없어 전체 변경·동일 건수를 확정하지 못했습니다.');
    Object.assign(summary,{changedCount:unknownCount ? null : summary.knownChangedCount,unchangedCount:unknownCount ? null : summary.knownUnchangedCount,
      addedCount,removedCount,preservedCount,unknownCount});
    return {valid:errors.length===0,errors,baselineAvailable,mode,fields,rows,summary,...summary};
  }
  return Object.freeze({FULL_FIELDS, prepare, compareRows});
});
