function text(value) {
  return String(value ?? "").trim();
}

function newestRow(rows = []) {
  return [...rows].sort((left, right) => Number(right?.id || 0) - Number(left?.id || 0))[0] || null;
}

export function preferredPickingRow(rows = [], invoiceNo = "") {
  const candidates = (rows || []).filter(Boolean);
  if (!candidates.length) return null;

  const currentInvoiceNo = text(invoiceNo);
  if (currentInvoiceNo) {
    const exactRows = candidates.filter((row) => text(row?.inv_no) === currentInvoiceNo);
    if (exactRows.length) return newestRow(exactRows);

    const blankInvoiceRows = candidates.filter((row) => !text(row?.inv_no));
    if (blankInvoiceRows.length) return newestRow(blankInvoiceRows);
  } else {
    const invoicedRows = candidates.filter((row) => text(row?.inv_no));
    if (invoicedRows.length) return newestRow(invoicedRows);
  }

  return newestRow(candidates);
}
