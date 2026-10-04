(function (global, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.RelationImportParser = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function text(value) {
    return String(value ?? '').trim();
  }

  function columnName(index) {
    let value = Number(index) + 1;
    let result = '';
    while (value > 0) {
      value -= 1;
      result = String.fromCharCode(65 + (value % 26)) + result;
      value = Math.floor(value / 26);
    }
    return result;
  }

  function findCycle(edges) {
    const next = new Map();
    edges.forEach(edge => {
      if (!next.has(edge.parentCode)) next.set(edge.parentCode, []);
      next.get(edge.parentCode).push(edge.childCode);
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

  function parseRelationHierarchyRows(rows, options = {}) {
    const maxCodes = Math.max(1, Number(options.maxCodes) || 500);
    const maxEdges = Math.max(1, Number(options.maxEdges) || 1000);
    const matrix = Array.isArray(rows) ? rows : [];
    const errors = [];
    if (!matrix.length) return {valid:false, headers:[], rows:[], codes:[], edges:[], duplicateEdgeCount:0, errors:['첫 번째 시트가 비어 있습니다.']};

    const rawHeaders = Array.isArray(matrix[0]) ? matrix[0].map(text) : [];
    let lastHeader = rawHeaders.length - 1;
    while (lastHeader >= 0 && !rawHeaders[lastHeader]) lastHeader -= 1;
    const headers = rawHeaders.slice(0, lastHeader + 1).map(value => value.toUpperCase());
    if (headers.length < 2) errors.push('헤더는 A, B처럼 두 단계 이상이어야 합니다.');
    headers.forEach((header, index) => {
      const expected = columnName(index);
      if (header !== expected) errors.push(`${expected}1 헤더는 '${expected}'여야 합니다.`);
    });

    const parsedRows = [];
    const codeSet = new Set();
    const edgeMap = new Map();
    let duplicateEdgeCount = 0;
    for (let index = 1; index < matrix.length; index += 1) {
      const values = headers.map((_, column) => text(matrix[index]?.[column]));
      if (!values.some(Boolean)) continue;
      let firstBlank = -1;
      values.forEach((value, column) => {
        if (!value && firstBlank < 0) firstBlank = column;
        if (value && firstBlank >= 0) errors.push(`${index + 1}행 ${columnName(firstBlank)}열이 비어 있는데 ${columnName(column)}열에 값이 있습니다.`);
      });
      const chain = values.filter(Boolean);
      if (chain.length < 2) {
        errors.push(`${index + 1}행은 상위·하위 코드가 모두 필요합니다.`);
        continue;
      }
      parsedRows.push({rowNo:index + 1, values:chain});
      chain.forEach(code => codeSet.add(code));
      for (let level = 0; level < chain.length - 1; level += 1) {
        const parentCode = chain[level];
        const childCode = chain[level + 1];
        if (parentCode === childCode) {
          errors.push(`${index + 1}행 ${columnName(level)}→${columnName(level + 1)} 관계는 같은 코드를 상위·하위로 사용할 수 없습니다.`);
          continue;
        }
        const key = `${parentCode}\u0000${childCode}`;
        if (edgeMap.has(key)) {
          duplicateEdgeCount += 1;
        } else {
          edgeMap.set(key, {parentCode, childCode, rowNo:index + 1, parentColumn:columnName(level), childColumn:columnName(level + 1)});
        }
      }
    }
    if (!parsedRows.length && !errors.length) errors.push('등록할 관계 행이 없습니다.');
    const codes = [...codeSet];
    const edges = [...edgeMap.values()];
    if (codes.length > maxCodes) errors.push(`고유 코드는 한 번에 최대 ${maxCodes}개까지 등록할 수 있습니다. 현재 ${codes.length}개입니다.`);
    if (edges.length > maxEdges) errors.push(`관계는 한 번에 최대 ${maxEdges}건까지 등록할 수 있습니다. 현재 ${edges.length}건입니다.`);
    const cycle = findCycle(edges);
    if (cycle) errors.push(`엑셀 안에 순환 관계가 있습니다: ${cycle.join(' → ')}`);
    return {valid:errors.length === 0, headers, rows:parsedRows, codes, edges, duplicateEdgeCount, errors};
  }

  return {columnName, findCycle, parseRelationHierarchyRows};
});
