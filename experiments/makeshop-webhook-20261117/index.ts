// Makeshop webhook receiver. No operation hub tables are modified.
// Fails closed until MAKESHOP_WEBHOOK_SECRET and MAKESHOP_CLIENT_ID are configured.
import postgres from "npm:postgres@3.4.3";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const MAX_BYTES = 262144; // refuse payloads exceeding 256 KiB
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
let db: ReturnType<typeof postgres> | undefined;

function response(status: number, data: Record<string, unknown>): Response {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}
function b64decode(encoded: string): Uint8Array {
  const binary = atob(encoded);
  return Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
}
function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  return difference === 0;
}
async function readBounded(req: Request): Promise<Uint8Array> {
  const reader = req.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BYTES) {
        await reader.cancel();
        throw new Error("BODY_TOO_LARGE");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const all = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.length;
  }
  return all;
}
async function validSignature(secret: string, id: string, timestamp: string, raw: Uint8Array, signatures: string): Promise<boolean> {
  let keyBytes: Uint8Array;
  try {
    keyBytes = secret.startsWith("whsec_") ? b64decode(secret.slice(6)) : encoder.encode(secret);
    if (keyBytes.length === 0) return false;
  } catch {
    return false;
  }
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const prefix = encoder.encode(id + "." + timestamp + ".");
  const signed = new Uint8Array(prefix.length + raw.length);
  signed.set(prefix);
  signed.set(raw, prefix.length);
  const expected = new Uint8Array(await crypto.subtle.sign("HMAC", key, signed));
  // Makeshop can provide multiple space-separated v1 signatures during secret rotation.
  for (const item of signatures.trim().split(/\s+/)) {
    if (!item.startsWith("v1,")) continue;
    try {
      if (equalBytes(expected, b64decode(item.slice(3)))) return true;
    } catch {
      // Bad base64 signature, skip.
    }
  }
  return false;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return response(405, { ok: false, code: "POST_REQUIRED" });
  const secret = Deno.env.get("MAKESHOP_WEBHOOK_SECRET");
  const expectedClientId = Deno.env.get("MAKESHOP_CLIENT_ID");
  const dbUrl = Deno.env.get("SUPABASE_DB_URL");
  if (!secret || !expectedClientId || !dbUrl) {
    return response(503, { ok: false, code: "NOT_CONFIGURED" });
  }
  const webhookId = req.headers.get("webhook-id") ?? "";
  const timestamp = req.headers.get("webhook-timestamp") ?? "";
  const signature = req.headers.get("webhook-signature") ?? "";
  const clientId = req.headers.get("x-client-id") ?? "";
  if (!webhookId || !signature || !timestamp || !clientId || clientId !== expectedClientId ||
      webhookId.length > 200 || clientId.length > 200 ||
      !/^\d+$/.test(timestamp) || !Number.isSafeInteger(Number(timestamp)) ||
      Math.abs(Date.now() / 1000 - Number(timestamp)) >= 300) {
    return response(401, { ok: false, code: "INVALID_WEBHOOK_AUTH" });
  }
  if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    return response(415, { ok: false, code: "JSON_REQUIRED" });
  }
  const declaredBytes = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredBytes) && declaredBytes > MAX_BYTES) {
    return response(413, { ok: false, code: "BODY_TOO_LARGE" });
  }
  let raw: Uint8Array;
  try {
    raw = await readBounded(req);
  } catch {
    return response(413, { ok: false, code: "BODY_TOO_LARGE" });
  }
  if (!await validSignature(secret, webhookId, timestamp, raw, signature)) {
    return response(401, { ok: false, code: "INVALID_WEBHOOK_SIGNATURE" });
  }
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(decoder.decode(raw));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid");
    body = parsed as Record<string, unknown>;
  } catch {
    return response(400, { ok: false, code: "INVALID_JSON" });
  }
  const eventId = body.id;
  const eventType = body.event_type;
  const shopId = body.shop_id;
  const occurredAt = typeof body.occurred_at === "string" ? body.occurred_at : null;
  if (typeof eventId !== "string" || !eventId || eventId.length > 200 ||
      typeof eventType !== "string" || !eventType || eventType.length > 200 ||
      typeof shopId !== "string" || !shopId || shopId.length > 200) {
    return response(400, { ok: false, code: "INVALID_EVENT_ENVELOPE" });
  }
  try {
    if (!db) db = postgres(dbUrl, { max: 1, prepare: false, connect_timeout: 5, idle_timeout: 10 });
    const inserted = await db.unsafe(
      "insert into makeshop.webhook_inbox " +
      "(client_id, webhook_id, event_id, event_type, shop_id, occurred_at, webhook_timestamp, payload) " +
      "values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb) " +
      "on conflict (client_id, webhook_id) do nothing returning webhook_id",
      [clientId, webhookId, eventId, eventType, shopId, occurredAt, Number(timestamp), JSON.stringify(body)]
    );
    return response(200, { ok: true, received: true, duplicate: inserted.length === 0 });
  } catch {
    // Retriable failure: do not acknowledge receipt unless it was durably recorded.
    console.error("makeshop_webhook_inbox_write_failed");
    return response(503, { ok: false, code: "PERSISTENCE_UNAVAILABLE" });
  }
});
