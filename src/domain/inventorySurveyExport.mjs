import {
  findOperationForCurrentItem,
  orderItemIdentity,
} from "../adapters/orderItemOperationsAdapter.mjs";

export const INVENTORY_SURVEY_EXPORT_HEADER = Object.freeze([
  "셀피아 SKU코드",
  "자사코드",
  "일반 피킹보관 수량",
  "미송서랍 보관 수량",
  "재고반영 합계",
  "집계시각",
  "주문수량",
]);

export const CURRENT_SHORTAGE_EXPORT_HEADER = Object.freeze(["셀피아 SKU", "자사코드", "미송수량"]);

function text(value) {
  return String(value ?? "").trim();
}

function nonNegativeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : 0;
}

function itemSellpiaSku(item = {}) {
  return text(
    item.sellpiaProductCode ||
      item.sellpia_p_code ||
      item.sellpia_product_code ||
      item.p_code ||
      item.product_code ||
      item.raw?.sellpia_p_code ||
      item.raw?.sellpia_product_code ||
      item.raw?.p_code ||
      item.raw?.product_code,
  );
}

function itemOwnCode(item = {}) {
  return text(
    item.ownCode ||
      item.prod_code ||
      item.own_code ||
      item.private_code ||
      item.p_dpcode ||
      item.raw?.prod_code ||
      item.raw?.own_code ||
      item.raw?.private_code ||
      item.raw?.p_dpcode,
  );
}

function itemQuantity(item = {}) {
  const value = item.quantity ?? item.qty ?? item.o_amount ?? item.raw?.quantity ?? item.raw?.qty ?? item.raw?.o_amount;
  if (value === null || value === undefined || value === "") return 1;
  return nonNegativeNumber(value);
}

function itemIdentityKey(item = {}) {
  const identity = orderItemIdentity(item);
  if (!identity.ordNo || (!identity.sellpiaOrderItemNo && !identity.itemNo)) return "";
  return `${identity.ordNo}::${identity.sellpiaOrderItemNo || identity.itemNo}`;
}

function operationHasPlacedOrder(operation = {}) {
  if (text(operation.custom_cancelled_at)) return false;
  return Boolean(text(operation.custom_ordered_on) || text(operation.custom_received_on));
}

export function inventorySurveyOrderedQuantitiesBySku({ currentItems = [], operations = [] } = {}) {
  const quantitiesBySku = new Map();
  const seenItems = new Set();

  for (const item of currentItems || []) {
    const identityKey = itemIdentityKey(item);
    if (!identityKey || seenItems.has(identityKey)) continue;
    seenItems.add(identityKey);

    const match = findOperationForCurrentItem(item, operations);
    if (match.status !== "matched" || !operationHasPlacedOrder(match.row)) continue;

    const sku = itemSellpiaSku(item);
    if (!sku) continue;
    const current = quantitiesBySku.get(sku) || { quantity: 0, ownCodes: new Set() };
    current.quantity += itemQuantity(item);
    const ownCode = itemOwnCode(item);
    if (ownCode) current.ownCodes.add(ownCode);
    quantitiesBySku.set(sku, current);
  }

  return quantitiesBySku;
}

export function inventorySurveyOwnCodesBySku(invoices = []) {
  const codesBySku = new Map();
  for (const invoice of invoices || []) {
    for (const item of invoice?.items || []) {
      const sku = itemSellpiaSku(item);
      const ownCode = itemOwnCode(item);
      if (!sku || !ownCode) continue;
      if (!codesBySku.has(sku)) codesBySku.set(sku, new Set());
      codesBySku.get(sku).add(ownCode);
    }
  }
  return new Map(
    [...codesBySku].map(([sku, codes]) => [
      sku,
      [...codes].sort((left, right) => left.localeCompare(right, "ko", { numeric: true })).join(" / "),
    ]),
  );
}

export function formatInventorySurveyCalculatedAt(value) {
  if (!text(value)) return "";
  const date = new Date(value || 0);
  if (Number.isNaN(date.getTime())) return text(value);
  const parts = new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const part = (type) => parts.find((entry) => entry.type === type)?.value || "";
  return `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")}:${part("second")}`;
}

export function buildInventorySurveyExport({ countRows = [], invoices = [], currentItems = [], operations = [] } = {}) {
  const ownCodesBySku = inventorySurveyOwnCodesBySku(invoices);
  const orderedBySku = inventorySurveyOrderedQuantitiesBySku({ currentItems, operations });
  const countsBySku = new Map();

  for (const row of countRows || []) {
    const sku = text(row?.sellpia_sku_code || row?.sellpiaSkuCode);
    if (!sku) continue;
    const current = countsBySku.get(sku) || {
      sku,
      pickedQty: 0,
      shortageDrawerQty: 0,
      orderedQty: 0,
      ownCodes: new Set(),
      calculatedAt: "",
    };
    current.pickedQty += nonNegativeNumber(row?.picked_qty ?? row?.pickedQty);
    current.shortageDrawerQty += nonNegativeNumber(row?.shortage_drawer_qty ?? row?.shortageDrawerQty);
    const serverOwnCode = text(row?.own_code || row?.ownCode);
    if (serverOwnCode) {
      for (const code of serverOwnCode.split(" / ").map((value) => text(value)).filter(Boolean)) current.ownCodes.add(code);
    }
    current.calculatedAt = current.calculatedAt || text(row?.calculated_at || row?.calculatedAt);
    countsBySku.set(sku, current);
  }

  for (const [sku, ordered] of orderedBySku) {
    const current = countsBySku.get(sku) || {
      sku,
      pickedQty: 0,
      shortageDrawerQty: 0,
      orderedQty: 0,
      ownCodes: new Set(),
      calculatedAt: "",
    };
    current.orderedQty += ordered.quantity;
    for (const ownCode of ordered.ownCodes) current.ownCodes.add(ownCode);
    countsBySku.set(sku, current);
  }

  const entries = [...countsBySku.values()]
    .filter((row) => row.pickedQty + row.shortageDrawerQty + row.orderedQty > 0)
    .sort((left, right) => left.sku.localeCompare(right.sku, "en", { numeric: true, sensitivity: "base" }));

  let missingOwnCodeCount = 0;
  const rows = entries.map((row) => {
    // The RPC derives this from the same persisted picking rows as the count.
    // Loaded invoices remain a fallback for older RPC responses only.
    const ownCode = [...row.ownCodes].sort().join(" / ") || ownCodesBySku.get(row.sku) || "";
    if (!ownCode) missingOwnCodeCount += 1;
    return [
      row.sku,
      ownCode,
      row.pickedQty,
      row.shortageDrawerQty,
      row.pickedQty + row.shortageDrawerQty,
      formatInventorySurveyCalculatedAt(row.calculatedAt),
      row.orderedQty,
    ];
  });

  return {
    rows: [INVENTORY_SURVEY_EXPORT_HEADER, ...rows],
    itemCount: rows.length,
    pickedTotal: entries.reduce((sum, row) => sum + row.pickedQty, 0),
    shortageDrawerTotal: entries.reduce((sum, row) => sum + row.shortageDrawerQty, 0),
    orderedTotal: entries.reduce((sum, row) => sum + row.orderedQty, 0),
    missingOwnCodeCount,
  };
}

export function buildCurrentShortageExport(shortageRows = []) {
  const countsBySku = new Map();
  let skippedWithoutSku = 0;

  for (const row of shortageRows || []) {
    const item = row?.item || {};
    const sku = itemSellpiaSku(item);
    if (!sku) {
      skippedWithoutSku += 1;
      continue;
    }
    const current = countsBySku.get(sku) || { sku, ownCodes: new Set(), shortageQty: 0 };
    const ownCode = itemOwnCode(item);
    if (ownCode) current.ownCodes.add(ownCode);
    const rawQty = row?.state?.shortageQty ?? row?.shortageQty ?? item?.pickingState?.shortageQty;
    current.shortageQty += Math.max(1, nonNegativeNumber(rawQty));
    countsBySku.set(sku, current);
  }

  const entries = [...countsBySku.values()]
    .filter((row) => row.shortageQty > 0)
    .sort((left, right) => left.sku.localeCompare(right.sku, "en", { numeric: true, sensitivity: "base" }));
  const rows = entries.map((row) => [
    row.sku,
    [...row.ownCodes].sort((left, right) => left.localeCompare(right, "ko", { numeric: true })).join(" / "),
    row.shortageQty,
  ]);

  return {
    rows: [CURRENT_SHORTAGE_EXPORT_HEADER, ...rows],
    itemCount: rows.length,
    shortageTotal: entries.reduce((sum, row) => sum + row.shortageQty, 0),
    missingOwnCodeCount: entries.filter((row) => row.ownCodes.size === 0).length,
    skippedWithoutSku,
  };
}
