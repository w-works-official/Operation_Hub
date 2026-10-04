export const CS_CASE_STATUSES = Object.freeze(["pending", "resolved", "excluded"]);
export const CS_CASE_SOURCES = Object.freeze(["auto", "manual"]);
export const CS_CASE_BASIS_SOURCES = Object.freeze(["receipt_date", "manual", "shortage_detected", "hold_detected"]);

function text(value) {
  return String(value ?? "").trim();
}

function nonEmpty(value, label) {
  const normalized = text(value);
  if (!normalized) throw new Error(`${label} is required.`);
  return normalized;
}

function oneRow(data, error, label) {
  if (error) throw error;
  if (!data || data.length !== 1) throw new Error(`${label}: expected exactly one row.`);
  return data[0];
}

export function csCaseNaturalKey({ ordNo, itemNo, caseType }) {
  return `${text(ordNo)}\u0000${text(itemNo)}\u0000${text(caseType)}`;
}

export function openShortageItemKeys({ candidates = [], shortageRows = [] } = {}) {
  const keys = new Set();
  const add = (ordNo, itemNo) => {
    const ord = text(ordNo);
    const item = text(itemNo);
    if (ord && item) keys.add(`${ord}::${item}`);
  };

  // The current memo2 value is the scrape-time shortage baseline.  It is
  // intentionally item-scoped: one item's shortage must not make siblings
  // appear in CS.
  for (const row of candidates) {
    if (!text(row?.item?.o_shop_memo2)) continue;
    add(row?.order?.ord_no || row?.item?.ord_no, row?.item?.item_no);
    add(row?.order?.ord_no || row?.item?.ord_no, row?.item?.sellpia_order_item_no);
  }

  // Some legacy/current shortages do not have memo2 populated, so retain the
  // shortage table as an additional (not mandatory) open-state signal.
  for (const row of shortageRows) {
    if (!(Number(row?.short_qty) > 0)) continue;
    add(row?.ord_no, row?.item_no);
  }
  return keys;
}

export function createCsCaseAdapter(db) {
  if (!db?.from) throw new Error("A Supabase client is required.");

  async function loadAllRows(table, orderColumn, pageSize = 1000) {
    const rows = [];
    for (let offset = 0; ; offset += pageSize) {
      const { data, error } = await db
        .from(table)
        .select("*")
        .order(orderColumn, { ascending: true })
        .range(offset, offset + pageSize - 1);
      if (error) throw error;
      const page = data || [];
      rows.push(...page);
      if (page.length < pageSize) return rows;
    }
  }

  async function loadCsCases() {
    const { data, error } = await db
      .from("cs_cases")
      .select("*")
      .order("updated_at", { ascending: false })
      .order("id", { ascending: false });
    if (error) throw error;
    return data || [];
  }

  async function loadCsCaseContexts(caseRows = []) {
    const ordNos = [...new Set(caseRows.map((row) => text(row?.ord_no)).filter(Boolean))];
    const itemNos = [...new Set(caseRows.map((row) => text(row?.item_no)).filter(Boolean))];
    const [orderResult, itemResult] = await Promise.all([
      ordNos.length ? db.from("orders").select("*").in("ord_no", ordNos) : Promise.resolve({ data: [], error: null }),
      itemNos.length ? db.from("order_items").select("*").in("item_no", itemNos) : Promise.resolve({ data: [], error: null }),
    ]);
    if (orderResult.error) throw orderResult.error;
    if (itemResult.error) throw itemResult.error;
    return {
      orders: new Map((orderResult.data || []).map((row) => [text(row.ord_no), row])),
      items: new Map((itemResult.data || []).map((row) => [text(row.item_no), row])),
    };
  }

  async function loadManualCsCandidates() {
    const [orders, items] = await Promise.all([
      loadAllRows("orders", "ord_no"),
      loadAllRows("order_items", "item_no"),
    ]);
    const orderByNo = new Map(orders.map((row) => [text(row.ord_no), row]));
    return items
      .map((item) => ({ order: orderByNo.get(text(item.ord_no)) || null, item }))
      .filter((row) => row.order && text(row.item?.item_no));
  }

  async function loadOpenShortageItemKeys(candidates = []) {
    const { data, error } = await db
      .from("shortage")
      .select("ord_no,item_no,short_qty")
      .gt("short_qty", 0);
    if (error) throw error;
    return openShortageItemKeys({ candidates, shortageRows: data || [] });
  }

  async function findCsCase({ ordNo, itemNo, caseType }) {
    const { data, error } = await db
      .from("cs_cases")
      .select("*")
      .eq("ord_no", nonEmpty(ordNo, "ord_no"))
      .eq("item_no", nonEmpty(itemNo, "item_no"))
      .eq("case_type", nonEmpty(caseType, "case_type"));
    if (error) throw error;
    if (!data?.length) return null;
    if (data.length !== 1) throw new Error("CS case identity is ambiguous.");
    return data[0];
  }

  async function createManualCsCase(input) {
    const payload = {
      ord_no: nonEmpty(input.ordNo, "ord_no"),
      item_no: nonEmpty(input.itemNo, "item_no"),
      sellpia_order_item_no: text(input.sellpiaOrderItemNo) || null,
      inv_no: text(input.invNo) || null,
      receipt_date: text(input.receiptDate) || null,
      case_type: nonEmpty(input.caseType, "case_type"),
      status: "pending",
      source: "manual",
      basis_date: text(input.basisDate) || null,
      basis_date_source: input.basisDateSource === "manual" ? "manual" : "receipt_date",
      assigned_to: text(input.assignedTo) || null,
      created_by: text(input.createdBy) || null,
      updated_by: text(input.updatedBy) || null,
    };
    const existing = await findCsCase({ ordNo: payload.ord_no, itemNo: payload.item_no, caseType: payload.case_type });
    if (existing) {
      // 제외/해결했던 같은 상품행의 별도 CS를 다시 추가하면 새 행을
      // 만들지 않고 기존 수동 케이스만 진행 상태로 복구한다.
      if (existing.source === "manual" && existing.status !== "pending") {
        return {
          caseRow: await reopenCsCase(existing.id, payload.updated_by || ""),
          created: false,
          reopened: true,
        };
      }
      return { caseRow: existing, created: false, reopened: false };
    }
    const { data, error } = await db.from("cs_cases").insert(payload).select("*");
    return { caseRow: oneRow(data, error, "create CS case"), created: true };
  }

  async function createAutoShortageCsCase(input) {
    const payload = {
      ord_no: nonEmpty(input.ordNo, "ord_no"),
      item_no: nonEmpty(input.itemNo, "item_no"),
      sellpia_order_item_no: text(input.sellpiaOrderItemNo) || null,
      inv_no: text(input.invNo) || null,
      receipt_date: text(input.receiptDate) || null,
      case_type: "shortage",
      status: "pending",
      source: "auto",
      basis_date: text(input.basisDate) || null,
      basis_date_source: input.basisDateSource === "shortage_detected" ? "shortage_detected" : "receipt_date",
      alimtalk_template: text(input.alimtalkTemplate) || null,
    };
    const existing = await findCsCase({ ordNo: payload.ord_no, itemNo: payload.item_no, caseType: payload.case_type });
    if (existing) return { caseRow: existing, created: false };
    const { data, error } = await db.from("cs_cases").insert(payload).select("*");
    return { caseRow: oneRow(data, error, "create auto shortage CS case"), created: true };
  }

  async function upsertTemplateOverride(input) {
    const hasAlimtalkExcluded = Object.prototype.hasOwnProperty.call(input || {}, "alimtalkExcluded");
    const payload = {
      ord_no: nonEmpty(input.ordNo, "ord_no"),
      item_no: nonEmpty(input.itemNo, "item_no"),
      sellpia_order_item_no: text(input.sellpiaOrderItemNo) || null,
      inv_no: text(input.invNo) || null,
      receipt_date: text(input.receiptDate) || null,
      case_type: "template_override",
      status: "excluded",
      source: "manual",
      basis_date: text(input.receiptDate) || null,
      basis_date_source: "receipt_date",
      alimtalk_template: text(input.alimtalkTemplate) || null,
      alimtalk_excluded: hasAlimtalkExcluded ? Boolean(input.alimtalkExcluded) : false,
      updated_by: text(input.updatedBy) || null,
    };
    const existing = await findCsCase({
      ordNo: payload.ord_no,
      itemNo: payload.item_no,
      caseType: payload.case_type,
    });
    if (!existing && !payload.alimtalk_template && !payload.alimtalk_excluded) {
      return { caseRow: null, created: false };
    }
    if (existing) {
      const patch = {
        alimtalk_template: payload.alimtalk_template,
        updated_by: payload.updated_by,
      };
      if (hasAlimtalkExcluded) patch.alimtalk_excluded = payload.alimtalk_excluded;
      const caseRow = await updateCsCase(existing.id, patch);
      return { caseRow, created: false };
    }
    const { data, error } = await db.from("cs_cases").insert(payload).select("*");
    return { caseRow: oneRow(data, error, "save CS template override"), created: true };
  }

  async function updateCsCase(caseId, patch) {
    const id = Number(caseId);
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error("A valid CS case id is required.");
    const { data, error } = await db.from("cs_cases").update(patch).eq("id", id).select("*");
    return oneRow(data, error, "update CS case");
  }

  async function resolveCsCase(caseId, updatedBy = "") {
    return updateCsCase(caseId, {
      status: "resolved",
      resolved_at: new Date().toISOString(),
      excluded_at: null,
      updated_by: text(updatedBy) || null,
    });
  }

  async function excludeCsCase(caseId, updatedBy = "") {
    return updateCsCase(caseId, {
      status: "excluded",
      excluded_at: new Date().toISOString(),
      resolved_at: null,
      updated_by: text(updatedBy) || null,
    });
  }

  async function excludeAutoShortageCsCase(input) {
    const payload = {
      ordNo: nonEmpty(input.ordNo, "ord_no"),
      itemNo: nonEmpty(input.itemNo, "item_no"),
      sellpiaOrderItemNo: text(input.sellpiaOrderItemNo) || null,
      invNo: text(input.invNo) || null,
      receiptDate: text(input.receiptDate) || null,
      basisDate: text(input.basisDate) || null,
    };
    const existing = await findCsCase({ ordNo: payload.ordNo, itemNo: payload.itemNo, caseType: "shortage" });
    if (existing) {
      if (existing.source !== "auto" || existing.status !== "pending") return { caseRow: existing, excluded: false };
      return { caseRow: await excludeCsCase(existing.id), excluded: true };
    }
    const created = await createAutoShortageCsCase({
      ...payload,
      basisDateSource: "receipt_date",
    });
    return { caseRow: await excludeCsCase(created.caseRow.id), excluded: true };
  }

  async function reopenExcludedAutoShortageCsCase(input) {
    const ordNo = nonEmpty(input.ordNo, "ord_no");
    const itemNo = nonEmpty(input.itemNo, "item_no");
    const existing = await findCsCase({ ordNo, itemNo, caseType: "shortage" });
    if (!existing || existing.source !== "auto" || existing.status !== "excluded") {
      return { caseRow: existing, reopened: false };
    }
    return { caseRow: await reopenCsCase(existing.id, text(input.updatedBy) || ""), reopened: true };
  }

  async function reopenCsCase(caseId, updatedBy = "") {
    return updateCsCase(caseId, {
      status: "pending",
      resolved_at: null,
      excluded_at: null,
      updated_by: text(updatedBy) || null,
    });
  }

  return {
    loadCsCases,
    loadCsCaseContexts,
    loadManualCsCandidates,
    loadOpenShortageItemKeys,
    findCsCase,
    createManualCsCase,
    createAutoShortageCsCase,
    upsertTemplateOverride,
    updateCsCase,
    resolveCsCase,
    excludeCsCase,
    excludeAutoShortageCsCase,
    reopenExcludedAutoShortageCsCase,
    reopenCsCase,
  };
}
