export const ITEM_EVENT = Object.freeze({
  PICKED: "picked",
  PICK_UNCHECKED: "pick_unchecked",
  SHORTAGE_CREATED: "shortage_created",
  SHORTAGE_QTY_CHANGED: "shortage_qty_changed",
  SHORTAGE_REPICK_COMPLETED: "shortage_repick_completed",
  INSPECTION_COMPLETED: "inspection_completed",
  INSPECTION_REOPENED: "inspection_reopened",
  CANCELLED: "cancelled",
  CANCEL_REOPENED: "cancel_reopened",
});

export const INVOICE_EVENT = Object.freeze({
  HOLD_CREATED: "hold_created",
  HOLD_RELEASED: "hold_released",
  CS_PENDING: "cs_pending",
  CS_RESOLVED: "cs_resolved",
  SHORTAGE_INVOICE_REPICK_COMPLETED: "shortage_invoice_repick_completed",
  INSPECTION_COMPLETED: "inspection_completed",
  INSPECTION_REOPENED: "inspection_reopened",
  CANCELLED: "cancelled",
  CANCEL_REOPENED: "cancel_reopened",
});

export const SYNC_ACTION = Object.freeze({
  MEMO1_SET: "memo1_set",
  MEMO1_CLEAR: "memo1_clear",
  MEMO2_SET: "memo2_set",
  MEMO2_CLEAR: "memo2_clear",
  HOLD_SET: "hold_set",
  HOLD_RELEASE: "hold_release",
  ORDER_MEMO_SET: "order_memo_set",
  ORDER_MEMO_CLEAR: "order_memo_clear",
});

function text(value) {
  return String(value ?? "").trim();
}

function eventTime(row) {
  return new Date(row.event_at || row.created_at || 0).getTime() || 0;
}

function eventId(row) {
  return Number(row.id || 0);
}

export function itemEventKey(row) {
  return `${text(row.order_group_no)}::${text(row.sellpia_item_no)}`;
}

export function invoiceEventKey(row) {
  return text(row.order_group_no);
}

export function sortEvents(events = []) {
  return [...events].sort((a, b) => eventTime(a) - eventTime(b) || eventId(a) - eventId(b));
}

export function reduceItemEvents(events = []) {
  const state = {
    picked: false,
    shortageOpen: false,
    shortageQty: 0,
    shortageRepicked: false,
    inspected: false,
    cancelled: false,
    drawerMemo: "",
    memo: "",
    lastEventAt: "",
  };

  for (const event of sortEvents(events)) {
    state.lastEventAt = event.event_at || event.created_at || state.lastEventAt;
    const qty = Number(event.quantity || 0);
    const memo = text(event.memo);
    const drawerMemo = text(event.drawer_memo);
    if (memo) state.memo = memo;
    if (drawerMemo) state.drawerMemo = drawerMemo;

    switch (event.event_type) {
      case ITEM_EVENT.PICKED:
        state.picked = true;
        break;
      case ITEM_EVENT.PICK_UNCHECKED:
        state.picked = false;
        break;
      case ITEM_EVENT.SHORTAGE_CREATED:
        state.shortageOpen = true;
        state.shortageQty = qty || state.shortageQty || 1;
        state.shortageRepicked = false;
        state.inspected = false;
        state.cancelled = false;
        break;
      case ITEM_EVENT.SHORTAGE_QTY_CHANGED:
        state.shortageQty = Math.max(0, qty);
        break;
      case ITEM_EVENT.SHORTAGE_REPICK_COMPLETED:
        state.shortageOpen = false;
        state.shortageQty = 0;
        state.shortageRepicked = true;
        state.inspected = false;
        break;
      case ITEM_EVENT.INSPECTION_COMPLETED:
        state.inspected = true;
        state.shortageOpen = false;
        break;
      case ITEM_EVENT.INSPECTION_REOPENED:
        state.inspected = false;
        break;
      case ITEM_EVENT.CANCELLED:
        state.cancelled = true;
        break;
      case ITEM_EVENT.CANCEL_REOPENED:
        state.cancelled = false;
        break;
      default:
        break;
    }
  }

  return state;
}

export function reduceInvoiceEvents(events = []) {
  const state = {
    hold: false,
    systemShippingHold: false,
    systemShippingHoldKnown: false,
    systemShippingHoldStatus: "OFF",
    systemShippingHoldSource: "",
    systemShippingHoldReason: "",
    shippingHoldNeedsOn: false,
    shippingHoldUnknown: false,
    shippingHoldSignals: [],
    csPending: false,
    shortageInvoiceRepicked: false,
    inspected: false,
    cancelled: false,
    memo: "",
    lastEventAt: "",
  };

  for (const event of sortEvents(events)) {
    state.lastEventAt = event.event_at || event.created_at || state.lastEventAt;
    const memo = text(event.memo);
    if (memo) state.memo = memo;

    switch (event.event_type) {
      case INVOICE_EVENT.HOLD_CREATED:
        state.hold = true;
        state.systemShippingHold = true;
        state.systemShippingHoldKnown = true;
        state.systemShippingHoldStatus = "ON";
        state.systemShippingHoldSource = "event_hold_created";
        state.systemShippingHoldReason = "explicit_hold_created";
        state.shippingHoldNeedsOn = false;
        state.shippingHoldUnknown = false;
        break;
      case INVOICE_EVENT.HOLD_RELEASED:
        state.hold = false;
        state.systemShippingHold = false;
        state.systemShippingHoldKnown = true;
        state.systemShippingHoldStatus = "OFF";
        state.systemShippingHoldSource = "event_hold_released";
        state.systemShippingHoldReason = "explicit_hold_released";
        state.shippingHoldNeedsOn = false;
        state.shippingHoldUnknown = false;
        break;
      case INVOICE_EVENT.CS_PENDING:
        state.csPending = true;
        break;
      case INVOICE_EVENT.CS_RESOLVED:
        state.csPending = false;
        break;
      case INVOICE_EVENT.SHORTAGE_INVOICE_REPICK_COMPLETED:
        state.shortageInvoiceRepicked = true;
        state.inspected = false;
        break;
      case INVOICE_EVENT.INSPECTION_COMPLETED:
        state.inspected = true;
        break;
      case INVOICE_EVENT.INSPECTION_REOPENED:
        state.inspected = false;
        break;
      case INVOICE_EVENT.CANCELLED:
        state.cancelled = true;
        break;
      case INVOICE_EVENT.CANCEL_REOPENED:
        state.cancelled = false;
        break;
      default:
        break;
    }
  }

  return state;
}

export function groupItemEvents(events = []) {
  const grouped = new Map();
  for (const event of events) {
    const key = itemEventKey(event);
    if (!key || key === "::") continue;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(event);
  }
  return grouped;
}

export function groupInvoiceEvents(events = []) {
  const grouped = new Map();
  for (const event of events) {
    const key = invoiceEventKey(event);
    if (!key) continue;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(event);
  }
  return grouped;
}

export function buildWorkflowState({ itemEvents = [], invoiceEvents = [] } = {}) {
  const itemGroups = groupItemEvents(itemEvents);
  const invoiceGroups = groupInvoiceEvents(invoiceEvents);
  const itemStateByKey = new Map();
  const invoiceStateByKey = new Map();

  for (const [key, events] of itemGroups) {
    itemStateByKey.set(key, reduceItemEvents(events));
  }

  for (const [key, events] of invoiceGroups) {
    invoiceStateByKey.set(key, reduceInvoiceEvents(events));
  }

  return { itemStateByKey, invoiceStateByKey };
}

export function defaultInvoiceState() {
  return reduceInvoiceEvents([]);
}

export function openShortageItems(viewModel, workflowState) {
  return (viewModel?.invoices || []).flatMap((invoice) => {
    const invoiceState = workflowState.invoiceStateByKey.get(invoice.orderGroupNo);
    if (invoiceState?.cancelled) return [];
    return (invoice.items || [])
      .map((item) => ({
        invoice,
        item,
        state: workflowState.itemStateByKey.get(`${invoice.orderGroupNo}::${item.sellpiaItemNo}`),
      }))
      .filter((row) => row.state?.shortageOpen && !row.state?.shortageRepicked && !row.state?.cancelled);
  });
}

export function repickedInvoicesForInspection(viewModel, workflowState) {
  return (viewModel?.invoices || []).filter((invoice) => {
    const invoiceState = workflowState.invoiceStateByKey.get(invoice.orderGroupNo);
    if (invoiceState?.inspected || invoiceState?.cancelled) return false;
    if (invoiceState?.shortageInvoiceRepicked && !invoiceState?.inspected && !invoiceState?.cancelled) return true;

    return (invoice.items || []).some((item) => {
      const itemState = workflowState.itemStateByKey.get(`${invoice.orderGroupNo}::${item.sellpiaItemNo}`);
      return itemState?.shortageRepicked && !itemState?.inspected && !itemState?.cancelled;
    });
  });
}

export function completedInvoicesForInspection(viewModel, workflowState) {
  return (viewModel?.invoices || []).filter((invoice) => {
    const invoiceState = workflowState.invoiceStateByKey.get(invoice.orderGroupNo);
    return Boolean(invoiceState?.inspected && !invoiceState?.cancelled);
  });
}

export function invoicesForCs(viewModel, workflowState) {
  return (viewModel?.invoices || []).filter((invoice) => {
    const invoiceState = workflowState.invoiceStateByKey.get(invoice.orderGroupNo);
    return Boolean(invoiceState?.hold || invoiceState?.csPending);
  });
}
