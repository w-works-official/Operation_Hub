import { annotateShippingHoldState, loadWorkflowQueues } from "../adapters/workflowEventAdapter.mjs?v=20260731-cancellation3";
import { buildPickingViewModel } from "../workflows/picking/buildPickingViewModel.mjs?v=20260706-memo2-text1";
import { createCsCaseAdapter, openShortageItemKeys } from "../adapters/csCaseAdapter.mjs?v=20260929-alimtalk-uncheck1";
import {
  createOrderItemOperationsAdapter,
  findOperationForCurrentItem,
  orderItemIdentity,
  resolveEffectiveInboundExpectedDate,
} from "../adapters/orderItemOperationsAdapter.mjs?v=20261001-sku-schedule1";
import {
  CUSTOM_ORDER_STATUS_LABEL,
  addCalendarDays,
  buildCustomOrderRows,
  buildInboundExpectedRows,
  canClearCustomRequired,
  customOrderStatus,
  customOrderSuppliers,
  filterCustomOrderRows,
  filterInboundExpectedRows,
  sortInboundExpectedRows,
} from "../domain/customOrder.mjs?v=20261001-custom-order-ui2";
import { createSkuInboundSchedulesAdapter } from "../adapters/skuInboundSchedulesAdapter.mjs?v=20261001-sku-schedule1";
import {
  SKU_INBOUND_SCHEDULE_HEADERS,
  findSkuInboundSchedule,
  parseSkuInboundScheduleRows,
  skuInboundScheduleWorkbookRows,
} from "../domain/skuInboundSchedule.mjs?v=20261001-sku-schedule1";
import { createAlimtalkSendAdapter } from "../adapters/alimtalkSendAdapter.mjs?v=20260728-alimtalk-history2";
import { isBareGpaOwnCode, isGoldOwnCode } from "../domain/gold.mjs?v=20260811-bare-gpa-label1";
import { alimtalkSendLogAnchor, alimtalkSendLogCode, alimtalkSendNaturalKey, appendAlimtalkSendLog, formatAlimtalkInboundExpectedDate, hasTomorrowShippingManagementMemo, normalizeAlimtalkSendLog, resolveAlimtalkTemplate } from "../domain/alimtalk.mjs?v=20260804-send-log-anchor2";
import { receiptBusinessDayKeys, receiptBusinessDaysSince } from "../domain/businessDays.mjs?v=20260728-receipt-business-days1";
import { inspectionHoldCsAction } from "../domain/csHoldTransition.mjs?v=20260731-inspection-hold-cs1";
import { preferredPickingRow } from "../domain/pickingPersistence.mjs?v=20260807-picking-dedupe1";
import { comparePickingRowsByRoute } from "../domain/pickingRowSort.mjs?v=20260731-route-row1";
import { buildCurrentShortageExport, buildInventorySurveyExport } from "../domain/inventorySurveyExport.mjs?v=20261001-custom-order-qty1";
import {
  combineInvoicesBySharedInvoice,
  sourceOrderGroupNo,
} from "../domain/shipmentGroups.mjs?v=20260811-auto-combined2";
import {
  buildWorkflowState,
  completedInvoicesForInspection,
  openShortageItems,
  repickedInvoicesForInspection,
} from "../workflows/workflowEvents.mjs?v=20260731-cancellation3";

const SUPABASE_URL = "https://vgxocngpykhlkosiaeew.supabase.co";
const SUPABASE_KEY = "sb_publishable_XVnKGJo66GZiYTq5Ivu8dA_SjBVvX0g";
const IMAGE_SUPABASE_URL = "https://bpgvqmtsjgegnrdzmpep.supabase.co";
const IMAGE_SUPABASE_KEY = "sb_publishable__NVp6Ra227_e1TQqQE40oA_O2PVwv5C";
const IMAGE_BUCKET = "product-images";
const PRODUCT_PHOTO_FOLDER = "sellpia";
const PRODUCT_PHOTO_GROUP_SUFFIX = ".__group";
const PRODUCT_PHOTO_RANGE_SUFFIX = ".__range";
const PRODUCT_PHOTO_PRIORITY_SUFFIX = ".__priority";
const PRODUCT_PHOTO_MAX_DIMENSION = 2400;
const PRODUCT_PHOTO_MAX_BYTES = 5 * 1024 * 1024;
const PHOTO_VIEWER_ZOOM_STORAGE_KEY = "system-v3-photo-viewer-zoom";
const PHOTO_VIEWER_ZOOM_MIN = 25;
const PHOTO_VIEWER_ZOOM_MAX = 500;
const PHOTO_VIEWER_ZOOM_DEFAULT = 100;
const RECEIVING_LABEL_BUCKET = "system-v3-shared";
const RECEIVING_LABEL_PATH = "receiving-label/current.csv";
const RECEIVING_LABEL_CSV_HEADER = ["product_code", "own_code", "option_name", "qty"];
const JO_SIZE = 4;
const CS_TEMPLATE_PRESETS = {
  d1: {
    label: "1일차 기본",
    text:
      "[#{SHOPNAME}/입고지연 상품 안내]\n\n안녕하세요, #{NAME} 고객님!\n주문 상품 중 아래의 상품이 거래처 지연/불량 등의 사유로, 부득이하게 출고가 지연되고 있습니다. 이용에 불편을 드려 대단히 죄송합니다.\n\n●지연상품\n#{PRODUCT}(#{OPTION})\n※ 보통 1-2일내로 정상출고되며, 추가지연시 다시 연락드립니다.\n※ 안내가 없는 제품은 입고완료 제품입니다.\n※ 만약 빠른 출고를 위하여 해당 제품의 취소 / 옵션 변경을 희망하시는 경우, 핑크로켓 고객센터(카카오톡:핑크로켓) / 구매처 게시판 등으로 연락부탁드립니다!\n\n빠른 출고가 되도록 노력하겠습니다!",
  },
  d3_ms: {
    label: "3일차 메이크샵",
    text:
      "[#{SHOPNAME}/지연상품 취소 및 출고 안내]\n\n안녕하세요, #{NAME} 고객님!\n안내드린 상품의 입고가 3 영업일 이상 경과되어,\n주문시에 선택하신 장기지연 처리 방법으로 취소/환불 후, 내일 준비된 제품만 출고될 예정입니다.\n(주말의 경우 차주 월요일 출고 / 단독상품 주문시 주문취소)\n정상 출고 도와드리지 못해 대단히 죄송합니다.\n\n●취소예정상품\n#{PRODUCT}(#{OPTION})\n※ 안내가 없는 제품은 입고완료 제품입니다.\n\n더욱 나은 서비스를 위해 노력하겠습니다. 감사합니다!",
  },
  d3_pf: {
    label: "3일차 플랫폼",
    text:
      "[#{SHOPNAME}/입고지연 취소 및 출고 안내]\n\n안녕하세요, #{NAME} 고객님!\n안내드린 지연상품의 입고가 3 영업일 이상 지속되어, 장기지연이 예상되고 있습니다.\n이에 부득이하게 해당 제품을 취소처리 후, 내일 나머지 제품만 출고될 예정입니다.\n(주말의 경우 차주 월요일 출고 / 단독상품 주문시 주문취소)\n오래 기다려 주셨으나, 정상출고 도와드리지 못해 대단히 죄송합니다.\n\n●취소예정상품\n#{PRODUCT}(#{OPTION})\n※ 안내가 없는 제품은 입고완료 제품입니다.\n※ 만약 취소하지 않고, 입고시까지 기다리시기를 원하시는 경우, 다음날 9:30AM까지 핑크로켓 고객센터(카카오톡:핑크로켓) / 구매처 게시판 등으로 연락부탁드립니다.\n\n더욱 나은 서비스를 위해 노력하겠습니다. 감사합니다!",
  },
  d5_hi: {
    label: "5일차 부분출고",
    text:
      "[#{SHOPNAME}/부분 출고 안내]\n\n안녕하세요, #{NAME} 고객님!\n안내드린 상품의 입고가 5 영업일 이상 경과되어, 장기지연이 예상되고 있습니다. 이에 부득이하게 내일 준비된 제품만 우선적으로 부분출고될 예정입니다.\n(주말의 경우 차주 월요일 출고)\n이용에 불편을 드려 대단히 죄송합니다.\n\n●지연상품\n#{PRODUCT}(#{OPTION})\n※ 안내가 없는 제품은 입고완료 제품으로, 익일 부분출고됩니다.\n※ 지연상품의 입고지연이 지속될 경우, 취소처리 될 수 있습니다.\n\n더욱 나은 서비스를 위해 노력하겠습니다. 감사합니다!",
  },
  d5_lo: {
    label: "5일차 취소출고",
    text:
      "[#{SHOPNAME}/지연상품 취소 및 출고 안내]\n\n안녕하세요, #{NAME} 고객님!\n안내드린 상품의 입고가 5 영업일 이상 경과되어, 입고일이 불투명한 장기지연이 예상되고 있습니다. 이에 부득이하게 해당 제품을 취소처리 후, 내일 나머지 제품만 출고될 예정입니다.\n(주말의 경우 차주 월요일 출고 / 단독상품 주문시 주문취소)\n오래 기다려 주셨으나, 정상출고 도와드리지 못해 대단히 죄송합니다.\n\n●취소예정상품\n#{PRODUCT}(#{OPTION})\n※ 안내가 없는 제품은 입고완료 제품입니다.\n※ 만약 취소하지 않고, 입고시까지 기다리시기를 원하시는 경우, 다음날 9:30AM까지 핑크로켓 고객센터(카카오톡:핑크로켓) / 구매처 게시판 등으로 연락부탁드립니다. 이경우, 추후 입고지연이 지속될 경우, 취소처리 될 수 있습니다.\n\n더욱 나은 서비스를 위해 노력하겠습니다. 감사합니다!",
  },
  d10: {
    label: "10일차 잔여취소",
    text:
      "[#{SHOPNAME}/지연상품 취소 안내]\n\n안녕하세요, #{NAME} 고객님!\n부분출고 후 지연상품의 입고를 꾸준히 체크하였으나, 현재 입고일이 불투명한 장기지연이 계속되고 있는 상태입니다. 이에 부득이하게 해당 제품을 취소처리 해드리고자 합니다.\n오래 기다려 주셨으나, 정상출고 도와드리지 못해 대단히 죄송합니다.\n\n●취소예정상품\n#{PRODUCT}(#{OPTION})\n\n더욱 나은 서비스를 위해 노력하겠습니다. 감사합니다!",
  },
  d0: {
    label: "내일출고",
    text:
      "[#{SHOPNAME}/내일 출고 안내]\n\n안녕하세요, #{NAME} 고객님!\n주문하신 상품이 오늘 모두 준비가 완료되었습니다.\n꼼꼼히 검품/포장 후, 내일 출고하겠습니다.\n(주말의 경우 차주 월요일 출고)\n기다려주셔서 감사합니다! :)",
  },
  "14k_1": {
    label: "14K 1일차",
    text:
      "[#{SHOPNAME}/14K제품 배송안내]\n\n안녕하세요, #{NAME} 고객님!\n주문하신 14K 제품이 현재 제작진행 중입니다!\n\n●현재 제작중인 14K 제품\n#{PRODUCT}(#{OPTION})\n※ 안내가 없는 제품은 입고완료된 제품입니다.\n※ 14K 제품은 주문 후 제작되는 방식입니다. (1-2주 소요 / 빠른 출고를 위한 선재고 보유품목 제외)\n※ 자세한 내용은 상세 공지 확인해주세요!\n\n빠른 출고가 되도록 노력하겠습니다!",
  },
  "14k_5": {
    label: "14K 5일차 부분출고",
    text:
      "[#{SHOPNAME}/부분 출고 안내]\n\n안녕하세요, #{NAME} 고객님!\n주문해 주신 상품 중, 제작 주문이 들어간 제품 이외에 준비된 제품만 내일 우선적으로 부분출고될 예정입니다.\n(주말의 경우 차주 월요일 출고)\n\n●현재 제작중인 14K 제품\n#{PRODUCT}(#{OPTION})\n※ 안내가 없는 제품은 준비완료 제품으로, 익일 부분출고됩니다.\n※ 안내된 제품은 제작이 완료되는 대로 추가출고됩니다.\n\n더욱 나은 서비스를 위해 노력하겠습니다. 감사합니다!",
  },
};
const CS_DAYS = [
  { key: "all", label: "전체" },
  { key: "내일출고", label: "내일출고" },
  { key: "1일차", label: "1일차 기본" },
  { key: "3일차 메이크샵", label: "3일차 메이크샵" },
  { key: "3일차 플랫폼", label: "3일차 플랫폼" },
  { key: "5일차 부분출고", label: "5일차 부분출고" },
  { key: "5일차 취소출고", label: "5일차 취소출고" },
  { key: "10일차", label: "10일차 잔여취소" },
  { key: "14K 1일차", label: "14K 1일차" },
  { key: "14K 5일차", label: "14K 5일차 부분출고" },
];
const CS_DAY_TEMPLATE = {
  내일출고: "d0",
  "1일차": "d1",
  "3일차 메이크샵": "d3_ms",
  "3일차 플랫폼": "d3_pf",
  "5일차 부분출고": "d5_hi",
  "5일차 취소출고": "d5_lo",
  "10일차": "d10",
  "14K 1일차": "14k_1",
  "14K 5일차": "14k_5",
};

const params = new URLSearchParams(location.search);
const allowWrites = params.get("write") !== "0";
const allowOrderReorder = allowWrites && params.get("reorder") === "1";
const allowWorkflowEvents = allowWrites && params.get("events") !== "0";
const db = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
const imageDb = window.supabase.createClient(IMAGE_SUPABASE_URL, IMAGE_SUPABASE_KEY);
const csCases = createCsCaseAdapter(db);
const orderItemOperations = createOrderItemOperationsAdapter(db);
const skuInboundSchedules = createSkuInboundSchedulesAdapter(db);
const alimtalkSends = createAlimtalkSendAdapter(db);

function todayDateString() {
  const date = new Date();
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

const state = {
  activeTab: "picking",
  selectedDate: todayDateString(),
  session: "ALL",
  workSortMode: true,
  filterMode: "all",
  viewModel: null,
  groups: [],
  groupInfos: [],
  currentGroup: 0,
  trayOpen: false,
  trayExpanded: false,
  currentTrayKey: "",
  searchText: "",
  workflowQueues: null,
  workflowQueueError: "",
  selectedShortageKey: "",
  shortageBulkSelectedKeys: new Set(),
  shortageBulkSaving: false,
  shortageFilter: "all",
  shortageSearchText: "",
  receivingLabel: {
    only: false,
    fileName: "",
    entries: [],
    productMap: new Map(),
    ownCodeMap: new Map(),
    rowCount: 0,
    totalQty: 0,
    error: "",
    source: "none",
    syncError: "",
  },
  selectedInspectionGroup: "",
  selectedInspectionItemKey: "",
  selectedCompletedGroup: "",
  completedDateMode: "receipt",
  inspectionFilter: "all",
  inspectionHideCompleted: false,
  inspectionSearchText: "",
  csDateFilter: "all",
  csSearchText: "",
  selectedCsKey: "",
  csCases: [],
  csCaseContexts: { orders: new Map(), items: new Map() },
  csCasesLoading: false,
  csCasesLoaded: false,
  csCaseError: "",
  csMode: "cases",
  csStatusFilter: "pending",
  csTypeFilter: "",
  csTemplateOnly: false,
  csGoldFilter: "all",
  csInboundDateFilter: "all",
  csSort: "receipt_desc",
  csManualCandidates: [],
  orderItemOperations: [],
  orderItemOperationsLoaded: false,
  customOrders: {
    view: "workflow",
    loaded: false,
    loading: false,
    error: "",
    operations: [],
    currentItems: [],
    skuSchedules: [],
    skuSchedulesLoaded: false,
    skuScheduleImportStatus: "",
    status: "active",
    supplier: "",
    dateCriterion: "required",
    dateFrom: "",
    dateTo: "",
    search: "",
    inboundSource: "all",
    inboundSupplier: "",
    inboundDateFrom: "",
    inboundDateTo: "",
    inboundSort: "asc",
    inboundSearch: "",
  },
  csReceiptBusinessDates: new Set(),
  csReceiptBusinessDayCache: new Map(),
  csOpenShortageItemKeys: new Set(),
  sidebarCollapsed: false,
  workflowEventsReady: false,
  workflowEventsChecked: false,
  saving: new Set(),
  workflowSaving: new Set(),
  shortageSaveQueues: new Map(),
  drawerKeypad: {
    orderGroupNo: "",
    value: "",
    note: "",
    input: null,
  },
  orderListModal: {
    open: false,
    filter: "all",
    search: "",
    sourceCount: 0,
  },
  csWorkLogModal: {
    open: false,
    filter: "all",
    search: "",
    loading: false,
    loaded: false,
    rows: [],
    returnToOrderList: false,
  },
  dashboardMonthKey: todayDateString().slice(0, 7),
  photoViewer: {
    open: false,
    src: "",
    title: "",
    zoom: PHOTO_VIEWER_ZOOM_DEFAULT,
  },
  productPhotoUpload: {
    running: false,
    versions: new Map(),
  },
  productPhotoLibrary: {
    entries: [],
    loaded: false,
    loading: false,
    error: "",
    offset: 0,
    hasMore: true,
    search: "",
    type: "all",
    mutatingName: "",
    contextMenuName: "",
    selectedNames: new Set(),
  },
  inventoryCountExportRunning: false,
};

const els = {
  dateInput: document.getElementById("date-input"),
  refreshBtn: document.getElementById("refresh-btn"),
  todayBtn: document.getElementById("today-btn"),
  sortToggle: document.getElementById("sort-toggle"),
  searchInput: document.getElementById("search-input"),
  filterBar: document.getElementById("filter-bar"),
  mainGrid: document.querySelector(".main-grid"),
  sidebar: document.querySelector(".sidebar"),
  sidebarToggle: document.getElementById("sidebar-toggle"),
  sideShortcuts: document.getElementById("side-shortcuts"),
  inspectionFilterBar: document.getElementById("inspection-filter-bar"),
  inspectionSearchInput: document.getElementById("inspection-search-input"),
  groupList: document.getElementById("group-list"),
  jumpGroupInput: document.getElementById("jump-group-input"),
  jumpGroupBtn: document.getElementById("jump-group-btn"),
  jumpSeqInput: document.getElementById("jump-seq-input"),
  jumpSeqBtn: document.getElementById("jump-seq-btn"),
  jumpInvoiceInput: document.getElementById("jump-invoice-input"),
  jumpInvoiceBtn: document.getElementById("jump-invoice-btn"),
  pickingPanel: document.getElementById("picking-panel"),
  dashboardPanel: document.getElementById("dashboard-panel"),
  shortagePanel: document.getElementById("shortage-panel"),
  inspectionPanel: document.getElementById("inspection-panel"),
  csPanel: document.getElementById("cs-panel"),
  customOrdersPanel: document.getElementById("custom-orders-panel"),
  completedPanel: document.getElementById("completed-panel"),
  shortageListCount: document.getElementById("shortage-list-count"),
  shortageBulkCompleteBtn: document.getElementById("shortage-bulk-complete-btn"),
  shortageListBody: document.getElementById("shortage-list-body"),
  shortageDetail: document.getElementById("shortage-detail"),
  shortageFilterBar: document.getElementById("shortage-filter-bar"),
  shortageSearchInput: document.getElementById("shortage-search-input"),
  shortageReceivingFile: document.getElementById("shortage-receiving-file"),
  shortageReceivingOnly: document.getElementById("shortage-receiving-only"),
  shortageReceivingStatus: document.getElementById("shortage-receiving-status"),
  inspectionListCount: document.getElementById("inspection-list-count"),
  inspectionListBody: document.getElementById("inspection-list-body"),
  inspectionDetail: document.getElementById("inspection-detail"),
  csDateTabs: document.getElementById("cs-date-tabs"),
  csSearchInput: document.getElementById("cs-search-input"),
  csListCount: document.getElementById("cs-list-count"),
  csListSort: document.getElementById("cs-list-sort"),
  csListBody: document.getElementById("cs-list-body"),
  csDetail: document.getElementById("cs-detail"),
  customOrdersRefresh: document.getElementById("custom-orders-refresh"),
  customOrdersStatus: document.getElementById("custom-orders-status"),
  customOrdersSupplier: document.getElementById("custom-orders-supplier"),
  customOrdersDateCriterion: document.getElementById("custom-orders-date-criterion"),
  customOrdersDateFrom: document.getElementById("custom-orders-date-from"),
  customOrdersDateTo: document.getElementById("custom-orders-date-to"),
  customOrdersSearch: document.getElementById("custom-orders-search"),
  customOrdersSummaryText: document.getElementById("custom-orders-summary-text"),
  customOrdersInboundSource: document.getElementById("custom-orders-inbound-source"),
  customOrdersInboundSupplier: document.getElementById("custom-orders-inbound-supplier"),
  customOrdersInboundDateFrom: document.getElementById("custom-orders-inbound-date-from"),
  customOrdersInboundDateTo: document.getElementById("custom-orders-inbound-date-to"),
  customOrdersInboundSort: document.getElementById("custom-orders-inbound-sort"),
  customOrdersInboundSearch: document.getElementById("custom-orders-inbound-search"),
  customOrdersSkuSchedulePanel: document.getElementById("custom-orders-sku-schedule-panel"),
  customOrdersSkuInput: document.getElementById("custom-orders-sku-input"),
  customOrdersSkuDate: document.getElementById("custom-orders-sku-date"),
  customOrdersSkuOwnCode: document.getElementById("custom-orders-sku-own-code"),
  customOrdersSkuSave: document.getElementById("custom-orders-sku-save"),
  customOrdersSkuUpload: document.getElementById("custom-orders-sku-upload"),
  customOrdersSkuFile: document.getElementById("custom-orders-sku-file"),
  customOrdersSkuDownload: document.getElementById("custom-orders-sku-download"),
  customOrdersSkuImportStatus: document.getElementById("custom-orders-sku-import-status"),
  customOrdersSkuCount: document.getElementById("custom-orders-sku-count"),
  customOrdersSkuList: document.getElementById("custom-orders-sku-list"),
  customOrdersCount: document.getElementById("custom-orders-count"),
  customOrdersList: document.getElementById("custom-orders-list"),
  completedListCount: document.getElementById("completed-list-count"),
  completedListBody: document.getElementById("completed-list-body"),
  completedDetail: document.getElementById("completed-detail"),
  dashboardSummary: document.getElementById("dashboard-summary"),
  dashboardPhotoInput: document.getElementById("dashboard-photo-input"),
  dashboardPhotoDropzone: document.getElementById("dashboard-photo-dropzone"),
  dashboardPhotoUploadBtn: document.getElementById("dashboard-photo-upload-btn"),
  dashboardPhotoUploadStatus: document.getElementById("dashboard-photo-upload-status"),
  dashboardPhotoSearch: document.getElementById("dashboard-photo-search"),
  dashboardPhotoFilter: document.getElementById("dashboard-photo-filter"),
  dashboardPhotoLibraryStatus: document.getElementById("dashboard-photo-library-status"),
  dashboardPhotoLibraryGrid: document.getElementById("dashboard-photo-library-grid"),
  dashboardPhotoLibraryMore: document.getElementById("dashboard-photo-library-more"),
  dashboardInventoryCountExportBtn: document.getElementById("dashboard-inventory-count-export-btn"),
  orderList: document.getElementById("order-list"),
  panelSubtitle: document.getElementById("panel-subtitle"),
  currentGroupLabel: document.getElementById("current-group-label"),
  progressText: document.getElementById("progress-text"),
  progressFill: document.getElementById("progress-fill"),
  bottomTray: document.getElementById("bottom-tray"),
  trayHandle: document.getElementById("tray-handle"),
  trayExpandBtn: document.getElementById("tray-expand-btn"),
  trayLabel: document.getElementById("tray-label"),
  trayCount: document.getElementById("tray-count"),
  trayTitle: document.getElementById("tray-title"),
  trayBoard: document.getElementById("tray-board"),
  metricOrders: document.getElementById("metric-orders"),
  metricPicked: document.getElementById("metric-picked"),
  metricShortage: document.getElementById("metric-shortage"),
  metricHold: document.getElementById("metric-hold"),
  metricWrite: document.getElementById("metric-write"),
  metricEvents: document.getElementById("metric-events"),
  toast: document.getElementById("toast"),
};

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compactCode(value) {
  return String(value || "")
    .replace(/\s+/g, "")
    .replace(/[()[\]{}]/g, "")
    .toUpperCase();
}

function codeCompareKey(value) {
  return String(value || "")
    .replace(/[\s()[\]{}]/g, "")
    .replace(/[^0-9A-Z_-]/gi, "")
    .toUpperCase();
}

function ownCodeCandidates(ownCode) {
  const raw = String(ownCode || "").trim();
  const withoutPrefix = raw.replace(/^\[[^\]]+\]\s*/, "").trim();
  const noBrackets = raw.replace(/[\[\]{}()]/g, "").trim();
  const compact = codeCompareKey(raw);
  const withoutPrefixCompact = codeCompareKey(withoutPrefix);
  return [...new Set([raw, withoutPrefix, noBrackets, compact, withoutPrefixCompact].filter(Boolean))];
}

function receivingProductCodeKey(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, "")
    .toUpperCase();
}

function receivingOwnCodeKeys(value) {
  const raw = String(value || "").trim();
  if (!raw) return [];
  const withoutPrefix = raw.replace(/^\[[^\]]+\]\s*/, "").trim();
  const withoutTrailingLabel = withoutPrefix.replace(/\]\s*\d+$/g, "").trim();
  return [...new Set([raw, withoutPrefix, withoutTrailingLabel, ...ownCodeCandidates(raw)].map(codeCompareKey).filter(Boolean))];
}

function numberFromCell(value) {
  if (value === null || value === undefined || value === "") return 0;
  const number = Number(String(value).replace(/,/g, "").trim());
  return Number.isFinite(number) ? number : 0;
}

function onlyDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

function toast(message) {
  els.toast.textContent = message;
  els.toast.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => {
    els.toast.hidden = true;
  }, 1800);
}

async function fetchAllRows(makeQuery, pageSize = 1000) {
  const rows = [];
  for (let from = 0; ; from += pageSize) {
    const to = from + pageSize - 1;
    const { data, error } = await makeQuery().range(from, to);
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < pageSize) break;
  }
  return rows;
}

function productPhotoVersionStorageKey(code) {
  return `system-v3-product-photo-version::${code}`;
}

function productPhotoVersion(code) {
  if (state.productPhotoUpload.versions.has(code)) return state.productPhotoUpload.versions.get(code);
  let version = "";
  try {
    version = window.localStorage.getItem(productPhotoVersionStorageKey(code)) || "";
  } catch {
    version = "";
  }
  state.productPhotoUpload.versions.set(code, version);
  return version;
}

function markProductPhotoUpdated(code) {
  const version = String(Date.now());
  state.productPhotoUpload.versions.set(code, version);
  try {
    window.localStorage.setItem(productPhotoVersionStorageKey(code), version);
  } catch {
    // Local storage can be unavailable in restricted browser modes. The in-memory nonce still refreshes this page.
  }
  return version;
}

function productImageUrlForCode(code) {
  const normalizedCode = String(code || "").trim();
  if (!normalizedCode) return "";
  const base = `${IMAGE_SUPABASE_URL}/storage/v1/object/public/${IMAGE_BUCKET}/${PRODUCT_PHOTO_FOLDER}/${encodeURIComponent(normalizedCode)}.jpg`;
  const version = productPhotoVersion(normalizedCode);
  return version ? `${base}?v=${encodeURIComponent(version)}` : base;
}

function productImageUrl(sellpiaProductCode) {
  return productImageUrlForCode(productPhotoPriorityCode(sellpiaProductCode));
}

function productPhotoRangeCode(code) {
  const normalizedCode = String(code || "").trim();
  return normalizedCode ? `${normalizedCode}${PRODUCT_PHOTO_RANGE_SUFFIX}` : "";
}

function productPhotoGroupCode(code) {
  const normalizedCode = String(code || "").trim();
  return normalizedCode ? `${normalizedCode}${PRODUCT_PHOTO_GROUP_SUFFIX}` : "";
}

function productPhotoPriorityCode(code) {
  const normalizedCode = String(code || "").trim();
  return normalizedCode ? `${normalizedCode}${PRODUCT_PHOTO_PRIORITY_SUFFIX}` : "";
}

function productPhotoStorageCode(code, tier = "direct", priority = false) {
  const baseCode = tier === "group"
    ? productPhotoGroupCode(code)
    : tier === "range"
      ? productPhotoRangeCode(code)
      : String(code || "").trim();
  return priority ? productPhotoPriorityCode(baseCode) : baseCode;
}

function productImageFallbackUrls(sellpiaProductCode) {
  const code = String(sellpiaProductCode || "").trim();
  const match = code.match(/^(.+)-(\d+)$/);
  if (!code) return [];
  if (!match?.[1]) return [productImageUrlForCode(code)];
  return [
    productImageUrlForCode(productPhotoPriorityCode(productPhotoGroupCode(code))),
    productImageUrlForCode(productPhotoPriorityCode(productPhotoRangeCode(code))),
    productImageUrlForCode(productPhotoPriorityCode(match[1])),
    productImageUrlForCode(code),
    productImageUrlForCode(productPhotoGroupCode(code)),
    productImageUrlForCode(productPhotoRangeCode(code)),
    productImageUrlForCode(match[1]),
  ];
}

function photoFileStem(fileName) {
  const name = String(fileName || "").trim();
  const stem = name.replace(/\.[^.]+$/, "").trim();
  if (!stem || stem === "." || stem === ".." || stem.length > 160 || /[\\/]/.test(stem)) return "";
  return stem;
}

function photoFileRule(fileName) {
  const rawStem = photoFileStem(fileName);
  const priorityMatch = rawStem.match(/^\{(.+)\}$/);
  if (!priorityMatch) return { stem: rawStem, priority: false };
  const stem = String(priorityMatch[1] || "").trim();
  if (!stem || stem.length > 160 || /[\\/{}]/.test(stem)) return { stem: "", priority: true };
  return { stem, priority: true };
}

function sellpiaSkuTargetsFromPhotoFileName(fileName) {
  const { stem } = photoFileRule(fileName);
  if (!stem) return [];
  const grouped = /^(.*)-((?:\[[^\]]+\])+)$/.exec(stem);
  if (!grouped) return [stem];

  const prefix = String(grouped[1] || "").trim();
  const bracketSource = grouped[2] || "";
  if (!prefix || prefix.length > 150 || /[\\/]/.test(prefix)) return [];
  const parts = [...bracketSource.matchAll(/\[([^\]]+)\]/g)].map((match) => String(match[1] || "").trim());
  if (!parts.length || parts.map((part) => `[${part}]`).join("") !== bracketSource) return [];

  const suffixes = new Set();
  for (const part of parts) {
    const range = part.match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || end - start >= 200) return [];
      for (let value = start; value <= end; value += 1) suffixes.add(value);
      continue;
    }
    if (!/^\d+$/.test(part)) return [];
    const value = Number(part);
    if (!Number.isSafeInteger(value) || value < 1) return [];
    suffixes.add(value);
  }
  return [...suffixes].sort((a, b) => a - b).map((suffix) => `${prefix}-${suffix}`);
}

function photoFileTargetTier(fileName) {
  const { stem } = photoFileRule(fileName);
  const grouped = stem && /^(.*)-((?:\[[^\]]+\])+)$/.exec(stem);
  if (!grouped) return "direct";
  const parts = [...grouped[2].matchAll(/\[([^\]]+)\]/g)].map((match) => String(match[1] || "").trim());
  if (!parts.length) return "";
  if (parts.every((part) => /^\d+$/.test(part))) return "group";
  if (parts.every((part) => /^\d+\s*-\s*\d+$/.test(part))) return "range";
  return "";
}

function photoFileHasPriority(fileName) {
  return photoFileRule(fileName).priority && Boolean(photoFileRule(fileName).stem);
}

function sellpiaSkuFromPhotoFileName(fileName) {
  const targets = sellpiaSkuTargetsFromPhotoFileName(fileName);
  return targets.length === 1 ? targets[0] : "";
}

function productPhotoFileAllowed(file) {
  const type = String(file?.type || "").toLowerCase();
  const name = String(file?.name || "").toLowerCase();
  return ["image/jpeg", "image/png", "image/webp"].includes(type) || /\.(jpe?g|png|webp)$/.test(name);
}

async function decodeProductPhoto(file) {
  if (typeof window.createImageBitmap === "function") {
    const bitmap = await window.createImageBitmap(file);
    return {
      source: bitmap,
      width: bitmap.width,
      height: bitmap.height,
      release: () => bitmap.close(),
    };
  }

  const objectUrl = URL.createObjectURL(file);
  try {
    const image = await new Promise((resolve, reject) => {
      const next = new Image();
      next.onload = () => resolve(next);
      next.onerror = () => reject(new Error("이미지 파일을 읽지 못했습니다."));
      next.src = objectUrl;
    });
    return {
      source: image,
      width: image.naturalWidth,
      height: image.naturalHeight,
      release: () => URL.revokeObjectURL(objectUrl),
    };
  } catch (error) {
    URL.revokeObjectURL(objectUrl);
    throw error;
  }
}

function canvasJpegBlob(canvas, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("JPG 변환에 실패했습니다."));
    }, "image/jpeg", quality);
  });
}

async function normalizeProductPhotoToJpeg(file) {
  const decoded = await decodeProductPhoto(file);
  try {
    if (!decoded.width || !decoded.height) throw new Error("이미지 크기를 확인하지 못했습니다.");
    const scale = Math.min(1, PRODUCT_PHOTO_MAX_DIMENSION / Math.max(decoded.width, decoded.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(decoded.width * scale));
    canvas.height = Math.max(1, Math.round(decoded.height * scale));
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("이미지 변환 기능을 사용할 수 없습니다.");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(decoded.source, 0, 0, canvas.width, canvas.height);

    for (const quality of [0.9, 0.82, 0.72]) {
      const blob = await canvasJpegBlob(canvas, quality);
      if (blob.size <= PRODUCT_PHOTO_MAX_BYTES) return blob;
    }
    throw new Error("변환 후에도 사진이 5MB를 초과합니다.");
  } finally {
    decoded.release();
  }
}

function renderProductPhotoUploadStatus({ message, tone = "", details = [] }) {
  if (!els.dashboardPhotoUploadStatus) return;
  els.dashboardPhotoUploadStatus.className = `dashboard-photo-upload-status ${tone}`.trim();
  els.dashboardPhotoUploadStatus.innerHTML = `<strong>${escapeHtml(message)}</strong>${details.length ? `<ul>${details.map((detail) => `<li>${escapeHtml(detail)}</li>`).join("")}</ul>` : ""}`;
}

function setProductPhotoUploadBusy(running) {
  state.productPhotoUpload.running = running;
  if (els.dashboardPhotoUploadBtn) {
    els.dashboardPhotoUploadBtn.disabled = running || !allowWrites;
    els.dashboardPhotoUploadBtn.textContent = running ? "사진 저장 중..." : "사진 여러 장 선택";
  }
  els.dashboardPhotoDropzone?.classList.toggle("is-uploading", running);
  els.dashboardPhotoDropzone?.setAttribute("aria-busy", running ? "true" : "false");
}

async function uploadProductPhotos(fileList) {
  if (!allowWrites) {
    toast("읽기전용입니다. URL에 write=1을 붙여 사진을 업로드할 수 있습니다.");
    return;
  }
  if (state.productPhotoUpload.running) return;
  const files = [...(fileList || [])];
  if (!files.length) return;

  setProductPhotoUploadBusy(true);
  const successes = [];
  const failures = [];
  try {
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      const targetSkus = sellpiaSkuTargetsFromPhotoFileName(file.name);
      const targetTier = photoFileTargetTier(file.name);
      const priority = photoFileHasPriority(file.name);
      renderProductPhotoUploadStatus({ message: `사진 저장 중 ${index + 1}/${files.length}: ${targetSkus.join(", ") || file.name}` });
      if (!targetSkus.length || !targetTier) {
        failures.push(`${file.name}: 파일명 형식을 확인할 수 없음 (예: 8601.jpg, 8601-2.jpg, 8601-[1][3].jpg, 8601-[1-10].jpg, {8601}.jpg)`);
        continue;
      }
      if (!productPhotoFileAllowed(file)) {
        failures.push(`${file.name}: JPG, PNG, WEBP만 가능`);
        continue;
      }

      try {
        const jpeg = await normalizeProductPhotoToJpeg(file);
        for (const sku of targetSkus) {
          const storageSku = productPhotoStorageCode(sku, targetTier, priority);
          const objectPath = `${PRODUCT_PHOTO_FOLDER}/${storageSku}.jpg`;
          const { error } = await imageDb.storage.from(IMAGE_BUCKET).upload(objectPath, jpeg, {
            contentType: "image/jpeg",
            cacheControl: "0",
            upsert: true,
          });
          if (error) {
            failures.push(`${file.name} → ${sku}: ${error.message || error}`);
            continue;
          }
          markProductPhotoUpdated(storageSku);
          successes.push(sku);
        }
      } catch (error) {
        failures.push(`${file.name}: ${error?.message || error}`);
      }
    }
  } finally {
    setProductPhotoUploadBusy(false);
    if (els.dashboardPhotoInput) els.dashboardPhotoInput.value = "";
  }

  const summary = failures.length
    ? `사진 저장 완료 ${successes.length}개 · 실패 ${failures.length}개`
    : `사진 ${successes.length}개 저장 완료`;
  const details = [
    ...(successes.length ? [`저장 SKU: ${successes.join(", ")}`] : []),
    ...failures,
  ];
  renderProductPhotoUploadStatus({ message: summary, tone: failures.length ? "warn" : "success", details });
  if (successes.length) loadProductPhotoLibrary({ reset: true }).catch(() => {});
  toast(summary);
}

function productPhotoLibraryEntry(file = {}) {
  const name = String(file.name || "").trim();
  if (!/\.jpg$/i.test(name)) return null;
  const storageCode = name.replace(/\.jpg$/i, "");
  if (!storageCode || /[\\/]/.test(storageCode)) return null;

  const priority = storageCode.endsWith(PRODUCT_PHOTO_PRIORITY_SUFFIX);
  const tierStorageCode = priority ? storageCode.slice(0, -PRODUCT_PHOTO_PRIORITY_SUFFIX.length) : storageCode;
  let type = "direct";
  let code = tierStorageCode;
  if (tierStorageCode.endsWith(PRODUCT_PHOTO_GROUP_SUFFIX)) {
    type = "group";
    code = tierStorageCode.slice(0, -PRODUCT_PHOTO_GROUP_SUFFIX.length);
  } else if (tierStorageCode.endsWith(PRODUCT_PHOTO_RANGE_SUFFIX)) {
    type = "range";
    code = tierStorageCode.slice(0, -PRODUCT_PHOTO_RANGE_SUFFIX.length);
  } else if (!/^.+-\d+$/.test(tierStorageCode)) {
    type = "common";
  }
  if (!code) return null;

  return {
    name,
    storageCode,
    code,
    type,
    priority,
    updatedAt: String(file.updated_at || file.created_at || ""),
    bytes: Number(file.metadata?.size || 0),
  };
}

function productPhotoTypeLabel(type, priority = false) {
  const label = ({ direct: "전용 파일", group: "개별번호 묶음", range: "범위 사진", common: "공용 prefix" })[type] || "사진";
  return priority ? `우선 적용 · ${label}` : label;
}

function productPhotoSizeLabel(bytes) {
  const value = Number(bytes || 0);
  if (!Number.isFinite(value) || value <= 0) return "용량 정보 없음";
  if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function productPhotoDateLabel(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "날짜 정보 없음";
  return date.toLocaleDateString("ko-KR", { month: "numeric", day: "numeric" });
}

function visibleProductPhotoEntries() {
  const library = state.productPhotoLibrary;
  const search = String(library.search || "").trim().toLowerCase();
  return library.entries.filter((entry) => {
    if (library.type !== "all" && entry.type !== library.type) return false;
    return !search || `${entry.code} ${entry.name}`.toLowerCase().includes(search);
  });
}

function productPhotoLibraryEntryByName(name) {
  return state.productPhotoLibrary.entries.find((entry) => entry.name === String(name || "")) || null;
}

function productPhotoRenameCode(value) {
  const code = photoFileStem(value);
  if (!code || /[\[\]]/.test(code) || code.endsWith(PRODUCT_PHOTO_GROUP_SUFFIX) || code.endsWith(PRODUCT_PHOTO_RANGE_SUFFIX)) return "";
  return sellpiaSkuFromPhotoFileName(`${code}.jpg`) ? code : "";
}

function productPhotoRenameStorageCode(entry, code) {
  return productPhotoStorageCode(code, entry?.type || "direct", Boolean(entry?.priority));
}

async function loadProductPhotoBlob(storageCode) {
  const sourceUrl = `${productImageUrlForCode(storageCode)}${productImageUrlForCode(storageCode).includes("?") ? "&" : "?"}copy=${Date.now()}`;
  const response = await fetch(sourceUrl, { cache: "no-store" });
  if (!response.ok) throw new Error(`원본 사진을 읽지 못했습니다. (${response.status})`);
  const blob = await response.blob();
  if (!blob.size) throw new Error("원본 사진이 비어 있습니다.");
  return blob;
}

async function verifyProductPhotoObject(storageCode) {
  const checkUrl = `${productImageUrlForCode(storageCode)}${productImageUrlForCode(storageCode).includes("?") ? "&" : "?"}check=${Date.now()}`;
  const response = await fetch(checkUrl, { cache: "no-store" });
  if (!response.ok) throw new Error(`새 사진을 확인하지 못했습니다. (${response.status})`);
}

function setProductPhotoLibraryMutating(name = "") {
  state.productPhotoLibrary.mutatingName = String(name || "");
  renderProductPhotoLibrary();
}

async function renameProductPhotoLibraryEntry(entry) {
  if (!entry || !allowWrites) {
    toast("읽기전용입니다. URL에 write=1을 붙여 사진을 관리할 수 있습니다.");
    return;
  }
  if (state.productPhotoLibrary.mutatingName) return;

  const nextName = window.prompt(
    `이 사진 한 장을 새 SKU에 연결합니다.\n\n현재 연결: ${entry.code}.jpg\n입력 예: 8601.jpg 또는 8601-2.jpg\n\n새 이름으로 저장한 뒤 기존 파일은 삭제됩니다.\n즉, 정상 완료되면 사진이 두 장 남지 않습니다.${entry.priority ? "\n\n※ 현재 우선 적용 설정은 그대로 유지됩니다." : ""}`,
    `${entry.code}.jpg`,
  );
  if (nextName === null) return;
  const nextCode = productPhotoRenameCode(nextName);
  if (!nextCode) {
    toast("파일명은 단일 SKU 형식으로 입력하세요. 예: 8601.jpg 또는 8601-2.jpg");
    return;
  }

  const targetStorageCode = productPhotoRenameStorageCode(entry, nextCode);
  if (targetStorageCode === entry.storageCode) {
    toast("같은 파일명입니다.");
    return;
  }
  const sourcePath = `${PRODUCT_PHOTO_FOLDER}/${entry.name}`;
  const targetPath = `${PRODUCT_PHOTO_FOLDER}/${targetStorageCode}.jpg`;
  setProductPhotoLibraryMutating(entry.name);
  try {
    const blob = await loadProductPhotoBlob(entry.storageCode);
    const { error: uploadError } = await imageDb.storage.from(IMAGE_BUCKET).upload(targetPath, blob, {
      contentType: "image/jpeg",
      cacheControl: "0",
      upsert: true,
    });
    if (uploadError) throw uploadError;
    markProductPhotoUpdated(targetStorageCode);
    await verifyProductPhotoObject(targetStorageCode);
    const { error: removeError } = await imageDb.storage.from(IMAGE_BUCKET).remove([sourcePath]);
    if (removeError) throw new Error(`새 이름으로 복사됐지만 기존 파일 삭제에 실패했습니다: ${removeError.message || removeError}`);
    markProductPhotoUpdated(entry.storageCode);
    toast(`${entry.code} → ${nextCode} 이름 변경 완료`);
  } finally {
    setProductPhotoLibraryMutating("");
  }
  await loadProductPhotoLibrary({ reset: true });
}

function selectedProductPhotoLibraryEntries() {
  const selectedNames = state.productPhotoLibrary.selectedNames;
  return state.productPhotoLibrary.entries.filter((entry) => selectedNames.has(entry.name));
}

function setProductPhotoLibraryEntrySelected(name, selected) {
  const selectedNames = state.productPhotoLibrary.selectedNames;
  if (selected) selectedNames.add(String(name || ""));
  else selectedNames.delete(String(name || ""));
  renderProductPhotoLibrary();
}

async function deleteProductPhotoLibraryEntries(entries) {
  const uniqueEntries = [...new Map((entries || []).filter(Boolean).map((entry) => [entry.name, entry])).values()];
  if (!uniqueEntries.length) return;
  if (!allowWrites) {
    toast("읽기전용입니다. URL에 write=1을 붙여 사진을 관리할 수 있습니다.");
    return;
  }
  if (state.productPhotoLibrary.mutatingName) return;
  const preview = uniqueEntries.slice(0, 12).map((entry) => `- ${entry.name}`).join("\n");
  const remaining = uniqueEntries.length > 12 ? `\n… 외 ${uniqueEntries.length - 12}개` : "";
  const confirmed = window.confirm(
    `${uniqueEntries.length}개 사진 파일을 삭제할까요?\n\n${preview}${remaining}\n\n삭제하면 선택한 사진은 라이브러리와 상품 연결에서 바로 제거됩니다.\n삭제 후에는 사진 파일이 남아 있지 않습니다.`,
  );
  if (!confirmed) return;

  setProductPhotoLibraryMutating(uniqueEntries.length > 1 ? "__bulk__" : uniqueEntries[0].name);
  try {
    const { error } = await imageDb.storage.from(IMAGE_BUCKET).remove(uniqueEntries.map((entry) => `${PRODUCT_PHOTO_FOLDER}/${entry.name}`));
    if (error) throw error;
    uniqueEntries.forEach((entry) => {
      markProductPhotoUpdated(entry.storageCode);
      state.productPhotoLibrary.selectedNames.delete(entry.name);
    });
    toast(uniqueEntries.length === 1 ? `${uniqueEntries[0].code} 사진을 삭제했습니다.` : `선택 사진 ${uniqueEntries.length}개를 삭제했습니다.`);
  } finally {
    setProductPhotoLibraryMutating("");
  }
  await loadProductPhotoLibrary({ reset: true });
}

function deleteProductPhotoLibraryEntry(entry) {
  return deleteProductPhotoLibraryEntries([entry]);
}

function ensureProductPhotoLibraryContextMenu() {
  let menu = document.getElementById("photo-library-context-menu");
  if (menu) return menu;
  menu = document.createElement("div");
  menu.id = "photo-library-context-menu";
  menu.className = "photo-library-context-menu";
  menu.hidden = true;
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", "사진 관리 메뉴");
  menu.innerHTML = `
    <button type="button" role="menuitem" data-photo-library-context-action="rename">이름 변경</button>
    <button id="photo-library-context-delete" type="button" role="menuitem" class="danger" data-photo-library-context-action="delete">삭제</button>
  `;
  document.body.append(menu);
  return menu;
}

function closeProductPhotoLibraryContextMenu() {
  const menu = document.getElementById("photo-library-context-menu");
  if (menu) menu.hidden = true;
  state.productPhotoLibrary.contextMenuName = "";
}

function openProductPhotoLibraryContextMenu(entry, clientX, clientY) {
  if (!entry || state.productPhotoLibrary.mutatingName) return;
  const menu = ensureProductPhotoLibraryContextMenu();
  const selectedEntries = selectedProductPhotoLibraryEntries();
  const deleteButton = menu.querySelector("#photo-library-context-delete");
  const deleteSelected = selectedEntries.length > 1 && state.productPhotoLibrary.selectedNames.has(entry.name);
  if (deleteButton) {
    deleteButton.dataset.photoLibraryContextAction = deleteSelected ? "delete-selected" : "delete";
    deleteButton.textContent = deleteSelected ? `선택 사진 ${selectedEntries.length}개 삭제` : "삭제";
  }
  state.productPhotoLibrary.contextMenuName = entry.name;
  menu.hidden = false;
  menu.style.visibility = "hidden";
  menu.style.left = "0px";
  menu.style.top = "0px";
  const left = Math.max(8, Math.min(clientX, window.innerWidth - menu.offsetWidth - 8));
  const top = Math.max(8, Math.min(clientY, window.innerHeight - menu.offsetHeight - 8));
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  menu.style.visibility = "";
}

function openProductPhotoLibraryContextMenuFromEvent(event) {
  const target = event.target instanceof Element ? event.target : null;
  const card = target?.closest("[data-photo-library-entry]");
  if (!card) return false;
  event.preventDefault();
  openProductPhotoLibraryContextMenu(
    productPhotoLibraryEntryByName(card.dataset.photoLibraryEntry || ""),
    event.clientX,
    event.clientY,
  );
  return true;
}

function renderProductPhotoLibrary() {
  if (!els.dashboardPhotoLibraryGrid || !els.dashboardPhotoLibraryStatus) return;
  const library = state.productPhotoLibrary;
  const entries = visibleProductPhotoEntries();
  const selectedCount = selectedProductPhotoLibraryEntries().length;
  if (library.error) {
    els.dashboardPhotoLibraryStatus.className = "dashboard-photo-library-status error";
    els.dashboardPhotoLibraryStatus.textContent = `사진 목록을 불러오지 못했습니다: ${library.error}`;
  } else if (library.loading) {
    els.dashboardPhotoLibraryStatus.className = "dashboard-photo-library-status";
    els.dashboardPhotoLibraryStatus.textContent = library.entries.length ? `사진 ${library.entries.length}개를 불러왔습니다. 추가 목록을 읽는 중입니다.` : "사진 목록을 불러오는 중입니다.";
  } else if (!library.loaded) {
    els.dashboardPhotoLibraryStatus.className = "dashboard-photo-library-status";
    els.dashboardPhotoLibraryStatus.textContent = "사진 목록을 불러오는 중입니다.";
  } else {
    els.dashboardPhotoLibraryStatus.className = "dashboard-photo-library-status";
    els.dashboardPhotoLibraryStatus.textContent = `사진 ${entries.length}개 표시 · 선택 ${selectedCount}개 · ${library.hasMore ? "더 불러올 수 있습니다." : "전체 목록을 불러왔습니다."}`;
  }

  if (!entries.length) {
    const message = library.loading ? "사진 목록을 읽는 중입니다." : library.loaded ? "조건에 맞는 사진이 없습니다." : "사진 목록을 불러오는 중입니다.";
    els.dashboardPhotoLibraryGrid.innerHTML = `<div class="dashboard-photo-library-empty">${escapeHtml(message)}</div>`;
  } else {
    els.dashboardPhotoLibraryGrid.innerHTML = entries
      .map((entry) => {
        const imageUrl = productImageUrlForCode(entry.storageCode);
        const title = `${entry.code} · ${productPhotoTypeLabel(entry.type, entry.priority)}`;
        const isMutating = library.mutatingName === entry.name || library.mutatingName === "__bulk__";
        const isSelected = library.selectedNames.has(entry.name);
        return `<article class="dashboard-photo-library-item${isMutating ? " is-mutating" : ""}${isSelected ? " is-selected" : ""}" data-photo-library-entry="${escapeHtml(entry.name)}" title="체크로 여러 장 선택 · 우클릭으로 관리">
          <label class="dashboard-photo-library-select" title="이 사진 선택">
            <input type="checkbox" data-photo-library-select="${escapeHtml(entry.name)}" ${isSelected ? "checked" : ""} aria-label="${escapeHtml(entry.code)} 사진 선택">
          </label>
          <button class="dashboard-photo-library-thumb" type="button" ${photoImgAttrs(imageUrl, title)} aria-label="${escapeHtml(title)} 사진 확대">
            <img src="${escapeHtml(imageUrl)}" ${photoImgAttrs(imageUrl, title)} alt="${escapeHtml(entry.code)}" loading="lazy">
          </button>
          <div class="dashboard-photo-library-body">
            <span class="dashboard-photo-library-type ${escapeHtml(entry.type)}">${escapeHtml(productPhotoTypeLabel(entry.type, entry.priority))}</span>
            <strong title="${escapeHtml(entry.code)}">${escapeHtml(entry.code)}</strong>
            <span title="${escapeHtml(entry.name)}">${escapeHtml(entry.name)}</span>
            <span>${isMutating ? "사진 처리 중..." : `${escapeHtml(productPhotoDateLabel(entry.updatedAt))} · ${escapeHtml(productPhotoSizeLabel(entry.bytes))}`}</span>
          </div>
        </article>`;
      })
      .join("");
  }
  if (els.dashboardPhotoLibraryMore) {
    els.dashboardPhotoLibraryMore.hidden = library.loading || !library.hasMore || Boolean(library.error);
    els.dashboardPhotoLibraryMore.disabled = library.loading;
  }
}

async function loadProductPhotoLibrary({ reset = false } = {}) {
  const library = state.productPhotoLibrary;
  if (!els.dashboardPhotoLibraryGrid || library.loading) return;
  if (reset) {
    library.entries = [];
    library.selectedNames.clear();
    library.offset = 0;
    library.hasMore = true;
    library.loaded = false;
    library.error = "";
  }
  if (!library.hasMore) {
    renderProductPhotoLibrary();
    return;
  }

  library.loading = true;
  library.error = "";
  renderProductPhotoLibrary();
  const pageSize = 80;
  try {
    const { data, error } = await imageDb.storage.from(IMAGE_BUCKET).list(PRODUCT_PHOTO_FOLDER, {
      limit: pageSize,
      offset: library.offset,
      sortBy: { column: "name", order: "asc" },
      ...(library.search ? { search: library.search } : {}),
    });
    if (error) throw error;
    const incoming = (data || []).map(productPhotoLibraryEntry).filter(Boolean);
    const existing = new Set(library.entries.map((entry) => entry.name));
    library.entries.push(...incoming.filter((entry) => !existing.has(entry.name)));
    library.offset += (data || []).length;
    library.hasMore = (data || []).length === pageSize;
    library.loaded = true;
  } catch (error) {
    library.error = error?.message || String(error || "알 수 없는 오류");
  } finally {
    library.loading = false;
    renderProductPhotoLibrary();
  }
}

function searchProductPhotoLibrary() {
  state.productPhotoLibrary.search = String(els.dashboardPhotoSearch?.value || "").trim();
  state.productPhotoLibrary.type = String(els.dashboardPhotoFilter?.value || "all");
  loadProductPhotoLibrary({ reset: true }).catch(() => {});
}

function photoTitleForItem(item = {}) {
  return [item.ownCode, cleanOptionName(item.optionName, item.ownCode) || item.productName].filter(Boolean).join(" · ");
}

function photoImgAttrs(src, title = "", fallbackSrcs = []) {
  const fallbacks = [...new Set((Array.isArray(fallbackSrcs) ? fallbackSrcs : [fallbackSrcs]).map((value) => String(value || "").trim()).filter(Boolean))];
  const fallbackAttr = fallbacks.length ? ` data-photo-fallbacks="${escapeHtml(JSON.stringify(fallbacks))}"` : "";
  return `data-photo-src="${escapeHtml(src)}" data-photo-title="${escapeHtml(title)}"${fallbackAttr} onerror="var f=JSON.parse(this.dataset.photoFallbacks||'[]');if(f.length){var n=f.shift();this.dataset.photoFallbacks=JSON.stringify(f);this.src=n;this.dataset.photoSrc=n;}else{this.style.visibility='hidden'}"`;
}

function normalizePhotoViewerZoom(value) {
  const zoom = Math.round(Number(value));
  if (!Number.isFinite(zoom)) return PHOTO_VIEWER_ZOOM_DEFAULT;
  return Math.min(PHOTO_VIEWER_ZOOM_MAX, Math.max(PHOTO_VIEWER_ZOOM_MIN, zoom));
}

function savedPhotoViewerZoom() {
  try {
    return normalizePhotoViewerZoom(window.localStorage.getItem(PHOTO_VIEWER_ZOOM_STORAGE_KEY));
  } catch {
    return PHOTO_VIEWER_ZOOM_DEFAULT;
  }
}

function layoutPhotoViewerImage() {
  const overlay = document.getElementById("photo-viewer-overlay");
  if (!state.photoViewer.open || !overlay || overlay.hidden) return;
  const body = overlay.querySelector(".photo-viewer-body");
  const canvas = overlay.querySelector("#photo-viewer-canvas");
  const image = overlay.querySelector("#photo-viewer-img");
  if (!body || !canvas || !image?.naturalWidth || !image?.naturalHeight) return;

  const availableWidth = Math.max(1, body.clientWidth - 24);
  const availableHeight = Math.max(1, body.clientHeight - 24);
  const fitRatio = Math.min(1, availableWidth / image.naturalWidth, availableHeight / image.naturalHeight);
  const zoomRatio = state.photoViewer.zoom / 100;
  const imageWidth = Math.max(1, Math.round(image.naturalWidth * fitRatio * zoomRatio));
  const imageHeight = Math.max(1, Math.round(image.naturalHeight * fitRatio * zoomRatio));
  image.style.width = `${imageWidth}px`;
  image.style.height = `${imageHeight}px`;
  canvas.style.width = `${Math.max(availableWidth, imageWidth)}px`;
  canvas.style.height = `${Math.max(availableHeight, imageHeight)}px`;
}

function setPhotoViewerZoom(value, { persist = true } = {}) {
  const zoom = normalizePhotoViewerZoom(value);
  state.photoViewer.zoom = zoom;
  const input = document.getElementById("photo-viewer-zoom");
  if (input) input.value = String(zoom);
  if (persist) {
    try {
      window.localStorage.setItem(PHOTO_VIEWER_ZOOM_STORAGE_KEY, String(zoom));
    } catch {
      // Restricted browser modes keep the selected zoom only for the current page.
    }
  }
  window.requestAnimationFrame(layoutPhotoViewerImage);
  return zoom;
}

function ensurePhotoViewer() {
  let overlay = document.getElementById("photo-viewer-overlay");
  if (overlay) return overlay;
  overlay = document.createElement("div");
  overlay.id = "photo-viewer-overlay";
  overlay.className = "photo-viewer-overlay";
  overlay.hidden = true;
  overlay.innerHTML = `<div class="photo-viewer" role="dialog" aria-modal="true" aria-label="상품 사진 확대">
    <div class="photo-viewer-head">
      <strong id="photo-viewer-title">상품 사진</strong>
      <div class="photo-viewer-actions">
        <label class="photo-viewer-zoom-control">배율
          <input id="photo-viewer-zoom" type="number" min="${PHOTO_VIEWER_ZOOM_MIN}" max="${PHOTO_VIEWER_ZOOM_MAX}" step="1" inputmode="numeric" aria-label="사진 확대 배율">%
        </label>
        <button class="btn" data-photo-action="zoom-apply" type="button">적용</button>
        <button class="btn" data-photo-action="refresh" type="button">새로고침</button>
        <button class="btn" data-photo-action="close" type="button">닫기</button>
      </div>
    </div>
    <div class="photo-viewer-body">
      <div id="photo-viewer-canvas" class="photo-viewer-canvas"><img id="photo-viewer-img" alt=""></div>
    </div>
  </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector("#photo-viewer-img")?.addEventListener("load", layoutPhotoViewerImage);
  setPhotoViewerZoom(savedPhotoViewerZoom(), { persist: false });
  return overlay;
}

function bustImageUrl(src) {
  const separator = String(src || "").includes("?") ? "&" : "?";
  return `${src}${separator}v=${Date.now()}`;
}

function openPhotoViewer(src, title = "") {
  if (!src) return;
  const overlay = ensurePhotoViewer();
  state.photoViewer = { open: true, src, title, zoom: savedPhotoViewerZoom() };
  overlay.hidden = false;
  overlay.querySelector("#photo-viewer-title").textContent = title || "상품 사진";
  const image = overlay.querySelector("#photo-viewer-img");
  image.style.width = "";
  image.style.height = "";
  overlay.querySelector("#photo-viewer-canvas").style.cssText = "";
  setPhotoViewerZoom(state.photoViewer.zoom, { persist: false });
  image.src = src;
  if (image.complete) window.requestAnimationFrame(layoutPhotoViewerImage);
}

function closePhotoViewer() {
  const overlay = document.getElementById("photo-viewer-overlay");
  state.photoViewer.open = false;
  if (overlay) overlay.hidden = true;
}

function refreshPhotoViewer() {
  if (!state.photoViewer.src) return;
  const image = document.getElementById("photo-viewer-img");
  if (image) image.src = bustImageUrl(state.photoViewer.src);
}

function isPicked(item) {
  return Boolean(item.pickingState?.isPicked);
}

function normalizedShortageMemo2(value) {
  const text = String(value ?? "").trim();
  return text === "0" ? "" : text;
}

function isRepickDoneMemo2(value) {
  const compact = String(value || "").replace(/\s+/g, "");
  return compact === "ㅁ" || compact === "✓" || compact === "✔" || compact.toLowerCase() === "done" || compact.includes("피킹완료");
}

function shortageQtyFromMemo2(value) {
  const text = normalizedShortageMemo2(value);
  if (!text || isRepickDoneMemo2(text)) return 0;
  if (/^\d+$/.test(text)) return Math.max(0, Number(text) || 0);
  const matched = text.match(/\bshortage\s*(\d+)\b/i)?.[1] || text.match(/부족\s*(\d+)/)?.[1] || text.match(/\d+/)?.[0];
  return matched ? Math.max(0, Number(matched) || 0) : 1;
}

function itemManagementMemo2(item, fallbackValue = "") {
  const memo = firstRawPreservedText(item?.raw, "o_shop_memo2", "shop_memo2", "memo2", "sellpia_memo2") || item?.sellpiaMemo2 || item?.pickingState?.shortageMemo2 || "";
  if (String(memo || "").trim()) return String(memo);
  const fallbackQty = shortageQtyFromMemo2(fallbackValue);
  return fallbackQty > 0 ? String(fallbackQty) : "";
}

function shortageQty(item) {
  return shortageQtyFromMemo2(itemManagementMemo2(item));
}

function normalizedShortageQty(value) {
  return shortageQtyFromMemo2(value);
}

function isHold(item) {
  return Boolean(item.pickingState?.isHold || item.shortageState?.isHold);
}

function isGoldItem(item) {
  return isGoldOwnCode(item?.ownCode || item?.raw?.prod_code || item?.raw?.own_code || "");
}

function invoiceHasGold(invoice) {
  return (invoice.items || []).some(isGoldItem);
}

function itemHasLabelTarget(item) {
  const ownCode = item?.ownCode || "";
  if (isBareGpaOwnCode(ownCode)) return false;
  return isGoldItem(item) || isLabelTarget({ privateCode: ownCode });
}

function invoiceHasLabelTarget(invoice) {
  return (invoice.items || []).some(itemHasLabelTarget);
}

function itemManagementMemo(item) {
  return String(
    item?.sellpiaMemo1 ||
      item?.raw?.o_shop_memo ||
      item?.raw?.shop_memo ||
      item?.raw?.memo1 ||
      item?.pickingState?.drawerMemo ||
      item?.shortageState?.drawerMemo ||
      "",
  ).trim();
}

function invoiceDrawerValue(invoice) {
  return String(
    (invoice.items || []).map(itemManagementMemo).find(Boolean) ||
      invoice.sellpiaMemo1 ||
      "",
  ).trim();
}

function invoiceHasNoDrawer(invoice) {
  return !invoiceDrawerValue(invoice);
}

function itemStateKey(invoice, item) {
  return `${sourceOrderGroupNo(invoice, item)}::${item.sellpiaItemNo}`;
}

function cleanOptionName(optionName, ownCode) {
  const rawOption = String(optionName || "").trim();
  const rawCode = String(ownCode || "").trim();
  if (!rawOption || !rawCode) return rawOption;

  let option = rawOption;
  const candidates = ownCodeCandidates(rawCode);
  const candidateKeys = new Set(candidates.map(codeCompareKey).filter(Boolean));

  option = option.replace(/\[([^\]]+)\]/g, (match, inner) => {
    const innerKey = codeCompareKey(inner);
    return candidateKeys.has(innerKey) ? "" : match;
  });

  for (const code of candidates) {
    option = option.replace(new RegExp(escapeRegExp(code), "gi"), "");
  }

  return option
    .replace(/\[\s*\]/g, "")
    .replace(/\s*,\s*,/g, ",")
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s,/|:>-]+|[\s,/|:>-]+$/g, "")
    .trim();
}

function invoiceStats(invoice) {
  const items = activeWorkflowItems(invoice);
  const picked = items.filter(isPicked).length;
  const shortage = items.filter((item) => shortageQty(item) > 0).length;
  const hold = items.filter(isHold).length;
  return {
    total: items.length,
    picked,
    shortage,
    hold,
    done: items.length > 0 && picked === items.length && shortage === 0 && hold === 0,
    todo: items.some((item) => !isPicked(item)) || shortage > 0 || hold > 0,
    qty: items.reduce((sum, item) => sum + (Number(item.quantity) || 0), 0),
  };
}

function itemHasOpenWorkflowShortage(invoice, item) {
  if (itemIsEffectivelyCancelled(invoice, item)) return false;
  const itemState = workflowItemState(invoice, item);
  if (itemState?.cancelled || itemState?.shortageRepicked || itemState?.inspected) return false;
  if (itemState?.shortageOpen) return true;
  return shortageQty(item) > 0;
}

function invoiceHasOpenWorkflowShortage(invoice) {
  return (invoice.items || []).some((item) => itemHasOpenWorkflowShortage(invoice, item));
}

function invoiceReadyFromPicking(invoice) {
  const invoiceState = workflowInvoiceState(invoice);
  if (invoiceState?.cancelled) return false;
  if (invoiceHasOpenWorkflowShortage(invoice)) return false;
  if (invoiceState?.inspected) return true;

  const stats = invoiceStats(invoice);
  return stats.total > 0 && stats.picked === stats.total && stats.shortage === 0 && stats.hold === 0;
}

function invoiceSessionRank(invoice) {
  const session = String(invoice?.session || invoice?.raw?.am_pm || "").trim().toUpperCase();
  if (session === "AM" || session === "오전") return 0;
  if (session === "PM" || session === "오후") return 1;
  return 2;
}

function invoiceItemKindCount(invoice) {
  const keys = (invoice?.items || [])
    .map((item) => String(item.ownCode || item.sellpiaProductCode || item.productName || item.sellpiaItemNo || "").trim())
    .filter(Boolean);
  return new Set(keys).size || (invoice?.items || []).length;
}

function compareWorkInvoices(a, b) {
  const aStats = invoiceStats(a);
  const bStats = invoiceStats(b);
  const aRepresentativeRouteCode = invoiceRepresentativeRouteCode(a);
  const bRepresentativeRouteCode = invoiceRepresentativeRouteCode(b);
  return (
    invoiceSessionRank(a) - invoiceSessionRank(b) ||
    invoiceItemKindCount(a) - invoiceItemKindCount(b) ||
    compareExportRouteCode(aRepresentativeRouteCode, bRepresentativeRouteCode) ||
    aStats.qty - bStats.qty ||
    String(a.orderGroupNo).localeCompare(String(b.orderGroupNo), "ko", { numeric: true })
  );
}

function sortInvoices(invoices) {
  const rows = [...invoices];
  if (!state.workSortMode) return rows;
  return rows.sort(compareWorkInvoices);
}

function optionHasBarChange(item) {
  const raw = `${item?.optionName || ""} ${item?.raw?.p_option || ""} ${item?.raw?.option_name || ""}`;
  return /바\s*변경|바변경/i.test(raw);
}

function optionClass(item, base = "option") {
  return [base, optionHasBarChange(item) ? "option-change" : ""].filter(Boolean).join(" ");
}

function orderedInvoicesForSystemSequence(invoices = []) {
  const sorted = [...invoices].sort(compareWorkInvoices);
  return [...sorted.filter((invoice) => !invoiceHasGold(invoice)), ...sorted.filter(invoiceHasGold)];
}

function workOrderedInvoices() {
  return orderedInvoicesForSystemSequence(state.viewModel?.invoices || []);
}

function frontOrderedInvoicesForExport() {
  return exportOrderedInvoices(state.viewModel?.invoices || []);
}

function workflowOrderedInvoices() {
  return orderedInvoicesForSystemSequence(state.workflowQueues?.viewModel?.invoices || []);
}

const invoiceSequenceCache = {
  workSortMode: null,
  viewModel: null,
  workflowViewModel: null,
  map: new Map(),
};

function invoiceSystemSequenceMap() {
  const workflowViewModel = state.workflowQueues?.viewModel || null;
  if (
    invoiceSequenceCache.workSortMode === state.workSortMode &&
    invoiceSequenceCache.viewModel === state.viewModel &&
    invoiceSequenceCache.workflowViewModel === workflowViewModel
  ) {
    return invoiceSequenceCache.map;
  }
  const map = new Map();
  for (const rows of [workOrderedInvoices(), workflowOrderedInvoices()]) {
    rows.forEach((row, index) => {
      const key = systemInvoiceKey(row);
      if (key && !map.has(key)) map.set(key, index + 1);
    });
  }
  invoiceSequenceCache.workSortMode = state.workSortMode;
  invoiceSequenceCache.viewModel = state.viewModel;
  invoiceSequenceCache.workflowViewModel = workflowViewModel;
  invoiceSequenceCache.map = map;
  return map;
}

function normalizeRouteCode(value) {
  return String(value || "").trim().replace(/^\[|\]$/g, "").toUpperCase();
}

function exportRouteBaseCode(value) {
  const raw = String(value || "").trim().replace(/^낱/i, "").toUpperCase();
  const bracket = raw.match(/^\[([A-Z]+)\]\s*([A-Z])/);
  if (bracket) {
    const zone = bracket[1].trim();
    const aisle = bracket[2].trim();
    if (zone === "P" || zone === "E" || zone === "H") return zone + aisle;
    return zone;
  }
  return normalizeRouteCode(raw).replace(/^낱/i, "").replace(/[\]\s]+/g, "");
}

const EXPORT_ROUTE_ORDER = [
  "CA",
  "PT",
  "PS",
  "PR",
  "PQ",
  "PP",
  "PO",
  "PN",
  "PM",
  "PL",
  "PK",
  "PJ",
  "PI",
  "PH",
  "PG",
  "PF",
  "PE",
  "PD",
  "PC",
  "PB",
  "PA",
  "EA",
  "ED",
  "EC",
  "EB",
  "EF",
  "EE",
  "NA",
  "BA",
  "SA",
  "RA",
  "HA",
  "HB",
  "HC",
  "HD",
];
const EXPORT_ROUTE_RANK = EXPORT_ROUTE_ORDER.reduce((map, code, index) => {
  map[code] = index;
  return map;
}, {});

function exportRouteRank(value) {
  const code = exportRouteBaseCode(value);
  if (!code) return 9999;
  if (EXPORT_ROUTE_RANK[code] !== undefined) return EXPORT_ROUTE_RANK[code];
  const prefix2 = code.slice(0, 2);
  if (EXPORT_ROUTE_RANK[prefix2] !== undefined) return EXPORT_ROUTE_RANK[prefix2];
  const first = code.charAt(0);
  if (first === "P") return 900;
  if (first === "E") return 920;
  if (/^[HNRSB]/.test(first)) return 940;
  return 9999;
}

function compareExportRouteCode(a, b) {
  const aRank = exportRouteRank(a);
  const bRank = exportRouteRank(b);
  if (aRank !== bRank) return aRank - bRank;
  return String(exportRouteBaseCode(a)).localeCompare(String(exportRouteBaseCode(b)), "en", { numeric: true, sensitivity: "base" });
}

function invoiceRepresentativeRouteCode(invoice) {
  const routeCodes = (invoice?.items || [])
    .map((item) => item?.ownCode || item?.sellpiaProductCode || "")
    .filter((code) => String(code).trim());
  return routeCodes.sort(compareExportRouteCode)[0] || "";
}

function exportRouteMetrics(codes = []) {
  const ranks = (codes || []).map(exportRouteRank).filter((number) => Number.isFinite(number) && number < 9999);
  const startRank = ranks.length ? Math.min(...ranks) : 9999;
  const endRank = ranks.length ? Math.max(...ranks) : 9999;
  const routeSpan = ranks.length ? endRank - startRank : 9999;
  const primaryRouteCode = (codes || []).filter(Boolean).sort(compareExportRouteCode)[0] || "";
  return {
    startRank,
    endRank,
    routeSpan,
    routeZoneSpread: new Set(ranks).size || 1,
    primaryRouteCode,
  };
}

function exportOriginalRank(invoice, fallback) {
  const rawRank = firstRawText(invoice.raw, "sellpia_seq_no", "original_seq_no", "print_seq_no", "sort_order");
  const number = Number(String(rawRank || invoice.sortOrder || fallback || 0).replace(/,/g, ""));
  return Number.isFinite(number) && number > 0 ? number : Number(fallback) || 0;
}

function exportSortMetrics(invoice) {
  const items = invoice.items || [];
  const itemKindCount = new Set(items.map((item) => item.ownCode || item.sellpiaProductCode).filter(Boolean)).size;
  const totalItemQty = items.reduce((sum, item) => sum + (Number(item.quantity) || 1), 0);
  const hasShortage = items.some((item) => {
    const memoShortage = parseInt(String(item.sellpiaMemo2 || "").replace(/[^0-9-]/g, ""), 10) || 0;
    return memoShortage > 0 || shortageQty(item) > 0;
  });
  const hasHold =
    Boolean(invoice.raw?.hold || invoice.raw?.is_hold || invoice.raw?.shipping_hold || workflowInvoiceState(invoice)?.hold) ||
    items.some(isHold);
  const routeCodes = items.map((item) => normalizeRouteCode(item.ownCode || item.sellpiaProductCode)).filter(Boolean);
  const route = exportRouteMetrics(routeCodes);
  return {
    itemKindCount: itemKindCount || 0,
    totalItemQty: totalItemQty || 0,
    hasGoldItem: invoiceHasGold(invoice),
    hasShortage,
    hasHold,
    routeZoneRank: route.startRank,
    routeZoneSpread: route.routeZoneSpread,
    primaryRouteCode: route.primaryRouteCode,
    startRank: route.startRank,
    endRank: route.endRank,
    routeSpan: route.routeSpan,
  };
}

function exportProblemRank(metrics = {}) {
  if (metrics.hasHold) return 2;
  if (metrics.hasGoldItem) return 1;
  return 0;
}

function compareExportInvoices(a, b) {
  const aMetrics = a._exportSortMetrics || {};
  const bMetrics = b._exportSortMetrics || {};
  const aProblem = exportProblemRank(aMetrics);
  const bProblem = exportProblemRank(bMetrics);
  if (aProblem !== bProblem) return aProblem - bProblem;
  if ((aMetrics.itemKindCount || 0) !== (bMetrics.itemKindCount || 0)) return (aMetrics.itemKindCount || 0) - (bMetrics.itemKindCount || 0);
  if ((aMetrics.routeZoneRank ?? 9999) !== (bMetrics.routeZoneRank ?? 9999)) return (aMetrics.routeZoneRank ?? 9999) - (bMetrics.routeZoneRank ?? 9999);
  if ((aMetrics.routeSpan ?? 9999) !== (bMetrics.routeSpan ?? 9999)) return (aMetrics.routeSpan ?? 9999) - (bMetrics.routeSpan ?? 9999);
  if ((aMetrics.routeZoneSpread || 1) !== (bMetrics.routeZoneSpread || 1)) return (aMetrics.routeZoneSpread || 1) - (bMetrics.routeZoneSpread || 1);
  if ((aMetrics.totalItemQty || 0) !== (bMetrics.totalItemQty || 0)) return (aMetrics.totalItemQty || 0) - (bMetrics.totalItemQty || 0);
  const codeCompare = String(aMetrics.primaryRouteCode || "").localeCompare(String(bMetrics.primaryRouteCode || ""), "en", {
    numeric: true,
    sensitivity: "base",
  });
  if (codeCompare !== 0) return codeCompare;
  return (a._exportOriginalRank || 0) - (b._exportOriginalRank || 0);
}

function compareExportInvoicesWithinKind(a, b) {
  const aMetrics = a._exportSortMetrics || {};
  const bMetrics = b._exportSortMetrics || {};
  const aProblem = exportProblemRank(aMetrics);
  const bProblem = exportProblemRank(bMetrics);
  if (aProblem !== bProblem) return aProblem - bProblem;
  if ((aMetrics.routeZoneRank ?? 9999) !== (bMetrics.routeZoneRank ?? 9999)) return (aMetrics.routeZoneRank ?? 9999) - (bMetrics.routeZoneRank ?? 9999);
  if ((aMetrics.routeSpan ?? 9999) !== (bMetrics.routeSpan ?? 9999)) return (aMetrics.routeSpan ?? 9999) - (bMetrics.routeSpan ?? 9999);
  if ((aMetrics.routeZoneSpread || 1) !== (bMetrics.routeZoneSpread || 1)) return (aMetrics.routeZoneSpread || 1) - (bMetrics.routeZoneSpread || 1);
  if ((aMetrics.totalItemQty || 0) !== (bMetrics.totalItemQty || 0)) return (aMetrics.totalItemQty || 0) - (bMetrics.totalItemQty || 0);
  return (a._exportOriginalRank || 0) - (b._exportOriginalRank || 0);
}

function buildRouteOptimizedExportInvoices(invoices) {
  const buckets = new Map();
  [...invoices].sort(compareExportInvoices).forEach((invoice) => {
    const metrics = invoice._exportSortMetrics || {};
    const key = [exportProblemRank(metrics), metrics.itemKindCount || 0].join("|");
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(invoice);
  });

  const result = [];
  [...buckets.entries()]
    .sort((a, b) => {
      const [aProblem, aKind] = a[0].split("|").map(Number);
      const [bProblem, bKind] = b[0].split("|").map(Number);
      return aProblem - bProblem || aKind - bKind;
    })
    .forEach(([, bucket]) => {
      const sorted = [...bucket].sort(compareExportInvoicesWithinKind);
      const batches = [];
      for (let index = 0; index < sorted.length; index += JO_SIZE) {
        const orders = sorted.slice(index, index + JO_SIZE);
        const starts = orders.map((invoice) => invoice._exportSortMetrics?.startRank ?? 9999);
        const ends = orders.map((invoice) => invoice._exportSortMetrics?.endRank ?? 9999);
        batches.push({ orders, start: Math.min(...starts), end: Math.max(...ends) });
      }
      let prevEnd = result.length ? (result[result.length - 1]._exportSortMetrics?.endRank ?? 0) : 0;
      while (batches.length) {
        let bestIndex = 0;
        let bestScore = Infinity;
        batches.forEach((batch, index) => {
          const score = Math.abs((batch.start ?? 9999) - prevEnd);
          if (score < bestScore) {
            bestScore = score;
            bestIndex = index;
          }
        });
        const [next] = batches.splice(bestIndex, 1);
        result.push(...next.orders.sort(compareExportInvoicesWithinKind));
        prevEnd = next.end;
      }
    });
  return result;
}

function exportOrderedInvoices(invoices = state.viewModel?.invoices || []) {
  return orderedInvoicesForSystemSequence(invoices).map((invoice, index) => ({ ...invoice, plannedPrintSeqNo: index + 1 }));
}

function inspectionDateRank(invoice) {
  const receiptDate = String(invoice?.receiptDate || "").slice(0, 10);
  if (receiptDate && receiptDate === state.selectedDate) return 0;
  return 1;
}

function sortInspectionInvoices(invoices) {
  return [...(invoices || [])].sort((a, b) => {
    const aDateRank = inspectionDateRank(a);
    const bDateRank = inspectionDateRank(b);
    if (aDateRank !== bDateRank) return aDateRank - bDateRank;
    if (aDateRank > 0) {
      const dateCompare = String(a.receiptDate || "").localeCompare(String(b.receiptDate || ""));
      if (dateCompare !== 0) return dateCompare;
    }
    return (
      invoiceSessionRank(a) - invoiceSessionRank(b) ||
      visibleInvoiceSequenceNo(a, 999999) - visibleInvoiceSequenceNo(b, 999999) ||
      String(a.orderGroupNo || "").localeCompare(String(b.orderGroupNo || ""), "ko", { numeric: true })
    );
  });
}

function compareShortageRowsByReceiptDate(a, b) {
  const aDate = String(a?.invoice?.receiptDate || "9999-12-31").slice(0, 10);
  const bDate = String(b?.invoice?.receiptDate || "9999-12-31").slice(0, 10);
  return (
    aDate.localeCompare(bDate) ||
    visibleInvoiceSequenceNo(a.invoice, 999999) - visibleInvoiceSequenceNo(b.invoice, 999999) ||
    compareInvoiceItemsBySellpiaRow(a.item, b.item) ||
    String(a?.invoice?.orderGroupNo || "").localeCompare(String(b?.invoice?.orderGroupNo || ""), "ko", { numeric: true })
  );
}

function sortShortageRowsByReceiptDate(rows = []) {
  return [...rows].sort(compareShortageRowsByReceiptDate);
}

function compareShortageRouteCode(a, b) {
  return (
    compareExportRouteCode(a, b) ||
    String(a || "").localeCompare(String(b || ""), "en", { numeric: true, sensitivity: "base" })
  );
}

function compareShortageRowsByPickingRoute(a, b) {
  const aCode = a?.item?.ownCode || a?.item?.sellpiaProductCode || "";
  const bCode = b?.item?.ownCode || b?.item?.sellpiaProductCode || "";
  const routeCompare = compareShortageRouteCode(aCode, bCode);
  if (routeCompare) return routeCompare;
  return compareShortageRowsByReceiptDate(a, b);
}

function sortPickingRows(rows) {
  if (!state.workSortMode) return rows;
  return [...rows].sort((a, b) => {
    const aItem = a.item;
    const bItem = b.item;
    const aGold = invoiceHasGold(a.invoice);
    const bGold = invoiceHasGold(b.invoice);
    if (aGold && bGold) {
      return (
        (a.invoice.sortOrder ?? 999999) - (b.invoice.sortOrder ?? 999999) ||
        String(a.invoice.orderGroupNo).localeCompare(String(b.invoice.orderGroupNo), "ko") ||
        compareInvoiceItemsBySellpiaRow(aItem, bItem)
      );
    }
    if (aGold !== bGold) {
      return (
        (a.invoice.sortOrder ?? 999999) - (b.invoice.sortOrder ?? 999999) ||
        String(a.invoice.orderGroupNo).localeCompare(String(b.invoice.orderGroupNo), "ko")
      );
    }
    return comparePickingRowsByRoute(a, b, {
      compareRouteCode: compareExportRouteCode,
      invoiceSequenceNo: visibleInvoiceSequenceNo,
      compareInvoiceItems: compareInvoiceItemsBySellpiaRow,
    });
  });
}

function rebuildGroups() {
  const invoices = workOrderedInvoices();
  state.groups = [];
  state.groupInfos = [];

  const addGroups = (rows, prefix, kind) => {
    for (let index = 0; index < rows.length; index += JO_SIZE) {
      state.groups.push(rows.slice(index, index + JO_SIZE));
      state.groupInfos.push({ label: `${prefix}${Math.floor(index / JO_SIZE) + 1}조`, kind });
    }
  };

  addGroups(
    invoices.filter((invoice) => !invoiceHasGold(invoice)),
    "",
    "normal",
  );
  addGroups(
    invoices.filter(invoiceHasGold),
    "골드",
    "gold",
  );

  if (!state.groups.length) {
    state.groupInfos = [];
  }
  if (state.currentGroup >= state.groups.length) state.currentGroup = Math.max(0, state.groups.length - 1);
}

function currentVisibleInvoices() {
  const search = state.searchText.trim().toLowerCase();
  const statusView = state.filterMode !== "all" || search;
  const base = statusView ? workOrderedInvoices() : state.groups[state.currentGroup] || [];

  return base
    .filter((invoice) => invoiceMatchesFilter(invoice, state.filterMode))
    .filter((invoice) => {
      if (!search) return true;
      const haystack = [
        invoice.invoiceNo,
        invoice.orderGroupNo,
        invoice.displayName,
        invoice.recipientName,
        invoice.buyerName,
        invoice.seller,
        ...invoice.items.flatMap((item) => [item.ownCode, item.sellpiaProductCode, item.productName, item.optionName]),
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(search);
    });
}

function currentPickingRows() {
  return sortPickingRows(
    currentVisibleInvoices().flatMap((invoice, invoiceIndex) =>
      invoiceItemsInSellpiaRowOrder(invoice).map((item, itemIndex) => ({ invoice, item, invoiceIndex, itemIndex })),
    ),
  );
}

function currentTrayInvoices() {
  return currentVisibleInvoices();
}

function itemSlotKey(invoice, item) {
  return `${sourceOrderGroupNo(invoice, item)}::${item.sellpiaItemNo}`;
}

function itemSortRank(item) {
  const sortOrder = Number(item?.sortOrder);
  if (Number.isFinite(sortOrder) && sortOrder > 0) return sortOrder;
  const itemOrder = Number(item?.itemOrderIndex);
  if (Number.isFinite(itemOrder) && itemOrder > 0) return itemOrder;
  return 999999;
}

function compareInvoiceItemsBySellpiaRow(a, b) {
  return (
    itemSortRank(a) - itemSortRank(b) ||
    String(a?.sellpiaItemNo || "").localeCompare(String(b?.sellpiaItemNo || ""), "ko", { numeric: true }) ||
    String(a?.ownCode || "").localeCompare(String(b?.ownCode || ""), "ko", { numeric: true })
  );
}

function invoiceItemsInSellpiaRowOrder(invoice) {
  if (invoice?.shipmentGroup) {
    return [...(invoice.items || [])].sort((left, right) => (
      Number(left.shipmentItemOrderIndex ?? Number.MAX_SAFE_INTEGER)
        - Number(right.shipmentItemOrderIndex ?? Number.MAX_SAFE_INTEGER)
      || compareInvoiceItemsBySellpiaRow(left, right)
    ));
  }
  return [...(invoice?.items || [])].sort(compareInvoiceItemsBySellpiaRow);
}

function itemOrderNo(item, fallbackIndex = 0) {
  void item;
  return fallbackIndex + 1;
}

function invoiceItemIndex(invoice, item) {
  const index = invoiceItemsInSellpiaRowOrder(invoice).findIndex((row) => row.sellpiaItemNo === item?.sellpiaItemNo);
  return index >= 0 ? index : 0;
}

function renderInvoiceSlots(invoiceIndex, item, itemIndex) {
  const activeSlot = (invoiceIndex % JO_SIZE) + 1;
  const orderNo = itemOrderNo(item, itemIndex);
  return `<div class="invoice-slots" aria-label="조 배치 슬롯">
    ${Array.from({ length: JO_SIZE }, (_, index) => {
      const slotNo = index + 1;
      const active = slotNo === activeSlot;
      return `<div class="invoice-slot ${active ? "active" : ""}">
        <span>${slotNo}</span>
        <strong>${active ? escapeHtml(orderNo) : ""}</strong>
      </div>`;
    }).join("")}
  </div>`;
}

function itemStatusMeta(item, invoice = null) {
  if (invoice && itemIsEffectivelyCancelled(invoice, item)) return { label: "취소", className: "cancelled" };
  if (shortageQty(item) > 0) return { label: `미송 ${shortageQty(item)}`, className: "shortage" };
  if (isHold(item)) return { label: "보류", className: "hold" };
  if (isPicked(item)) return { label: "완료", className: "picked" };
  return { label: "대기", className: "todo" };
}

function sellerBadgeMeta(seller) {
  const text = String(seller || "").trim().toLowerCase();
  if (!text) return null;
  if (text.includes("지그재그") || text.includes("zigzag") || text.includes("zig")) {
    return { label: "지그재그", className: "seller-zigzag" };
  }
  if (text.includes("에이블리") || text.includes("ably") || text.includes("a-bly")) {
    return { label: "에이블리", className: "seller-ably" };
  }
  if (text.includes("쿠팡") || text.includes("coupang")) {
    return { label: "쿠팡", className: "seller-coupang" };
  }
  if (text.includes("스마트") || text.includes("smart") || text.includes("naver") || text.includes("네이버")) {
    return { label: "스마트스토어", className: "seller-smartstore" };
  }
  return { label: "메이크샵", className: "seller-makeshop" };
}

function workflowItemKey(invoice, item) {
  return `${sourceOrderGroupNo(invoice, item)}::${item.sellpiaItemNo}`;
}

function workflowItemState(invoice, item) {
  return state.workflowQueues?.workflowState?.itemStateByKey?.get(workflowItemKey(invoice, item)) || null;
}

function workflowAwareShortageQty(itemState, item) {
  if (itemState && itemState.shortageQty !== null && itemState.shortageQty !== undefined) {
    return Number(itemState.shortageQty) || 0;
  }
  return shortageQty(item);
}

function workflowInvoiceState(invoice) {
  const invoiceStateByKey = state.workflowQueues?.workflowState?.invoiceStateByKey;
  if (!invoiceStateByKey) return null;
  if (!invoice?.shipmentGroup) return invoiceStateByKey.get(invoice?.orderGroupNo) || null;
  const memberStates = (invoice.sourceInvoices || [])
    .map((sourceInvoice) => invoiceStateByKey.get(sourceInvoice.orderGroupNo) || null)
    .filter(Boolean);
  if (!memberStates.length) return null;
  const latest = [...memberStates].sort((left, right) => (
    new Date(right.lastEventAt || 0).getTime() - new Date(left.lastEventAt || 0).getTime()
  ))[0];
  return {
    ...latest,
    inspected: memberStates.length === invoice.sourceInvoices.length && memberStates.every((row) => row.inspected),
    cancelled: memberStates.length === invoice.sourceInvoices.length && memberStates.every((row) => row.cancelled),
    hold: memberStates.some((row) => row.hold),
    systemShippingHold: memberStates.some((row) => row.systemShippingHold),
    systemShippingHoldKnown: memberStates.every((row) => row.systemShippingHoldKnown === true),
    shippingHoldNeedsOn: memberStates.some((row) => row.shippingHoldNeedsOn),
    shippingHoldUnknown: memberStates.some((row) => row.shippingHoldUnknown),
    memo: memberStates.map((row) => String(row.memo || "").trim()).filter(Boolean).join(" / "),
  };
}

function invoiceIsCancelled(invoice) {
  return Boolean(invoice && workflowInvoiceState(invoice)?.cancelled);
}

function itemIsIndividuallyCancelled(invoice, item) {
  return Boolean(invoice && item && workflowItemState(invoice, item)?.cancelled);
}

function itemIsEffectivelyCancelled(invoice, item) {
  if (invoice?.shipmentGroup) {
    const sourceState = state.workflowQueues?.workflowState?.invoiceStateByKey?.get(sourceOrderGroupNo(invoice, item));
    return Boolean(sourceState?.cancelled) || itemIsIndividuallyCancelled(invoice, item);
  }
  return invoiceIsCancelled(invoice) || itemIsIndividuallyCancelled(invoice, item);
}

function activeWorkflowItems(invoice) {
  return (invoice?.items || []).filter((item) => !itemIsEffectivelyCancelled(invoice, item));
}

function shippingHoldUiState(invoice) {
  const invoiceState = workflowInvoiceState(invoice);
  if (invoiceState?.systemShippingHold) {
    return { key: "on", label: "배송보류 ON", className: "hold", action: "inspection-hold-release", actionLabel: "배송보류 해제", needsAttention: false };
  }
  if (invoiceState?.shippingHoldNeedsOn) {
    return { key: "needs_on", label: "배송보류 ON 필요", className: "warn", action: "inspection-hold", actionLabel: "배송보류 처리", needsAttention: true };
  }
  if (invoiceState?.shippingHoldUnknown) {
    return { key: "unknown", label: "배송보류 확인 필요", className: "warn", action: "inspection-hold", actionLabel: "배송보류 처리", needsAttention: true };
  }
  return { key: "off", label: "배송보류 OFF", className: "done", action: "inspection-hold", actionLabel: "배송보류 처리", needsAttention: false };
}

function isSystemShippingHoldOn(invoice) {
  return shippingHoldUiState(invoice).key === "on";
}

function shippingHoldBadge(invoice) {
  const holdState = shippingHoldUiState(invoice);
  return `<span class="workflow-row-badge ${holdState.className}">${escapeHtml(holdState.label)}</span>`;
}

function workflowEventTime(row) {
  return new Date(row?.event_at || row?.created_at || row?.lastEventAt || 0).getTime() || 0;
}

function invoiceSequenceNo(invoice, fallbackIndex = 0) {
  return Number(invoice?.sortOrder || 0) || fallbackIndex + 1;
}

function invoiceSequenceLabel(invoice, fallbackIndex = 0) {
  return `${invoiceSequenceNo(invoice, fallbackIndex)}번`;
}

function systemInvoiceKey(invoice) {
  return String(invoice?.orderGroupNo || invoice?.invoiceNo || "").trim();
}

function invoiceSystemSequenceNo(invoice, fallbackIndex = 0) {
  const key = systemInvoiceKey(invoice);
  if (key) {
    const sequence = invoiceSystemSequenceMap().get(key);
    if (sequence) return sequence;
  }
  return fallbackIndex + 1;
}

function visibleInvoiceSequenceNo(invoice, fallbackIndex = 0) {
  return invoiceSystemSequenceNo(invoice, fallbackIndex);
}

function visibleInvoiceSequenceLabel(invoice, fallbackIndex = 0) {
  return `${visibleInvoiceSequenceNo(invoice, fallbackIndex)}번`;
}

function invoiceGroupSlotLabel(invoice, fallbackIndex = 0) {
  const sequence = visibleInvoiceSequenceNo(invoice, fallbackIndex);
  if (!sequence) return "-";
  const groupNo = Math.floor((sequence - 1) / JO_SIZE) + 1;
  const slotNo = ((sequence - 1) % JO_SIZE) + 1;
  return `${groupNo}조-${slotNo}번`;
}

function invoiceSequenceWithGroupLabel(invoice, fallbackIndex = 0) {
  return `${visibleInvoiceSequenceLabel(invoice, fallbackIndex)} · ${invoiceGroupSlotLabel(invoice, fallbackIndex)}`;
}

function itemSequenceNo(item, fallbackIndex = 0) {
  void item;
  return fallbackIndex + 1;
}

function formatAmount(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toLocaleString("ko-KR") : "-";
}

function parseAmountNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const normalized = String(value).replace(/[^0-9.-]/g, "");
  if (!/\d/.test(normalized)) return null;
  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}

function getInvoiceTotalAmount(invoice) {
  const candidates = [
    invoice?.orderTotalAmount,
    invoice?.order_amount,
    invoice?.order_price,
    invoice?.total_amount,
    invoice?.total_price,
    invoice?.pay_amount,
    invoice?.settle_price,
    invoice?.o_total_price,
    invoice?.order_total,
    invoice?.raw?.sellpia_order_total_amount,
    invoice?.raw?.order_total_amount,
    invoice?.raw?.order_amount,
    invoice?.raw?.order_price,
    invoice?.raw?.total_amount,
    invoice?.raw?.total_price,
    invoice?.raw?.pay_amount,
    invoice?.raw?.settle_price,
    invoice?.raw?.o_total_price,
    invoice?.raw?.order_total,
  ];
  for (const value of candidates) {
    const amount = parseAmountNumber(value);
    if (amount !== null) return amount;
  }
  return null;
}

function renderInspectionTotalAmountBadge(invoice) {
  const totalAmount = getInvoiceTotalAmount(invoice);
  if (totalAmount === null) return "";
  return `<span class="invoice-badge inspection-total-amount" aria-label="총 주문금액">총금액 ${escapeHtml(formatAmount(totalAmount))}원</span>
    ${totalAmount >= 20000 ? '<span class="workflow-row-badge gift">사은품확인!</span>' : ""}`;
}

function invoiceTotalQuantity(invoice) {
  return (invoice?.items || []).reduce((sum, item) => sum + (Number(item.quantity) || 1), 0);
}

function renderInspectionItemHeader(includeLabelNo = false, totalQty = null) {
  const totalQtyLabel = Number.isFinite(totalQty) ? ` (총 ${totalQty.toLocaleString("ko-KR")}개)` : "";
  return `<div class="workflow-item-row workflow-item-header">
    <span>상품순서번호</span>
    ${includeLabelNo ? "<span>라벨번호</span>" : ""}
    <span>사진</span>
    <span>옵션명</span>
    <span>수량${totalQtyLabel}</span>
    <span>상품명</span>
    <span>금액</span>
    <span>자사코드</span>
    <span>셀피아코드</span>
    <span>부족수량</span>
    <span>셀피아 주문메모</span>
    <span>상품 확인메모</span>
    <span>상태</span>
  </div>`;
}

function inspectionLabelNumberMap(selectedInvoice) {
  if (!selectedInvoice || !invoiceHasLabelTarget(selectedInvoice)) return new Map();
  const selectedKey = selectedInvoice.orderGroupNo || selectedInvoice.invoiceNo;
  const map = new Map();
  const dayOffsetSeq = {};
  labelSourceInvoices(new Map()).forEach((invoice) => {
    (labelItemsForInvoice(invoice, new Map()) || []).forEach((item) => {
      const target = getLabelTargetResult({ privateCode: item.ownCode || "" }, null);
      const optionName = normalizeLabelOptionName(item.optionName || "");
      if (!target.ok || !optionName) return;
      const qty = Math.max(1, parseInt(String(item.quantity || 1).replace(/,/g, ""), 10) || 1);
      const dayOffset = getLabelDayOffset(labelReceivedAtForItem(invoice, item));
      const numbers = [];
      for (let index = 0; index < qty; index += 1) {
        dayOffsetSeq[dayOffset] = (dayOffsetSeq[dayOffset] || 0) + 1;
        numbers.push(`(${dayOffset})-${dayOffsetSeq[dayOffset]}`);
      }
      if ((invoice.orderGroupNo || invoice.invoiceNo) !== selectedKey) return;
      map.set(itemSlotKey(invoice, item), numbers.join(", "));
    });
  });
  return map;
}

function invoiceOrderDateTimeLabel(invoice) {
  const sourceInvoices = Array.isArray(invoice?.sourceInvoices) && invoice.sourceInvoices.length
    ? invoice.sourceInvoices
    : [invoice];
  return [...new Set(sourceInvoices
    .map((source) => String(source?.orderDateTime || "").trim())
    .filter(Boolean))]
    .join(" / ");
}

function formatShortDate(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 10);
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

function dateKey(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 10);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function completedEventForInvoice(invoice) {
  return [...(state.workflowQueues?.invoiceEvents || [])]
    .filter((event) => event.order_group_no === invoice.orderGroupNo && event.event_type === "inspection_completed")
    .sort((a, b) => new Date(b.event_at || b.created_at || 0).getTime() - new Date(a.event_at || a.created_at || 0).getTime())[0];
}

function completedDateForInvoice(invoice) {
  const event = completedEventForInvoice(invoice);
  return dateKey(event?.event_at || event?.created_at || workflowInvoiceState(invoice)?.lastEventAt);
}

function completedInvoicesForSelectedDate() {
  const rows = state.workflowQueues?.inspectionCompletedInvoices || [];
  return rows
    .filter((invoice) => {
      if (state.completedDateMode === "completed") return completedDateForInvoice(invoice) === state.selectedDate;
      return String(invoice.receiptDate || "").slice(0, 10) === state.selectedDate;
    })
    .sort((a, b) => {
      const aEvent = completedEventForInvoice(a);
      const bEvent = completedEventForInvoice(b);
      const aTime = new Date(aEvent?.event_at || aEvent?.created_at || workflowInvoiceState(a)?.lastEventAt || 0).getTime() || 0;
      const bTime = new Date(bEvent?.event_at || bEvent?.created_at || workflowInvoiceState(b)?.lastEventAt || 0).getTime() || 0;
      return bTime - aTime || String(a.invoiceNo || "").localeCompare(String(b.invoiceNo || ""));
    });
}

function invoiceTextForSearch(invoice) {
  return [
    invoice.invoiceNo,
    invoice.orderGroupNo,
    invoice.displayName,
    invoice.csDisplayName,
    invoice.recipientName,
    invoice.buyerName,
    invoice.seller,
    ...(invoice.shipmentGroup?.members || []).flatMap((member) => [member.orderGroupNo, member.invoiceNo]),
    ...(invoice.items || []).flatMap((item) => [item.sourceOrderGroupNo, item.sourceInvoiceNo, item.ownCode, item.sellpiaProductCode, item.productName, item.optionName]),
  ]
    .join(" ")
    .toLowerCase();
}

function invoiceHasRepickedShortage(invoice) {
  const invoiceState = workflowInvoiceState(invoice);
  if (invoiceState?.shortageInvoiceRepicked && !invoiceState?.inspected && !invoiceState?.cancelled) return true;
  return (invoice.items || []).some((item) => {
    const itemState = workflowItemState(invoice, item);
    return (itemHasOpenWorkflowShortage(invoice, item) || itemState?.shortageRepicked) && !itemState?.inspected && !itemState?.cancelled;
  });
}

function shortageLabelSourceInvoices() {
  return sortInspectionInvoices(
    mergeInvoicesUnique(
      state.workflowQueues?.viewModel?.invoices || [],
      state.viewModel?.invoices || [],
      state.workflowQueues?.inspectionInvoices || [],
    ).filter(invoiceHasRepickedShortage),
  );
}

function compactReceiptDateLabel(value) {
  const key = String(value || "").slice(0, 10);
  const match = key.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match) return `${match[2]}${match[3]}`;
  return key.replace(/\D/g, "").slice(-4) || "날짜없음";
}

function shortageInvoiceDisplayLabel(invoice) {
  const targetKey = systemInvoiceKey(invoice);
  if (!targetKey) return "미송";
  const counters = {};
  for (const row of shortageLabelSourceInvoices()) {
    const key = systemInvoiceKey(row);
    if (!key) continue;
    const receiptDate = String(row.receiptDate || "").slice(0, 10) || "날짜없음";
    counters[receiptDate] = (counters[receiptDate] || 0) + 1;
    if (key === targetKey) return `${compactReceiptDateLabel(receiptDate)}미송${counters[receiptDate]}`;
  }
  const fallbackDate = String(invoice?.receiptDate || "").slice(0, 10) || "날짜없음";
  return `${compactReceiptDateLabel(fallbackDate)}미송`;
}

function invoicePrimaryWorkflowLabel(invoice, fallbackIndex = 0) {
  if (invoice?.shipmentGroup) return `합배송 · ${invoice.invoiceNo || "송장없음"}`;
  if (!invoiceHasRepickedShortage(invoice)) return visibleInvoiceSequenceLabel(invoice, fallbackIndex);
  const shortageLabel = shortageInvoiceDisplayLabel(invoice);
  const receiptDate = String(invoice?.receiptDate || "").slice(0, 10);
  if (receiptDate && receiptDate === state.selectedDate) return `${visibleInvoiceSequenceLabel(invoice, fallbackIndex)} / ${shortageLabel}`;
  return shortageLabel;
}

function invoiceSecondaryWorkflowLabel(invoice, fallbackIndex = 0) {
  if (invoice?.shipmentGroup) return `원주문 ${invoice.shipmentGroup.members.length}건`;
  return invoiceHasRepickedShortage(invoice) ? invoice.invoiceNo || "" : invoiceGroupSlotLabel(invoice, fallbackIndex);
}

function invoiceMatchesInspectionFilter(invoice) {
  const invoiceState = workflowInvoiceState(invoice);
  if (state.inspectionFilter === "normal") return !invoiceHasRepickedShortage(invoice);
  if (state.inspectionFilter === "gold") return invoiceHasGold(invoice);
  if (state.inspectionFilter === "hold") return Boolean(invoiceState?.systemShippingHold || invoiceState?.shippingHoldNeedsOn || invoiceState?.shippingHoldUnknown);
  if (state.inspectionFilter === "shortage") return invoiceHasRepickedShortage(invoice);
  return true;
}

function invoiceMatchesInspectionSearch(invoice) {
  const search = state.inspectionSearchText.trim().toLowerCase();
  if (!search) return true;
  return invoiceTextForSearch(invoice).includes(search);
}

function ensureInspectionFilterButtons() {
  const bar = els.inspectionFilterBar;
  if (!bar) return;
  const shortageButton = bar.querySelector("[data-inspection-filter='shortage']");
  if (shortageButton) shortageButton.textContent = "미송피킹";
  if (bar.querySelector("[data-inspection-filter='normal']")) return;
  const button = document.createElement("button");
  button.className = "filter-chip";
  button.dataset.inspectionFilter = "normal";
  button.type = "button";
  button.textContent = "일반검품";
  bar.insertBefore(button, shortageButton || bar.querySelector("[data-inspection-filter='hold']") || null);
}

function mergeInvoicesUnique(...lists) {
  const merged = [];
  const seen = new Set();
  for (const list of lists) {
    for (const invoice of list || []) {
      const key = invoice.orderGroupNo || invoice.invoiceNo;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      merged.push(invoice);
    }
  }
  return merged;
}

function isInspectionVisibleBaseInvoice(invoice) {
  return Boolean(invoice);
}

function inspectionBaseInvoices() {
  const pickingReadyInvoices = (state.viewModel?.invoices || []).filter(invoiceReadyFromPicking);
  const shortageInvoices = mergeInvoicesUnique(state.workflowQueues?.viewModel?.invoices || [], state.viewModel?.invoices || []).filter(invoiceHasRepickedShortage);
  const latestScrapeInvoices = state.workflowQueues?.viewModel?.invoices || [];
  return sortInspectionInvoices(
    mergeInvoicesUnique(
      latestScrapeInvoices,
      pickingReadyInvoices,
      shortageInvoices,
      state.workflowQueues?.inspectionInvoices || [],
      state.workflowQueues?.inspectionCompletedInvoices || [],
    ).filter(isInspectionVisibleBaseInvoice),
  );
}

function workflowSummary() {
  const queues = state.workflowQueues;
  const inspectionInvoices = inspectionSourceInvoices();
  const pendingInspectionInvoices = inspectionInvoices.filter((invoice) => {
    const invoiceState = workflowInvoiceState(invoice);
    return !invoiceState?.inspected && !invoiceState?.cancelled;
  });
  const repickedPendingInvoices = pendingInspectionInvoices.filter(invoiceHasRepickedShortage);
  const holdInvoices = inspectionInvoices.filter((invoice) => {
    const invoiceState = workflowInvoiceState(invoice);
    return invoiceState?.systemShippingHold || invoiceState?.shippingHoldNeedsOn || invoiceState?.shippingHoldUnknown || invoiceStats(invoice).hold > 0;
  });
  const goldInspectionInvoices = inspectionInvoices.filter(invoiceHasGold);
  const goldInspectionItems = goldInspectionInvoices.flatMap((invoice) => invoice.items || []).filter(isGoldItem);
  if (!queues) {
    return {
      ready: false,
      status: state.workflowQueueError ? "오류" : "대기",
      shortageItems: 0,
      inspectionInvoices: pendingInspectionInvoices.length,
      repickedInvoices: repickedPendingInvoices.length,
      completedInvoices: 0,
      repickedItems: 0,
      holdInvoices: holdInvoices.length,
      goldInvoices: goldInspectionInvoices.length,
      goldItems: goldInspectionItems.length,
      missingInvoices: 0,
      eventRows: 0,
    };
  }

  const repickedItems = Array.from(queues.workflowState.itemStateByKey.values()).filter(
    (row) => row.shortageRepicked && !row.inspected && !row.cancelled,
  ).length;
  const syntheticEventRows = (queues.syntheticEvents?.itemEvents?.length || 0) + (queues.syntheticEvents?.invoiceEvents?.length || 0);

  return {
    ready: true,
    status: "ON",
    shortageItems: queues.shortageItems.length,
    inspectionInvoices: pendingInspectionInvoices.length,
    repickedInvoices: repickedPendingInvoices.length,
    completedInvoices: queues.inspectionCompletedInvoices.length,
    repickedItems,
    holdInvoices: holdInvoices.length,
    goldInvoices: goldInspectionInvoices.length,
    goldItems: goldInspectionItems.length,
    missingInvoices: Math.max(0, queues.orderGroupNos.length - queues.viewModel.invoices.length),
    eventRows: queues.itemEvents.length + queues.invoiceEvents.length + syntheticEventRows,
  };
}

function invoiceMatchesFilter(invoice, filterMode) {
  const stats = invoiceStats(invoice);
  if (filterMode === "todo") return stats.todo;
  if (filterMode === "shortage") return stats.shortage > 0;
  if (filterMode === "nodrawer") return invoiceHasNoDrawer(invoice);
  if (filterMode === "gold") return invoiceHasGold(invoice);
  if (filterMode === "hold") return stats.hold > 0;
  if (filterMode === "done") return stats.done;
  return true;
}

function filterLabel(filterMode) {
  return {
    all: "전체",
    todo: "미완료",
    shortage: "미송",
    nodrawer: "서랍없음",
    gold: "골드",
    hold: "보류",
    done: "완료",
  }[filterMode] || "전체";
}

function dashboardItemBuckets(items = []) {
  return items.reduce(
    (acc, item) => {
      if (isHold(item)) acc.hold += 1;
      else if (shortageQty(item) > 0) acc.shortage += 1;
      else if (isPicked(item)) acc.picked += 1;
      else acc.todo += 1;
      return acc;
    },
    { picked: 0, shortage: 0, hold: 0, todo: 0 },
  );
}

function dashboardDonutSegments(segments = []) {
  const total = segments.reduce((sum, segment) => sum + Math.max(0, Number(segment.value) || 0), 0);
  if (!total) return { total: 0, style: "#e5eaf2 0 100%", segments };
  let cursor = 0;
  const parts = segments
    .filter((segment) => Number(segment.value) > 0)
    .map((segment) => {
      const start = cursor;
      cursor += (Number(segment.value) / total) * 100;
      return `${segment.color} ${start.toFixed(2)}% ${cursor.toFixed(2)}%`;
    });
  return { total, style: parts.join(", "), segments };
}

function dashboardMonthKey(dateValue = state.selectedDate) {
  if (state.dashboardMonthKey) return state.dashboardMonthKey;
  const key = dateKey(dateValue) || todayDateString();
  return key.slice(0, 7);
}

function setDashboardMonthFromDate(dateValue = state.selectedDate) {
  const key = dateKey(dateValue) || todayDateString();
  state.dashboardMonthKey = key.slice(0, 7);
}

function shiftDashboardMonth(delta) {
  const key = dashboardMonthKey();
  const [year, month] = key.split("-").map(Number);
  const date = new Date(year, month - 1 + delta, 1);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  state.dashboardMonthKey = local.toISOString().slice(0, 7);
  renderDashboard();
}

function dashboardMonthDays(monthKey = dashboardMonthKey()) {
  const [year, month] = monthKey.split("-").map(Number);
  const first = new Date(year, month - 1, 1);
  const last = new Date(year, month, 0);
  const cells = [];
  const leading = first.getDay();
  for (let index = 0; index < leading; index += 1) cells.push(null);
  for (let day = 1; day <= last.getDate(); day += 1) {
    const date = new Date(year, month - 1, day);
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
    cells.push(local.toISOString().slice(0, 10));
  }
  while (cells.length % 7) cells.push(null);
  return cells;
}

function dashboardSourceInvoices() {
  return mergeInvoicesUnique(
    state.viewModel?.invoices || [],
    state.workflowQueues?.viewModel?.invoices || [],
    state.workflowQueues?.inspectionInvoices || [],
    state.workflowQueues?.inspectionCompletedInvoices || [],
  );
}

function createDashboardDayStats(date) {
  return {
    date,
    invoices: 0,
    items: 0,
    pickedInvoices: 0,
    shortageItems: 0,
    holdInvoices: 0,
    inspectionInvoices: 0,
    completedInvoices: 0,
    repickedInvoices: 0,
    goldInvoices: 0,
  };
}

function dashboardDayStatsMap(invoices = dashboardSourceInvoices()) {
  const map = new Map();
  const ensure = (date) => {
    if (!map.has(date)) map.set(date, createDashboardDayStats(date));
    return map.get(date);
  };

  invoices.forEach((invoice) => {
    const date = dateKey(invoice.receiptDate);
    if (!date) return;
    const stats = ensure(date);
    const itemRows = invoice.items || [];
    const invoiceState = workflowInvoiceState(invoice);
    const invoiceStatsRow = invoiceStats(invoice);
    stats.invoices += 1;
    stats.items += itemRows.length;
    if (invoiceStatsRow.done || invoiceState?.picked) stats.pickedInvoices += 1;
    if (invoiceStatsRow.hold > 0 || invoiceState?.systemShippingHold || invoiceState?.shippingHoldNeedsOn || invoiceState?.shippingHoldUnknown) stats.holdInvoices += 1;
    if (invoiceHasGold(invoice)) stats.goldInvoices += 1;
    if (invoiceState?.inspected) stats.completedInvoices += 1;
    if (!invoiceState?.inspected && isInspectionVisibleBaseInvoice(invoice)) stats.inspectionInvoices += 1;
    if (invoiceHasRepickedShortage(invoice)) stats.repickedInvoices += 1;
    stats.shortageItems += itemRows.filter((item) => {
      const itemState = workflowItemState(invoice, item);
      return workflowAwareShortageQty(itemState, item) > 0;
    }).length;
  });

  return map;
}

function dashboardStatusChips(stats, { includeTotal = false } = {}) {
  const rows = [
    includeTotal ? { key: "total", label: "송장", value: stats.invoices, unit: "건" } : null,
    { key: "shortage", label: "미송", value: stats.shortageItems, unit: "개" },
    { key: "inspection", label: "검품", value: stats.inspectionInvoices, unit: "건" },
    { key: "completed", label: "완료", value: stats.completedInvoices, unit: "건" },
    { key: "hold", label: "보류", value: stats.holdInvoices, unit: "건" },
    { key: "repicked", label: "미송완료", value: stats.repickedInvoices, unit: "건" },
    { key: "gold", label: "골드", value: stats.goldInvoices, unit: "건" },
  ].filter(Boolean);

  return rows.filter((row) => Number(row.value) > 0);
}

function renderDashboardStatusChips(stats, options = {}) {
  const chips = dashboardStatusChips(stats, options);
  if (!chips.length) return "";
  return chips
    .map(
      (chip) =>
        `<span class="dashboard-status-chip ${escapeHtml(chip.key)}">${escapeHtml(chip.label)} <strong>${chip.value}</strong>${escapeHtml(chip.unit || "")}</span>`,
    )
    .join("");
}

function renderMetrics() {
  const invoices = state.viewModel?.invoices || [];
  const items = invoices.flatMap((invoice) => invoice.items || []);
  els.metricOrders.textContent = String(invoices.length);
  els.metricPicked.textContent = String(items.filter(isPicked).length);
  els.metricShortage.textContent = String(items.filter((item) => shortageQty(item) > 0).length);
  els.metricHold.textContent = String(items.filter(isHold).length);
  els.metricWrite.textContent = allowWrites ? "ON" : "OFF";
  const workflow = workflowSummary();
  if (!allowWorkflowEvents) els.metricEvents.textContent = "OFF";
  else if (workflow.ready || state.workflowQueueError) els.metricEvents.textContent = workflow.status;
  else if (!state.workflowEventsChecked) els.metricEvents.textContent = "대기";
  else els.metricEvents.textContent = state.workflowEventsReady ? "ON" : "미준비";
}

function renderDashboard() {
  if (!els.dashboardSummary) return;
  const workflow = workflowSummary();
  const monthKey = dashboardMonthKey();
  const monthDays = dashboardMonthDays(monthKey);
  const dayStats = dashboardDayStatsMap();
  const selectedStats = dayStats.get(state.selectedDate) || createDashboardDayStats(state.selectedDate);
  const monthTotals = [...dayStats.values()]
    .filter((stats) => String(stats.date || "").startsWith(monthKey))
    .reduce((acc, stats) => {
      Object.keys(acc).forEach((key) => {
        if (key !== "date") acc[key] += Number(stats[key] || 0);
      });
      return acc;
    }, createDashboardDayStats(monthKey));
  const selectedChips = renderDashboardStatusChips(selectedStats, { includeTotal: true });
  const monthChips = renderDashboardStatusChips(monthTotals, { includeTotal: true });

  els.dashboardSummary.innerHTML = `<div class="dashboard-calendar-card">
      <div class="dashboard-calendar-head">
        <div>
          <h3>${escapeHtml(monthKey.replace("-", "년 "))}월 작업 캘린더</h3>
          <p>접수일 기준으로 묶고, 값이 있는 상태만 표시합니다.</p>
        </div>
        <div class="dashboard-calendar-tools">
          <button class="btn mini" data-dashboard-month="-1" type="button">이전달</button>
          <button class="btn mini" data-dashboard-month="today" type="button">이번달</button>
          <button class="btn mini" data-dashboard-month="1" type="button">다음달</button>
          <div class="dashboard-month-total">${monthChips || '<span class="dashboard-empty-inline">표시할 상태 없음</span>'}</div>
        </div>
      </div>
      <div class="dashboard-calendar-weekdays">
        ${["일", "월", "화", "수", "목", "금", "토"].map((day) => `<span>${day}</span>`).join("")}
      </div>
      <div class="dashboard-calendar-grid">
        ${monthDays
          .map((day) => {
            if (!day) return '<div class="dashboard-calendar-day empty"></div>';
            const stats = dayStats.get(day) || createDashboardDayStats(day);
            const chips = renderDashboardStatusChips(stats, { includeTotal: true });
            return `<button class="dashboard-calendar-day ${day === state.selectedDate ? "selected" : ""} ${chips ? "has-data" : ""}" data-dashboard-date="${escapeHtml(day)}" type="button">
              <div class="dashboard-day-top">
                <strong>${Number(day.slice(8, 10))}</strong>
                ${day === todayDateString() ? "<em>오늘</em>" : ""}
              </div>
              <div class="dashboard-day-chips">${chips}</div>
            </button>`;
          })
          .join("")}
      </div>
    </div>
    <div class="dashboard-selected-card">
      <h3>선택일 요약</h3>
      <strong class="dashboard-selected-date">${escapeHtml(state.selectedDate)}</strong>
      <div class="dashboard-selected-chips">${selectedChips || '<span class="dashboard-empty-inline">표시할 상태 없음</span>'}</div>
      <div class="dashboard-actions">
        <button class="btn" data-dashboard-tab="shortage" type="button">미송피킹</button>
        <button class="btn" data-dashboard-tab="inspection" type="button">검품대기</button>
        <button class="btn" data-dashboard-tab="completed" type="button">작업완료</button>
      </div>
    </div>
    <div class="workflow-dashboard">
      <div class="workflow-flow-head">
        <strong>미송 / 입고 / 검품 연결</strong>
        <span class="${workflow.ready ? "ok" : state.workflowQueueError ? "bad" : "wait"}">${escapeHtml(workflow.status)}</span>
      </div>
      ${
        state.workflowQueueError
          ? `<div class="workflow-error">${escapeHtml(state.workflowQueueError)}</div>`
          : `<div class="dashboard-workflow-chips">
              ${[
                ["shortage", "미송피킹 대기", workflow.shortageItems, "상품"],
                ["inspection", "검품 대기", workflow.inspectionInvoices, "송장"],
                ["completed", "작업완료", workflow.completedInvoices, "송장"],
                ["repicked", "미송완료 미검품", workflow.repickedInvoices, "송장"],
                ["hold", "보류", workflow.holdInvoices, "송장"],
                ["gold", "골드 송장", workflow.goldInvoices, "건"],
                ["bad", "원본 연결 누락", workflow.missingInvoices, "송장"],
              ]
                .filter((row) => Number(row[2]) > 0)
                .map(
                  ([key, label, value, unit]) =>
                    `<span class="dashboard-status-chip ${escapeHtml(key)}">${escapeHtml(label)} <strong>${value}</strong>${escapeHtml(unit)}</span>`,
                )
                .join("") || '<span class="dashboard-empty-inline">표시할 상태 없음</span>'}
            </div>
            <div class="dashboard-actions">
              <button class="btn" data-dashboard-tab="shortage" type="button">미송피킹 보기</button>
              <button class="btn" data-dashboard-tab="inspection" type="button">검품대기 보기</button>
              <button class="btn" data-dashboard-tab="completed" type="button">작업완료 보기</button>
            </div>
            <p>미송피킹/검품은 선택 날짜가 아니라 workflow event 상태 기준으로 집계됩니다.</p>`
      }
    </div>`;
  renderProductPhotoLibrary();
  if (!state.productPhotoLibrary.loaded && !state.productPhotoLibrary.loading && !state.productPhotoLibrary.error) {
    loadProductPhotoLibrary().catch(() => {});
  }
}

function orderListModalRows() {
  const search = state.orderListModal.search.trim().toLowerCase();
  const filter = state.orderListModal.filter;
  const source = state.viewModel?.invoices || [];
  state.orderListModal.sourceCount = source.length;
  return sortInvoices(source)
    .map((invoice, invoiceIndex) => {
      const invoiceState = workflowInvoiceState(invoice);
      const shortage = invoiceItemsInSellpiaRowOrder(invoice).reduce((sum, item) => sum + shortageQty(item), 0);
      const hold = Boolean(invoiceState?.systemShippingHold || invoiceState?.shippingHoldNeedsOn || invoiceState?.shippingHoldUnknown || invoiceStats(invoice).hold > 0);
      const holdLabel = invoiceState?.systemShippingHold ? "배송보류 ON" : invoiceState?.shippingHoldNeedsOn ? "배송보류 처리필요" : invoiceState?.shippingHoldUnknown ? "배송보류 확인필요" : invoiceStats(invoice).hold > 0 ? "배송보류" : "";
      const itemSummary = invoiceItemsInSellpiaRowOrder(invoice)
        .map((item) => [item.ownCode || item.sellpiaProductCode, cleanOptionName(item.optionName, item.ownCode) || item.productName].filter(Boolean).join(" · "))
        .filter(Boolean);
      const status = [shortage > 0 ? `미송 ${shortage}` : "", holdLabel].filter(Boolean);
      const haystack = [
        invoiceSequenceWithGroupLabel(invoice, invoiceIndex),
        invoice.invoiceNo,
        invoice.orderGroupNo,
        invoice.displayName,
        invoice.csDisplayName,
        invoice.recipientName,
        invoice.buyerName,
        invoiceDrawerValue(invoice),
        ...itemSummary,
      ]
        .join(" ")
        .toLowerCase();
      return { invoice, invoiceIndex, shortage, hold, status, itemSummary, haystack };
    })
    .filter((row) => {
      if (workflowInvoiceState(row.invoice)?.cancelled) return false;
      if (filter === "target" && !(row.shortage > 0 || row.hold)) return false;
      if (filter === "shortage" && row.shortage <= 0) return false;
      if (filter === "hold" && !row.hold) return false;
      return !search || row.haystack.includes(search);
    });
}

function csListReceiptLabel(invoice) {
  const receiptDate = dateKey(invoice?.receiptDate);
  if (!receiptDate) return "접수일 -";
  return `접수 ${receiptDate} (알림톡 ${receiptBusinessDaysSinceDateKey(receiptDate)}일차)`;
}

function ensureOrderListModal() {
  let modal = document.getElementById("order-list-modal");
  if (modal) return modal;
  modal = document.createElement("div");
  modal.id = "order-list-modal";
  modal.className = "order-list-modal-overlay";
  modal.hidden = true;
  modal.innerHTML = `<div class="order-list-modal cs-list-modal" role="dialog" aria-modal="true" aria-label="CS 리스트">
    <div class="order-list-modal-head">
      <h3>CS 리스트</h3>
      <div class="order-list-modal-tools">
        <input id="order-list-modal-search" type="search" placeholder="주문자 / 수취인 / 자사코드 / 송장">
        <button type="button" class="order-list-modal-close" data-order-list-action="close">×</button>
      </div>
    </div>
    <div class="order-list-modal-filters" id="order-list-modal-filters">
      <button type="button" data-order-list-filter="target">CS 대상</button>
      <button type="button" data-order-list-filter="all">전체</button>
      <button type="button" data-order-list-filter="shortage">미송 진행</button>
      <button type="button" data-order-list-filter="hold">배송보류</button>
    </div>
    <div class="order-list-modal-table-wrap">
      <table class="order-list-modal-table cs-list-table">
        <thead>
          <tr>
            <th>상태</th>
            <th>송장 / 접수</th>
            <th>수취인</th>
            <th>상품</th>
            <th>관리메모</th>
            <th></th>
          </tr>
        </thead>
        <tbody id="order-list-modal-body"></tbody>
      </table>
    </div>
    <div class="order-list-modal-foot" id="order-list-modal-foot">0건</div>
  </div>`;
  document.body.appendChild(modal);
  modal.addEventListener("click", (event) => {
    if (event.target.id === "order-list-modal" || event.target.closest("[data-order-list-action='close']")) {
      closeOrderListModal();
      return;
    }
    const logButton = event.target.closest("[data-order-list-action='work-log']");
    if (logButton) {
      state.csWorkLogModal.search = logButton.dataset.orderSearch || "";
      state.csWorkLogModal.loaded = false;
      closeOrderListModal();
      openCsWorkLogModal({ returnToOrderList: true });
      loadCsWorkLog().catch(showError);
      return;
    }
    const filterButton = event.target.closest("[data-order-list-filter]");
    if (!filterButton) return;
    state.orderListModal.filter = filterButton.dataset.orderListFilter || "all";
    renderOrderListModal();
  });
  modal.querySelector("#order-list-modal-search")?.addEventListener("input", (event) => {
    state.orderListModal.search = event.target.value;
    renderOrderListModal();
  });
  return modal;
}

function renderOrderListModal() {
  const modal = ensureOrderListModal();
  modal.hidden = !state.orderListModal.open;
  if (!state.orderListModal.open) return;
  const searchInput = modal.querySelector("#order-list-modal-search");
  if (searchInput && searchInput.value !== state.orderListModal.search) searchInput.value = state.orderListModal.search;
  modal.querySelectorAll("[data-order-list-filter]").forEach((button) => {
    button.classList.toggle("active", button.dataset.orderListFilter === state.orderListModal.filter);
  });
  const body = modal.querySelector("#order-list-modal-body");
  const foot = modal.querySelector("#order-list-modal-foot");
  const rows = orderListModalRows();
  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="6" class="order-list-modal-empty">현재 필터에 맞는 CS 대상이 없습니다.</td></tr>';
    if (foot) foot.textContent = `표시 0건 · 현재 화면 주문 ${state.orderListModal.sourceCount}건`;
    return;
  }
  body.innerHTML = rows
    .map(({ invoice, shortage, hold, status, itemSummary }) => {
      const rowClass = shortage > 0 ? "shortage" : hold ? "hold" : "";
      return `<tr class="${rowClass}">
        <td><div class="order-list-modal-badges">${status.map((label) => `<span class="${label.startsWith("미송") ? "danger" : "hold"}">${escapeHtml(label)}</span>`).join("") || "<span>일반</span>"}</div></td>
        <td><strong class="cs-list-invoice">${escapeHtml(invoice.invoiceNo || "-")}</strong><small>${escapeHtml(csListReceiptLabel(invoice))}</small></td>
        <td>${escapeHtml(invoice.recipientName || invoice.displayName || invoice.csDisplayName || "-")}</td>
        <td class="name cs-list-products">${escapeHtml(itemSummary.join("\n") || "-")}</td>
        <td class="accent cs-list-memo">${escapeHtml(invoiceDrawerValue(invoice) || "-")}</td>
        <td class="center"><button class="btn" type="button" data-order-list-action="work-log" data-order-search="${escapeHtml(invoice.invoiceNo || invoice.orderGroupNo || "")}">로그</button></td>
      </tr>`;
    })
    .join("");
  if (foot) foot.textContent = `표시 ${rows.length}건 · 현재 화면 주문 ${state.orderListModal.sourceCount}건`;
}

function openOrderListModal() {
  state.orderListModal.filter = "all";
  state.orderListModal.search = "";
  state.orderListModal.open = true;
  renderOrderListModal();
  document.getElementById("order-list-modal-search")?.focus();
}

function closeOrderListModal() {
  state.orderListModal.open = false;
  renderOrderListModal();
}

function renderTray() {
  if (!els.trayBoard) return;
  const invoices = currentTrayInvoices();
  const rows = invoices.flatMap((invoice, invoiceIndex) =>
    invoiceItemsInSellpiaRowOrder(invoice).map((item) => ({ invoice, item, invoiceIndex })),
  );
  const activeRows = rows.filter(({ invoice, item }) => !itemIsEffectivelyCancelled(invoice, item));
  const done = activeRows.filter(({ item }) => isPicked(item)).length;
  const groupLabel =
    state.searchText || state.filterMode !== "all"
      ? filterLabel(state.filterMode)
      : state.groupInfos[state.currentGroup]?.label || `${state.currentGroup + 1}조`;

  els.bottomTray?.classList.toggle("open", state.trayOpen);
  els.bottomTray?.classList.toggle("expanded", state.trayExpanded);
  if (els.bottomTray) els.bottomTray.scrollTop = 0;
  if (els.trayHandle) els.trayHandle.setAttribute("aria-expanded", String(state.trayOpen));
  if (els.trayLabel) els.trayLabel.textContent = `${groupLabel} 상품 슬롯`;
  if (els.trayTitle) els.trayTitle.textContent = `${groupLabel} 상품 슬롯`;
  if (els.trayCount) els.trayCount.textContent = `${done}/${activeRows.length}`;
  if (els.trayExpandBtn) els.trayExpandBtn.textContent = state.trayExpanded ? "접기" : "펼치기";

  if (!rows.length) {
    els.trayBoard.innerHTML = '<div class="tray-empty">표시할 상품이 없습니다.</div>';
    return;
  }

  const slots = [[], [], [], []];
  rows.forEach((row) => {
    slots[Math.min(3, row.invoiceIndex % 4)].push(row);
  });

  els.trayBoard.innerHTML = slots
    .map((slotRows, index) => {
      const activeSlotRows = slotRows.filter(({ invoice, item }) => !itemIsEffectivelyCancelled(invoice, item));
      const picked = activeSlotRows.filter(({ item }) => isPicked(item)).length;
      const shortage = activeSlotRows.filter(({ item }) => shortageQty(item) > 0).length;
      const firstInvoice = slotRows[0]?.invoice;
      const title = firstInvoice
        ? `${invoiceSequenceWithGroupLabel(firstInvoice)} · ${firstInvoice.displayName || firstInvoice.csDisplayName || ""}`
        : `${index + 1}번`;
      const body = slotRows.length
        ? slotRows
            .map(({ invoice, item }) => {
              const meta = itemStatusMeta(item, invoice);
              const key = itemSlotKey(invoice, item);
              const classes = [
                "tray-item",
                meta.className,
                key === state.currentTrayKey ? "selected" : "",
                isGoldItem(item) ? "is-gold" : "",
                itemIsEffectivelyCancelled(invoice, item) ? "is-cancelled" : "",
              ]
                .filter(Boolean)
                .join(" ");
              return `<button class="${classes}" data-tray-key="${escapeHtml(key)}" type="button" ${itemIsEffectivelyCancelled(invoice, item) ? "disabled" : ""}>
                <span class="tray-item-check" data-tray-toggle>${isPicked(item) ? "✓" : ""}</span>
                <span class="tray-item-main">
                  <span class="tray-item-seq">${escapeHtml(invoiceSequenceWithGroupLabel(invoice))}</span>
                  <strong>${escapeHtml(item.ownCode || "-")}</strong>
                  <small>${escapeHtml(cleanOptionName(item.optionName, item.ownCode) || item.productName || "-")}</small>
                </span>
                <span class="tray-item-qty">${Number(item.quantity) || 1}개</span>
                <span class="tray-item-state">${escapeHtml(meta.label)}</span>
              </button>`;
            })
            .join("")
        : '<div class="tray-slot-empty">상품 없음</div>';
      return `<section class="tray-slot">
        <div class="tray-slot-head">
          <span>${escapeHtml(title)}</span>
          <strong>${picked}/${activeSlotRows.length}</strong>
          ${shortage ? `<em>미송 ${shortage}</em>` : ""}
        </div>
        <div class="tray-slot-list">${body}</div>
      </section>`;
    })
    .join("");
}

function renderGroups() {
  els.groupList.innerHTML = state.groups
    .map((group, index) => {
      const info = state.groupInfos[index] || { label: `${index + 1}조`, kind: "normal" };
      const stats = group.reduce(
        (acc, invoice) => {
          const invoiceStat = invoiceStats(invoice);
          acc.total += invoiceStat.total;
          acc.done += invoiceStat.picked;
          acc.shortage += invoiceStat.shortage;
          return acc;
        },
        { total: 0, done: 0, shortage: 0 },
      );
      const classes = [
        "group-btn",
        index === state.currentGroup ? "active" : "",
        stats.shortage ? "has-shortage" : "",
        info.kind === "gold" ? "is-gold" : "",
      ]
        .filter(Boolean)
        .join(" ");
      const bulkTargets = groupBulkTargets(group);
      const bulkDone = bulkTargets.length > 0 && bulkTargets.every(({ item }) => isPicked(item));
      return `<div class="group-row">
        <button class="${classes}" data-group="${index}" type="button">
          <span>${escapeHtml(info.label)}</span>
          <span>${stats.done}/${stats.total}${stats.shortage ? ` · 미송 ${stats.shortage}` : ""}</span>
        </button>
        <button class="group-bulk-btn ${bulkDone ? "done" : ""}" data-bulk-group="${index}" type="button" title="${bulkDone ? "체크 취소" : "일괄 체크"}" ${bulkTargets.length ? "" : "disabled"}>${bulkDone ? "↩" : "☑"}</button>
      </div>`;
    })
    .join("");
}

function renderFilters() {
  els.filterBar.querySelectorAll("[data-filter]").forEach((button) => {
    button.classList.toggle("active", button.dataset.filter === state.filterMode);
  });
}

function sideShortcutConfig() {
  if (state.activeTab === "picking") {
    return {
      title: "상태 바로가기",
      items: [
        ["filter", "all", "전체"],
        ["filter", "todo", "미완료"],
        ["filter", "shortage", "미송"],
        ["filter", "nodrawer", "서랍없음"],
        ["filter", "gold", "골드"],
        ["filter", "hold", "보류"],
        ["filter", "done", "완료"],
      ],
    };
  }
  if (state.activeTab === "shortage") {
    return {
      title: "미송 보기",
      items: [
        ["shortage", "all", "전체(지연일순)"],
        ["shortage", "code", "자사코드별"],
        ["shortage", "drawer", "서랍입력"],
        ["shortage", "completed", "기존완료"],
      ],
    };
  }
  if (state.activeTab === "inspection") {
    return {
      title: "검품 보기",
      items: [
        ["inspection", "all", "전체"],
        ["inspection", "shortage", "미송포함"],
        ["inspection", "hold", "보류"],
        ["inspection", "gold", "골드"],
        ["inspection-hide", "toggle", state.inspectionHideCompleted ? "완료보기" : "완료제거"],
      ],
    };
  }
  if (state.activeTab === "cs") {
    return {
      title: "CS 보기",
      items: [],
    };
  }
  if (state.activeTab === "completed") {
    return {
      title: "완료 기준",
      items: [
        ["completed-date", "receipt", "접수일"],
        ["completed-date", "completed", "완료일"],
      ],
    };
  }
  return { title: "바로가기", items: [] };
}

function isSideShortcutActive(type, value) {
  if (type === "filter") return state.filterMode === value;
  if (type === "shortage") return state.shortageFilter === value;
  if (type === "inspection") return state.inspectionFilter === value;
  if (type === "inspection-hide") return state.inspectionHideCompleted;
  if (type === "completed-date") return state.completedDateMode === value;
  return false;
}

function renderSideShortcuts() {
  if (!els.sideShortcuts) return;
  const config = sideShortcutConfig();
  if (!config.items.length || state.sidebarCollapsed) {
    els.sideShortcuts.innerHTML = "";
    return;
  }
  els.sideShortcuts.innerHTML = `<div class="side-title">${escapeHtml(config.title)}</div>
    <div class="side-shortcut-grid">
      ${config.items
        .map(
          ([type, value, label]) =>
            `<button class="side-shortcut ${isSideShortcutActive(type, value) ? "active" : ""}" data-side-shortcut="${type}" data-side-value="${escapeHtml(value)}" type="button">${escapeHtml(label)}</button>`,
        )
        .join("")}
    </div>`;
}

function applySideShortcut(type, value) {
  if (type === "filter") {
    state.filterMode = value || "all";
    render();
    return;
  }
  if (type === "shortage") {
    state.shortageFilter = value || "all";
    state.selectedShortageKey = "";
    renderShortagePanels();
    renderSideShortcuts();
    return;
  }
  if (type === "inspection") {
    state.inspectionFilter = value || "all";
    state.selectedInspectionGroup = "";
    renderInspectionPanels();
    renderSideShortcuts();
    return;
  }
  if (type === "inspection-hide") {
    state.inspectionHideCompleted = !state.inspectionHideCompleted;
    state.selectedInspectionGroup = "";
    renderInspectionPanels();
    renderSideShortcuts();
    return;
  }
  if (type === "completed-date") {
    state.completedDateMode = value || "receipt";
    state.selectedCompletedGroup = "";
    renderCompletedPanels();
    renderSideShortcuts();
  }
}

function renderProgress(invoices) {
  const rows = invoices.flatMap((invoice) => activeWorkflowItems(invoice).map((item) => ({ invoice, item })));
  const done = rows.filter(({ item }) => isPicked(item)).length;
  const items = rows.map(({ item }) => item);
  const total = items.length;
  const pct = total ? Math.round((done / total) * 100) : 0;
  const groupLabel = state.groupInfos[state.currentGroup]?.label || `${state.currentGroup + 1}조`;
  els.currentGroupLabel.textContent =
    state.searchText || state.filterMode !== "all" ? filterLabel(state.filterMode) : groupLabel;
  els.progressText.textContent = `${done}/${total} 완료`;
  els.progressFill.style.width = `${pct}%`;
}

function groupBulkTargets(group = []) {
  return group.flatMap((invoice) =>
    (invoice.items || [])
      .filter((item) => !itemIsEffectivelyCancelled(invoice, item) && shortageQty(item) === 0 && !isHold(item))
      .map((item) => ({ invoice, item })),
  );
}

function renderOrderList() {
  const invoices = currentVisibleInvoices();
  const rows = currentPickingRows();
  renderProgress(invoices);
  const groupLabel = state.groupInfos[state.currentGroup]?.label || `${state.currentGroup + 1}조`;
  els.panelSubtitle.textContent =
    state.searchText || state.filterMode !== "all"
      ? `${filterLabel(state.filterMode)} · ${rows.length}상품 / ${invoices.length}송장`
      : `${groupLabel} · ${rows.length}상품 / ${invoices.length}송장`;

  if (!state.viewModel) {
    els.orderList.innerHTML = '<div class="empty">데이터를 불러오는 중입니다.</div>';
    return;
  }

  if (!rows.length) {
    els.orderList.innerHTML = '<div class="empty">표시할 상품이 없습니다.</div>';
    return;
  }

  if (isGoldGroupedPickingView(invoices)) {
    els.orderList.innerHTML = invoices.map((invoice, invoiceIndex) => renderGoldInvoiceCard(invoice, invoiceIndex)).join("");
    return;
  }

  els.orderList.innerHTML = rows.map(({ invoice, item, invoiceIndex, itemIndex }) => renderPickingRow(invoice, item, invoiceIndex, itemIndex)).join("");
}

function isGoldGroupedPickingView(invoices = currentVisibleInvoices()) {
  if (!invoices.some(invoiceHasGold)) return false;
  return state.filterMode === "gold" || state.groupInfos[state.currentGroup]?.kind === "gold";
}

function sortedInvoiceItemsForPicking(invoice) {
  return invoiceItemsInSellpiaRowOrder(invoice);
}

function renderGoldInvoiceCard(invoice, invoiceIndex = 0) {
  const items = sortedInvoiceItemsForPicking(invoice);
  const activeItems = activeWorkflowItems(invoice);
  const picked = activeItems.filter(isPicked).length;
  const shortage = activeItems.filter((item) => shortageQty(item) > 0).length;
  const qty = activeItems.reduce((sum, item) => sum + (Number(item.quantity) || 1), 0);
  const seller = sellerBadgeMeta(invoice.seller);
  return `<article class="gold-invoice-card ${invoiceIsCancelled(invoice) ? "is-cancelled" : ""}">
    <div class="gold-invoice-head">
      <div>
        <strong>${escapeHtml(invoiceSequenceWithGroupLabel(invoice, invoiceIndex))}</strong>
        <span>${escapeHtml(invoice.displayName || invoice.csDisplayName || "-")} · ${items.length}종 ${qty}개</span>
      </div>
      <div class="gold-invoice-badges">
        ${seller ? `<span class="seller-badge ${seller.className}">${escapeHtml(seller.label)}</span>` : ""}
        <span class="gold-badge">골드송장</span>
        ${shortage ? `<span class="workflow-row-badge danger">미송 ${shortage}</span>` : ""}
        ${invoiceIsCancelled(invoice) ? '<span class="workflow-row-badge cancelled">주문취소</span>' : ""}
        <span class="workflow-row-badge done">${picked}/${activeItems.length}</span>
      </div>
    </div>
    <div class="gold-item-list">
      ${items.map((item, itemIndex) => renderGoldInvoiceItem(invoice, item, invoiceIndex, itemIndex)).join("")}
    </div>
  </article>`;
}

function renderGoldInvoiceItem(invoice, item, invoiceIndex = 0, itemIndex = 0) {
  const key = itemSlotKey(invoice, item);
  const checked = isPicked(item);
  const shortage = shortageQty(item);
  const imageUrl = productImageUrl(item.sellpiaProductCode);
  const option = cleanOptionName(item.optionName, item.ownCode) || item.productName || "-";
  const classes = [
    "gold-item-row",
    checked ? "is-picked" : "",
    shortage ? "has-shortage" : "",
    isHold(item) ? "has-hold" : "",
    isGoldItem(item) ? "is-gold" : "",
    key === state.currentTrayKey ? "is-selected" : "",
    itemIsEffectivelyCancelled(invoice, item) ? "is-cancelled" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return `<div class="${classes}" data-order-group="${escapeHtml(invoice.orderGroupNo)}" data-item-no="${escapeHtml(item.sellpiaItemNo)}" data-slot-key="${escapeHtml(key)}">
    <button class="pick-check ${checked ? "checked" : ""}" data-action="toggle" data-order-group="${escapeHtml(invoice.orderGroupNo)}" data-item-no="${escapeHtml(item.sellpiaItemNo)}" ${itemIsEffectivelyCancelled(invoice, item) ? "disabled" : ""}>${checked ? "✓" : ""}</button>
    <div class="gold-item-photo">${imageUrl ? `<img src="${imageUrl}" ${photoImgAttrs(imageUrl, photoTitleForItem(item), productImageFallbackUrls(item.sellpiaProductCode))} alt="" loading="lazy">` : "사진"}</div>
    <div class="gold-item-main">
      <span class="workflow-row-order">상품순서 ${itemOrderNo(item, itemIndex)}번</span>
      <strong class="${optionClass(item, "option")}">${escapeHtml(option)}</strong>
      <small>${escapeHtml(item.ownCode || "-")} · ${escapeHtml(item.productName || "")}</small>
      ${renderPickingCustomOrderControls(invoice, item, { compact: true })}
    </div>
    <span class="gold-item-qty">${Number(item.quantity) || 1}개</span>
    <div class="shortage-control gold-shortage-control">
      ${shortageQtyInput(invoice, item, shortage, "compact")}
    </div>
    <textarea class="drawer-input gold-drawer-input" inputmode="none" data-action="drawer" data-order-group="${escapeHtml(invoice.orderGroupNo)}" rows="1" placeholder="서랍" readonly>${escapeHtml(invoiceDrawerValue(invoice))}</textarea>
  </div>`;
}

function renderWorkflowEmpty(target, message) {
  if (target) target.innerHTML = `<div class="workflow-empty">${escapeHtml(message)}</div>`;
}

function shortageFilterLabel(filter = state.shortageFilter) {
  return (
    {
      all: "전체(지연일순)",
      code: "자사코드별",
      drawer: "서랍입력",
      completed: "기존완료",
      cancelled: "취소",
    }[filter] || "전체"
  );
}

function repickedShortageRows() {
  return (state.workflowQueues?.viewModel?.invoices || []).flatMap((invoice) => {
    const invoiceState = workflowInvoiceState(invoice);
    if (invoiceState?.inspected || invoiceState?.cancelled) return [];
    return (invoice.items || [])
      .map((item) => ({
        invoice,
        item,
        state: workflowItemState(invoice, item),
        completed: true,
      }))
      .filter((row) => row.state?.shortageRepicked && !row.state?.inspected && !row.state?.cancelled);
  });
}

function resetReceivingLabel(error = "") {
  state.receivingLabel.fileName = "";
  state.receivingLabel.entries = [];
  state.receivingLabel.productMap = new Map();
  state.receivingLabel.ownCodeMap = new Map();
  state.receivingLabel.rowCount = 0;
  state.receivingLabel.totalQty = 0;
  state.receivingLabel.error = error;
  state.receivingLabel.source = "none";
  state.receivingLabel.syncError = "";
}

function addReceivingEntry(entry) {
  if (!entry?.productCode) return;
  const productKey = receivingProductCodeKey(entry.productCode);
  if (!productKey) return;
  const productMap = state.receivingLabel.productMap;
  const current = productMap.get(productKey) || {
    productCode: entry.productCode,
    optionName: entry.optionName || "",
    ownCode: entry.ownCode || "",
    qty: 0,
    rows: 0,
  };
  current.qty += Number(entry.qty || 0);
  current.rows += 1;
  if (!current.optionName && entry.optionName) current.optionName = entry.optionName;
  if (!current.ownCode && entry.ownCode) current.ownCode = entry.ownCode;
  productMap.set(productKey, current);

  for (const ownKey of receivingOwnCodeKeys(entry.ownCode)) {
    if (!state.receivingLabel.ownCodeMap.has(ownKey)) state.receivingLabel.ownCodeMap.set(ownKey, current);
  }
}

function receivingColumnIndex(headers, names) {
  const normalized = headers.map((value) => String(value || "").replace(/\s+/g, "").trim());
  return normalized.findIndex((header) => names.some((name) => header === name));
}

function parseReceivingRows(sheetRows = []) {
  const headerIndex = sheetRows.findIndex((row) => {
    const text = (row || []).map((cell) => String(cell || "").replace(/\s+/g, "").trim());
    return text.includes("상품코드") && text.includes("입고");
  });
  if (headerIndex < 0) throw new Error("라벨지에서 상품코드/입고 헤더를 찾지 못했습니다.");

  const headers = sheetRows[headerIndex] || [];
  const productIndex = receivingColumnIndex(headers, ["상품코드", "상품CODE", "상품코드"]);
  const optionIndex = receivingColumnIndex(headers, ["옵션명", "옵션"]);
  const qtyIndex = receivingColumnIndex(headers, ["입고", "입고수량", "수량"]);
  const ownIndex = receivingColumnIndex(headers, ["자사코드", "자사상품코드"]);
  if (productIndex < 0 || qtyIndex < 0) throw new Error("라벨지 필수 컬럼이 부족합니다.");

  return sheetRows.slice(headerIndex + 1).flatMap((row) => {
    const productCode = String(row?.[productIndex] || "").trim();
    if (!productCode) return [];
    return [
      {
        productCode,
        optionName: String(row?.[optionIndex] || "").trim(),
        qty: numberFromCell(row?.[qtyIndex]),
        ownCode: String(row?.[ownIndex] || "").trim(),
      },
    ];
  });
}

function applyReceivingEntries(entries = [], { fileName = "", source = "local" } = {}) {
  resetReceivingLabel();
  state.receivingLabel.fileName = fileName;
  state.receivingLabel.source = source;
  state.receivingLabel.entries = (entries || [])
    .map((entry) => ({
      productCode: String(entry?.productCode || "").trim(),
      optionName: String(entry?.optionName || "").trim(),
      qty: numberFromCell(entry?.qty),
      ownCode: String(entry?.ownCode || "").trim(),
    }))
    .filter((entry) => entry.productCode);
  for (const entry of state.receivingLabel.entries) {
    addReceivingEntry(entry);
    state.receivingLabel.totalQty += Number(entry.qty || 0);
  }
  state.receivingLabel.rowCount = state.receivingLabel.productMap.size;
}

function parseCsvTextRows(text = "") {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  const source = String(text || "").replace(/^\uFEFF/, "");
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === '"' && source[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && source[index + 1] === "\n") index += 1;
      row.push(cell);
      if (row.some((value) => String(value || "").trim())) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  row.push(cell);
  if (row.some((value) => String(value || "").trim())) rows.push(row);
  return rows;
}

function parseSharedReceivingLabelCsv(text = "") {
  const rows = parseCsvTextRows(text);
  const headers = (rows.shift() || []).map((value) => String(value || "").trim().toLowerCase());
  const productIndex = headers.indexOf("product_code");
  const ownIndex = headers.indexOf("own_code");
  const optionIndex = headers.indexOf("option_name");
  const qtyIndex = headers.indexOf("qty");
  if (productIndex < 0 || qtyIndex < 0) throw new Error("공유 입고 라벨 형식이 올바르지 않습니다.");
  return rows.flatMap((row) => {
    const productCode = String(row?.[productIndex] || "").trim();
    if (!productCode) return [];
    return [{
      productCode,
      ownCode: String(row?.[ownIndex] || "").trim(),
      optionName: String(row?.[optionIndex] || "").trim(),
      qty: numberFromCell(row?.[qtyIndex]),
    }];
  });
}

function sharedReceivingLabelCsv(entries = []) {
  return csvRowsToText([
    RECEIVING_LABEL_CSV_HEADER,
    ...(entries || []).map((entry) => [entry.productCode, entry.ownCode, entry.optionName, entry.qty]),
  ]);
}

function isMissingSharedReceivingLabel(error) {
  const status = String(error?.statusCode || error?.status || "");
  const message = String(error?.message || "");
  return status === "404" || /not found|object not found/i.test(message);
}

async function saveSharedReceivingLabel(entries = []) {
  const file = new Blob([sharedReceivingLabelCsv(entries)], { type: "text/csv;charset=utf-8" });
  const { error } = await db.storage.from(RECEIVING_LABEL_BUCKET).upload(RECEIVING_LABEL_PATH, file, {
    upsert: true,
    contentType: "text/csv",
    cacheControl: "0",
  });
  if (error) throw error;
}

async function loadSharedReceivingLabel() {
  const { data, error } = await db.storage.from(RECEIVING_LABEL_BUCKET).download(RECEIVING_LABEL_PATH);
  if (error) {
    if (isMissingSharedReceivingLabel(error)) return false;
    throw error;
  }
  const entries = parseSharedReceivingLabelCsv(await data.text());
  applyReceivingEntries(entries, { fileName: "공유 입고 라벨", source: "shared" });
  return true;
}

async function loadReceivingLabelFile(file) {
  if (!file) return;
  if (!window.XLSX) {
    resetReceivingLabel("XLSX 로드 실패");
    toast("XLSX 라이브러리 로드 실패");
    renderShortagePanels();
    return;
  }
  try {
    const buffer = await file.arrayBuffer();
    const workbook = window.XLSX.read(new Uint8Array(buffer), { type: "array" });
    const firstSheetName = workbook.SheetNames?.[0];
    if (!firstSheetName) throw new Error("시트를 찾지 못했습니다.");
    const sheetRows = window.XLSX.utils.sheet_to_json(workbook.Sheets[firstSheetName], { header: 1, raw: false, defval: "" });
    const entries = parseReceivingRows(sheetRows);
    applyReceivingEntries(entries, { fileName: file.name || "", source: "local" });
  } catch (error) {
    resetReceivingLabel(error?.message || "라벨지 읽기 실패");
    toast(`입고 라벨 읽기 실패: ${state.receivingLabel.error}`);
    state.selectedShortageKey = "";
    renderShortagePanels();
    renderSideShortcuts();
    return;
  }
  try {
    await saveSharedReceivingLabel(state.receivingLabel.entries);
    state.receivingLabel.source = "shared";
    toast(`입고 라벨 ${state.receivingLabel.rowCount}종 공유 완료`);
  } catch (error) {
    state.receivingLabel.syncError = error?.message || "공유 저장 실패";
    toast(`입고 라벨은 현재 화면에만 적용됨: ${state.receivingLabel.syncError}`);
  }
  state.selectedShortageKey = "";
  renderShortagePanels();
  renderSideShortcuts();
}

function receivingLabelEntryForItem(item = {}) {
  const productKey = receivingProductCodeKey(item.sellpiaProductCode || item.raw?.p_code || item.raw?.sellpia_p_code);
  if (productKey && state.receivingLabel.productMap.has(productKey)) return state.receivingLabel.productMap.get(productKey);
  for (const ownKey of receivingOwnCodeKeys(item.ownCode || item.raw?.prod_code || item.raw?.p_dpcode)) {
    if (state.receivingLabel.ownCodeMap.has(ownKey)) return state.receivingLabel.ownCodeMap.get(ownKey);
  }
  return null;
}

function shortageRowReceivingEntry(row) {
  return receivingLabelEntryForItem(row?.item || {});
}

function shortageRowMatchesReceiving(row) {
  if (!state.receivingLabel.only) return true;
  return Boolean(shortageRowReceivingEntry(row));
}

function updateShortageReceivingStatus(openRows = []) {
  if (els.shortageReceivingOnly && els.shortageReceivingOnly.checked !== state.receivingLabel.only) {
    els.shortageReceivingOnly.checked = state.receivingLabel.only;
  }
  if (!els.shortageReceivingStatus) return;
  if (state.receivingLabel.error) {
    els.shortageReceivingStatus.textContent = state.receivingLabel.error;
    els.shortageReceivingStatus.classList.add("warn");
    return;
  }
  if (state.receivingLabel.syncError) {
    els.shortageReceivingStatus.textContent = state.receivingLabel.rowCount
      ? `입고 ${state.receivingLabel.rowCount}종 · 공유 실패`
      : "공유 라벨 불러오기 실패";
    els.shortageReceivingStatus.classList.add("warn");
    return;
  }
  if (!state.receivingLabel.rowCount) {
    els.shortageReceivingStatus.textContent = "라벨 없음";
    els.shortageReceivingStatus.classList.remove("warn");
    return;
  }
  els.shortageReceivingStatus.classList.remove("warn");
  const matched = openRows.filter(shortageRowReceivingEntry).length;
  const shared = state.receivingLabel.source === "shared" ? "공유 " : "";
  els.shortageReceivingStatus.textContent = `${shared}입고 ${state.receivingLabel.rowCount}종 · 미송 ${matched}건`;
}

function drawerMemoForShortageRow(row) {
  return String(row?.state?.drawerMemo || itemManagementMemo(row?.item) || invoiceDrawerValue(row?.invoice) || "").trim();
}

function shortageDelayDisplayLabel(invoice) {
  const receiptDate = dateKey(invoice?.receiptDate);
  if (!receiptDate) return "지연 -일차";
  return `지연 ${receiptBusinessDaysSinceDateKey(receiptDate)}일차`;
}

function shortageRowMatchesSearch(row) {
  const search = state.shortageSearchText.trim().toLowerCase();
  if (!search) return true;
  const invoice = row.invoice || {};
  const drawerMemo = drawerMemoForShortageRow(row);
  const sequenceNo = String(visibleInvoiceSequenceNo(invoice) || "");
  const shortageLabel = shortageInvoiceDisplayLabel(invoice);
  const text = [
    invoice.invoiceNo,
    invoice.orderGroupNo,
    invoice.displayName,
    invoice.csDisplayName,
    invoice.recipientName,
    invoice.buyerName,
    sequenceNo,
    visibleInvoiceSequenceLabel(invoice),
    shortageLabel,
    drawerMemo,
  ]
    .join(" ")
    .toLowerCase();
  const digits = onlyDigits(search);
  if (digits && search === digits) {
    return onlyDigits(invoice.invoiceNo).includes(digits) || sequenceNo === digits || onlyDigits(drawerMemo).includes(digits);
  }
  return text.includes(search);
}

function shortageRowsForCurrentFilter() {
  const openRows = sortShortageRowsByReceiptDate(state.workflowQueues?.shortageItems || []);
  const cancelledRows = sortShortageRowsByReceiptDate(cancelledShortageRows());
  let rows = [...openRows, ...cancelledRows];
  if (state.shortageFilter === "completed") {
    rows = repickedShortageRows().sort((a, b) => workflowEventTime(b.state) - workflowEventTime(a.state));
  } else if (state.shortageFilter === "cancelled") {
    rows = cancelledRows;
  } else if (state.shortageFilter === "drawer") {
    rows = rows.filter(drawerMemoForShortageRow);
  } else if (state.shortageFilter === "code") {
    rows = [...rows].sort(compareShortageRowsByPickingRoute);
  }
  return rows.filter(shortageRowMatchesReceiving).filter(shortageRowMatchesSearch);
}

function shortageRowOwnCode(row) {
  return String(row?.item?.ownCode || "").trim() || "자사코드 없음";
}

function shortageGroupStats(rows = []) {
  const groups = new Map();
  for (const row of rows) {
    const code = shortageRowOwnCode(row);
    if (!groups.has(code)) groups.set(code, { code, rows: [], qty: 0 });
    const group = groups.get(code);
    group.rows.push(row);
    group.qty += Number(row.state?.shortageQty || 0) || 1;
  }
  return [...groups.values()];
}

function renderShortageRow({ invoice, item, state: itemState, completed, cancelled }, visibleSequenceNo = 0) {
  const key = workflowItemKey(invoice, item);
  const orderNo = itemOrderNo(item, invoiceItemIndex(invoice, item));
  const receiptDate = String(invoice.receiptDate || "").slice(0, 10);
  const orderDateTime = invoiceOrderDateTimeLabel(invoice);
  const delayLabel = shortageDelayDisplayLabel(invoice);
  const drawerNo = drawerMemoForShortageRow({ invoice, item, state: itemState });
  const drawerOrderLabel = `${drawerNo || "미입력"}-${orderNo}`;
  const receiving = receivingLabelEntryForItem(item);
  const bulkChecked = state.shortageBulkSelectedKeys.has(key);
  const bulkDisabled = completed || cancelled || state.shortageBulkSaving || !allowWorkflowEvents;
  return `<div class="shortage-row-shell">
    <label class="shortage-row-select" title="미송피킹 일괄완료 대상 선택">
      <input type="checkbox" data-shortage-select="${escapeHtml(key)}" aria-label="${escapeHtml(item.ownCode || "미송 상품")} 선택" ${bulkChecked ? "checked" : ""} ${bulkDisabled ? "disabled" : ""}>
    </label>
    <button class="workflow-row shortage-workflow-row ${key === state.selectedShortageKey ? "selected" : ""} ${completed ? "is-completed" : ""} ${cancelled ? "is-cancelled" : ""} ${receiving ? "has-receiving" : ""}" data-shortage-key="${escapeHtml(key)}" data-visible-sequence="${visibleSequenceNo}" type="button">
      <span class="workflow-row-sequence" aria-label="현재 정렬 순번">${visibleSequenceNo || "-"}</span>
      <span class="workflow-row-code">${escapeHtml(item.ownCode || "-")}</span>
      <span class="workflow-row-main">
        <strong>${escapeHtml(cleanOptionName(item.optionName, item.ownCode) || item.productName || "-")}</strong>
        <span class="workflow-row-order" title="서랍번호-상품순서">${escapeHtml(drawerOrderLabel)}</span>
        <small>${escapeHtml(invoice.displayName || invoice.csDisplayName || "-")} · ${escapeHtml(delayLabel)}</small>
        ${receiptDate ? `<small class="workflow-row-receipt">접수 ${escapeHtml(receiptDate)}</small>` : ""}
        ${orderDateTime ? `<small class="workflow-row-order-date">주문 ${escapeHtml(orderDateTime)}</small>` : ""}
        ${receiving ? `<small class="receiving-row-note">입고 ${escapeHtml(receiving.qty || "-")}개</small>` : ""}
      </span>
      <span class="workflow-row-badge ${cancelled ? "cancelled" : completed ? "done" : "danger"}">${cancelled ? "취소" : completed ? "기존완료" : `미송 ${Number(itemState?.shortageQty || 0) || 1}`}</span>
    </button>
  </div>`;
}

function renderShortageRows(rows) {
  const visibleSequenceByRow = new Map(rows.map((row, index) => [row, index + 1]));
  const renderVisibleRow = (row) => renderShortageRow(row, visibleSequenceByRow.get(row) || 0);
  if (state.shortageFilter !== "code") return rows.map(renderVisibleRow).join("");
  return shortageGroupStats(rows)
    .map((group) => {
      const sample = group.rows[0]?.item;
      const sampleName = cleanOptionName(sample?.optionName, sample?.ownCode) || sample?.productName || "";
      return `<section class="workflow-code-group">
        <div class="workflow-code-group-head">
          <strong>${escapeHtml(group.code)}</strong>
          <span>${group.rows.length}건 · 미송 ${group.qty}개</span>
          ${sampleName ? `<small>${escapeHtml(sampleName)}</small>` : ""}
        </div>
        ${group.rows.map(renderVisibleRow).join("")}
      </section>`;
    })
    .join("");
}

function openShortageRowForInvoiceItem(invoice, item) {
  const targetKey = workflowItemKey(invoice, item);
  return (state.workflowQueues?.shortageItems || []).find((row) => (
    workflowItemKey(row.invoice, row.item) === targetKey
    && !row.completed
    && !row.cancelled
    && !itemIsEffectivelyCancelled(row.invoice, row.item)
  )) || null;
}

function renderShortageInvoiceItems(invoice) {
  return `<div class="workflow-item-table shortage-invoice-table">
    ${invoiceItemsInSellpiaRowOrder(invoice)
      .map((item, index) => {
        const itemState = workflowItemState(invoice, item);
        const itemCancelled = itemIsEffectivelyCancelled(invoice, item);
        const imageUrl = productImageUrl(item.sellpiaProductCode);
        const shortage = workflowAwareShortageQty(itemState, item);
        const openShortageRow = openShortageRowForInvoiceItem(invoice, item);
        const openShortageKey = openShortageRow
          ? workflowItemKey(openShortageRow.invoice, openShortageRow.item)
          : "";
        const completeDisabled = allowWorkflowEvents ? "" : "disabled";
        return `<div class="workflow-item-row ${shortage > 0 ? "repicked" : ""} ${itemCancelled ? "is-cancelled" : ""}">
          <span>${itemSequenceNo(item, index)}</span>
          <div class="workflow-item-photo">${imageUrl ? `<img src="${imageUrl}" ${photoImgAttrs(imageUrl, photoTitleForItem(item), productImageFallbackUrls(item.sellpiaProductCode))} alt="" loading="lazy">` : "?ъ쭊"}</div>
          <strong>${escapeHtml(item.ownCode || "-")}</strong>
          <em class="${optionHasBarChange(item) ? "option-change" : ""}">${escapeHtml(cleanOptionName(item.optionName, item.ownCode) || item.productName || "-")}</em>
          <b>${Number(item.quantity) || 1}개</b>
          <small>${itemCancelled ? "취소" : shortage > 0 ? `미송 ${shortage}` : "정상"}</small>
          <span class="shortage-invoice-action">${openShortageRow ? `<button class="btn primary mini shortage-invoice-complete-btn" data-action="shortage-repicked" data-shortage-inline-complete data-shortage-key="${escapeHtml(openShortageKey)}" type="button" ${completeDisabled}>미송피킹완료</button>` : ""}</span>
        </div>`;
      })
      .join("")}
  </div>`;
}

function renderShortagePanels() {
  const rows = shortageRowsForCurrentFilter();
  const visibleOpenKeys = new Set(
    rows
      .filter((row) => !row.completed && !row.cancelled)
      .map(({ invoice, item }) => workflowItemKey(invoice, item)),
  );
  for (const key of state.shortageBulkSelectedKeys) {
    if (!visibleOpenKeys.has(key)) state.shortageBulkSelectedKeys.delete(key);
  }
  const openCount = state.workflowQueues?.shortageItems?.length || 0;
  const openRows = state.workflowQueues?.shortageItems || [];
  const completedCount = repickedShortageRows().length;
  const cancelledCount = cancelledShortageRows().length;
  const codeGroupCount = state.shortageFilter === "code" ? shortageGroupStats(rows).length : 0;
  updateShortageReceivingStatus(openRows);
  if (els.shortageSearchInput && els.shortageSearchInput.value !== state.shortageSearchText) {
    els.shortageSearchInput.value = state.shortageSearchText;
  }
  els.shortageFilterBar?.querySelectorAll("[data-shortage-filter]").forEach((button) => {
    button.classList.toggle("active", button.dataset.shortageFilter === state.shortageFilter);
  });
  if (els.shortageListCount) {
    els.shortageListCount.textContent =
      state.shortageFilter === "all"
        ? `${state.shortageSearchText.trim() ? "검색 " : ""}대기 ${openCount}개 · 취소 ${cancelledCount}개 · 표시 ${rows.length}개 · 완료 ${completedCount}개`
        : state.shortageFilter === "code"
          ? `자사코드 ${codeGroupCount}개 · 상품 ${rows.length}개`
          : `${shortageFilterLabel()} ${rows.length}개`;
  }
  if (els.shortageBulkCompleteBtn) {
    const selectedCount = state.shortageBulkSelectedKeys.size;
    els.shortageBulkCompleteBtn.textContent = selectedCount
      ? `미송피킹 일괄완료 (${selectedCount})`
      : "미송피킹 일괄완료";
    els.shortageBulkCompleteBtn.disabled = !allowWorkflowEvents || state.shortageBulkSaving || selectedCount === 0;
  }

  if (state.workflowQueueError) {
    renderWorkflowEmpty(els.shortageListBody, state.workflowQueueError);
    renderWorkflowEmpty(els.shortageDetail, "이벤트 큐를 불러오지 못했습니다.");
    return;
  }

  if (!state.workflowQueues) {
    renderWorkflowEmpty(els.shortageListBody, "이벤트 큐를 불러오는 중입니다.");
    renderWorkflowEmpty(els.shortageDetail, "미송 대상 상품을 선택하면 상세가 표시됩니다.");
    return;
  }

  if (!rows.length) {
    const emptyMessage = state.receivingLabel.only && !state.receivingLabel.rowCount
      ? "입고 라벨지를 먼저 불러오세요."
      : state.receivingLabel.only
        ? "입고 라벨과 일치하는 미송 대상이 없습니다."
        : state.shortageSearchText.trim()
          ? "검색 결과가 없습니다."
          : `${shortageFilterLabel()} 대상이 없습니다.`;
    renderWorkflowEmpty(els.shortageListBody, emptyMessage);
    renderWorkflowEmpty(els.shortageDetail, emptyMessage);
    return;
  }

  if (!rows.some(({ invoice, item }) => workflowItemKey(invoice, item) === state.selectedShortageKey)) {
    state.selectedShortageKey = workflowItemKey(rows[0].invoice, rows[0].item);
  }

  els.shortageListBody.innerHTML = renderShortageRows(rows);

  const selected = rows.find(({ invoice, item }) => workflowItemKey(invoice, item) === state.selectedShortageKey) || rows[0];
  const selectedState = selected.state || workflowItemState(selected.invoice, selected.item);
  const seller = sellerBadgeMeta(selected.invoice.seller);
  const repickDisabled = allowWorkflowEvents ? "" : "disabled";
  const selectedKey = workflowItemKey(selected.invoice, selected.item);
  const selectedCompleted = Boolean(selected.completed);
  const selectedCancelled = Boolean(selected.cancelled || itemIsEffectivelyCancelled(selected.invoice, selected.item));
  const receiving = receivingLabelEntryForItem(selected.item);
  els.shortageDetail.innerHTML = `<div class="workflow-detail-card ${selectedCancelled ? "is-cancelled" : ""}">
    <div class="workflow-detail-head">
      <div>
        <strong>${escapeHtml(selected.item.ownCode || "-")}</strong>
        <span>${escapeHtml(selected.invoice.displayName || selected.invoice.csDisplayName || "-")}</span>
      </div>
      <div class="workflow-detail-actions">
        ${seller ? `<span class="seller-badge ${seller.className}">${escapeHtml(seller.label)}</span>` : ""}
        <span class="workflow-row-badge ${selectedCancelled ? "cancelled" : "warn"}">${selectedCancelled ? "취소된 미송" : "메모입력용"}</span>
      </div>
    </div>
    <div class="workflow-detail-main">
      <div class="workflow-photo">${productImageUrl(selected.item.sellpiaProductCode) ? `<img src="${productImageUrl(selected.item.sellpiaProductCode)}" ${photoImgAttrs(productImageUrl(selected.item.sellpiaProductCode), photoTitleForItem(selected.item), productImageFallbackUrls(selected.item.sellpiaProductCode))} alt="">` : "사진"}</div>
      <div class="workflow-detail-text">
        <h3 class="${optionHasBarChange(selected.item) ? "option-change" : ""}">${escapeHtml(cleanOptionName(selected.item.optionName, selected.item.ownCode) || selected.item.productName || "-")}</h3>
        <p>${escapeHtml(selected.item.productName || "")}</p>
        <dl>
          <div><dt>상품순서</dt><dd>${itemOrderNo(selected.item, invoiceItemIndex(selected.invoice, selected.item))}번</dd></div>
          <div><dt>미송표기</dt><dd>${escapeHtml(shortageInvoiceDisplayLabel(selected.invoice))}</dd></div>
          <div><dt>송장번호</dt><dd>${escapeHtml(selected.invoice.invoiceNo || "-")}</dd></div>
          <div><dt>부족수량</dt><dd class="shortage-qty-with-order">${shortageQtyInput(selected.invoice, selected.item, selectedCompleted ? previousShortageQuantity(selected.invoice, selected.item) : Number(selectedState?.shortageQty || 0) || 1, "workflow-number-input")}<small>주문 ${Number(selected.item.quantity) || 1}개</small></dd></div>
          ${receiving ? `<div><dt>입고라벨</dt><dd>${escapeHtml(`입고 ${receiving.qty || "-"}개`)}${receiving.optionName ? `<small>${escapeHtml(receiving.optionName)}</small>` : ""}</dd></div>` : ""}
          <div><dt>접수일</dt><dd>${escapeHtml(selected.invoice.receiptDate || "-")}</dd></div>
          <div><dt>마지막 이벤트</dt><dd>${escapeHtml(formatShortDate(selectedState?.lastEventAt))}</dd></div>
        </dl>
        <div class="workflow-memo-editor">
          <label>
            <span>관리메모</span>
            <input data-shortage-field="drawerMemo" value="${escapeHtml(drawerMemoForShortageRow(selected))}" placeholder="서랍번호/CS메모" ${selectedCancelled ? "disabled" : ""}>
          </label>
          <label>
            <span>관리메모2</span>
            <textarea data-shortage-field="memo" rows="2" placeholder="상품별 미송 메모" ${selectedCancelled ? "disabled" : ""}>${escapeHtml(selectedState?.memo || selected.item.sellpiaMemo2 || "")}</textarea>
          </label>
          ${selectedCancelled ? '<small class="workflow-help-text">취소된 미송입니다. CS 탭에서 취소를 해제하면 기존 미송 상태로 복원됩니다.</small>' : selectedCompleted ? '<small class="workflow-help-text">기존 완료 기록입니다. 미송피킹 대기 목록에는 표시되지 않습니다.</small>' : `<div class="workflow-actions-row"><button class="btn" data-action="shortage-memo-save" data-shortage-key="${escapeHtml(selectedKey)}" type="button" ${repickDisabled}>메모 저장</button><button class="btn primary" data-action="shortage-repicked" data-shortage-key="${escapeHtml(selectedKey)}" type="button" ${repickDisabled}>미송피킹완료</button></div>`}
        </div>
      </div>
    </div>
    ${renderShortageInvoiceItems(selected.invoice)}
  </div>`;
}

function manualPendingCsCasesForInspectionItem(invoice, item) {
  const ordNo = sourceOrderGroupNo(invoice, item) || String(invoice?.raw?.ord_no || "").trim();
  const itemNo = String(item?.raw?.item_no || item?.sellpiaItemNo || "").trim();
  const sellpiaOrderItemNo = String(item?.raw?.sellpia_order_item_no || "").trim();
  if (!ordNo || (!itemNo && !sellpiaOrderItemNo)) return [];

  return (state.csCases || []).filter((caseRow) => {
    if (caseRow?.source !== "manual" || caseRow?.status !== "pending") return false;
    if (String(caseRow?.ord_no || "").trim() !== ordNo) return false;
    const caseItemNo = String(caseRow?.item_no || "").trim();
    if (itemNo && caseItemNo) return caseItemNo === itemNo;

    // Legacy cases only: a Sellpia item number must never override a present internal item key.
    return !caseItemNo
      && Boolean(sellpiaOrderItemNo)
      && String(caseRow?.sellpia_order_item_no || "").trim() === sellpiaOrderItemNo;
  });
}

function manualPendingCsCountForInspectionInvoice(invoice) {
  const caseIds = new Set();
  for (const item of invoice?.items || []) {
    for (const caseRow of manualPendingCsCasesForInspectionItem(invoice, item)) {
      caseIds.add(String(caseRow?.id || `${caseRow?.ord_no || ""}::${caseRow?.item_no || caseRow?.sellpia_order_item_no || ""}::${caseRow?.case_type || ""}`));
    }
  }
  return caseIds.size;
}

function shipmentGroupNotice(invoice) {
  const group = invoice?.shipmentGroup;
  if (!group) return "";
  const members = group.members.map((member, index) => (
    `<div class="shipment-member">
      <span class="shipment-source-badge">주문 ${index + 1}</span>
      <span><strong>${escapeHtml(member.displayName || member.orderGroupNo)}</strong><small>${escapeHtml(member.orderGroupNo)} · 상품 ${member.itemCount}종</small></span>
    </div>`
  )).join("");
  return `<section class="shipment-group-notice is-synced">
    <div class="shipment-group-summary">
      <div><strong>합배송 ${group.members.length}주문</strong><span>셀피아 동일 송장 자동 인식</span></div>
    </div>
    <div class="shipment-member-list">${members}</div>
    <p>검품에서는 실제 포장 송장 1건으로 표시합니다. 원주문별 CS와 상품행 메모는 각각의 원주문에 저장됩니다.</p>
  </section>`;
}

function renderInspectionPanels(options = {}) {
  ensureInspectionFilterButtons();
  const renderList = options.list !== false;
  const allInvoices = inspectionSourceInvoices();
  const completedCount = allInvoices.filter((invoice) => workflowInvoiceState(invoice)?.inspected).length;
  const pendingInvoices = state.inspectionHideCompleted
    ? allInvoices.filter((invoice) => !workflowInvoiceState(invoice)?.inspected)
    : allInvoices;
  const invoices = pendingInvoices.filter(invoiceMatchesInspectionFilter).filter(invoiceMatchesInspectionSearch);
  if (els.inspectionListCount) {
    els.inspectionListCount.textContent = `표시 ${invoices.length}건 / 전체 ${allInvoices.length}건 · 완료 ${completedCount}건`;
  }

  els.inspectionFilterBar?.querySelectorAll("[data-inspection-filter]").forEach((button) => {
    button.classList.toggle("active", button.dataset.inspectionFilter === state.inspectionFilter);
  });
  els.inspectionFilterBar?.querySelectorAll("[data-inspection-hide-completed]").forEach((button) => {
    button.classList.toggle("active", state.inspectionHideCompleted);
    button.textContent = state.inspectionHideCompleted ? "완료보기" : "완료제거";
    button.disabled = completedCount === 0;
  });

  if (state.workflowQueueError && !allInvoices.length) {
    renderWorkflowEmpty(els.inspectionListBody, state.workflowQueueError);
    renderWorkflowEmpty(els.inspectionDetail, "이벤트 큐를 불러오지 못했습니다.");
    return;
  }

  if (!state.workflowQueues && !state.viewModel) {
    renderWorkflowEmpty(els.inspectionListBody, "검품 대기 송장을 불러오는 중입니다.");
    renderWorkflowEmpty(els.inspectionDetail, "검품 대기 송장을 선택하면 전체 상품이 표시됩니다.");
    return;
  }

  if (!invoices.length) {
    state.selectedInspectionItemKey = "";
    const emptyText = allInvoices.length ? "현재 필터/검색에 맞는 검품 송장이 없습니다." : "현재 검품 송장이 없습니다.";
    renderWorkflowEmpty(els.inspectionListBody, emptyText);
    renderWorkflowEmpty(els.inspectionDetail, `${emptyText} 완료제거가 켜져 있으면 완료보기로 전환하세요.`);
    return;
  }

  if (!invoices.some((invoice) => invoice.orderGroupNo === state.selectedInspectionGroup)) {
    state.selectedInspectionGroup = invoices[0].orderGroupNo;
  }

  if (renderList) {
    els.inspectionListBody.innerHTML = invoices
      .map((invoice, index) => {
        const orderDateTime = invoiceOrderDateTimeLabel(invoice);
        const itemStates = (invoice.items || []).map((item) => workflowItemState(invoice, item)).filter(Boolean);
        const repicked = itemStates.filter((row) => row.shortageRepicked && !row.inspected && !row.cancelled).length;
        const manualCsCount = manualPendingCsCountForInspectionInvoice(invoice);
        const partialHoldCount = (invoice.items || []).filter((item) => isHold(item)).length;
        const invoiceState = workflowInvoiceState(invoice);
        const completed = Boolean(invoiceState?.inspected);
        const cancelled = Boolean(invoiceState?.cancelled);
        const seller = sellerBadgeMeta(invoice.seller);
        const rowClasses = [
          "workflow-row",
          invoice.orderGroupNo === state.selectedInspectionGroup ? "selected" : "",
          completed ? "is-completed" : "",
          invoiceState?.systemShippingHold ? "is-hold" : "",
          partialHoldCount ? "has-hold" : "",
          repicked ? "has-shortage" : "",
          invoiceHasGold(invoice) ? "is-gold" : "",
          cancelled ? "is-cancelled" : "",
        ]
          .filter(Boolean)
          .join(" ");
        const badges = [
          seller ? `<span class="seller-badge ${seller.className}">${escapeHtml(seller.label)}</span>` : "",
          completed ? '<span class="workflow-row-badge done">완료</span>' : "",
          cancelled ? '<span class="workflow-row-badge cancelled">주문취소</span>' : "",
          invoiceHasGold(invoice) ? '<span class="workflow-row-badge gold">골드</span>' : "",
          shippingHoldBadge(invoice),
          partialHoldCount ? `<span class="workflow-row-badge hold">부분보류 ${partialHoldCount}</span>` : "",
          manualCsCount ? `<span class="workflow-row-badge manual">별도 CS ${manualCsCount}</span>` : "",
          repicked ? `<span class="workflow-row-badge warn">검품 ${repicked}</span>` : "",
        ]
          .filter(Boolean)
          .join("");
        const shipmentGroup = invoice.shipmentGroup;
        const shipmentBadges = shipmentGroup
          ? `<span class="workflow-row-badge shipment">합배송 ${shipmentGroup.members.length}주문</span>`
          : "";
        return `<button class="${rowClasses} ${shipmentGroup ? "is-grouped" : ""}" data-inspection-group="${escapeHtml(invoice.orderGroupNo)}" type="button">
          <span class="workflow-row-code seq-with-slot">
            <strong>${escapeHtml(invoicePrimaryWorkflowLabel(invoice, index))}</strong>
            <small>${escapeHtml(invoiceSecondaryWorkflowLabel(invoice, index))}</small>
          </span>
          <span class="workflow-row-main">
            <strong>${escapeHtml(invoice.displayName || invoice.csDisplayName || "-")}</strong>
            <small>상품 ${invoice.items.length}종 · 접수 ${escapeHtml(invoice.receiptDate || "-")}${orderDateTime ? ` · 주문 ${escapeHtml(orderDateTime)}` : ""}</small>
          </span>
          <span class="workflow-row-badges">${shipmentBadges}${badges}</span>
        </button>`;
      })
      .join("");
  } else {
    els.inspectionListBody?.querySelectorAll("[data-inspection-group]").forEach((button) => {
      button.classList.toggle("selected", button.dataset.inspectionGroup === state.selectedInspectionGroup);
    });
  }

  const selected = invoices.find((invoice) => invoice.orderGroupNo === state.selectedInspectionGroup) || invoices[0];
  const selectedShipmentGroup = selected.shipmentGroup || null;
  const seller = sellerBadgeMeta(selected.seller);
  const invoiceState = workflowInvoiceState(selected);
  const holdState = shippingHoldUiState(selected);
  const selectedCompleted = Boolean(invoiceState?.inspected);
  const selectedCancelled = Boolean(invoiceState?.cancelled);
  const selectableInspectionItemKeys = inspectionSelectableItems(selected).map((item) => itemSlotKey(selected, item));
  if (state.selectedInspectionItemKey && !selectableInspectionItemKeys.includes(state.selectedInspectionItemKey)) {
    state.selectedInspectionItemKey = "";
  }
  const actionDisabled = allowWorkflowEvents && !selectedCancelled ? "" : "disabled";
  const partialHoldActionDisabled = allowWrites && !selectedCancelled ? "" : "disabled";
  const holdAction = holdState.action;
  const holdLabel = holdState.actionLabel;
  const selectedRepicked = (selected.items || []).filter((item) => {
    const itemState = workflowItemState(selected, item);
    return itemState?.shortageRepicked && !itemState?.inspected && !itemState?.cancelled;
  }).length;
  const selectedManualCsCount = manualPendingCsCountForInspectionInvoice(selected);
  const selectedPartialHoldCount = (selected.items || []).filter((item) => isHold(item)).length;
  const selectedIndex = invoices.findIndex((invoice) => invoice.orderGroupNo === selected.orderGroupNo);
  const selectedGold = invoiceHasGold(selected);
  const selectedLabelTarget = invoiceHasLabelTarget(selected);
  const labelNoByItem = selectedLabelTarget ? inspectionLabelNumberMap(selected) : new Map();
  const selectedTotalQty = invoiceTotalQuantity(selected);
  const selectedName = selected.displayName || selected.csDisplayName || "-";
  const selectedOrderDateTime = invoiceOrderDateTimeLabel(selected);
  const holdNotice = holdState.needsAttention
    ? '<div class="workflow-note">관리메모/기존 보류 신호가 있어 배송보류 ON 확인이 필요합니다. 확인 전 업데이터는 배송보류 OFF를 계획하지 않습니다.</div>'
    : '<div class="workflow-note">셀피아 배송보류는 시스템 배송보류 current 값과 업데이터 실행 시 동기화됩니다.</div>';
  els.inspectionDetail.innerHTML = `${shipmentGroupNotice(selected)}<div class="inspection-header-skeleton ${invoiceState?.systemShippingHold ? "is-hold" : ""} ${selectedCompleted ? "is-completed" : ""} ${selectedCancelled ? "is-cancelled" : ""} ${selectedShipmentGroup ? "is-shipment-group" : ""}">
      <div class="inspection-title-block">
        <div class="inspection-title-line">
          <strong>${escapeHtml(invoicePrimaryWorkflowLabel(selected, selectedIndex >= 0 ? selectedIndex : 0))}</strong>
          <span class="inspection-title-name">${escapeHtml(selectedName)}</span>
          <span class="inspection-commerce-summary">
            ${seller ? `<span class="seller-badge inspection-seller-badge ${seller.className}">${escapeHtml(seller.label)}</span>` : ""}
            ${renderInspectionTotalAmountBadge(selected)}
          </span>
        </div>
        <span class="inspection-title-meta">
          <span>접수 ${escapeHtml(selected.receiptDate || "-")}${selectedOrderDateTime ? ` · 주문 ${escapeHtml(selectedOrderDateTime)}` : ""}</span>
        </span>
        <label class="inspection-drawer-box" style="flex-wrap: wrap;">
          <span>서랍번호</span>
          <textarea class="drawer-input inspection-drawer-input" data-inspection-drawer data-order-group="${escapeHtml(selected.orderGroupNo)}" rows="2" placeholder="서랍번호 / 메모">${escapeHtml(invoiceDrawerValue(selected))}</textarea>
        </label>
      </div>
      <div class="inspection-header-controls">
        <button class="btn inspection-hold-action" data-action="${holdAction}" data-inspection-group="${escapeHtml(selected.orderGroupNo)}" type="button" ${actionDisabled}>${holdLabel}</button>
        <div class="inspection-actions">
          <span class="invoice-badge inspection-slot-badge">${escapeHtml(invoiceSecondaryWorkflowLabel(selected, selectedIndex >= 0 ? selectedIndex : 0))}</span>
          ${selectedCompleted ? '<span class="workflow-row-badge done">완료</span>' : ""}
          ${selectedCancelled ? '<span class="workflow-row-badge cancelled">주문취소</span>' : ""}
          ${selectedGold ? '<span class="workflow-row-badge gold">골드</span>' : ""}
          ${selectedShipmentGroup ? `<span class="workflow-row-badge shipment">합배송 ${selectedShipmentGroup.members.length}주문</span>` : ""}
          ${selectedRepicked ? `<span class="workflow-row-badge warn">미송 ${selectedRepicked}</span>` : ""}
          ${selectedManualCsCount ? `<span class="workflow-row-badge manual">별도 CS ${selectedManualCsCount}</span>` : ""}
          ${selectedPartialHoldCount ? `<span class="workflow-row-badge hold">부분보류 ${selectedPartialHoldCount}</span>` : ""}
          ${shippingHoldBadge(selected)}
        </div>
      </div>
    </div>
    ${holdNotice}
    <div class="workflow-item-table inspection-item-table ${selectedLabelTarget ? "has-label-number" : ""}">
      ${renderInspectionItemHeader(selectedLabelTarget, selectedTotalQty)}
      ${invoiceItemsInSellpiaRowOrder(selected)
        .map((item, index) => {
          const itemState = workflowItemState(selected, item);
          const itemSourceOrderGroupNo = sourceOrderGroupNo(selected, item);
          const itemCancelled = itemIsEffectivelyCancelled(selected, item);
          const itemRepicked = Boolean(itemState?.shortageRepicked && !itemState?.cancelled);
          const itemManualCsCount = manualPendingCsCasesForInspectionItem(selected, item).length;
          const itemPartialShippingHold = isHold(item);
          const itemKey = itemSlotKey(selected, item);
          const itemSelectable = inspectionItemIsSelectable(selected, item);
          const rowClass = [
            itemRepicked ? "repicked" : "",
            itemPartialShippingHold ? "has-hold" : "",
            selectedCompleted ? "inspected" : "",
            itemCancelled ? "is-cancelled" : "",
            itemSelectable ? "is-selectable" : "",
            itemSelectable && itemKey === state.selectedInspectionItemKey ? "is-selected" : "",
          ].filter(Boolean).join(" ");
          const imageUrl = productImageUrl(item.sellpiaProductCode);
          const option = cleanOptionName(item.optionName, item.ownCode) || "-";
          const product = item.productName || "-";
          const labelNo = labelNoByItem.get(itemSlotKey(selected, item)) || "-";
          const shortage = workflowAwareShortageQty(itemState, item);
          const statusText = itemCancelled ? (selectedCancelled ? "주문취소" : "상품취소") : selectedCompleted ? "검품완료" : itemRepicked ? "미송피킹 완료" : "전체상품";
          const statusNotes = [itemState?.drawerMemo ? `서랍 ${itemState.drawerMemo}` : "", itemState?.memo ? itemState.memo : ""].filter(Boolean);
          const sellpiaOrderMemo = itemSellpiaOrderMemo(selected, item);
          const inspectionMemo = itemInspectionMemo(item);
          const memoReadonly = allowWrites ? "" : "readonly";
          const memoHint = allowWrites ? "" : ' title="읽기전용입니다. URL에 write=1을 붙여야 저장할 수 있습니다."';
          const itemActionDisabled = allowWorkflowEvents && !itemCancelled ? "" : "disabled";
          const reopenButton =
            itemRepicked && !selectedCompleted
              ? `<button class="workflow-inline-btn danger" data-action="shortage-repick-reopen" data-order-group="${escapeHtml(itemSourceOrderGroupNo)}" data-item-no="${escapeHtml(item.sellpiaItemNo)}" type="button" ${itemActionDisabled}>완료취소</button>`
              : "";
          const partialHoldReleaseButton = itemPartialShippingHold
            ? `<button class="workflow-inline-btn danger" data-action="inspection-partial-hold-release" data-order-group="${escapeHtml(itemSourceOrderGroupNo)}" data-item-no="${escapeHtml(item.sellpiaItemNo)}" type="button" ${partialHoldActionDisabled}>부분보류 해제</button>`
            : "";
          return `<div class="workflow-item-row ${rowClass}" data-inspection-item-key="${escapeHtml(itemKey)}">
            <span class="workflow-seq-cell">${itemSequenceNo(item, index)}</span>
            ${selectedLabelTarget ? `<span class="workflow-label-cell">${escapeHtml(labelNo)}</span>` : ""}
            <div class="workflow-item-photo">${imageUrl ? `<img src="${imageUrl}" ${photoImgAttrs(imageUrl, photoTitleForItem(item), productImageFallbackUrls(item.sellpiaProductCode))} alt="" loading="lazy">` : "사진"}</div>
            <em class="${optionClass(item, "workflow-option-cell")}">${shipmentMemberBadge(item)}${escapeHtml(option)}</em>
            <b>${Number(item.quantity) || 1}</b>
            <strong class="workflow-product-cell">${escapeHtml(product)}</strong>
            <span class="workflow-amount-cell">${escapeHtml(formatAmount(item.itemSalesAmount))}</span>
            <strong class="workflow-code-cell">${escapeHtml(item.ownCode || "-")}</strong>
            <span class="workflow-sellpia-cell">${escapeHtml(item.sellpiaProductCode || "-")}</span>
            ${shortageQtyInput(selected, item, shortage, "workflow-shortage-cell compact")}
            <label class="inspection-memo-cell ${sellpiaOrderMemo ? "has-value" : ""}">
              <textarea data-inspection-memo-field="sellpia-order" data-order-group="${escapeHtml(itemSourceOrderGroupNo)}" data-item-no="${escapeHtml(item.sellpiaItemNo)}" rows="2" placeholder="셀피아 주문메모" ${memoReadonly}${memoHint}>${escapeHtml(sellpiaOrderMemo)}</textarea>
            </label>
            <label class="inspection-memo-cell ${inspectionMemo ? "has-value" : ""}">
              <textarea data-inspection-memo-field="confirm" data-order-group="${escapeHtml(itemSourceOrderGroupNo)}" data-item-no="${escapeHtml(item.sellpiaItemNo)}" rows="2" placeholder="상품 확인메모" ${memoReadonly}${memoHint}>${escapeHtml(inspectionMemo)}</textarea>
            </label>
            <small class="workflow-status-cell">
              <span>${escapeHtml(statusText)}</span>
              ${itemManualCsCount ? `<span class="workflow-row-badge manual">별도 CS</span>` : ""}
              ${itemPartialShippingHold ? '<span class="workflow-row-badge hold">부분보류 ON</span>' : ""}
              ${statusNotes.length ? `<em>${escapeHtml(statusNotes.join(" / "))}</em>` : ""}
              ${reopenButton}
              ${partialHoldReleaseButton}
            </small>
          </div>`;
        })
        .join("")}
    </div>
    ${invoiceState?.memo ? `<div class="workflow-note">${escapeHtml(invoiceState.memo)}</div>` : ""}`;
}

function csRowKey(invoice, item) {
  return workflowItemKey(invoice, item);
}

function csShortageStartEvent(invoice, item) {
  const key = csRowKey(invoice, item);
  return [...(state.workflowQueues?.itemEvents || [])]
    .filter((event) => `${event.order_group_no}::${event.sellpia_item_no}` === key && ["shortage_created", "shortage_qty_changed"].includes(event.event_type))
    .sort((a, b) => workflowEventTime(a) - workflowEventTime(b))[0];
}

function receiptBusinessDaysSinceDateKey(key) {
  const basisDate = dateKey(key);
  if (!basisDate) return 0;
  const cacheKey = `${basisDate}::${todayDateString()}`;
  if (state.csReceiptBusinessDayCache.has(cacheKey)) return state.csReceiptBusinessDayCache.get(cacheKey);
  const elapsed = receiptBusinessDaysSince(basisDate, state.csReceiptBusinessDates, todayDateString());
  state.csReceiptBusinessDayCache.set(cacheKey, elapsed);
  return elapsed;
}

function alimtalkSendLogValueForRow(row) {
  return String(
    row?.alimtalkSendLog
      || row?.order?.sellpia_outbound_scheduled_date
      || row?.invoice?.raw?.sellpia_outbound_scheduled_date
      || "",
  ).trim();
}

function effectiveAlimtalkElapsedDays(row, { basisDate = "", isGold = false } = {}) {
  const fallback = receiptBusinessDaysSinceDateKey(
    basisDate || row?.delayBaseDate || row?.invoice?.receiptDate || row?.order?.receipt_date || row?.item?.receipt_date || "",
  );
  const anchor = alimtalkSendLogAnchor(alimtalkSendLogValueForRow(row), {
    isGold,
    referenceDate: todayDateString(),
  });
  if (!anchor.hasAnchor) return { elapsedDays: fallback, anchor };
  const elapsedSinceAnchor = receiptBusinessDaysSinceDateKey(anchor.dateKey);
  return {
    elapsedDays: Math.max(0, anchor.day - 1 + elapsedSinceAnchor),
    selectedTemplate: elapsedSinceAnchor === 0 ? anchor.templateKey : "",
    anchor,
  };
}

function isValidDateKey(key) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(key || ""))) return false;
  return !Number.isNaN(new Date(`${key}T00:00:00`).getTime());
}

function csBasisDateText(row, value) {
  const key = dateKey(value);
  if (!isValidDateKey(key)) return "- (영업일 기준 -일차)";
  const weekday = new Intl.DateTimeFormat("ko-KR", { weekday: "long" }).format(new Date(`${key}T12:00:00`));
  const businessDay = Number(csAlimtalkTemplateRule(row, key).elapsedDays || 0) + 1;
  const [year, month, day] = key.split("-");
  return `${year.slice(-2)}/${month}/${day}/${weekday} (영업일 기준 ${businessDay}일차)`;
}

function csMethodText(invoice, item) {
  return firstRawText(
    invoice?.raw,
    "method",
    "delay_method",
    "long_delay_method",
    "cs_method",
    "process_method",
    "처리방법",
    "장기지연처리방법",
  ) || firstRawText(item?.raw, "method", "delay_method", "long_delay_method", "cs_method", "process_method", "처리방법", "장기지연처리방법");
}

function isCsMakeshopMethod(row) {
  const method = String(row.csMethod || "").trim();
  if (method) return true;
  return sellerBadgeMeta(row.invoice.seller)?.className === "seller-makeshop";
}

function csDayKeyForTemplate(templateKey) {
  return CS_DAYS.find((day) => CS_DAY_TEMPLATE[day.key] === templateKey)?.key || "";
}

function alimtalkRuleForRow(row, { selectedTemplate = "" } = {}) {
  const effective = effectiveAlimtalkElapsedDays(row, { isGold: isGoldItem(row?.item) });
  return resolveAlimtalkTemplate({
    elapsedDays: effective.elapsedDays,
    isGold: isGoldItem(row?.item),
    isTomorrowShipping: hasTomorrowShippingManagementMemo(invoiceDrawerValue(row?.invoice)),
    isMakeshop: isCsMakeshopMethod(row),
    selectedTemplate: effective.anchor.hasAnchor ? effective.selectedTemplate : selectedTemplate,
  });
}

function classifyCsRowsByDay(rows) {
  const groups = Object.fromEntries(CS_DAYS.filter((day) => day.key !== "all").map((day) => [day.key, []]));
  rows.forEach((row) => {
    const pushTemplate = (templateKey) => {
      const dayKey = csDayKeyForTemplate(templateKey);
      if (dayKey) groups[dayKey]?.push({ ...row, csDayKey: dayKey });
    };
    const rule = alimtalkRuleForRow(row);
    if (rule.templateKey) pushTemplate(rule.templateKey);
  });
  return groups;
}

function csDayLabel(key) {
  return CS_DAYS.find((day) => day.key === key)?.label || key || "전체";
}

function defaultCsDayKey(row) {
  const byDay = classifyCsRowsByDay([row]);
  return CS_DAYS.find((day) => day.key !== "all" && byDay[day.key]?.length)?.key || "";
}

function recommendedCsTemplateKey(row) {
  return alimtalkRuleForRow(row).templateKey;
}

function buildCsMessage(row) {
  const option = cleanOptionName(row.item.optionName, row.item.ownCode) || row.item.productName || "-";
  const product = row.item.productName || row.item.ownCode || "-";
  const preset = CS_TEMPLATE_PRESETS[recommendedCsTemplateKey(row)];
  if (!preset) return "";
  return preset.text
    .replace(/#{SHOPNAME}/g, "핑크로켓")
    .replace(/#{NAME}/g, row.invoice.displayName || row.invoice.csDisplayName || row.invoice.recipientName || "고객")
    .replace(/#{PRODUCT}\(#{OPTION}\)/g, `${product}(${option})`)
    .replace(/#{PRODUCT}/g, product)
    .replace(/#{OPTION}/g, option);
}

function legacyAllCsRows() {
  const invoices = state.workflowQueues?.viewModel?.invoices || state.viewModel?.invoices || [];
  const rows = [];
  for (const invoice of invoices) {
    const invoiceState = workflowInvoiceState(invoice);
    if (invoiceState?.inspected || invoiceState?.cancelled) continue;
    const invoiceNeedsCs = Boolean(invoiceState?.hold || invoiceState?.csPending);
    let invoiceRowCount = 0;
    for (const item of invoice.items || []) {
      const itemState = workflowItemState(invoice, item);
      const qty = workflowAwareShortageQty(itemState, item);
      const started = csShortageStartEvent(invoice, item);
      if (!started && qty <= 0 && !itemState?.shortageRepicked) continue;
      const date = dateKey(invoice.receiptDate);
      invoiceRowCount += 1;
      rows.push({
        key: csRowKey(invoice, item),
        invoice,
        item,
        state: itemState,
        shortageQty: qty || previousShortageQuantity(invoice, item) || 1,
        currentShortageQty: qty,
        shortageDate: date,
        elapsedDays: receiptBusinessDaysSinceDateKey(date),
        csMethod: csMethodText(invoice, item),
        csReason: invoiceNeedsCs ? "hold" : "shortage",
      });
    }
    if (invoiceNeedsCs && invoiceRowCount === 0) {
      const item = invoice.items?.[0];
      if (!item) continue;
      const key = `${invoice.orderGroupNo || invoice.invoiceNo || "invoice"}::hold`;
      const date = dateKey(invoice.receiptDate);
      rows.push({
        key,
        invoice,
        item,
        state: null,
        shortageQty: 0,
        currentShortageQty: 0,
        shortageDate: date,
        elapsedDays: receiptBusinessDaysSinceDateKey(date),
        csMethod: csMethodText(invoice, item),
        csReason: "hold",
      });
    }
  }
  const byDay = classifyCsRowsByDay(rows);
  const defaultDayByKey = new Map();
  CS_DAYS.filter((day) => day.key !== "all").forEach((day) => {
    (byDay[day.key] || []).forEach((row) => {
      if (!defaultDayByKey.has(row.key)) defaultDayByKey.set(row.key, day.key);
    });
  });
  return rows
    .map((row) => ({ ...row, csDayKey: defaultDayByKey.get(row.key) || defaultCsDayKey(row) }))
    .sort((a, b) => String(b.shortageDate).localeCompare(String(a.shortageDate)) || visibleInvoiceSequenceNo(a.invoice) - visibleInvoiceSequenceNo(b.invoice));
}

function legacyFilteredCsRows() {
  const search = state.csSearchText.trim().toLowerCase();
  const allRows = allCsRows();
  const byDay = classifyCsRowsByDay(allRows);
  const sourceRows = state.csDateFilter === "all" ? allRows : byDay[state.csDateFilter] || [];
  return sourceRows.filter((row) => {
    if (!search) return true;
    return [
      row.invoice.invoiceNo,
      visibleInvoiceSequenceLabel(row.invoice),
      row.invoice.displayName,
      row.invoice.csDisplayName,
      row.invoice.recipientName,
      row.item.ownCode,
      row.item.sellpiaProductCode,
      row.item.productName,
      row.item.optionName,
      invoiceDrawerValue(row.invoice),
    ]
      .join(" ")
      .toLowerCase()
      .includes(search);
  });
}

function legacyRenderCsPanels() {
  if (els.csSearchInput && els.csSearchInput.value !== state.csSearchText) els.csSearchInput.value = state.csSearchText;
  if (state.workflowQueueError) {
    renderWorkflowEmpty(els.csListBody, state.workflowQueueError);
    renderWorkflowEmpty(els.csDetail, "CS 대상 데이터를 불러오지 못했습니다.");
    return;
  }
  if (!state.workflowQueues && !state.viewModel) {
    renderWorkflowEmpty(els.csListBody, "미송 데이터를 불러오는 중입니다.");
    renderWorkflowEmpty(els.csDetail, "연락 대상을 선택하면 템플릿을 표시합니다.");
    return;
  }

  const allRows = allCsRows();
  const byDay = classifyCsRowsByDay(allRows);
  if (state.csDateFilter !== "all" && !CS_DAYS.some((day) => day.key === state.csDateFilter)) state.csDateFilter = "all";
  const dayButtons = CS_DAYS.map((day) => [day.key, `${day.label} ${day.key === "all" ? allRows.length : byDay[day.key]?.length || 0}`]);
  if (els.csDateTabs) {
    els.csDateTabs.innerHTML = dayButtons
      .map(([value, label]) => `<button class="filter-chip ${state.csDateFilter === value ? "active" : ""}" data-cs-date="${escapeHtml(value)}" type="button">${escapeHtml(label)}</button>`)
      .join("");
  }
  const rows = filteredCsRows();
  if (els.csListCount) els.csListCount.textContent = `${rows.length}건 / 전체 ${allRows.length}건`;
  if (!rows.length) {
    renderWorkflowEmpty(els.csListBody, "현재 조건에 맞는 CS 대상이 없습니다.");
    renderWorkflowEmpty(els.csDetail, "일차/상태 필터를 조정해보세요.");
    return;
  }
  if (!rows.some((row) => row.key === state.selectedCsKey)) state.selectedCsKey = rows[0].key;
  els.csListBody.innerHTML = rows
    .map((row) => {
      const selected = row.key === state.selectedCsKey;
      const seller = sellerBadgeMeta(row.invoice.seller);
      const option = cleanOptionName(row.item.optionName, row.item.ownCode) || row.item.productName || "-";
      const holdBadge = row.csReason === "hold" ? '<span class="workflow-row-badge hold">보류</span>' : "";
      return `<button class="workflow-row ${selected ? "selected" : ""}" data-cs-key="${escapeHtml(row.key)}" type="button">
        <span class="workflow-row-code seq-with-slot">
          <strong>${escapeHtml(visibleInvoiceSequenceLabel(row.invoice))}</strong>
          <small>${escapeHtml(csDayLabel(row.csDayKey || defaultCsDayKey(row)))}</small>
        </span>
        <span class="workflow-row-main">
          <strong>${escapeHtml(row.invoice.displayName || row.invoice.csDisplayName || "-")}</strong>
          <small>${escapeHtml(row.item.ownCode || "-")} · ${escapeHtml(option)} · 미송 ${row.shortageQty}</small>
          <small>${escapeHtml(row.shortageDate)} · ${row.elapsedDays}일 경과 · 서랍 ${escapeHtml(invoiceDrawerValue(row.invoice) || "-")}</small>
        </span>
        <span class="workflow-row-badges">
          ${seller ? `<span class="seller-badge ${seller.className}">${escapeHtml(seller.label)}</span>` : ""}
          ${holdBadge}
          <span class="workflow-row-badge danger">CS필요</span>
        </span>
      </button>`;
    })
    .join("");

  const selected = rows.find((row) => row.key === state.selectedCsKey) || rows[0];
  const option = cleanOptionName(selected.item.optionName, selected.item.ownCode) || selected.item.productName || "-";
  const orderMemo = itemSellpiaOrderMemo(selected.invoice, selected.item);
  const readonlyHint = allowWrites ? "" : "readonly title=\"URL에 write=1을 붙여야 저장할 수 있습니다.\"";
  els.csDetail.innerHTML = `<div class="cs-detail-card">
    <div class="workflow-detail-head">
      <div>
        <strong>${escapeHtml(selected.invoice.displayName || selected.invoice.csDisplayName || "-")}</strong>
        <span>${escapeHtml(csDayLabel(selected.csDayKey || defaultCsDayKey(selected)))} · ${escapeHtml(selected.shortageDate)} · ${selected.elapsedDays}일 경과 · 미송 ${selected.shortageQty}</span>
      </div>
      <div class="workflow-detail-actions">
        <span class="invoice-badge">주문메모</span>
        ${selected.csReason === "hold" ? '<span class="workflow-row-badge hold">보류</span>' : ""}
      </div>
    </div>
    <div class="cs-product-line">
      <strong>${escapeHtml(selected.item.ownCode || "-")}</strong>
      <span class="${optionHasBarChange(selected.item) ? "option-change" : ""}">${escapeHtml(option)}</span>
      <small>송장 ${escapeHtml(selected.invoice.invoiceNo || "-")} · ${escapeHtml(invoiceSequenceWithGroupLabel(selected.invoice))}</small>
    </div>
    <div class="cs-memo-editor">
      <label>
        <span>셀피아 주문메모</span>
        <textarea data-cs-order-memo data-order-group="${escapeHtml(selected.invoice.orderGroupNo)}" data-item-no="${escapeHtml(selected.item.sellpiaItemNo)}" rows="8" placeholder="주문메모" ${readonlyHint}>${escapeHtml(orderMemo)}</textarea>
      </label>
      <button class="btn primary" data-cs-order-memo-save data-order-group="${escapeHtml(selected.invoice.orderGroupNo)}" data-item-no="${escapeHtml(selected.item.sellpiaItemNo)}" type="button">주문메모 저장</button>
    </div>
  </div>`;
}

function csSourceInvoices() {
  return sortInspectionInvoices(
    mergeInvoicesUnique(
      state.viewModel?.invoices || [],
      state.workflowQueues?.viewModel?.invoices || [],
      state.workflowQueues?.inspectionInvoices || [],
      state.workflowQueues?.inspectionCompletedInvoices || [],
    ).filter(isInspectionVisibleBaseInvoice),
  );
}

function allCsRows() {
  return csSourceInvoices().map((invoice, index) => ({
    key: invoice.orderGroupNo || invoice.invoiceNo || `cs-${index}`,
    invoice,
    index,
  }));
}

function filteredCsRows() {
  const search = state.csSearchText.trim().toLowerCase();
  return allCsRows().filter((row) => {
    if (!search) return true;
    return `${invoiceTextForSearch(row.invoice)} ${invoiceDrawerValue(row.invoice)}`.toLowerCase().includes(search);
  });
}

function renderLegacyCsInvoicePanels() {
  if (els.csSearchInput && els.csSearchInput.value !== state.csSearchText) els.csSearchInput.value = state.csSearchText;
  if (state.workflowQueueError) {
    renderWorkflowEmpty(els.csListBody, state.workflowQueueError);
    renderWorkflowEmpty(els.csDetail, "CS 데이터를 불러오지 못했습니다.");
    return;
  }
  if (!state.workflowQueues && !state.viewModel) {
    renderWorkflowEmpty(els.csListBody, "데이터를 불러오는 중입니다.");
    renderWorkflowEmpty(els.csDetail, "송장을 선택하면 메모를 수정할 수 있습니다.");
    return;
  }

  state.csDateFilter = "all";
  const allRows = allCsRows();
  if (els.csDateTabs) {
    els.csDateTabs.innerHTML = `<button class="filter-chip active" data-cs-date="all" type="button">전체 ${allRows.length}</button>`;
  }
  const rows = filteredCsRows();
  if (els.csListCount) els.csListCount.textContent = `${rows.length}건 / 전체 ${allRows.length}건`;
  if (!rows.length) {
    renderWorkflowEmpty(els.csListBody, "현재 조건에 맞는 송장이 없습니다.");
    renderWorkflowEmpty(els.csDetail, "검색어를 조정해보세요.");
    return;
  }

  if (!rows.some((row) => row.key === state.selectedCsKey)) state.selectedCsKey = rows[0].key;
  els.csListBody.innerHTML = rows
    .map((row) => {
      const { invoice } = row;
      const selected = row.key === state.selectedCsKey;
      const seller = sellerBadgeMeta(invoice.seller);
      const invoiceState = workflowInvoiceState(invoice);
      const shortageCount = invoiceItemsInSellpiaRowOrder(invoice).reduce((sum, item) => sum + workflowAwareShortageQty(workflowItemState(invoice, item), item), 0);
      return `<button class="workflow-row ${selected ? "selected" : ""}" data-cs-key="${escapeHtml(row.key)}" type="button">
        <span class="workflow-row-code seq-with-slot">
          <strong>${escapeHtml(invoicePrimaryWorkflowLabel(invoice, row.index))}</strong>
          <small>${escapeHtml(invoiceSecondaryWorkflowLabel(invoice, row.index))}</small>
        </span>
        <span class="workflow-row-main">
          <strong>${escapeHtml(invoice.displayName || invoice.csDisplayName || "-")}</strong>
          <small>상품 ${invoice.items?.length || 0}종 · 접수 ${escapeHtml(invoice.receiptDate || "-")}</small>
          <small>관리메모 ${escapeHtml(invoiceDrawerValue(invoice) || "-")} · 관리메모2 ${shortageCount}</small>
        </span>
        <span class="workflow-row-badges">
          ${seller ? `<span class="seller-badge ${seller.className}">${escapeHtml(seller.label)}</span>` : ""}
          ${invoiceState?.hold ? '<span class="workflow-row-badge hold">보류</span>' : ""}
          ${invoiceState?.inspected ? '<span class="workflow-row-badge done">완료</span>' : ""}
          ${shortageCount ? `<span class="workflow-row-badge danger">부족 ${shortageCount}</span>` : ""}
        </span>
      </button>`;
    })
    .join("");

  const selected = rows.find((row) => row.key === state.selectedCsKey) || rows[0];
  const invoice = selected.invoice;
  const seller = sellerBadgeMeta(invoice.seller);
  const invoiceState = workflowInvoiceState(invoice);
  const readonlyHint = allowWrites ? "" : "readonly title=\"URL에 write=1이 없으면 저장할 수 없습니다.\"";
  const memoReadonly = allowWrites ? "" : "readonly";
  const memoHint = allowWrites ? "" : ' title="URL에 write=1이 없으면 저장할 수 없습니다."';
  const selectedIndex = rows.findIndex((row) => row.key === selected.key);
  els.csDetail.innerHTML = `<div class="inspection-header-skeleton ${invoiceState?.hold ? "is-hold" : ""} ${invoiceState?.inspected ? "is-completed" : ""}">
      <div class="inspection-title-block">
        <div class="inspection-title-line">
          <strong>${escapeHtml(invoicePrimaryWorkflowLabel(invoice, selectedIndex >= 0 ? selectedIndex : 0))}</strong>
          <span class="inspection-title-name">${escapeHtml(invoice.displayName || invoice.csDisplayName || "-")}</span>
          ${seller ? `<span class="seller-badge ${seller.className}">${escapeHtml(seller.label)}</span>` : ""}
        </div>
        <span class="inspection-title-meta">
          <span>접수 ${escapeHtml(invoice.receiptDate || "-")} · 송장 ${escapeHtml(invoice.invoiceNo || "-")}</span>
        </span>
        <label class="inspection-drawer-box">
          <span>관리메모</span>
          <textarea class="drawer-input inspection-drawer-input" data-cs-drawer data-order-group="${escapeHtml(invoice.orderGroupNo)}" rows="2" placeholder="서랍번호 / 메모" ${readonlyHint}>${escapeHtml(invoiceDrawerValue(invoice))}</textarea>
        </label>
      </div>
      <div class="inspection-actions">
        <span class="invoice-badge inspection-slot-badge">${escapeHtml(invoiceSecondaryWorkflowLabel(invoice, selectedIndex >= 0 ? selectedIndex : 0))}</span>
        ${invoiceState?.hold ? '<span class="workflow-row-badge hold">보류</span>' : ""}
        ${invoiceState?.inspected ? '<span class="workflow-row-badge done">완료</span>' : ""}
        ${invoiceHasGold(invoice) ? '<span class="workflow-row-badge gold">골드</span>' : ""}
      </div>
    </div>
    <div class="workflow-item-table inspection-item-table">
      <div class="workflow-item-row workflow-item-header">
        <span>상품순서번호</span>
        <span>사진</span>
        <span>옵션명</span>
        <span>수량</span>
        <span>상품명</span>
        <span>금액</span>
        <span>자사코드</span>
        <span>셀피아코드</span>
        <span>관리메모2</span>
        <span>주문메모</span>
        <span>상태</span>
      </div>
      ${invoiceItemsInSellpiaRowOrder(invoice)
        .map((item, index) => {
          const itemState = workflowItemState(invoice, item);
          const imageUrl = productImageUrl(item.sellpiaProductCode);
          const option = cleanOptionName(item.optionName, item.ownCode) || "-";
          const product = item.productName || "-";
          const shortage = workflowAwareShortageQty(itemState, item);
          const sellpiaOrderMemo = itemSellpiaOrderMemo(invoice, item);
          return `<div class="workflow-item-row">
            <span class="workflow-seq-cell">${itemSequenceNo(item, index)}</span>
            <div class="workflow-item-photo">${imageUrl ? `<img src="${imageUrl}" ${photoImgAttrs(imageUrl, photoTitleForItem(item), productImageFallbackUrls(item.sellpiaProductCode))} alt="" loading="lazy">` : "사진"}</div>
            <em class="${optionClass(item, "workflow-option-cell")}">${escapeHtml(option)}</em>
            <b>${Number(item.quantity) || 1}</b>
            <strong class="workflow-product-cell">${escapeHtml(product)}</strong>
            <span class="workflow-amount-cell">${escapeHtml(formatAmount(item.itemSalesAmount))}</span>
            <strong class="workflow-code-cell">${escapeHtml(item.ownCode || "-")}</strong>
            <span class="workflow-sellpia-cell">${escapeHtml(item.sellpiaProductCode || "-")}</span>
            ${shortageQtyInput(invoice, item, shortage, "workflow-shortage-cell compact")}
            <label class="inspection-memo-cell ${sellpiaOrderMemo ? "has-value" : ""}">
              <textarea data-cs-order-memo data-order-group="${escapeHtml(invoice.orderGroupNo)}" data-item-no="${escapeHtml(item.sellpiaItemNo)}" rows="2" placeholder="셀피아 주문메모" ${memoReadonly}${memoHint}>${escapeHtml(sellpiaOrderMemo)}</textarea>
            </label>
            <small class="workflow-status-cell">
              <span>${invoiceState?.inspected ? "검품완료" : itemState?.shortageRepicked ? "미송피킹" : "작업중"}</span>
            </small>
          </div>`;
        })
        .join("")}
    </div>`;
}

function renderCsPanels() {
  renderCsCasePanels();
}

function renderCompletedPanels() {
  const invoices = completedInvoicesForSelectedDate();
  const allCompleted = state.workflowQueues?.inspectionCompletedInvoices || [];
  const modeLabel = state.completedDateMode === "completed" ? "완료일" : "접수일";
  if (els.completedListCount) els.completedListCount.textContent = `${modeLabel} ${invoices.length}건 / 전체 ${allCompleted.length}건`;

  document.querySelectorAll("[data-completed-date-mode]").forEach((button) => {
    button.classList.toggle("active", button.dataset.completedDateMode === state.completedDateMode);
  });

  if (state.workflowQueueError) {
    renderWorkflowEmpty(els.completedListBody, state.workflowQueueError);
    renderWorkflowEmpty(els.completedDetail, "작업완료 큐를 불러오지 못했습니다.");
    return;
  }

  if (!state.workflowQueues) {
    renderWorkflowEmpty(els.completedListBody, "작업완료 송장을 불러오는 중입니다.");
    renderWorkflowEmpty(els.completedDetail, "완료된 송장을 선택하면 전체 상품이 표시됩니다.");
    return;
  }

  if (!invoices.length) {
    renderWorkflowEmpty(els.completedListBody, `${state.selectedDate} 기준 작업완료 송장이 없습니다.`);
    renderWorkflowEmpty(els.completedDetail, "선택한 날짜 기준 작업완료 송장이 없습니다.");
    return;
  }

  if (!invoices.some((invoice) => invoice.orderGroupNo === state.selectedCompletedGroup)) {
    state.selectedCompletedGroup = invoices[0].orderGroupNo;
  }

  els.completedListBody.innerHTML = invoices
    .map((invoice) => {
      const invoiceState = workflowInvoiceState(invoice);
      const completedEvent = completedEventForInvoice(invoice);
      const completedAt = completedEvent?.event_at || completedEvent?.created_at || invoiceState?.lastEventAt;
      return `<button class="workflow-row ${invoice.orderGroupNo === state.selectedCompletedGroup ? "selected" : ""}" data-completed-group="${escapeHtml(invoice.orderGroupNo)}" type="button">
        <span class="workflow-row-code seq-with-slot">
          <strong>${escapeHtml(visibleInvoiceSequenceLabel(invoice))}</strong>
          <small>${escapeHtml(invoiceGroupSlotLabel(invoice))}</small>
        </span>
        <span class="workflow-row-main">
          <strong>${escapeHtml(invoice.displayName || invoice.csDisplayName || "-")}</strong>
          <small>접수 ${escapeHtml(invoice.receiptDate || "-")} · 완료 ${escapeHtml(formatShortDate(completedAt))} · 상품 ${invoice.items.length}종</small>
        </span>
        <span class="workflow-row-badge done">완료</span>
      </button>`;
    })
    .join("");

  const selected = invoices.find((invoice) => invoice.orderGroupNo === state.selectedCompletedGroup) || invoices[0];
  const seller = sellerBadgeMeta(selected.seller);
  const invoiceState = workflowInvoiceState(selected);
  const completedEvent = completedEventForInvoice(selected);
  const completedAt = completedEvent?.event_at || completedEvent?.created_at || invoiceState?.lastEventAt;
  const actionDisabled = allowWorkflowEvents ? "" : "disabled";
  els.completedDetail.innerHTML = `<div class="inspection-header-skeleton is-completed">
      <div class="inspection-title-block">
        <div class="inspection-title-line">
          <strong>${escapeHtml(invoiceSequenceWithGroupLabel(selected))}</strong>
          <span class="inspection-title-name">${escapeHtml(selected.displayName || selected.csDisplayName || "-")}</span>
          ${seller ? `<span class="seller-badge ${seller.className}">${escapeHtml(seller.label)}</span>` : ""}
        </div>
        <span class="inspection-title-meta">
          <span>접수 ${escapeHtml(selected.receiptDate || "-")} · 완료 ${escapeHtml(formatShortDate(completedAt))}</span>
        </span>
      </div>
      <div class="inspection-actions">
        <button class="btn primary" data-action="inspection-reopen" data-completed-group="${escapeHtml(selected.orderGroupNo)}" type="button" ${actionDisabled}>완료 취소</button>
      </div>
    </div>
    <div class="workflow-item-table">
      ${invoiceItemsInSellpiaRowOrder(selected)
        .map((item, index) => {
          const itemState = workflowItemState(selected, item);
          const rowClass = itemState?.shortageRepicked ? "repicked" : "";
          const imageUrl = productImageUrl(item.sellpiaProductCode);
          return `<div class="workflow-item-row ${rowClass}">
            <span>${index + 1}</span>
            <div class="workflow-item-photo">${imageUrl ? `<img src="${imageUrl}" ${photoImgAttrs(imageUrl, photoTitleForItem(item), productImageFallbackUrls(item.sellpiaProductCode))} alt="" loading="lazy">` : "사진"}</div>
            <strong>${escapeHtml(item.ownCode || "-")}</strong>
            <em class="${optionHasBarChange(item) ? "option-change" : ""}">${escapeHtml(cleanOptionName(item.optionName, item.ownCode) || item.productName || "-")}</em>
            <b>${Number(item.quantity) || 1}개</b>
            ${rowClass ? '<small>미송피킹 완료</small>' : "<small>전체상품</small>"}
          </div>`;
        })
        .join("")}
    </div>
    ${invoiceState?.memo ? `<div class="workflow-note">${escapeHtml(invoiceState.memo)}</div>` : ""}`;
}

function operationForPickingItem(item) {
  const match = findOperationForCurrentItem(item, state.orderItemOperations);
  return match.status === "matched" ? match.row : null;
}

function operationStatusMeta(operation, item = null) {
  const inbound = resolveEffectiveInboundExpectedDate({
    operation,
    currentItem: item,
    skuSchedule: findSkuInboundSchedule(item, state.customOrders.skuSchedules),
  });
  const status = customOrderStatus(operation || {}, inbound);
  return {
    status,
    label: CUSTOM_ORDER_STATUS_LABEL[status] || (String(operation?.internal_memo || "").trim() ? "메모" : ""),
  };
}

function renderPickingCustomOrderControls(invoice, item, { compact = false } = {}) {
  const operation = operationForPickingItem(item);
  const required = Boolean(String(operation?.custom_required_at || "").trim());
  const meta = operationStatusMeta(operation, item);
  const memo = String(operation?.internal_memo || "");
  const identityAttrs = `data-order-group="${escapeHtml(invoice.orderGroupNo)}" data-item-no="${escapeHtml(item.sellpiaItemNo)}"`;
  return `<div class="picking-custom-order ${compact ? "compact" : ""}">
    <label class="custom-order-check">
      <input type="checkbox" data-action="custom-order-toggle" ${identityAttrs} ${required ? "checked" : ""}>
      <span>주문제작 필요</span>
    </label>
    <div class="custom-order-memo-inline">
      <input data-action="custom-order-memo-input" ${identityAttrs} value="${escapeHtml(memo)}" maxlength="500" placeholder="내부 메모">
      <button class="btn mini" data-action="custom-order-memo-save" ${identityAttrs} type="button">저장</button>
    </div>
    ${meta.label ? `<span class="custom-order-status status-${escapeHtml(meta.status || "memo")}">${escapeHtml(meta.label)}</span>` : ""}
  </div>`;
}

function renderPickingRow(invoice, item, invoiceIndex = 0, itemIndex = 0) {
  const shortage = shortageQty(item);
  const checked = isPicked(item);
  const imageUrl = productImageUrl(item.sellpiaProductCode);
  const option = cleanOptionName(item.optionName, item.ownCode) || item.productName || "-";
  const product = item.productName || "";
  const goldItem = isGoldItem(item);
  const goldInvoice = invoiceHasGold(invoice);
  const slotKey = itemSlotKey(invoice, item);
  const classes = [
    "picking-item-card",
    checked ? "is-picked" : "",
    shortage ? "has-shortage" : "",
    isHold(item) ? "has-hold" : "",
    goldItem ? "is-gold" : "",
    slotKey === state.currentTrayKey ? "is-selected" : "",
    itemIsEffectivelyCancelled(invoice, item) ? "is-cancelled" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const drawerValue = invoiceDrawerValue(invoice);
  const seller = sellerBadgeMeta(invoice.seller);

  return `<article class="${classes}" data-order-group="${escapeHtml(invoice.orderGroupNo)}" data-item-no="${escapeHtml(item.sellpiaItemNo)}" data-slot-key="${escapeHtml(slotKey)}">
    <div class="thumb-wrap">
      <button class="pick-check ${checked ? "checked" : ""}" data-action="toggle" data-order-group="${escapeHtml(invoice.orderGroupNo)}" data-item-no="${escapeHtml(item.sellpiaItemNo)}" ${itemIsEffectivelyCancelled(invoice, item) ? "disabled" : ""}>${checked ? "✓" : ""}</button>
      ${imageUrl ? `<img class="thumb" src="${imageUrl}" ${photoImgAttrs(imageUrl, photoTitleForItem(item), productImageFallbackUrls(item.sellpiaProductCode))} alt="" loading="lazy">` : '<div class="thumb"></div>'}
    </div>
    <div class="picking-body">
      <div class="picking-main">
        <div class="picking-title-line">
          <span class="work-no own-code-display">${escapeHtml(item.ownCode || "-")}</span>
          ${goldItem ? '<span class="gold-badge">골드</span>' : goldInvoice ? '<span class="gold-badge soft">골드송장</span>' : ""}
          ${item.sellpiaLocation ? `<span class="small-badge">${escapeHtml(item.sellpiaLocation)}</span>` : ""}
          ${itemIsEffectivelyCancelled(invoice, item) ? '<span class="workflow-row-badge cancelled">취소</span>' : ""}
        </div>
        <p class="${optionClass(item)}">${escapeHtml(option)}</p>
        <p class="product">${escapeHtml(product)}</p>
        <div class="invoice-meta">
          <span>${escapeHtml(invoice.displayName || invoice.csDisplayName || "-")}</span>
          <span>${escapeHtml(invoiceSequenceWithGroupLabel(invoice))}</span>
          ${seller ? `<span class="seller-badge ${seller.className}">${escapeHtml(seller.label)}</span>` : ""}
        </div>
        ${renderPickingCustomOrderControls(invoice, item)}
      </div>
      <div class="picking-controls">
        <div class="qty-tile">${Number(item.quantity) || 1}개</div>
        ${renderInvoiceSlots(invoiceIndex, item, itemIndex)}
        <div class="shortage-control">
          <button data-action="shortage" data-delta="-1" data-order-group="${escapeHtml(invoice.orderGroupNo)}" data-item-no="${escapeHtml(item.sellpiaItemNo)}" ${itemIsEffectivelyCancelled(invoice, item) ? "disabled" : ""}>−</button>
          ${shortageQtyInput(invoice, item, shortage)}
          <button data-action="shortage" data-delta="1" data-order-group="${escapeHtml(invoice.orderGroupNo)}" data-item-no="${escapeHtml(item.sellpiaItemNo)}" ${itemIsEffectivelyCancelled(invoice, item) ? "disabled" : ""}>+</button>
        </div>
        <div class="drawer-box">
          <label>서랍</label>
          <textarea class="drawer-input" inputmode="none" data-action="drawer" data-order-group="${escapeHtml(invoice.orderGroupNo)}" rows="2" placeholder="서랍번호" readonly>${escapeHtml(drawerValue)}</textarea>
        </div>
      </div>
    </div>
  </article>`;
}

function renderShell() {
  document.querySelectorAll("[data-app-tab]").forEach((button) => {
    button.classList.toggle("active", button.dataset.appTab === state.activeTab);
  });
  els.mainGrid?.classList.toggle("sidebar-collapsed", state.sidebarCollapsed);
  els.sidebar?.classList.toggle("collapsed", state.sidebarCollapsed);
  if (els.sidebarToggle) {
    els.sidebarToggle.textContent = state.sidebarCollapsed ? "▶" : "◀";
    els.sidebarToggle.title = state.sidebarCollapsed ? "사이드바 펼치기" : "사이드바 접기";
    els.sidebarToggle.setAttribute("aria-expanded", String(!state.sidebarCollapsed));
  }
  if (els.pickingPanel) els.pickingPanel.hidden = state.activeTab !== "picking";
  if (els.dashboardPanel) els.dashboardPanel.hidden = state.activeTab !== "dashboard";
  if (els.shortagePanel) els.shortagePanel.hidden = state.activeTab !== "shortage";
  if (els.inspectionPanel) els.inspectionPanel.hidden = state.activeTab !== "inspection";
  if (els.csPanel) els.csPanel.hidden = state.activeTab !== "cs";
  if (els.customOrdersPanel) els.customOrdersPanel.hidden = state.activeTab !== "custom-orders";
  if (els.completedPanel) els.completedPanel.hidden = state.activeTab !== "completed";
  renderSideShortcuts();
}

function renderActivePanel(options = {}) {
  if (options.metrics !== false) renderMetrics();
  if (state.activeTab === "dashboard") {
    renderDashboard();
    return;
  }
  if (state.activeTab === "picking") {
    renderFilters();
    renderGroups();
    renderOrderList();
    renderTray();
    return;
  }
  if (state.activeTab === "shortage") {
    renderShortagePanels();
    return;
  }
  if (state.activeTab === "inspection") {
    renderInspectionPanels();
    return;
  }
  if (state.activeTab === "cs") {
    renderCsPanels();
    return;
  }
  if (state.activeTab === "custom-orders") {
    renderCustomOrdersPanel();
    return;
  }
  if (state.activeTab === "completed") {
    renderCompletedPanels();
  }
}

function render() {
  renderShell();
  renderActivePanel();
  if (state.orderListModal.open) renderOrderListModal();
}

function csCandidateForCase(caseRow) {
  const ordNo = String(caseRow?.ord_no || "").trim();
  const itemNo = String(caseRow?.item_no || "").trim();
  const sellpiaOrderItemNo = String(caseRow?.sellpia_order_item_no || "").trim();
  return state.csManualCandidates.find((candidate) => {
    const candidateOrdNo = String(candidate?.order?.ord_no || candidate?.item?.ord_no || "").trim();
    if (!ordNo || candidateOrdNo !== ordNo) return false;
    const candidateItemNo = String(candidate?.item?.item_no || "").trim();
    if (itemNo && candidateItemNo === itemNo) return true;
    // Only use the Sellpia item key if the internal key is absent on the
    // persisted legacy case.
    return !itemNo && sellpiaOrderItemNo
      && String(candidate?.item?.sellpia_order_item_no || "").trim() === sellpiaOrderItemNo;
  }) || null;
}

function csCaseContext(caseRow) {
  const candidate = csCandidateForCase(caseRow);
  const order = state.csCaseContexts.orders.get(String(caseRow.ord_no || "")) || candidate?.order || null;
  const item = state.csCaseContexts.items.get(String(caseRow.item_no || "")) || candidate?.item || null;
  const ownCode = String(item?.prod_code || item?.p_dpcode || item?.own_code || "").trim();
  const context = {
    caseRow,
    order,
    item,
    ownCode,
    isGold: isGoldOwnCode(ownCode),
    key: String(caseRow.id),
  };
  return { ...context, templateOverride: csTemplateOverrideForRow(context) };
}

function csSearchTextFor({ order, item, caseRow }) {
  return [
    caseRow?.ord_no,
    caseRow?.inv_no,
    order?.ord_no,
    order?.inv_no,
    order?.orderer,
    order?.receiver,
    order?.receiver_name,
    item?.p_name,
    item?.p_option,
    item?.p_code,
    item?.prod_code,
  ]
    .map((value) => String(value || "").toLowerCase())
    .join(" ");
}

function autoShortageCsRows() {
  const openItemKeys = new Set(state.csOpenShortageItemKeys || []);
  for (const invoice of allWorkflowInvoices()) {
    for (const item of invoice.items || []) {
      if (!itemHasOpenWorkflowShortage(invoice, item)) continue;
      const ordNo = String(invoice.orderGroupNo || "").trim();
      const itemNo = String(item?.raw?.item_no || item?.sellpiaItemNo || "").trim();
      const sellpiaOrderItemNo = String(item?.raw?.sellpia_order_item_no || "").trim();
      if (ordNo && itemNo) openItemKeys.add(`${ordNo}::${itemNo}`);
      if (ordNo && sellpiaOrderItemNo) openItemKeys.add(`${ordNo}::${sellpiaOrderItemNo}`);
    }
  }
  if (!openItemKeys.size) return [];
  const persistedShortageKeys = new Set(
    state.csCases
      .filter((row) => String(row.case_type || "") === "shortage")
      .flatMap((row) => [
        `${String(row.ord_no || "")}::${String(row.item_no || "")}`,
        `${String(row.ord_no || "")}::${String(row.sellpia_order_item_no || "")}`,
      ]),
  );
  return state.csManualCandidates
    .map(manualCsCandidateRow)
    .filter((row) => {
      const ordNo = csRowOrderNo(row);
      const itemNo = String(row.item?.item_no || "").trim();
      const sellpiaOrderItemNo = String(row.item?.sellpia_order_item_no || "").trim();
      const isOpen = openItemKeys.has(`${ordNo}::${itemNo}`) || openItemKeys.has(`${ordNo}::${sellpiaOrderItemNo}`);
      const isPersisted = persistedShortageKeys.has(`${ordNo}::${itemNo}`) || persistedShortageKeys.has(`${ordNo}::${sellpiaOrderItemNo}`);
      return isOpen && !isPersisted;
    })
    .map((row) => ({
      ...row,
      key: `auto-shortage:${csRowOrderNo(row)}:${String(row.item?.item_no || row.item?.sellpia_order_item_no || "")}`,
      virtualAutoCase: true,
      caseRow: {
        id: null,
        ord_no: csRowOrderNo(row),
        item_no: row.item?.item_no || null,
        sellpia_order_item_no: row.item?.sellpia_order_item_no || null,
        inv_no: row.order?.inv_no || row.item?.inv_no || null,
        receipt_date: row.order?.receipt_date || row.item?.receipt_date || null,
        case_type: "shortage",
        status: "pending",
        source: "auto",
      },
    }));
}

function cancelledShortageRows() {
  return (state.workflowQueues?.viewModel?.invoices || []).flatMap((invoice) => {
    const invoiceCancelled = invoiceIsCancelled(invoice);
    return (invoice.items || [])
      .map((item) => {
        const itemState = workflowItemState(invoice, item);
        return {
          invoice,
          item,
          state: itemState,
          cancelled: invoiceCancelled || Boolean(itemState?.cancelled),
        };
      })
      .filter((row) => (
        row.cancelled
        && (
          row.state?.shortageOpen
          || Number(row.state?.shortageQty || 0) > 0
          || shortageQty(row.item) > 0
          || previousShortageQuantity(row.invoice, row.item) > 0
        )
      ));
  });
}

function autoTomorrowShippingCsRows() {
  const tomorrowInvoiceByOrderNo = new Map();
  for (const invoice of allWorkflowInvoices()) {
    const ordNo = String(invoice?.orderGroupNo || "").trim();
    if (!ordNo || tomorrowInvoiceByOrderNo.has(ordNo)) continue;
    if (hasTomorrowShippingManagementMemo(invoiceDrawerValue(invoice))) {
      tomorrowInvoiceByOrderNo.set(ordNo, invoice);
    }
  }
  if (!tomorrowInvoiceByOrderNo.size) return [];

  const candidateByOrderNo = new Map();
  for (const candidate of state.csManualCandidates) {
    const ordNo = csRowOrderNo(candidate);
    if (!tomorrowInvoiceByOrderNo.has(ordNo)) continue;
    const memo1 = String(
      candidate?.item?.o_shop_memo
        ?? candidate?.item?.shop_memo
        ?? candidate?.item?.memo1
        ?? "",
    );
    if (!candidateByOrderNo.has(ordNo) || hasTomorrowShippingManagementMemo(memo1)) {
      candidateByOrderNo.set(ordNo, candidate);
    }
  }

  return [...candidateByOrderNo.entries()].map(([ordNo, candidate]) => {
    const row = manualCsCandidateRow(candidate);
    return {
      ...row,
      key: `auto-tomorrow:${ordNo}:${String(row.item?.item_no || row.item?.sellpia_order_item_no || "")}`,
      virtualTomorrowCase: true,
      caseRow: {
        id: null,
        ord_no: ordNo,
        item_no: row.item?.item_no || null,
        sellpia_order_item_no: row.item?.sellpia_order_item_no || null,
        inv_no: row.order?.inv_no || row.item?.inv_no || null,
        receipt_date: row.order?.receipt_date || row.item?.receipt_date || null,
        case_type: "tomorrow_shipping",
        status: "pending",
        source: "auto",
        alimtalk_template: "d0",
      },
    };
  });
}

function allCsDisplayRows() {
  const visibleCases = state.csCases.filter((caseRow) => caseRow?.case_type !== "template_override");
  return [...visibleCases.map(csCaseContext), ...autoShortageCsRows(), ...autoTomorrowShippingCsRows()];
}

function csInboundExpectedState(rowOrItem) {
  const item = rowOrItem?.item || rowOrItem || {};
  const match = findOperationForCurrentItem(item, state.orderItemOperations);
  return resolveEffectiveInboundExpectedDate({
    operation: match.status === "matched" ? match.row : null,
    currentItem: item,
    skuSchedule: findSkuInboundSchedule(item, state.customOrders.skuSchedules),
  });
}

function normalizedCsInboundExpectedDate(rowOrItem) {
  return csInboundExpectedState(rowOrItem).date;
}

function csInboundExpectedSource(rowOrItem) {
  const source = csInboundExpectedState(rowOrItem).source;
  if (source === "sku_schedule") return "auto";
  if (source === "manual") return "manual";
  if (source === "legacy_sellpia") return "legacy_sellpia";
  return "";
}

function offsetLocalDateString(dateString, days) {
  const date = new Date(`${dateString}T12:00:00`);
  date.setDate(date.getDate() + days);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function csInboundDateMatches(row, filter = state.csInboundDateFilter) {
  if (!filter || filter === "all") return true;
  const date = normalizedCsInboundExpectedDate(row);
  if (filter === "missing") return !date;
  if (!date) return false;
  const today = todayDateString();
  if (filter === "overdue") return date < today;
  if (filter === "today") return date === today;
  if (filter === "tomorrow") return date === offsetLocalDateString(today, 1);
  if (filter === "week") {
    const weekday = new Date(`${today}T12:00:00`).getDay();
    const weekEnd = offsetLocalDateString(today, (7 - weekday) % 7);
    return date >= today && date <= weekEnd;
  }
  if (filter.startsWith("date:")) return date === filter.slice(5);
  return true;
}

function formatCsInboundDateLabel(dateString) {
  if (!dateString) return "";
  const [, month = "", day = ""] = dateString.split("-");
  const weekday = ["일", "월", "화", "수", "목", "금", "토"][new Date(`${dateString}T12:00:00`).getDay()] || "";
  return `${month}/${day}${weekday ? `(${weekday})` : ""}`;
}

function csInboundExpectedBadges(row) {
  const date = normalizedCsInboundExpectedDate(row);
  if (!date) return "";
  const source = csInboundExpectedSource(row);
  const sourceBadge = source === "auto"
    ? '<span class="workflow-row-badge inbound-source-auto" title="SKU 입고예정 DB에서 가져온 값">자동</span>'
    : source === "manual"
      ? '<span class="workflow-row-badge inbound-source-manual" title="CS 화면에서 직접 입력한 값">수동</span>'
      : source === "legacy_sellpia"
        ? '<span class="workflow-row-badge" title="기존 셀피아 출고확정일 값">셀피아</span>'
      : "";
  return `<span class="workflow-row-badge inbound-date" title="입고예정일">입고 ${escapeHtml(formatCsInboundDateLabel(date))}</span>${sourceBadge}`;
}

function filteredCsCaseRows({ includeInboundDate = true } = {}) {
  const search = state.csSearchText.trim().toLowerCase();
  return allCsDisplayRows()
    .filter((row) => state.csStatusFilter === "all" || csEffectiveStatus(row) === state.csStatusFilter)
    .filter((row) => !state.csTemplateOnly || csAutoTemplateKeys(row).length > 0)
    .filter((row) => {
      if (!state.csTypeFilter) return true;
      if (state.csTypeFilter === "alimtalk_excluded") return csAlimtalkExcluded(row);
      if (state.csTypeFilter === "manual") return row.caseRow?.source === "manual";
      if (state.csTypeFilter === "d5_selection_required") return csNeedsFiveDayTemplateSelection(row);
      if (state.csTypeFilter === "none") return row.caseRow?.source === "auto"
        && !csAlimtalkTemplateRule(row).templateKey
        && !csNeedsFiveDayTemplateSelection(row);
      return row.caseRow?.source === "auto" && csAutoTemplateKeys(row).includes(state.csTypeFilter);
    })
    .filter((row) => state.csGoldFilter === "all" || (state.csGoldFilter === "gold" ? row.isGold : !row.isGold))
    .filter((row) => !includeInboundDate || csInboundDateMatches(row))
    .filter((row) => !search || csSearchTextFor(row).includes(search));
}

function filteredManualCsCandidates() {
  const search = state.csSearchText.trim().toLowerCase();
  if (!search) return [];
  return state.csManualCandidates
    .filter((row) => csSearchTextFor(row).includes(search))
    .map(manualCsCandidateRow)
    .filter((row) => csInboundDateMatches(row))
    .slice(0, 100);
}

function manualCsCandidateRow(row) {
  const itemNo = String(row?.item?.item_no || "").trim();
  const sellpiaOrderItemNo = String(row?.item?.sellpia_order_item_no || "").trim();
  const ownCode = String(row?.item?.prod_code || row?.item?.p_dpcode || row?.item?.own_code || "").trim();
  return {
    ...row,
    key: `manual:${itemNo || sellpiaOrderItemNo}`,
    ownCode,
    isGold: isGoldOwnCode(ownCode),
    templateOverride: csTemplateOverrideForRow(row),
  };
}

function csRowOrderNo(row) {
  return String(row?.caseRow?.ord_no || row?.order?.ord_no || row?.item?.ord_no || row?.item?.order_group_no || "").trim();
}

function csTemplateOverrideForRow(row) {
  const ordNo = csRowOrderNo(row);
  const itemNo = String(row?.item?.item_no || row?.caseRow?.item_no || "").trim();
  if (!ordNo || !itemNo) return null;
  return state.csCases.find((caseRow) => (
    caseRow?.case_type === "template_override"
    && String(caseRow?.ord_no || "") === ordNo
    && String(caseRow?.item_no || "") === itemNo
  )) || null;
}

function csSelectedAlimtalkTemplate(row) {
  return String(row?.caseRow?.alimtalk_template || row?.templateOverride?.alimtalk_template || "").trim();
}

function csAlimtalkExcluded(row) {
  return Boolean(row?.caseRow?.alimtalk_excluded || row?.templateOverride?.alimtalk_excluded);
}

function groupedCsRows(rows) {
  const groups = new Map();
  for (const row of rows) {
    const ordNo = csRowOrderNo(row);
    const invoiceNo = csRowInvoiceNo(row);
    const key = invoiceNo ? `invoice:${invoiceNo}` : `order:${ordNo || row.key}`;
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        ordNo,
        invoiceNo,
        order: row.order || null,
        sourceOrderNos: [],
        items: [],
      });
    }
    const group = groups.get(key);
    group.items.push(row);
    if (ordNo && !group.sourceOrderNos.includes(ordNo)) group.sourceOrderNos.push(ordNo);
    if (!group.order && row.order) group.order = row.order;
  }
  return [...groups.values()].sort((left, right) => {
    const leftReceiptDate = String(left.order?.receipt_date || left.items.find((row) => row.caseRow?.receipt_date)?.caseRow?.receipt_date || "");
    const rightReceiptDate = String(right.order?.receipt_date || right.items.find((row) => row.caseRow?.receipt_date)?.caseRow?.receipt_date || "");
    const leftOrderKey = String(left.ordNo || left.invoiceNo || "");
    const rightOrderKey = String(right.ordNo || right.invoiceNo || "");
    const numericOptions = { numeric: true };
    if (state.csSort === "receipt_asc") {
      return leftReceiptDate.localeCompare(rightReceiptDate) || leftOrderKey.localeCompare(rightOrderKey, undefined, numericOptions);
    }
    if (state.csSort === "order_desc") {
      return rightOrderKey.localeCompare(leftOrderKey, undefined, numericOptions) || rightReceiptDate.localeCompare(leftReceiptDate);
    }
    if (state.csSort === "order_asc") {
      return leftOrderKey.localeCompare(rightOrderKey, undefined, numericOptions) || leftReceiptDate.localeCompare(rightReceiptDate);
    }
    return rightReceiptDate.localeCompare(leftReceiptDate) || rightOrderKey.localeCompare(leftOrderKey, undefined, numericOptions);
  });
}

function manualCsRowsForMatchedOrders() {
  const matchedRows = filteredManualCsCandidates();
  const matchedOrderNos = new Set(matchedRows.map(csRowOrderNo).filter(Boolean));
  const matchedInvoiceNos = new Set(matchedRows.map(csRowInvoiceNo).filter(Boolean));
  if (!matchedOrderNos.size && !matchedInvoiceNos.size) return [];
  return state.csManualCandidates
    .filter((row) => matchedOrderNos.has(csRowOrderNo(row)) || matchedInvoiceNos.has(csRowInvoiceNo(row)))
    .map(manualCsCandidateRow);
}

function caseRowsForMatchedOrders({ includeInboundDate = true } = {}) {
  // First apply the ordinary CS filters, then expand the matched order/invoice
  // to its product rows. An inbound date may be entered on a sibling that is
  // not itself the shortage CS target, so the date filter must run after this
  // expansion instead of only against persisted cs_cases rows.
  const matchedCaseRows = filteredCsCaseRows({ includeInboundDate: false });
  if (!state.csManualCandidates.length) {
    return includeInboundDate ? matchedCaseRows.filter((row) => csInboundDateMatches(row)) : matchedCaseRows;
  }
  const matchedOrderNos = new Set(matchedCaseRows.map(csRowOrderNo).filter(Boolean));
  const matchedInvoiceNos = new Set(matchedCaseRows.map(csRowInvoiceNo).filter(Boolean));
  if (!matchedOrderNos.size && !matchedInvoiceNos.size) return [];
  const allCaseByItemKey = new Map();
  for (const row of allCsDisplayRows()) {
    const caseRow = row.caseRow;
    const itemKey = `${String(caseRow?.ord_no || "")}::${String(caseRow?.item_no || caseRow?.sellpia_order_item_no || "")}`;
    if (itemKey.endsWith("::")) continue;
    allCaseByItemKey.set(itemKey, row);
  }
  const expandedRows = state.csManualCandidates
    .filter((row) => matchedOrderNos.has(csRowOrderNo(row)) || matchedInvoiceNos.has(csRowInvoiceNo(row)))
    .map((row) => {
      const normalized = manualCsCandidateRow(row);
      const orderNo = csRowOrderNo(normalized);
      const itemKey = `${orderNo}::${String(normalized.item?.item_no || normalized.item?.sellpia_order_item_no || "")}`;
      const matchedCase = allCaseByItemKey.get(itemKey) || null;
      // 한 송장의 다른 상품 때문에 상세를 함께 보여 주는 경우에도,
      // 제외된 별도 CS 상품은 진행 화면에서 CS가 없던 원래 상품행으로 복원한다.
      // 제외 탭에서는 이력을 확인하고 재개할 수 있도록 원본 케이스를 유지한다.
      const visibleCase = matchedCase?.caseRow?.source === "manual"
        && matchedCase.caseRow.status === "excluded"
        && state.csStatusFilter !== "excluded"
        ? null
        : matchedCase;
      return {
        ...normalized,
        caseRow: visibleCase?.caseRow || null,
        virtualAutoCase: Boolean(visibleCase?.virtualAutoCase),
        virtualTomorrowCase: Boolean(visibleCase?.virtualTomorrowCase),
      };
    });
  const expandedItemKeys = new Set(expandedRows.map((row) => `${csRowOrderNo(row)}::${String(row.item?.item_no || row.item?.sellpia_order_item_no || "")}`));
  for (const row of matchedCaseRows) {
    const itemKey = `${csRowOrderNo(row)}::${String(row.caseRow?.item_no || row.caseRow?.sellpia_order_item_no || "")}`;
    if (!expandedItemKeys.has(itemKey)) expandedRows.push(row);
  }
  return includeInboundDate ? expandedRows.filter((row) => csInboundDateMatches(row)) : expandedRows;
}

function renderedCsGroups() {
  const rows = state.csMode === "manual" ? manualCsRowsForMatchedOrders() : caseRowsForMatchedOrders();
  return groupedCsRows(rows);
}

function selectedCsRenderedGroup() {
  const groups = renderedCsGroups();
  return groups.find((group) => group.key === state.selectedCsKey) || null;
}

function selectedCsItemRow(rowKey) {
  return selectedCsRenderedGroup()?.items.find((row) => row.key === rowKey) || null;
}

function csStatusLabel(status) {
  return ({ pending: "진행", resolved: "해결", excluded: "제외" })[status] || status || "-";
}

function csRowDisplayName(row) {
  return row.order?.receiver || row.order?.receiver_name || row.order?.orderer || "-";
}

function csRowInvoiceNo(row) {
  // 송장번호가 없는 주문은 주문번호 단위로 유지한다. 표시용 "-"를 여기서
  // 반환하면 모든 미출고 주문이 invoice:- 한 건으로 잘못 합배송 그룹화된다.
  return row.caseRow?.inv_no || row.order?.inv_no || row.item?.inv_no || "";
}

function csSellerMeta(group) {
  const seller = group.order?.seller || group.order?.provider_name || group.order?.seller_id || "";
  return sellerBadgeMeta(seller);
}

function csRecommendedTemplateKeys(row) {
  const caseRow = row?.caseRow;
  if (!caseRow || (!row.virtualAutoCase && caseRow.source !== "auto")) return [];
  const basisDate = String(caseRow.basis_date || caseRow.receipt_date || row.order?.receipt_date || row.item?.receipt_date || "").trim();
  return csAlimtalkTemplateRule(row, basisDate).allowedTemplateKeys;
}

function csAlimtalkTemplateRule(row, basisDate = "") {
  const caseRow = row?.caseRow || {};
  const effective = effectiveAlimtalkElapsedDays(row, {
    basisDate: basisDate || caseRow.basis_date || caseRow.receipt_date || row?.order?.receipt_date || row?.item?.receipt_date || "",
    isGold: Boolean(row?.isGold),
  });
  return resolveAlimtalkTemplate({
    elapsedDays: effective.elapsedDays,
    isGold: Boolean(row?.isGold),
    isMakeshop: isCsMakeshopMethod({
      invoice: { seller: row?.order?.seller || row?.order?.provider_name || "" },
      csMethod: row?.csMethod || "",
    }),
    selectedTemplate: effective.anchor.hasAnchor ? effective.selectedTemplate : caseRow.alimtalk_template || "",
  });
}

function csAutoTemplateKeys(row) {
  const rule = csAlimtalkTemplateRule(row);
  return rule.templateKey ? [rule.templateKey] : [];
}

function csNeedsFiveDayTemplateSelection(row) {
  const caseRow = row?.caseRow;
  if (!caseRow || (!row.virtualAutoCase && caseRow.source !== "auto")) return false;
  const rule = csAlimtalkTemplateRule(row);
  return !rule.templateKey
    && rule.selectionRequired
    && rule.allowedTemplateKeys.length === 2
    && rule.allowedTemplateKeys.includes("d5_hi")
    && rule.allowedTemplateKeys.includes("d5_lo");
}

function csTemplateSelect(row, disabled = "") {
  const rule = csAlimtalkTemplateRule(row);
  const explicitTemplate = csSelectedAlimtalkTemplate(row);
  const automaticCase = Boolean(row?.virtualAutoCase || row?.caseRow?.source === "auto");
  // 일반 상품행은 자동 알림톡 대상이 아니다. 사용자가 직접 고른 값만
  // 보이며, 선택 전에는 반드시 '템플릿 없음'으로 둔다.
  const selectedTemplate = explicitTemplate || (automaticCase ? rule.templateKey : "");
  const placeholder = !automaticCase
    ? "템플릿 없음"
    : csNeedsFiveDayTemplateSelection(row)
      ? "5일차 선택 필요"
      : rule.label ? `자동 추천 · ${rule.label}` : "자동 추천으로 되돌리기";
  return `<label class="cs-template-field"><span>알림톡 템플릿</span><select data-cs-case-field="alimtalk_template" ${disabled}>
    <option value="" ${selectedTemplate ? "" : "selected"}>${escapeHtml(placeholder)}</option>
    ${Object.entries(CS_TEMPLATE_PRESETS).map(([templateKey, preset]) => `<option value="${escapeHtml(templateKey)}" ${selectedTemplate === templateKey ? "selected" : ""}>${escapeHtml(preset.label || templateKey)}</option>`).join("")}
  </select></label>`;
}

function csAlimtalkExcludeField(row, disabled = "") {
  const excluded = csAlimtalkExcluded(row);
  return `<label class="cs-alimtalk-exclude-field ${excluded ? "is-excluded" : ""}">
    <span>알림톡 제외</span>
    <span class="cs-alimtalk-exclude-control"><input type="checkbox" data-cs-alimtalk-excluded ${excluded ? "checked" : ""} ${disabled}><em>${excluded ? "내보내기 제외 중" : "체크 시 내보내기 제외"}</em></span>
  </label>`;
}

function csCaseBadges(group) {
  const badges = [];
  const seller = csSellerMeta(group);
  if (seller) badges.push(`<span class="seller-badge ${seller.className}">${escapeHtml(seller.label)}</span>`);

  const automaticTemplateKeys = [...new Set(
    group.items.filter((row) => row.virtualAutoCase || row.caseRow?.source === "auto").flatMap((row) => csAutoTemplateKeys(row)),
  )];
  automaticTemplateKeys.forEach((templateKey) => {
    const templateLabel = CS_TEMPLATE_PRESETS[templateKey]?.label || templateKey;
    badges.push(`<span class="workflow-row-badge warn" title="${escapeHtml(templateKey)}">알림톡 ${escapeHtml(templateLabel)}</span>`);
  });
  const fiveDaySelectionCount = group.items.filter(csNeedsFiveDayTemplateSelection).length;
  if (fiveDaySelectionCount) {
    badges.push(`<span class="workflow-row-badge warn">5일차 선택 필요${fiveDaySelectionCount > 1 ? ` ${fiveDaySelectionCount}` : ""}</span>`);
  }
  const noTemplateLabels = [...new Set(
    group.items
      .filter((row) => row.virtualAutoCase || row.caseRow?.source === "auto")
      .filter((row) => !csNeedsFiveDayTemplateSelection(row))
      .map((row) => csAlimtalkTemplateRule(row))
      .filter((rule) => !rule.templateKey)
      .map((rule) => rule.label),
  )];
  noTemplateLabels.forEach((label) => badges.push(`<span class="workflow-row-badge neutral">${escapeHtml(label)}</span>`));
  const alimtalkExcludedCount = group.items.filter(csAlimtalkExcluded).length;
  if (alimtalkExcludedCount) {
    badges.push(`<span class="workflow-row-badge hold">알림톡 제외${alimtalkExcludedCount > 1 ? ` ${alimtalkExcludedCount}` : ""}</span>`);
  }

  // 제외한 별도 CS는 일반 상품으로 되돌아간 것처럼 보여야 한다.
  // 따라서 진행 중인 수동 케이스만 송장/검품 뱃지에 반영한다.
  const manualCaseCount = group.items.filter((row) => (
    row.caseRow?.source === "manual" && row.caseRow?.status === "pending"
  )).length;
  if (manualCaseCount) {
    badges.push(`<span class="workflow-row-badge manual">별도 CS${manualCaseCount > 1 ? ` ${manualCaseCount}` : ""}</span>`);
  }
  return badges.join("");
}

function csInboundDateFilterOptions(rows) {
  const count = (filter) => rows.filter((row) => csInboundDateMatches(row, filter)).length;
  const dateCounts = new Map();
  for (const row of rows) {
    const date = normalizedCsInboundExpectedDate(row);
    if (date) dateCounts.set(date, (dateCounts.get(date) || 0) + 1);
  }
  const options = [
    ["all", `입고예정 전체 ${rows.length}`],
    ["missing", `입고예정 미정 ${count("missing")}`],
    ["overdue", `예정일 지남 ${count("overdue")}`],
    ["today", `오늘 ${count("today")}`],
    ["tomorrow", `내일 ${count("tomorrow")}`],
    ["week", `이번주 ${count("week")}`],
  ];
  [...dateCounts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .forEach(([date, dateCount]) => options.push([`date:${date}`, `${formatCsInboundDateLabel(date)} · ${dateCount}건`]));
  if (state.csInboundDateFilter.startsWith("date:") && !options.some(([value]) => value === state.csInboundDateFilter)) {
    const selectedDate = state.csInboundDateFilter.slice(5);
    options.push([state.csInboundDateFilter, `${formatCsInboundDateLabel(selectedDate)} · 0건`]);
  }
  return options;
}

function renderCsCaseFilters() {
  const statusButtons = [
    ["pending", "진행"],
    ["excluded", "제외"],
    ["all", "전체"],
  ];
  const inboundDateSourceRows = state.csMode === "manual"
    ? state.csManualCandidates.map(manualCsCandidateRow)
    : caseRowsForMatchedOrders({ includeInboundDate: false });
  const inboundDateOptions = csInboundDateFilterOptions(inboundDateSourceRows);
  els.csDateTabs.innerHTML = `
    ${statusButtons.map(([value, label]) => `<button class="filter-chip ${state.csMode === "cases" && state.csStatusFilter === value ? "active" : ""}" data-cs-case-status="${value}" type="button">${label}</button>`).join("")}
    <select class="filter-chip" data-cs-template-filter aria-label="알림톡 템플릿 필터">
      <option value="">템플릿별</option>
      <option value="d5_selection_required" ${state.csTypeFilter === "d5_selection_required" ? "selected" : ""}>5일차 선택 필요</option>
      ${Object.entries(CS_TEMPLATE_PRESETS).map(([templateKey, preset]) => `<option value="${escapeHtml(templateKey)}" ${state.csTypeFilter === templateKey ? "selected" : ""}>${escapeHtml(preset.label)}</option>`).join("")}
      <option value="none" ${state.csTypeFilter === "none" ? "selected" : ""}>템플릿 없음 (기타)</option>
      <option value="manual" ${state.csTypeFilter === "manual" ? "selected" : ""}>별도 CS</option>
      <option value="alimtalk_excluded" ${state.csTypeFilter === "alimtalk_excluded" ? "selected" : ""}>알림톡 제외건</option>
    </select>
    <label class="filter-chip cs-template-only"><input type="checkbox" data-cs-template-only ${state.csTemplateOnly ? "checked" : ""}> 템플릿 없음 제외</label>
    <select class="filter-chip" data-cs-gold-filter aria-label="골드 필터">
      <option value="all" ${state.csGoldFilter === "all" ? "selected" : ""}>일반/14K 전체</option>
      <option value="normal" ${state.csGoldFilter === "normal" ? "selected" : ""}>일반</option>
      <option value="gold" ${state.csGoldFilter === "gold" ? "selected" : ""}>14K</option>
    </select>
    <select class="filter-chip cs-inbound-date-filter" data-cs-inbound-date-filter aria-label="입고예정일 모아보기" title="입고예정일이 입력된 상품은 자동·수동 출처와 관계없이 같은 날짜로 모읍니다.">
      ${inboundDateOptions.map(([value, label]) => `<option value="${escapeHtml(value)}" ${state.csInboundDateFilter === value ? "selected" : ""}>${escapeHtml(label)}</option>`).join("")}
    </select>
    <button class="filter-chip ${state.csMode === "manual" ? "active" : ""}" data-cs-mode="manual" type="button">수동 CS 추가</button>
    <button class="filter-chip" data-cs-alimtalk-action="export" type="button" ${allowWrites ? "" : "disabled"}>알림톡 CSV</button>
    <span class="cs-mode-indicator ${state.csMode === "manual" ? "manual" : ""}">${state.csMode === "manual" ? "수동 CS 추가 모드 · 검색 후 상품행의 ‘별도 CS 추가’를 누르세요" : "CS 케이스 목록"}</span>`;
}

function renderCsCaseRow(group, selected) {
  const caseRows = group.items.filter((row) => row.caseRow);
  const cancellation = csGroupCancellationState(group);
  const tomorrowShippingCount = caseRows.filter((row) => row.virtualTomorrowCase).length;
  const autoShortageCount = caseRows.filter((row) => (
    row.virtualAutoCase || (row.caseRow.source === "auto" && row.caseRow.case_type === "shortage")
  )).length;
  const pendingCount = caseRows.filter((row) => csEffectiveStatus(row) === "pending").length;
  const goldCount = group.items.filter((row) => row.isGold).length;
  const badgeClass = cancellation.invoiceCancelled || cancellation.cancelledItems ? "cancelled" : caseRows.length ? (pendingCount ? "danger" : caseRows.every((row) => csEffectiveStatus(row) === "excluded") ? "hold" : "done") : "manual";
  const modeLabel = cancellation.invoiceCancelled
    ? "주문취소"
    : cancellation.cancelledItems
      ? `상품취소 ${cancellation.cancelledItems}`
      : tomorrowShippingCount
    ? `내일출고${autoShortageCount ? ` · 미송 ${autoShortageCount}` : ""}`
    : autoShortageCount
      ? `미송 ${autoShortageCount}`
      : caseRows.length ? (pendingCount ? `진행 ${pendingCount}` : "처리됨") : "수동 등록 가능";
  const receiver = group.order?.receiver || group.order?.receiver_name || group.order?.orderer || "-";
  const badges = csCaseBadges(group);
  const combinedBadge = group.sourceOrderNos?.length > 1
    ? `<span class="workflow-row-badge shipment">합배송 ${group.sourceOrderNos.length}주문</span>`
    : "";
  return `<button class="workflow-row cs-case-row ${caseRows.length ? "is-case" : "is-manual-source"} ${cancellation.invoiceCancelled ? "is-cancelled" : ""} ${selected ? "selected" : ""}" data-cs-key="${escapeHtml(group.key)}" type="button">
    <span class="cs-case-row-main">
      <strong>송장 ${escapeHtml(group.invoiceNo || "-")} · ${escapeHtml(receiver)}</strong>
      <small>상품 ${group.items.length}건${caseRows.length ? ` · ${autoShortageCount ? `미송 ${autoShortageCount}건` : `CS ${caseRows.length}건`}` : ""}</small>
      ${badges || combinedBadge ? `<span class="cs-case-row-meta">${combinedBadge}${badges}</span>` : ""}
    </span>
    <span class="cs-case-row-side">
      <span class="workflow-row-badge ${badgeClass}">${escapeHtml(modeLabel)}</span>
      ${goldCount ? `<span class="workflow-row-badge gold">14K ${goldCount}</span>` : ""}
    </span>
  </button>`;
}

function renderCsCaseItemEditor(row, itemNumber = 0) {
  const caseRow = row.caseRow || null;
  const virtualAutoCase = Boolean(row.virtualAutoCase);
  const virtualTomorrowCase = Boolean(row.virtualTomorrowCase);
  const virtualCase = virtualAutoCase || virtualTomorrowCase;
  const item = row.item || {};
  const order = row.order || {};
  const cancellation = csCancellationState(row);
  const workflowItem = cancellation.item;
  const partialShippingHoldOn = Boolean(workflowItem && isHold(workflowItem));
  const readonly = allowWrites && !virtualCase ? "" : "readonly";
  const orderMemoReadonly = allowWrites ? "" : "readonly";
  const managementReadonly = allowWrites ? "" : "readonly";
  const disabled = allowWrites ? "" : "disabled";
  const partialHoldDisabled = allowWrites && workflowItem && !cancellation.cancelled ? "" : "disabled";
  const receiptDate = caseRow?.receipt_date || order.receipt_date || item.receipt_date || "";
  const memo = String(item.order_memo ?? "");
  const managementMemo2 = String(item.o_shop_memo2 ?? item.shop_memo2 ?? item.memo2 ?? "");
  const outboundConfirmedDate = normalizedCsInboundExpectedDate(row);
  const basisDate = caseRow?.basis_date || receiptDate;
  const automaticCase = Boolean(virtualCase || caseRow?.source === "auto");
  const manualCase = Boolean(caseRow && !virtualCase && caseRow.source === "manual");
  const hasCase = Boolean(caseRow);
  const caseBadge = cancellation.invoiceCancelled
    ? '<span class="workflow-row-badge cancelled">주문취소</span>'
    : cancellation.itemCancelled
      ? '<span class="workflow-row-badge cancelled">상품취소</span>'
      : virtualTomorrowCase
    ? '<span class="workflow-row-badge warn">내일출고 자동대상</span>'
    : virtualAutoCase
    ? '<span class="workflow-row-badge danger">미송 자동대상</span>'
    : automaticCase
      ? `<span class="workflow-row-badge danger">${escapeHtml(csStatusLabel(caseRow.status))}</span><span class="workflow-row-badge danger">미송 CS</span>`
      : manualCase
        ? `<span class="workflow-row-badge manual">별도 CS</span><span class="workflow-row-badge ${caseRow.status === "pending" ? "danger" : caseRow.status === "excluded" ? "hold" : "done"}">${escapeHtml(csStatusLabel(caseRow.status))}</span>`
        : '<span class="workflow-row-badge neutral">CS 대상 아님</span>';
  const caseClassification = automaticCase
    ? csTemplateSelect(row, allowWrites && !virtualTomorrowCase ? "" : "disabled")
    : manualCase
      ? '<label class="cs-template-static"><span>CS 구분</span><strong>별도 CS</strong></label>'
      : csTemplateSelect(row, allowWrites ? "" : "disabled");
  const imageCode = item.sellpia_p_code || item.sellpia_product_code || item.p_code || "";
  const imageUrl = productImageUrl(imageCode);
  const actionButtons = virtualTomorrowCase
    ? '<span class="workflow-row-badge warn">관리메모1 표식으로 자동 판정</span>'
    : virtualAutoCase
    ? `<button class="btn primary" data-cs-case-action="register-auto" data-cs-row-key="${escapeHtml(row.key)}" type="button" ${disabled}>미송 CS 저장</button>`
    : hasCase
      ? `<button class="btn primary" data-cs-case-action="save-all" data-cs-case-id="${caseRow.id}" data-cs-row-key="${escapeHtml(row.key)}" type="button" ${disabled}>저장</button>
          ${caseRow.status === "pending" ? `<button class="btn" data-cs-case-action="resolve" data-cs-case-id="${caseRow.id}" data-cs-row-key="${escapeHtml(row.key)}" type="button" ${disabled}>해결</button><button class="btn" data-cs-case-action="exclude" data-cs-case-id="${caseRow.id}" data-cs-row-key="${escapeHtml(row.key)}" type="button" ${disabled}>제외</button>` : `<button class="btn primary" data-cs-case-action="reopen" data-cs-case-id="${caseRow.id}" data-cs-row-key="${escapeHtml(row.key)}" type="button" ${disabled}>재개</button>`}`
      : `<button class="btn" data-cs-case-action="save-template-override" data-cs-row-key="${escapeHtml(row.key)}" type="button" ${disabled}>템플릿 저장</button>
          <button class="btn primary" data-cs-case-action="create" data-cs-manual-item-no="${escapeHtml(item.item_no || "")}" data-cs-row-key="${escapeHtml(row.key)}" type="button" ${disabled}>별도 CS 추가</button>`;
  const partialHoldButton = `<button class="btn ${partialShippingHoldOn ? "" : "primary"}" data-cs-item-hold-action="${partialShippingHoldOn ? "off" : "on"}" data-cs-row-key="${escapeHtml(row.key)}" type="button" title="상품행 단위 부분 배송보류 (셀피아 동기화 전 System 테스트)" ${partialHoldDisabled}>${partialShippingHoldOn ? "부분보류 해제" : "부분보류 처리"}</button>`;
  const cancelButton = cancellation.invoiceCancelled
    ? '<div class="cs-cancel-action-slot"><span class="workflow-row-badge cancelled">주문 전체 취소 적용</span></div>'
    : `<div class="cs-cancel-action-slot"><button class="btn ${cancellation.itemCancelled ? "cancel-reopen" : "cancel-action"}" data-cs-cancel-action="${cancellation.itemCancelled ? "item-reopen" : "item-cancel"}" data-cs-row-key="${escapeHtml(row.key)}" type="button" ${allowWorkflowEvents ? "" : "disabled"}>${cancellation.itemCancelled ? "취소 해제" : "이 상품 취소"}</button></div>`;
  const partialHoldBadge = partialShippingHoldOn ? '<span class="workflow-row-badge hold">부분보류 ON</span>' : "";
  return `<article class="cs-item-card ${caseRow?.status === "pending" ? "is-cs-target" : ""} ${partialShippingHoldOn ? "has-partial-hold" : ""} ${cancellation.cancelled ? "is-cancelled" : ""}" data-cs-row-key="${escapeHtml(row.key)}">
    <section class="cs-item-overview">
      <span class="cs-item-line-number" title="상품행번호 ${escapeHtml(String(itemNumber || "-"))}">${escapeHtml(String(itemNumber || "-"))}</span>
      <div class="workflow-item-photo">${imageUrl ? `<img src="${imageUrl}" ${photoImgAttrs(imageUrl, `${row.ownCode || ""} · ${item.p_name || ""}`, productImageFallbackUrls(imageCode))} alt="" loading="lazy">` : "사진"}</div>
      <div class="cs-item-product"><strong>${escapeHtml(item.p_name || "상품 정보 없음")}</strong><em>${escapeHtml(item.p_option || "옵션 없음")}</em><div class="cs-item-facts"><span>수량 <b>${escapeHtml(String(item.qty ?? item.o_amount ?? "-"))}</b></span><span>자사코드 <b>${escapeHtml(row.ownCode || "-")}</b></span></div></div>
      <div class="workflow-row-badges cs-item-status">${caseBadge}${partialHoldBadge}${csInboundExpectedBadges(row)}${row.isGold ? '<span class="workflow-row-badge gold">14K</span>' : '<span class="workflow-row-badge">일반</span>'}</div>
    </section>
    <section class="cs-item-section cs-item-case-classification">
      <h4>CS 진행</h4>
      ${caseClassification}
      ${csAlimtalkExcludeField(row, disabled)}
      <label><span>기준일</span><output class="cs-basis-date-display" data-cs-basis-date-text>${escapeHtml(csBasisDateText(row, basisDate || receiptDate))}</output></label>
      <label><span>입고예정일</span><input data-cs-item-sync-field="outbound_confirmed_date" type="date" value="${escapeHtml(outboundConfirmedDate)}" ${managementReadonly}></label>
    </section>
    <section class="cs-item-section cs-item-memo-fields">
      <h4>상품 메모</h4>
      <label><span>관리메모2</span><input data-cs-management-field="memo2" value="${escapeHtml(managementMemo2)}" ${managementReadonly}></label>
      <label class="inspection-memo-cell ${memo.trim() ? "has-value" : ""}"><span>주문메모</span><textarea data-cs-case-order-memo rows="2" ${orderMemoReadonly}>${escapeHtml(memo)}</textarea></label>
    </section>
    <div class="cs-item-card-actions">${partialHoldButton}${actionButtons}${cancelButton}</div>
  </article>`;
}

function csGroupSourceInvoices(group) {
  const orderNos = group?.sourceOrderNos?.length ? group.sourceOrderNos : [group?.ordNo].filter(Boolean);
  const byOrder = new Map();
  for (const invoice of allWorkflowInvoices()) {
    const orderGroupNo = String(invoice?.orderGroupNo || "").trim();
    if (orderNos.includes(orderGroupNo) && !byOrder.has(orderGroupNo)) byOrder.set(orderGroupNo, invoice);
  }
  return orderNos.map((orderGroupNo) => byOrder.get(orderGroupNo)).filter(Boolean);
}

function csGroupWorkflowInvoice(group) {
  const sourceInvoices = csGroupSourceInvoices(group);
  if (sourceInvoices.length < 2) return sourceInvoices[0] || null;
  return combineInvoicesBySharedInvoice(sourceInvoices)[0] || sourceInvoices[0];
}

function selectedCsWorkflowInvoice(orderGroupNo = "") {
  const invoice = csGroupWorkflowInvoice(selectedCsRenderedGroup());
  if (!invoice) return null;
  const target = String(orderGroupNo || "").trim();
  if (!target || String(invoice.orderGroupNo || "") === target) return invoice;
  return sourceInvoicesForShipment(invoice).some((sourceInvoice) => String(sourceInvoice.orderGroupNo || "") === target)
    ? invoice
    : null;
}

function renderCsCombinedOrderSections(group) {
  let itemNumber = 0;
  return (group.sourceOrderNos || []).map((orderGroupNo, orderIndex) => {
    const rows = group.items.filter((row) => csRowOrderNo(row) === orderGroupNo);
    const sourceInvoice = csGroupSourceInvoices(group).find((invoice) => invoice.orderGroupNo === orderGroupNo) || null;
    const order = rows.find((row) => row.order)?.order || {};
    const receiver = order.receiver || order.receiver_name || order.orderer || "-";
    const cancelled = invoiceIsCancelled(sourceInvoice);
    const cards = rows.map((row) => renderCsCaseItemEditor(row, ++itemNumber)).join("");
    return `<section class="cs-source-order-section ${cancelled ? "is-cancelled" : ""}">
      <div class="cs-source-order-head">
        <div><span class="shipment-source-badge">원주문 ${orderIndex + 1}</span><strong>${escapeHtml(orderGroupNo)}</strong><small>${escapeHtml(receiver)} · 상품 ${rows.length}종</small></div>
        <div class="cs-order-action-stack">
          <button class="btn ${cancelled ? "cancel-reopen" : "cancel-action"}" data-cs-cancel-action="${cancelled ? "order-reopen" : "order-cancel"}" data-cs-order-group="${escapeHtml(orderGroupNo)}" type="button" ${sourceInvoice && allowWorkflowEvents ? "" : "disabled"}>${cancelled ? "주문 취소 해제" : "주문 전체 취소"}</button>
          ${sourceInvoice ? shippingHoldBadge(sourceInvoice) : ""}
        </div>
      </div>
      <div class="cs-item-card-stack">${cards}</div>
    </section>`;
  }).join("");
}

function renderCsCaseDetail(group) {
  if (!group) {
    renderWorkflowEmpty(els.csDetail, state.csMode === "manual" ? "검색어를 입력해 주문을 찾으세요." : "CS 케이스를 선택하세요.");
    return;
  }
  const receiver = group.order?.receiver || group.order?.receiver_name || group.order?.orderer || "-";
  const caseCount = group.items.filter((row) => row.caseRow).length;
  const invoice = csGroupWorkflowInvoice(group);
  const combinedShipment = Boolean(invoice?.shipmentGroup && group.sourceOrderNos?.length > 1);
  const invoiceCancelled = invoiceIsCancelled(invoice);
  const holdState = invoice ? shippingHoldUiState(invoice) : null;
  const holdAction = holdState?.action || "inspection-hold";
  const holdLabel = holdState?.actionLabel || "배송보류 처리";
  const holdDisabled = invoice && allowWorkflowEvents && !invoiceCancelled ? "" : "disabled";
  const managementReadonly = allowWrites ? "" : "readonly";
  const scheduledHistory = String(group.order?.sellpia_outbound_scheduled_date || "");
  const headerBadges = csCaseBadges(group);
  els.csDetail.innerHTML = `<div class="cs-detail-card cs-case-detail-card ${invoiceCancelled ? "is-cancelled" : ""}">
    <div class="workflow-detail-head cs-order-detail-head">
      <div class="cs-order-title-block"><strong>송장 ${escapeHtml(group.invoiceNo || "-")} · ${escapeHtml(receiver)}</strong>
        ${headerBadges ? `<div class="cs-case-row-meta cs-order-header-meta">${headerBadges}</div>` : ""}
      </div>
      <div class="inspection-actions">
        <span class="workflow-row-badge ${state.csMode === "manual" ? "manual" : ""}">${state.csMode === "manual" ? "수동 추가 대상" : `CS ${caseCount}건`}</span>
        <div class="cs-order-action-stack">
          <button class="btn" data-cs-hold-action="${escapeHtml(holdAction)}" data-cs-order-group="${escapeHtml(group.ordNo || "")}" type="button" ${holdDisabled}>${escapeHtml(holdLabel)}</button>
          ${combinedShipment ? "" : `<button class="btn ${invoiceCancelled ? "cancel-reopen" : "cancel-action"}" data-cs-cancel-action="${invoiceCancelled ? "order-reopen" : "order-cancel"}" data-cs-order-group="${escapeHtml(group.ordNo || "")}" type="button" ${invoice && allowWorkflowEvents ? "" : "disabled"}>${invoiceCancelled ? "주문 취소 해제" : "주문 전체 취소"}</button>`}
          ${invoice ? shippingHoldBadge(invoice) : ""}
        </div>
        ${combinedShipment ? `<span class="workflow-row-badge shipment">합배송 ${group.sourceOrderNos.length}주문 · 관리메모1·배송보류 송장 전체</span>` : ""}
        <label class="cs-order-drawer-box"><span>관리메모1 <em>송장 전체</em></span><textarea class="drawer-input cs-order-drawer-input" data-cs-drawer data-order-group="${escapeHtml(invoice?.orderGroupNo || group.ordNo || "")}" rows="2" placeholder="서랍번호 / 관리메모1" ${managementReadonly}>${escapeHtml(invoice ? invoiceDrawerValue(invoice) : "")}</textarea></label>
        <label class="cs-order-scheduled-date"><span>알림톡 발송로그 <em>송장 공통 · 코드 + 최종 입력일</em></span><textarea data-cs-order-sync-field="outbound_scheduled_date" data-cs-order-group="${escapeHtml(group.ordNo || "")}" rows="3" placeholder="예: 1,3,5ㅂ&#10;08/04" title="코드 다음 줄의 MM/DD를 기준으로 다음 영업일차를 자동 계산합니다. 0=내일출고, 1=일반 1일차, 1_14=14K 1일차, 3=일반 3일차 플랫폼, 3ㅁ=일반 3일차 메이크샵, 5ㅂ=5일차 부분출고, 5ㅊ=5일차 취소출고, 5_14k=14K 5일차 부분출고, 10=10일차 잔여취소, ㅂㅂ=별도 CS 처리" ${managementReadonly}>${escapeHtml(scheduledHistory)}</textarea></label>
      </div>
    </div>
    <p class="workflow-note">미송 자동대상과 별도 CS를 구분합니다. 관리메모1과 배송보류는 같은 송장 전체에 적용하고, 관리메모2는 상품행별 미송 상태와 연결합니다. 주문메모·기준일은 상품행별로 저장합니다.</p>
    <div class="cs-sync-note"><strong>CS 백업·동기화 기준</strong><span>송장 단위의 <b>알림톡 발송로그</b>는 첫 줄에 코드를 쉼표로 누적하고, 마지막 줄에 <b>MM/DD</b>를 기록합니다. 해당 상품에 적용되는 마지막 코드의 일차에서 날짜 이후 영업일을 다시 계산합니다. <b>0</b>=내일출고, <b>1</b>=일반1일차, <b>1_14</b>=14K1일차, <b>3</b>=플랫폼, <b>3ㅁ</b>=메이크샵, <b>5ㅂ</b>=부분출고, <b>5ㅊ</b>=취소출고, <b>5_14k</b>=14K5일차, <b>10</b>=잔여취소, <b>ㅂㅂ</b>=별도 CS 처리입니다.</span></div>
    ${combinedShipment ? renderCsCombinedOrderSections(group) : `<div class="cs-item-card-stack">${group.items.map((row, index) => renderCsCaseItemEditor(row, index + 1)).join("")}</div>`}
  </div>`;
}

function renderCsCasePanels() {
  if (els.csSearchInput && els.csSearchInput.value !== state.csSearchText) els.csSearchInput.value = state.csSearchText;
  if (els.csListSort && els.csListSort.value !== state.csSort) els.csListSort.value = state.csSort;
  els.csListBody?.closest(".workflow-list")?.classList.toggle("cs-manual-mode", state.csMode === "manual");
  els.csDetail?.classList.toggle("cs-manual-mode", state.csMode === "manual");
  renderCsCaseFilters();
  if (state.csCaseError) {
    renderWorkflowEmpty(els.csListBody, state.csCaseError);
    renderWorkflowEmpty(els.csDetail, "CS 케이스를 불러오지 못했습니다.");
    return;
  }
  // Never replace an already-renderable CS list with a blocking loading
  // screen.  The candidates are sufficient to draw the item detail; any
  // supplemental DB reads can finish in the background.
  const groups = renderedCsGroups();
  const total = state.csMode === "manual"
    ? groupedCsRows(state.csManualCandidates.map(manualCsCandidateRow)).length
    : groupedCsRows(allCsDisplayRows()).length;
  if (els.csListCount) els.csListCount.textContent = `${groups.length}건 / 전체 ${total}건`;
  if (!groups.length) {
    renderWorkflowEmpty(els.csListBody, state.csMode === "manual" ? "검색어를 입력하면 주문·상품행을 찾을 수 있습니다." : "현재 필터에 맞는 CS 케이스가 없습니다.");
    renderWorkflowEmpty(els.csDetail, state.csMode === "manual" ? "주문번호, 송장번호, 이름, 상품명, 상품코드 또는 자사코드로 검색하세요." : "수동 추가로 상품행 CS 케이스를 등록할 수 있습니다.");
    return;
  }
  if (!groups.some((group) => group.key === state.selectedCsKey)) state.selectedCsKey = groups[0].key;
  els.csListBody.innerHTML = groups.map((group) => renderCsCaseRow(group, group.key === state.selectedCsKey)).join("");
  renderCsCaseDetail(groups.find((group) => group.key === state.selectedCsKey) || groups[0]);
}

function customOrderInboundSourceLabel(source) {
  return {
    manual: "수동",
    sku_schedule: "SKU 일정",
    legacy_sellpia: "셀피아",
  }[String(source || "").trim()] || "없음";
}

function sortedSkuInboundSchedules() {
  return [...state.customOrders.skuSchedules].sort((left, right) => (
    String(left.inbound_expected_date || "").localeCompare(String(right.inbound_expected_date || ""))
      || String(left.sellpia_sku || "").localeCompare(String(right.sellpia_sku || ""), "ko")
  ));
}

function mergeSkuInboundScheduleState(saved) {
  const sku = String(saved?.sellpia_sku || "").trim();
  if (!sku) return;
  const index = state.customOrders.skuSchedules.findIndex((row) => String(row.sellpia_sku || "").trim() === sku);
  if (index >= 0) state.customOrders.skuSchedules.splice(index, 1, saved);
  else state.customOrders.skuSchedules.push(saved);
  state.customOrders.skuSchedulesLoaded = true;
}

function renderSkuInboundScheduleRow(schedule) {
  const sku = escapeHtml(schedule.sellpia_sku || "");
  const saving = state.saving.has(`sku-inbound:${schedule.sellpia_sku}`);
  return `<div class="sku-inbound-schedule-row" data-sku-inbound-schedule="${sku}" aria-busy="${saving ? "true" : "false"}">
    <code title="${sku}">${sku}</code>
    <label>입고예정일<input type="date" data-sku-schedule-field="inbound_expected_date" value="${escapeHtml(schedule.inbound_expected_date || "")}" ${saving ? "disabled" : ""}></label>
    <label>자사코드<input data-sku-schedule-field="own_code" value="${escapeHtml(schedule.own_code || "")}" placeholder="선택 입력" ${saving ? "disabled" : ""}></label>
    <button class="btn" data-sku-schedule-action="save" type="button" ${saving ? "disabled" : ""}>저장</button>
  </div>`;
}

function renderSkuInboundScheduleManager() {
  if (!els.customOrdersSkuList) return;
  const schedules = sortedSkuInboundSchedules();
  if (els.customOrdersSkuCount) els.customOrdersSkuCount.textContent = `${schedules.length}개 SKU`;
  if (els.customOrdersSkuImportStatus) {
    els.customOrdersSkuImportStatus.textContent = state.customOrders.skuScheduleImportStatus;
  }
  els.customOrdersSkuList.innerHTML = schedules.length
    ? schedules.map(renderSkuInboundScheduleRow).join("")
    : `<div class="sku-inbound-schedule-empty">
        등록된 SKU 입고예정일이 없습니다. 위 입력란 또는 엑셀 업로드로 추가하세요.<br>
        엑셀 열: <strong>셀피아 SKU | 입고예정일(YYYY-MM-DD) | 자사코드(선택)</strong><br>
        예: <code>1000-1 | 2026-10-08 | GPA-14-19_5</code>
      </div>`;
}

function renderCustomOrderRow(row) {
  const operation = row.operation;
  const display = row.display;
  const imageCode = display.sellpiaProductCode || "";
  const imageUrl = productImageUrl(imageCode);
  const statusLabel = CUSTOM_ORDER_STATUS_LABEL[row.status] || "-";
  const operationId = escapeHtml(operation.operation_id);
  const cancelled = row.status === "cancelled";
  const saving = state.saving.has(`custom-order:${operation.operation_id}`);
  const disabled = cancelled || saving ? "disabled" : "";
  return `<article class="custom-order-row status-${escapeHtml(row.status)}" data-operation-id="${operationId}" aria-busy="${saving ? "true" : "false"}">
    <div class="custom-order-row-primary custom-order-card-section">
      <div class="custom-order-product-photo">
        ${imageUrl ? `<img src="${imageUrl}" ${photoImgAttrs(imageUrl, `${display.ownCode || ""} · ${display.productName || ""}`, productImageFallbackUrls(imageCode))} alt="" loading="lazy">` : '<span>사진</span>'}
      </div>
      <div class="custom-order-row-primary-copy">
        <div class="custom-order-row-badges">
          <span class="custom-order-status status-${escapeHtml(row.status)}">${escapeHtml(statusLabel)}</span>
          ${row.sourceMissing ? '<span class="workflow-row-badge danger">원천 주문행 없음</span>' : ""}
        </div>
        <strong class="custom-order-supplier">${escapeHtml(display.supplierCellRaw || "매입처 미확인")}</strong>
        <div class="custom-order-product">
          <b>${escapeHtml(display.productName || "상품명 없음")}</b>
          ${display.productOption ? `<span>${escapeHtml(display.productOption)}</span>` : ""}
        </div>
        <div class="custom-order-codes">
          <span>SKU ${escapeHtml(display.sellpiaProductCode || "-")}</span>
          <span>자사 ${escapeHtml(display.ownCode || "-")}</span>
        </div>
        <div class="custom-order-identity">
          <span>주문 ${escapeHtml(operation.ord_no || "-")}</span>
          <small>${escapeHtml(operation.sellpia_order_item_no || operation.item_no || "-")}</small>
        </div>
      </div>
    </div>
    <div class="custom-order-card-section custom-order-row-workflow">
      <strong class="custom-order-section-title">진행 일정</strong>
      <div class="custom-order-row-dates">
        <label>등록일 <span>${escapeHtml(formatShortDate(operation.custom_required_at))}</span></label>
        <label>업체 주문일
          <input type="date" data-custom-order-field="custom_ordered_on" value="${escapeHtml(operation.custom_ordered_on || "")}" ${disabled}>
        </label>
        <label>입고예정일
          <span class="custom-order-date-with-source">
            <input type="date" data-custom-order-field="inbound_expected_date" value="${escapeHtml(row.inbound.date || "")}" ${disabled}>
            <small>${escapeHtml(customOrderInboundSourceLabel(row.inbound.source))}${row.inbound.explicitlyCleared ? " · 삭제됨" : ""}</small>
          </span>
        </label>
        <label>입고 완료일
          <input type="date" data-custom-order-field="custom_received_on" value="${escapeHtml(operation.custom_received_on || "")}" ${disabled}>
        </label>
      </div>
    </div>
    <div class="custom-order-card-section custom-order-row-side">
      <div class="custom-order-row-memo">
        <label>내부 메모
          <input data-custom-order-field="internal_memo" maxlength="500" value="${escapeHtml(operation.internal_memo || "")}" placeholder="System V3 내부 메모" ${disabled}>
        </label>
      </div>
      <div class="custom-order-row-actions">
        <button class="btn" data-custom-order-action="ordered-today" type="button" ${disabled}>주문 넣음</button>
        <button class="btn primary" data-custom-order-action="received-today" type="button" ${disabled}>입고 완료</button>
        <button class="btn danger" data-custom-order-action="cancel" type="button" ${disabled}>취소</button>
      </div>
    </div>
  </article>`;
}

function inboundRowIdentity(row) {
  return orderItemIdentity(row?.operation || row?.currentItem || {});
}

function renderInboundExpectedRow(row) {
  const identity = inboundRowIdentity(row);
  const operation = row.operation;
  const operationId = operation?.operation_id || "";
  const savingKey = operationId ? `custom-order:${operationId}` : `inbound:${row.key}`;
  const saving = state.saving.has(savingKey);
  const disabled = saving || row.identityIssue || customOrderStatus(operation || {}) === "cancelled" ? "disabled" : "";
  const display = row.display;
  return `<article class="custom-order-row inbound-expected-row" data-inbound-row-key="${escapeHtml(row.key)}" ${operationId ? `data-operation-id="${escapeHtml(operationId)}"` : ""} aria-busy="${saving ? "true" : "false"}">
    <div class="custom-order-row-primary custom-order-card-section">
      <div class="custom-order-row-badges">
        <span class="custom-order-status inbound-source-${escapeHtml(row.inbound.source || "none")}">${escapeHtml(customOrderInboundSourceLabel(row.inbound.source))}</span>
        ${row.inbound.explicitlyCleared ? '<span class="workflow-row-badge warn">명시적 삭제</span>' : ""}
        ${row.sourceMissing ? '<span class="workflow-row-badge danger">원천 주문행 없음</span>' : ""}
        ${row.identityIssue ? '<span class="workflow-row-badge danger">식별 충돌 · 수정 불가</span>' : ""}
      </div>
      <strong class="custom-order-supplier">${escapeHtml(display.supplierCellRaw || "매입처 미확인")}</strong>
      <div class="custom-order-product">
        <b>${escapeHtml(display.productName || "상품명 없음")}</b>
        ${display.productOption ? `<span>${escapeHtml(display.productOption)}</span>` : ""}
      </div>
      <div class="custom-order-codes">
        <span>SKU ${escapeHtml(display.sellpiaProductCode || "-")}</span>
        <span>자사 ${escapeHtml(display.ownCode || "-")}</span>
      </div>
      <div class="custom-order-identity">
        <span>주문 ${escapeHtml(identity.ordNo || "-")}</span>
        <small>${escapeHtml(identity.sellpiaOrderItemNo || identity.itemNo || "-")}</small>
      </div>
    </div>
    <div class="custom-order-card-section inbound-expected-editor">
      <strong class="custom-order-section-title">입고예정일</strong>
      <label>예정일
        <input type="date" data-inbound-expected-field="inbound_expected_date" value="${escapeHtml(row.inbound.date || "")}" ${disabled}>
      </label>
      <div class="inbound-expected-meta">
        <span>출처 <b>${escapeHtml(customOrderInboundSourceLabel(row.inbound.source))}</b></span>
        <small>${row.inbound.authoritative ? "operation 저장값" : "셀피아 기존값"}</small>
      </div>
    </div>
    <div class="custom-order-card-section inbound-expected-note">
      <strong class="custom-order-section-title">내부 메모</strong>
      <p>${escapeHtml(operation?.internal_memo || "메모 없음")}</p>
      <small>${row.inbound.explicitlyCleared ? "날짜를 지워도 셀피아 기존값은 다시 표시되지 않습니다." : "날짜를 수정하면 수동 입력으로 저장됩니다."}</small>
    </div>
  </article>`;
}

function syncCustomOrdersViewControls() {
  const activeView = state.customOrders.view;
  document.querySelectorAll("[data-custom-orders-view]").forEach((button) => {
    const active = button.dataset.customOrdersView === activeView;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  });
  document.querySelectorAll("[data-custom-orders-toolbar]").forEach((toolbar) => {
    toolbar.hidden = toolbar.dataset.customOrdersToolbar !== activeView;
  });
  document.querySelectorAll("[data-custom-orders-view-panel]").forEach((panel) => {
    panel.hidden = panel.dataset.customOrdersViewPanel !== activeView;
  });
}

function renderCustomOrdersPanel() {
  if (!els.customOrdersList) return;
  const workspace = state.customOrders;
  syncCustomOrdersViewControls();
  if (workspace.loading && !workspace.loaded) {
    renderWorkflowEmpty(els.customOrdersList, "주문제작 데이터를 불러오는 중입니다.");
    return;
  }
  if (workspace.error) {
    renderWorkflowEmpty(els.customOrdersList, workspace.error);
    return;
  }
  if (!workspace.loaded) {
    renderWorkflowEmpty(els.customOrdersList, "주문제작 탭을 열면 데이터를 불러옵니다.");
    return;
  }

  const rows = buildCustomOrderRows({
    operations: workspace.operations,
    currentItems: workspace.currentItems,
    skuSchedules: workspace.skuSchedules,
  });
  const inboundRows = buildInboundExpectedRows({
    operations: workspace.operations,
    currentItems: workspace.currentItems,
    skuSchedules: workspace.skuSchedules,
  });
  if (workspace.view === "inbound") {
    renderSkuInboundScheduleManager();
    const suppliers = customOrderSuppliers(inboundRows);
    if (workspace.inboundSupplier && !suppliers.includes(workspace.inboundSupplier)) workspace.inboundSupplier = "";
    if (els.customOrdersInboundSupplier) {
      els.customOrdersInboundSupplier.innerHTML = `<option value="">전체</option>${suppliers.map((supplier) => `<option value="${escapeHtml(supplier)}">${escapeHtml(supplier)}</option>`).join("")}`;
      els.customOrdersInboundSupplier.value = workspace.inboundSupplier;
    }
    if (els.customOrdersInboundSource) els.customOrdersInboundSource.value = workspace.inboundSource;
    if (els.customOrdersInboundDateFrom) els.customOrdersInboundDateFrom.value = workspace.inboundDateFrom;
    if (els.customOrdersInboundDateTo) els.customOrdersInboundDateTo.value = workspace.inboundDateTo;
    if (els.customOrdersInboundSort) els.customOrdersInboundSort.value = workspace.inboundSort;
    if (els.customOrdersInboundSearch && document.activeElement !== els.customOrdersInboundSearch) els.customOrdersInboundSearch.value = workspace.inboundSearch;
    const filtered = sortInboundExpectedRows(filterInboundExpectedRows(inboundRows, {
      source: workspace.inboundSource,
      supplier: workspace.inboundSupplier,
      dateFrom: workspace.inboundDateFrom,
      dateTo: workspace.inboundDateTo,
      search: workspace.inboundSearch,
    }), workspace.inboundSort);
    if (els.customOrdersCount) els.customOrdersCount.textContent = `${filtered.length}건 / 전체 ${inboundRows.length}건`;
    if (els.customOrdersSummaryText) els.customOrdersSummaryText.textContent = "아래는 SKU 일정이 적용된 주문상품과 수동·셀피아 입고예정일 현황입니다.";
    if (!filtered.length) {
      renderWorkflowEmpty(els.customOrdersList, "현재 필터에 맞는 입고예정일이 없습니다.");
      return;
    }
    els.customOrdersList.innerHTML = filtered.map(renderInboundExpectedRow).join("");
    return;
  }

  const suppliers = customOrderSuppliers(rows);
  if (workspace.supplier && !suppliers.includes(workspace.supplier)) workspace.supplier = "";
  if (els.customOrdersSupplier) {
    els.customOrdersSupplier.innerHTML = `<option value="">전체</option>${suppliers.map((supplier) => `<option value="${escapeHtml(supplier)}">${escapeHtml(supplier)}</option>`).join("")}`;
    els.customOrdersSupplier.value = workspace.supplier;
  }
  if (els.customOrdersStatus) els.customOrdersStatus.value = workspace.status;
  if (els.customOrdersDateCriterion) els.customOrdersDateCriterion.value = workspace.dateCriterion;
  if (els.customOrdersDateFrom) els.customOrdersDateFrom.value = workspace.dateFrom;
  if (els.customOrdersDateTo) els.customOrdersDateTo.value = workspace.dateTo;
  if (els.customOrdersSearch && document.activeElement !== els.customOrdersSearch) els.customOrdersSearch.value = workspace.search;

  const filtered = filterCustomOrderRows(rows, {
    status: workspace.status,
    supplier: workspace.supplier,
    dateCriterion: workspace.dateCriterion,
    dateFrom: workspace.dateFrom,
    dateTo: workspace.dateTo,
    search: workspace.search,
  });
  if (els.customOrdersCount) els.customOrdersCount.textContent = `${filtered.length}건 / 전체 ${rows.length}건`;
  if (els.customOrdersSummaryText) els.customOrdersSummaryText.textContent = "기본 화면은 완료·취소를 제외한 미완료 주문제작 건입니다.";
  if (!filtered.length) {
    renderWorkflowEmpty(els.customOrdersList, "현재 필터에 맞는 주문제작 건이 없습니다.");
    return;
  }
  els.customOrdersList.innerHTML = filtered.map(renderCustomOrderRow).join("");
}

async function loadCustomOrdersData({ force = false } = {}) {
  if (state.customOrders.loading || (state.customOrders.loaded && !force)) return;
  state.customOrders.loading = true;
  state.customOrders.error = "";
  renderCustomOrdersPanel();
  try {
    const [workspace, schedules] = await Promise.all([
      orderItemOperations.loadCustomOrderWorkspace(),
      skuInboundSchedules.loadAllSchedules(),
    ]);
    const scheduledItems = await skuInboundSchedules.loadCurrentItemsForSchedules(schedules);
    const currentItems = [...new Map(
      [...workspace.currentItems, ...scheduledItems]
        .map((item) => [currentItemIdentityKey(item), item]),
    ).values()];
    state.customOrders.operations = workspace.operations;
    state.customOrders.currentItems = currentItems;
    state.customOrders.skuSchedules = schedules;
    state.customOrders.skuSchedulesLoaded = true;
    state.customOrders.loaded = true;
    for (const operation of workspace.operations) mergeOperationState(operation);
  } catch (error) {
    state.customOrders.error = `주문제작 조회 실패: ${error?.message || error}`;
    throw error;
  } finally {
    state.customOrders.loading = false;
    renderCustomOrdersPanel();
  }
}

async function saveCustomOrderPatch(operationId, patch, successMessage) {
  if (!allowWrites) {
    toast("읽기전용입니다. 주문제작 변경은 write=1에서만 저장됩니다.");
    return null;
  }
  const savingKey = `custom-order:${operationId}`;
  if (state.saving.has(savingKey)) return null;
  state.saving.add(savingKey);
  renderCustomOrdersPanel();
  try {
    const saved = await orderItemOperations.updateOperation(operationId, patch);
    mergeOperationState(saved);
    if (successMessage) toast(successMessage);
    return saved;
  } finally {
    state.saving.delete(savingKey);
    renderCustomOrdersPanel();
    renderPickingSurfaces();
  }
}

let skuScheduleXlsxPromise = null;

function ensureSkuScheduleXlsx() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  if (skuScheduleXlsxPromise) return skuScheduleXlsxPromise;
  skuScheduleXlsxPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js";
    script.async = true;
    script.addEventListener("load", () => {
      if (window.XLSX) resolve(window.XLSX);
      else reject(new Error("XLSX 라이브러리를 불러오지 못했습니다."));
    }, { once: true });
    script.addEventListener("error", () => reject(new Error("XLSX 라이브러리를 불러오지 못했습니다.")), { once: true });
    document.head.appendChild(script);
  }).catch((error) => {
    skuScheduleXlsxPromise = null;
    throw error;
  });
  return skuScheduleXlsxPromise;
}

async function mergeScheduledCurrentItems(schedules) {
  const items = await skuInboundSchedules.loadCurrentItemsForSchedules(schedules);
  const merged = new Map(state.customOrders.currentItems.map((item) => [currentItemIdentityKey(item), item]));
  items.forEach((item) => merged.set(currentItemIdentityKey(item), item));
  state.customOrders.currentItems = [...merged.values()];
}

async function saveSkuInboundSchedule(value, successMessage = "SKU 입고예정일을 저장했습니다.") {
  if (!allowWrites) {
    toast("읽기전용입니다. SKU 입고예정일 변경은 write=1에서만 저장됩니다.");
    return null;
  }
  const sku = String(value?.sellpia_sku || "").trim();
  const savingKey = `sku-inbound:${sku}`;
  if (state.saving.has(savingKey)) return null;
  state.saving.add(savingKey);
  renderSkuInboundScheduleManager();
  try {
    const saved = await skuInboundSchedules.upsertSchedule(value);
    mergeSkuInboundScheduleState(saved);
    await mergeScheduledCurrentItems([saved]);
    state.customOrders.skuScheduleImportStatus = successMessage;
    toast(successMessage);
    return saved;
  } finally {
    state.saving.delete(savingKey);
    renderCustomOrdersPanel();
    renderPickingSurfaces();
    if (state.activeTab === "cs") renderCsPanels();
  }
}

async function saveDirectSkuInboundSchedule() {
  const sellpiaSku = String(els.customOrdersSkuInput?.value || "").trim();
  const inboundExpectedDate = String(els.customOrdersSkuDate?.value || "").trim();
  const ownCode = String(els.customOrdersSkuOwnCode?.value || "").trim();
  const saved = await saveSkuInboundSchedule({
    sellpia_sku: sellpiaSku,
    inbound_expected_date: inboundExpectedDate,
    own_code: ownCode || null,
  });
  if (!saved) return;
  if (els.customOrdersSkuInput) els.customOrdersSkuInput.value = "";
  if (els.customOrdersSkuDate) els.customOrdersSkuDate.value = "";
  if (els.customOrdersSkuOwnCode) els.customOrdersSkuOwnCode.value = "";
}

async function saveSkuInboundScheduleRow(rowElement) {
  const sellpiaSku = String(rowElement?.dataset.skuInboundSchedule || "").trim();
  const inboundExpectedDate = String(rowElement?.querySelector('[data-sku-schedule-field="inbound_expected_date"]')?.value || "").trim();
  const ownCode = String(rowElement?.querySelector('[data-sku-schedule-field="own_code"]')?.value || "").trim();
  await saveSkuInboundSchedule({
    sellpia_sku: sellpiaSku,
    inbound_expected_date: inboundExpectedDate,
    own_code: ownCode || null,
  });
}

async function downloadSkuInboundSchedules() {
  const XLSX = await ensureSkuScheduleXlsx();
  const schedules = sortedSkuInboundSchedules();
  const exported = skuInboundScheduleWorkbookRows(schedules);
  const values = [SKU_INBOUND_SCHEDULE_HEADERS, ...exported.map((row) => [
    row[SKU_INBOUND_SCHEDULE_HEADERS[0]],
    row[SKU_INBOUND_SCHEDULE_HEADERS[1]] ? new Date(`${row[SKU_INBOUND_SCHEDULE_HEADERS[1]]}T12:00:00`) : null,
    row[SKU_INBOUND_SCHEDULE_HEADERS[2]],
  ])];
  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.aoa_to_sheet(values, { cellDates: true });
  worksheet["!cols"] = [{ wch: 24 }, { wch: 14 }, { wch: 22 }];
  worksheet["!autofilter"] = { ref: `A1:C${Math.max(1, values.length)}` };
  for (let row = 2; row <= values.length; row += 1) {
    if (worksheet[`A${row}`]) {
      worksheet[`A${row}`].t = "s";
      worksheet[`A${row}`].z = "@";
    }
    if (worksheet[`B${row}`]) worksheet[`B${row}`].z = "yyyy-mm-dd";
    if (worksheet[`C${row}`]) {
      worksheet[`C${row}`].t = "s";
      worksheet[`C${row}`].z = "@";
    }
  }
  XLSX.utils.book_append_sheet(workbook, worksheet, "입고예정일");
  XLSX.writeFile(workbook, `SKU_입고예정일_${todayDateString()}.xlsx`, { bookType: "xlsx", cellDates: true });
  state.customOrders.skuScheduleImportStatus = `${schedules.length}개 SKU를 내려받았습니다.`;
  renderSkuInboundScheduleManager();
}

async function importSkuInboundSchedules(file) {
  if (!file) return;
  if (!allowWrites) {
    toast("읽기전용입니다. 엑셀 업로드는 write=1에서만 저장됩니다.");
    return;
  }
  const XLSX = await ensureSkuScheduleXlsx();
  const workbook = XLSX.read(await file.arrayBuffer(), { type: "array", cellDates: true });
  const sheetName = workbook.SheetNames?.[0];
  if (!sheetName) throw new Error("엑셀의 첫 번째 시트를 찾지 못했습니다.");
  const matrix = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, raw: true, defval: "" });
  const parsed = parseSkuInboundScheduleRows(matrix);
  if (parsed.errors.length) {
    const preview = parsed.errors.slice(0, 3).map((error) => `${error.rowNumber ? `${error.rowNumber}행 ` : ""}${error.message}`).join(" / ");
    state.customOrders.skuScheduleImportStatus = `업로드 중단: ${preview}${parsed.errors.length > 3 ? ` 외 ${parsed.errors.length - 3}건` : ""}`;
    renderSkuInboundScheduleManager();
    throw new Error(state.customOrders.skuScheduleImportStatus);
  }
  if (!parsed.rows.length) throw new Error("업로드할 SKU 일정이 없습니다.");
  if (!window.confirm(`${parsed.rows.length}개 SKU 일정을 추가하거나 같은 SKU의 값을 갱신할까요?`)) return;
  const saved = await skuInboundSchedules.upsertSchedules(parsed.rows);
  saved.forEach(mergeSkuInboundScheduleState);
  await mergeScheduledCurrentItems(saved);
  state.customOrders.skuScheduleImportStatus = `${saved.length}개 SKU 일정을 업로드했습니다.`;
  renderCustomOrdersPanel();
  toast(state.customOrders.skuScheduleImportStatus);
}

function currentItemIdentityKey(item) {
  const identity = orderItemIdentity(item);
  return `${identity.ordNo}::${identity.sellpiaOrderItemNo || identity.itemNo}`;
}

async function saveInboundExpectedDate(rowElement, value) {
  if (!allowWrites) {
    toast("읽기전용입니다. 입고예정일 변경은 write=1에서만 저장됩니다.");
    return null;
  }
  const operationId = rowElement?.dataset.operationId || "";
  if (operationId) {
    return saveCustomOrderPatch(operationId, {
      inbound_expected_date: value,
      inbound_expected_source: "manual",
    }, value ? "입고예정일을 수동 저장했습니다." : "입고예정일을 명시적으로 삭제했습니다.");
  }
  const rowKey = rowElement?.dataset.inboundRowKey || "";
  const currentItem = state.customOrders.currentItems.find((item) => currentItemIdentityKey(item) === rowKey);
  if (!currentItem) throw new Error("입고예정일을 저장할 현재 주문상품을 찾지 못했습니다.");
  const savingKey = `inbound:${rowKey}`;
  if (state.saving.has(savingKey)) return null;
  state.saving.add(savingKey);
  renderCustomOrdersPanel();
  try {
    const saved = await orderItemOperations.upsertOperationForCurrentOrderItem(currentItem, {
      inbound_expected_date: value,
      inbound_expected_source: "manual",
    });
    mergeOperationState(saved);
    toast(value ? "입고예정일을 수동 저장했습니다." : "입고예정일을 명시적으로 삭제했습니다.");
    return saved;
  } finally {
    state.saving.delete(savingKey);
    renderCustomOrdersPanel();
    renderPickingSurfaces();
  }
}

async function onCustomOrderListClick(event) {
  const button = event.target.closest("[data-custom-order-action]");
  if (!button) return;
  const row = button.closest("[data-operation-id]");
  const operationId = row?.dataset.operationId;
  if (!operationId) return;
  const action = button.dataset.customOrderAction;
  if (action === "ordered-today") {
    const orderedOn = todayDateString();
    const currentRow = buildCustomOrderRows({
      operations: state.customOrders.operations,
      currentItems: state.customOrders.currentItems,
      skuSchedules: state.customOrders.skuSchedules,
    }).find((entry) => String(entry.operation?.operation_id || "") === operationId);
    const patch = { custom_ordered_on: orderedOn };
    const autoInboundDate = addCalendarDays(orderedOn, 14);
    if (!currentRow?.inbound?.source && !currentRow?.inbound?.date && autoInboundDate) {
      patch.inbound_expected_date = autoInboundDate;
      patch.inbound_expected_source = "manual";
    }
    await saveCustomOrderPatch(
      operationId,
      patch,
      patch.inbound_expected_date
        ? `업체 주문일과 입고예정일(${patch.inbound_expected_date})을 저장했습니다.`
        : "업체 주문일을 오늘로 저장했습니다.",
    );
  }
  if (action === "received-today") {
    await saveCustomOrderPatch(operationId, { custom_received_on: todayDateString() }, "입고 완료일을 오늘로 저장했습니다.");
  }
  if (action === "cancel") {
    if (!window.confirm("이 주문제작 건을 취소 처리할까요? 기존 날짜와 메모는 유지됩니다.")) return;
    await saveCustomOrderPatch(operationId, { custom_cancelled_at: new Date().toISOString() }, "주문제작을 취소 처리했습니다.");
  }
}

async function onCustomOrderListChange(event) {
  const inboundInput = event.target.closest("[data-inbound-expected-field]");
  if (inboundInput) {
    const row = inboundInput.closest("[data-inbound-row-key]");
    if (!row) return;
    const value = String(inboundInput.value || "").trim() || null;
    await saveInboundExpectedDate(row, value);
    return;
  }
  const input = event.target.closest("[data-custom-order-field]");
  if (!input) return;
  const row = input.closest("[data-operation-id]");
  const operationId = row?.dataset.operationId;
  if (!operationId) return;
  const field = input.dataset.customOrderField;
  const value = String(input.value || "").trim() || null;
  if (field === "inbound_expected_date") {
    await saveCustomOrderPatch(operationId, {
      inbound_expected_date: value,
      inbound_expected_source: "manual",
    }, value ? "입고예정일을 수동 저장했습니다." : "입고예정일을 명시적으로 삭제했습니다.");
    return;
  }
  if (["custom_ordered_on", "custom_received_on", "internal_memo"].includes(field)) {
    await saveCustomOrderPatch(operationId, { [field]: value }, "주문제작 정보를 저장했습니다.");
  }
}

function showCustomOrdersError(error) {
  console.error(error);
  state.customOrders.error = `주문제작 처리 실패: ${error?.message || error}`;
  state.customOrders.loading = false;
  renderCustomOrdersPanel();
  toast(state.customOrders.error);
}

async function loadCsCaseData() {
  state.csCasesLoading = true;
  state.csCaseError = "";
  render();
  try {
    const [cases, candidates, operations, schedules] = await Promise.all([
      csCases.loadCsCases(),
      state.csManualCandidates.length ? Promise.resolve(state.csManualCandidates) : csCases.loadManualCsCandidates(),
      orderItemOperations.loadAllOperations(),
      state.customOrders.skuSchedulesLoaded
        ? Promise.resolve(state.customOrders.skuSchedules)
        : skuInboundSchedules.loadAllSchedules(),
    ]);
    state.csCases = cases;
    state.csManualCandidates = candidates;
    state.orderItemOperations = operations;
    state.orderItemOperationsLoaded = true;
    state.customOrders.skuSchedules = schedules;
    state.customOrders.skuSchedulesLoaded = true;
    // The candidate source contains every currently readable order.  Build a
    // receipt-active calendar from it once so the CS screen and Alimtalk CSV
    // use the same business-day definition: dates with at least one receipt.
    state.csReceiptBusinessDates = receiptBusinessDayKeys(candidates.map((candidate) => candidate.order));
    state.csReceiptBusinessDayCache = new Map();
    // The candidate load already contains the current order/item rows needed
    // by the CS detail.  Use its memo2 baseline immediately so a slow
    // supplemental shortage lookup cannot block the full detail panel.
    state.csCaseContexts = { orders: new Map(), items: new Map() };
    state.csOpenShortageItemKeys = openShortageItemKeys({ candidates });
    state.csCasesLoaded = true;
    // A shortage row is supplemental legacy coverage only.  It must never
    // hold the main CS UI in loading state after its primary item baseline is
    // ready.
    csCases.loadOpenShortageItemKeys(candidates)
      .then((keys) => {
        state.csOpenShortageItemKeys = keys;
        if (state.activeTab === "cs") renderCsPanels();
      })
      .catch((error) => console.warn("supplemental CS shortage load failed", error));
  } catch (error) {
    state.csCaseError = `CS 케이스 조회 실패: ${error?.message || error}`;
    console.warn("CS case load failed", error);
  } finally {
    state.csCasesLoading = false;
    render();
  }
}

async function loadManualCsCandidates() {
  if (state.csManualCandidates.length) return;
  state.csCasesLoading = true;
  render();
  try {
    const [candidates, operations, schedules] = await Promise.all([
      csCases.loadManualCsCandidates(),
      state.orderItemOperationsLoaded ? Promise.resolve(state.orderItemOperations) : orderItemOperations.loadAllOperations(),
      state.customOrders.skuSchedulesLoaded
        ? Promise.resolve(state.customOrders.skuSchedules)
        : skuInboundSchedules.loadAllSchedules(),
    ]);
    state.csManualCandidates = candidates;
    state.orderItemOperations = operations;
    state.orderItemOperationsLoaded = true;
    state.customOrders.skuSchedules = schedules;
    state.customOrders.skuSchedulesLoaded = true;
    state.csReceiptBusinessDates = receiptBusinessDayKeys(state.csManualCandidates.map((candidate) => candidate.order));
    state.csReceiptBusinessDayCache = new Map();
  } catch (error) {
    state.csCaseError = `수동 CS 원본 조회 실패: ${error?.message || error}`;
    console.warn("manual CS source load failed", error);
  } finally {
    state.csCasesLoading = false;
    render();
  }
}

function selectedCsRenderedRow() {
  return selectedCsRenderedGroup();
}

function csDetailInput(name, scope = els.csDetail) {
  return scope?.querySelector(`[data-cs-case-field="${name}"]`);
}

function csItemIdentity(row) {
  return {
    ordNo: String(row?.caseRow?.ord_no || row?.order?.ord_no || row?.item?.ord_no || "").trim(),
    itemNo: String(row?.caseRow?.item_no || row?.item?.item_no || "").trim(),
    sellpiaOrderItemNo: String(row?.caseRow?.sellpia_order_item_no || row?.item?.sellpia_order_item_no || "").trim(),
  };
}

async function saveCsOrderScheduledDate(ordNo, value, { silent = false } = {}) {
  if (!allowWrites) {
    toast("Read-only mode: add write=1 to save the outbound scheduled date.");
    return;
  }
  const normalizedOrdNo = String(ordNo || "").trim();
  if (!normalizedOrdNo) throw new Error("Missing order number for outbound scheduled date.");
  const scheduledHistory = normalizeAlimtalkSendLog(value, todayDateString()) || null;
  const { data, error } = await db
    .from("orders")
    .update({ sellpia_outbound_scheduled_date: scheduledHistory })
    .eq("ord_no", normalizedOrdNo)
    .select("ord_no,sellpia_outbound_scheduled_date");
  if (error) throw error;
  if (!data || data.length !== 1) throw new Error(`Order not found for outbound scheduled date (${normalizedOrdNo}).`);
  const nextValue = data[0].sellpia_outbound_scheduled_date || "";
  const current = state.csCaseContexts?.orders?.get(normalizedOrdNo);
  if (current) current.sellpia_outbound_scheduled_date = nextValue;
  for (const candidate of state.csManualCandidates || []) {
    if (String(candidate?.order?.ord_no || "") === normalizedOrdNo) candidate.order.sellpia_outbound_scheduled_date = nextValue;
  }
  for (const invoice of allWorkflowInvoices()) {
    if (String(invoice?.orderGroupNo || "") !== normalizedOrdNo || !invoice.raw) continue;
    invoice.raw.sellpia_outbound_scheduled_date = nextValue;
  }
  if (!silent) toast("알림톡 발송로그 저장");
  return nextValue;
}

async function appendCsOrderScheduledHistory(ordNo, entry) {
  const normalizedOrdNo = String(ordNo || "").trim();
  if (!normalizedOrdNo || !String(entry || "").trim()) return "";
  const { data, error } = await db
    .from("orders")
    .select("ord_no,sellpia_outbound_scheduled_date")
    .eq("ord_no", normalizedOrdNo);
  if (error) throw error;
  if (!data || data.length !== 1) throw new Error(`Order not found for outbound scheduled history (${normalizedOrdNo}).`);
  const nextValue = appendAlimtalkSendLog(data[0].sellpia_outbound_scheduled_date, entry, todayDateString());
  await saveCsOrderScheduledDate(normalizedOrdNo, nextValue, { silent: true });
  return nextValue;
}

async function saveCsItemConfirmedDate(row, value) {
  if (!allowWrites) {
    toast("Read-only mode: add write=1 to save the inbound expected date.");
    return;
  }
  const { ordNo, itemNo, sellpiaOrderItemNo } = csItemIdentity(row);
  if (!ordNo || (!itemNo && !sellpiaOrderItemNo) || !row?.item) throw new Error("Missing item key for inbound expected date.");
  const confirmedDate = String(value || "").trim() || null;
  const operation = await orderItemOperations.upsertOperationForCurrentOrderItem(row.item, {
    inbound_expected_date: confirmedDate,
    inbound_expected_source: "manual",
  });
  const existingIndex = state.orderItemOperations.findIndex((entry) => entry.operation_id === operation.operation_id);
  if (existingIndex >= 0) state.orderItemOperations.splice(existingIndex, 1, operation);
  else state.orderItemOperations.push(operation);
  state.orderItemOperationsLoaded = true;
  toast("입고예정일 저장");
}

async function recordAlimtalkSendScheduledDate(batchId) {
  const items = await alimtalkSends.loadBatchItems(batchId);
  const templateKeysByOrder = new Map();
  for (const item of items) {
    const ordNo = String(item?.ord_no || "").trim();
    const templateKey = String(item?.template_key || "").trim();
    if (!ordNo || !templateKey) continue;
    if (!templateKeysByOrder.has(ordNo)) templateKeysByOrder.set(ordNo, new Set());
    templateKeysByOrder.get(ordNo).add(templateKey);
  }
  for (const [ordNo, templateKeys] of templateKeysByOrder) {
    for (const templateKey of templateKeys) {
      const logCode = alimtalkSendLogCode(templateKey);
      if (logCode) await appendCsOrderScheduledHistory(ordNo, logCode);
    }
  }
  return templateKeysByOrder.size;
}

async function excludeAutomaticCsAfterInspectionHoldRelease(invoice) {
  const ordNo = String(invoice?.orderGroupNo || "").trim();
  if (!ordNo) return 0;
  const openShortageItems = (invoice.items || []).filter((item) => itemHasOpenWorkflowShortage(invoice, item));
  if (openShortageItems.length) return 0;
  const pendingAutoCases = (state.csCases || []).filter((row) => (
    String(row?.ord_no || "") === ordNo && row?.source === "auto" && row?.status === "pending"
  ));
  const operations = pendingAutoCases.map((row) => csCases.excludeCsCase(row.id));
  if (!operations.length) return 0;
  const results = await Promise.all(operations);
  await loadCsCaseData();
  return results.length;
}

async function reopenAutomaticCsAfterInspectionHoldCreated(invoice) {
  const ordNo = String(invoice?.orderGroupNo || "").trim();
  if (!ordNo) return 0;
  const openShortageItems = (invoice.items || []).filter((item) => itemHasOpenWorkflowShortage(invoice, item));
  const operations = openShortageItems
    .map((item) => String(item?.raw?.item_no || item?.sellpiaItemNo || "").trim())
    .filter(Boolean)
    .map((itemNo) => csCases.reopenExcludedAutoShortageCsCase({ ordNo, itemNo }));
  if (!operations.length) return 0;
  const results = await Promise.all(operations);
  const reopenedCount = results.filter((result) => result?.reopened).length;
  if (reopenedCount) await loadCsCaseData();
  return reopenedCount;
}

function findCsWorkflowItem(row) {
  const { ordNo, itemNo, sellpiaOrderItemNo } = csItemIdentity(row);
  for (const invoice of allWorkflowInvoices()) {
    if (String(invoice?.orderGroupNo || "") !== ordNo) continue;
    const matched = (invoice.items || []).find((item) => {
      const rawItemNo = String(item?.raw?.item_no || item?.sellpiaItemNo || "").trim();
      const rawSellpiaItemNo = String(item?.raw?.sellpia_order_item_no || "").trim();
      return (itemNo && rawItemNo === itemNo) || (!itemNo && sellpiaOrderItemNo && rawSellpiaItemNo === sellpiaOrderItemNo);
    });
    if (matched) return { invoice, item: matched };
  }
  return { invoice: null, item: null };
}

function csCancellationState(row) {
  const { invoice, item } = findCsWorkflowItem(row);
  const invoiceCancelled = invoiceIsCancelled(invoice);
  const itemCancelled = itemIsIndividuallyCancelled(invoice, item);
  return {
    invoice,
    item,
    invoiceCancelled,
    itemCancelled,
    cancelled: invoiceCancelled || itemCancelled,
  };
}

function csEffectiveStatus(row) {
  return csCancellationState(row).cancelled ? "excluded" : row?.caseRow?.status;
}

function csGroupCancellationState(group) {
  const invoice = allWorkflowInvoices().find(
    (candidate) => String(candidate?.orderGroupNo || "") === String(group?.ordNo || ""),
  ) || null;
  const invoiceCancelled = invoiceIsCancelled(invoice);
  const cancelledItems = (group?.items || []).filter((row) => csCancellationState(row).cancelled).length;
  return { invoice, invoiceCancelled, cancelledItems };
}

async function toggleCsPartialShippingHold(row) {
  if (!allowWrites) {
    toast("읽기전용입니다. URL에 write=1을 붙여 부분보류를 저장할 수 있습니다.");
    return;
  }
  const { invoice, item } = findCsWorkflowItem(row);
  if (!invoice || !item) {
    throw new Error("부분보류를 저장할 정확한 상품행을 찾지 못했습니다.");
  }
  const itemKey = itemStateKey(invoice, item);
  if (state.saving.has(itemKey)) return;

  const previous = isHold(item);
  patchLocalPickingState(invoice, item, { isHold: !previous });
  renderWorkflowSurfacesIfVisible();
  try {
    await savePickingRow(invoice, item);
    toast(previous ? "상품행 부분보류를 해제했습니다." : "상품행 부분보류를 처리했습니다.");
  } catch (error) {
    patchLocalPickingState(invoice, item, { isHold: previous });
    renderWorkflowSurfacesIfVisible();
    throw error;
  }
}

async function releaseInspectionPartialShippingHold(orderGroupNo, sellpiaItemNo) {
  if (!allowWrites) {
    toast("읽기전용입니다. URL에 write=1을 붙여 부분보류를 저장할 수 있습니다.");
    return;
  }
  const invoice = allWorkflowInvoices().find((candidate) => candidate.orderGroupNo === orderGroupNo);
  const item = invoice?.items?.find((candidate) => candidate.sellpiaItemNo === sellpiaItemNo);
  if (!invoice || !item) {
    throw new Error("부분보류를 해제할 정확한 상품행을 찾지 못했습니다.");
  }
  if (itemIsEffectivelyCancelled(invoice, item)) {
    toast("취소된 상품은 CS 탭에서 취소 해제 후 수정할 수 있습니다.");
    return;
  }
  if (!isHold(item)) return;

  const itemKey = itemStateKey(invoice, item);
  if (state.saving.has(itemKey)) return;

  patchLocalPickingState(invoice, item, { isHold: false });
  renderWorkflowSurfacesIfVisible();
  try {
    await savePickingRow(invoice, item);
    toast("상품행 부분보류를 해제했습니다.");
  } catch (error) {
    patchLocalPickingState(invoice, item, { isHold: true });
    renderWorkflowSurfacesIfVisible();
    throw error;
  }
}

async function saveCsManagementFields(row, scope = els.csDetail, { renderAfter = true } = {}) {
  if (!allowWrites) {
    toast("읽기전용입니다. URL에 write=1을 붙여야 관리메모를 저장할 수 있습니다.");
    return;
  }
  if (!row?.item) throw new Error("관리메모를 저장할 상품행을 찾지 못했습니다.");
  const { ordNo, itemNo, sellpiaOrderItemNo } = csItemIdentity(row);
  if (!ordNo || (!itemNo && !sellpiaOrderItemNo)) throw new Error("관리메모 저장에 필요한 상품행키가 없습니다.");
  const memo1Field = scope?.querySelector("[data-cs-management-field='memo1']");
  const memo2Field = scope?.querySelector("[data-cs-management-field='memo2']");

  const previousMemo1 = String(row.item.o_shop_memo ?? row.item.shop_memo ?? row.item.memo1 ?? "").trim();
  const previousMemo2 = String(row.item.o_shop_memo2 ?? row.item.shop_memo2 ?? row.item.memo2 ?? "").trim();
  const memo1 = memo1Field ? String(memo1Field.value || "").trim() : previousMemo1;
  const memo2 = memo2Field ? String(memo2Field.value || "").trim() : previousMemo2;
  const memo1Changed = Boolean(memo1Field) && memo1 !== previousMemo1;
  const memo2Changed = Boolean(memo2Field) && memo2 !== previousMemo2;
  if (!memo1Changed && !memo2Changed) {
    toast("변경된 관리메모가 없습니다.");
    return;
  }

  const { invoice, item } = findCsWorkflowItem(row);
  const shipmentInvoice = shipmentScopeForInvoice(invoice);
  if (memo1Changed) {
    if (!invoice) throw new Error("관리메모1을 송장 전체에 저장할 작업 데이터를 찾지 못했습니다.");
    await saveDrawerForInvoice(shipmentInvoice, memo1);
    row.item.o_shop_memo = memo1;
    row.item.shop_memo = memo1;
    row.item.memo1 = memo1;
  }

  if (memo2Changed) {
    if (!invoice || !item) throw new Error("관리메모2를 미송 상태에 연결할 작업 데이터를 찾지 못했습니다.");
    const saved = await setShortageQty(invoice.orderGroupNo, item.sellpiaItemNo, memo2, {
      shippingHoldInvoice: shipmentInvoice,
      throwOnError: true,
    });
    if (!saved) throw new Error("관리메모2와 미송 상태를 저장하지 못했습니다.");
    row.item.o_shop_memo2 = memo2;
    row.item.shop_memo2 = memo2;
    row.item.memo2 = memo2;
  }

  if (invoice && item) {
    patchLocalItemManagementMemos(invoice.orderGroupNo, item.sellpiaItemNo, {
      ...(memo2Changed ? { memo2 } : {}),
    });
  }
  toast("관리메모1은 송장 전체에, 관리메모2는 상품행에 저장했습니다.");
  if (renderAfter) renderCsPanels();
}

async function saveCsCaseOrderMemo(row, scope = els.csDetail) {
  if (!allowWrites) {
    toast("읽기전용입니다. URL에 write=1을 붙여야 주문메모를 저장할 수 있습니다.");
    return;
  }
  const ordNo = String(row?.caseRow?.ord_no || row?.order?.ord_no || "").trim();
  const itemNo = String(row?.caseRow?.item_no || row?.item?.item_no || "").trim();
  const sellpiaOrderItemNo = String(row?.caseRow?.sellpia_order_item_no || row?.item?.sellpia_order_item_no || "").trim();
  if (!ordNo || (!itemNo && !sellpiaOrderItemNo)) throw new Error("CS 주문메모 저장에 필요한 주문번호 또는 상품행키가 없습니다.");
  const value = String(scope?.querySelector("[data-cs-case-order-memo]")?.value || "");
  if (value === String(row?.item?.order_memo ?? "")) return;
  await updateOrderItemOrderMemoExact({
    ordNo,
    itemNo,
    sellpiaOrderItemNo,
    patch: { order_memo: value, order_memo_updated_at: new Date().toISOString() },
  });
  if (row.item) {
    row.item.order_memo = value;
    row.item.order_memo_updated_at = new Date().toISOString();
  }
  patchLocalOrderMemoByExact(ordNo, itemNo, value, sellpiaOrderItemNo);
  toast("상품행 주문메모 저장");
}

async function saveCsOrderMemosBeforeCancellation(cancelButton) {
  const action = String(cancelButton?.dataset?.csCancelAction || "");
  const itemAction = action.startsWith("item-");
  const root = itemAction
    ? cancelButton?.closest(".cs-item-card, .cs-item-row")
    : cancelButton?.closest(".cs-source-order-section, .cs-detail-card") || els.csDetail;
  const scopes = itemAction
    ? [root].filter(Boolean)
    : Array.from(root?.querySelectorAll(".cs-item-card[data-cs-row-key], .cs-item-row[data-cs-row-key]") || []);

  if (!scopes.length) throw new Error("취소 전에 저장할 주문메모 상품행을 찾지 못했습니다.");
  for (const scope of scopes) {
    const row = selectedCsItemRow(scope.dataset.csRowKey || "");
    if (!row) throw new Error("취소 전에 주문메모를 저장할 상품행을 찾지 못했습니다.");
    await saveCsCaseOrderMemo(row, scope);
  }
}

async function runCsCancellationAction(cancelButton) {
  if (!cancelButton || cancelButton.disabled) return;
  cancelButton.disabled = true;
  try {
    await saveCsOrderMemosBeforeCancellation(cancelButton);
    const action = cancelButton.dataset.csCancelAction || "";
    if (action.startsWith("order-")) {
      await toggleCsOrderCancellation(cancelButton.dataset.csOrderGroup || "", action === "order-reopen");
    } else {
      const row = selectedCsItemRow(cancelButton.dataset.csRowKey || "");
      if (!row) throw new Error("취소 처리할 상품행을 찾지 못했습니다.");
      await toggleCsItemCancellation(row, action === "item-reopen");
    }
  } finally {
    if (cancelButton.isConnected) cancelButton.disabled = false;
  }
}

async function saveCsTemplateOverride(row, scope = els.csDetail) {
  if (!allowWrites) {
    toast("읽기전용입니다. URL에 write=1을 붙여야 알림톡 템플릿을 저장할 수 있습니다.");
    return;
  }
  const ordNo = csRowOrderNo(row);
  const itemNo = String(row?.item?.item_no || row?.caseRow?.item_no || "").trim();
  const sellpiaOrderItemNo = String(row?.item?.sellpia_order_item_no || row?.caseRow?.sellpia_order_item_no || "").trim();
  if (!ordNo || !itemNo) throw new Error("템플릿 저장에는 주문번호와 상품행번호가 필요합니다.");
  const templateField = csDetailInput("alimtalk_template", scope);
  if (!templateField) throw new Error("알림톡 템플릿 선택칸을 찾지 못했습니다.");
  const receiptDate = String(row?.order?.receipt_date || row?.item?.receipt_date || row?.caseRow?.receipt_date || "").trim();
  const result = await csCases.upsertTemplateOverride({
    ordNo,
    itemNo,
    sellpiaOrderItemNo,
    invNo: row?.order?.inv_no || row?.item?.inv_no || row?.caseRow?.inv_no || "",
    receiptDate,
    alimtalkTemplate: templateField.value || "",
    alimtalkExcluded: csAlimtalkExcluded(row),
  });
  if (result.caseRow) {
    state.csCases = [
      ...state.csCases.filter((entry) => Number(entry.id) !== Number(result.caseRow.id)),
      result.caseRow,
    ];
  }
  toast(result.caseRow?.alimtalk_template ? "알림톡 템플릿을 저장했습니다." : "알림톡 템플릿 선택을 해제했습니다.");
  renderCsPanels();
}

async function saveCsAlimtalkExcluded(row, excluded) {
  if (!allowWrites) {
    toast("읽기전용입니다. URL에 write=1을 붙여야 알림톡 제외 상태를 저장할 수 있습니다.");
    return;
  }
  const ordNo = csRowOrderNo(row);
  const itemNo = String(row?.item?.item_no || row?.caseRow?.item_no || "").trim();
  const sellpiaOrderItemNo = String(row?.item?.sellpia_order_item_no || row?.caseRow?.sellpia_order_item_no || "").trim();
  if (!ordNo || !itemNo) throw new Error("알림톡 제외 저장에는 주문번호와 상품행번호가 필요합니다.");
  const receiptDate = String(row?.order?.receipt_date || row?.item?.receipt_date || row?.caseRow?.receipt_date || "").trim();
  const result = await csCases.upsertTemplateOverride({
    ordNo,
    itemNo,
    sellpiaOrderItemNo,
    invNo: row?.order?.inv_no || row?.item?.inv_no || row?.caseRow?.inv_no || "",
    receiptDate,
    alimtalkTemplate: row?.templateOverride?.alimtalk_template || "",
    alimtalkExcluded: Boolean(excluded),
  });
  if (result.caseRow) {
    state.csCases = [
      ...state.csCases.filter((entry) => Number(entry.id) !== Number(result.caseRow.id)),
      result.caseRow,
    ];
  }
  toast(excluded ? "알림톡 제외로 저장했습니다." : "알림톡 대상에 다시 포함했습니다.");
  renderCsPanels();
}

function patchLocalOrderMemoByExact(ordNo, itemNo, value, sellpiaOrderItemNo = "") {
  for (const invoice of allWorkflowInvoices()) {
    if (String(invoice?.orderGroupNo || "") !== String(ordNo || "")) continue;
    for (const item of invoice.items || []) {
      const rawItemNo = String(item?.raw?.item_no || item?.sellpiaItemNo || "");
      const rawRegularNo = String(item?.raw?.sellpia_order_item_no || "");
      const matches = itemNo ? rawItemNo === String(itemNo) : rawRegularNo === String(sellpiaOrderItemNo);
      if (!matches) continue;
      if (!item.raw) item.raw = {};
      item.raw.order_memo = value;
      item.raw.order_memo_updated_at = new Date().toISOString();
    }
  }
}

async function saveCsCaseFields(caseId, row, scope, { renderAfter = true } = {}) {
  if (!allowWrites) {
    toast("읽기전용입니다. URL에 write=1을 붙여야 CS 케이스를 저장할 수 있습니다.");
    return;
  }
  const current = row?.caseRow;
  if (!current || Number(current.id) !== Number(caseId)) throw new Error("선택한 CS 케이스를 찾지 못했습니다.");
  const caseType = String(csDetailInput("case_type", scope)?.value || current.case_type || "general").trim();
  const basisDate = String(
    csDetailInput("basis_date", scope)?.value
      || current.basis_date
      || current.receipt_date
      || row?.order?.receipt_date
      || row?.item?.receipt_date
      || "",
  ).trim() || null;
  const assignedField = csDetailInput("assigned_to", scope);
  const assignedTo = assignedField ? String(assignedField.value || "").trim() || null : current.assigned_to || null;
  const templateField = csDetailInput("alimtalk_template", scope);
  const patch = {
    case_type: caseType,
    basis_date: basisDate,
    basis_date_source: basisDate !== (current.basis_date || null) ? "manual" : current.basis_date_source,
    assigned_to: assignedTo,
    updated_by: null,
  };
  if (current.source === "auto" && templateField) patch.alimtalk_template = String(templateField.value || "").trim() || null;
  const next = await csCases.updateCsCase(caseId, patch);
  state.csCases = state.csCases.map((entry) => (entry.id === next.id ? next : entry));
  state.selectedCsKey = `order:${String(next.ord_no || row.order?.ord_no || "")}`;
  toast("CS 케이스 저장");
  if (renderAfter) renderCsPanels();
}

async function saveCsItemCard(caseId, row, scope) {
  if (!allowWrites) {
    toast("읽기전용입니다. URL에 write=1을 붙여야 CS 정보를 저장할 수 있습니다.");
    return;
  }
  await saveCsManagementFields(row, scope, { renderAfter: false });
  await saveCsCaseOrderMemo(row, scope);
  await saveCsCaseFields(caseId, row, scope, { renderAfter: false });
  renderCsPanels();
}

async function createManualCsCaseFromDetail(itemNo, row, scope) {
  if (!allowWrites) {
    toast("읽기전용입니다. URL에 write=1을 붙여야 수동 CS를 추가할 수 있습니다.");
    return;
  }
  if (!row?.item || String(row.item.item_no || "") !== String(itemNo || "")) throw new Error("수동 추가할 상품행을 찾지 못했습니다.");
  const caseType = "general";
  await saveCsManagementFields(row, scope, { renderAfter: false });
  await saveCsCaseOrderMemo(row, scope);
  const receiptDate = String(row.order?.receipt_date || row.item?.receipt_date || "").trim();
  const basisDate = String(csDetailInput("basis_date", scope)?.value || receiptDate || "").trim();
  const result = await csCases.createManualCsCase({
    ordNo: row.order?.ord_no,
    itemNo: row.item?.item_no,
    sellpiaOrderItemNo: row.item?.sellpia_order_item_no,
    invNo: row.order?.inv_no || row.item?.inv_no,
    receiptDate,
    caseType,
    basisDate,
    basisDateSource: basisDate && basisDate !== receiptDate ? "manual" : "receipt_date",
    assignedTo: csDetailInput("assigned_to", scope)?.value || "",
  });
  if (result.created) {
    await appendCsOrderScheduledHistory(
      result.caseRow.ord_no || row.order?.ord_no,
      alimtalkSendLogCode("manual"),
    );
  }
  await loadCsCaseData();
  state.csMode = "cases";
  state.csStatusFilter = result.caseRow.status || "pending";
  state.selectedCsKey = `order:${String(result.caseRow.ord_no || row.order?.ord_no || "")}`;
  toast(
    result.created
      ? "수동 CS 케이스 추가"
      : result.reopened
        ? "제외된 별도 CS를 다시 진행으로 복구했습니다."
        : "이미 진행 중인 별도 CS 케이스가 있습니다."
  );
  renderCsPanels();
}

async function registerAutoShortageCsCase(row, scope) {
  if (!allowWrites) {
    toast("읽기전용입니다. URL에 write=1을 붙여야 자동 CS 케이스를 저장할 수 있습니다.");
    return;
  }
  if (!row?.virtualAutoCase || !row?.item) throw new Error("자동 등록할 미송 상품행을 찾지 못했습니다.");
  await saveCsManagementFields(row, scope, { renderAfter: false });
  await saveCsCaseOrderMemo(row, scope);
  const receiptDate = String(row.order?.receipt_date || row.item?.receipt_date || "").trim();
  const result = await csCases.createAutoShortageCsCase({
    ordNo: row.order?.ord_no || row.caseRow?.ord_no,
    itemNo: row.item?.item_no,
    sellpiaOrderItemNo: row.item?.sellpia_order_item_no,
    invNo: row.order?.inv_no || row.item?.inv_no,
    receiptDate,
    basisDate: receiptDate,
    basisDateSource: "receipt_date",
    alimtalkTemplate: csDetailInput("alimtalk_template", scope)?.value || "",
  });
  await loadCsCaseData();
  state.selectedCsKey = `order:${String(result.caseRow.ord_no || row.order?.ord_no || "")}`;
  toast(result.created ? "미송 자동 CS 케이스를 저장했습니다." : "이미 저장된 미송 CS 케이스입니다.");
  renderCsPanels();
}

async function changeCsCaseStatus(caseId, action) {
  if (!allowWrites) {
    toast("읽기전용입니다. URL에 write=1을 붙여야 상태를 변경할 수 있습니다.");
    return;
  }
  const next = action === "resolve"
    ? await csCases.resolveCsCase(caseId)
    : action === "exclude"
      ? await csCases.excludeCsCase(caseId)
      : await csCases.reopenCsCase(caseId);
  // 별도 CS 코드(ㅂㅂ)는 실제 수동 등록 시에만 주문 공통 이력에 남긴다.
  // 제외·해결·재개는 케이스의 현재 상태만 바꾸며, 같은 이력을 다시 누적하지 않는다.
  state.csCases = state.csCases.map((entry) => (entry.id === next.id ? next : entry));
  state.selectedCsKey = `order:${String(next.ord_no || "")}`;
  toast(`CS 케이스 ${csStatusLabel(next.status)}`);
  renderCsPanels();
}

let activePanelRenderTimer = 0;

function renderActivePanelSoon(delayMs = 120, options = {}) {
  window.clearTimeout(activePanelRenderTimer);
  activePanelRenderTimer = window.setTimeout(() => {
    activePanelRenderTimer = 0;
    renderActivePanel(options);
  }, delayMs);
}

function renderPickingSurfaces() {
  renderMetrics();
  renderGroups();
  renderOrderList();
  renderTray();
}

function mergeOperationState(operation) {
  if (!operation?.operation_id) return;
  const mergeInto = (rows) => {
    const index = rows.findIndex((entry) => entry.operation_id === operation.operation_id);
    if (index >= 0) rows.splice(index, 1, operation);
    else rows.push(operation);
  };
  mergeInto(state.orderItemOperations);
  if (state.customOrders.loaded) mergeInto(state.customOrders.operations);
}

async function loadPickingOperationData(orderNos) {
  const operations = await orderItemOperations.loadOperationsForOrders(orderNos);
  const scopedOrders = new Set((orderNos || []).map((value) => String(value || "").trim()).filter(Boolean));
  state.orderItemOperations = [
    ...state.orderItemOperations.filter((operation) => !scopedOrders.has(String(operation?.ord_no || "").trim())),
    ...operations,
  ];
  if (state.activeTab === "picking") renderPickingSurfaces();
}

let pickingSurfaceRenderTimer = 0;

function schedulePickingSurfaces(delayMs = 3000) {
  window.clearTimeout(pickingSurfaceRenderTimer);
  const run = () => {
    pickingSurfaceRenderTimer = 0;
    renderPickingSurfaces();
  };
  pickingSurfaceRenderTimer = window.setTimeout(() => {
    if ("requestIdleCallback" in window) {
      window.requestIdleCallback(run, { timeout: 1200 });
      return;
    }
    run();
  }, delayMs);
}

function renderWorkflowSurfaces() {
  renderMetrics();
  if (state.activeTab === "dashboard") renderDashboard();
  if (state.activeTab === "shortage") renderShortagePanels();
  if (state.activeTab === "inspection") renderInspectionPanels();
  if (state.activeTab === "cs") renderCsPanels();
  if (state.activeTab === "custom-orders") renderCustomOrdersPanel();
  if (state.activeTab === "completed") renderCompletedPanels();
}

function renderWorkflowSurfacesIfVisible() {
  if (["dashboard", "shortage", "inspection", "cs", "custom-orders", "completed"].includes(state.activeTab)) {
    renderActivePanel();
    return;
  }
  renderMetrics();
}

function findInvoiceAndItem(orderGroupNo, sellpiaItemNo) {
  const invoices = [
    ...(state.viewModel?.invoices || []),
    ...(state.workflowQueues?.viewModel?.invoices || []),
    ...(state.workflowQueues?.inspectionInvoices || []),
    ...(state.workflowQueues?.inspectionCompletedInvoices || []),
  ];
  const invoice = invoices.find((row) => row.orderGroupNo === orderGroupNo);
  const item = invoice?.items.find((row) => row.sellpiaItemNo === sellpiaItemNo);
  return { invoice, item };
}

function patchLocalPickingState(invoice, item, patch) {
  const orderGroupNo = String(invoice?.orderGroupNo || "").trim();
  const sellpiaItemNo = String(item?.sellpiaItemNo || "").trim();
  const patchedItems = new Set();
  const applyPatch = (targetInvoice, targetItem) => {
    if (!targetItem?.pickingState) {
      targetItem.pickingState = {
        orderGroupNo: targetInvoice?.orderGroupNo || orderGroupNo,
        sellpiaItemNo: targetItem?.sellpiaItemNo || sellpiaItemNo,
        key: itemStateKey(targetInvoice, targetItem),
        isPicked: false,
        shortageQty: 0,
        drawerMemo: "",
        isHold: false,
        status: "",
        raw: null,
      };
    }
    Object.assign(targetItem.pickingState, patch);
    patchedItems.add(targetItem);
  };

  // 피킹·검품·CS는 동일 주문을 각 화면 모델에 사본으로 들고 있을 수 있다.
  // 부분보류는 주문 전체가 아닌 같은 주문그룹 + 상품행에만 즉시 반영한다.
  if (orderGroupNo && sellpiaItemNo) {
    allWorkflowInvoices().forEach((candidateInvoice) => {
      if (String(candidateInvoice?.orderGroupNo || "").trim() !== orderGroupNo) return;
      (candidateInvoice.items || []).forEach((candidateItem) => {
        if (String(candidateItem?.sellpiaItemNo || "").trim() !== sellpiaItemNo) return;
        if (!patchedItems.has(candidateItem)) applyPatch(candidateInvoice, candidateItem);
      });
    });
  }

  if (!patchedItems.has(item)) applyPatch(invoice, item);
}

function itemDataSelector(invoice, item) {
  const orderGroupNo = String(invoice?.orderGroupNo || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const sellpiaItemNo = String(item?.sellpiaItemNo || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `[data-order-group="${orderGroupNo}"][data-item-no="${sellpiaItemNo}"]`;
}

function paintPickingItemState(invoice, item) {
  const picked = isPicked(item);
  const shortage = shortageQty(item);
  const selector = itemDataSelector(invoice, item);
  const card = els.orderList?.querySelector(`.picking-item-card${selector}, .gold-item-row${selector}`);
  if (card) {
    card.classList.toggle("is-picked", picked);
    card.classList.toggle("has-shortage", shortage > 0);
    card.classList.toggle("has-hold", isHold(item));
    const check = card.querySelector("[data-action='toggle']");
    if (check) {
      check.classList.toggle("checked", picked);
      check.textContent = picked ? "✓" : "";
    }
    const shortageValue = card.querySelector(".shortage-value");
    if (shortageValue) shortageValue.textContent = String(shortage);
    const shortageInput = card.querySelector(".shortage-input");
    if (shortageInput && document.activeElement !== shortageInput) shortageInput.value = String(shortage);
  }

  const trayItem = els.trayBoard?.querySelector(`[data-tray-key="${itemSlotKey(invoice, item).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"]`);
  if (trayItem) {
    const meta = itemStatusMeta(item, invoice);
    trayItem.classList.remove("picked", "shortage", "hold", "todo", "cancelled");
    trayItem.classList.add(meta.className);
    trayItem.querySelector(".tray-item-check")?.replaceChildren(document.createTextNode(picked ? "✓" : ""));
    const stateNode = trayItem.querySelector(".tray-item-state");
    if (stateNode) stateNode.textContent = meta.label;
  }
}

function shortageEventType(prev, next) {
  if (next > 0 && prev === 0) return "shortage_created";
  if (next === 0 && prev > 0) return "shortage_repick_completed";
  if (next !== prev) return "shortage_qty_changed";
  return null;
}

function buildItemEvent(invoice, item, eventType, overrides = {}) {
  return {
    receipt_date: dateKey(invoice.receiptDate) || null,
    order_group_no: invoice.orderGroupNo,
    invoice_no: invoice.invoiceNo || "",
    sellpia_item_no: item.sellpiaItemNo,
    sellpia_product_code: item.sellpiaProductCode || "",
    own_code: item.ownCode || "",
    event_type: eventType,
    quantity: overrides.quantity ?? null,
    memo: overrides.memo || null,
    drawer_memo: overrides.drawerMemo || item.pickingState?.drawerMemo || null,
    actor: "front",
    source: overrides.source || "f_v1_picking",
    payload: {
      productName: item.productName || "",
      optionName: item.optionName || "",
    },
  };
}

function buildInvoiceEvent(invoice, eventType, overrides = {}) {
  return {
    receipt_date: dateKey(invoice.receiptDate) || null,
    order_group_no: invoice.orderGroupNo,
    invoice_no: invoice.invoiceNo || "",
    event_type: eventType,
    memo: overrides.memo || null,
    actor: "front",
    source: overrides.source || "f_v1_inspection",
    payload: {
      displayName: invoice.displayName || invoice.csDisplayName || "",
      itemCount: (invoice.items || []).length,
    },
  };
}

function rebuildWorkflowQueuesFromLocalEvents() {
  if (!state.workflowQueues) return;
  const viewModel = state.workflowQueues.viewModel || state.viewModel;
  const systemShippingHoldCurrents = state.workflowQueues.systemShippingHoldCurrents || new Map();
  const workflowState = buildWorkflowState({
    itemEvents: [
      ...(state.workflowQueues.shortageBaselineEvents || []),
      ...(state.workflowQueues.syntheticEvents?.itemEvents || []),
      ...(state.workflowQueues.itemEvents || []),
    ],
    invoiceEvents: [...(state.workflowQueues.syntheticEvents?.invoiceEvents || []), ...(state.workflowQueues.invoiceEvents || [])],
  });
  annotateShippingHoldState({
    viewModel,
    workflowState,
    shippingHoldSignals: state.workflowQueues.shippingHoldSignals || [],
    scrapedShippingHoldBaselines: state.workflowQueues.scrapedShippingHoldBaselines || new Map(),
    systemShippingHoldCurrents,
  });
  state.workflowQueues.workflowState = workflowState;
  state.workflowQueues.shortageItems = openShortageItems(viewModel, workflowState);
  state.workflowQueues.inspectionInvoices = repickedInvoicesForInspection(viewModel, workflowState);
  state.workflowQueues.inspectionCompletedInvoices = completedInvoicesForInspection(viewModel, workflowState);
}

function applyLocalSystemShippingHoldCurrent(invoice, current) {
  if (!state.workflowQueues || !invoice || !current) return;
  const groupNo = String(invoice.orderGroupNo || "").trim();
  if (!groupNo) return;
  const next = {
    order_group_no: groupNo,
    invoice_no: invoice.invoiceNo || "",
    status: current.status,
    source: current.source || "system_current",
    updated_at: current.updatedAt || current.updated_at || "",
  };
  if (!(state.workflowQueues.systemShippingHoldCurrents instanceof Map)) {
    state.workflowQueues.systemShippingHoldCurrents = new Map();
  }
  state.workflowQueues.systemShippingHoldCurrents.set(groupNo, next);
  for (const candidate of [
    invoice,
    ...(state.workflowQueues.viewModel?.invoices || []),
    ...(state.workflowQueues.inspectionInvoices || []),
    ...(state.workflowQueues.inspectionCompletedInvoices || []),
  ]) {
    if (candidate?.orderGroupNo !== groupNo) continue;
    candidate.raw = {
      ...(candidate.raw || {}),
      system_shipping_hold_status: next.status,
      system_shipping_hold_source: next.source,
      system_shipping_hold_updated_at: next.updated_at,
    };
  }
  rebuildWorkflowQueuesFromLocalEvents();
}

function applyWorkflowItemEvent(row) {
  if (!state.workflowQueues || !row) return;
  state.workflowQueues.itemEvents = [...(state.workflowQueues.itemEvents || []), row];
  rebuildWorkflowQueuesFromLocalEvents();
}

function applyWorkflowInvoiceEvent(row) {
  if (!state.workflowQueues || !row) return;
  state.workflowQueues.invoiceEvents = [...(state.workflowQueues.invoiceEvents || []), row];
  rebuildWorkflowQueuesFromLocalEvents();
}

async function saveWorkflowItemEvent(invoice, item, eventType, overrides = {}, { render = true } = {}) {
  if (!allowWorkflowEvents) {
    toast("이벤트 저장이 비활성화되어 있습니다. URL에 write=1&events=1을 붙여야 저장할 수 있습니다.");
    return false;
  }
  const savingKey = `item::${workflowItemKey(invoice, item)}::${eventType}`;
  if (state.workflowSaving.has(savingKey)) return false;
  state.workflowSaving.add(savingKey);
  const eventRow = buildItemEvent(invoice, item, eventType, overrides);
  try {
    const { data, error } = await db.from("workflow_item_events").insert(eventRow).select("*").single();
    if (error) {
      state.workflowEventsChecked = true;
      state.workflowEventsReady = false;
      renderMetrics();
      console.warn("workflow_item_events insert failed", error);
      toast("피킹 저장 완료 · 이벤트 테이블 미준비");
      return false;
    }
    state.workflowEventsChecked = true;
    state.workflowEventsReady = true;
    const savedEvent = data || { ...eventRow, event_at: new Date().toISOString() };
    applyWorkflowItemEvent(savedEvent);
    if (render) renderWorkflowSurfacesIfVisible();
    return savedEvent;
  } finally {
    state.workflowSaving.delete(savingKey);
  }
}

async function saveWorkflowInvoiceEvent(invoice, eventType, overrides = {}) {
  if (!allowWorkflowEvents) {
    toast("이벤트 저장이 비활성화되어 있습니다. URL에 write=1&events=1을 붙여야 저장할 수 있습니다.");
    return false;
  }
  const savingKey = `invoice::${invoice.orderGroupNo}::${eventType}`;
  if (state.workflowSaving.has(savingKey)) return false;
  state.workflowSaving.add(savingKey);
  const eventRow = buildInvoiceEvent(invoice, eventType, overrides);
  try {
    const { data, error } = await db.from("workflow_invoice_events").insert(eventRow).select("*").single();
    if (error) {
      state.workflowEventsChecked = true;
      state.workflowEventsReady = false;
      renderMetrics();
      console.warn("workflow_invoice_events insert failed", error);
      toast("송장 이벤트 저장 실패");
      return false;
    }
    state.workflowEventsChecked = true;
    state.workflowEventsReady = true;
    const savedEvent = data || { ...eventRow, event_at: new Date().toISOString() };
    applyWorkflowInvoiceEvent(savedEvent);
    renderWorkflowSurfacesIfVisible();
    return savedEvent;
  } finally {
    state.workflowSaving.delete(savingKey);
  }
}

async function saveSystemShippingHoldCurrent(invoice, status, source) {
  if (!allowWorkflowEvents) {
    toast("이벤트 저장이 비활성화되어 있습니다. URL에 write=1&events=1을 붙여야 저장할 수 있습니다.");
    return false;
  }
  const orderGroupNo = String(invoice?.orderGroupNo || "").trim();
  if (!orderGroupNo) {
    toast("배송보류 저장 대상을 찾지 못했습니다.");
    return false;
  }
  const normalizedStatus = String(status || "").trim().toUpperCase();
  if (normalizedStatus !== "ON" && normalizedStatus !== "OFF" && normalizedStatus !== "UNKNOWN") {
    throw new Error(`지원하지 않는 배송보류 상태: ${status}`);
  }
  const updatedAt = new Date().toISOString();
  const { data, error } = await db
    .from("orders")
    .update({
      system_shipping_hold_status: normalizedStatus,
      system_shipping_hold_source: source || "",
      system_shipping_hold_updated_at: updatedAt,
    })
    .eq("ord_no", orderGroupNo)
    .select("ord_no");
  if (error) {
    toast(`배송보류 current 저장 실패: ${error.message}`);
    throw error;
  }
  if (!data || !data.length) {
    const error = new Error(`orders에서 주문 ${orderGroupNo}을 찾지 못했습니다.`);
    toast("배송보류 current 저장 대상을 찾지 못했습니다.");
    throw error;
  }
  const current = { status: normalizedStatus, source, updatedAt };
  applyLocalSystemShippingHoldCurrent(invoice, current);
  return current;
}

async function saveShippingHoldCurrentThenEvent(invoice, status, source, eventType, eventOverrides = {}) {
  const current = await saveSystemShippingHoldCurrent(invoice, status, source);
  if (!current) return false;
  const event = await saveWorkflowInvoiceEvent(invoice, eventType, eventOverrides);
  if (!event) {
    toast("배송보류 current는 저장됐지만 이벤트 로그 저장에 실패했습니다.");
    return false;
  }
  return event;
}

async function ensureShippingHoldOnAfterMemoSave(invoice, memoValue) {
  if (!allowWorkflowEvents || !String(memoValue || "").trim() || isSystemShippingHoldOn(invoice)) return false;
  return await saveShippingHoldCurrentThenEvent(invoice, "ON", "memo_auto_hold", "hold_created", {
    memo: "shipping hold auto on by memo save",
    source: "f_v1_memo_auto_hold",
  });
}

async function savePickingRow(invoice, item, eventType = null, eventOverrides = {}) {
  if (!allowWrites) {
    toast("읽기전용입니다. URL에 write=1을 붙여야 저장할 수 있습니다.");
    return;
  }

  const key = itemStateKey(invoice, item);
  if (state.saving.has(key)) return;
  state.saving.add(key);

  const row = {
    inv_no: invoice.invoiceNo || "",
    ord_no: invoice.orderGroupNo,
    item_no: item.sellpiaItemNo,
    item_sort_order: item.itemOrderIndex ?? item.sortOrder ?? null,
    sellpia_p_code: item.sellpiaProductCode || "",
    p_code: item.ownCode || item.sellpiaProductCode || "",
    is_checked: Boolean(item.pickingState?.isPicked),
    drawer_no: item.pickingState?.drawerMemo || "",
    hold: Boolean(item.pickingState?.isHold),
  };

  try {
    // 초기 피킹행은 송장번호가 비어 있을 수 있습니다. 현재 송장번호로만 찾으면
    // 같은 주문/상품을 다시 INSERT하므로 주문+상품 범위에서 현재 송장 행,
    // 빈 송장 행 순으로 재사용합니다.
    const { data: existing, error: findError } = await db
      .from("picking")
      .select("id,inv_no")
      .eq("ord_no", row.ord_no)
      .eq("item_no", row.item_no)
      .order("id", { ascending: false });
    if (findError) throw findError;

    const existingRow = preferredPickingRow(existing, row.inv_no);
    if (existingRow?.id) {
      const { error } = await db.from("picking").update(row).eq("id", existingRow.id);
      if (error) throw error;
    } else {
      const { error } = await db.from("picking").insert(row);
      if (error) throw error;
    }
    if (eventType) await saveWorkflowItemEvent(invoice, item, eventType, eventOverrides);
  } finally {
    state.saving.delete(key);
  }
}

function sourceInvoicesForShipment(invoice) {
  return invoice?.shipmentGroup ? (invoice.sourceInvoices || []) : invoice ? [invoice] : [];
}

function shipmentScopeForInvoice(invoice) {
  if (!invoice || invoice.shipmentGroup) return invoice || null;
  const invoiceNo = String(invoice.invoiceNo || "").trim();
  if (!invoiceNo) return invoice;
  const byOrder = new Map();
  for (const candidate of allWorkflowInvoices()) {
    if (!candidate || candidate.shipmentGroup || String(candidate.invoiceNo || "").trim() !== invoiceNo) continue;
    const orderGroupNo = String(candidate.orderGroupNo || "").trim();
    if (orderGroupNo && !byOrder.has(orderGroupNo)) byOrder.set(orderGroupNo, candidate);
  }
  const invoiceOrderGroupNo = String(invoice.orderGroupNo || "").trim();
  if (invoiceOrderGroupNo && !byOrder.has(invoiceOrderGroupNo)) byOrder.set(invoiceOrderGroupNo, invoice);
  const sourceInvoices = [...byOrder.values()];
  if (sourceInvoices.length < 2) return invoice;
  return combineInvoicesBySharedInvoice(sourceInvoices)[0] || invoice;
}

async function ensureShippingHoldOnForShipment(invoice, memoValue) {
  if (!String(memoValue || "").trim()) return true;
  for (const sourceInvoice of sourceInvoicesForShipment(invoice)) {
    if (isSystemShippingHoldOn(sourceInvoice)) continue;
    const saved = await ensureShippingHoldOnAfterMemoSave(sourceInvoice, memoValue);
    if (!saved) throw new Error(`배송보류 ON 저장에 실패했습니다: ${sourceInvoice.orderGroupNo}`);
  }
  return true;
}

async function saveDrawerForInvoice(invoice, drawerMemo) {
  if (!allowWrites) {
    toast("읽기전용입니다. URL에 write=1을 붙여야 저장할 수 있습니다.");
    return;
  }
  for (const sourceInvoice of sourceInvoicesForShipment(invoice)) {
    for (const item of sourceInvoice.items || []) {
      await updateOrderItemMemoFields(sourceInvoice.orderGroupNo, item.sellpiaItemNo, { o_shop_memo: drawerMemo });
    }
    for (const item of sourceInvoice.items || []) {
      patchLocalPickingState(sourceInvoice, item, { drawerMemo });
      await savePickingRow(sourceInvoice, item, null, { drawerMemo });
      patchLocalItemManagementMemos(sourceInvoice.orderGroupNo, item.sellpiaItemNo, { memo1: drawerMemo });
    }
    await ensureShippingHoldOnAfterMemoSave(sourceInvoice, drawerMemo);
  }
}

async function setShortageQty(orderGroupNo, sellpiaItemNo, nextValue, { shippingHoldInvoice = null, throwOnError = false } = {}) {
  const { invoice, item } = findInvoiceAndItem(orderGroupNo, sellpiaItemNo);
  if (!invoice || !item) {
    toast("부족수량 대상을 찾지 못했습니다.");
    return false;
  }
  const prevText = itemManagementMemo2(item);
  const nextText = normalizedShortageMemo2(nextValue);
  const prev = shortageQty(item);
  const next = normalizedShortageQty(nextText);
  if (prev === next && prevText === nextText) return true;
  const eventType = shortageEventType(prev, next);
  patchLocalPickingState(invoice, item, { shortageQty: next, shortageMemo2: nextText });
  item.sellpiaMemo2 = nextText;
  if (item.raw) {
    item.raw.o_shop_memo2 = nextText;
    item.raw.shop_memo2 = nextText;
    item.raw.memo2 = nextText;
  }
  paintPickingItemState(invoice, item);
  schedulePickingSurfaces();
  const queueKey = itemStateKey(invoice, item);
  const previousSave = state.shortageSaveQueues.get(queueKey) || Promise.resolve();
  const queuedSave = previousSave.catch(() => undefined).then(async () => {
    try {
      // 관리메모2를 비우는 것은 단순 메모 수정이 아니라 미송피킹완료 상태 전이입니다.
      // 이벤트 저장이 꺼져 있거나 실패한 경우 메모만 비워 두면, 다음 렌더에서 이전
      // shortage 이벤트가 다시 우선되어 부족수량이 되돌아옵니다. 따라서 현재값을
      // 먼저 저장한 뒤 완료/수량 이벤트가 성공한 경우에만 메모 변경을 확정합니다.
      if (eventType && !allowWorkflowEvents) {
        throw new Error("미송 상태 이벤트 저장이 필요합니다. URL에 write=1&events=1을 붙여 다시 시도하세요.");
      }
      await savePickingRow(invoice, item);
      await updateOrderItemMemoFields(invoice.orderGroupNo, item.sellpiaItemNo, { o_shop_memo2: nextText });
      if (eventType) {
        const savedEvent = await saveWorkflowItemEvent(invoice, item, eventType, { quantity: next, memo: nextText || null });
        if (!savedEvent) {
          await updateOrderItemMemoFields(invoice.orderGroupNo, item.sellpiaItemNo, { o_shop_memo2: prevText });
          throw new Error("미송 상태 이벤트가 저장되지 않아 관리메모2 변경을 취소했습니다. URL에 write=1&events=1을 붙여 다시 시도하세요.");
        }
      }
      patchLocalItemManagementMemos(invoice.orderGroupNo, item.sellpiaItemNo, { memo2: nextText });
      await ensureShippingHoldOnForShipment(shippingHoldInvoice || invoice, nextText);
      renderWorkflowSurfacesIfVisible();
      toast("관리메모2 저장");
      return true;
    } catch (error) {
      // A newer input is already visible and queued; do not roll it back to an older value.
      if (itemManagementMemo2(item) === nextText) {
        patchLocalPickingState(invoice, item, { shortageQty: prev, shortageMemo2: prevText });
        item.sellpiaMemo2 = prevText;
        if (item.raw) {
          item.raw.o_shop_memo2 = prevText;
          item.raw.shop_memo2 = prevText;
          item.raw.memo2 = prevText;
        }
        render();
      }
      toast(`관리메모2 저장 실패: ${error.message}`);
      if (throwOnError) throw error;
      return false;
    }
  });
  state.shortageSaveQueues.set(queueKey, queuedSave);
  try {
    return await queuedSave;
  } finally {
    if (state.shortageSaveQueues.get(queueKey) === queuedSave) {
      state.shortageSaveQueues.delete(queueKey);
    }
  }
}

function onShortageInputChange(event) {
  const input = event.target.closest("[data-shortage-input]");
  if (!input) return;
  input.value = normalizedShortageMemo2(input.value);
  setShortageQty(input.dataset.orderGroup, input.dataset.itemNo, input.value).catch(showError);
}

function shortageQtyInput(invoice, item, value = shortageQty(item), extraClass = "") {
  return `<input class="shortage-input ${extraClass}" data-shortage-input data-action="shortage-set" type="text" value="${escapeHtml(itemManagementMemo2(item, value))}" data-order-group="${escapeHtml(sourceOrderGroupNo(invoice, item))}" data-item-no="${escapeHtml(item.sellpiaItemNo)}" aria-label="관리메모2" ${itemIsEffectivelyCancelled(invoice, item) ? "disabled" : ""}>`;
}

function firstRawText(source, ...keys) {
  for (const key of keys) {
    const value = source?.[key];
    if (value === null || value === undefined) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return "";
}

function firstRawPreservedText(source, ...keys) {
  for (const key of keys) {
    const value = source?.[key];
    if (value === null || value === undefined) continue;
    const text = String(value);
    if (text.trim()) return text;
  }
  return "";
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csvRowsToText(rows) {
  return `\uFEFF${(rows || []).map((row) => row.map(csvCell).join(",")).join("\r\n")}`;
}

function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function downloadCsv(filename, rows) {
  downloadBlob(filename, new Blob([csvRowsToText(rows)], { type: "text/csv;charset=utf-8;" }));
}

function setInventoryCountExportBusy(running) {
  state.inventoryCountExportRunning = running;
  if (!els.dashboardInventoryCountExportBtn) return;
  els.dashboardInventoryCountExportBtn.disabled = running;
  els.dashboardInventoryCountExportBtn.textContent = running ? "재고수량 집계 중..." : "재고반영 수량";
}

function downloadInventoryCountWorkbook(filename, inventoryRows, shortageRows) {
  if (!window.XLSX) {
    toast("XLSX 라이브러리 로드 실패: 시트별 CSV로 저장합니다.");
    const baseName = filename.replace(/\.xlsx$/i, "");
    downloadCsv(`${baseName}_재고반영.csv`, inventoryRows);
    downloadCsv(`${baseName}_현재미송.csv`, shortageRows);
    return;
  }

  const workbook = window.XLSX.utils.book_new();
  const worksheet = window.XLSX.utils.aoa_to_sheet(inventoryRows || []);
  worksheet["!cols"] = [{ wch: 18 }, { wch: 24 }, { wch: 20 }, { wch: 20 }, { wch: 16 }, { wch: 22 }, { wch: 14 }];
  worksheet["!autofilter"] = { ref: `A1:G${Math.max(1, inventoryRows?.length || 1)}` };
  const range = window.XLSX.utils.decode_range(worksheet["!ref"] || "A1:G1");
  for (let row = 1; row <= range.e.r; row += 1) {
    for (const column of ["A", "B"]) {
      const cell = worksheet[`${column}${row + 1}`];
      if (!cell) continue;
      cell.t = "s";
      cell.z = "@";
    }
  }
  window.XLSX.utils.book_append_sheet(workbook, worksheet, "재고반영 수량");

  const shortageWorksheet = window.XLSX.utils.aoa_to_sheet(shortageRows || []);
  shortageWorksheet["!cols"] = [{ wch: 18 }, { wch: 24 }, { wch: 12 }];
  shortageWorksheet["!autofilter"] = { ref: `A1:C${Math.max(1, shortageRows?.length || 1)}` };
  const shortageRange = window.XLSX.utils.decode_range(shortageWorksheet["!ref"] || "A1:C1");
  for (let row = 1; row <= shortageRange.e.r; row += 1) {
    for (const column of ["A", "B"]) {
      const cell = shortageWorksheet[`${column}${row + 1}`];
      if (!cell) continue;
      cell.t = "s";
      cell.z = "@";
    }
  }
  window.XLSX.utils.book_append_sheet(workbook, shortageWorksheet, "현재 미송 상품");
  window.XLSX.writeFile(workbook, filename, { bookType: "xlsx" });
}

async function loadTodayCustomOrderInventoryExportData() {
  const today = todayDateString();
  const orders = await fetchAllRows(() => db.from("orders").select("ord_no").eq("receipt_date", today));
  const orderNos = [...new Set(orders.map((row) => String(row.ord_no || "").trim()).filter(Boolean))];
  if (!orderNos.length) return { currentItems: [], operations: [] };
  const [currentItems, operations] = await Promise.all([
    fetchAllRows(() => db.from("order_items").select("*").in("ord_no", orderNos)),
    orderItemOperations.loadOperationsForOrders(orderNos),
  ]);
  return { currentItems, operations };
}

async function exportInventoryCountWorkbook() {
  if (state.inventoryCountExportRunning) return;
  setInventoryCountExportBusy(true);
  try {
    const [{ data, error }, customOrderData] = await Promise.all([
      db.rpc("get_inventory_survey_live_counts"),
      loadTodayCustomOrderInventoryExportData(),
    ]);
    if (error) throw error;
    const result = buildInventorySurveyExport({
      countRows: data || [],
      invoices: allWorkflowInvoices(),
      currentItems: customOrderData.currentItems,
      operations: customOrderData.operations,
    });
    const currentShortage = buildCurrentShortageExport(state.workflowQueues?.shortageItems || []);
    if (!result.itemCount) {
      toast("현재 재고에 반영할 피킹·미송서랍 수량이 없습니다.");
      return;
    }

    downloadInventoryCountWorkbook(
      `재고반영_피킹미송_${timestampForFilename()}.xlsx`,
      result.rows,
      currentShortage.rows,
    );
    const missingOwnCode = result.missingOwnCodeCount ? ` · 자사코드 미확인 ${result.missingOwnCodeCount}종` : "";
    toast(
      `재고반영 ${result.itemCount}종 · 일반 피킹 ${result.pickedTotal}개 · 미송서랍 ${result.shortageDrawerTotal}개 · 오늘 주문수량 ${result.orderedTotal}개 · 현재 미송 ${currentShortage.itemCount}종 ${currentShortage.shortageTotal}개${missingOwnCode}`,
    );
  } finally {
    setInventoryCountExportBusy(false);
  }
}

function zipCrc32(bytes) {
  if (!zipCrc32.table) {
    zipCrc32.table = Array.from({ length: 256 }, (_, index) => {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      return value >>> 0;
    });
  }
  let crc = 0xffffffff;
  for (const byte of bytes) crc = zipCrc32.table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function zipHeader(size) {
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  return { bytes, view };
}

function zipDateTime(date = new Date()) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = date.getDate();
  const month = date.getMonth() + 1;
  const year = Math.max(1980, date.getFullYear()) - 1980;
  return { time, date: (year << 9) | (month << 5) | day };
}

function buildZipBlob(files) {
  const encoder = new TextEncoder();
  const parts = [];
  const centralParts = [];
  const now = zipDateTime();
  let offset = 0;

  (files || []).forEach((file) => {
    const nameBytes = encoder.encode(file.filename);
    const dataBytes = encoder.encode(file.content);
    const crc = zipCrc32(dataBytes);
    const local = zipHeader(30);
    local.view.setUint32(0, 0x04034b50, true);
    local.view.setUint16(4, 20, true);
    local.view.setUint16(6, 0x0800, true);
    local.view.setUint16(8, 0, true);
    local.view.setUint16(10, now.time, true);
    local.view.setUint16(12, now.date, true);
    local.view.setUint32(14, crc, true);
    local.view.setUint32(18, dataBytes.length, true);
    local.view.setUint32(22, dataBytes.length, true);
    local.view.setUint16(26, nameBytes.length, true);
    local.view.setUint16(28, 0, true);
    parts.push(local.bytes, nameBytes, dataBytes);

    const central = zipHeader(46);
    central.view.setUint32(0, 0x02014b50, true);
    central.view.setUint16(4, 20, true);
    central.view.setUint16(6, 20, true);
    central.view.setUint16(8, 0x0800, true);
    central.view.setUint16(10, 0, true);
    central.view.setUint16(12, now.time, true);
    central.view.setUint16(14, now.date, true);
    central.view.setUint32(16, crc, true);
    central.view.setUint32(20, dataBytes.length, true);
    central.view.setUint32(24, dataBytes.length, true);
    central.view.setUint16(28, nameBytes.length, true);
    central.view.setUint16(30, 0, true);
    central.view.setUint16(32, 0, true);
    central.view.setUint16(34, 0, true);
    central.view.setUint16(36, 0, true);
    central.view.setUint32(38, 0, true);
    central.view.setUint32(42, offset, true);
    centralParts.push(central.bytes, nameBytes);
    offset += local.bytes.length + nameBytes.length + dataBytes.length;
  });

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = zipHeader(22);
  end.view.setUint32(0, 0x06054b50, true);
  end.view.setUint16(8, files.length, true);
  end.view.setUint16(10, files.length, true);
  end.view.setUint32(12, centralSize, true);
  end.view.setUint32(16, offset, true);
  end.view.setUint16(20, 0, true);
  return new Blob([...parts, ...centralParts, end.bytes], { type: "application/zip" });
}

function timestampForFilename() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}`;
}

function monthDayForFilename() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
}

function itemSellerProductName(item) {
  return firstRawPreservedText(item.raw, "seller_product_name", "seller_p_name", "mall_product_name", "p_name") || item.productName || "";
}

function itemSellerOptionName(item) {
  return firstRawPreservedText(item.raw, "seller_option_name", "seller_p_option", "mall_option_name", "p_option") || item.optionName || "";
}

function itemSellpiaItemNo(item) {
  return firstRawText(item.raw, "item_no", "sellpia_item_no", "order_item_no") || item.sellpiaItemNo || "";
}

function isSellerOrderMemoLine(value) {
  const text = String(value || "").trim();
  if (!text) return false;
  const normalized = text.replace(/\s+/g, "");
  if (/^(판매처)?주문번호[:：-]?[A-Za-z0-9_-]{8,}$/.test(normalized)) return true;
  if (/^(에이블리|쿠팡|플레이오토|playauto|ably|coupang)[:：-]?[A-Za-z0-9_-]{8,}$/i.test(normalized)) return true;
  return /^[0-9]{8,}$/.test(normalized.replace(/[-_]/g, ""));
}

function cleanSellpiaManageMemo(value) {
  return String(value || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !isSellerOrderMemoLine(line))
    .join("\n");
}

function rawTextOrNull(source, key) {
  const value = source?.[key];
  return value === null || value === undefined ? null : String(value);
}

function itemSystemOrderMemoOverride(item) {
  const value = firstRawPreservedText(item.raw, "order_memo", "item_order_memo", "sellpia_order_memo");
  if (value) return { present: true, value };

  const orderMemo = rawTextOrNull(item.raw, "order_memo");
  const updatedAt = firstRawText(item.raw, "order_memo_updated_at");
  if (orderMemo !== null && !orderMemo.trim() && updatedAt) return { present: true, value: "" };

  return { present: false, value: "" };
}

function itemOrderMemo(invoice, item) {
  const override = itemSystemOrderMemoOverride(item);
  if (override.present) return cleanSellpiaManageMemo(override.value);

  const rawSellpiaMemo = rawTextOrNull(item.raw, "sellpia_order_memo_raw");
  if (rawSellpiaMemo !== null) return cleanSellpiaManageMemo(rawSellpiaMemo);

  return "";
}

function itemSellpiaOrderMemo(invoice, item) {
  const override = itemSystemOrderMemoOverride(item);
  if (override.present) return override.value;

  const rawSellpiaMemo = rawTextOrNull(item.raw, "sellpia_order_memo_raw");
  return rawSellpiaMemo !== null ? rawSellpiaMemo : "";
}

function inspectionMemoCode(item) {
  return String(item?.sellpiaProductCode || item?.raw?.p_code || item?.ownCode || "").trim();
}

function itemInspectionMemo(item) {
  return String(item?.inspectionMemo || item?.raw?.insp_memo || item?.raw?.inspection_memo || "").trim();
}

function patchLocalInspectionMemo(invoice, item, value) {
  const code = inspectionMemoCode(item);
  for (const inv of state.viewModel?.invoices || []) {
    if (inv.invoiceNo !== invoice.invoiceNo && inv.orderGroupNo !== invoice.orderGroupNo) continue;
    for (const row of inv.items || []) {
      if (inspectionMemoCode(row) !== code) continue;
      row.inspectionMemo = value || "";
      if (row.raw) row.raw.insp_memo = value || "";
    }
  }
  for (const inv of state.workflowQueues?.viewModel?.invoices || []) {
    if (inv.invoiceNo !== invoice.invoiceNo && inv.orderGroupNo !== invoice.orderGroupNo) continue;
    for (const row of inv.items || []) {
      if (inspectionMemoCode(row) !== code) continue;
      row.inspectionMemo = value || "";
      if (row.raw) row.raw.insp_memo = value || "";
    }
  }
}

function patchLocalSellpiaOrderMemo(invoice, item, value) {
  for (const inv of state.viewModel?.invoices || []) {
    if (inv.orderGroupNo !== invoice.orderGroupNo) continue;
    for (const row of inv.items || []) {
      if (String(row.sellpiaItemNo || "") !== String(item.sellpiaItemNo || "")) continue;
      if (row.raw) row.raw.order_memo = value || "";
    }
  }
  for (const inv of state.workflowQueues?.viewModel?.invoices || []) {
    if (inv.orderGroupNo !== invoice.orderGroupNo) continue;
    for (const row of inv.items || []) {
      if (String(row.sellpiaItemNo || "") !== String(item.sellpiaItemNo || "")) continue;
      if (row.raw) row.raw.order_memo = value || "";
    }
  }
}

function allWorkflowInvoices() {
  return [
    ...(state.viewModel?.invoices || []),
    ...(state.workflowQueues?.viewModel?.invoices || []),
    ...(state.workflowQueues?.inspectionInvoices || []),
    ...(state.workflowQueues?.shortageItems || []).map((row) => row.invoice).filter(Boolean),
    ...(state.workflowQueues?.inspectionCompletedInvoices || []),
  ];
}

function patchLocalItemManagementMemos(orderGroupNo, sellpiaItemNo, { memo1, memo2 } = {}) {
  const groupNo = String(orderGroupNo || "");
  const itemNo = String(sellpiaItemNo || "");
  const seen = new Set();
  for (const inv of allWorkflowInvoices()) {
    if (!inv || String(inv.orderGroupNo || "") !== groupNo) continue;
    for (const row of inv.items || []) {
      if (String(row.sellpiaItemNo || "") !== itemNo) continue;
      const key = `${groupNo}::${itemNo}::${seen.size}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (memo1 !== undefined) {
        row.sellpiaMemo1 = memo1;
        if (row.raw) row.raw.o_shop_memo = memo1;
        if (row.pickingState) row.pickingState.drawerMemo = memo1;
      }
      if (memo2 !== undefined) {
        row.sellpiaMemo2 = memo2;
        if (row.raw) {
          row.raw.o_shop_memo2 = memo2;
          row.raw.shop_memo2 = memo2;
          row.raw.memo2 = memo2;
        }
        if (row.pickingState) row.pickingState.shortageMemo2 = memo2;
      }
    }
  }
  for (const shortageRow of state.workflowQueues?.shortageItems || []) {
    if (String(shortageRow.invoice?.orderGroupNo || "") !== groupNo) continue;
    if (String(shortageRow.item?.sellpiaItemNo || "") !== itemNo) continue;
    if (memo1 !== undefined) {
      shortageRow.item.sellpiaMemo1 = memo1;
      if (shortageRow.item.raw) shortageRow.item.raw.o_shop_memo = memo1;
      if (shortageRow.state) shortageRow.state.drawerMemo = memo1;
    }
    if (memo2 !== undefined) {
      shortageRow.item.sellpiaMemo2 = memo2;
      if (shortageRow.item.raw) {
        shortageRow.item.raw.o_shop_memo2 = memo2;
        shortageRow.item.raw.shop_memo2 = memo2;
        shortageRow.item.raw.memo2 = memo2;
      }
      if (shortageRow.state) shortageRow.state.memo = memo2;
    }
  }
}

async function updateOrderItemMemoFields(orderGroupNo, sellpiaItemNo, patch) {
  const primary = await db
    .from("order_items")
    .update(patch)
    .eq("ord_no", orderGroupNo)
    .eq("item_no", sellpiaItemNo)
    .select("ord_no,item_no,sellpia_order_item_no");
  if (primary.error) throw primary.error;
  if (primary.data?.length) return primary.data;

  // Some Sellpia flows expose the regular item number while System V3 stores
  // the prefixed internal item number. Fall back only within the same order.
  const fallback = await db
    .from("order_items")
    .update(patch)
    .eq("ord_no", orderGroupNo)
    .eq("sellpia_order_item_no", sellpiaItemNo)
    .select("ord_no,item_no,sellpia_order_item_no");
  if (fallback.error) throw fallback.error;
  if (!fallback.data || fallback.data.length !== 1) {
    throw new Error(`order_items 대상 행 없음 (${orderGroupNo} / ${sellpiaItemNo})`);
  }
  return fallback.data;
}

async function updateOrderItemOrderMemoExact({ ordNo, itemNo, sellpiaOrderItemNo, patch }) {
  const normalizedOrdNo = String(ordNo || "").trim();
  const normalizedItemNo = String(itemNo || "").trim();
  const normalizedSellpiaItemNo = String(sellpiaOrderItemNo || "").trim();
  if (!normalizedOrdNo) throw new Error("order_items update requires ord_no.");

  let query = db.from("order_items").update(patch).eq("ord_no", normalizedOrdNo);
  if (normalizedItemNo) query = query.eq("item_no", normalizedItemNo);
  else if (normalizedSellpiaItemNo) query = query.eq("sellpia_order_item_no", normalizedSellpiaItemNo);
  else throw new Error("order_items update requires item_no or legacy sellpia_order_item_no.");

  const result = await query.select("ord_no,item_no,sellpia_order_item_no");
  if (result.error) throw result.error;
  if (!result.data || result.data.length !== 1) {
    throw new Error(`order_items exact row not found (${normalizedOrdNo} / ${normalizedItemNo || normalizedSellpiaItemNo}).`);
  }
  return result.data[0];
}

function buildPlannedPrintCsvRows() {
  const headers = ["작업번호", "송장번호", "셀피아순번", "주문자", "수취인", "상품종류수", "총수량", "골드포함", "부족/미송", "배송보류"];
  const rows = [headers];
  exportOrderedInvoices().forEach((invoice, index) => {
    const stats = invoiceStats(invoice);
    const metrics = invoice._exportSortMetrics || {};
    rows.push([
      invoice.plannedPrintSeqNo || index + 1,
      invoice.invoiceNo || "",
      invoice.raw?.sellpia_seq_no || invoice.raw?.original_seq_no || invoice.raw?.sort_order || invoice.sortOrder || "",
      invoice.buyerName || invoice.displayName || "",
      invoice.recipientName || invoice.csDisplayName || invoice.displayName || "",
      metrics.itemKindCount || stats.total,
      metrics.totalItemQty || stats.qty,
      metrics.hasGoldItem ? "Y" : "",
      metrics.hasShortage ? "Y" : "",
      metrics.hasHold ? "Y" : "",
    ]);
  });
  return rows;
}

function exportPlannedPrintCsv() {
  if (!state.viewModel?.invoices?.length) {
    toast("출력대상 CSV 대상이 없습니다.");
    return;
  }
  const rows = buildPlannedPrintCsvRows();
  downloadCsv(`planned_print_${timestampForFilename()}.csv`, rows);
  toast(`출력대상 CSV ${rows.length - 1}건 다운로드`);
}

function compactFilenamePart(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[\\/:*?"<>|]/g, "");
}

function alimtalkPhone(invoice) {
  return (
    firstRawText(
      invoice.raw,
      "receiver_mobile",
      "recipient_mobile",
      "receiver_hp",
      "recipient_hp",
      "orderer_mobile",
      "buyer_mobile",
      "mobile",
      "phone",
    ) ||
    invoice.recipientPhone ||
    invoice.buyerPhone ||
    invoiceReceiverMobile(invoice) ||
    invoiceReceiverTel(invoice)
  );
}

function alimtalkName(invoice) {
  return invoice.recipientName || invoice.displayName || invoice.csDisplayName || invoice.buyerName || "";
}

function alimtalkProduct(item) {
  return itemSellerProductName(item) || item.productName || item.ownCode || "";
}

function alimtalkOption(item) {
  return itemSellerOptionName(item) || item.optionName || "";
}

function alimtalkInboundExpectedDate(item) {
  return normalizedCsInboundExpectedDate(item);
}

function alimtalkOptionWithInboundExpectedDate(item) {
  const option = alimtalkOption(item);
  const inboundExpectedDate = formatAlimtalkInboundExpectedDate(alimtalkInboundExpectedDate(item));
  if (!inboundExpectedDate) return option;
  return `${option}${option ? " " : ""}${inboundExpectedDate}`;
}

function csWorkLogText(...values) {
  return values
    .flatMap((value) => (Array.isArray(value) ? value : [value]))
    .map((value) => String(value ?? "").trim())
    .filter(Boolean)
    .join(" ");
}

function csWorkLogTime(event = {}) {
  return String(event.event_at || event.created_at || "").trim();
}

function csWorkLogScope(event = {}) {
  return event.sellpia_item_no || event.item_no || event.order_item_no || "주문";
}

function csWorkLogItemKey(item = {}) {
  return String(item.sellpia_item_no || item.item_no || item.sellpia_order_item_no || item.order_item_no || "").trim();
}

function csWorkLogProductLabel(item = {}) {
  const code = String(item.own_code || item.p_dpcode || item.p_code || item.prod_code || item.sellpia_p_code || "").trim();
  const name = String(item.p_name || item.product_name || "").trim();
  const option = String(item.p_option || item.option_name || "").trim();
  const quantity = Number(item.qty || item.o_amount || item.quantity || 0);
  const title = [code, option ? `${name} / ${option}` : name].filter(Boolean).join(" · ");
  return `${title || csWorkLogItemKey(item) || "상품 정보 없음"}${quantity > 0 ? ` (${quantity}개)` : ""}`;
}

function formatCsWorkLogTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value || "-").trim() || "-";
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Seoul",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return `${parts.month}/${parts.day} ${parts.hour}:${parts.minute}`;
}

function csWorkLogEventLabel(event = {}) {
  const labels = {
    picked: "피킹 완료",
    shortage_created: "미송 생성",
    shortage_qty_changed: "미송수량 변경",
    shortage_repick_completed: "미송피킹 완료",
    shortage_repick_cancelled: "미송피킹 완료취소",
    inspection_completed: "검품 완료",
    inspection_cancelled: "검품 완료취소",
    hold_created: "배송보류 ON",
    hold_cleared: "배송보류 OFF",
    cancelled: "취소 처리",
    cancel_reopened: "취소 해제",
  };
  const type = String(event.event_type || "").trim();
  const quantity = event.quantity === null || event.quantity === undefined || event.quantity === "" ? "" : ` · 수량 ${event.quantity}`;
  const memo = String(event.memo || event.drawer_memo || event.note || "").trim();
  return `${labels[type] || type || "작업"}${quantity}${memo ? ` · ${memo}` : ""}`;
}

function csWorkLogCategory(event = {}) {
  const type = String(event.event_type || "").toLowerCase();
  if (type.includes("shortage")) return "shortage";
  if (type.includes("inspection")) return "inspection";
  if (type.includes("pick")) return "picking";
  if (type.includes("cancel")) return "cancellation";
  return "other";
}

function csWorkLogRows({ orders = [], orderItems = [], itemEvents = [], invoiceEvents = [] }, search = "") {
  const orderByGroup = new Map();
  for (const order of orders) {
    const key = String(order.ord_no || order.order_group_no || "").trim();
    if (key && !orderByGroup.has(key)) orderByGroup.set(key, order);
  }
  const rowsByKey = new Map();
  const ensureRow = ({ orderGroupNo, scope, item = null }) => {
    const key = `${orderGroupNo}::${scope || "주문"}`;
    if (!rowsByKey.has(key)) {
      const order = orderByGroup.get(orderGroupNo) || {};
      rowsByKey.set(key, {
        orderGroupNo,
        invoiceNo: String(order.inv_no || order.invoice_no || order.dnum || "").trim(),
        recipient: String(order.receiver || order.receiver_name || order.recipient_name || order.orderer || order.buyer || "").trim(),
        receiptDate: String(order.receipt_date || order.ord_date || "").trim(),
        scope: scope || "주문",
        product: item ? csWorkLogProductLabel(item) : "주문 전체",
        itemSortOrder: Number(item?.sort_order) || Number.MAX_SAFE_INTEGER,
        logs: [],
      });
    }
    return rowsByKey.get(key);
  };

  for (const item of orderItems) {
    const orderGroupNo = String(item.ord_no || item.order_group_no || "").trim();
    const scope = csWorkLogItemKey(item);
    if (orderGroupNo && scope) ensureRow({ orderGroupNo, scope, item });
  }

  for (const event of invoiceEvents) {
    const orderGroupNo = String(event.order_group_no || event.ord_no || "").trim();
    if (!orderGroupNo) continue;
    ensureRow({ orderGroupNo, scope: "주문" }).logs.push({ event, category: csWorkLogCategory(event), time: csWorkLogTime(event) });
  }

  for (const event of itemEvents) {
    const orderGroupNo = String(event.order_group_no || event.ord_no || "").trim();
    if (!orderGroupNo) continue;
    const scope = csWorkLogScope(event);
    ensureRow({ orderGroupNo, scope }).logs.push({ event, category: csWorkLogCategory(event), time: csWorkLogTime(event) });
  }

  const needle = String(search || "").trim().toLowerCase();
  return [...rowsByKey.values()]
    .map((row) => ({
      ...row,
      logs: [...row.logs].sort((left, right) => String(left.time).localeCompare(String(right.time)) || Number(left.event.id || 0) - Number(right.event.id || 0)),
    }))
    .filter((row) => {
      const logText = row.logs.map(({ event }) => csWorkLogEventLabel(event)).join(" ");
      return !needle || csWorkLogText(row.orderGroupNo, row.invoiceNo, row.recipient, row.scope, row.product, logText).toLowerCase().includes(needle);
    })
    .sort((left, right) => {
      const leftLastTime = left.logs.at(-1)?.time || "";
      const rightLastTime = right.logs.at(-1)?.time || "";
      return String(rightLastTime).localeCompare(String(leftLastTime)) || left.orderGroupNo.localeCompare(right.orderGroupNo) || left.itemSortOrder - right.itemSortOrder || left.scope.localeCompare(right.scope);
    });
}

function ensureCsWorkLogModal() {
  let modal = document.getElementById("cs-work-log-modal");
  if (modal) return modal;
  modal = document.createElement("div");
  modal.id = "cs-work-log-modal";
  modal.className = "order-list-modal-overlay";
  modal.hidden = true;
  modal.innerHTML = `<div class="order-list-modal cs-work-log-modal" role="dialog" aria-modal="true" aria-label="CS 작업로그 조회">
    <div class="order-list-modal-head">
      <h3>CS 작업로그 조회</h3>
      <div class="order-list-modal-tools">
        <input id="cs-work-log-search" type="search" placeholder="주문번호 / 송장번호 / 수취인 / 상품키">
        <button class="btn" type="button" data-cs-work-log-action="search">조회</button>
        <button class="btn cs-work-log-back" type="button" data-cs-work-log-action="back-to-list" hidden>← CS 리스트</button>
        <button type="button" class="order-list-modal-close" data-cs-work-log-action="close">×</button>
      </div>
    </div>
    <div class="cs-work-log-note">읽기 전용입니다. 현재 DB에 남아 있는 주문 정보와 workflow 작업 이벤트만 조회합니다.</div>
    <div class="order-list-modal-filters" id="cs-work-log-filters">
      <button type="button" data-cs-work-log-filter="all">전체</button>
      <button type="button" data-cs-work-log-filter="shortage">미송</button>
      <button type="button" data-cs-work-log-filter="picking">피킹</button>
      <button type="button" data-cs-work-log-filter="inspection">검품</button>
    </div>
    <div class="order-list-modal-table-wrap">
      <table class="order-list-modal-table cs-work-log-table">
        <thead><tr><th>주문 / 송장</th><th>수취인</th><th>상품행</th><th>작업로그</th></tr></thead>
        <tbody id="cs-work-log-body"></tbody>
      </table>
    </div>
    <div class="order-list-modal-foot" id="cs-work-log-foot">검색어를 입력해 주세요.</div>
  </div>`;
  document.body.appendChild(modal);
  modal.addEventListener("click", (event) => {
    const action = event.target.closest("[data-cs-work-log-action]")?.dataset.csWorkLogAction;
    if (action === "back-to-list") {
      closeCsWorkLogModal({ returnToOrderList: true });
      return;
    }
    if (event.target.id === "cs-work-log-modal" || action === "close") {
      closeCsWorkLogModal();
      return;
    }
    if (action === "search") loadCsWorkLog().catch(showError);
    const filter = event.target.closest("[data-cs-work-log-filter]")?.dataset.csWorkLogFilter;
    if (!filter) return;
    state.csWorkLogModal.filter = filter;
    renderCsWorkLogModal();
  });
  modal.querySelector("#cs-work-log-search")?.addEventListener("input", (event) => {
    state.csWorkLogModal.search = event.target.value;
    state.csWorkLogModal.loaded = false;
  });
  modal.querySelector("#cs-work-log-search")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") loadCsWorkLog().catch(showError);
  });
  return modal;
}

function renderCsWorkLogModal() {
  const modal = ensureCsWorkLogModal();
  modal.hidden = !state.csWorkLogModal.open;
  if (!state.csWorkLogModal.open) return;
  const input = modal.querySelector("#cs-work-log-search");
  if (input && input.value !== state.csWorkLogModal.search) input.value = state.csWorkLogModal.search;
  const backButton = modal.querySelector("[data-cs-work-log-action='back-to-list']");
  if (backButton) backButton.hidden = !state.csWorkLogModal.returnToOrderList;
  modal.querySelectorAll("[data-cs-work-log-filter]").forEach((button) => {
    button.classList.toggle("active", button.dataset.csWorkLogFilter === state.csWorkLogModal.filter);
  });
  const body = modal.querySelector("#cs-work-log-body");
  const foot = modal.querySelector("#cs-work-log-foot");
  if (state.csWorkLogModal.loading) {
    body.innerHTML = '<tr><td colspan="4" class="order-list-modal-empty">DB 작업로그를 읽는 중입니다.</td></tr>';
    if (foot) foot.textContent = "조회 중";
    return;
  }
  if (!state.csWorkLogModal.loaded) {
    body.innerHTML = '<tr><td colspan="4" class="order-list-modal-empty">주문번호·송장번호·수취인·상품키를 입력한 뒤 조회하세요.</td></tr>';
    return;
  }
  const rows = state.csWorkLogModal.rows.filter((row) => state.csWorkLogModal.filter === "all" || row.logs.some((log) => log.category === state.csWorkLogModal.filter));
  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="4" class="order-list-modal-empty">일치하는 작업로그가 없습니다.</td></tr>';
    if (foot) foot.textContent = "0건";
    return;
  }
  body.innerHTML = rows.slice(0, 500).map((row) => `<tr>
    <td><strong>${escapeHtml(row.orderGroupNo || "-")}</strong><small>${escapeHtml(row.invoiceNo || "송장 정보 없음")}${row.receiptDate ? ` · ${escapeHtml(row.receiptDate)}` : ""}</small></td>
    <td>${escapeHtml(row.recipient || "-")}</td>
    <td class="cs-work-log-product"><strong>${escapeHtml(row.product)}</strong><small>${escapeHtml(row.scope)}</small></td>
    <td class="cs-work-log-memo">${row.logs.length ? row.logs.map(({ event, time }) => `<div><time>${escapeHtml(formatCsWorkLogTime(time))}</time>${escapeHtml(csWorkLogEventLabel(event))}</div>`).join("") : '<span class="cs-work-log-empty">작업로그 없음</span>'}</td>
  </tr>`).join("");
  if (foot) foot.textContent = rows.length > 500 ? `${rows.length}건 중 최근 500건 표시` : `${rows.length}건`;
}

async function loadCsWorkLog() {
  const search = state.csWorkLogModal.search.trim();
  if (!search) {
    toast("검색어를 입력해 주세요.");
    return;
  }
  state.csWorkLogModal.loading = true;
  renderCsWorkLogModal();
  try {
    const [orders, orderItems, itemEvents, invoiceEvents] = await Promise.all([
      fetchAllRows(() => db.from("orders").select("*").order("receipt_date", { ascending: false, nullsFirst: false })),
      fetchAllRows(() => db.from("order_items").select("*").order("sort_order", { ascending: true, nullsFirst: false })),
      fetchAllRows(() => db.from("workflow_item_events").select("*").order("event_at", { ascending: false }).order("id", { ascending: false })),
      fetchAllRows(() => db.from("workflow_invoice_events").select("*").order("event_at", { ascending: false }).order("id", { ascending: false })),
    ]);
    state.csWorkLogModal.rows = csWorkLogRows({ orders, orderItems, itemEvents, invoiceEvents }, search);
    state.csWorkLogModal.loaded = true;
  } finally {
    state.csWorkLogModal.loading = false;
    renderCsWorkLogModal();
  }
}

function openCsWorkLogModal({ returnToOrderList = false } = {}) {
  state.csWorkLogModal.returnToOrderList = returnToOrderList;
  state.csWorkLogModal.open = true;
  renderCsWorkLogModal();
  document.getElementById("cs-work-log-search")?.focus();
}

function closeCsWorkLogModal({ returnToOrderList = state.csWorkLogModal.returnToOrderList } = {}) {
  state.csWorkLogModal.open = false;
  state.csWorkLogModal.returnToOrderList = false;
  renderCsWorkLogModal();
  if (!returnToOrderList) return;
  state.orderListModal.open = true;
  renderOrderListModal();
  document.getElementById("order-list-modal-search")?.focus();
}

function alimtalkShippingHoldState(invoice) {
  const invoiceState = workflowInvoiceState(invoice);
  const known = invoiceState?.systemShippingHoldKnown === true;
  const on = invoiceState?.systemShippingHold === true;
  return {
    on,
    known,
    label: on ? "ON" : known ? "OFF" : "UNKNOWN",
    source: invoiceState?.systemShippingHoldSource || "",
  };
}

function alimtalkInvoiceShortageMetrics(invoice) {
  const items = invoiceItemsInSellpiaRowOrder(invoice).filter((item) => !itemIsEffectivelyCancelled(invoice, item));
  let shortageQtyTotal = 0;
  let hasOpenShortage = false;
  for (const item of items) {
    const itemState = workflowItemState(invoice, item);
    const qty = workflowAwareShortageQty(itemState, item);
    shortageQtyTotal += Number(qty || 0);
    if (itemHasOpenWorkflowShortage(invoice, item) || qty > 0) hasOpenShortage = true;
  }
  return { hasOpenShortage, shortageQtyTotal };
}

function alimtalkDelayedItemsForInvoice(invoice) {
  return invoiceItemsInSellpiaRowOrder(invoice).filter((item) => {
    if (itemIsEffectivelyCancelled(invoice, item)) return false;
    const itemState = workflowItemState(invoice, item);
    if (itemState?.inspected || itemState?.cancelled || itemState?.shortageRepicked) return false;
    return itemHasOpenWorkflowShortage(invoice, item) || workflowAwareShortageQty(itemState, item) > 0;
  });
}

function alimtalkProductLine(item) {
  const product = alimtalkProduct(item);
  const option = alimtalkOption(item);
  return option ? `${product}(${option})` : product;
}

function alimtalkDebugColumns(row) {
  const seller = sellerBadgeMeta(row.invoice.seller)?.label || row.invoice.seller || "";
  const delayedItems = alimtalkDelayedItemsForInvoice(row.invoice);
  return [
    seller,
    dateKey(row.invoice.receiptDate),
    row.systemShippingHold || "UNKNOWN",
    delayedItems.map(alimtalkProductLine).join("\n"),
    row.alimtalkBucket || row.csDayKey || "",
  ];
}

function alimtalkBaseRow(row, item, extra = {}) {
  const invoice = row.invoice;
  const itemState = item ? workflowItemState(invoice, item) : null;
  const date = dateKey(invoice.receiptDate);
  const shippingHold = alimtalkShippingHoldState(invoice);
  const shortageMetrics = alimtalkInvoiceShortageMetrics(invoice);
  return {
    key: item ? csRowKey(invoice, item) : row.key,
    invoice,
    item,
    state: itemState,
    shortageQty: item ? workflowAwareShortageQty(itemState, item) || previousShortageQuantity(invoice, item) || 1 : 0,
    currentShortageQty: item ? workflowAwareShortageQty(itemState, item) : 0,
    shortageDate: date,
    elapsedDays: receiptBusinessDaysSinceDateKey(date),
    csMethod: item ? csMethodText(invoice, item) : "",
    receiptDate: date,
    delayBaseDate: date,
    delayBaseDateSource: "receiptDate",
    alimtalkSendLog: String(invoice?.raw?.sellpia_outbound_scheduled_date || ""),
    systemShippingHold: shippingHold.label,
    systemShippingHoldKnown: shippingHold.known,
    systemShippingHoldSource: shippingHold.source,
    hasOpenShortage: shortageMetrics.hasOpenShortage,
    shortageQtyTotal: shortageMetrics.shortageQtyTotal,
    ...extra,
  };
}

function buildAlimtalkRowsFromCsInvoices(csRows) {
  const rows = [];
  for (const row of csRows || []) {
    const invoice = row.invoice;
    const invoiceState = workflowInvoiceState(invoice);
    if (invoiceState?.cancelled) continue;
    if (hasTomorrowShippingManagementMemo(invoiceDrawerValue(invoice))) {
      const item = invoiceItemsInSellpiaRowOrder(invoice).find((candidate) => !itemIsEffectivelyCancelled(invoice, candidate)) || null;
      if (!item) continue;
      rows.push(alimtalkBaseRow(row, item, { key: row.key, csReason: "tomorrow", currentShortageQty: 0, shortageQty: 0 }));
      continue;
    }
    const shippingHold = alimtalkShippingHoldState(invoice);
    if (!shippingHold.on || !shippingHold.known) continue;
    const shortageMetrics = alimtalkInvoiceShortageMetrics(invoice);
    const delayedItems = alimtalkDelayedItemsForInvoice(invoice);
    if (shortageMetrics.hasOpenShortage || shortageMetrics.shortageQtyTotal > 0) {
      delayedItems.forEach((item) => {
        const itemState = workflowItemState(invoice, item);
        rows.push(
          alimtalkBaseRow(row, item, {
            currentShortageQty: workflowAwareShortageQty(itemState, item),
            csReason: "shortage",
          }),
        );
      });
      continue;
    }
  }
  return rows;
}

function buildAlimtalkRowsFromCurrentCsCases() {
  const rows = [];
  const seen = new Set();
  const displayRows = allCsDisplayRows();
  const tomorrowOrders = new Set(
    displayRows
      .filter((row) => row?.caseRow?.case_type === "tomorrow_shipping")
      .map((row) => csRowOrderNo(row))
      .filter(Boolean),
  );

  for (const displayRow of displayRows) {
    if (csEffectiveStatus(displayRow) !== "pending") continue;
    const caseType = String(displayRow?.caseRow?.case_type || "").trim();
    if (!["shortage", "tomorrow_shipping"].includes(caseType)) continue;

    const { invoice, item } = findCsWorkflowItem(displayRow);
    if (!invoice || !item || itemIsEffectivelyCancelled(invoice, item)) continue;
    const ordNo = String(invoice.orderGroupNo || "").trim();
    if (caseType === "shortage" && tomorrowOrders.has(ordNo)) continue;

    const reason = caseType === "tomorrow_shipping" ? "tomorrow" : "shortage";
    const itemNo = String(item?.raw?.item_no || item?.sellpiaItemNo || "").trim();
    const rowKey = `${ordNo}::${itemNo}::${reason}`;
    if (seen.has(rowKey)) continue;

    if (reason === "shortage") {
      const shippingHold = alimtalkShippingHoldState(invoice);
      if (!shippingHold.on || !shippingHold.known) continue;
    }

    const itemState = workflowItemState(invoice, item);
    const shortageQty = reason === "shortage"
      ? workflowAwareShortageQty(itemState, item) || previousShortageQuantity(invoice, item) || shortageQty(item) || 1
      : 0;
    rows.push(alimtalkBaseRow(
      { key: displayRow.key, invoice },
      item,
      {
        key: displayRow.key,
        csReason: reason,
        currentShortageQty: reason === "shortage" ? shortageQty : 0,
        shortageQty: reason === "shortage" ? shortageQty : 0,
        hasOpenShortage: reason === "shortage",
        shortageQtyTotal: reason === "shortage" ? shortageQty : 0,
        alimtalkCaseRow: displayRow.caseRow || null,
        alimtalkSendLog: String(displayRow?.order?.sellpia_outbound_scheduled_date || invoice?.raw?.sellpia_outbound_scheduled_date || ""),
      },
    ));
    seen.add(rowKey);
  }

  return rows;
}

function mergeAlimtalkSourceRows(...lists) {
  const merged = [];
  const seen = new Set();
  for (const row of lists.flat()) {
    const reason = String(row?.csReason || "").trim();
    const ordNo = alimtalkOrderNo(row);
    const itemNo = String(row?.item?.raw?.item_no || row?.item?.sellpiaItemNo || "").trim();
    // Tomorrow-shipping notifications are order-scoped. The CS list and the
    // direct source can select different representative items from the same
    // order, so dedupe them by order before applying the item-row exclusion.
    const key = reason === "tomorrow"
      ? `${ordNo}::tomorrow`
      : `${ordNo}::${itemNo}::${reason}`;
    if (!ordNo || seen.has(key)) continue;
    seen.add(key);
    merged.push(row);
  }
  return merged;
}

function alimtalkExcludedForExport(row) {
  if (row?.alimtalkCaseRow?.alimtalk_excluded) return true;
  const ordNo = alimtalkOrderNo(row);
  const itemNo = String(row?.item?.raw?.item_no || row?.item?.item_no || row?.item?.sellpiaItemNo || "").trim();
  if (!ordNo || !itemNo) return false;
  return state.csCases.some((caseRow) => (
    Boolean(caseRow?.alimtalk_excluded)
    && String(caseRow?.ord_no || "") === ordNo
    && String(caseRow?.item_no || "") === itemNo
  ));
}

function alimtalkCsCaseForRow(row) {
  const ordNo = String(row?.invoice?.orderGroupNo || row?.invoice?.raw?.ord_no || "").trim();
  const itemNo = String(row?.item?.raw?.item_no || row?.item?.item_no || row?.item?.sellpiaItemNo || "").trim();
  if (!ordNo || !itemNo) return null;
  return state.csCases.find((caseRow) =>
    caseRow.source === "auto"
    && caseRow.case_type === "shortage"
    && String(caseRow.ord_no || "") === ordNo
    && String(caseRow.item_no || "") === itemNo,
  ) || null;
}

function classifyAlimtalkRowsByDay(rows) {
  const groups = Object.fromEntries(CS_DAYS.filter((day) => day.key !== "all").map((day) => [day.key, []]));
  rows.forEach((row) => {
    const pushTemplate = (templateKey, reason) => {
      const dayKey = csDayKeyForTemplate(templateKey);
      if (dayKey) groups[dayKey]?.push({ ...row, csDayKey: dayKey, alimtalkBucket: dayKey, alimtalkBucketReason: reason });
    };
    if (row.csReason === "tomorrow") {
      pushTemplate("d0", "management_memo1");
      return;
    }
    if (!row.hasOpenShortage && !(Number(row.shortageQtyTotal || 0) > 0)) return;
    if (!isValidDateKey(row.delayBaseDate)) return;
    const caseRow = row.alimtalkCaseRow || alimtalkCsCaseForRow(row);
    if (caseRow && caseRow.status !== "pending") return;
    const effective = effectiveAlimtalkElapsedDays(row, {
      basisDate: row.delayBaseDate,
      isGold: isGoldItem(row.item),
    });
    const rule = resolveAlimtalkTemplate({
      elapsedDays: effective.elapsedDays,
      isGold: isGoldItem(row.item),
      isMakeshop: isCsMakeshopMethod(row),
      selectedTemplate: effective.anchor.hasAnchor ? effective.selectedTemplate : caseRow?.alimtalk_template || "",
    });
    if (!rule.templateKey) return;
    pushTemplate(rule.templateKey, `exact_day_${rule.elapsedDays}`);
  });
  return groups;
}

function alimtalkRowsForDay(dayKey, rows) {
  const debugSpacer = ["", "", ""];
  const debugHeader = [
    "판매처",
    "접수일",
    "배송보류 ON/OFF",
    "미송상품",
    "알림톡 일차",
  ];
  const header = (dayKey === "내일출고" ? ["전화번호", "#{NAME}"] : ["전화번호", "#{NAME}", "#{PRODUCT}", "#{OPTION}"]).concat(debugSpacer, debugHeader);
  const body = rows.map((row) =>
    dayKey === "내일출고"
      ? [alimtalkPhone(row.invoice), alimtalkName(row.invoice), ...debugSpacer, ...alimtalkDebugColumns(row)]
      : [alimtalkPhone(row.invoice), alimtalkName(row.invoice), alimtalkProduct(row.item), alimtalkOptionWithInboundExpectedDate(row.item), ...debugSpacer, ...alimtalkDebugColumns(row)],
  );
  return [header, ...body];
}

function alimtalkOrderNo(row) {
  return String(row?.invoice?.orderGroupNo || row?.invoice?.raw?.ord_no || row?.key || "").trim();
}

async function exportAlimtalkCsv() {
  if (!allowWrites) {
    toast("알림톡 내보내기 이력을 남기려면 URL에 write=1을 붙여야 합니다.");
    return;
  }
  const allRows = mergeAlimtalkSourceRows(
    buildAlimtalkRowsFromCurrentCsCases(),
    buildAlimtalkRowsFromCsInvoices(allCsRows()),
  ).filter((row) => !alimtalkExcludedForExport(row));
  if (!allRows.length) {
    toast("알림톡 CSV 대상이 없습니다.");
    return;
  }
  const byDay = classifyAlimtalkRowsByDay(allRows);
  const timestamp = timestampForFilename();
  const files = [];
  const sendTargets = new Map();
  let fileCount = 0;
  let rowCount = 0;
  CS_DAYS.filter((day) => day.key !== "all").forEach((day) => {
    const templateKey = CS_DAY_TEMPLATE[day.key] || day.key;
    const rows = byDay[day.key] || [];
    if (!rows.length) return;
    const csvRows = alimtalkRowsForDay(day.key, rows);
    files.push({
      filename: `alimtalk_${compactFilenamePart(day.label)}_${templateKey}_${timestamp}.csv`,
      content: csvRowsToText(csvRows),
    });
    rows.forEach((row) => {
      const ordNo = alimtalkOrderNo(row);
      if (!ordNo) return;
      const key = alimtalkSendNaturalKey(ordNo, templateKey);
      const existing = sendTargets.get(key);
      sendTargets.set(key, {
        ord_no: ordNo,
        inv_no: String(row.invoice?.invoiceNo || row.invoice?.raw?.inv_no || "").trim() || null,
        template_key: templateKey,
        basis_date: String(row.delayBaseDate || row.invoice?.receiptDate || "").trim() || null,
        target_snapshot: {
          item_count: Number(existing?.target_snapshot?.item_count || 0) + 1,
          item_keys: [...new Set([...(existing?.target_snapshot?.item_keys || []), String(row.item?.raw?.item_no || row.item?.sellpiaItemNo || "").trim()].filter(Boolean))],
        },
      });
    });
    fileCount += 1;
    rowCount += rows.length;
  });
  if (!files.length || !sendTargets.size) {
    toast("오늘 정확한 일차의 새 알림톡 대상이 없습니다.");
    return;
  }
  const batch = await alimtalkSends.createExportBatch({ items: [...sendTargets.values()] });
  const syncedOrders = await recordAlimtalkSendScheduledDate(batch.id);
  await alimtalkSends.confirmExportBatch(batch.id);
  downloadBlob(`${monthDayForFilename()}알림톡.zip`, buildZipBlob(files));
  toast(`알림톡 ZIP ${fileCount}개 파일 · ${rowCount}행을 내보내고 발송로그 ${syncedOrders}건을 기록했습니다.`);
}

function invoiceReceiverTel(invoice) {
  return firstRawText(invoice.raw, "receiver_tel", "recipient_tel", "receiver_phone", "recipient_phone", "tel");
}

function invoiceReceiverMobile(invoice) {
  return (
    firstRawText(invoice.raw, "receiver_mobile", "recipient_mobile", "receiver_hp", "recipient_hp", "mobile") ||
    (!invoiceReceiverTel(invoice) ? invoice.recipientPhone : "")
  );
}

function invoiceZipcode(invoice) {
  return firstRawText(invoice.raw, "zipcode", "zip_code", "post_code", "receiver_zipcode", "recipient_zipcode", "receiver_zip");
}

function invoiceAddress(invoice) {
  const direct = firstRawText(invoice.raw, "receiver_address", "recipient_address", "address", "addr", "receiver_addr", "recipient_addr");
  if (direct) return direct;
  return [firstRawText(invoice.raw, "receiver_addr1", "recipient_addr1", "addr1"), firstRawText(invoice.raw, "receiver_addr2", "recipient_addr2", "addr2")]
    .filter(Boolean)
    .join(" ");
}

function buildToggleCsvRows() {
  const headers = [
    "주문번호",
    "접수일자",
    "주문품목No",
    "판매처상품명",
    "판매처옵션명",
    "주문수량",
    "수취인명",
    "수취인연락처",
    "수취인핸드폰",
    "우편번호",
    "주소",
    "주문메모",
  ];
  const rows = [headers];
  frontOrderedInvoicesForExport().forEach((invoice) => {
    invoiceItemsInSellpiaRowOrder(invoice).forEach((item) => {
      rows.push([
        invoice.orderGroupNo || "",
        invoice.receiptDate || "",
        itemSellpiaItemNo(item),
        itemSellerProductName(item),
        itemSellerOptionName(item),
        item.quantity || 1,
        invoice.recipientName || invoice.displayName || "",
        invoiceReceiverTel(invoice),
        invoiceReceiverMobile(invoice),
        invoiceZipcode(invoice),
        invoiceAddress(invoice),
        itemOrderMemo(invoice, item),
      ]);
    });
  });
  return rows;
}

function validateToggleCsvRows(rows) {
  const stats = {
    total: 0,
    missingRequired: 0,
    missingName: 0,
    missingTel: 0,
    missingZip: 0,
    missingAddress: 0,
    missingItemNo: 0,
    badItemNo: 0,
  };
  for (let index = 1; index < rows.length; index += 1) {
    const row = rows[index];
    stats.total += 1;
    const orderNo = String(row[0] || "").trim();
    const itemNo = String(row[2] || "").trim();
    const name = String(row[6] || "").trim();
    const hasTel = String(row[7] || "").trim() || String(row[8] || "").trim();
    const zip = String(row[9] || "").trim();
    const address = String(row[10] || "").trim();
    if (!itemNo) stats.missingItemNo += 1;
    if (itemNo && orderNo && itemNo === orderNo) stats.badItemNo += 1;
    if (!name) stats.missingName += 1;
    if (!hasTel) stats.missingTel += 1;
    if (!zip) stats.missingZip += 1;
    if (!address) stats.missingAddress += 1;
    if (!name || !hasTel || !zip || !address || !itemNo || itemNo === orderNo) stats.missingRequired += 1;
  }
  return stats;
}

function showPostOfficeEnrichmentStatus() {
  if (!state.viewModel?.invoices?.length) {
    toast("보강현황 대상 주문이 없습니다.");
    return;
  }

  const invoices = exportOrderedInvoices();
  const rows = buildToggleCsvRows();
  const stats = validateToggleCsvRows(rows);
  let enriched = 0;
  let missingAddress = 0;
  let missingTel = 0;
  let missingZip = 0;
  let missingMobile = 0;
  let missingMemo = 0;
  let missingOrderNo = 0;

  invoices.forEach((invoice) => {
    if (firstRawText(invoice.raw, "enriched_at", "postoffice_enriched_at")) enriched += 1;
    if (!invoiceAddress(invoice)) missingAddress += 1;
    if (!invoiceReceiverTel(invoice) && !invoiceReceiverMobile(invoice)) missingTel += 1;
    if (!invoiceReceiverMobile(invoice)) missingMobile += 1;
    if (!invoiceZipcode(invoice)) missingZip += 1;
    if (!itemOrderMemo(invoice, (invoice.items || [])[0] || {})) missingMemo += 1;
    if (!String(invoice.orderGroupNo || "").trim()) missingOrderNo += 1;
  });

  const message = [
    "토글 등록 CSV 준비 현황",
    "",
    `총 주문: ${invoices.length}`,
    `CSV 상품행: ${stats.total}`,
    `보강 완료(enriched_at): ${enriched}`,
    `주소 누락: ${missingAddress}`,
    `연락처(전화/핸드폰 모두) 누락: ${missingTel}`,
    `핸드폰 누락: ${missingMobile}`,
    `우편번호 누락: ${missingZip}`,
    `주문메모 누락: ${missingMemo}`,
    `주문번호 누락: ${missingOrderNo}`,
    `주문품목No 누락: ${stats.missingItemNo}`,
    `주문번호로 잘못 들어간 품목No: ${stats.badItemNo}`,
    `필수정보 누락 상품행: ${stats.missingRequired}`,
  ].join("\n");

  console.log("[TOGLE] registration CSV status", {
    totalOrders: invoices.length,
    enriched,
    missingAddress,
    missingTel,
    missingMobile,
    missingZip,
    missingMemo,
    missingOrderNo,
    csvStats: stats,
  });
  window.alert(message);
}

async function exportToggleCsv() {
  // Sellpia scraping runs outside this page, so the in-memory view can still
  // contain pre-scrape rows. Refresh before building the frontend-ordered CSV.
  await loadPickingData();
  if (!state.viewModel?.invoices?.length) {
    toast("토글 CSV 대상이 없습니다.");
    return;
  }
  if (state.session !== "ALL" && !window.confirm("현재 오전/오후 필터가 적용되어 있습니다. 현재 필터 데이터만 토글 CSV로 받을까요?")) {
    return;
  }
  const rows = buildToggleCsvRows();
  const stats = validateToggleCsvRows(rows);
  if (stats.missingRequired > 0) {
    const proceed = window.confirm(
      `토글 등록 필수정보가 누락된 행이 있습니다.\n\n총 ${stats.total}행 중 ${stats.missingRequired}행 누락\n- 수취인명: ${stats.missingName}\n- 연락처: ${stats.missingTel}\n- 우편번호: ${stats.missingZip}\n- 주소: ${stats.missingAddress}\n- 주문품목No: ${stats.missingItemNo}\n- 주문번호로 들어간 품목No: ${stats.badItemNo}\n\n그래도 다운로드할까요?`,
    );
    if (!proceed) return;
  }
  downloadCsv(`togle_registration_${timestampForFilename()}.csv`, rows);
  toast(`토글 CSV ${rows.length - 1}행 다운로드`);
}

const LABEL_CSV_HEADER = ["라벨번호", "상품코드", "자사코드", "판매처 상품명", "판매처 옵션명", "수량", "접수일자", "수취인"];

function createLabelExportStats() {
  return {
    originalRows: 0,
    targetRows: 0,
    finalRows: 0,
    invalidQtyDefaulted: 0,
    skipped: {
      noPrivateCode: 0,
      bareGpa: 0,
      caExcluded: 0,
      notGp: 0,
      optionFailed: 0,
      qtyZero: 0,
      printed: 0,
      duplicateKey: 0,
    },
  };
}

function addLabelSkip(stats, reason) {
  if (stats?.skipped && Object.prototype.hasOwnProperty.call(stats.skipped, reason)) stats.skipped[reason] += 1;
}

function normalizePrivateCode(rawCode) {
  const raw = String(rawCode || "").trim();
  if (!raw) return "";
  const match = raw.match(/\[[^\]]+\]/);
  return match ? match[0].trim() : "";
}

function getLabelTargetResult(row, stats) {
  const raw = String(row?.privateCode ?? row?.prodCode ?? row?.code ?? "").trim();
  if (!raw) {
    addLabelSkip(stats, "noPrivateCode");
    return { ok: false, code: "" };
  }
  if (isBareGpaOwnCode(raw)) {
    addLabelSkip(stats, "bareGpa");
    return { ok: false, code: "" };
  }
  const normalized = normalizePrivateCode(raw);
  if (/^\[CA/i.test(raw) || /^\[CA/i.test(normalized)) {
    addLabelSkip(stats, "caExcluded");
    return { ok: false, code: normalized };
  }
  if (!normalized || !/^\[GP/i.test(normalized)) {
    addLabelSkip(stats, "notGp");
    return { ok: false, code: normalized };
  }
  return { ok: true, code: normalized };
}

function isLabelTarget(row) {
  return getLabelTargetResult(row, null).ok;
}

function normalizeProductName(productCode, productName) {
  if (String(productCode || "").trim().startsWith("6778")) return "14K 골드 볼 피어싱 0.8mm 24종";
  return String(productName || "").trim();
}

function formatCsvTextCell(value) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  return `="${text.replace(/"/g, '""')}"`;
}

function normalizeLabelOptionName(optionName) {
  let value = String(optionName || "").trim();
  if (value.includes(",")) value = value.split(",")[0];
  if (value.includes(":")) value = value.split(":").pop();
  if (value.includes("[")) value = value.split("[")[0];
  return value.trim();
}

function labelDateValue(value) {
  const raw = String(value || "").trim();
  const compact = raw.match(/^(\d{4})[-./]?(\d{2})[-./]?(\d{2})/);
  const date = compact ? new Date(Number(compact[1]), Number(compact[2]) - 1, Number(compact[3])) : new Date(raw);
  return Number.isNaN(date.getTime()) ? null : new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function getLabelDayOffset(receivedAt) {
  const selectedDate = labelDateValue(state.selectedDate);
  const receivedDate = labelDateValue(receivedAt || state.selectedDate);
  if (!selectedDate || !receivedDate) return 0;
  const diffMs = selectedDate.getTime() - receivedDate.getTime();
  return Math.max(0, Math.round(diffMs / 86400000));
}

function makeLabelKey(row, privateCode, optionName, unitIndex) {
  return [
    String(row?.invNo || row?.orderNo || "").trim(),
    String(row?.itemNo || "").trim(),
    String(row?.productCode || "").trim(),
    String(privateCode || "").trim(),
    String(optionName || "").trim(),
    String(row?.receivedAt || "").trim(),
    String(unitIndex),
  ].join("|");
}

function getPrintedLabelKeys() {
  return new Set();
}

function expandRowsByQty(row, stats) {
  const rawQty = String(row?.qty ?? "").replace(/,/g, "").trim();
  let qty = parseInt(rawQty, 10);
  if (!Number.isFinite(qty)) {
    qty = 1;
    if (stats) stats.invalidQtyDefaulted += 1;
  }
  if (qty <= 0) {
    addLabelSkip(stats, "qtyZero");
    return [];
  }
  return Array.from({ length: qty }, () => ({ ...row, qty: 1 }));
}

function buildLabelCsvRows(rows, options = {}) {
  const stats = createLabelExportStats();
  const csvRows = [LABEL_CSV_HEADER];
  const xlsxMode = options.format === "xlsx";
  const dayOffsetSeq = {};
  const emittedKeys = new Set();
  const printedKeys = options.printedKeys || getPrintedLabelKeys();
  const newLabelKeys = [];

  (rows || []).forEach((row) => {
    stats.originalRows += 1;
    const target = getLabelTargetResult(row, stats);
    if (!target.ok) return;
    const optionName = normalizeLabelOptionName(row.optionName);
    if (!optionName) {
      addLabelSkip(stats, "optionFailed");
      return;
    }
    const expanded = expandRowsByQty(row, stats);
    if (!expanded.length) return;
    stats.targetRows += 1;
    const productName = normalizeProductName(row.productCode, row.productName);
    const dayOffset = getLabelDayOffset(row.receivedAt);
    expanded.forEach((expandedRow, copyIndex) => {
      const unitIndex = copyIndex + 1;
      const labelKey = makeLabelKey(row, target.code, optionName, unitIndex);
      if (printedKeys.has(labelKey)) {
        addLabelSkip(stats, "printed");
        return;
      }
      if (emittedKeys.has(labelKey)) {
        addLabelSkip(stats, "duplicateKey");
        return;
      }
      emittedKeys.add(labelKey);
      newLabelKeys.push(labelKey);
      dayOffsetSeq[dayOffset] = (dayOffsetSeq[dayOffset] || 0) + 1;
      csvRows.push([
        `(${dayOffset})-${dayOffsetSeq[dayOffset]}`,
        xlsxMode ? String(expandedRow.productCode || "").trim() : formatCsvTextCell(expandedRow.productCode || ""),
        target.code,
        productName,
        optionName,
        1,
        expandedRow.receivedAt || "",
        expandedRow.recipient || "",
      ]);
    });
  });

  stats.finalRows = csvRows.length - 1;
  return { rows: csvRows, stats, labelKeys: newLabelKeys };
}

function downloadLabelCsv(filename, rows) {
  downloadCsv(filename, rows);
}

function downloadLabelXlsx(filename, rows) {
  if (!window.XLSX) {
    toast("XLSX 라이브러리 로드 실패: CSV로 저장합니다.");
    downloadLabelCsv(filename.replace(/\.xlsx$/i, ".csv"), rows);
    return;
  }
  const wb = window.XLSX.utils.book_new();
  const ws = window.XLSX.utils.aoa_to_sheet(rows || []);
  ws["!cols"] = [{ wch: 10 }, { wch: 14 }, { wch: 16 }, { wch: 42 }, { wch: 36 }, { wch: 8 }, { wch: 12 }, { wch: 12 }];
  const range = window.XLSX.utils.decode_range(ws["!ref"] || "A1:A1");
  for (let row = 0; row <= range.e.r; row += 1) {
    ["B", "C", "G"].forEach((col) => {
      const address = `${col}${row + 1}`;
      if (ws[address]) {
        ws[address].t = "s";
        ws[address].z = "@";
      }
    });
  }
  window.XLSX.utils.book_append_sheet(wb, ws, "라벨");
  window.XLSX.writeFile(wb, filename, { bookType: "xlsx" });
}

function labelReceivedAtForItem(invoice, item) {
  return invoice?.receiptDate || firstRawText(item.raw, "receipt_date") || "";
}

function labelShortageRankKeysForRow(row) {
  const orderKeys = [row?.ord_no, row?.inv_no].map((value) => String(value || "").trim()).filter(Boolean);
  const itemKeys = [row?.item_no, row?.p_code, row?.sellpia_p_code].map((value) => String(value || "").trim()).filter(Boolean);
  return orderKeys.flatMap((orderKey) => itemKeys.map((itemKey) => `${orderKey}::${itemKey}`));
}

function labelShortageRankKeysForItem(invoice, item) {
  const orderKeys = [invoice?.orderGroupNo, invoice?.invoiceNo].map((value) => String(value || "").trim()).filter(Boolean);
  const itemKeys = [item?.sellpiaItemNo, item?.ownCode, item?.sellpiaProductCode].map((value) => String(value || "").trim()).filter(Boolean);
  return orderKeys.flatMap((orderKey) => itemKeys.map((itemKey) => `${orderKey}::${itemKey}`));
}

async function loadLabelShortageRankMap() {
  const rows = await fetchAllRows(() =>
    db
      .from("shortage")
      .select("ord_no,inv_no,item_no,p_code,sellpia_p_code,created_at,updated_at,work_date")
      .order("created_at", { ascending: true, nullsFirst: false }),
  );
  const map = new Map();
  rows.forEach((row, index) => {
    const time = new Date(row.created_at || row.updated_at || row.work_date || 0).getTime() || 0;
    const rank = { index, time };
    labelShortageRankKeysForRow(row).forEach((key) => {
      if (!map.has(key)) map.set(key, rank);
    });
  });
  return map;
}

function labelItemRank(invoice, item, shortageRankMap) {
  for (const key of labelShortageRankKeysForItem(invoice, item)) {
    const rank = shortageRankMap?.get(key);
    if (rank) return rank;
  }
  return null;
}

function compareLabelItems(invoice, shortageRankMap) {
  return (a, b) => {
    const aRank = labelItemRank(invoice, a, shortageRankMap);
    const bRank = labelItemRank(invoice, b, shortageRankMap);
    if (aRank || bRank) {
      if (!aRank) return 1;
      if (!bRank) return -1;
      if (aRank.time !== bRank.time) return aRank.time - bRank.time;
      if (aRank.index !== bRank.index) return aRank.index - bRank.index;
    }
    return compareInvoiceItemsBySellpiaRow(a, b);
  };
}

function labelInvoiceRank(invoice, shortageRankMap) {
  let best = null;
  (invoice.items || []).forEach((item) => {
    const rank = labelItemRank(invoice, item, shortageRankMap);
    if (!rank) return;
    if (!best || rank.time < best.time || (rank.time === best.time && rank.index < best.index)) best = rank;
  });
  return best;
}

function labelSourceInvoices(shortageRankMap = new Map()) {
  void shortageRankMap;
  return inspectionSourceInvoices()
    .filter(invoiceHasGold)
    .filter(invoiceHasLabelTarget)
    .sort((a, b) => {
      const aReceivedAt = labelReceivedAtForItem(a, (a.items || [])[0]);
      const bReceivedAt = labelReceivedAtForItem(b, (b.items || [])[0]);
      return getLabelDayOffset(aReceivedAt) - getLabelDayOffset(bReceivedAt);
    });
}

function labelItemsForInvoice(invoice, shortageRankMap) {
  void shortageRankMap;
  return invoiceItemsInSellpiaRowOrder(invoice);
}

function buildGoldLabelSourceRows(shortageRankMap = new Map()) {
  return labelSourceInvoices(shortageRankMap).flatMap((invoice) =>
    labelItemsForInvoice(invoice, shortageRankMap).map((item) => ({
      invNo: invoice.invoiceNo || "",
      orderNo: invoice.orderGroupNo || "",
      itemNo: item.sellpiaItemNo || "",
      productCode: item.sellpiaProductCode || "",
      privateCode: item.ownCode || "",
      productName: item.productName || "",
      optionName: item.optionName || "",
      qty: item.quantity,
      receivedAt: labelReceivedAtForItem(invoice, item),
      recipient: invoice.recipientName || invoice.buyerName || invoice.displayName || "",
    })),
  );
}

async function exportGoldLabelXlsx() {
  if (!state.workflowQueues && !state.workflowQueueError) {
    await loadWorkflowData();
  }
  const shortageRankMap = await loadLabelShortageRankMap();
  const sourceRows = buildGoldLabelSourceRows(shortageRankMap);
  if (!sourceRows.length) {
    toast("라벨 XLSX 대상이 없습니다.");
    return;
  }
  const result = buildLabelCsvRows(sourceRows, { format: "xlsx" });
  if (!result.rows || result.rows.length <= 1) {
    toast("라벨 XLSX 대상 GP 상품이 없습니다.");
    return;
  }
  downloadLabelXlsx(`label_${timestampForFilename()}.xlsx`, result.rows);
  toast(`라벨 XLSX ${result.rows.length - 1}행 다운로드`);
}

async function reorderInvoiceSortOrder() {
  if (!allowOrderReorder) {
    toast("송장순서 재정렬이 비활성화되어 있습니다.");
    return;
  }
  if (state.session === "ALL") {
    toast("오전 또는 오후를 선택한 뒤 해당 시간대만 송장순서 재정렬하세요.");
    return;
  }
  const targetSession = state.session;
  const ordered = workOrderedInvoices().filter((invoice) => String(invoice?.session || invoice?.raw?.am_pm || "").trim().toUpperCase() === targetSession);
  if (!ordered.length) {
    toast(`${targetSession === "AM" ? "오전" : "오후"} 재정렬할 송장이 없습니다.`);
    return;
  }

  const sessionLabel = targetSession === "AM" ? "오전" : "오후";
  const proceed = window.confirm(
    `현재 ${sessionLabel} 화면에 보이는 작업순서 기준으로 ${ordered.length}개 송장의 sort_order를 다시 저장할까요?\n다른 시간대 송장순서는 변경하지 않습니다.\n골드 송장은 해당 시간대의 뒤쪽으로 배치됩니다.`,
  );
  if (!proceed) return;

  for (let index = 0; index < ordered.length; index += 1) {
    const invoice = ordered[index];
    const nextSortOrder = index + 1;
    const { error } = await db.from("orders").update({ sort_order: nextSortOrder }).eq("ord_no", invoice.orderGroupNo).eq("am_pm", targetSession);
    if (error) throw error;
    invoice.sortOrder = nextSortOrder;
  }

  state.workSortMode = false;
  els.sortToggle.classList.remove("primary");
  els.sortToggle.textContent = "송장순서";
  state.currentGroup = 0;
  await loadPickingData();
  toast(`${sessionLabel} 송장순서 재정렬 완료: ${ordered.length}건`);
}

async function reorderInvoicesByCurrentView() {
  return reorderInvoiceSortOrder();
}

async function completeShortagePickingRow(row, { render = true } = {}) {
  const itemState = workflowItemState(row.invoice, row.item) || row.state;
  if (itemState?.shortageRepicked || itemState?.inspected || itemState?.cancelled) {
    return false;
  }

  const operationKey = `shortage-complete::${workflowItemKey(row.invoice, row.item)}`;
  if (state.saving.has(operationKey)) return false;
  state.saving.add(operationKey);

  const previousMemo2 = itemManagementMemo2(row.item);
  let memo2Cleared = false;
  try {
    await updateOrderItemMemoFields(row.invoice.orderGroupNo, row.item.sellpiaItemNo, { o_shop_memo2: "" });
    memo2Cleared = true;

    const ok = await saveWorkflowItemEvent(
      row.invoice,
      row.item,
      "shortage_repick_completed",
      {
        quantity: 0,
        memo: "shortage repicked",
        drawerMemo: row.state?.drawerMemo || row.item.pickingState?.drawerMemo || row.invoice.sellpiaMemo1 || null,
      },
      { render },
    );
    if (!ok) {
      await updateOrderItemMemoFields(row.invoice.orderGroupNo, row.item.sellpiaItemNo, { o_shop_memo2: previousMemo2 });
      return false;
    }

    patchLocalItemManagementMemos(row.invoice.orderGroupNo, row.item.sellpiaItemNo, { memo2: "" });
  } catch (error) {
    if (memo2Cleared) {
      try {
        await updateOrderItemMemoFields(row.invoice.orderGroupNo, row.item.sellpiaItemNo, { o_shop_memo2: previousMemo2 });
      } catch (rollbackError) {
        console.warn("shortage repick memo2 rollback failed", rollbackError);
      }
    }
    throw error;
  } finally {
    state.saving.delete(operationKey);
  }

  return true;
}

function nextOpenShortageKeyInSameOrder(completedRow) {
  const completedKey = workflowItemKey(completedRow.invoice, completedRow.item);
  const sourceOrderNo = sourceOrderGroupNo(completedRow.invoice, completedRow.item);
  const nextRow = (state.workflowQueues?.shortageItems || []).find((row) => (
    workflowItemKey(row.invoice, row.item) !== completedKey
    && sourceOrderGroupNo(row.invoice, row.item) === sourceOrderNo
    && !row.completed
    && !row.cancelled
    && !itemIsEffectivelyCancelled(row.invoice, row.item)
  ));
  return nextRow ? workflowItemKey(nextRow.invoice, nextRow.item) : "";
}

async function completeSelectedShortagePicking(
  shortageKey = state.selectedShortageKey,
  { keepSameOrder = false } = {},
) {
  const row = (state.workflowQueues?.shortageItems || []).find(({ invoice, item }) => workflowItemKey(invoice, item) === shortageKey);
  if (!row) {
    toast("미송피킹 대상을 찾지 못했습니다.");
    return false;
  }

  const nextSameOrderKey = keepSameOrder ? nextOpenShortageKeyInSameOrder(row) : "";
  const completed = await completeShortagePickingRow(row, { render: false });
  if (!completed) {
    toast("이미 완료됐거나 저장하지 못한 미송피킹입니다.");
    return false;
  }

  state.selectedInspectionGroup = row.invoice.orderGroupNo;
  state.selectedInspectionItemKey = itemSlotKey(row.invoice, row.item);
  state.selectedShortageKey = nextSameOrderKey;
  renderWorkflowSurfaces();
  toast("미송피킹 완료: 관리메모2를 비우고 검품탭에 송장 전체가 표시됩니다.");
  return true;
}

async function completeCheckedShortagePickings() {
  if (state.shortageBulkSaving) return;
  const selectedKeys = new Set(state.shortageBulkSelectedKeys);
  const targets = (state.workflowQueues?.shortageItems || []).filter(({ invoice, item }) =>
    selectedKeys.has(workflowItemKey(invoice, item)),
  );
  if (!targets.length) {
    state.shortageBulkSelectedKeys.clear();
    renderShortagePanels();
    toast("미송피킹 완료 대상을 체크해 주세요.");
    return;
  }

  const confirmed = window.confirm(`미송피킹 체크 내역 ${targets.length}건을 일괄 완료처리 하시겠습니까?`);
  if (!confirmed) return;

  state.shortageBulkSaving = true;
  renderShortagePanels();
  let successCount = 0;
  const failedKeys = [];
  let firstCompletedInvoice = null;
  try {
    for (const row of targets) {
      const key = workflowItemKey(row.invoice, row.item);
      try {
        const completed = await completeShortagePickingRow(row, { render: false });
        if (!completed) {
          failedKeys.push(key);
          continue;
        }
        if (!firstCompletedInvoice) firstCompletedInvoice = row.invoice;
        state.shortageBulkSelectedKeys.delete(key);
        successCount += 1;
      } catch (error) {
        console.warn("bulk shortage repick failed", key, error);
        failedKeys.push(key);
      }
    }
  } finally {
    state.shortageBulkSaving = false;
  }

  if (firstCompletedInvoice) state.selectedInspectionGroup = firstCompletedInvoice.orderGroupNo;
  if (
    successCount &&
    selectedKeys.has(state.selectedShortageKey) &&
    !state.shortageBulkSelectedKeys.has(state.selectedShortageKey)
  ) {
    state.selectedShortageKey = "";
  }
  renderWorkflowSurfaces();
  if (!failedKeys.length) {
    toast(`미송피킹 일괄완료: ${successCount}건`);
    return;
  }
  toast(`미송피킹 일괄완료: 성공 ${successCount}건 · 실패 ${failedKeys.length}건 (실패 항목은 체크 유지)`);
}

function findWorkflowInvoiceItem(orderGroupNo, sellpiaItemNo) {
  const groupNo = String(orderGroupNo || "");
  const itemNo = String(sellpiaItemNo || "");
  const invoices = [
    ...(state.workflowQueues?.viewModel?.invoices || []),
    ...(state.workflowQueues?.inspectionInvoices || []),
    ...(state.workflowQueues?.inspectionCompletedInvoices || []),
  ];
  for (const invoice of invoices) {
    if (String(invoice.orderGroupNo || "") !== groupNo) continue;
    const item = (invoice.items || []).find((entry) => String(entry.sellpiaItemNo || "") === itemNo);
    if (item) return { invoice, item };
  }
  return { invoice: null, item: null };
}

function previousShortageQuantity(invoice, item) {
  const key = workflowItemKey(invoice, item);
  const events = [...(state.workflowQueues?.syntheticEvents?.itemEvents || []), ...(state.workflowQueues?.itemEvents || [])]
    .filter((event) => `${event.order_group_no}::${event.sellpia_item_no}` === key)
    .sort((a, b) => workflowEventTime(a) - workflowEventTime(b) || Number(a.id || 0) - Number(b.id || 0));

  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.event_type !== "shortage_created" && event.event_type !== "shortage_qty_changed") continue;
    const qty = Number(event.quantity || 0);
    if (qty > 0) return qty;
  }
  return Number(item.shortageState?.shortageQty || item.pickingState?.shortageQty || 1) || 1;
}

async function reopenShortageRepick(orderGroupNo, sellpiaItemNo) {
  const { invoice, item } = findWorkflowInvoiceItem(orderGroupNo, sellpiaItemNo);
  if (!invoice || !item) {
    toast("미송피킹 완료취소 대상을 찾지 못했습니다.");
    return false;
  }
  const itemState = workflowItemState(invoice, item);
  if (!itemState?.shortageRepicked || itemState?.cancelled) {
    toast("이미 미송피킹 대기 상태입니다.");
    return false;
  }

  const operationKey = `shortage-reopen::${workflowItemKey(invoice, item)}`;
  if (state.saving.has(operationKey)) return false;
  state.saving.add(operationKey);

  const previousMemo2 = itemManagementMemo2(item);
  const restoredQuantity = previousShortageQuantity(invoice, item);
  const restoredMemo2 = String(restoredQuantity);
  let memo2Restored = false;
  try {
    await updateOrderItemMemoFields(orderGroupNo, sellpiaItemNo, { o_shop_memo2: restoredMemo2 });
    memo2Restored = true;

    const ok = await saveWorkflowItemEvent(invoice, item, "shortage_created", {
      quantity: restoredQuantity,
      memo: restoredMemo2,
      drawerMemo: itemState?.drawerMemo || item.pickingState?.drawerMemo || invoice.sellpiaMemo1 || null,
    });
    if (!ok) {
      await updateOrderItemMemoFields(orderGroupNo, sellpiaItemNo, { o_shop_memo2: previousMemo2 });
      return false;
    }

    patchLocalItemManagementMemos(orderGroupNo, sellpiaItemNo, { memo2: restoredMemo2 });
    await ensureShippingHoldOnAfterMemoSave(invoice, restoredMemo2);
  } catch (error) {
    if (memo2Restored) {
      try {
        await updateOrderItemMemoFields(orderGroupNo, sellpiaItemNo, { o_shop_memo2: previousMemo2 });
      } catch (rollbackError) {
        console.warn("shortage reopen memo2 rollback failed", rollbackError);
      }
    }
    throw error;
  } finally {
    state.saving.delete(operationKey);
  }

  state.activeTab = "shortage";
  state.selectedShortageKey = workflowItemKey(invoice, item);
  state.selectedInspectionGroup = "";
  renderWorkflowSurfaces();
  toast(`미송피킹 완료를 취소했습니다. 관리메모2를 ${restoredMemo2}(으)로 복원했습니다.`);
  return true;
}

async function saveSelectedShortageMemo(shortageKey = state.selectedShortageKey) {
  const row = (state.workflowQueues?.shortageItems || []).find(({ invoice, item }) => workflowItemKey(invoice, item) === shortageKey);
  if (!row) {
    toast("미송피킹 대상을 찾지 못했습니다.");
    return;
  }
  const drawerMemo = els.shortageDetail?.querySelector("[data-shortage-field='drawerMemo']")?.value?.trim() || "";
  const memo = els.shortageDetail?.querySelector("[data-shortage-field='memo']")?.value?.trim() || "";
  const qty = Number(row.state?.shortageQty || 0) || 1;
  // 관리메모1(서랍번호)은 송장 전체 공통값이고 관리메모2만 상품행 값입니다.
  await saveDrawerForInvoice(row.invoice, drawerMemo);
  await updateOrderItemMemoFields(row.invoice.orderGroupNo, row.item.sellpiaItemNo, { o_shop_memo2: memo });
  const ok = await saveWorkflowItemEvent(row.invoice, row.item, "shortage_qty_changed", {
    quantity: qty,
    memo,
    drawerMemo,
  });
  if (!ok) return;
  patchLocalItemManagementMemos(row.invoice.orderGroupNo, row.item.sellpiaItemNo, { memo2: memo });
  await ensureShippingHoldOnAfterMemoSave(row.invoice, `${drawerMemo}\n${memo}`);
  state.selectedShortageKey = shortageKey;
  renderWorkflowSurfaces();
  toast("미송 메모 저장 완료");
}

function findInspectionInvoiceItem(orderGroupNo, sellpiaItemNo) {
  const groupNo = String(orderGroupNo || "");
  const itemNo = String(sellpiaItemNo || "");
  const invoices = [
    ...(state.viewModel?.invoices || []),
    ...(state.workflowQueues?.viewModel?.invoices || []),
    ...(state.workflowQueues?.inspectionInvoices || []),
    ...(state.workflowQueues?.inspectionCompletedInvoices || []),
  ];
  for (const invoice of invoices) {
    if (String(invoice.orderGroupNo || "") !== groupNo) continue;
    const item = (invoice.items || []).find((entry) => String(entry.sellpiaItemNo || "") === itemNo);
    if (item) return { invoice, item };
  }
  return { invoice: null, item: null };
}

async function saveInspectionSellpiaOrderMemo(orderGroupNo, sellpiaItemNo, value) {
  if (!allowWrites) {
    toast("읽기전용입니다. URL에 write=1을 붙여야 셀피아 주문메모를 저장할 수 있습니다.");
    return;
  }
  const { invoice, item } = findInspectionInvoiceItem(orderGroupNo, sellpiaItemNo);
  if (!invoice || !item) {
    toast("셀피아 주문메모 저장 대상을 찾지 못했습니다.");
    return;
  }
  const nextValue = String(value || "");
  const itemNo = String(item.raw?.item_no || item.sellpiaItemNo || "").trim();
  const sellpiaOrderItemNo = String(item.raw?.sellpia_order_item_no || "").trim();
  try {
    await updateOrderItemOrderMemoExact({
      ordNo: invoice.orderGroupNo,
      itemNo,
      sellpiaOrderItemNo,
      patch: { order_memo: nextValue, order_memo_updated_at: new Date().toISOString() },
    });
  } catch (error) {
    if (!/order_memo_updated_at|column|schema cache/i.test(error?.message || "")) {
      toast(`셀피아 주문메모 저장 실패: ${error.message}`);
      throw error;
    }
    await updateOrderItemOrderMemoExact({
      ordNo: invoice.orderGroupNo,
      itemNo,
      sellpiaOrderItemNo,
      patch: { order_memo: nextValue },
    });
  }
  patchLocalSellpiaOrderMemo(invoice, item, nextValue);
  toast("셀피아 주문메모 저장");
}

async function saveInspectionConfirmMemo(orderGroupNo, sellpiaItemNo, value) {
  if (!allowWrites) {
    toast("읽기전용입니다. URL에 write=1을 붙여야 상품 확인메모를 저장할 수 있습니다.");
    return;
  }
  const { invoice, item } = findInspectionInvoiceItem(orderGroupNo, sellpiaItemNo);
  if (!invoice || !item) {
    toast("상품 확인메모 저장 대상을 찾지 못했습니다.");
    return;
  }
  const code = inspectionMemoCode(item);
  if (!code) {
    toast("셀피아코드가 없어 상품 확인메모를 저장할 수 없습니다.");
    return;
  }
  const nextValue = String(value || "").trim();
  const row = {
    inv_no: invoice.invoiceNo || "",
    ord_no: invoice.orderGroupNo,
    item_no: item.sellpiaItemNo || "",
    p_code: code,
    insp_memo: nextValue,
    memo_updated_at: new Date().toISOString(),
  };
  let { error } = await db.from("inspection").upsert(row, { onConflict: "inv_no,p_code" });
  if (error && /memo_updated_at|column|schema cache/i.test(error.message || "")) {
    const { memo_updated_at, ...fallbackRow } = row;
    void memo_updated_at;
    ({ error } = await db.from("inspection").upsert(fallbackRow, { onConflict: "inv_no,p_code" }));
  }
  if (error) {
    toast(`상품 확인메모 저장 실패: ${error.message}`);
    throw error;
  }
  patchLocalInspectionMemo(invoice, item, nextValue);
  toast("상품 확인메모 저장");
}

function selectedInspectionInvoice(orderGroupNo = state.selectedInspectionGroup) {
  return (
    [...inspectionSourceInvoices(), ...(state.workflowQueues?.inspectionCompletedInvoices || [])].find((invoice) => invoice.orderGroupNo === orderGroupNo) ||
    null
  );
}

function inspectionSourceInvoices() {
  return combineInvoicesBySharedInvoice(inspectionBaseInvoices());
}

function shipmentMemberBadge(item) {
  if (!item?.sourceOrderGroupNo) return "";
  const memberNo = Number(item.sourceMemberIndex || 0) + 1;
  return `<span class="shipment-source-badge">주문 ${memberNo}</span>`;
}

function inspectionItemIsSelectable(invoice, item) {
  const invoiceState = workflowInvoiceState(invoice);
  const itemState = workflowItemState(invoice, item);
  return Boolean(
    invoice &&
      item &&
      !invoiceState?.inspected &&
      !invoiceState?.cancelled &&
      !itemState?.inspected &&
      !itemIsEffectivelyCancelled(invoice, item),
  );
}

function inspectionSelectableItems(invoice = selectedInspectionInvoice()) {
  return invoiceItemsInSellpiaRowOrder(invoice).filter((item) => inspectionItemIsSelectable(invoice, item));
}

function selectInspectionItem(key, { scroll = false } = {}) {
  const targetKey = String(key || "");
  state.selectedInspectionItemKey = targetKey;
  els.inspectionDetail?.querySelectorAll("[data-inspection-item-key].is-selected").forEach((row) => row.classList.remove("is-selected"));
  if (!targetKey) return;
  const selectorKey = window.CSS?.escape ? CSS.escape(targetKey) : targetKey.replace(/"/g, '\\"');
  const target = els.inspectionDetail?.querySelector(`[data-inspection-item-key="${selectorKey}"].is-selectable`);
  target?.classList.add("is-selected");
  if (scroll) target?.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function moveInspectionItemSelection(delta) {
  const invoice = selectedInspectionInvoice();
  const keys = inspectionSelectableItems(invoice).map((item) => itemSlotKey(invoice, item));
  if (!keys.length) return;
  const current = keys.indexOf(state.selectedInspectionItemKey);
  const start = current >= 0 ? current : delta < 0 ? keys.length : -1;
  const next = Math.max(0, Math.min(keys.length - 1, start + delta));
  selectInspectionItem(keys[next], { scroll: true });
}

async function completeSelectedInspection(orderGroupNo = state.selectedInspectionGroup) {
  const invoice = selectedInspectionInvoice(orderGroupNo);
  if (!invoice) {
    toast("검품 대기 송장을 찾지 못했습니다.");
    return;
  }
  if (invoiceIsCancelled(invoice)) {
    toast("취소된 주문은 CS 탭에서 취소 해제 후 검품할 수 있습니다.");
    return;
  }
  if (isSystemShippingHoldOn(invoice)) {
    toast("보류 송장은 보류 해제 후 완료 처리할 수 있습니다.");
    return;
  }
  for (const sourceInvoice of sourceInvoicesForShipment(invoice)) {
    const ok = await saveWorkflowInvoiceEvent(sourceInvoice, "inspection_completed", { memo: "inspection completed" });
    if (!ok) return;
  }
  state.activeTab = "inspection";
  state.selectedInspectionGroup = invoice.orderGroupNo;
  state.selectedCompletedGroup = invoice.orderGroupNo;
  state.inspectionHideCompleted = false;
  renderWorkflowSurfaces();
  toast("검품 완료 처리되었습니다.");
}

async function reopenSelectedInspection(orderGroupNo = state.selectedInspectionGroup) {
  const invoice = selectedInspectionInvoice(orderGroupNo);
  if (!invoice) {
    toast("검품 완료 송장을 찾지 못했습니다.");
    return;
  }
  if (invoiceIsCancelled(invoice)) {
    toast("취소된 주문은 CS 탭에서 취소 해제 후 수정할 수 있습니다.");
    return;
  }
  for (const sourceInvoice of sourceInvoicesForShipment(invoice)) {
    const ok = await saveWorkflowInvoiceEvent(sourceInvoice, "inspection_reopened", { memo: "inspection reopened" });
    if (!ok) return;
  }
  state.activeTab = "inspection";
  state.selectedInspectionGroup = invoice.orderGroupNo;
  state.selectedCompletedGroup = "";
  renderWorkflowSurfaces();
  toast("검품 완료가 취소되었습니다.");
}

async function toggleSelectedInspectionHold(orderGroupNo = state.selectedInspectionGroup) {
  const invoice = selectedInspectionInvoice(orderGroupNo);
  if (!invoice) {
    toast("검품 대기 송장을 찾지 못했습니다.");
    return;
  }
  if (invoiceIsCancelled(invoice)) {
    toast("취소된 주문은 CS 탭에서 취소 해제 후 수정할 수 있습니다.");
    return;
  }
  const invoiceState = workflowInvoiceState(invoice);
  const holdOn = Boolean(invoiceState?.systemShippingHold);
  const eventType = holdOn ? "hold_released" : "hold_created";
  const sourceInvoices = sourceInvoicesForShipment(invoice);
  for (const sourceInvoice of sourceInvoices) {
    const ok = await saveShippingHoldCurrentThenEvent(
      sourceInvoice,
      holdOn ? "OFF" : "ON",
      holdOn ? "inspection_hold_off" : "inspection_hold_on",
      eventType,
      { memo: holdOn ? "shipping hold released" : "shipping hold on" }
    );
    if (!ok) return;
  }
  let excludedCount = 0;
  for (const sourceInvoice of sourceInvoices) {
    const openShortageCount = (sourceInvoice.items || []).filter((item) => itemHasOpenWorkflowShortage(sourceInvoice, item)).length;
    const csAction = inspectionHoldCsAction({ holdWasOn: holdOn, openShortageCount });
    if (csAction === "exclude") {
      try {
        excludedCount += await excludeAutomaticCsAfterInspectionHoldRelease(sourceInvoice);
      } catch (error) {
        console.warn("automatic CS exclusion after inspection hold release failed", error);
        toast("배송보류는 해제됐지만 자동 CS 제외 저장에 실패했습니다. CS 탭에서 다시 확인해주세요.");
      }
    } else if (csAction === "reopen") {
      try {
        await reopenAutomaticCsAfterInspectionHoldCreated(sourceInvoice);
      } catch (error) {
        console.warn("automatic CS reopen after inspection hold creation failed", error);
        toast("배송보류 ON 처리됐지만 자동 CS 복구 저장에 실패했습니다. CS 탭에서 다시 확인해주세요.");
      }
    }
  }
  state.selectedInspectionGroup = invoice.orderGroupNo;
  renderWorkflowSurfaces();
  toast(holdOn ? "보류 해제되었습니다." : "배송보류 ON 처리되었습니다.");
}

async function toggleCsShippingHold(orderGroupNo) {
  const sourceInvoice = allWorkflowInvoices().find((candidate) => String(candidate?.orderGroupNo || "") === String(orderGroupNo || "")) || null;
  const invoice = selectedCsWorkflowInvoice(orderGroupNo) || shipmentScopeForInvoice(sourceInvoice);
  if (!invoice) {
    toast("CS 주문의 배송보류 대상을 찾지 못했습니다.");
    return;
  }
  const holdOn = Boolean(workflowInvoiceState(invoice)?.systemShippingHold);
  const sourceInvoices = sourceInvoicesForShipment(invoice);
  for (const memberInvoice of sourceInvoices) {
    const event = await saveShippingHoldCurrentThenEvent(
      memberInvoice,
      holdOn ? "OFF" : "ON",
      holdOn ? "cs_hold_off" : "cs_hold_on",
      holdOn ? "hold_released" : "hold_created",
      { memo: holdOn ? "shipping hold released from cs" : "shipping hold on from cs", source: "f_v1_cs" },
    );
    if (!event) return;
  }
  renderWorkflowSurfaces();
  const scopeLabel = sourceInvoices.length > 1 ? `합배송 ${sourceInvoices.length}주문 전체` : "주문";
  toast(holdOn ? `${scopeLabel} 배송보류를 해제했습니다.` : `${scopeLabel} 배송보류를 처리했습니다.`);
}

function cancellationWarning(invoice, scopeLabel) {
  const hasOutboundConfirmed = (invoice?.items || []).some((item) =>
    Boolean(String(item?.raw?.sellpia_outbound_confirmed_date || item?.sellpiaOutboundConfirmedDate || "").trim()),
  );
  return hasOutboundConfirmed
    ? `\n\n주의: 출고확정일이 입력된 상품이 있습니다. ${scopeLabel}를 계속할까요?`
    : "";
}

async function toggleCsOrderCancellation(orderGroupNo, reopen = false) {
  if (!allowWorkflowEvents) {
    toast("취소 저장이 비활성화되어 있습니다. URL에 write=1&events=1을 붙여야 합니다.");
    return;
  }
  const invoice = allWorkflowInvoices().find(
    (candidate) => String(candidate?.orderGroupNo || "") === String(orderGroupNo || ""),
  );
  if (!invoice) throw new Error("취소할 주문을 찾지 못했습니다.");

  const receiver = invoice.displayName || invoice.csDisplayName || invoice.invoiceNo || orderGroupNo;
  const message = reopen
    ? `${receiver} 주문의 취소를 해제하고 작업 대상으로 되돌릴까요?`
    : `${receiver} 주문 전체를 취소 처리할까요?\n피킹·검품·CS 진행 대상에서 제외됩니다.${cancellationWarning(invoice, "주문 전체 취소")}`;
  if (!window.confirm(message)) return;

  const saved = await saveWorkflowInvoiceEvent(invoice, reopen ? "cancel_reopened" : "cancelled", {
    memo: reopen ? "order cancellation reopened from cs" : "order cancelled from cs",
    source: "f_v1_cs",
  });
  if (!saved) return;
  render();
  toast(reopen ? "주문 취소를 해제했습니다." : "주문 전체를 취소 처리했습니다.");
}

async function toggleCsItemCancellation(row, reopen = false) {
  if (!allowWorkflowEvents) {
    toast("취소 저장이 비활성화되어 있습니다. URL에 write=1&events=1을 붙여야 합니다.");
    return;
  }
  const { invoice, item } = findCsWorkflowItem(row);
  if (!invoice || !item) throw new Error("취소할 상품행을 찾지 못했습니다.");
  if (invoiceIsCancelled(invoice)) {
    toast("주문 전체가 취소되어 있습니다. 먼저 주문 취소를 해제해 주세요.");
    return;
  }

  const productLabel = [item.ownCode, item.productName, item.optionName].filter(Boolean).join(" · ");
  if (!reopen && activeWorkflowItems(invoice).length <= 1) {
    const message = `마지막 남은 상품입니다.\n${productLabel || "이 상품"}을 취소하면 주문 전체 취소로 처리됩니다. 계속할까요?${cancellationWarning(invoice, "주문 전체 취소")}`;
    if (!window.confirm(message)) return;
    const saved = await saveWorkflowInvoiceEvent(invoice, "cancelled", {
      memo: "last active item cancelled; order cancelled from cs",
      source: "f_v1_cs",
    });
    if (!saved) return;
    render();
    toast("마지막 상품이어서 주문 전체를 취소 처리했습니다.");
    return;
  }

  const message = reopen
    ? `${productLabel || "이 상품"}의 취소를 해제하고 작업 대상으로 되돌릴까요?`
    : `${productLabel || "이 상품"}만 취소 처리할까요?\n다른 상품은 기존 작업을 계속합니다.${cancellationWarning(invoice, "상품 취소")}`;
  if (!window.confirm(message)) return;
  const saved = await saveWorkflowItemEvent(invoice, item, reopen ? "cancel_reopened" : "cancelled", {
    memo: reopen ? "item cancellation reopened from cs" : "item cancelled from cs",
    source: "f_v1_cs",
  });
  if (!saved) return;
  render();
  toast(reopen ? "상품 취소를 해제했습니다." : "상품을 취소 처리했습니다.");
}

async function onOrderListClick(event) {
  const target = event.target.closest("[data-action]");
  if (!target) return;

  const action = target.dataset.action;
  const orderGroupNo = target.dataset.orderGroup;
  const sellpiaItemNo = target.dataset.itemNo;
  const { invoice, item } = findInvoiceAndItem(orderGroupNo, sellpiaItemNo);
  if (!invoice || !item) return;
  if (itemIsEffectivelyCancelled(invoice, item)) {
    toast("취소된 상품은 CS 탭에서 취소 해제 후 수정할 수 있습니다.");
    return;
  }

  if (action === "custom-order-toggle") {
    if (!allowWrites) {
      toast("읽기전용입니다. 주문제작 변경은 write=1에서만 저장됩니다.");
      renderPickingSurfaces();
      return;
    }
    const checked = Boolean(target.checked);
    const existing = operationForPickingItem(item);
    if (!checked && existing && !canClearCustomRequired(existing)) {
      toast("진행 기록이 있어 여기서 해제할 수 없습니다. 주문제작 탭에서 취소 처리해주세요.");
      renderPickingSurfaces();
      return;
    }
    const saved = await orderItemOperations.upsertOperationForCurrentOrderItem(item, {
      custom_required_at: checked ? new Date().toISOString() : null,
    });
    mergeOperationState(saved);
    renderPickingSurfaces();
    toast(checked ? "주문제작 필요로 등록했습니다." : "주문제작 체크를 해제했습니다.");
    return;
  }

  if (action === "custom-order-memo-save") {
    if (!allowWrites) {
      toast("읽기전용입니다. 내부 메모는 write=1에서만 저장됩니다.");
      return;
    }
    const card = target.closest(".picking-item-card, .gold-item-row");
    const input = card?.querySelector("[data-action='custom-order-memo-input']");
    const memo = String(input?.value || "").trim();
    const existing = operationForPickingItem(item);
    if (!existing && !memo) {
      toast("저장할 내부 메모가 없습니다.");
      return;
    }
    const saved = await orderItemOperations.upsertOperationForCurrentOrderItem(item, { internal_memo: memo || null });
    mergeOperationState(saved);
    renderPickingSurfaces();
    toast("내부 메모를 저장했습니다.");
    return;
  }

  if (action === "custom-order-memo-input") return;

  if (action === "toggle") {
    patchLocalPickingState(invoice, item, { isPicked: !isPicked(item) });
    paintPickingItemState(invoice, item);
    schedulePickingSurfaces();
    try {
      await savePickingRow(invoice, item, isPicked(item) ? "picked" : "pick_unchecked");
      toast("피킹 상태 저장");
    } catch (error) {
      patchLocalPickingState(invoice, item, { isPicked: !isPicked(item) });
      renderPickingSurfaces();
      toast(`저장 실패: ${error.message}`);
    }
  }

  if (action === "shortage") {
    const delta = Number(target.dataset.delta || 0);
    const prev = shortageQty(item);
    const next = Math.max(0, prev + delta);
    await setShortageQty(orderGroupNo, sellpiaItemNo, next);
  }
}

function onDrawerChange(event) {
  const input = event.target.closest("[data-action='drawer'], [data-inspection-drawer], [data-cs-drawer]");
  if (!input) return;
  const invoice = findInvoiceAndItem(input.dataset.orderGroup, "")?.invoice
    || selectedInspectionInvoice(input.dataset.orderGroup)
    || selectedCsWorkflowInvoice(input.dataset.orderGroup)
    || (state.viewModel?.invoices || []).find((row) => row.orderGroupNo === input.dataset.orderGroup);
  if (!invoice) return;
  const value = input.value.trim();
  saveDrawerForInvoice(invoice, value)
    .then(() => {
      invoice.sellpiaMemo1 = value;
      if (input.matches("[data-inspection-drawer]")) renderInspectionPanels();
      else if (input.matches("[data-cs-drawer]")) renderCsPanels();
      else render();
      toast("서랍번호 저장");
    })
    .catch((error) => toast(`서랍번호 저장 실패: ${error.message}`));
}

function drawerDigitsOnly(value) {
  return String(value || "").replace(/\D/g, "").slice(0, 8);
}

function drawerPrefixForSeller(seller) {
  const text = String(seller || "").trim().toLowerCase();
  if (text.includes("ably") || text.includes("a-bly") || text.includes("에이블리")) return "ㅁㅇ";
  if (text.includes("coupang") || text.includes("쿠팡")) return "ㅁㅋ";
  if (text.includes("zigzag") || text.includes("zig") || text.includes("지그재그")) return "ㅁㅈ";
  if (text.includes("smart") || text.includes("naver") || text.includes("스마트") || text.includes("네이버")) return "ㅁㅅ";
  return "ㅁㅁ";
}

function splitDrawerMemo(value) {
  const lines = String(value || "").replace(/\r\n/g, "\n").split("\n");
  const first = (lines.shift() || "").trim();
  const rest = lines.join("\n").trim();
  if (/^(ㅁ[ㅁㅅㅇㅋㅈ])?\s*\d+\s*$/.test(first)) {
    return { digits: drawerDigitsOnly(first), note: rest };
  }
  return { digits: drawerDigitsOnly(first), note: [first, rest].filter(Boolean).join("\n") };
}

function composeDrawerMemo(invoice, digits, note = "") {
  const drawerNo = drawerDigitsOnly(digits);
  const cleanNote = String(note || "").trim();
  if (!drawerNo) return cleanNote;
  const firstLine = `${drawerPrefixForSeller(invoice?.seller)}${drawerNo}`;
  return cleanNote ? `${firstLine}\n${cleanNote}` : firstLine;
}

function ensureDrawerKeypad() {
  let overlay = document.getElementById("drawer-keypad-overlay");
  if (overlay) return overlay;
  overlay = document.createElement("div");
  overlay.id = "drawer-keypad-overlay";
  overlay.className = "drawer-keypad-overlay";
  overlay.hidden = true;
  overlay.innerHTML = `<div class="drawer-keypad" role="dialog" aria-modal="true" aria-label="서랍번호 입력">
    <div class="drawer-keypad-display">
      <strong id="drawer-keypad-value">-</strong>
      <span>서랍번호</span>
    </div>
    <div class="drawer-keypad-grid">
      ${["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((digit) => `<button type="button" data-keypad-digit="${digit}">${digit}</button>`).join("")}
      <button type="button" data-keypad-action="clear">지움</button>
      <button type="button" data-keypad-digit="0">0</button>
      <button type="button" data-keypad-action="delete">⌫</button>
    </div>
    <div class="drawer-keypad-actions">
      <button type="button" data-keypad-action="close">닫기</button>
      <button type="button" data-keypad-action="native">직접 입력</button>
      <button type="button" class="primary" data-keypad-action="done">확인</button>
    </div>
  </div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener("click", (event) => onDrawerKeypadClick(event).catch(showError));
  return overlay;
}

function renderDrawerKeypad() {
  const display = document.getElementById("drawer-keypad-value");
  if (display) display.textContent = state.drawerKeypad.value || "-";
}

function openDrawerKeypad(input) {
  if (!input) return;
  if (state.drawerKeypad.input === input && !document.getElementById("drawer-keypad-overlay")?.hidden) return;
  state.drawerKeypad.input = input;
  state.drawerKeypad.orderGroupNo = input.dataset.orderGroup || "";
  const parsed = splitDrawerMemo(input.value);
  state.drawerKeypad.value = parsed.digits;
  state.drawerKeypad.note = parsed.note;
  const overlay = ensureDrawerKeypad();
  overlay.hidden = false;
  renderDrawerKeypad();
}

function closeDrawerKeypad() {
  const overlay = document.getElementById("drawer-keypad-overlay");
  if (overlay) overlay.hidden = true;
  state.drawerKeypad.orderGroupNo = "";
  state.drawerKeypad.value = "";
  state.drawerKeypad.note = "";
  state.drawerKeypad.input = null;
}

async function commitDrawerKeypad() {
  if (!allowWrites) {
    toast("읽기전용입니다. URL에 write=1을 붙여야 서랍번호를 저장할 수 있습니다.");
    closeDrawerKeypad();
    return;
  }
  const invoice = (state.viewModel?.invoices || []).find((row) => row.orderGroupNo === state.drawerKeypad.orderGroupNo);
  if (!invoice) {
    toast("서랍번호 저장 대상을 찾지 못했습니다.");
    closeDrawerKeypad();
    return;
  }
  const value = composeDrawerMemo(invoice, state.drawerKeypad.value, state.drawerKeypad.note);
  await saveDrawerForInvoice(invoice, value);
  invoice.sellpiaMemo1 = value;
  closeDrawerKeypad();
  render();
  toast("서랍번호 저장");
}

function restoreDrawerNativeInput(input) {
  if (!input) return;
  input.readOnly = true;
  input.setAttribute("readonly", "");
  input.setAttribute("inputmode", "none");
  delete input.dataset.drawerNativeInput;
  delete input.dataset.drawerNativeOriginalValue;
}

function focusDrawerNativeInput(input) {
  try {
    input.focus({ preventScroll: true });
  } catch {
    input.focus();
  }
  const end = input.value.length;
  if (typeof input.setSelectionRange === "function") input.setSelectionRange(end, end);
}

function startDrawerNativeInput() {
  const input = state.drawerKeypad.input;
  if (!input) return;
  const invoice = (state.viewModel?.invoices || []).find((row) => row.orderGroupNo === state.drawerKeypad.orderGroupNo);
  if (invoice) input.value = composeDrawerMemo(invoice, state.drawerKeypad.value, state.drawerKeypad.note);
  input.dataset.drawerNativeOriginalValue = input.value;
  input.dataset.drawerNativeInput = "1";
  closeDrawerKeypad();
  input.readOnly = false;
  input.removeAttribute("readonly");
  input.setAttribute("inputmode", "text");

  const onKeydown = (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      input.blur();
    }
    if (event.key === "Escape") {
      event.preventDefault();
      input.value = input.dataset.drawerNativeOriginalValue || "";
      restoreDrawerNativeInput(input);
      input.blur();
    }
  };
  input.addEventListener("keydown", onKeydown);
  input.addEventListener(
    "blur",
    () => {
      input.removeEventListener("keydown", onKeydown);
      setTimeout(() => restoreDrawerNativeInput(input), 0);
    },
    { once: true },
  );
  focusDrawerNativeInput(input);
}

async function onDrawerKeypadClick(event) {
  if (event.target.id === "drawer-keypad-overlay") {
    closeDrawerKeypad();
    return;
  }
  const digit = event.target.closest("[data-keypad-digit]")?.dataset.keypadDigit;
  if (digit !== undefined) {
    state.drawerKeypad.value = drawerDigitsOnly(`${state.drawerKeypad.value}${digit}`);
    renderDrawerKeypad();
    return;
  }
  const action = event.target.closest("[data-keypad-action]")?.dataset.keypadAction;
  if (action === "clear") state.drawerKeypad.value = "";
  if (action === "delete") state.drawerKeypad.value = state.drawerKeypad.value.slice(0, -1);
  if (action === "close") closeDrawerKeypad();
  if (action === "native") {
    startDrawerNativeInput();
    return;
  }
  if (action === "done") await commitDrawerKeypad();
  renderDrawerKeypad();
}

function onDrawerKeypadOpen(event) {
  const input = event.target.closest(".drawer-input[data-action='drawer']");
  if (!input) return;
  if (input.closest(".is-cancelled")) {
    toast("취소된 주문/상품은 CS 탭에서 취소 해제 후 수정할 수 있습니다.");
    return;
  }
  if (input.dataset.drawerNativeInput === "1") return;
  event.preventDefault();
  input.blur();
  openDrawerKeypad(input);
}

async function bulkToggleGroup(groupIndex) {
  if (!allowWrites) {
    toast("읽기전용입니다. URL에 write=1을 붙여야 조 일괄 체크를 저장할 수 있습니다.");
    return;
  }

  const group = state.groups[groupIndex] || [];
  const targets = groupBulkTargets(group);
  if (!targets.length) {
    toast("일괄 체크할 상품이 없습니다.");
    return;
  }

  const nextPicked = !targets.every(({ item }) => isPicked(item));
  const changed = targets.filter(({ item }) => isPicked(item) !== nextPicked);
  if (!changed.length) {
    toast("변경할 상품이 없습니다.");
    return;
  }

  changed.forEach(({ invoice, item }) => patchLocalPickingState(invoice, item, { isPicked: nextPicked }));
  renderPickingSurfaces();

  try {
    for (const { invoice, item } of changed) {
      await savePickingRow(invoice, item, nextPicked ? "picked" : "pick_unchecked");
    }
    toast(`${state.groupInfos[groupIndex]?.label || `${groupIndex + 1}조`} ${nextPicked ? "일괄 체크" : "일괄 체크 취소"} 완료: ${changed.length}건`);
  } catch (error) {
    toast(`조 일괄 체크 저장 실패: ${error.message}`);
    await loadPickingData();
  }
}

async function loadPickingData() {
  els.orderList.innerHTML = '<div class="empty">데이터를 불러오는 중입니다.</div>';
  const selectedDate = state.selectedDate;
  const session = state.session;
  try {
    await loadSharedReceivingLabel();
  } catch (error) {
    state.receivingLabel.syncError = error?.message || "공유 라벨 불러오기 실패";
    console.warn("shared receiving label load failed", error);
  }

  const buildOrderQuery = (query) => {
    let next = query.order("sort_order", { ascending: true, nullsFirst: false });
    if (session !== "ALL") next = next.eq("am_pm", session);
    return next;
  };

  const receiptDateOrders = await fetchAllRows(() => buildOrderQuery(db.from("orders").select("*").eq("receipt_date", selectedDate)));
  const ordersByNo = new Map();
  receiptDateOrders.forEach((row) => {
    const key = String(row.ord_no || "").trim();
    if (key) ordersByNo.set(key, row);
  });
  const orders = [...ordersByNo.values()].sort((a, b) => {
    const left = Number(a.sort_order ?? Number.MAX_SAFE_INTEGER);
    const right = Number(b.sort_order ?? Number.MAX_SAFE_INTEGER);
    if (left !== right) return left - right;
    return String(a.ord_no || "").localeCompare(String(b.ord_no || ""));
  });

  const orderNos = orders.map((row) => String(row.ord_no || "").trim()).filter(Boolean);
  const items = orderNos.length
    ? await fetchAllRows(() => db.from("order_items").select("*").in("ord_no", orderNos).order("sort_order", { ascending: true, nullsFirst: false }))
    : [];
  const pickingRows = orderNos.length ? await fetchAllRows(() => db.from("picking").select("*").in("ord_no", orderNos)) : [];
  const shortageRows = orderNos.length ? await fetchAllRows(() => db.from("shortage").select("*").in("ord_no", orderNos)) : [];
  const inspectionRows = orderNos.length ? await loadInspectionMemoRows(orderNos) : [];
  const itemsWithInspectionMemos = applyInspectionMemos(items, inspectionRows);

  state.viewModel = buildPickingViewModel({
    orders,
    orderItems: itemsWithInspectionMemos,
    pickingRows,
    shortageRows,
  });
  rebuildGroups();
  render();
  loadPickingOperationData(orderNos).catch((error) => {
    console.warn("picking operation status load skipped", error);
  });
  await loadWorkflowData();
  await loadCsCaseData();
}

async function loadInspectionMemoRows(orderNos) {
  try {
    return await fetchAllRows(() => db.from("inspection").select("inv_no,ord_no,item_no,p_code,insp_memo,memo_updated_at").in("ord_no", orderNos));
  } catch (error) {
    console.warn("inspection memo load skipped", error);
    return [];
  }
}

function applyInspectionMemos(items, memoRows) {
  if (!memoRows?.length) return items;
  const memoByKey = new Map();
  for (const row of memoRows) {
    const memo = String(row.insp_memo || "").trim();
    if (!memo) continue;
    const code = String(row.p_code || "").trim();
    const ord = String(row.ord_no || "").trim();
    const inv = String(row.inv_no || "").trim();
    if (ord && code) memoByKey.set(`${ord}::${code}`, memo);
    if (inv && code) memoByKey.set(`${inv}::${code}`, memo);
  }
  return items.map((item) => {
    const code = String(item.p_code || item.sellpia_p_code || item.sellpia_product_code || item.prod_code || item.p_dpcode || "").trim();
    const ord = String(item.ord_no || item.order_group_no || "").trim();
    const inv = String(item.inv_no || item.dnum || "").trim();
    const memo = memoByKey.get(`${ord}::${code}`) || memoByKey.get(`${inv}::${code}`) || "";
    return memo ? { ...item, insp_memo: memo } : item;
  });
}

async function loadWorkflowData() {
  state.workflowQueueError = "";
  try {
    state.workflowQueues = await loadWorkflowQueues(db);
    state.workflowEventsChecked = true;
    state.workflowEventsReady = true;
  } catch (error) {
    state.workflowQueues = null;
    state.workflowEventsChecked = true;
    state.workflowEventsReady = false;
    state.workflowQueueError = `workflow event 읽기 실패: ${error.message || error}`;
    console.warn("workflow queue load failed", error);
  }
  render();
}

function setActiveTab(tab) {
  const requestedTab = tab === "gold" ? "picking" : tab;
  const allowedTabs = new Set(["dashboard", "picking", "shortage", "inspection", "cs", "custom-orders", "completed"]);
  state.activeTab = allowedTabs.has(requestedTab) ? requestedTab : "picking";
  if (tab === "gold") {
    state.filterMode = "gold";
    state.searchText = "";
    if (els.searchInput) els.searchInput.value = "";
  }
  renderShell();
  renderActivePanelSoon(0, { metrics: false });
  if (state.activeTab === "cs" && !state.csCasesLoaded && !state.csCasesLoading) {
    loadCsCaseData().catch(showError);
  }
  if (state.activeTab === "custom-orders" && !state.customOrders.loaded && !state.customOrders.loading) {
    loadCustomOrdersData().catch(showCustomOrdersError);
  }
}

function scrollToTrayItem(key) {
  state.currentTrayKey = key;
  const selectorKey = window.CSS?.escape ? CSS.escape(key) : key.replace(/"/g, '\\"');
  let target = els.orderList.querySelector(`[data-slot-key="${selectorKey}"]`);
  if (target) {
    selectPickingCard(key);
  } else {
    renderOrderList();
    renderTray();
    target = els.orderList.querySelector(`[data-slot-key="${selectorKey}"]`);
  }
  if (target) {
    target.scrollIntoView({ block: "center", behavior: "smooth" });
  }
}

function scrollTrayToSelectedItem(key) {
  const selectorKey = window.CSS?.escape ? CSS.escape(key) : key.replace(/"/g, '\\"');
  const target = els.trayBoard?.querySelector(`[data-tray-key="${selectorKey}"]`);
  if (!target || !els.trayBoard) return;
  const nextLeft = target.offsetLeft - Math.max(0, (els.trayBoard.clientWidth - target.clientWidth) / 2);
  els.trayBoard.scrollTo({ left: Math.max(0, nextLeft), behavior: "smooth" });
  if (els.bottomTray) els.bottomTray.scrollTop = 0;
}

function selectPickingCard(key) {
  state.currentTrayKey = key;
  els.orderList.querySelectorAll(".is-selected[data-slot-key]").forEach((card) => card.classList.remove("is-selected"));
  els.trayBoard?.querySelectorAll(".selected[data-tray-key]").forEach((card) => card.classList.remove("selected"));
  const selectorKey = window.CSS?.escape ? CSS.escape(key) : key.replace(/"/g, '\\"');
  els.orderList.querySelector(`[data-slot-key="${selectorKey}"]`)?.classList.add("is-selected");
  els.trayBoard?.querySelector(`[data-tray-key="${selectorKey}"]`)?.classList.add("selected");
  scrollTrayToSelectedItem(key);
}

function sortedAllInvoices() {
  return sortInvoices(state.viewModel?.invoices || []);
}

function selectFirstItemOfInvoice(invoice, shouldRender = true) {
  const item = invoice?.items?.[0];
  if (!invoice || !item) return false;
  const key = itemSlotKey(invoice, item);
  state.currentTrayKey = key;
  if (shouldRender) {
    if (state.activeTab === "picking") renderPickingSurfaces();
    else render();
  } else {
    selectPickingCard(key);
  }
  const selectorKey = window.CSS?.escape ? CSS.escape(key) : key.replace(/"/g, '\\"');
  const target = els.orderList.querySelector(`[data-slot-key="${selectorKey}"]`);
  if (target) target.scrollIntoView({ block: "center", behavior: "smooth" });
  scrollTrayToSelectedItem(key);
  return true;
}

function resetSearchAndFilterForJump() {
  state.searchText = "";
  state.filterMode = "all";
  if (els.searchInput) els.searchInput.value = "";
}

function setCurrentGroupByInvoice(invoice) {
  const groupIndex = state.groups.findIndex((group) => group.some((row) => row.orderGroupNo === invoice?.orderGroupNo));
  state.currentGroup = groupIndex >= 0 ? groupIndex : 0;
}

function jumpToGroup(value) {
  const groupNo = Number(onlyDigits(value));
  if (!groupNo || groupNo < 1 || groupNo > state.groups.length) {
    toast("해당 조가 없습니다.");
    return;
  }
  resetSearchAndFilterForJump();
  state.currentGroup = groupNo - 1;
  const invoice = state.groups[state.currentGroup]?.[0];
  selectFirstItemOfInvoice(invoice);
}

function canSwipePickingGroup() {
  return state.activeTab === "picking" && state.filterMode === "all" && !state.searchText.trim() && state.groups.length > 1;
}

function movePickingGroup(delta) {
  if (!canSwipePickingGroup()) return false;
  const nextGroup = Math.max(0, Math.min(state.groups.length - 1, state.currentGroup + delta));
  if (nextGroup === state.currentGroup) return false;
  state.currentGroup = nextGroup;
  renderGroups();
  renderOrderList();
  renderTray();
  return true;
}

function bindPickingGroupSwipe() {
  if (!els.orderList) return;
  let startX = 0;
  let startY = 0;
  let startTime = 0;

  els.orderList.addEventListener(
    "touchstart",
    (event) => {
      const touch = event.touches?.[0];
      if (!touch) return;
      startX = touch.clientX;
      startY = touch.clientY;
      startTime = Date.now();
    },
    { passive: true },
  );

  els.orderList.addEventListener(
    "touchend",
    (event) => {
      const touch = event.changedTouches?.[0];
      if (!touch || !startTime) return;
      const dx = touch.clientX - startX;
      const dy = touch.clientY - startY;
      const elapsed = Date.now() - startTime;
      startTime = 0;
      if (elapsed > 800 || Math.abs(dx) < 56 || Math.abs(dx) < Math.abs(dy) * 1.4) return;
      movePickingGroup(dx < 0 ? 1 : -1);
    },
    { passive: true },
  );
}

function jumpToSequence(value) {
  const seq = Number(onlyDigits(value));
  const invoices = sortedAllInvoices();
  const invoice = invoices[seq - 1];
  if (!seq || !invoice) {
    toast("해당 순서가 없습니다.");
    return;
  }
  resetSearchAndFilterForJump();
  setCurrentGroupByInvoice(invoice);
  selectFirstItemOfInvoice(invoice);
}

function findInvoiceByInvoiceNo(value) {
  const digits = onlyDigits(value);
  if (!digits) return null;
  return sortedAllInvoices().find((invoice) => {
    const invoiceDigits = onlyDigits(invoice.invoiceNo);
    return invoiceDigits === digits || invoiceDigits.endsWith(digits) || digits.endsWith(invoiceDigits);
  });
}

function jumpToInvoiceNo(value) {
  const invoice = findInvoiceByInvoiceNo(value);
  if (!invoice) {
    toast("송장번호를 찾지 못했습니다.");
    return false;
  }
  const invoices = sortedAllInvoices();
  const index = invoices.findIndex((row) => row.orderGroupNo === invoice.orderGroupNo);
  resetSearchAndFilterForJump();
  if (index >= 0) setCurrentGroupByInvoice(invoice);
  selectFirstItemOfInvoice(invoice);
  return true;
}

function currentVisibleRowKeys() {
  return currentPickingRows().map(({ invoice, item }) => itemSlotKey(invoice, item));
}

function moveSelection(delta) {
  const keys = currentVisibleRowKeys();
  if (!keys.length) return;
  const currentIndex = Math.max(0, keys.indexOf(state.currentTrayKey));
  const nextIndex = state.currentTrayKey ? Math.min(keys.length - 1, Math.max(0, currentIndex + delta)) : 0;
  scrollToTrayItem(keys[nextIndex]);
}

async function toggleSelectedItem() {
  if (!state.currentTrayKey) {
    const firstKey = currentVisibleRowKeys()[0];
    if (firstKey) scrollToTrayItem(firstKey);
    return;
  }
  const [orderGroupNo, sellpiaItemNo] = state.currentTrayKey.split("::");
  const { invoice, item } = findInvoiceAndItem(orderGroupNo, sellpiaItemNo);
  if (!invoice || !item) return;
  if (itemIsEffectivelyCancelled(invoice, item)) {
    toast("취소된 상품은 CS 탭에서 취소 해제 후 수정할 수 있습니다.");
    return;
  }
  patchLocalPickingState(invoice, item, { isPicked: !isPicked(item) });
  paintPickingItemState(invoice, item);
  schedulePickingSurfaces();
  try {
    await savePickingRow(invoice, item, isPicked(item) ? "picked" : "pick_unchecked");
    toast("피킹 상태 저장");
  } catch (error) {
    patchLocalPickingState(invoice, item, { isPicked: !isPicked(item) });
    renderPickingSurfaces();
    toast(`저장 실패: ${error.message}`);
  }
}

function currentWorkflowRows() {
  if (state.activeTab === "shortage") return shortageRowsForCurrentFilter();
  if (state.activeTab === "inspection") {
    return inspectionSourceInvoices().filter(invoiceMatchesInspectionFilter).filter(invoiceMatchesInspectionSearch);
  }
  if (state.activeTab === "cs") return filteredCsRows();
  if (state.activeTab === "completed") return completedInvoicesForSelectedDate();
  return [];
}

function moveWorkflowSelection(delta) {
  const rows = currentWorkflowRows();
  if (!rows.length) return;
  if (state.activeTab === "shortage") {
    const keys = rows.map(({ invoice, item }) => workflowItemKey(invoice, item));
    const current = keys.indexOf(state.selectedShortageKey);
    state.selectedShortageKey = keys[Math.max(0, Math.min(keys.length - 1, (current >= 0 ? current : 0) + delta))];
    renderShortagePanels();
    return;
  }
  if (state.activeTab === "inspection") {
    const keys = rows.map((invoice) => invoice.orderGroupNo);
    const current = keys.indexOf(state.selectedInspectionGroup);
    state.selectedInspectionGroup = keys[Math.max(0, Math.min(keys.length - 1, (current >= 0 ? current : 0) + delta))];
    state.selectedInspectionItemKey = "";
    renderInspectionPanels({ list: false });
    return;
  }
  if (state.activeTab === "cs") {
    const keys = rows.map((row) => row.key);
    const current = keys.indexOf(state.selectedCsKey);
    state.selectedCsKey = keys[Math.max(0, Math.min(keys.length - 1, (current >= 0 ? current : 0) + delta))];
    renderCsPanels();
    return;
  }
  if (state.activeTab === "completed") {
    const keys = rows.map((invoice) => invoice.orderGroupNo);
    const current = keys.indexOf(state.selectedCompletedGroup);
    state.selectedCompletedGroup = keys[Math.max(0, Math.min(keys.length - 1, (current >= 0 ? current : 0) + delta))];
    renderCompletedPanels();
  }
}

function focusActiveSearch() {
  const target = state.activeTab === "inspection" ? els.inspectionSearchInput : state.activeTab === "cs" ? els.csSearchInput : els.searchInput;
  target?.focus();
  target?.select();
}

function activateTabShortcut(key) {
  const tabs = {
    "1": "dashboard",
    "2": "picking",
    "3": "shortage",
    "4": "inspection",
    "5": "cs",
    "6": "completed",
  };
  if (!tabs[key]) return false;
  setActiveTab(tabs[key]);
  return true;
}

function isTypingTarget(target) {
  return Boolean(target?.closest?.("input, textarea, select, [contenteditable='true']"));
}

function onGlobalKeydown(event) {
  if (!isTypingTarget(event.target) && activateTabShortcut(event.key)) {
    event.preventDefault();
    return;
  }
  if (event.key.toLowerCase() === "q" && !isTypingTarget(event.target)) {
    event.preventDefault();
    focusActiveSearch();
    return;
  }
  if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && state.activeTab === "inspection" && !isTypingTarget(event.target)) {
    event.preventDefault();
    moveInspectionItemSelection(event.key === "ArrowLeft" ? -1 : 1);
    return;
  }
  if ((event.key === "Tab" || event.key === "ArrowDown" || event.key === "ArrowUp") && !isTypingTarget(event.target)) {
    event.preventDefault();
    const delta = event.key === "ArrowUp" || (event.key === "Tab" && event.shiftKey) ? -1 : 1;
    if (["shortage", "inspection", "cs", "completed"].includes(state.activeTab)) moveWorkflowSelection(delta);
    else moveSelection(delta);
    return;
  }
  if (event.code === "Space" && !isTypingTarget(event.target) && !event.repeat) {
    event.preventDefault();
    if (state.activeTab === "shortage") completeSelectedShortagePicking().catch(showError);
    else if (state.activeTab === "inspection") toggleSelectedInspectionHold().catch(showError);
    else toggleSelectedItem().catch(showError);
  }
}

function bindEvents() {
  document.querySelectorAll("[data-app-tab]").forEach((button) => {
    button.addEventListener("click", () => setActiveTab(button.dataset.appTab));
  });
  document.querySelectorAll("[data-custom-orders-view]").forEach((button) => {
    button.addEventListener("click", () => {
      state.customOrders.view = button.dataset.customOrdersView || "workflow";
      renderCustomOrdersPanel();
    });
  });
  els.customOrdersRefresh?.addEventListener("click", () => loadCustomOrdersData({ force: true }).catch(showCustomOrdersError));
  els.customOrdersStatus?.addEventListener("change", () => {
    state.customOrders.status = els.customOrdersStatus.value || "active";
    renderCustomOrdersPanel();
  });
  els.customOrdersSupplier?.addEventListener("change", () => {
    state.customOrders.supplier = els.customOrdersSupplier.value || "";
    renderCustomOrdersPanel();
  });
  els.customOrdersDateCriterion?.addEventListener("change", () => {
    state.customOrders.dateCriterion = els.customOrdersDateCriterion.value || "required";
    renderCustomOrdersPanel();
  });
  els.customOrdersDateFrom?.addEventListener("change", () => {
    state.customOrders.dateFrom = els.customOrdersDateFrom.value || "";
    renderCustomOrdersPanel();
  });
  els.customOrdersDateTo?.addEventListener("change", () => {
    state.customOrders.dateTo = els.customOrdersDateTo.value || "";
    renderCustomOrdersPanel();
  });
  els.customOrdersSearch?.addEventListener("input", () => {
    state.customOrders.search = els.customOrdersSearch.value || "";
    renderCustomOrdersPanel();
  });
  els.customOrdersInboundSource?.addEventListener("change", () => {
    state.customOrders.inboundSource = els.customOrdersInboundSource.value || "all";
    renderCustomOrdersPanel();
  });
  els.customOrdersInboundSupplier?.addEventListener("change", () => {
    state.customOrders.inboundSupplier = els.customOrdersInboundSupplier.value || "";
    renderCustomOrdersPanel();
  });
  els.customOrdersInboundDateFrom?.addEventListener("change", () => {
    state.customOrders.inboundDateFrom = els.customOrdersInboundDateFrom.value || "";
    renderCustomOrdersPanel();
  });
  els.customOrdersInboundDateTo?.addEventListener("change", () => {
    state.customOrders.inboundDateTo = els.customOrdersInboundDateTo.value || "";
    renderCustomOrdersPanel();
  });
  els.customOrdersInboundSort?.addEventListener("change", () => {
    state.customOrders.inboundSort = els.customOrdersInboundSort.value === "desc" ? "desc" : "asc";
    renderCustomOrdersPanel();
  });
  els.customOrdersInboundSearch?.addEventListener("input", () => {
    state.customOrders.inboundSearch = els.customOrdersInboundSearch.value || "";
    renderCustomOrdersPanel();
  });
  els.customOrdersSkuSave?.addEventListener("click", () => saveDirectSkuInboundSchedule().catch((error) => {
    console.error(error);
    state.customOrders.skuScheduleImportStatus = `저장 실패: ${error?.message || error}`;
    renderSkuInboundScheduleManager();
    toast(state.customOrders.skuScheduleImportStatus);
  }));
  els.customOrdersSkuUpload?.addEventListener("click", () => els.customOrdersSkuFile?.click());
  els.customOrdersSkuFile?.addEventListener("change", () => {
    const file = els.customOrdersSkuFile.files?.[0];
    importSkuInboundSchedules(file).catch((error) => {
      console.error(error);
      if (!state.customOrders.skuScheduleImportStatus.startsWith("업로드 중단:")) {
        state.customOrders.skuScheduleImportStatus = `업로드 실패: ${error?.message || error}`;
      }
      renderSkuInboundScheduleManager();
      toast(state.customOrders.skuScheduleImportStatus);
    }).finally(() => {
      els.customOrdersSkuFile.value = "";
    });
  });
  els.customOrdersSkuDownload?.addEventListener("click", () => downloadSkuInboundSchedules().catch((error) => {
    console.error(error);
    state.customOrders.skuScheduleImportStatus = `내려받기 실패: ${error?.message || error}`;
    renderSkuInboundScheduleManager();
    toast(state.customOrders.skuScheduleImportStatus);
  }));
  els.customOrdersSkuList?.addEventListener("click", (event) => {
    const button = event.target.closest('[data-sku-schedule-action="save"]');
    if (!button) return;
    const row = button.closest("[data-sku-inbound-schedule]");
    saveSkuInboundScheduleRow(row).catch((error) => {
      console.error(error);
      state.customOrders.skuScheduleImportStatus = `저장 실패: ${error?.message || error}`;
      renderSkuInboundScheduleManager();
      toast(state.customOrders.skuScheduleImportStatus);
    });
  });
  els.customOrdersList?.addEventListener("click", (event) => onCustomOrderListClick(event).catch((error) => {
    console.error(error);
    toast(`주문제작 처리 실패: ${error?.message || error}`);
  }));
  els.customOrdersList?.addEventListener("change", (event) => onCustomOrderListChange(event).catch((error) => {
    console.error(error);
    toast(`주문제작 저장 실패: ${error?.message || error}`);
    renderCustomOrdersPanel();
  }));
  els.sidebarToggle?.addEventListener("click", () => {
    state.sidebarCollapsed = !state.sidebarCollapsed;
    renderShell();
  });
  els.sideShortcuts?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-side-shortcut]");
    if (!button) return;
    applySideShortcut(button.dataset.sideShortcut, button.dataset.sideValue);
  });
  els.refreshBtn.addEventListener("click", () => loadPickingData().catch(showError));
  els.todayBtn.addEventListener("click", () => {
    state.selectedDate = todayDateString();
    setDashboardMonthFromDate(state.selectedDate);
    state.selectedCompletedGroup = "";
    els.dateInput.value = state.selectedDate;
    loadPickingData().catch(showError);
  });
  els.dateInput.addEventListener("change", () => {
    state.selectedDate = els.dateInput.value;
    setDashboardMonthFromDate(state.selectedDate);
    state.currentGroup = 0;
    state.selectedCompletedGroup = "";
    loadPickingData().catch(showError);
  });
  document.querySelectorAll(".seg").forEach((button) => {
    button.addEventListener("click", () => {
      state.session = button.dataset.session;
      document.querySelectorAll(".seg").forEach((node) => node.classList.toggle("active", node === button));
      state.currentGroup = 0;
      loadPickingData().catch(showError);
    });
  });
  els.sortToggle.addEventListener("click", () => {
    state.workSortMode = !state.workSortMode;
    els.sortToggle.classList.toggle("primary", state.workSortMode);
    els.sortToggle.textContent = state.workSortMode ? "작업순서" : "송장순서";
    rebuildGroups();
    render();
  });
  els.searchInput.addEventListener("input", () => {
    state.searchText = els.searchInput.value;
    render();
    const digits = onlyDigits(state.searchText);
    if (digits.length >= 13 && findInvoiceByInvoiceNo(digits)) {
      jumpToInvoiceNo(digits);
    }
  });
  els.filterBar.addEventListener("click", (event) => {
    const button = event.target.closest("[data-filter]");
    if (!button) return;
    state.filterMode = button.dataset.filter;
    render();
  });
  els.inspectionFilterBar?.addEventListener("click", (event) => {
    const hideCompletedButton = event.target.closest("[data-inspection-hide-completed]");
    if (hideCompletedButton) {
      state.inspectionHideCompleted = !state.inspectionHideCompleted;
      state.selectedInspectionGroup = "";
      renderInspectionPanels();
      renderSideShortcuts();
      return;
    }
    const button = event.target.closest("[data-inspection-filter]");
    if (!button) return;
    state.inspectionFilter = button.dataset.inspectionFilter || "all";
    state.selectedInspectionGroup = "";
    renderInspectionPanels();
    renderSideShortcuts();
  });
  els.inspectionSearchInput?.addEventListener("input", () => {
    state.inspectionSearchText = els.inspectionSearchInput.value;
    state.selectedInspectionGroup = "";
    renderInspectionPanels();
    const digits = onlyDigits(state.inspectionSearchText);
    if (digits.length >= 13) {
      const row = inspectionSourceInvoices().find((invoice) => onlyDigits(invoice.invoiceNo).includes(digits));
      if (row) {
        state.selectedInspectionGroup = row.orderGroupNo;
        renderInspectionPanels();
      }
    }
  });
  els.csDateTabs?.addEventListener("click", (event) => {
    const alimtalkAction = event.target.closest("[data-cs-alimtalk-action]");
    if (alimtalkAction) {
      if (alimtalkAction.dataset.csAlimtalkAction === "export") exportAlimtalkCsv().catch(showCsError);
      return;
    }
    const statusButton = event.target.closest("[data-cs-case-status]");
    if (statusButton) {
      state.csMode = "cases";
      state.csStatusFilter = statusButton.dataset.csCaseStatus || "pending";
      state.selectedCsKey = "";
      renderCsPanels();
      return;
    }
    const modeButton = event.target.closest("[data-cs-mode]");
    if (modeButton?.dataset.csMode === "manual") {
      state.csMode = "manual";
      state.selectedCsKey = "";
      loadManualCsCandidates().catch(showError);
      renderCsPanels();
      return;
    }
    const button = event.target.closest("[data-cs-date]");
    if (!button) return;
    state.csDateFilter = button.dataset.csDate || "all";
    state.selectedCsKey = "";
    renderCsPanels();
  });
  els.csDateTabs?.addEventListener("change", (event) => {
    const templateOnly = event.target.closest("[data-cs-template-only]");
    if (templateOnly) {
      state.csTemplateOnly = Boolean(templateOnly.checked);
      state.selectedCsKey = "";
      renderCsPanels();
      return;
    }
    const templateSelect = event.target.closest("[data-cs-template-filter]");
    if (templateSelect) {
      state.csTypeFilter = templateSelect.value || "";
      state.selectedCsKey = "";
      renderCsPanels();
      return;
    }
    const goldSelect = event.target.closest("[data-cs-gold-filter]");
    if (goldSelect) {
      state.csGoldFilter = goldSelect.value || "all";
      state.selectedCsKey = "";
      renderCsPanels();
      return;
    }
    const inboundDateSelect = event.target.closest("[data-cs-inbound-date-filter]");
    if (inboundDateSelect) {
      state.csInboundDateFilter = inboundDateSelect.value || "all";
      state.selectedCsKey = "";
      renderCsPanels();
    }
  });
  els.csSearchInput?.addEventListener("input", () => {
    state.csSearchText = els.csSearchInput.value;
    state.selectedCsKey = "";
    renderCsPanels();
  });
  els.csListBody?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-cs-key]");
    if (!button) return;
    state.selectedCsKey = button.dataset.csKey;
    renderCsPanels();
  });
  els.csListSort?.addEventListener("change", () => {
    state.csSort = els.csListSort.value || "receipt_desc";
    state.selectedCsKey = "";
    renderCsPanels();
  });
  els.csDetail?.addEventListener("input", (event) => {
    const field = event.target.closest("[data-cs-order-memo], [data-cs-case-order-memo]");
    if (!field) return;
    field.closest(".inspection-memo-cell")?.classList.toggle("has-value", Boolean(field.value.trim()));
  });
  els.csDetail?.addEventListener("change", (event) => {
    const alimtalkExcludedField = event.target.closest("[data-cs-alimtalk-excluded]");
    if (alimtalkExcludedField) {
      const scope = alimtalkExcludedField.closest(".cs-item-card, .cs-item-row");
      const row = selectedCsItemRow(scope?.dataset.csRowKey || "");
      const requested = Boolean(alimtalkExcludedField.checked);
      alimtalkExcludedField.disabled = true;
      saveCsAlimtalkExcluded(row, requested).catch((error) => {
        if (alimtalkExcludedField.isConnected) {
          alimtalkExcludedField.checked = !requested;
          alimtalkExcludedField.disabled = false;
        }
        showCsError(error);
      });
      return;
    }
    if (event.target.closest("[data-shortage-input]")) {
      onShortageInputChange(event);
      return;
    }
    if (event.target.closest("[data-cs-drawer]")) {
      onDrawerChange(event);
      return;
    }
    const orderSyncField = event.target.closest("[data-cs-order-sync-field]");
    if (orderSyncField) {
      saveCsOrderScheduledDate(orderSyncField.dataset.csOrderGroup || "", orderSyncField.value)
        .then(() => renderCsPanels())
        .catch(showCsError);
      return;
    }
    const itemSyncField = event.target.closest("[data-cs-item-sync-field]");
    if (itemSyncField) {
      const scope = itemSyncField.closest(".cs-item-card, .cs-item-row");
      const row = selectedCsItemRow(scope?.dataset.csRowKey || "");
      saveCsItemConfirmedDate(row, itemSyncField.value)
        .then(() => renderCsPanels())
        .catch(showCsError);
      return;
    }
    const managementField = event.target.closest("[data-cs-management-field]");
    if (managementField) {
      const scope = managementField.closest(".cs-item-card, .cs-item-row");
      const row = selectedCsItemRow(scope?.dataset.csRowKey || "");
      saveCsManagementFields(row, scope).catch(showCsError);
      return;
    }
    const caseOrderMemoField = event.target.closest("[data-cs-case-order-memo]");
    if (caseOrderMemoField) {
      const scope = caseOrderMemoField.closest(".cs-item-card, .cs-item-row");
      const row = selectedCsItemRow(scope?.dataset.csRowKey || "");
      saveCsCaseOrderMemo(row, scope).catch(showCsError);
      return;
    }
    const field = event.target.closest("[data-cs-order-memo]");
    if (!field) return;
    saveInspectionSellpiaOrderMemo(field.dataset.orderGroup || "", field.dataset.itemNo || "", field.value).catch(showError);
  });
  els.csDetail?.addEventListener("click", (event) => {
    const cancelButton = event.target.closest("[data-cs-cancel-action]");
    if (cancelButton) {
      runCsCancellationAction(cancelButton).catch(showCsError);
      return;
    }
    const holdButton = event.target.closest("[data-cs-hold-action]");
    if (holdButton) {
      toggleCsShippingHold(holdButton.dataset.csOrderGroup || "").catch(showError);
      return;
    }
    const partialHoldButton = event.target.closest("[data-cs-item-hold-action]");
    if (partialHoldButton) {
      const row = selectedCsItemRow(partialHoldButton.dataset.csRowKey || "");
      toggleCsPartialShippingHold(row).catch(showCsError);
      return;
    }
    const caseAction = event.target.closest("[data-cs-case-action]");
    if (caseAction) {
      const action = caseAction.dataset.csCaseAction;
      const caseId = Number(caseAction.dataset.csCaseId || 0);
      const row = selectedCsItemRow(caseAction.dataset.csRowKey || "");
      const scope = caseAction.closest(".cs-item-card, .cs-case-item-editor, .cs-item-row");
      if (action === "register-auto") {
        registerAutoShortageCsCase(row, scope).catch(showCsError);
      } else if (action === "save-template-override") {
        saveCsTemplateOverride(row, scope).catch(showCsError);
      } else if (action === "create") {
        createManualCsCaseFromDetail(caseAction.dataset.csManualItemNo || "", row, scope).catch(showCsError);
      } else if (action === "save-all") {
        saveCsItemCard(caseId, row, scope).catch(showCsError);
      } else if (action === "save") {
        saveCsCaseFields(caseId, row, scope).catch(showCsError);
      } else if (action === "memo") {
        saveCsCaseOrderMemo(row, scope).then(renderCsPanels).catch(showCsError);
      } else if (action === "resolve" || action === "exclude" || action === "reopen") {
        changeCsCaseStatus(caseId, action).catch(showCsError);
      }
      return;
    }
    const memoButton = event.target.closest("[data-cs-order-memo-save]");
    if (!memoButton) return;
    const orderGroupNo = memoButton.dataset.orderGroup;
    const itemNo = memoButton.dataset.itemNo;
    const field = els.csDetail.querySelector(`[data-cs-order-memo][data-order-group="${window.CSS?.escape ? CSS.escape(orderGroupNo) : orderGroupNo}"][data-item-no="${window.CSS?.escape ? CSS.escape(itemNo) : itemNo}"]`);
    saveInspectionSellpiaOrderMemo(orderGroupNo, itemNo, field?.value || "").then(renderCsPanels).catch(showError);
  });
  els.dashboardSummary?.addEventListener("click", (event) => {
    const monthButton = event.target.closest("[data-dashboard-month]");
    if (monthButton) {
      const value = monthButton.dataset.dashboardMonth;
      if (value === "today") setDashboardMonthFromDate(todayDateString());
      else shiftDashboardMonth(Number(value) || 0);
      return;
    }
    const dateButton = event.target.closest("[data-dashboard-date]");
    if (dateButton) {
      state.selectedDate = dateButton.dataset.dashboardDate;
      setDashboardMonthFromDate(state.selectedDate);
      state.currentGroup = 0;
      state.selectedCompletedGroup = "";
      if (els.dateInput) els.dateInput.value = state.selectedDate;
      loadPickingData().catch(showError);
      return;
    }
    const button = event.target.closest("[data-dashboard-tab]");
    if (!button) return;
    setActiveTab(button.dataset.dashboardTab);
  });
  els.dashboardPanel?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-dashboard-action]");
    if (!button) return;
    if (button.dataset.dashboardAction === "reorder-invoices") {
      reorderInvoicesByCurrentView().catch(showError);
    }
    if (button.dataset.dashboardAction === "toggle-csv") {
      exportToggleCsv().catch(showError);
    }
    if (button.dataset.dashboardAction === "planned-print-csv") {
      exportPlannedPrintCsv();
    }
    if (button.dataset.dashboardAction === "gold-label") {
      exportGoldLabelXlsx().catch(showError);
    }
    if (button.dataset.dashboardAction === "inventory-count-export") {
      exportInventoryCountWorkbook().catch(showError);
    }
    if (button.dataset.dashboardAction === "postoffice-status") {
      showPostOfficeEnrichmentStatus();
    }
    if (button.dataset.dashboardAction === "cs-work-log") {
      openCsWorkLogModal();
    }
    if (button.dataset.dashboardAction === "order-list") {
      openOrderListModal();
    }
    if (button.dataset.dashboardAction === "photo-upload-select") {
      if (!allowWrites) {
        toast("읽기전용입니다. URL에 write=1을 붙여 사진을 업로드할 수 있습니다.");
        return;
      }
      els.dashboardPhotoInput?.click();
    }
    if (button.dataset.dashboardAction === "photo-library-refresh") {
      loadProductPhotoLibrary({ reset: true }).catch(() => {});
    }
    if (button.dataset.dashboardAction === "photo-library-search") {
      searchProductPhotoLibrary();
    }
    if (button.dataset.dashboardAction === "photo-library-more") {
      loadProductPhotoLibrary().catch(() => {});
    }
  });
  els.dashboardPhotoSearch?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") searchProductPhotoLibrary();
  });
  els.dashboardPhotoFilter?.addEventListener("change", () => {
    state.productPhotoLibrary.type = String(els.dashboardPhotoFilter.value || "all");
    state.productPhotoLibrary.selectedNames.clear();
    renderProductPhotoLibrary();
  });
  els.dashboardPhotoLibraryGrid?.addEventListener("change", (event) => {
    const checkbox = event.target.closest("[data-photo-library-select]");
    if (!checkbox) return;
    setProductPhotoLibraryEntrySelected(checkbox.dataset.photoLibrarySelect, checkbox.checked);
  });
  // Capture this before thumbnail/modal handlers so a photo-card right click is
  // never mistaken for the normal image-click interaction in a browser.
  document.addEventListener("contextmenu", openProductPhotoLibraryContextMenuFromEvent, true);
  document.addEventListener("click", (event) => {
    const action = event.target.closest("[data-photo-library-context-action]");
    if (action) {
      const entry = productPhotoLibraryEntryByName(state.productPhotoLibrary.contextMenuName);
      const kind = action.dataset.photoLibraryContextAction;
      closeProductPhotoLibraryContextMenu();
      if (kind === "rename") renameProductPhotoLibraryEntry(entry).catch(showError);
      if (kind === "delete") deleteProductPhotoLibraryEntry(entry).catch(showError);
      if (kind === "delete-selected") deleteProductPhotoLibraryEntries(selectedProductPhotoLibraryEntries()).catch(showError);
      return;
    }
    if (!event.target.closest("#photo-library-context-menu")) closeProductPhotoLibraryContextMenu();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeProductPhotoLibraryContextMenu();
  });
  window.addEventListener("resize", closeProductPhotoLibraryContextMenu);
  window.addEventListener("scroll", closeProductPhotoLibraryContextMenu, true);
  els.dashboardPhotoInput?.addEventListener("change", () => {
    uploadProductPhotos(els.dashboardPhotoInput.files).catch((error) => {
      setProductPhotoUploadBusy(false);
      renderProductPhotoUploadStatus({ message: `사진 업로드 실패: ${error?.message || error}`, tone: "error" });
    });
  });
  els.dashboardPhotoDropzone?.addEventListener("click", () => {
    if (!state.productPhotoUpload.running) els.dashboardPhotoInput?.click();
  });
  els.dashboardPhotoDropzone?.addEventListener("keydown", (event) => {
    if (!["Enter", " "].includes(event.key) || state.productPhotoUpload.running) return;
    event.preventDefault();
    els.dashboardPhotoInput?.click();
  });
  for (const eventName of ["dragenter", "dragover"]) {
    els.dashboardPhotoDropzone?.addEventListener(eventName, (event) => {
      event.preventDefault();
      if (!state.productPhotoUpload.running) els.dashboardPhotoDropzone.classList.add("is-dragging");
    });
  }
  for (const eventName of ["dragleave", "drop"]) {
    els.dashboardPhotoDropzone?.addEventListener(eventName, (event) => {
      event.preventDefault();
      els.dashboardPhotoDropzone.classList.remove("is-dragging");
    });
  }
  els.dashboardPhotoDropzone?.addEventListener("drop", (event) => {
    if (state.productPhotoUpload.running) return;
    uploadProductPhotos(event.dataTransfer?.files).catch((error) => {
      setProductPhotoUploadBusy(false);
      renderProductPhotoUploadStatus({ message: `사진 업로드 실패: ${error?.message || error}`, tone: "error" });
    });
  });
  els.groupList.addEventListener("click", (event) => {
    const bulkButton = event.target.closest("[data-bulk-group]");
    if (bulkButton) {
      event.stopPropagation();
      bulkToggleGroup(Number(bulkButton.dataset.bulkGroup)).catch(showError);
      return;
    }
    const button = event.target.closest("[data-group]");
    if (!button) return;
    state.currentGroup = Number(button.dataset.group);
    renderGroups();
    if (state.activeTab === "picking") {
      renderOrderList();
      renderTray();
    }
  });
  els.jumpGroupBtn?.addEventListener("click", () => jumpToGroup(els.jumpGroupInput.value));
  els.jumpSeqBtn?.addEventListener("click", () => jumpToSequence(els.jumpSeqInput.value));
  els.jumpInvoiceBtn?.addEventListener("click", () => jumpToInvoiceNo(els.jumpInvoiceInput.value));
  els.jumpGroupInput?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") jumpToGroup(els.jumpGroupInput.value);
  });
  els.jumpSeqInput?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") jumpToSequence(els.jumpSeqInput.value);
  });
  els.jumpInvoiceInput?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") jumpToInvoiceNo(els.jumpInvoiceInput.value);
  });
  els.orderList.addEventListener("click", (event) => onOrderListClick(event).catch(showError));
  els.orderList.addEventListener("click", onDrawerKeypadOpen);
  els.orderList.addEventListener("click", (event) => {
    if (event.target.closest("[data-action]")) return;
    const card = event.target.closest("[data-slot-key]");
    if (!card) return;
    selectPickingCard(card.dataset.slotKey);
  });
  els.orderList.addEventListener("change", onDrawerChange);
  els.orderList.addEventListener("change", onShortageInputChange);
  bindPickingGroupSwipe();
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.photoViewer.open) closePhotoViewer();
    if (event.key === "Escape" && state.orderListModal.open) closeOrderListModal();
    if (event.key === "Escape" && state.csWorkLogModal.open) closeCsWorkLogModal();
  });
  document.addEventListener("click", (event) => {
    const image = event.target.closest("[data-photo-src]");
    if (image) {
      openPhotoViewer(image.dataset.photoSrc, image.dataset.photoTitle || "");
      return;
    }
    const photoAction = event.target.closest("[data-photo-action]");
    if (!photoAction) return;
    if (photoAction.dataset.photoAction === "close") closePhotoViewer();
    if (photoAction.dataset.photoAction === "refresh") refreshPhotoViewer();
    if (photoAction.dataset.photoAction === "zoom-apply") setPhotoViewerZoom(document.getElementById("photo-viewer-zoom")?.value);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.target?.id !== "photo-viewer-zoom") return;
    event.preventDefault();
    setPhotoViewerZoom(event.target.value);
  });
  window.addEventListener("resize", () => window.requestAnimationFrame(layoutPhotoViewerImage));
  els.shortageFilterBar?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-shortage-filter]");
    if (!button) return;
    state.shortageFilter = button.dataset.shortageFilter || "all";
    state.selectedShortageKey = "";
    renderShortagePanels();
    renderSideShortcuts();
  });
  els.shortageSearchInput?.addEventListener("input", () => {
    state.shortageSearchText = els.shortageSearchInput.value;
    state.selectedShortageKey = "";
    renderShortagePanels();
    renderSideShortcuts();
  });
  els.shortageReceivingFile?.addEventListener("change", (event) => {
    const file = event.target.files?.[0];
    loadReceivingLabelFile(file).catch(showError);
  });
  els.shortageReceivingOnly?.addEventListener("change", () => {
    state.receivingLabel.only = Boolean(els.shortageReceivingOnly.checked);
    state.selectedShortageKey = "";
    renderShortagePanels();
    renderSideShortcuts();
  });
  els.shortageListBody?.addEventListener("click", (event) => {
    if (event.target.closest("[data-shortage-select]")) return;
    const button = event.target.closest("[data-shortage-key]");
    if (!button) return;
    state.selectedShortageKey = button.dataset.shortageKey;
    renderShortagePanels();
  });
  els.shortageListBody?.addEventListener("change", (event) => {
    const checkbox = event.target.closest("[data-shortage-select]");
    if (!checkbox) return;
    const key = checkbox.dataset.shortageSelect;
    if (checkbox.checked) state.shortageBulkSelectedKeys.add(key);
    else state.shortageBulkSelectedKeys.delete(key);
    renderShortagePanels();
  });
  els.shortageBulkCompleteBtn?.addEventListener("click", () => {
    completeCheckedShortagePickings().catch(showError);
  });
  els.shortageDetail?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-action]");
    if (!button) return;
    if (button.dataset.action === "shortage-repicked") {
      completeSelectedShortagePicking(button.dataset.shortageKey, {
        keepSameOrder: button.hasAttribute("data-shortage-inline-complete"),
      }).catch(showError);
    }
    if (button.dataset.action === "shortage-memo-save") {
      saveSelectedShortageMemo(button.dataset.shortageKey).catch(showError);
    }
    if (button.dataset.action === "shortage-repick-reopen") {
      reopenShortageRepick(button.dataset.orderGroup, button.dataset.itemNo).catch(showError);
    }
  });
  els.shortageDetail?.addEventListener("change", onShortageInputChange);
  els.inspectionListBody?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-inspection-group]");
    if (!button) return;
    state.selectedInspectionGroup = button.dataset.inspectionGroup;
    state.selectedInspectionItemKey = "";
    renderInspectionPanels({ list: false });
  });
  els.inspectionDetail?.addEventListener("input", (event) => {
    const field = event.target.closest("[data-inspection-memo-field]");
    if (!field) return;
    field.closest(".inspection-memo-cell")?.classList.toggle("has-value", Boolean(field.value.trim()));
  });
  els.inspectionDetail?.addEventListener("change", (event) => {
    if (event.target.closest("[data-shortage-input]")) {
      onShortageInputChange(event);
      return;
    }
    if (event.target.closest("[data-inspection-drawer]")) {
      onDrawerChange(event);
      return;
    }
    const field = event.target.closest("[data-inspection-memo-field]");
    if (!field) return;
    const orderGroupNo = field.dataset.orderGroup || "";
    const itemNo = field.dataset.itemNo || "";
    if (field.dataset.inspectionMemoField === "sellpia-order") {
      saveInspectionSellpiaOrderMemo(orderGroupNo, itemNo, field.value).catch(showError);
    }
    if (field.dataset.inspectionMemoField === "confirm") {
      saveInspectionConfirmMemo(orderGroupNo, itemNo, field.value).catch(showError);
    }
  });
  els.inspectionDetail?.addEventListener("click", (event) => {
    const itemRow = event.target.closest("[data-inspection-item-key].is-selectable");
    if (itemRow) selectInspectionItem(itemRow.dataset.inspectionItemKey);
    const button = event.target.closest("[data-action]");
    if (!button) return;
    if (button.dataset.action === "inspection-complete") {
      return;
    }
    if (button.dataset.action === "inspection-reopen") {
      reopenSelectedInspection(button.dataset.inspectionGroup).catch(showError);
    }
    if (button.dataset.action === "inspection-hold" || button.dataset.action === "inspection-hold-release") {
      toggleSelectedInspectionHold(button.dataset.inspectionGroup).catch(showError);
    }
    if (button.dataset.action === "inspection-partial-hold-release") {
      releaseInspectionPartialShippingHold(button.dataset.orderGroup || "", button.dataset.itemNo || "").catch(showError);
    }
    if (button.dataset.action === "shortage-repick-reopen") {
      reopenShortageRepick(button.dataset.orderGroup, button.dataset.itemNo).catch(showError);
    }
  });
  document.querySelectorAll("[data-completed-date-mode]").forEach((button) => {
    button.addEventListener("click", () => {
      state.completedDateMode = button.dataset.completedDateMode === "completed" ? "completed" : "receipt";
      state.selectedCompletedGroup = "";
      renderCompletedPanels();
      renderSideShortcuts();
    });
  });
  els.completedListBody?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-completed-group]");
    if (!button) return;
    state.selectedCompletedGroup = button.dataset.completedGroup;
    renderCompletedPanels();
  });
  els.completedDetail?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-action]");
    if (!button) return;
    if (button.dataset.action === "inspection-reopen") {
      reopenSelectedInspection(button.dataset.completedGroup).catch(showError);
    }
  });
  els.trayHandle?.addEventListener("click", () => {
    state.trayOpen = !state.trayOpen;
    renderTray();
  });
  els.trayExpandBtn?.addEventListener("click", (event) => {
    event.stopPropagation();
    state.trayOpen = true;
    state.trayExpanded = !state.trayExpanded;
    renderTray();
  });
  els.trayBoard?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-tray-key]");
    if (!button) return;
    const shouldToggle = Boolean(event.target.closest("[data-tray-toggle]"));
    state.trayOpen = true;
    scrollToTrayItem(button.dataset.trayKey);
    if (shouldToggle) {
      event.preventDefault();
      toggleSelectedItem().catch(showError);
    }
  });
  document.addEventListener("keydown", onGlobalKeydown);
}

function showError(error) {
  console.error(error);
  els.orderList.innerHTML = `<div class="error">${escapeHtml(error.message || error)}</div>`;
}

function showCsError(error) {
  console.error(error);
  toast(`CS 처리 실패: ${error?.message || error}`);
}

function init() {
  els.dateInput.value = state.selectedDate;
  bindEvents();
  renderMetrics();
  loadPickingData().catch(showError);
}

init();
