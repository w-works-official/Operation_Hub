import {
  findCurrentSourceForOperation,
  findOperationForCurrentItem,
  orderItemIdentity,
  resolveEffectiveInboundExpectedDate,
  resolveOperationDisplayFields,
} from "../adapters/orderItemOperationsAdapter.mjs";
import {
  buildSkuInboundScheduleMap,
  findSkuInboundSchedule,
} from "./skuInboundSchedule.mjs";

export const CUSTOM_ORDER_STATUS = Object.freeze({
  BEFORE_ORDER: "before_order",
  ORDERED: "ordered",
  WAITING: "waiting",
  RECEIVED: "received",
  CANCELLED: "cancelled",
});

export const CUSTOM_ORDER_STATUS_LABEL = Object.freeze({
  [CUSTOM_ORDER_STATUS.BEFORE_ORDER]: "주문 전",
  [CUSTOM_ORDER_STATUS.ORDERED]: "주문완",
  [CUSTOM_ORDER_STATUS.WAITING]: "주문완 · 입고 대기",
  [CUSTOM_ORDER_STATUS.RECEIVED]: "입고 완료",
  [CUSTOM_ORDER_STATUS.CANCELLED]: "취소",
});

function text(value) {
  return String(value ?? "").trim();
}

export function customOrderStatus(operation = {}, inbound = null) {
  if (text(operation.custom_cancelled_at)) return CUSTOM_ORDER_STATUS.CANCELLED;
  if (text(operation.custom_received_on)) return CUSTOM_ORDER_STATUS.RECEIVED;
  if (text(operation.custom_ordered_on) && text(inbound?.date ?? operation.inbound_expected_date)) return CUSTOM_ORDER_STATUS.WAITING;
  if (text(operation.custom_ordered_on)) return CUSTOM_ORDER_STATUS.ORDERED;
  if (text(operation.custom_required_at)) return CUSTOM_ORDER_STATUS.BEFORE_ORDER;
  return "";
}

export function canClearCustomRequired(operation = {}) {
  return Boolean(text(operation.custom_required_at))
    && !text(operation.custom_ordered_on)
    && !text(operation.custom_received_on)
    && !text(operation.custom_cancelled_at)
    && !text(operation.internal_memo)
    && !text(operation.inbound_expected_source);
}

function datePart(value) {
  const normalized = text(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return normalized;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return "";
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

export function buildCustomOrderRows({ operations = [], currentItems = [], skuSchedules = [] } = {}) {
  const scheduleMap = buildSkuInboundScheduleMap(skuSchedules);
  return operations
    .filter((operation) => text(operation.custom_required_at))
    .map((operation) => {
      const match = findCurrentSourceForOperation(operation, currentItems);
      const currentItem = match.status === "matched" ? match.row : null;
      const display = resolveOperationDisplayFields({ operation, currentItem });
      const skuSchedule = findSkuInboundSchedule(display.sellpiaProductCode, scheduleMap);
      const inbound = resolveEffectiveInboundExpectedDate({ operation, currentItem, skuSchedule });
      return {
        operation,
        currentItem,
        match,
        display,
        inbound,
        status: customOrderStatus(operation, inbound),
        sourceMissing: match.status !== "matched",
      };
    });
}

export function addCalendarDays(value, days) {
  const normalized = datePart(value);
  const count = Number(days);
  if (!normalized || !Number.isFinite(count)) return "";
  const [year, month, day] = normalized.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + Math.trunc(count));
  return date.toISOString().slice(0, 10);
}

function identityKey(value) {
  const identity = orderItemIdentity(value);
  return `${identity.ordNo}::${identity.sellpiaOrderItemNo || identity.itemNo}`;
}

export function buildInboundExpectedRows({ operations = [], currentItems = [], skuSchedules = [] } = {}) {
  const rows = [];
  const scheduleMap = buildSkuInboundScheduleMap(skuSchedules);
  const usedOperationIds = new Set();
  const usedCurrentItemKeys = new Set();

  for (const currentItem of currentItems) {
    const operationMatch = findOperationForCurrentItem(currentItem, operations);
    const operation = operationMatch.status === "matched" ? operationMatch.row : null;
    const display = resolveOperationDisplayFields({ operation, currentItem });
    const skuSchedule = findSkuInboundSchedule(display.sellpiaProductCode, scheduleMap);
    const inbound = resolveEffectiveInboundExpectedDate({ operation, currentItem, skuSchedule });
    if (!inbound.source && !inbound.date) continue;
    const key = identityKey(currentItem);
    usedCurrentItemKeys.add(key);
    if (operation?.operation_id) usedOperationIds.add(text(operation.operation_id));
    rows.push({
      key,
      operation,
      currentItem,
      display,
      inbound,
      sourceMissing: false,
      identityIssue: ["ambiguous", "conflict"].includes(operationMatch.status),
    });
  }

  for (const operation of operations) {
    const operationId = text(operation.operation_id);
    if (usedOperationIds.has(operationId)) continue;
    const sourceMatch = findCurrentSourceForOperation(operation, currentItems);
    const currentItem = sourceMatch.status === "matched" ? sourceMatch.row : null;
    const key = currentItem ? identityKey(currentItem) : identityKey(operation);
    if (usedCurrentItemKeys.has(key)) continue;
    const display = resolveOperationDisplayFields({ operation, currentItem });
    const skuSchedule = findSkuInboundSchedule(display.sellpiaProductCode, scheduleMap);
    const inbound = resolveEffectiveInboundExpectedDate({ operation, currentItem, skuSchedule });
    if (!inbound.source && !inbound.date) continue;
    rows.push({
      key,
      operation,
      currentItem,
      display,
      inbound,
      sourceMissing: sourceMatch.status !== "matched",
      identityIssue: ["ambiguous", "conflict"].includes(sourceMatch.status),
    });
  }

  return sortInboundExpectedRows(rows, "asc");
}

export function sortInboundExpectedRows(rows = [], direction = "asc") {
  const descending = text(direction).toLowerCase() === "desc";
  return [...rows].sort((left, right) => {
    const leftDate = datePart(left.inbound?.date);
    const rightDate = datePart(right.inbound?.date);
    if (!leftDate && !rightDate) return left.key.localeCompare(right.key, "ko");
    if (!leftDate) return 1;
    if (!rightDate) return -1;
    const dateOrder = leftDate.localeCompare(rightDate);
    return (descending ? -dateOrder : dateOrder) || left.key.localeCompare(right.key, "ko");
  });
}

export function customOrderDate(row, criterion) {
  const operation = row?.operation || {};
  if (criterion === "ordered") return datePart(operation.custom_ordered_on);
  if (criterion === "inbound") return datePart(row?.inbound?.date);
  if (criterion === "received") return datePart(operation.custom_received_on);
  return datePart(operation.custom_required_at);
}

export function customOrderSearchText(row) {
  const operation = row?.operation || {};
  const identity = orderItemIdentity(row?.operation || row?.currentItem || {});
  const display = row?.display || {};
  return [
    identity.ordNo,
    identity.sellpiaOrderItemNo,
    identity.itemNo,
    display.sellpiaProductCode,
    display.ownCode,
    display.productName,
    display.productOption,
    display.supplierCellRaw,
    operation.internal_memo,
  ].map(text).join(" ").toLocaleLowerCase("ko");
}

export function filterInboundExpectedRows(rows = [], filters = {}) {
  const source = text(filters.source) || "all";
  const supplier = text(filters.supplier);
  const query = text(filters.search).toLocaleLowerCase("ko");
  const from = datePart(filters.dateFrom);
  const to = datePart(filters.dateTo);

  return rows.filter((row) => {
    if (source === "cleared" && !row.inbound?.explicitlyCleared) return false;
    if (source !== "all" && source !== "cleared" && row.inbound?.source !== source) return false;
    if (supplier && text(row.display?.supplierCellRaw) !== supplier) return false;
    if (query && !customOrderSearchText(row).includes(query)) return false;
    if (from || to) {
      const value = datePart(row.inbound?.date);
      if (!value || (from && value < from) || (to && value > to)) return false;
    }
    return true;
  });
}

export function filterCustomOrderRows(rows = [], filters = {}) {
  const status = text(filters.status) || "active";
  const supplier = text(filters.supplier);
  const query = text(filters.search).toLocaleLowerCase("ko");
  const from = datePart(filters.dateFrom);
  const to = datePart(filters.dateTo);
  const criterion = text(filters.dateCriterion) || "required";

  return rows.filter((row) => {
    if (status === "active" && [CUSTOM_ORDER_STATUS.RECEIVED, CUSTOM_ORDER_STATUS.CANCELLED].includes(row.status)) return false;
    if (status !== "active" && status !== "all" && row.status !== status) return false;
    if (supplier && text(row.display?.supplierCellRaw) !== supplier) return false;
    if (query && !customOrderSearchText(row).includes(query)) return false;
    if (from || to) {
      const value = customOrderDate(row, criterion);
      if (!value || (from && value < from) || (to && value > to)) return false;
    }
    return true;
  });
}

export function customOrderSuppliers(rows = []) {
  return [...new Set(rows.map((row) => text(row.display?.supplierCellRaw)).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right, "ko"));
}
