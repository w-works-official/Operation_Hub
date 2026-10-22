(function(global) {
  'use strict';

  const fields = {stock:'sellpia_current_stock',available_stock:'sellpia_available_stock'};
  const compare = (left,right) => left < right ? -1 : left > right ? 1 : 0;
  const copy = value => Array.isArray(value) ? value.map(copy) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort(compare).map(key => [key,copy(value[key])])) : value;

  function resolve({context,stockSources,stockSource,blockedSkus = []} = {}) {
    const field = Object.hasOwn(fields,stockSource) ? fields[stockSource] : null;
    if (!field) throw new Error('재고 종속관계의 내보내기 기준을 확인해주세요.');
    if (!global.HubPriceDependencyExport?.plan) throw new Error('SKU 종속관계 검증 모듈이 없습니다.');
    if (!stockSources || typeof stockSources.snapshotId !== 'string' || !stockSources.snapshotId.trim()
      || !stockSources.bySku || typeof stockSources.bySku.get !== 'function'
      || typeof stockSources.bySku.has !== 'function' || typeof stockSources.bySku.entries !== 'function') {
      throw new Error('재고 종속관계의 원본 snapshot을 확인할 수 없습니다.');
    }
    if (!Array.isArray(blockedSkus) && !(blockedSkus instanceof Set)) throw new Error('차단 SKU 목록을 확인해주세요.');
    const blocked = new Set(Array.from(blockedSkus,value => {
      if (typeof value !== 'string' || !value.trim()) throw new Error('차단 SKU identity를 확인해주세요.');
      return value.trim();
    }));
    const originallyBlocked = new Set(blocked);
    const structure = global.HubPriceDependencyExport.plan({context});
    const inputSkus = [...new Set([...context.selected_skus,...context.reference_skus])].sort(compare);
    const rawSources = stockSources.bySku;
    const bySku = new Map(Array.from(rawSources.entries(),([sku,row]) => [sku,copy(row)]));
    const sourcePresent = sku => rawSources.has(sku) && rawSources.get(sku) !== null
      && typeof rawSources.get(sku) === 'object' && !Array.isArray(rawSources.get(sku));
    const rows = structure.rows.map(row => {
      const own = sourcePresent(row.sku) ? rawSources.get(row.sku) : null;
      const root = sourcePresent(row.root_sku) ? rawSources.get(row.root_sku) : null;
      const result = {...row,path:[...row.path],stock_source:stockSource,stock_field:field,
        raw_value:own?.[field] ?? null,root_raw_value:root?.[field] ?? null,
        source_snapshot_id:stockSources.snapshotId,applied:false};
      const fail = (code,message) => {
        blocked.add(row.sku);
        return {...result,error_code:code,error:message};
      };
      if (row.error) return fail(row.error_code,row.error);
      if (originallyBlocked.has(row.sku)) return fail('SKU_BLOCKED',`${row.sku}: 재고 입력 또는 기존 재고 정책에서 차단된 SKU입니다.`);
      if (!row.inherited) return result;
      const blockedAncestor = row.path.slice(0,-1).find(sku => originallyBlocked.has(sku));
      if (blockedAncestor) return fail('PARENT_BLOCKED',`${row.sku}: 상위 SKU ${blockedAncestor}의 재고가 차단되어 있습니다.`);
      const missingAncestor = row.path.slice(0,-1).find(sku => !sourcePresent(sku));
      if (missingAncestor) return fail('PARENT_SOURCE_MISSING',`${row.sku}: 상위 SKU ${missingAncestor}의 원본 재고 행이 없습니다.`);
      if (!own) return fail('SKU_SOURCE_MISSING',`${row.sku}: 원본 재고 행이 없어 상속 수량을 적용할 수 없습니다.`);
      const value = root?.[field];
      if (!Number.isSafeInteger(value)) return fail('INVALID_PARENT_STOCK',`${row.sku}: 최초 상위 SKU ${row.root_sku}의 원본 재고가 안전한 정수가 아닙니다.`);
      // This is an export-only scalar inheritance. Keep the other stock field,
      // every source row and all listing/BOM quantity or stock policies intact.
      bySku.set(row.sku,{...bySku.get(row.sku),[field]:value});
      return {...result,raw_value:value,root_raw_value:value,applied:true};
    });
    const blockedResult = [...blocked].sort(compare);
    const facts = inputSkus.map(sku => ({sku,present:sourcePresent(sku),
      field_present:sourcePresent(sku) && Object.hasOwn(rawSources.get(sku),field),
      raw_value:sourcePresent(sku) ? rawSources.get(sku)[field] ?? null : null}));
    const proof = JSON.stringify(copy({contract_version:1,stock_source:stockSource,stock_field:field,
      snapshot_id:stockSources.snapshotId,graph:JSON.parse(structure.graphProof),input_skus:inputSkus,
      input_stock:facts,originally_blocked_skus:[...originallyBlocked].sort(compare),blocked_skus:blockedResult,
      rows:rows.map(row => ({sku:row.sku,parent_sku:row.parent_sku,root_sku:row.root_sku,path:row.path,
        inherited:row.inherited,automatically_included:row.automatically_included,raw_value:row.raw_value,
        root_raw_value:row.root_raw_value,source_snapshot_id:row.source_snapshot_id,applied:row.applied,
        error_code:row.error_code,error:row.error}))}));
    const {bySku:rawMap,...metadata} = stockSources;
    return {stockSources:{...copy(metadata),bySku},rows,blockedSkus:blockedResult,inputSkus,proof};
  }

  global.HubStockDependencyExport = Object.freeze({resolve});
})(typeof window === 'undefined' ? globalThis : window);
