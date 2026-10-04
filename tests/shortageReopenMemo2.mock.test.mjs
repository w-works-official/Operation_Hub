import assert from "node:assert/strict";
import fs from "node:fs";

const appSource = fs.readFileSync(new URL("../src/app/pickingApp.mjs", import.meta.url), "utf8");
const start = appSource.indexOf("async function reopenShortageRepick");
const end = appSource.indexOf("\nasync function saveSelectedShortageMemo", start);
assert.ok(start >= 0 && end > start, "reopenShortageRepick source must exist");
const reopenSource = appSource.slice(start, end);

function buildReopenHarness(overrides = {}) {
  const invoice = {
    orderGroupNo: "order-1",
    sellpiaMemo1: "drawer-7",
    items: [],
  };
  const item = {
    sellpiaItemNo: "item-3",
    sellpiaMemo2: "",
    pickingState: { drawerMemo: "drawer-7" },
  };
  invoice.items.push(item);

  const calls = [];
  const toasts = [];
  const state = {
    saving: new Set(),
    activeTab: "inspection",
    selectedShortageKey: "",
    selectedInspectionGroup: "order-1",
  };
  const dependencies = {
    findWorkflowInvoiceItem: () => ({ invoice, item }),
    toast: (message) => toasts.push(message),
    workflowItemState: () => ({ shortageRepicked: true, cancelled: false, drawerMemo: "drawer-7" }),
    workflowItemKey: () => "order-1::item-3",
    state,
    itemManagementMemo2: () => "",
    previousShortageQuantity: () => 3,
    updateOrderItemMemoFields: async (orderGroupNo, sellpiaItemNo, patch) => {
      calls.push({ type: "memo2", orderGroupNo, sellpiaItemNo, patch });
    },
    saveWorkflowItemEvent: async (_invoice, _item, eventType, payload) => {
      calls.push({ type: "event", eventType, payload });
      return true;
    },
    patchLocalItemManagementMemos: (orderGroupNo, sellpiaItemNo, patch) => {
      calls.push({ type: "local", orderGroupNo, sellpiaItemNo, patch });
    },
    ensureShippingHoldOnAfterMemoSave: async () => false,
    renderWorkflowSurfaces: () => calls.push({ type: "render" }),
    ...overrides,
  };

  const names = Object.keys(dependencies);
  const values = Object.values(dependencies);
  const reopen = new Function(...names, `${reopenSource}; return reopenShortageRepick;`)(...values);
  return { reopen, calls, invoice, item, state, toasts };
}

{
  const harness = buildReopenHarness();
  const result = await harness.reopen("order-1", "item-3");

  assert.equal(result, true);
  assert.deepEqual(harness.calls.slice(0, 3), [
    { type: "memo2", orderGroupNo: "order-1", sellpiaItemNo: "item-3", patch: { o_shop_memo2: "3" } },
    { type: "event", eventType: "shortage_created", payload: { quantity: 3, memo: "3", drawerMemo: "drawer-7" } },
    { type: "local", orderGroupNo: "order-1", sellpiaItemNo: "item-3", patch: { memo2: "3" } },
  ]);
  assert.equal(harness.state.activeTab, "shortage");
  assert.equal(harness.state.selectedShortageKey, "order-1::item-3");
  assert.equal(harness.state.saving.size, 0);
  assert.match(harness.toasts.at(-1), /관리메모2를 3/);
}

{
  const harness = buildReopenHarness({
    saveWorkflowItemEvent: async () => false,
  });
  const result = await harness.reopen("order-1", "item-3");

  assert.equal(result, false);
  assert.deepEqual(harness.calls, [
    { type: "memo2", orderGroupNo: "order-1", sellpiaItemNo: "item-3", patch: { o_shop_memo2: "3" } },
    { type: "memo2", orderGroupNo: "order-1", sellpiaItemNo: "item-3", patch: { o_shop_memo2: "" } },
  ]);
  assert.equal(harness.state.activeTab, "inspection");
  assert.equal(harness.state.saving.size, 0);
}

console.log("Shortage completion reopen restores memo2 and rolls back on event failure: passed");
