function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
}

const TEMPLATE_KEYS = new Set(["d0", "d1", "14k_1", "d3_pf", "d3_ms", "d5_hi", "d5_lo", "14k_5", "d10"]);

export const ALIMTALK_SEND_LOG_CODES = Object.freeze({
  d0: "0",
  d1: "1",
  "14k_1": "1_14",
  d3_pf: "3",
  d3_ms: "3ㅁ",
  d5_hi: "5ㅂ",
  d5_lo: "5ㅊ",
  "14k_5": "5_14k",
  d10: "10",
  manual: "ㅂㅂ",
});

export function alimtalkSendLogCode(templateKey) {
  return ALIMTALK_SEND_LOG_CODES[String(templateKey || "").trim()] || "";
}

function validDateKey(value) {
  const key = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return false;
  const [year, month, day] = key.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function inferLogDateKey(monthDay, referenceDate) {
  const match = String(monthDay || "").trim().match(/^(\d{2})\/(\d{2})$/);
  const referenceKey = validDateKey(referenceDate) ? String(referenceDate) : "";
  if (!match || !referenceKey) return "";
  const [, month, day] = match;
  const referenceYear = Number(referenceKey.slice(0, 4));
  let candidate = `${referenceYear}-${month}-${day}`;
  if (!validDateKey(candidate)) return "";
  if (candidate > referenceKey) candidate = `${referenceYear - 1}-${month}-${day}`;
  return validDateKey(candidate) ? candidate : "";
}

export function parseAlimtalkSendLog(currentValue, { referenceDate = "" } = {}) {
  const lines = String(currentValue || "")
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
  const finalLine = lines.at(-1) || "";
  const dateText = /^\d{2}\/\d{2}$/.test(finalLine) ? finalLine : "";
  const codeLines = dateText ? lines.slice(0, -1) : lines;
  const codes = codeLines
    .join(",")
    .split(/,+/)
    .map((value) => value.trim())
    .filter(Boolean);
  return {
    codes,
    dateText,
    dateKey: inferLogDateKey(dateText, referenceDate),
  };
}

export function normalizeAlimtalkSendLog(currentValue, logDateKey = "") {
  const referenceDate = validDateKey(logDateKey) ? String(logDateKey) : "";
  const parsed = parseAlimtalkSendLog(currentValue, { referenceDate });
  const codes = parsed.codes.join(",");
  if (!codes) return "";
  const dateText = referenceDate ? `${referenceDate.slice(5, 7)}/${referenceDate.slice(8, 10)}` : parsed.dateText;
  return dateText ? `${codes}\n${dateText}` : codes;
}

export function appendAlimtalkSendLog(currentValue, nextCode, logDateKey = "") {
  const existing = parseAlimtalkSendLog(currentValue, { referenceDate: logDateKey });
  const additions = parseAlimtalkSendLog(nextCode, { referenceDate: logDateKey }).codes;
  return normalizeAlimtalkSendLog([...existing.codes, ...additions].join(","), logDateKey);
}

export function alimtalkSendLogAnchor(currentValue, { isGold = false, referenceDate = "" } = {}) {
  const parsed = parseAlimtalkSendLog(currentValue, { referenceDate });
  const ruleByCode = isGold
    ? {
        "1_14": { day: 1, templateKey: "14k_1" },
        "5_14k": { day: 5, templateKey: "14k_5" },
      }
    : {
        1: { day: 1, templateKey: "d1" },
        3: { day: 3, templateKey: "d3_pf" },
        "3ㅁ": { day: 3, templateKey: "d3_ms" },
        "5ㅂ": { day: 5, templateKey: "d5_hi" },
        "5ㅊ": { day: 5, templateKey: "d5_lo" },
        10: { day: 10, templateKey: "d10" },
      };
  const code = [...parsed.codes].reverse().find((candidate) => ruleByCode[candidate]) || "";
  const rule = ruleByCode[code] || {};
  return {
    ...parsed,
    code,
    day: rule.day || 0,
    templateKey: rule.templateKey || "",
    hasAnchor: Boolean(code && parsed.dateKey),
  };
}

export function formatAlimtalkInboundExpectedDate(value) {
  const raw = String(value ?? "").trim();
  const match = raw.match(/^(\d{4})[-/.]\s*(\d{1,2})[-/.]\s*(\d{1,2})\.?$/);
  if (!match) return raw;
  const [, , month, day] = match;
  return `(입고예정일 : ${month.padStart(2, "0")}-${day.padStart(2, "0")})`;
}

export function hasTomorrowShippingManagementMemo(value) {
  const memo = String(value ?? "").trim();
  return memo === ".." || memo === "!!";
}

export function alimtalkElapsedLabel(value) {
  const days = nonNegativeInteger(value);
  return days >= 11 ? "11일차 이후" : `${days}일차`;
}

/**
 * Resolves whether a delayed item is eligible for an Alimtalk template today.
 * A delay template is never carried forward to a different day. The
 * management-memo1 tomorrow-shipping notice is independent of elapsed days.
 */
export function resolveAlimtalkTemplate({
  elapsedDays,
  isGold = false,
  isTomorrowShipping = false,
  isMakeshop = false,
  selectedTemplate = "",
} = {}) {
  const days = nonNegativeInteger(elapsedDays);
  const selected = String(selectedTemplate || "").trim();

  if (isTomorrowShipping) {
    return {
      elapsedDays: days,
      dayKey: "내일출고",
      label: "내일출고",
      templateKey: "d0",
      allowedTemplateKeys: ["d0"],
      hasTemplate: true,
      selectionRequired: false,
      manuallySelected: false,
    };
  }

  // A user-selected template is an explicit CS decision.  It must not be
  // discarded merely because its normal automatic day has passed.
  if (TEMPLATE_KEYS.has(selected)) {
    return {
      elapsedDays: days,
      dayKey: selected,
      label: "",
      templateKey: selected,
      allowedTemplateKeys: [],
      hasTemplate: true,
      selectionRequired: false,
      manuallySelected: true,
    };
  }

  let allowedTemplateKeys = [];
  if (isGold) {
    if (days === 0) allowedTemplateKeys = ["14k_1"];
    if (days === 4) allowedTemplateKeys = ["14k_5"];
  } else if (days === 0) {
    allowedTemplateKeys = ["d1"];
  } else if (days === 2) {
    allowedTemplateKeys = [isMakeshop ? "d3_ms" : "d3_pf"];
  } else if (days === 4) {
    // The operator must choose either partial-shipment or cancellation-shipment.
    allowedTemplateKeys = ["d5_hi", "d5_lo"];
  } else if (days === 9) {
    allowedTemplateKeys = ["d10"];
  }

  if (!allowedTemplateKeys.length) {
    return {
      elapsedDays: days,
      dayKey: "",
      label: `${alimtalkElapsedLabel(days + 1)} · 템플릿 없음`,
      templateKey: "",
      allowedTemplateKeys,
      hasTemplate: false,
      selectionRequired: false,
      manuallySelected: false,
    };
  }

  const selectionRequired = allowedTemplateKeys.length > 1;
  const templateKey = selectionRequired
      ? ""
      : allowedTemplateKeys[0];
  return {
    elapsedDays: days,
    dayKey: templateKey,
    label: templateKey ? "" : `${alimtalkElapsedLabel(days + 1)} · 템플릿 선택 필요`,
    templateKey,
    allowedTemplateKeys,
    hasTemplate: Boolean(templateKey),
    selectionRequired,
    manuallySelected: false,
  };
}

export function alimtalkSendNaturalKey(ordNo, templateKey) {
  return `${String(ordNo || "").trim()}\u0000${String(templateKey || "").trim()}`;
}
