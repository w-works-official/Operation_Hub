(function (global) {
  'use strict';

  const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0;
  function sku(value, label) {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`${label}: SKU가 올바르지 않습니다.`);
    return value.trim();
  }
  function skuList(value, label, unique = true) {
    if (!Array.isArray(value)) throw new Error(`${label}: SKU 목록이 필요합니다.`);
    const values = value.map(item => sku(item, label));
    if (unique && new Set(values).size !== values.length) throw new Error(`${label}: SKU가 중복됩니다.`);
    return [...new Set(values)].sort(compare);
  }
  function canonical(value, ancestors = new Set()) {
    if (value === undefined || value === null) return null;
    if (typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value !== 'object' || ancestors.has(value)) throw new Error('종속 가격 증거를 JSON으로 확인할 수 없습니다.');
    ancestors.add(value);
    const result = Array.isArray(value)
      ? value.map(item => canonical(item, ancestors))
      : Object.fromEntries(Object.keys(value).sort(compare).map(key => [key, canonical(value[key], ancestors)]));
    ancestors.delete(value);
    return result;
  }
  const proof = value => JSON.stringify(canonical(value));

  function plan({context, selection} = {}) {
    if (!context || typeof context !== 'object') throw new Error('현재 종속관계 조회 결과가 필요합니다.');
    if (context.contract_version !== undefined && context.contract_version !== 1) throw new Error('종속관계 조회 버전이 다릅니다.');
    const outputSkus = skuList(context.selected_skus, '내보내기 범위');
    const referenceSkus = skuList(context.reference_skus, '상위 참조 범위');
    const selected = skuList(selection instanceof Set ? [...selection] : selection ?? context.requested_skus ?? outputSkus, '원래 선택 범위', false);
    const output = new Set(outputSkus), allowed = new Set([...outputSkus, ...referenceSkus]);
    if (selected.some(value => !output.has(value))) throw new Error('원래 선택 SKU가 조회된 내보내기 범위에 없습니다.');
    if (referenceSkus.some(value => output.has(value))) throw new Error('참조 전용 SKU와 내보내기 SKU 범위가 겹칩니다.');
    if (!Array.isArray(context.edges)) throw new Error('현재 종속관계 목록이 필요합니다.');
    const parents = new Map(), children = new Map(), uniqueEdges = new Map();
    for (const edge of context.edges) {
      if (!edge || typeof edge !== 'object') throw new Error('종속관계 행이 올바르지 않습니다.');
      const parent = sku(edge.parent_sku, '상위'), child = sku(edge.child_sku, '하위');
      if (!allowed.has(parent) || !allowed.has(child)) throw new Error('조회 범위 밖의 종속관계 SKU가 있습니다.');
      if (edge.is_active === false) throw new Error('비활성 종속관계가 조회 결과에 포함되어 있습니다.');
      if (!parents.has(child)) parents.set(child, new Set());
      parents.get(child).add(parent);
      if (!children.has(parent)) children.set(parent, new Set());
      children.get(parent).add(child);
      const normalized = {parent_sku:parent, child_sku:child};
      for (const key of ['edge_id', 'parent_node_id', 'child_node_id']) if (edge[key] !== undefined) normalized[key] = edge[key];
      uniqueEdges.set(proof(normalized), normalized);
    }
    // The server expands descendants. Verify that its output scope neither
    // loses a descendant nor adds a merely referenced ancestor to the file.
    const closure = new Set(selected), queue = [...selected];
    for (let index = 0; index < queue.length; index++) for (const child of children.get(queue[index]) || []) {
      if (!closure.has(child)) { closure.add(child); queue.push(child); }
    }
    if (closure.size !== output.size || [...closure].some(value => !output.has(value))) throw new Error('하위 종속 SKU와 내보내기 범위가 일치하지 않습니다.');

    const memo = new Map();
    const failure = (value, parent, code, error, path = [value]) => ({sku:value, parent_sku:parent, root_sku:null, path, error_code:code, error});
    for (const start of outputSkus) {
      const frames = [{sku:start, entered:false}], active = new Map();
      while (frames.length) {
        const frame = frames[frames.length - 1], value = frame.sku;
        if (memo.has(value)) { active.delete(value); frames.pop(); continue; }
        const incoming = [...(parents.get(value) || [])].sort(compare);
        if (!frame.entered) {
          if (incoming.includes(value)) { memo.set(value, failure(value, value, 'SELF_REFERENCE', `${value}: 자기 자신을 상위 SKU로 참조할 수 없습니다.`, [value, value])); continue; }
          if (incoming.length > 1) { memo.set(value, failure(value, null, 'MULTIPLE_PARENTS', `${value}: 서로 다른 상위 SKU가 여러 개입니다 (${incoming.join(', ')}).`)); continue; }
          if (!incoming.length) { memo.set(value, {sku:value, parent_sku:null, root_sku:value, path:[value], error:null, error_code:null}); continue; }
          frame.parent = incoming[0]; frame.entered = true; active.set(value, frames.length - 1);
          if (active.has(frame.parent)) {
            const cycle = frames.slice(active.get(frame.parent)).map(item => item.sku).concat(frame.parent);
            for (const member of cycle.slice(0, -1)) memo.set(member, failure(member, [...parents.get(member)][0], 'CYCLE', `종속관계 순환: ${cycle.join(' → ')}`, [...cycle]));
          } else if (!memo.has(frame.parent)) frames.push({sku:frame.parent, entered:false});
          continue;
        }
        const parent = memo.get(frame.parent);
        if (!parent) throw new Error('종속관계 상위 경로를 확인하지 못했습니다.');
        memo.set(value, {sku:value, parent_sku:frame.parent, root_sku:parent.root_sku, path:[...parent.path, value],
          error:parent.error ? `${value}: 상위 SKU 경로 오류 · ${parent.error}` : null,
          error_code:parent.error ? 'PARENT_INVALID' : null});
      }
    }
    const original = new Set(selected);
    const rows = outputSkus.map(value => ({...memo.get(value), path:[...memo.get(value).path], inherited:parents.has(value), automatically_included:!original.has(value)}));
    const rootSkus = [...new Set(rows.filter(row => row.inherited && !row.error).map(row => row.root_sku))].sort(compare);
    const edges = [...uniqueEdges.values()].sort((left, right) => compare(proof(left), proof(right)));
    const graphProof = proof({contract_version:1, version:context.version ?? null, snapshot_id:context.snapshot_id ?? null,
      requested_skus:selected, selected_skus:outputSkus, reference_skus:referenceSkus, edges});
    return {rows, bySku:new Map(rows.map(row => [row.sku, row])), outputSkus, rootSkus, graphProof};
  }

  function resolve({context, parentPrices = new Map(), selection} = {}) {
    if (!parentPrices || typeof parentPrices.get !== 'function' || typeof parentPrices.has !== 'function') throw new Error('상위 최종가는 SKU별 Map으로 전달해주세요.');
    const structural = plan({context, selection});
    const rows = structural.rows.map(row => {
      const result = {...row, path:[...row.path], final:null, price_proof:null};
      // Ordinary selected roots retain the existing export path and precedence.
      if (!row.inherited || row.error) return result;
      const input = parentPrices.get(row.root_sku);
      if (!parentPrices.has(row.root_sku) || input === null || input === undefined) return {...result, error_code:'MISSING_PARENT_PRICE', error:`${row.sku}: 상위 SKU ${row.root_sku}의 현재 최종가가 없습니다.`};
      if (typeof input === 'object' && input.error) return {...result, error_code:'PARENT_PRICE_ERROR', error:`${row.sku}: 상위 SKU ${row.root_sku} 가격 조회 실패 · ${String(input.error.message || input.error)}`};
      const amount = typeof input === 'number' ? input : input.final;
      if (!Number.isSafeInteger(amount) || amount < 0) return {...result, error_code:'INVALID_PARENT_PRICE', error:`${row.sku}: 상위 SKU ${row.root_sku}의 최종가가 안전한 음수 아닌 정수가 아닙니다.`};
      // Copy only the scalar. A parent's current decision tuple/identity must
      // never be attached to the child's distinct marketplace identity.
      return {...result, final:amount, price_proof:canonical(typeof input === 'object' ? input.proof ?? null : null)};
    });
    return {...structural, rows, bySku:new Map(rows.map(row => [row.sku, row])),
      proof:proof({graph:JSON.parse(structural.graphProof), targets:rows.map(row => ({sku:row.sku, parent_sku:row.parent_sku, root_sku:row.root_sku,
        path:row.path, final:row.final, error_code:row.error_code, error:row.error, automatically_included:row.automatically_included, price_proof:row.price_proof}))})};
  }

  global.HubPriceDependencyExport = {plan, resolve};
})(typeof window === 'undefined' ? globalThis : window);
