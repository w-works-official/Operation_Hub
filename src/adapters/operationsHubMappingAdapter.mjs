const DEFAULT_BATCH_SIZE = 500;
const DEFAULT_RETRIES = 2;

function cleanText(value) {
  return String(value ?? "").trim();
}

function requestId() {
  if (!globalThis.crypto?.randomUUID) throw new Error("crypto.randomUUID를 사용할 수 없습니다.");
  return globalThis.crypto.randomUUID();
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function normalizeOperationsHubMapping(item = {}) {
  const sourceChannel = cleanText(item.source_channel || item.source).toLowerCase();
  const sellpiaSku = cleanText(item.sellpia_sku_code || item.sellpia_sku);
  const productCode = cleanText(item.product_code);
  const score = Number(item.match_score ?? 100);
  if (!['smartstore', 'makeshop', 'ably'].includes(sourceChannel)) throw new Error(`지원하지 않는 판매처: ${sourceChannel || '-'}`);
  if (!sellpiaSku) throw new Error('셀피아 SKU가 필요합니다.');
  if (!productCode) throw new Error('판매처 상품코드가 필요합니다.');
  if (!Number.isFinite(score) || score < 0 || score > 100) throw new Error('match_score는 0~100 숫자여야 합니다.');
  return {
    source_channel: sourceChannel,
    sellpia_sku_code: sellpiaSku,
    product_code: productCode,
    option_code: cleanText(item.option_code),
    match_score: score,
  };
}

export function chunkOperationsHubMappings(items = [], batchSize = DEFAULT_BATCH_SIZE) {
  const size = Math.max(1, Math.min(DEFAULT_BATCH_SIZE, Number(batchSize) || DEFAULT_BATCH_SIZE));
  const normalized = items.map(normalizeOperationsHubMapping);
  const chunks = [];
  for (let index = 0; index < normalized.length; index += size) {
    chunks.push(normalized.slice(index, index + size));
  }
  return chunks;
}

async function callWorkflow(db, args, {retries, retryDelayMs}) {
  let latestError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const {data, error} = await db.rpc("apply_operations_hub_mapping_workflow", args);
    if (!error) return data;
    latestError = error;
    if (attempt < retries) await wait(retryDelayMs * (attempt + 1));
  }
  throw latestError;
}

export async function saveOperationsHubMappingRun(db, items = [], options = {}) {
  if (!db?.rpc) throw new Error("Supabase service-role client가 필요합니다.");
  if (!Array.isArray(items) || !items.length) throw new Error("저장할 매핑이 없습니다.");

  const actor = cleanText(options.actor || "operations_hub_automation");
  const origin = cleanText(options.origin || "automatic").toLowerCase();
  const note = cleanText(options.note) || null;
  const retries = Math.max(0, Math.min(5, Number(options.retries ?? DEFAULT_RETRIES)));
  const retryDelayMs = Math.max(0, Number(options.retryDelayMs ?? 500));
  const makeRequestId = options.requestIdFactory || requestId;
  const chunks = chunkOperationsHubMappings(items, options.batchSize);
  const results = [];
  let processed = 0;
  if (!/^[0-9A-Za-z_.:@-]{3,120}$/.test(actor)) throw new Error('actor 형식이 올바르지 않습니다.');
  if (!['manual', 'automatic', 'import'].includes(origin)) throw new Error(`지원하지 않는 매핑 출처: ${origin || '-'}`);

  for (let index = 0; index < chunks.length; index += 1) {
    const stableRequestId = makeRequestId(index);
    const result = await callWorkflow(db, {
      p_request_id: stableRequestId,
      p_items: chunks[index],
      p_actor: actor,
      p_origin: origin,
      p_note: note,
      p_finalize: index === chunks.length - 1,
    }, {retries, retryDelayMs});
    results.push(result);
    processed += chunks[index].length;
    if (typeof options.onProgress === 'function') {
      try {
        options.onProgress({
          batch: index + 1,
          batchCount: chunks.length,
          processed,
          total: items.length,
          result,
        });
      } catch (error) {
        options.onProgressError?.(error);
      }
    }
  }

  const batches = results.map((result) => result?.batch || {});
  const savedCount = batches.reduce((sum, batch) => sum + Number(batch.saved_count || 0), 0);
  const failedCount = batches.reduce((sum, batch) => sum + Number(batch.failed_count || 0), 0);
  return {
    status: savedCount === 0 ? "failed" : failedCount ? "partial" : "completed",
    requestedCount: items.length,
    savedCount,
    failedCount,
    batches,
    core: results.at(-1)?.core || null,
    sync: results.at(-1)?.sync || null,
  };
}
