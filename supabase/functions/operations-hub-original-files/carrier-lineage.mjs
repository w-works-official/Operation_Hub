const MAX_LINEAGE_DEPTH = 256;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function modeOf(snapshot) {
  return String(snapshot?.metadata?.upload_mode ?? 'full').trim().toLowerCase();
}

// A patch or stock-only inventory count has no workbook of the complete catalogue. Only its exact ready
// parent chain may identify the immutable full workbook used as its carrier.
export async function resolveSellpiaCarrierLineage(latest, readReadySnapshot, requestedCarrierId = '') {
  if (!latest) return { carrier: null, stateSnapshotId: null, reason: 'ready 상태의 Sellpia 원본이 없습니다.' };
  const stateSnapshotId = latest.snapshot_id;
  const seen = new Set();
  let snapshot = latest;
  for (let depth = 0; depth < MAX_LINEAGE_DEPTH; depth++) {
    const id = String(snapshot?.snapshot_id ?? '');
    if (!UUID.test(id) || seen.has(id)) {
      return { carrier: null, stateSnapshotId, reason: 'Sellpia 원본 snapshot 계보가 손상되었거나 순환합니다.' };
    }
    seen.add(id);
    const mode = modeOf(snapshot);
    if (mode === 'full') {
      if (requestedCarrierId && requestedCarrierId !== id) {
        return { carrier: null, stateSnapshotId, reason: '요청한 전체 원본은 현재 Sellpia snapshot 계보의 carrier가 아닙니다.' };
      }
      return { carrier: snapshot, stateSnapshotId, reason: '' };
    }
    if (!['patch','inventory_count'].includes(mode)) {
      return { carrier: null, stateSnapshotId, reason: '지원하지 않는 Sellpia 원본 snapshot 종류입니다.' };
    }
    const parentId = String(snapshot.metadata?.base_snapshot_id ?? '').trim();
    if (!UUID.test(parentId) || seen.has(parentId)) {
      return { carrier: null, stateSnapshotId, reason: 'Sellpia 부분 원본의 기준 snapshot 참조가 유효하지 않습니다.' };
    }
    snapshot = await readReadySnapshot(parentId);
    if (!snapshot || snapshot.snapshot_id !== parentId) {
      return { carrier: null, stateSnapshotId, reason: 'Sellpia 부분 원본의 기준 snapshot이 ready 상태로 존재하지 않습니다.' };
    }
  }
  return { carrier: null, stateSnapshotId, reason: 'Sellpia 원본 snapshot 계보가 허용 길이를 초과했습니다.' };
}
