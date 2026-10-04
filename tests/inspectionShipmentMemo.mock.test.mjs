import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/app/pickingApp.mjs", import.meta.url), "utf8");

function sourceSlice(startText, endText) {
  const start = source.indexOf(startText);
  const end = source.indexOf(endText, start);
  assert.ok(start >= 0 && end > start, `${startText} source must exist`);
  return source.slice(start, end);
}

const inspectionRender = sourceSlice(
  "function renderInspectionPanels",
  "\nfunction csRowKey",
);
assert.match(
  inspectionRender,
  /const memoReadonly = allowWrites \? "" : "readonly";/,
  "검품 메모는 합배송 또는 취소 상태와 무관하게 쓰기 모드에서 편집 가능해야 한다",
);
assert.doesNotMatch(
  inspectionRender,
  /const memoReadonly = [^;]*(?:selectedShipmentGroup|itemCancelled)/,
  "합배송 및 취소 상태가 검품 메모를 잠그면 안 된다",
);
assert.match(
  inspectionRender,
  /data-inspection-memo-field="sellpia-order" data-order-group="\$\{escapeHtml\(itemSourceOrderGroupNo\)\}" data-item-no="\$\{escapeHtml\(item\.sellpiaItemNo\)\}"/,
  "합배송 주문메모는 각 원주문번호와 상품행번호를 저장 대상으로 전달해야 한다",
);

const finderSource = sourceSlice(
  "function findInspectionInvoiceItem",
  "\nasync function saveInspectionSellpiaOrderMemo",
);
const findInspectionInvoiceItem = new Function(
  "state",
  `${finderSource}; return findInspectionInvoiceItem;`,
)(
  {
    viewModel: {
      invoices: [
        { orderGroupNo: "source-order-1", items: [{ sellpiaItemNo: "item-1" }] },
        { orderGroupNo: "source-order-2", items: [{ sellpiaItemNo: "item-2" }] },
      ],
    },
    workflowQueues: {},
  },
);
assert.equal(findInspectionInvoiceItem("source-order-2", "item-2").invoice.orderGroupNo, "source-order-2");
assert.equal(findInspectionInvoiceItem("source-order-2", "item-2").item.sellpiaItemNo, "item-2");

const saveSource = sourceSlice(
  "async function saveInspectionSellpiaOrderMemo",
  "\nasync function saveInspectionConfirmMemo",
);
assert.match(saveSource, /ordNo: invoice\.orderGroupNo,[\s\S]*?itemNo,[\s\S]*?sellpiaOrderItemNo/);
assert.match(saveSource, /await updateOrderItemOrderMemoExact/);

console.log("Inspection combined-shipment memos stay editable and target the exact source-order item: passed");
