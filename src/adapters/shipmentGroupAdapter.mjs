import { normalizeShipmentGroup } from "../domain/shipmentGroups.mjs?v=20260811-shipment-groups1";

function text(value) {
  return String(value ?? "").trim();
}

function rpcData(data, error, label) {
  if (error) throw error;
  if (!data) throw new Error(`${label}: empty response.`);
  return data;
}

function normalizeSnapshot(snapshot = {}) {
  return normalizeShipmentGroup(snapshot.group || {}, snapshot.members || []);
}

export function createShipmentGroupAdapter(db) {
  if (!db?.from || !db?.rpc) throw new Error("A Supabase client with from/rpc is required.");

  async function loadActiveGroups() {
    const groupResult = await db
      .from("shipment_groups")
      .select("*")
      .eq("status", "active")
      .order("created_at", { ascending: true });
    if (groupResult.error) throw groupResult.error;
    const groups = groupResult.data || [];
    const groupIds = groups.map((group) => text(group.id)).filter(Boolean);
    if (!groupIds.length) return [];

    const memberResult = await db
      .from("shipment_group_members")
      .select("*")
      .in("group_id", groupIds)
      .eq("active", true)
      .order("member_order", { ascending: true });
    if (memberResult.error) throw memberResult.error;
    return groups.map((group) => normalizeShipmentGroup(group, memberResult.data || []));
  }

  async function createGroup({ orderGroupNos, representativeOrderGroupNo, actor = "system-v3-front" }) {
    const ordNos = [...new Set((orderGroupNos || []).map(text).filter(Boolean))];
    const representative = text(representativeOrderGroupNo);
    if (ordNos.length < 2) throw new Error("합배송은 주문 2건 이상을 선택해야 합니다.");
    if (!ordNos.includes(representative)) throw new Error("대표 주문은 선택된 주문에 포함되어야 합니다.");
    const { data, error } = await db.rpc("create_shipment_group", {
      p_ord_nos: ordNos,
      p_representative_ord_no: representative,
      p_created_by: text(actor) || "system-v3-front",
    });
    return normalizeSnapshot(rpcData(data, error, "create shipment group"));
  }

  async function changeRepresentative({ groupId, representativeOrderGroupNo, expectedVersion, actor = "system-v3-front" }) {
    const { data, error } = await db.rpc("change_shipment_representative", {
      p_group_id: text(groupId),
      p_representative_ord_no: text(representativeOrderGroupNo),
      p_expected_version: Number(expectedVersion),
      p_updated_by: text(actor) || "system-v3-front",
    });
    return normalizeSnapshot(rpcData(data, error, "change shipment representative"));
  }

  async function releaseGroup({ groupId, expectedVersion, actor = "system-v3-front" }) {
    const { data, error } = await db.rpc("release_shipment_group", {
      p_group_id: text(groupId),
      p_expected_version: Number(expectedVersion),
      p_released_by: text(actor) || "system-v3-front",
    });
    return normalizeSnapshot(rpcData(data, error, "release shipment group"));
  }

  async function saveDrawerMemo({ groupId, drawerMemo, expectedVersion, autoHold = true, actor = "system-v3-front" }) {
    const { data, error } = await db.rpc("save_shipment_group_drawer_memo", {
      p_group_id: text(groupId),
      p_drawer_memo: String(drawerMemo ?? ""),
      p_expected_version: Number(expectedVersion),
      p_auto_hold: Boolean(autoHold),
      p_updated_by: text(actor) || "system-v3-front",
    });
    const result = rpcData(data, error, "save shipment drawer memo");
    return {
      group: normalizeSnapshot(result.snapshot || {}),
      drawerMemo: String(result.drawer_memo ?? ""),
      heldOrderGroupNos: (result.held_ord_nos || []).map(text).filter(Boolean),
    };
  }

  async function saveItemMemo2({
    groupId,
    orderGroupNo,
    sellpiaItemNo,
    memo2,
    eventType = null,
    quantity = null,
    drawerMemo = null,
    expectedVersion,
    autoHold = true,
    actor = "system-v3-front",
  }) {
    const { data, error } = await db.rpc("save_shipment_group_item_memo2", {
      p_group_id: text(groupId),
      p_ord_no: text(orderGroupNo),
      p_item_no: text(sellpiaItemNo),
      p_memo2: String(memo2 ?? ""),
      p_event_type: text(eventType) || null,
      p_quantity: quantity === null || quantity === undefined ? null : Number(quantity),
      p_drawer_memo: drawerMemo === null || drawerMemo === undefined ? null : String(drawerMemo),
      p_expected_version: Number(expectedVersion),
      p_auto_hold: Boolean(autoHold),
      p_updated_by: text(actor) || "system-v3-front",
    });
    const result = rpcData(data, error, "save shipment item memo2");
    return {
      item: result.item || null,
      event: result.event || null,
      heldOrderGroupNos: (result.held_ord_nos || []).map(text).filter(Boolean),
    };
  }

  return {
    loadActiveGroups,
    createGroup,
    changeRepresentative,
    releaseGroup,
    saveDrawerMemo,
    saveItemMemo2,
  };
}
