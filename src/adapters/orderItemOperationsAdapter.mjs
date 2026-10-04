export const ORDER_ITEM_OPERATION_INBOUND_SOURCES = Object.freeze(["manual", "sku_schedule"]);

const MUTABLE_OPERATION_FIELDS = new Set([
  "custom_required_at",
  "custom_ordered_on",
  "custom_received_on",
  "custom_cancelled_at",
  "inbound_expected_date",
  "inbound_expected_source",
  "internal_memo",
]);

const SNAPSHOT_FIELDS = Object.freeze([
  "sellpia_product_code_snapshot",
  "own_code_snapshot",
  "product_name_snapshot",
  "product_option_snapshot",
  "supplier_cell_raw_snapshot",
]);

function text(value) {
  return String(value ?? "").trim();
}

function firstText(...values) {
  for (const value of values) {
    const normalized = text(value);
    if (normalized) return normalized;
  }
  return "";
}

function rawSource(value) {
  return value?.item || value?.raw || value || {};
}

function field(value, ...names) {
  const source = rawSource(value);
  const nestedRaw = source?.raw || {};
  for (const name of names) {
    const normalized = firstText(source?.[name], nestedRaw?.[name]);
    if (normalized) return normalized;
  }
  return "";
}

export function orderItemIdentity(value) {
  return {
    ordNo: field(value, "ord_no", "ordNo", "orderGroupNo"),
    sellpiaOrderItemNo: field(value, "sellpia_order_item_no", "sellpiaOrderItemNo"),
    itemNo: field(value, "item_no", "itemNo"),
  };
}

function sameRow(a, b) {
  if (a === b) return true;
  const aOperationId = field(a, "operation_id", "operationId");
  const bOperationId = field(b, "operation_id", "operationId");
  if (aOperationId && bOperationId) return aOperationId === bOperationId;
  const aIdentity = orderItemIdentity(a);
  const bIdentity = orderItemIdentity(b);
  return aIdentity.ordNo === bIdentity.ordNo
    && aIdentity.sellpiaOrderItemNo === bIdentity.sellpiaOrderItemNo
    && aIdentity.itemNo === bIdentity.itemNo;
}

export function matchOrderItemIdentity(target, candidates = []) {
  const identity = orderItemIdentity(target);
  if (!identity.ordNo || (!identity.sellpiaOrderItemNo && !identity.itemNo)) {
    return { status: "missing", matchMethod: "none", row: null, sourceMissing: true };
  }

  const sameOrder = candidates.filter((candidate) => orderItemIdentity(candidate).ordNo === identity.ordNo);
  const regularMatches = identity.sellpiaOrderItemNo
    ? sameOrder.filter((candidate) => orderItemIdentity(candidate).sellpiaOrderItemNo === identity.sellpiaOrderItemNo)
    : [];
  const itemMatches = identity.itemNo
    ? sameOrder.filter((candidate) => orderItemIdentity(candidate).itemNo === identity.itemNo)
    : [];

  if (regularMatches.length > 1 || itemMatches.length > 1) {
    return { status: "ambiguous", matchMethod: "none", row: null, sourceMissing: true };
  }
  if (regularMatches.length === 1) {
    if (itemMatches.length === 1 && !sameRow(regularMatches[0], itemMatches[0])) {
      return { status: "conflict", matchMethod: "none", row: null, sourceMissing: true };
    }
    return { status: "matched", matchMethod: "regular", row: regularMatches[0], sourceMissing: false };
  }
  if (itemMatches.length === 1) {
    return { status: "matched", matchMethod: "item_no", row: itemMatches[0], sourceMissing: false };
  }
  return { status: "missing", matchMethod: "none", row: null, sourceMissing: true };
}

export function findCurrentSourceForOperation(operation, currentItems = []) {
  return matchOrderItemIdentity(operation, currentItems);
}

export function findOperationForCurrentItem(currentItem, operations = []) {
  return matchOrderItemIdentity(currentItem, operations);
}

export function snapshotFromCurrentOrderItem(currentItem) {
  return {
    sellpia_product_code_snapshot: field(currentItem, "p_code", "sellpiaProductCode") || null,
    own_code_snapshot: field(currentItem, "p_dpcode", "prod_code", "own_code", "ownCode") || null,
    product_name_snapshot: field(currentItem, "p_name", "productName", "name") || null,
    product_option_snapshot: field(currentItem, "p_option", "productOption", "optionName") || null,
    supplier_cell_raw_snapshot: field(currentItem, "sellpia_supplier_cell_raw", "sellpiaSupplierCellRaw") || null,
  };
}

export function missingSnapshotBackfill(operation, currentItem) {
  const source = snapshotFromCurrentOrderItem(currentItem);
  return Object.fromEntries(
    SNAPSHOT_FIELDS
      .filter((name) => !text(operation?.[name]) && text(source[name]))
      .map((name) => [name, source[name]]),
  );
}

export function resolveOperationDisplayFields({ operation = null, currentItem = null } = {}) {
  const snapshot = operation || {};
  return {
    sellpiaProductCode: field(currentItem, "p_code", "sellpiaProductCode") || text(snapshot.sellpia_product_code_snapshot),
    ownCode: field(currentItem, "p_dpcode", "prod_code", "own_code", "ownCode") || text(snapshot.own_code_snapshot),
    productName: field(currentItem, "p_name", "productName", "name") || text(snapshot.product_name_snapshot),
    productOption: field(currentItem, "p_option", "productOption", "optionName") || text(snapshot.product_option_snapshot),
    supplierCellRaw: field(currentItem, "sellpia_supplier_cell_raw", "sellpiaSupplierCellRaw") || text(snapshot.supplier_cell_raw_snapshot),
    sourceMissing: !currentItem,
  };
}

function normalizedDate(value) {
  const normalized = text(value);
  return /^\d{4}-\d{2}-\d{2}$/.test(normalized) ? normalized : "";
}

export function resolveEffectiveInboundExpectedDate({ operation = null, currentItem = null, skuSchedule = null } = {}) {
  const source = text(operation?.inbound_expected_source).toLowerCase();
  if (source) {
    if (!ORDER_ITEM_OPERATION_INBOUND_SOURCES.includes(source)) {
      throw new Error(`Unsupported inbound_expected_source: ${source}`);
    }
    const date = normalizedDate(operation?.inbound_expected_date);
    return {
      date,
      source,
      authoritative: true,
      explicitlyCleared: source === "manual" && !date,
    };
  }
  const scheduleDate = normalizedDate(skuSchedule?.inbound_expected_date ?? skuSchedule?.inboundExpectedDate);
  if (scheduleDate) {
    return {
      date: scheduleDate,
      source: "sku_schedule",
      authoritative: true,
      explicitlyCleared: false,
    };
  }
  const legacyDate = normalizedDate(field(
    currentItem,
    "sellpia_outbound_confirmed_date",
    "sellpiaOutboundConfirmedDate",
    "outbound_confirmed_date",
  ));
  return {
    date: legacyDate,
    source: legacyDate ? "legacy_sellpia" : "",
    authoritative: false,
    explicitlyCleared: false,
  };
}

function requiredIdentity(value) {
  const identity = orderItemIdentity(value);
  if (!identity.ordNo) throw new Error("ord_no is required.");
  if (!identity.sellpiaOrderItemNo && !identity.itemNo) {
    throw new Error("sellpia_order_item_no or item_no is required.");
  }
  return identity;
}

function mutablePatch(input = {}) {
  const patch = {};
  for (const [name, value] of Object.entries(input)) {
    if (MUTABLE_OPERATION_FIELDS.has(name)) patch[name] = value;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "inbound_expected_source")) {
    const source = text(patch.inbound_expected_source).toLowerCase();
    if (source && !ORDER_ITEM_OPERATION_INBOUND_SOURCES.includes(source)) {
      throw new Error(`Unsupported inbound_expected_source: ${source}`);
    }
    patch.inbound_expected_source = source || null;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "inbound_expected_date")) {
    const date = text(patch.inbound_expected_date);
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("inbound_expected_date must be YYYY-MM-DD or null.");
    patch.inbound_expected_date = date || null;
  }
  return patch;
}

function oneRow(data, error, label) {
  if (error) throw error;
  if (!data || data.length !== 1) throw new Error(`${label}: expected exactly one row.`);
  return data[0];
}

export function createOrderItemOperationsAdapter(db) {
  if (!db?.from) throw new Error("A Supabase client is required.");

  async function loadAllOperations(pageSize = 1000) {
    const rows = [];
    for (let offset = 0; ; offset += pageSize) {
      const { data, error } = await db
        .from("order_item_operations")
        .select("*")
        .order("created_at", { ascending: true })
        .range(offset, offset + pageSize - 1);
      if (error) throw error;
      const page = data || [];
      rows.push(...page);
      if (page.length < pageSize) return rows;
    }
  }

  async function loadOperationsForOrder(ordNo) {
    const normalized = text(ordNo);
    if (!normalized) return [];
    const { data, error } = await db
      .from("order_item_operations")
      .select("*")
      .eq("ord_no", normalized);
    if (error) throw error;
    return data || [];
  }

  async function loadOperationsForOrders(ordNos = []) {
    const normalized = [...new Set(ordNos.map(text).filter(Boolean))];
    if (!normalized.length) return [];
    const rows = [];
    const batchSize = 200;
    for (let offset = 0; offset < normalized.length; offset += batchSize) {
      const { data, error } = await db
        .from("order_item_operations")
        .select("*")
        .in("ord_no", normalized.slice(offset, offset + batchSize));
      if (error) throw error;
      rows.push(...(data || []));
    }
    return rows;
  }

  async function loadCustomOrderOperations(pageSize = 1000) {
    const rows = [];
    for (let offset = 0; ; offset += pageSize) {
      const { data, error } = await db
        .from("order_item_operations")
        .select("*")
        .not("custom_required_at", "is", null)
        .order("custom_required_at", { ascending: false })
        .range(offset, offset + pageSize - 1);
      if (error) throw error;
      const page = data || [];
      rows.push(...page);
      if (page.length < pageSize) return rows;
    }
  }

  async function loadInboundExpectedOperations(pageSize = 1000) {
    const rows = [];
    for (let offset = 0; ; offset += pageSize) {
      const { data, error } = await db
        .from("order_item_operations")
        .select("*")
        .not("inbound_expected_source", "is", null)
        .order("updated_at", { ascending: false })
        .range(offset, offset + pageSize - 1);
      if (error) throw error;
      const page = data || [];
      rows.push(...page);
      if (page.length < pageSize) return rows;
    }
  }

  async function loadLegacyInboundExpectedItems(pageSize = 1000) {
    const rows = [];
    for (let offset = 0; ; offset += pageSize) {
      const { data, error } = await db
        .from("order_items")
        .select("*")
        .not("sellpia_outbound_confirmed_date", "is", null)
        .order("sellpia_outbound_confirmed_date", { ascending: true })
        .range(offset, offset + pageSize - 1);
      if (error) throw error;
      const page = data || [];
      rows.push(...page);
      if (page.length < pageSize) return rows;
    }
  }

  async function loadCurrentItemsForOperations(operations = []) {
    const ordNos = [...new Set(operations.map((operation) => orderItemIdentity(operation).ordNo).filter(Boolean))];
    if (!ordNos.length) return [];
    const rows = [];
    const batchSize = 200;
    for (let offset = 0; offset < ordNos.length; offset += batchSize) {
      const { data, error } = await db
        .from("order_items")
        .select("*")
        .in("ord_no", ordNos.slice(offset, offset + batchSize));
      if (error) throw error;
      rows.push(...(data || []));
    }
    return rows;
  }

  async function loadCustomOrderWorkspace() {
    const [customOperations, inboundOperations, legacyInboundItems] = await Promise.all([
      loadCustomOrderOperations(),
      loadInboundExpectedOperations(),
      loadLegacyInboundExpectedItems(),
    ]);
    const operations = [...new Map(
      [...customOperations, ...inboundOperations]
        .map((operation) => [text(operation.operation_id), operation]),
    ).values()];
    const operationItems = await loadCurrentItemsForOperations(operations);
    const currentItems = [...new Map(
      [...operationItems, ...legacyInboundItems]
        .map((item) => {
          const identity = orderItemIdentity(item);
          return [`${identity.ordNo}::${identity.sellpiaOrderItemNo || identity.itemNo}`, item];
        }),
    ).values()];
    return { operations, currentItems };
  }

  async function getOperationForCurrentOrderItem(currentItem, { operations } = {}) {
    const identity = requiredIdentity(currentItem);
    const candidates = operations || await loadOperationsForOrder(identity.ordNo);
    return findOperationForCurrentItem(currentItem, candidates);
  }

  async function upsertOperationForCurrentOrderItem(currentItem, inputPatch = {}) {
    const identity = requiredIdentity(currentItem);
    const patch = mutablePatch(inputPatch);
    const operations = await loadOperationsForOrder(identity.ordNo);
    const match = findOperationForCurrentItem(currentItem, operations);
    if (match.status === "ambiguous" || match.status === "conflict") {
      throw new Error(`Order item operation identity is ${match.status}; automatic save refused.`);
    }
    if (match.status === "matched") {
      const { data, error } = await db
        .from("order_item_operations")
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq("operation_id", match.row.operation_id)
        .select("*");
      return oneRow(data, error, "update order item operation");
    }
    const payload = {
      ord_no: identity.ordNo,
      sellpia_order_item_no: identity.sellpiaOrderItemNo || null,
      item_no: identity.itemNo || null,
      ...snapshotFromCurrentOrderItem(currentItem),
      ...patch,
    };
    const { data, error } = await db.from("order_item_operations").insert(payload).select("*");
    return oneRow(data, error, "create order item operation");
  }

  async function updateOperation(operationId, inputPatch = {}) {
    const normalizedId = text(operationId);
    if (!normalizedId) throw new Error("operation_id is required.");
    const patch = mutablePatch(inputPatch);
    if (!Object.keys(patch).length) throw new Error("No mutable operation fields were provided.");
    const { data, error } = await db
      .from("order_item_operations")
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq("operation_id", normalizedId)
      .select("*");
    return oneRow(data, error, "update order item operation");
  }

  async function backfillMissingSnapshots(operation, currentItems = []) {
    const match = findCurrentSourceForOperation(operation, currentItems);
    if (match.status !== "matched") return { operation, match, updated: false };
    const patch = missingSnapshotBackfill(operation, match.row);
    if (!Object.keys(patch).length) return { operation, match, updated: false };
    const { data, error } = await db
      .from("order_item_operations")
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq("operation_id", operation.operation_id)
      .select("*");
    return { operation: oneRow(data, error, "backfill order item operation snapshots"), match, updated: true };
  }

  return {
    loadAllOperations,
    loadOperationsForOrder,
    loadOperationsForOrders,
    loadCustomOrderOperations,
    loadInboundExpectedOperations,
    loadLegacyInboundExpectedItems,
    loadCurrentItemsForOperations,
    loadCustomOrderWorkspace,
    getOperationForCurrentOrderItem,
    upsertOperationForCurrentOrderItem,
    updateOperation,
    backfillMissingSnapshots,
    findCurrentSourceForOperation,
    resolveEffectiveInboundExpectedDate,
    resolveOperationDisplayFields,
  };
}
