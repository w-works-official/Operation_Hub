import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { resolveSellpiaCarrierLineage } from "./carrier-lineage.mjs";

const BUCKET = "seller-originals";
const VERSION = "2026.09.21-secure-carrier-lineage-v2";
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_TOTAL_BYTES = 60 * 1024 * 1024;
const DOWNLOAD_TTL_SECONDS = 300;

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

const guardClient = createClient(SUPABASE_URL, ANON_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const adminClient = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function allowedOrigin(origin: string): boolean {
  if (!origin) return true;
  if (origin === "https://kimhyein0214-dot.github.io") return true;
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

function corsHeaders(origin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": allowedOrigin(origin) && origin ? origin : "https://kimhyein0214-dot.github.io",
    "Access-Control-Allow-Headers": "apikey, content-type, x-client-info, x-operations-hub-session",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Max-Age": "600",
    "Vary": "Origin",
  };
}

function response(origin: string, status: number, payload: Record<string, unknown>): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders(origin), "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function cleanText(value: unknown): string {
  return String(value ?? "").trim();
}

function asArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((item) => item && typeof item === "object") as Record<string, unknown>[] : [];
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : cleanText((error as { message?: unknown })?.message || error);
  return message.slice(0, 1000) || "요청을 처리하지 못했습니다.";
}

function statusFor(error: unknown): number {
  const code = cleanText((error as { code?: unknown })?.code);
  const message = safeError(error);
  if (code === "42501" || /세션|권한|운영자/.test(message)) return 401;
  if (code === "P0002") return 404;
  if (["22023", "23505", "55000"].includes(code)) return 409;
  return 500;
}

function requireSession(req: Request): string {
  const token = cleanText(req.headers.get("x-operations-hub-session"));
  if (!/^[0-9a-f]{64}$/.test(token)) throw Object.assign(new Error("유효한 운영 세션이 필요합니다."), { code: "42501" });
  return token;
}

async function assertSession(sessionToken: string): Promise<void> {
  const { data, error } = await guardClient.rpc("operations_hub_check_session_v1", { p_session_token: sessionToken });
  if (error) throw error;
  const result = Array.isArray(data) ? data[0] : data;
  if (!result?.authenticated) throw Object.assign(new Error("운영 세션이 만료되었거나 회수되었습니다."), { code: "42501" });
}

async function beginUpload(sessionToken: string, body: Record<string, unknown>) {
  const files = asArray(body.files);
  const declaredTotal = files.reduce((sum, file) => sum + Number(file.size || 0), 0);
  if (files.some((file) => Number(file.size || 0) < 1 || Number(file.size || 0) > MAX_FILE_BYTES)) {
    throw Object.assign(new Error("파일당 최대 크기는 25 MiB입니다."), { code: "22023" });
  }
  if (declaredTotal < 1 || declaredTotal > MAX_TOTAL_BYTES) {
    throw Object.assign(new Error("SELLPIA 업로드 총 용량은 60 MiB를 초과할 수 없습니다."), { code: "22023" });
  }

  const { data: intent, error } = await guardClient.rpc("hub_original_upload_intent_begin_v2", {
    p_session_token: sessionToken,
    p_request_id: cleanText(body.request_id),
    p_upload_mode: cleanText(body.upload_mode),
    p_files: files,
    p_selected_fields: body.selected_fields && typeof body.selected_fields === "object" ? body.selected_fields : {},
    p_source_row_count: Number(body.source_row_count || 0),
  });
  if (error) throw error;
  const result = Array.isArray(intent) ? intent[0] : intent;
  const manifest = asArray(result?.manifest);
  const signedFiles = [];
  try {
    for (const file of manifest) {
      const path = cleanText(file.path);
      const { data, error: signedError } = await adminClient.storage.from(BUCKET).createSignedUploadUrl(path, { upsert: false });
      if (signedError) throw signedError;
      signedFiles.push({ ...file, signed_url: data?.signedUrl, token: data?.token });
    }
  } catch (signError) {
    await guardClient.rpc("hub_original_upload_intent_fail_v1", {
      p_session_token: sessionToken,
      p_intent_id: result?.intent_id,
      p_reason: `signed URL 생성 실패: ${safeError(signError)}`,
      p_aborted: false,
    });
    throw signError;
  }
  return { ...result, manifest: signedFiles, boundary: "signed-upload-v1", digest_verification: "client-declared-only" };
}

async function inspectUploadedObjects(manifest: Record<string, unknown>[]) {
  if (!manifest.length) throw Object.assign(new Error("업로드 manifest가 비어 있습니다."), { code: "22023" });
  const directory = cleanText(manifest[0].path).split("/").slice(0, -1).join("/");
  if (!directory.startsWith("sellpia/")) throw Object.assign(new Error("SELLPIA Storage 경로가 올바르지 않습니다."), { code: "22023" });
  if (manifest.some((item) => cleanText(item.path).split("/").slice(0, -1).join("/") !== directory)) {
    throw Object.assign(new Error("manifest object가 하나의 snapshot 경로에 있지 않습니다."), { code: "22023" });
  }
  const { data: listed, error } = await adminClient.storage.from(BUCKET).list(directory, { limit: 100, sortBy: { column: "name", order: "asc" } });
  if (error) throw error;
  const objects = (listed || []).filter((item) => item.id);
  if (objects.length !== manifest.length) throw Object.assign(new Error("업로드된 object 수가 manifest와 다릅니다."), { code: "22023" });
  const expectedByName = new Map(manifest.map((item) => [cleanText(item.path).split("/").pop(), item]));
  const storageFiles = [];
  for (const object of objects) {
    const expected = expectedByName.get(object.name);
    if (!expected) throw Object.assign(new Error("manifest에 없는 object가 snapshot 경로에 있습니다."), { code: "22023" });
    const size = Number(object.metadata?.size || 0);
    if (size !== Number(expected.size || 0)) throw Object.assign(new Error(`${object.name} object 크기가 manifest와 다릅니다.`), { code: "22023" });
    const type = cleanText(object.metadata?.mimetype || expected.type || "application/octet-stream");
    storageFiles.push({
      path: cleanText(expected.path),
      size,
      type,
      object_id: object.id,
      etag: cleanText(object.metadata?.eTag || object.metadata?.etag),
    });
  }
  return storageFiles.sort((a, b) => a.path.localeCompare(b.path));
}

async function finalizeUpload(sessionToken: string, body: Record<string, unknown>) {
  const intentId = cleanText(body.intent_id);
  const { data: statusData, error: statusError } = await guardClient.rpc("hub_original_upload_intent_status_v1", {
    p_session_token: sessionToken,
    p_intent_id: intentId,
  });
  if (statusError) throw statusError;
  const status = Array.isArray(statusData) ? statusData[0] : statusData;
  if (["uploaded", "parsing", "ready"].includes(cleanText(status?.status))) {
    return { ...status, boundary: "signed-upload-v1", idempotent: true };
  }
  if (cleanText(status?.status) !== "uploading") throw Object.assign(new Error("finalize 가능한 업로드 상태가 아닙니다."), { code: "55000" });
  const storageFiles = await inspectUploadedObjects(asArray(status?.manifest));
  const { data, error } = await adminClient.rpc("hub_original_upload_intent_uploaded_v1", {
    p_session_token: sessionToken,
    p_intent_id: intentId,
    p_storage_files: storageFiles,
  });
  if (error) throw error;
  return { ...(Array.isArray(data) ? data[0] : data), boundary: "signed-upload-v1", digest_verification: "client-declared-only" };
}

async function abortUpload(sessionToken: string, body: Record<string, unknown>) {
  const intentId = cleanText(body.intent_id);
  const { data: statusData, error: statusError } = await guardClient.rpc("hub_original_upload_intent_status_v1", {
    p_session_token: sessionToken,
    p_intent_id: intentId,
  });
  if (statusError) throw statusError;
  const status = Array.isArray(statusData) ? statusData[0] : statusData;
  if (cleanText(status?.status) === "ready") throw Object.assign(new Error("ready snapshot은 cleanup할 수 없습니다."), { code: "55000" });
  const paths = asArray(status?.manifest).map((file) => cleanText(file.path)).filter((path) => path.startsWith(`sellpia/${status?.snapshot_id}/`));
  if (paths.length) {
    const { error: removeError } = await adminClient.storage.from(BUCKET).remove(paths);
    if (removeError) throw removeError;
  }
  const { data, error } = await guardClient.rpc("hub_original_upload_intent_fail_v1", {
    p_session_token: sessionToken,
    p_intent_id: intentId,
    p_reason: cleanText(body.reason || "사용자 또는 client가 업로드를 중단했습니다."),
    p_aborted: true,
  });
  if (error) throw error;
  return { ...(Array.isArray(data) ? data[0] : data), removed_paths: paths.length, boundary: "signed-upload-v1" };
}

function validateStoredPath(source: string, snapshotId: string, path: string): void {
  const prefix = `${source}/${snapshotId}/`;
  if (!path.startsWith(prefix) || path.includes("..") || path.includes("\\")) {
    throw Object.assign(new Error("DB carrier reference의 Storage path가 올바르지 않습니다."), { code: "22023" });
  }
}

async function signDownloadFiles(files: Record<string, unknown>[]) {
  const result = [];
  for (const file of files) {
    const path = cleanText(file.path);
    const name = cleanText(file.name || path.split("/").pop());
    const { data, error } = await adminClient.storage.from(BUCKET).createSignedUrl(path, DOWNLOAD_TTL_SECONDS, { download: name });
    if (error) throw error;
    result.push({ ...file, name, path, signed_url: data?.signedUrl, expires_in: DOWNLOAD_TTL_SECONDS });
  }
  return result;
}

async function sellerReadManifest(body: Record<string, unknown>) {
  const source = cleanText(body.source).toLowerCase();
  if (!["smartstore", "makeshop", "ably"].includes(source)) throw Object.assign(new Error("지원하지 않는 판매처 original source입니다."), { code: "22023" });
  let query = adminClient.from("seller_inventory_snapshots")
    .select("snapshot_id,source_channel,source_file_names,source_storage_files,source_file_size,completed_at,created_at,upload_mode")
    .eq("source_channel", source).eq("upload_status", "ready");
  const requestedSnapshot = cleanText(body.snapshot_id);
  if (requestedSnapshot) query = query.eq("snapshot_id", requestedSnapshot);
  else query = query.order("completed_at", { ascending: false, nullsFirst: false }).order("created_at", { ascending: false }).limit(1);
  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  if (!data) return { source, snapshot_id: null, available: false, reason: "ready 상태의 판매처 원본이 없습니다.", files: [] };
  const files = asArray(data.source_storage_files);
  for (const file of files) validateStoredPath(source, data.snapshot_id, cleanText(file.path));
  const includeUrls = body.include_urls !== false;
  return {
    source, snapshot_id: data.snapshot_id, completed_at: data.completed_at || data.created_at,
    available: files.length > 0, reason: files.length ? "" : "snapshot에 원본 carrier reference가 없습니다.",
    files: includeUrls ? await signDownloadFiles(files) : files,
  };
}

async function sellpiaReadManifest(body: Record<string, unknown>) {
  const { data: latestRows, error: latestError } = await adminClient.from("sellpia_stock_snapshots")
    .select("snapshot_id,source_file_name,source_file_size,metadata,completed_at,created_at")
    .eq("upload_status", "ready").order("completed_at", { ascending: false, nullsFirst: false }).order("created_at", { ascending: false }).order("snapshot_id", { ascending: false }).limit(50);
  if (latestError) throw latestError;
  const rows = latestRows || [];
  const latest = rows[0] || null;
  const indexed = new Map(rows.map((row) => [row.snapshot_id, row]));
  const readReadySnapshot = async (id: string) => {
    if (indexed.has(id)) return indexed.get(id);
    const { data, error } = await adminClient.from("sellpia_stock_snapshots")
      .select("snapshot_id,source_file_name,source_file_size,metadata,completed_at,created_at")
      .eq("snapshot_id", id).eq("upload_status", "ready").maybeSingle();
    if (error) throw error;
    return data;
  };
  const lineage = await resolveSellpiaCarrierLineage(latest, readReadySnapshot, cleanText(body.snapshot_id));
  const snapshot = lineage.carrier;
  const files = asArray(snapshot?.metadata?.source_storage_files);
  if (snapshot) for (const file of files) validateStoredPath("sellpia", snapshot.snapshot_id, cleanText(file.path));
  const available = Boolean(snapshot && files.length === 3 && new Set(files.map((file) => cleanText(file.path))).size === 3);
  const reason = lineage.reason || (available ? "" : "Sellpia 전체 snapshot에 원본 carrier 3개 참조가 없습니다.");
  const includeUrls = body.include_urls !== false;
  return {
    source: "sellpia", snapshot_id: snapshot?.snapshot_id || null,
    completed_at: snapshot?.completed_at || snapshot?.created_at || null,
    state_snapshot_id: lineage.stateSnapshotId,
    state_completed_at: latest?.completed_at || latest?.created_at || null,
    available, reason, files: available && includeUrls ? await signDownloadFiles(files) : files,
  };
}

async function auxiliaryReadManifest(body: Record<string, unknown>) {
  const fileId = cleanText(body.file_id);
  if (!fileId) throw Object.assign(new Error("auxiliary file_id가 필요합니다."), { code: "22023" });
  const { data, error } = await adminClient.from("operations_hub_channel_files")
    .select("file_id,source_channel,source_role,file_name,storage_path,mime_type,file_size,is_active")
    .eq("file_id", fileId).eq("is_active", true).maybeSingle();
  if (error) throw error;
  if (!data) throw Object.assign(new Error("활성 auxiliary carrier를 찾을 수 없습니다."), { code: "P0002" });
  const expectedPrefix = `${data.source_channel}/aux/${data.source_role}/`;
  if (!cleanText(data.storage_path).startsWith(expectedPrefix)) throw Object.assign(new Error("auxiliary DB carrier reference가 올바르지 않습니다."), { code: "22023" });
  const files = [{ name: data.file_name, path: data.storage_path, type: data.mime_type, size: data.file_size }];
  return { source: data.source_channel, source_role: data.source_role, file_id: data.file_id, available: true, files: await signDownloadFiles(files) };
}

async function readManifest(sessionToken: string, body: Record<string, unknown>) {
  await assertSession(sessionToken);
  const kind = cleanText(body.kind);
  if (kind === "seller") return { ...(await sellerReadManifest(body)), boundary: "signed-read-v1" };
  if (kind === "sellpia") return { ...(await sellpiaReadManifest(body)), boundary: "signed-read-v1" };
  if (kind === "auxiliary") return { ...(await auxiliaryReadManifest(body)), boundary: "signed-read-v1" };
  throw Object.assign(new Error("지원하지 않는 original read 종류입니다."), { code: "22023" });
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("Origin") || "";
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin) });
  if (!allowedOrigin(origin)) return response(origin, 403, { error: "허용하지 않는 origin입니다." });
  if (req.method === "GET") return response(origin, 200, { ok: true, version: VERSION, upload: "signed", download: "signed" });
  if (req.method !== "POST") return response(origin, 405, { error: "POST 요청만 지원합니다." });

  try {
    if (!SUPABASE_URL || !ANON_KEY || !SERVICE_KEY) throw new Error("Edge Function server configuration이 없습니다.");
    const sessionToken = requireSession(req);
    const body = await req.json() as Record<string, unknown>;
    const action = cleanText(body.action);
    let data: unknown;
    if (action === "upload-init") data = await beginUpload(sessionToken, body);
    else if (action === "upload-finalize") data = await finalizeUpload(sessionToken, body);
    else if (action === "upload-abort") data = await abortUpload(sessionToken, body);
    else if (action === "read-manifest") data = await readManifest(sessionToken, body);
    else throw Object.assign(new Error("지원하지 않는 original-file action입니다."), { code: "22023" });
    return response(origin, 200, { ok: true, data, version: VERSION });
  } catch (error) {
    return response(origin, statusFor(error), { ok: false, error: safeError(error), code: cleanText((error as { code?: unknown })?.code) || "boundary_error", version: VERSION });
  }
});
