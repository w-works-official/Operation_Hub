const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function businessDayDateKey(value) {
  const key = String(value ?? "").trim().slice(0, 10);
  if (!DATE_KEY_RE.test(key)) return "";
  return Number.isNaN(new Date(`${key}T00:00:00`).getTime()) ? "" : key;
}

/**
 * A System V3 business day is a calendar date on which at least one order was
 * received.  This intentionally follows the operational receipt calendar
 * rather than a fixed weekday/holiday calendar.
 */
export function receiptBusinessDayKeys(rows = []) {
  const keys = new Set();
  for (const row of rows) {
    const key = businessDayDateKey(row?.receipt_date ?? row);
    if (key) keys.add(key);
  }
  return keys;
}

/**
 * The basis date is day zero.  Only receipt-active dates after the basis date
 * and up to today contribute to the elapsed business-day count.
 */
export function receiptBusinessDaysSince(basisDate, receiptDates, today) {
  const basis = businessDayDateKey(basisDate);
  const end = businessDayDateKey(today);
  if (!basis || !end || basis >= end) return 0;

  let elapsed = 0;
  for (const value of receiptDates || []) {
    const key = businessDayDateKey(value);
    if (key && key > basis && key <= end) elapsed += 1;
  }
  return elapsed;
}
