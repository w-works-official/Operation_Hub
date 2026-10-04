import { normalizeSkuInboundSchedule } from "../domain/skuInboundSchedule.mjs";

function text(value) {
  return String(value ?? "").trim();
}

function validateSchedule(value) {
  const schedule = normalizeSkuInboundSchedule(value);
  if (!schedule.sellpia_sku) throw new Error("셀피아 SKU를 입력해주세요.");
  if (!schedule.inbound_expected_date) throw new Error("입고예정일을 입력해주세요.");
  return schedule;
}

export function createSkuInboundSchedulesAdapter(db) {
  if (!db?.from) throw new Error("A Supabase client is required.");

  async function loadAllSchedules(pageSize = 1000) {
    const rows = [];
    for (let offset = 0; ; offset += pageSize) {
      const { data, error } = await db
        .from("sku_inbound_schedules")
        .select("*")
        .order("inbound_expected_date", { ascending: true })
        .order("sellpia_sku", { ascending: true })
        .range(offset, offset + pageSize - 1);
      if (error) throw error;
      const page = data || [];
      rows.push(...page);
      if (page.length < pageSize) return rows;
    }
  }

  async function upsertSchedules(values = [], batchSize = 200) {
    const normalized = values.map(validateSchedule);
    const seen = new Set();
    for (const schedule of normalized) {
      if (seen.has(schedule.sellpia_sku)) throw new Error(`중복 셀피아 SKU: ${schedule.sellpia_sku}`);
      seen.add(schedule.sellpia_sku);
    }
    const saved = [];
    for (let offset = 0; offset < normalized.length; offset += batchSize) {
      const payload = normalized.slice(offset, offset + batchSize);
      const { data, error } = await db
        .from("sku_inbound_schedules")
        .upsert(payload, { onConflict: "sellpia_sku" })
        .select("*");
      if (error) throw error;
      saved.push(...(data || []));
    }
    return saved;
  }

  async function upsertSchedule(value) {
    const rows = await upsertSchedules([value], 1);
    if (rows.length !== 1) throw new Error("SKU 입고예정일 저장 결과를 확인하지 못했습니다.");
    return rows[0];
  }

  async function loadCurrentItemsForSchedules(schedules = [], batchSize = 200) {
    const skus = [...new Set(schedules.map((row) => text(row?.sellpia_sku)).filter(Boolean))];
    if (!skus.length) return [];
    const rows = [];
    for (let offset = 0; offset < skus.length; offset += batchSize) {
      const { data, error } = await db
        .from("order_items")
        .select("*")
        .in("p_code", skus.slice(offset, offset + batchSize));
      if (error) throw error;
      rows.push(...(data || []));
    }
    return rows;
  }

  return {
    loadAllSchedules,
    upsertSchedule,
    upsertSchedules,
    loadCurrentItemsForSchedules,
  };
}
