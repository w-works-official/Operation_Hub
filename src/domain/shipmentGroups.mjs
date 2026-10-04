function text(value) {
  return String(value ?? "").trim();
}

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function shipmentGroupKey(groupId) {
  const id = text(groupId);
  return id ? `shipment:${id}` : "";
}

export function sourceOrderGroupNo(invoice, item = null) {
  return text(item?.sourceOrderGroupNo || invoice?.orderGroupNo);
}

export function sourceInvoiceNo(invoice, item = null) {
  return text(item?.sourceInvoiceNo || invoice?.invoiceNo);
}

export function automaticShipmentKey(invoiceNo) {
  const normalizedInvoiceNo = text(invoiceNo);
  return normalizedInvoiceNo ? `invoice:${normalizedInvoiceNo}` : "";
}

export function normalizeShipmentGroup(group = {}, members = []) {
  const id = text(group.id);
  const normalizedMembers = [...members]
    .filter((member) => text(member.group_id) === id && member.active !== false)
    .sort((left, right) => (
      number(left.member_order, Number.MAX_SAFE_INTEGER) - number(right.member_order, Number.MAX_SAFE_INTEGER)
      || text(left.ord_no).localeCompare(text(right.ord_no), "ko", { numeric: true })
    ))
    .map((member, index) => ({
      groupId: id,
      orderGroupNo: text(member.ord_no),
      originalInvoiceNo: text(member.original_inv_no),
      memberOrder: number(member.member_order, index + 1),
      active: member.active !== false,
      raw: member,
    }));

  return {
    id,
    key: shipmentGroupKey(id),
    representativeOrderGroupNo: text(group.representative_ord_no),
    targetInvoiceNo: text(group.target_inv_no),
    status: text(group.status) || "active",
    syncStatus: text(group.sync_status) || "pending",
    version: number(group.version, 1),
    members: normalizedMembers,
    raw: group,
  };
}

function combinedSeller(sourceInvoices) {
  const sellers = [...new Set(sourceInvoices.map((invoice) => text(invoice.seller)).filter(Boolean))];
  return sellers.length === 1 ? sellers[0] : sellers.length ? "복수판매처" : "";
}

function earliestReceiptDate(sourceInvoices) {
  return sourceInvoices.map((invoice) => text(invoice.receiptDate)).filter(Boolean).sort()[0] || "";
}

function minimumSortOrder(sourceInvoices) {
  const values = sourceInvoices.map((invoice) => Number(invoice.sortOrder)).filter(Number.isFinite);
  return values.length ? Math.min(...values) : null;
}

export function combineInvoicesWithShipmentGroups(invoices = [], shipmentGroups = []) {
  const invoiceByOrder = new Map(
    invoices.map((invoice) => [text(invoice?.orderGroupNo), invoice]).filter(([orderGroupNo]) => orderGroupNo),
  );
  const consumedOrderNos = new Set();
  const combinedByFirstIndex = new Map();

  for (const group of shipmentGroups) {
    if (!group?.id || group.status !== "active" || group.members.length < 2) continue;
    const memberPairs = group.members
      .map((member) => ({ member, invoice: invoiceByOrder.get(member.orderGroupNo) || null }))
      .filter((row) => row.invoice);
    if (memberPairs.length !== group.members.length) continue;
    if (memberPairs.some(({ member }) => consumedOrderNos.has(member.orderGroupNo))) continue;

    const representativePair = memberPairs.find(
      ({ member }) => member.orderGroupNo === group.representativeOrderGroupNo,
    ) || memberPairs[0];
    const sourceInvoices = memberPairs.map(({ invoice }) => invoice);
    const memberIndexByOrder = new Map(memberPairs.map(({ member }, index) => [member.orderGroupNo, index]));
    const items = memberPairs.flatMap(({ member, invoice }, memberIndex) => (
      (invoice.items || []).map((item, sourceItemIndex) => ({
        ...item,
        sourceOrderGroupNo: member.orderGroupNo,
        sourceInvoiceNo: text(invoice.invoiceNo),
        sourceMemberIndex: memberIndex,
        sourceItemIndex,
        shipmentItemOrderIndex: memberIndex * 100000 + sourceItemIndex,
      }))
    ));
    const firstIndex = Math.min(...memberPairs.map(({ invoice }) => invoices.indexOf(invoice)));
    const combined = {
      ...representativePair.invoice,
      orderGroupNo: group.key,
      invoiceNo: group.targetInvoiceNo || representativePair.invoice.invoiceNo,
      displayName: representativePair.invoice.displayName || representativePair.invoice.csDisplayName,
      csDisplayName: representativePair.invoice.csDisplayName || representativePair.invoice.displayName,
      seller: combinedSeller(sourceInvoices),
      receiptDate: earliestReceiptDate(sourceInvoices),
      sortOrder: minimumSortOrder(sourceInvoices),
      items,
      shipmentGroup: {
        ...group,
        members: group.members.map((member) => ({
          ...member,
          invoiceNo: text(invoiceByOrder.get(member.orderGroupNo)?.invoiceNo) || member.originalInvoiceNo,
          displayName: text(invoiceByOrder.get(member.orderGroupNo)?.displayName),
          itemCount: invoiceByOrder.get(member.orderGroupNo)?.items?.length || 0,
          memberIndex: memberIndexByOrder.get(member.orderGroupNo) ?? 0,
        })),
      },
      sourceInvoices,
    };
    combinedByFirstIndex.set(firstIndex, combined);
    memberPairs.forEach(({ member }) => consumedOrderNos.add(member.orderGroupNo));
  }

  const result = [];
  invoices.forEach((invoice, index) => {
    if (combinedByFirstIndex.has(index)) result.push(combinedByFirstIndex.get(index));
    if (!consumedOrderNos.has(text(invoice?.orderGroupNo))) result.push(invoice);
  });
  return result;
}

export function combineInvoicesBySharedInvoice(invoices = []) {
  const invoiceGroups = new Map();

  invoices.forEach((invoice, sourceIndex) => {
    const invoiceNo = text(invoice?.invoiceNo);
    const orderGroupNo = text(invoice?.orderGroupNo);
    if (!invoiceNo || !orderGroupNo) return;
    if (!invoiceGroups.has(invoiceNo)) invoiceGroups.set(invoiceNo, []);
    invoiceGroups.get(invoiceNo).push({ invoice, sourceIndex, orderGroupNo });
  });

  const combinedByFirstIndex = new Map();
  const consumedIndexes = new Set();

  for (const [invoiceNo, rows] of invoiceGroups) {
    const distinctOrders = [...new Set(rows.map((row) => row.orderGroupNo))];
    if (distinctOrders.length < 2) continue;

    const sourceInvoices = rows.map((row) => row.invoice);
    const members = rows.map(({ invoice, orderGroupNo }, memberIndex) => ({
      orderGroupNo,
      invoiceNo,
      displayName: text(invoice.displayName || invoice.csDisplayName),
      itemCount: invoice.items?.length || 0,
      memberIndex,
    }));
    const items = rows.flatMap(({ invoice, orderGroupNo }, memberIndex) => (
      (invoice.items || []).map((item, sourceItemIndex) => ({
        ...item,
        sourceOrderGroupNo: orderGroupNo,
        sourceInvoiceNo: invoiceNo,
        sourceMemberIndex: memberIndex,
        sourceItemIndex,
        shipmentItemOrderIndex: memberIndex * 100000 + sourceItemIndex,
      }))
    ));
    const firstRow = rows[0];
    const firstIndex = Math.min(...rows.map((row) => row.sourceIndex));
    combinedByFirstIndex.set(firstIndex, {
      ...firstRow.invoice,
      orderGroupNo: automaticShipmentKey(invoiceNo),
      invoiceNo,
      seller: combinedSeller(sourceInvoices),
      receiptDate: earliestReceiptDate(sourceInvoices),
      sortOrder: minimumSortOrder(sourceInvoices),
      items,
      shipmentGroup: {
        id: automaticShipmentKey(invoiceNo),
        key: automaticShipmentKey(invoiceNo),
        automatic: true,
        targetInvoiceNo: invoiceNo,
        syncStatus: "synced",
        members,
      },
      sourceInvoices,
    });
    rows.forEach((row) => consumedIndexes.add(row.sourceIndex));
  }

  const result = [];
  invoices.forEach((invoice, index) => {
    if (combinedByFirstIndex.has(index)) result.push(combinedByFirstIndex.get(index));
    if (!consumedIndexes.has(index)) result.push(invoice);
  });
  return result;
}

export function shipmentSyncLabel(syncStatus) {
  if (syncStatus === "synced") return "셀피아 동기화 완료";
  if (syncStatus === "failed") return "셀피아 동기화 오류";
  return "셀피아 동기화 대기";
}
