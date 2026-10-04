export function comparePickingRowsByRoute(a, b, {
  compareRouteCode,
  invoiceSequenceNo,
  compareInvoiceItems,
} = {}) {
  const aItem = a?.item || {};
  const bItem = b?.item || {};
  const routeCompare = compareRouteCode?.(
    aItem.ownCode || aItem.sellpiaProductCode,
    bItem.ownCode || bItem.sellpiaProductCode,
  ) || 0;
  if (routeCompare) return routeCompare;

  const sequenceCompare = (invoiceSequenceNo?.(a?.invoice, 999999) || 999999)
    - (invoiceSequenceNo?.(b?.invoice, 999999) || 999999);
  if (sequenceCompare) return sequenceCompare;

  const itemCompare = compareInvoiceItems?.(aItem, bItem) || 0;
  if (itemCompare) return itemCompare;

  const sortOrderCompare = (a?.invoice?.sortOrder ?? 999999) - (b?.invoice?.sortOrder ?? 999999);
  if (sortOrderCompare) return sortOrderCompare;

  return String(a?.invoice?.orderGroupNo || "").localeCompare(
    String(b?.invoice?.orderGroupNo || ""),
    "ko",
    { numeric: true },
  );
}
