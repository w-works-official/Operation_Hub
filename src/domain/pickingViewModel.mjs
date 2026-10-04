/**
 * @typedef {Object} PickingInvoice
 * @property {string} orderGroupNo Main invoice-like Sellpia group key.
 * @property {string} invoiceNo Delivery invoice number, used for barcode/search.
 * @property {string} recipientName Recipient name.
 * @property {string} buyerName Buyer/orderer name.
 * @property {string} displayName Recipient display name for picking/inspection.
 * @property {string} csDisplayName Buyer display name for CS.
 * @property {string} seller Seller/channel name.
 * @property {string} receiptDate Receipt/collection date.
 * @property {number|null} orderTotalAmount Sellpia order total amount. Do not derive from item rows.
 * @property {string} sellpiaMemo1 Invoice-level Sellpia management memo.
 * @property {string} orderMemo Invoice/order memo.
 * @property {PickingItem[]} items Normalized item rows.
 */

/**
 * @typedef {Object} PickingItem
 * @property {string} sellpiaItemNo Sellpia item key.
 * @property {string} sellpiaProductCode Sellpia product code, used for image filenames.
 * @property {string} ownCode Internal own code, used for picking and visible product identity.
 * @property {string} productName Sellpia product name.
 * @property {string} optionName Sellpia option name.
 * @property {number} quantity Ordered quantity.
 * @property {number|null} itemSalesAmount Item-level sales amount.
 * @property {string} sellpiaMemo2 Item-level Sellpia management memo 2.
 * @property {string} sellpiaLocation Sellpia product location text.
 * @property {number|null} itemOrderIndex Item order inside invoice/order group.
 * @property {Object} pickingState Picking/shortage/inspection state attached by adapter.
 */

export const PICKING_VIEW_MODEL_VERSION = "2026-06-30.1";
