import assert from "node:assert/strict";
import { createShipmentGroupAdapter } from "../src/adapters/shipmentGroupAdapter.mjs";

function queryResult(data) {
  const api = {
    select() { return api; },
    eq() { return api; },
    in() { return api; },
    order() { return api; },
    then(resolve) { resolve({ data, error: null }); },
  };
  return api;
}

const groupRow = {
  id: "00000000-0000-4000-8000-000000000001",
  representative_ord_no: "order-a",
  target_inv_no: "invoice-a",
  status: "active",
  sync_status: "pending",
  version: 1,
};
const memberRows = [
  { group_id: groupRow.id, ord_no: "order-a", original_inv_no: "invoice-a", member_order: 1, active: true },
  { group_id: groupRow.id, ord_no: "order-b", original_inv_no: "invoice-b", member_order: 2, active: true },
];
const calls = [];
const db = {
  from(table) {
    if (table === "shipment_groups") return queryResult([groupRow]);
    if (table === "shipment_group_members") return queryResult(memberRows);
    throw new Error(`unexpected table ${table}`);
  },
  async rpc(name, args) {
    calls.push({ name, args });
    const nextGroup = {
      ...groupRow,
      representative_ord_no: args.p_representative_ord_no || groupRow.representative_ord_no,
      status: name === "release_shipment_group" ? "released" : "active",
      version: groupRow.version + (name === "create_shipment_group" ? 0 : 1),
    };
    return { data: { group: nextGroup, members: memberRows }, error: null };
  },
};

const adapter = createShipmentGroupAdapter(db);
const loaded = await adapter.loadActiveGroups();
assert.equal(loaded.length, 1);
assert.deepEqual(loaded[0].members.map((row) => row.orderGroupNo), ["order-a", "order-b"]);

await adapter.createGroup({ orderGroupNos: ["order-a", "order-a", "order-b"], representativeOrderGroupNo: "order-a" });
assert.deepEqual(calls[0], {
  name: "create_shipment_group",
  args: {
    p_ord_nos: ["order-a", "order-b"],
    p_representative_ord_no: "order-a",
    p_created_by: "system-v3-front",
  },
});

await adapter.changeRepresentative({ groupId: groupRow.id, representativeOrderGroupNo: "order-b", expectedVersion: 1 });
assert.equal(calls[1].name, "change_shipment_representative");
assert.equal(calls[1].args.p_expected_version, 1);

await adapter.releaseGroup({ groupId: groupRow.id, expectedVersion: 2 });
assert.equal(calls[2].name, "release_shipment_group");
assert.equal(calls[2].args.p_expected_version, 2);

await adapter.saveDrawerMemo({ groupId: groupRow.id, drawerMemo: "416", expectedVersion: 1 });
assert.equal(calls[3].name, "save_shipment_group_drawer_memo");
assert.equal(calls[3].args.p_drawer_memo, "416");

await adapter.saveItemMemo2({
  groupId: groupRow.id,
  orderGroupNo: "order-a",
  sellpiaItemNo: "item-a",
  memo2: "1",
  eventType: "shortage_created",
  quantity: 1,
  expectedVersion: 1,
});
assert.equal(calls[4].name, "save_shipment_group_item_memo2");
assert.equal(calls[4].args.p_ord_no, "order-a");
assert.equal(calls[4].args.p_item_no, "item-a");

await assert.rejects(
  () => adapter.createGroup({ orderGroupNos: ["order-a"], representativeOrderGroupNo: "order-a" }),
  /2건 이상/,
);

console.log("Shipment group adapter regression: passed");
