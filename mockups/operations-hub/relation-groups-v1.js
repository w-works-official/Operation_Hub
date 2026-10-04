/*
 * Relationship Groups V1
 *
 * Browser and Node-safe state helpers for the next relationship-management UI.
 * This module deliberately owns no DOM, persistence, price, inventory or seller
 * mapping side effects. A relation group only describes SKU hierarchy context.
 */
(function (global, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.RelationGroupsV1 = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const GROUP_TYPES = Object.freeze({
    collection: {label:'모음전', color:'violet'},
    exhibition: {label:'기획전', color:'purple'},
    set: {label:'세트 구성', color:'blue'},
    one_plus_one: {label:'1+1 조합', color:'orange'},
    custom: {label:'사용자 정의', color:'slate'}
  });

  const EDGE_TYPES = Object.freeze({
    collection_member: {label:'모음전 구성'},
    exhibition_member: {label:'기획전 구성'},
    set_member: {label:'세트 구성품'},
    one_plus_one_member: {label:'1+1 구성품'},
    reference: {label:'참조 관계'},
    custom: {label:'사용자 정의 관계'}
  });

  const MEMBER_ROLES = Object.freeze({anchor:'anchor', member:'member', reference:'reference'});
  const DEFAULT_EDGE_TYPE_BY_GROUP_TYPE = Object.freeze({
    collection:'collection_member',
    exhibition:'exhibition_member',
    set:'set_member',
    one_plus_one:'one_plus_one_member',
    custom:'custom'
  });

  const RELATION_META = Object.freeze({
    affectsPrice:false,
    affectsInventory:false,
    note:'관계 그룹은 가격·재고·판매처 실제 연결을 변경하지 않습니다.'
  });

  function text(value) {
    return String(value == null ? '' : value).trim();
  }

  function list(value) {
    return Array.isArray(value) ? value : [];
  }

  function findFolderCycle(folders) {
    const byId = new Map(list(folders).map(folder => [folder.id, folder]));
    for (const folder of byId.values()) {
      const path = [];
      const seen = new Set();
      let current = folder;
      while (current && current.parentId) {
        if (seen.has(current.id)) return [...path, current.id];
        seen.add(current.id);
        path.push(current.id);
        current = byId.get(current.parentId);
      }
    }
    return null;
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function relationGroupType(type) {
    return GROUP_TYPES[text(type)] || GROUP_TYPES.custom;
  }

  function defaultEdgeType(groupType) {
    return DEFAULT_EDGE_TYPE_BY_GROUP_TYPE[text(groupType)] || 'custom';
  }

  function normalizeFolder(folder, index) {
    const id = text(folder && (folder.id || folder.folderId));
    if (!id) throw new Error(`폴더 ${index + 1}에 id가 필요합니다.`);
    return {
      id,
      name:text(folder && folder.name) || '이름 없는 폴더',
      parentId:text(folder && (folder.parentId || folder.parentFolderId)) || null,
      order:Number.isFinite(Number(folder && folder.order)) ? Number(folder.order) : index
    };
  }

  function normalizeGroup(group, index) {
    const id = text(group && (group.id || group.groupId));
    if (!id) throw new Error(`관계 묶음 ${index + 1}에 id가 필요합니다.`);
    const folderId = text(group && group.folderId);
    if (!folderId) throw new Error(`관계 묶음 '${id}'에 folderId가 필요합니다.`);
    const type = text(group && group.type) || 'custom';
    return {
      id,
      folderId,
      name:text(group && group.name) || '이름 없는 관계 묶음',
      type:GROUP_TYPES[type] ? type : 'custom',
      meta:{...RELATION_META, ...(group && group.meta || {})},
      order:Number.isFinite(Number(group && group.order)) ? Number(group.order) : index
    };
  }

  function normalizeSku(sku, index) {
    const id = text(sku && (sku.id || sku.skuId || sku.sku));
    if (!id) throw new Error(`SKU ${index + 1}에 id가 필요합니다.`);
    return {
      id,
      sku:text(sku && sku.sku) || id,
      productName:text(sku && sku.productName),
      optionName:text(sku && sku.optionName),
      thumbnailUrl:text(sku && sku.thumbnailUrl) || null,
      source:text(sku && sku.source) || 'sellpia',
      productCode:text(sku && sku.productCode) || null,
      optionCode:text(sku && sku.optionCode) || null
    };
  }

  function normalizeMembership(membership, index) {
    const groupId = text(membership && membership.groupId);
    const skuId = text(membership && membership.skuId);
    if (!groupId || !skuId) throw new Error(`소속 ${index + 1}에는 groupId와 skuId가 필요합니다.`);
    const memberRole = text(membership && membership.memberRole) || MEMBER_ROLES.member;
    if (!Object.prototype.hasOwnProperty.call(MEMBER_ROLES, memberRole)) throw new Error(`소속 '${groupId}:${skuId}'의 memberRole은 anchor, member, reference 중 하나여야 합니다.`);
    const sortOrder = Number(membership && (membership.sortOrder == null ? membership.order : membership.sortOrder));
    return {
      id:text(membership && membership.id) || `${groupId}:${skuId}`,
      groupId,
      skuId,
      memberRole,
      sortOrder:Number.isFinite(sortOrder) ? sortOrder : index
    };
  }

  function normalizeEdge(edge, index, groupById) {
    const id = text(edge && edge.id) || `edge-${index + 1}`;
    const groupId = text(edge && edge.groupId);
    const parentSkuId = text(edge && edge.parentSkuId);
    const childSkuId = text(edge && edge.childSkuId);
    if (!groupId || !parentSkuId || !childSkuId) throw new Error(`관계선 ${index + 1}에는 groupId, parentSkuId, childSkuId가 필요합니다.`);
    if (parentSkuId === childSkuId) throw new Error(`관계선 '${id}'은 같은 SKU를 상위·하위로 연결할 수 없습니다.`);
    const group = groupById && groupById.get(groupId);
    const edgeType = text(edge && edge.edgeType) || defaultEdgeType(group && group.type);
    if (!Object.prototype.hasOwnProperty.call(EDGE_TYPES, edgeType)) throw new Error(`관계선 '${id}'의 edgeType은 허용된 관계 종류여야 합니다.`);
    return {id, groupId, parentSkuId, childSkuId, edgeType};
  }

  function normalizeState(input) {
    const source = input || {};
    const folders = list(source.folders).map(normalizeFolder);
    const groups = list(source.groups).map(normalizeGroup);
    const skus = list(source.skus).map(normalizeSku);
    const memberships = list(source.memberships).map(normalizeMembership);
    const groupById = new Map(groups.map(group => [group.id, group]));
    const edges = list(source.edges).map((edge, index) => normalizeEdge(edge, index, groupById));
    const folderIds = new Set(folders.map(item => item.id));
    const groupIds = new Set(groups.map(item => item.id));
    const skuIds = new Set(skus.map(item => item.id));
    const membershipKeys = new Set();

    folders.forEach(folder => {
      if (folder.parentId && !folderIds.has(folder.parentId)) throw new Error(`폴더 '${folder.name}'의 상위 폴더를 찾을 수 없습니다.`);
      if (folder.parentId === folder.id) throw new Error(`폴더 '${folder.name}'은 자기 자신 아래에 둘 수 없습니다.`);
    });
    const folderCycle = findFolderCycle(folders);
    if (folderCycle) throw new Error(`폴더 계층에 순환이 있습니다: ${folderCycle.join(' → ')}`);
    groups.forEach(group => {
      if (!folderIds.has(group.folderId)) throw new Error(`관계 묶음 '${group.name}'의 폴더를 찾을 수 없습니다.`);
    });
    memberships.forEach(membership => {
      if (!groupIds.has(membership.groupId) || !skuIds.has(membership.skuId)) throw new Error(`소속 '${membership.id}'의 관계 묶음 또는 SKU를 찾을 수 없습니다.`);
      const key = `${membership.groupId}\u0000${membership.skuId}`;
      if (membershipKeys.has(key)) throw new Error(`SKU '${membership.skuId}'가 같은 관계 묶음에 중복 소속되어 있습니다.`);
      membershipKeys.add(key);
    });
    edges.forEach(edge => {
      if (!groupIds.has(edge.groupId) || !skuIds.has(edge.parentSkuId) || !skuIds.has(edge.childSkuId)) throw new Error(`관계선 '${edge.id}'의 관계 묶음 또는 SKU를 찾을 수 없습니다.`);
      if (!membershipKeys.has(`${edge.groupId}\u0000${edge.parentSkuId}`) || !membershipKeys.has(`${edge.groupId}\u0000${edge.childSkuId}`)) throw new Error(`관계선 '${edge.id}'의 양쪽 SKU는 같은 관계 묶음에 먼저 소속되어야 합니다.`);
    });
    groups.forEach(group => {
      const cycle = findCycle(edges.filter(edge => edge.groupId === group.id));
      if (cycle) throw new Error(`관계 묶음 '${group.name}'에 순환 관계가 있습니다: ${cycle.join(' → ')}`);
    });
    const stagedSource = source.staged || {};
    const stagedAdditions = list(stagedSource.additions).map((edge, index) => normalizeEdge(edge, edges.length + index, groupById));
    const stagedRemovalIds = [...new Set(list(stagedSource.removals).map(text).filter(Boolean))];
    const normalized = {
      folders,
      groups,
      skus,
      memberships,
      edges,
      staged:{additions:stagedAdditions, removals:stagedRemovalIds}
    };
    groups.forEach(group => {
      const cycle = findCycle(getActiveEdges(normalized, group.id));
      if (cycle) throw new Error(`저장 전 관계 묶음 '${group.name}'에 순환 관계가 있습니다: ${cycle.join(' → ')}`);
    });
    return normalized;
  }

  function createState(input) {
    return normalizeState(input);
  }

  function createFolder(state, folder) {
    const next = clone(state);
    const id = text(folder && (folder.id || folder.folderId));
    if (!id) throw new Error('새 폴더 id가 필요합니다.');
    if (next.folders.some(item => item.id === id)) throw new Error(`폴더 '${id}'가 이미 있습니다.`);
    next.folders.push(normalizeFolder(folder, next.folders.length));
    return normalizeState(next);
  }

  function createGroup(state, group) {
    const next = clone(state);
    const id = text(group && (group.id || group.groupId));
    if (!id) throw new Error('새 관계 묶음 id가 필요합니다.');
    if (next.groups.some(item => item.id === id)) throw new Error(`관계 묶음 '${id}'가 이미 있습니다.`);
    next.groups.push(normalizeGroup(group, next.groups.length));
    return normalizeState(next);
  }

  function upsertSku(state, sku) {
    const next = clone(state);
    const normalized = normalizeSku(sku, next.skus.length);
    const index = next.skus.findIndex(item => item.id === normalized.id);
    if (index >= 0) next.skus[index] = {...next.skus[index], ...normalized};
    else next.skus.push(normalized);
    return normalizeState(next);
  }

  function addMembership(state, membership) {
    const next = clone(state);
    const normalized = normalizeMembership(membership, next.memberships.length);
    if (!next.memberships.some(item => item.groupId === normalized.groupId && item.skuId === normalized.skuId)) next.memberships.push(normalized);
    return normalizeState(next);
  }

  function edgeKey(edge) {
    return `${edge.groupId}\u0000${edge.parentSkuId}\u0000${edge.childSkuId}\u0000${edge.edgeType || 'custom'}`;
  }

  function getActiveEdges(state, groupId) {
    const removed = new Set(list(state && state.staged && state.staged.removals));
    const active = list(state && state.edges).filter(edge => !removed.has(edge.id));
    const keys = new Set(active.map(edgeKey));
    list(state && state.staged && state.staged.additions).forEach(edge => {
      if (!removed.has(edge.id) && !keys.has(edgeKey(edge))) {
        active.push(edge);
        keys.add(edgeKey(edge));
      }
    });
    return groupId ? active.filter(edge => edge.groupId === groupId) : active;
  }

  function findCycle(edges) {
    const children = new Map();
    edges.forEach(edge => {
      if (!children.has(edge.parentSkuId)) children.set(edge.parentSkuId, []);
      children.get(edge.parentSkuId).push(edge.childSkuId);
    });
    const visiting = new Set();
    const visited = new Set();
    const path = [];
    function visit(skuId) {
      if (visiting.has(skuId)) return [...path.slice(path.indexOf(skuId)), skuId];
      if (visited.has(skuId)) return null;
      visiting.add(skuId);
      path.push(skuId);
      for (const child of children.get(skuId) || []) {
        const cycle = visit(child);
        if (cycle) return cycle;
      }
      path.pop();
      visiting.delete(skuId);
      visited.add(skuId);
      return null;
    }
    for (const skuId of children.keys()) {
      const cycle = visit(skuId);
      if (cycle) return cycle;
    }
    return null;
  }

  function stageAddEdge(state, edge) {
    const next = clone(state);
    const groupById = new Map(next.groups.map(group => [group.id, group]));
    const normalized = normalizeEdge(edge, next.edges.length + next.staged.additions.length, groupById);
    if (!next.groups.some(group => group.id === normalized.groupId)) throw new Error(`관계 묶음 '${normalized.groupId}'를 찾을 수 없습니다.`);
    [normalized.parentSkuId, normalized.childSkuId].forEach(skuId => {
      if (!next.skus.some(sku => sku.id === skuId)) throw new Error(`SKU '${skuId}'를 찾을 수 없습니다.`);
      if (!next.memberships.some(item => item.groupId === normalized.groupId && item.skuId === skuId)) next.memberships.push({id:`${normalized.groupId}:${skuId}`, groupId:normalized.groupId, skuId, memberRole:MEMBER_ROLES.member, sortOrder:next.memberships.length});
    });
    const existing = getActiveEdges(next, normalized.groupId);
    if (existing.some(item => edgeKey(item) === edgeKey(normalized))) return normalizeState(next);
    next.staged.additions.push(normalized);
    const cycle = findCycle(getActiveEdges(next, normalized.groupId));
    if (cycle) throw new Error(`순환 관계는 만들 수 없습니다: ${cycle.join(' → ')}`);
    return normalizeState({...next, staged:next.staged});
  }

  function stageRemoveEdge(state, edgeId) {
    const next = clone(state);
    const id = text(edgeId);
    const addedIndex = next.staged.additions.findIndex(edge => edge.id === id);
    if (addedIndex >= 0) {
      next.staged.additions.splice(addedIndex, 1);
      return normalizeState({...next, staged:next.staged});
    }
    if (!next.edges.some(edge => edge.id === id)) throw new Error(`관계선 '${id}'을 찾을 수 없습니다.`);
    if (!next.staged.removals.includes(id)) next.staged.removals.push(id);
    return normalizeState({...next, staged:next.staged});
  }

  function calculateLanes(state, groupId) {
    const memberships = list(state && state.memberships).filter(item => item.groupId === groupId);
    const edges = getActiveEdges(state, groupId);
    const skuById = new Map(list(state && state.skus).map(sku => [sku.id, sku]));
    const memberIds = memberships.map(item => item.skuId);
    const inbound = new Map(memberIds.map(id => [id, 0]));
    const children = new Map(memberIds.map(id => [id, []]));
    edges.forEach(edge => {
      inbound.set(edge.childSkuId, (inbound.get(edge.childSkuId) || 0) + 1);
      if (!children.has(edge.parentSkuId)) children.set(edge.parentSkuId, []);
      children.get(edge.parentSkuId).push(edge.childSkuId);
    });
    const roots = memberIds.filter(id => (inbound.get(id) || 0) === 0);
    const levels = new Map(memberIds.map(id => [id, 0]));
    const queue = [...roots];
    for (let index = 0; index < queue.length; index += 1) {
      const parent = queue[index];
      for (const child of children.get(parent) || []) {
        const proposed = (levels.get(parent) || 0) + 1;
        if (proposed > (levels.get(child) || 0)) levels.set(child, proposed);
        inbound.set(child, Math.max(0, (inbound.get(child) || 0) - 1));
        if (inbound.get(child) === 0) queue.push(child);
      }
    }
    const laneMap = new Map();
    memberIds.forEach(skuId => {
      const lane = levels.get(skuId) || 0;
      if (!laneMap.has(lane)) laneMap.set(lane, []);
      laneMap.get(lane).push(skuById.get(skuId) || {id:skuId, sku:skuId, productName:'', optionName:''});
    });
    const lanes = [...laneMap.keys()].sort((a, b) => a - b).map(index => ({
      index,
      title:index === 0 ? '상위 SKU' : index === 1 ? '하위 SKU' : `하위 ${index}단계`,
      items:laneMap.get(index)
    }));
    return {groupId, lanes, roots, edges, cycle:findCycle(edges)};
  }

  function getGroupGraph(state, groupId) {
    const group = list(state && state.groups).find(item => item.id === groupId);
    if (!group) throw new Error(`관계 묶음 '${groupId}'를 찾을 수 없습니다.`);
    const memberIds = new Set(list(state.memberships).filter(item => item.groupId === groupId).map(item => item.skuId));
    return {
      group:{...group, typeLabel:relationGroupType(group.type).label},
      meta:{...RELATION_META, ...group.meta},
      skus:list(state.skus).filter(sku => memberIds.has(sku.id)),
      memberships:list(state.memberships).filter(item => item.groupId === groupId),
      edges:getActiveEdges(state, groupId),
      lanes:calculateLanes(state, groupId)
    };
  }

  function getChangeSummary(state) {
    const additions = list(state && state.staged && state.staged.additions);
    const removals = list(state && state.staged && state.staged.removals);
    const groupIds = new Set([...additions.map(edge => edge.groupId), ...list(state && state.edges).filter(edge => removals.includes(edge.id)).map(edge => edge.groupId)]);
    const affectedSkuIds = new Set();
    additions.forEach(edge => { affectedSkuIds.add(edge.parentSkuId); affectedSkuIds.add(edge.childSkuId); });
    list(state && state.edges).filter(edge => removals.includes(edge.id)).forEach(edge => { affectedSkuIds.add(edge.parentSkuId); affectedSkuIds.add(edge.childSkuId); });
    return {
      additions:clone(additions),
      removals:clone(removals),
      additionCount:additions.length,
      removalCount:removals.length,
      affectedGroupCount:groupIds.size,
      affectedSkuCount:affectedSkuIds.size,
      affectsPrice:false,
      affectsInventory:false,
      message:RELATION_META.note
    };
  }

  function skuCardText(sku) {
    return {
      sku:text(sku && (sku.sku || sku.id)),
      productName:text(sku && sku.productName) || '상품명 없음',
      optionName:text(sku && sku.optionName) || '옵션명 없음',
      thumbnailUrl:text(sku && sku.thumbnailUrl) || null
    };
  }

  function escapeHtml(value) {
    return text(value).replace(/[&<>\"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#39;'}[char]));
  }

  function renderFixture(state, groupId) {
    const graph = getGroupGraph(state, groupId);
    const lanes = graph.lanes.lanes.map(lane => {
      const cards = lane.items.map(sku => {
        const card = skuCardText(sku);
        const image = card.thumbnailUrl ? `<img src="${escapeHtml(card.thumbnailUrl)}" alt="" />` : '<span class="rg-fixture-thumb-empty">이미지 없음</span>';
        return `<article class="rg-fixture-card" data-sku-id="${escapeHtml(sku.id)}">${image}<div><b>${escapeHtml(card.productName)}</b><strong>${escapeHtml(card.optionName)}</strong><small>${escapeHtml(card.sku)}</small></div></article>`;
      }).join('');
      return `<section class="rg-fixture-lane" data-lane="${lane.index}"><h4>${escapeHtml(lane.title)}</h4>${cards || '<p>없음</p>'}</section>`;
    }).join('');
    const edgeText = graph.edges.map(edge => `${escapeHtml(edge.parentSkuId)} → ${escapeHtml(edge.childSkuId)}`).join('<br>') || '관계 없음';
    return `<section class="rg-fixture" data-group-id="${escapeHtml(graph.group.id)}"><header><span>${escapeHtml(graph.group.typeLabel)}</span><h3>${escapeHtml(graph.group.name)}</h3><p>${escapeHtml(graph.meta.note)}</p></header><div class="rg-fixture-lanes">${lanes}</div><footer><b>관계 ${graph.edges.length}건</b><p>${edgeText}</p></footer></section>`;
  }

  return {
    GROUP_TYPES,
    EDGE_TYPES,
    MEMBER_ROLES,
    DEFAULT_EDGE_TYPE_BY_GROUP_TYPE,
    RELATION_META,
    relationGroupType,
    defaultEdgeType,
    createState,
    normalizeState,
    createFolder,
    createGroup,
    upsertSku,
    addMembership,
    edgeKey,
    findCycle,
    findFolderCycle,
    getActiveEdges,
    stageAddEdge,
    stageRemoveEdge,
    calculateLanes,
    getGroupGraph,
    getChangeSummary,
    skuCardText,
    renderFixture
  };
});
