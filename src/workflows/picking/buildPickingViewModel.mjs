import {
  makeItemStateKey,
  normalizeCurrentDbItem,
  normalizeCurrentDbOrder,
  normalizePickingState,
} from "../../adapters/currentDbPickingAdapter.mjs?v=20260706-memo2-text1";
import { preferredPickingRow } from "../../domain/pickingPersistence.mjs?v=20260807-picking-dedupe1";

function compareNullableNumbers(a, b) {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a - b;
}

function compareItems(a, b) {
  const rowOrder = compareNullableNumbers(a.sortOrder, b.sortOrder);
  if (rowOrder !== 0) return rowOrder;
  return compareNullableNumbers(a.itemOrderIndex, b.itemOrderIndex);
}

function normalizeInvoiceItems(items = []) {
  return [...items].sort(compareItems).map((item, index) => ({
    ...item,
    sourceItemOrderIndex: item.itemOrderIndex,
    itemOrderIndex: index + 1,
  }));
}

function sessionRank(value) {
  const session = String(value || "").trim().toUpperCase();
  if (session === "AM" || session === "오전") return 0;
  if (session === "PM" || session === "오후") return 1;
  return 2;
}

function compareInvoices(a, b) {
  const session = sessionRank(a.session) - sessionRank(b.session);
  if (session !== 0) return session;
  const sort = compareNullableNumbers(a.sortOrder, b.sortOrder);
  if (sort !== 0) return sort;
  return String(a.orderGroupNo).localeCompare(String(b.orderGroupNo), "ko");
}

export function buildPickingViewModel({
  orders = [],
  orderItems = [],
  pickingRows = [],
  shortageRows = [],
} = {}) {
  const pickingStateByKey = new Map();
  const shortageStateByKey = new Map();

  const pickingRowsByKey = new Map();
  for (const row of pickingRows) {
    const state = normalizePickingState(row);
    if (!pickingRowsByKey.has(state.key)) pickingRowsByKey.set(state.key, []);
    pickingRowsByKey.get(state.key).push(row);
  }
  for (const rows of pickingRowsByKey.values()) {
    const state = normalizePickingState(preferredPickingRow(rows));
    pickingStateByKey.set(state.key, state);
  }

  for (const row of shortageRows) {
    const state = normalizePickingState(row);
    shortageStateByKey.set(state.key, state);
  }

  const invoiceByGroup = new Map();
  for (const order of orders.map(normalizeCurrentDbOrder)) {
    if (!order.orderGroupNo) continue;
    invoiceByGroup.set(order.orderGroupNo, { ...order, items: [] });
  }

  for (const item of orderItems.map(normalizeCurrentDbItem)) {
    if (!item.orderGroupNo || !item.sellpiaItemNo) continue;

    if (!invoiceByGroup.has(item.orderGroupNo)) {
      invoiceByGroup.set(item.orderGroupNo, {
        orderGroupNo: item.orderGroupNo,
        invoiceNo: item.invoiceNo,
        recipientName: "",
        buyerName: "",
        displayName: "",
        csDisplayName: "",
        seller: "",
        recipientPhone: "",
        buyerPhone: "",
        orderTotalAmount: null,
        receiptDate: "",
        sellpiaMemo1: "",
        orderMemo: "",
        sortOrder: null,
        raw: null,
        items: [],
      });
    }

    const key = makeItemStateKey(item.orderGroupNo, item.sellpiaItemNo);
    const pickingState = pickingStateByKey.get(key) || null;
    const shortageState = shortageStateByKey.get(key) || null;

    invoiceByGroup.get(item.orderGroupNo).items.push({
      ...item,
      pickingState,
      shortageState,
    });
  }

  const invoices = Array.from(invoiceByGroup.values())
    .map((invoice) => ({
      ...invoice,
      items: normalizeInvoiceItems(invoice.items),
    }))
    .sort(compareInvoices);

  return {
    version: "2026-06-30.1",
    invoices,
    totals: {
      invoices: invoices.length,
      items: invoices.reduce((sum, invoice) => sum + invoice.items.length, 0),
    },
  };
}
