export const SKU_INBOUND_SCHEDULE_HEADERS = Object.freeze([
  "셀피아 SKU",
  "입고예정일",
  "자사코드",
]);

function text(value) {
  return String(value ?? "").trim();
}

function validDateParts(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

export function normalizeInboundExpectedDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const local = new Date(value.getTime() - value.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 10);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const utc = new Date(Date.UTC(1899, 11, 30) + Math.round(value * 86400000));
    return utc.toISOString().slice(0, 10);
  }
  const normalized = text(value);
  const match = normalized.match(/^(\d{4})[.\/-](\d{1,2})[.\/-](\d{1,2})$/);
  if (!match) return "";
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!validDateParts(year, month, day)) return "";
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function normalizeSkuInboundSchedule(value = {}) {
  const sellpiaSku = text(value.sellpia_sku ?? value.sellpiaSku ?? value[SKU_INBOUND_SCHEDULE_HEADERS[0]]);
  const inboundExpectedDate = normalizeInboundExpectedDate(
    value.inbound_expected_date ?? value.inboundExpectedDate ?? value[SKU_INBOUND_SCHEDULE_HEADERS[1]],
  );
  const ownCode = text(value.own_code ?? value.ownCode ?? value[SKU_INBOUND_SCHEDULE_HEADERS[2]]);
  return {
    sellpia_sku: sellpiaSku,
    inbound_expected_date: inboundExpectedDate,
    own_code: ownCode || null,
  };
}

function normalizedHeader(value) {
  return text(value).replace(/\s+/g, " ");
}

export function parseSkuInboundScheduleRows(matrix = []) {
  const rows = Array.isArray(matrix) ? matrix : [];
  let headerIndex = -1;
  let columnIndexes = null;
  for (let index = 0; index < Math.min(rows.length, 20); index += 1) {
    const headers = (Array.isArray(rows[index]) ? rows[index] : []).map(normalizedHeader);
    const indexes = SKU_INBOUND_SCHEDULE_HEADERS.map((header) => headers.indexOf(header));
    if (indexes.every((value) => value >= 0)) {
      headerIndex = index;
      columnIndexes = indexes;
      break;
    }
  }
  if (headerIndex < 0) {
    return {
      rows: [],
      errors: [{ rowNumber: 0, message: `헤더는 ${SKU_INBOUND_SCHEDULE_HEADERS.join(" | ")} 순서와 이름을 사용해주세요.` }],
      headerRowNumber: 0,
    };
  }

  const parsed = [];
  const errors = [];
  const skuCounts = new Map();
  for (let index = headerIndex + 1; index < rows.length; index += 1) {
    const source = Array.isArray(rows[index]) ? rows[index] : [];
    if (!source.some((value) => text(value))) continue;
    const rowNumber = index + 1;
    const schedule = normalizeSkuInboundSchedule({
      sellpia_sku: source[columnIndexes[0]],
      inbound_expected_date: source[columnIndexes[1]],
      own_code: source[columnIndexes[2]],
    });
    if (!schedule.sellpia_sku) {
      errors.push({ rowNumber, message: "셀피아 SKU가 비어 있습니다." });
      continue;
    }
    if (!schedule.inbound_expected_date) {
      errors.push({ rowNumber, message: "입고예정일을 YYYY-MM-DD 형식의 실제 날짜로 입력해주세요." });
      continue;
    }
    parsed.push({ ...schedule, rowNumber });
    skuCounts.set(schedule.sellpia_sku, (skuCounts.get(schedule.sellpia_sku) || 0) + 1);
  }

  for (const row of parsed) {
    if ((skuCounts.get(row.sellpia_sku) || 0) > 1) {
      errors.push({ rowNumber: row.rowNumber, message: `같은 파일에 셀피아 SKU ${row.sellpia_sku}가 중복되어 있습니다.` });
    }
  }
  const duplicateSkus = new Set([...skuCounts].filter(([, count]) => count > 1).map(([sku]) => sku));
  return {
    rows: parsed
      .filter((row) => !duplicateSkus.has(row.sellpia_sku))
      .map(({ rowNumber: _rowNumber, ...row }) => row),
    errors,
    headerRowNumber: headerIndex + 1,
  };
}

export function skuInboundScheduleWorkbookRows(schedules = []) {
  return schedules.map((value) => {
    const schedule = normalizeSkuInboundSchedule(value);
    return {
      [SKU_INBOUND_SCHEDULE_HEADERS[0]]: schedule.sellpia_sku,
      [SKU_INBOUND_SCHEDULE_HEADERS[1]]: schedule.inbound_expected_date,
      [SKU_INBOUND_SCHEDULE_HEADERS[2]]: schedule.own_code || "",
    };
  });
}

export function buildSkuInboundScheduleMap(schedules = []) {
  return new Map(
    schedules
      .map(normalizeSkuInboundSchedule)
      .filter((row) => row.sellpia_sku && row.inbound_expected_date)
      .map((row) => [row.sellpia_sku, row]),
  );
}

export function findSkuInboundSchedule(value, schedulesOrMap = []) {
  const sku = text(value?.p_code ?? value?.sellpiaProductCode ?? value?.sellpia_sku ?? value);
  if (!sku) return null;
  const scheduleMap = schedulesOrMap instanceof Map
    ? schedulesOrMap
    : buildSkuInboundScheduleMap(schedulesOrMap);
  return scheduleMap.get(sku) || null;
}
