export const FIELD_SCOPE = Object.freeze({
  INVOICE: "invoice",
  ITEM: "item",
});

export const STANDARD_FIELDS = Object.freeze([
  { name: "orderGroupNo", scope: FIELD_SCOPE.INVOICE, required: true },
  { name: "invoiceNo", scope: FIELD_SCOPE.INVOICE, required: false },
  { name: "recipientName", scope: FIELD_SCOPE.INVOICE, required: false },
  { name: "buyerName", scope: FIELD_SCOPE.INVOICE, required: false },
  { name: "seller", scope: FIELD_SCOPE.INVOICE, required: false },
  { name: "recipientPhone", scope: FIELD_SCOPE.INVOICE, required: false },
  { name: "buyerPhone", scope: FIELD_SCOPE.INVOICE, required: false },
  { name: "orderTotalAmount", scope: FIELD_SCOPE.INVOICE, required: false },
  { name: "receiptDate", scope: FIELD_SCOPE.INVOICE, required: true },
  { name: "sellpiaMemo1", scope: FIELD_SCOPE.INVOICE, required: false },
  { name: "orderMemo", scope: FIELD_SCOPE.INVOICE, required: false },
  { name: "sellpiaItemNo", scope: FIELD_SCOPE.ITEM, required: true },
  { name: "sellpiaProductCode", scope: FIELD_SCOPE.ITEM, required: false },
  { name: "ownCode", scope: FIELD_SCOPE.ITEM, required: false },
  { name: "productName", scope: FIELD_SCOPE.ITEM, required: false },
  { name: "optionName", scope: FIELD_SCOPE.ITEM, required: false },
  { name: "quantity", scope: FIELD_SCOPE.ITEM, required: false },
  { name: "itemSalesAmount", scope: FIELD_SCOPE.ITEM, required: false },
  { name: "sellpiaMemo2", scope: FIELD_SCOPE.ITEM, required: false },
  { name: "sellpiaLocation", scope: FIELD_SCOPE.ITEM, required: false },
  { name: "itemOrderIndex", scope: FIELD_SCOPE.ITEM, required: false },
]);

export function isStandardField(name) {
  return STANDARD_FIELDS.some((field) => field.name === name);
}
