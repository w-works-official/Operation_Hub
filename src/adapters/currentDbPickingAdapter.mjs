function firstText(...values) {
  for (const value of values) {
    if (value === null || value === undefined) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return "";
}

function firstNumber(...values) {
  for (const value of values) {
    if (value === null || value === undefined || value === "") continue;
    const number = Number(String(value).replace(/,/g, ""));
    if (Number.isFinite(number)) return number;
  }
  return null;
}

export function buildDisplayName(recipientName, buyerName) {
  const recipient = firstText(recipientName);
  const buyer = firstText(buyerName);
  if (!recipient) return buyer;
  if (!buyer || recipient === buyer) return recipient;
  return `${recipient}(${buyer})`;
}

export function parseItemOrderIndex(sellpiaItemNo, fallbackSortOrder = null) {
  const text = firstText(sellpiaItemNo);
  const suffix = text.match(/(?:_\[(\d{1,3})\]|\((\d{1,3})\)|_(\d{1,3}))$/);
  if (suffix) return Number(suffix[1] || suffix[2] || suffix[3]);
  return null;
}

export function makeItemStateKey(orderGroupNo, sellpiaItemNo) {
  return `${firstText(orderGroupNo)}::${firstText(sellpiaItemNo)}`;
}

export function normalizeCurrentDbOrder(order = {}) {
  const recipientName = firstText(order.receiver, order.receiver_name, order.recipient_name);
  const buyerName = firstText(order.orderer, order.buyer, order.buyer_name);

  return {
    orderGroupNo: firstText(order.ord_no, order.order_group_no, order.group_no),
    invoiceNo: firstText(order.inv_no, order.dnum, order.invoice_no),
    recipientName,
    buyerName,
    displayName: buildDisplayName(recipientName, buyerName),
    csDisplayName: buyerName || recipientName,
    seller: firstText(order.seller, order.provider_name, order.seller_id),
    recipientPhone: firstText(order.receiver_mobile, order.receiver_tel, order.recipient_phone),
    buyerPhone: firstText(order.orderer_mobile, order.orderer_tel, order.buyer_phone),
    orderTotalAmount: firstNumber(order.sellpia_order_total_amount, order.order_total_amount),
    receiptDate: firstText(order.receipt_date),
    // Keep the source order timestamp distinct from receipt_date. Receipt date
    // continues to drive the existing work queues and cleanup boundaries.
    orderDateTime: firstText(order.sellpia_ordered_at),
    sellpiaMemo1: firstText(order.o_shop_memo, order.shop_memo, order.memo1),
    orderMemo: firstText(order.order_memo, order.o_memo),
    session: firstText(order.am_pm, order.session, order.receipt_session),
    sortOrder: firstNumber(order.sort_order),
    raw: order,
  };
}

export function normalizeCurrentDbItem(item = {}) {
  const sellpiaItemNo = firstText(item.item_no, item.sellpia_item_no, item.order_item_no);

  return {
    orderGroupNo: firstText(item.ord_no, item.order_group_no, item.group_no),
    invoiceNo: firstText(item.inv_no, item.dnum, item.invoice_no),
    sellpiaItemNo,
    sellpiaProductCode: firstText(item.p_code, item.sellpia_p_code, item.sellpia_product_code),
    ownCode: firstText(item.prod_code, item.p_dpcode, item.own_code),
    productName: firstText(item.p_name, item.product_name),
    optionName: firstText(item.p_option, item.option_name),
    quantity: firstNumber(item.qty, item.o_amount, item.quantity) ?? 1,
    itemSalesAmount: firstNumber(item.sellpia_item_sales_amount, item.item_sales_amount),
    orderDateTime: firstText(item.sellpia_ordered_at),
    sellpiaMemo1: firstText(item.o_shop_memo, item.shop_memo, item.memo1),
    sellpiaMemo2: firstText(item.o_shop_memo2, item.shop_memo2, item.memo2),
    sellpiaLocation: firstText(item.p_location, item.location),
    inspectionMemo: firstText(item.insp_memo, item.inspection_memo),
    itemOrderIndex: parseItemOrderIndex(sellpiaItemNo, item.sort_order),
    sortOrder: firstNumber(item.sort_order),
    raw: item,
  };
}

export function normalizePickingState(row = {}) {
  const orderGroupNo = firstText(row.ord_no, row.order_group_no, row.group_no);
  const sellpiaItemNo = firstText(row.item_no, row.sellpia_item_no, row.order_item_no);

  return {
    orderGroupNo,
    sellpiaItemNo,
    key: makeItemStateKey(orderGroupNo, sellpiaItemNo),
    isPicked: Boolean(row.is_checked ?? row.checked ?? row.is_picked),
    shortageQty: 0,
    drawerMemo: firstText(row.drawer_no, row.drawer_memo),
    isHold: Boolean(row.hold ?? row.is_hold),
    status: firstText(row.status),
    raw: row,
  };
}
