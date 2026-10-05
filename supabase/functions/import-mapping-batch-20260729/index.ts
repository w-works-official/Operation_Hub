import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { decompressString } from "npm:lzma1@0.3.0";

const IMPORT_SECRET = Deno.env.get("MAPPING_IMPORT_SECRET") || "";
function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function decodeField(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i += 1) {
    const current = value[i];
    if (current !== "\\" || i + 1 >= value.length) {
      out += current;
      continue;
    }
    const next = value[++i];
    if (next === "n") out += "\n";
    else if (next === "r") out += "\r";
    else if (next === "t") out += "\t";
    else out += next;
  }
  return out;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
  if (!IMPORT_SECRET || req.headers.get("x-import-secret") !== IMPORT_SECRET) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { "content-type": "application/json" } });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    return new Response(JSON.stringify({ error: "missing Supabase environment" }), { status: 500, headers: { "content-type": "application/json" } });
  }
  const client = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

  try {
    const body = await req.json();
    const batchId = String(body?.batch_id ?? "").trim();
    if (!batchId) throw new Error("batch_id is required");

    const { data: batch, error: batchError } = await client
      .from("mapping_import_batches")
      .select("import_batch_id,source_channel,expected_row_count")
      .eq("import_batch_id", batchId)
      .single();
    if (batchError) throw batchError;

    const [{ data: chunks, error: chunkError }, { data: combos, error: comboError }] = await Promise.all([
      client.from("mapping_import_payload_chunks").select("chunk_no,base64_data").eq("import_batch_id", batchId).order("chunk_no", { ascending: true }),
      client.from("mapping_import_combos").select("combo_id,match_tier,match_score").eq("import_batch_id", batchId),
    ]);
    if (chunkError) throw chunkError;
    if (comboError) throw comboError;
    if (!chunks?.length) throw new Error("no payload chunks found");

    const comboMap = new Map((combos ?? []).map((row) => [Number(row.combo_id), row]));
    const compressed = decodeBase64(chunks.map((row) => row.base64_data).join(""));
    const text = decompressString(compressed);
    const lines = text.split("\n").filter((line) => line.length > 0);

    const rows = lines.map((line, index) => {
      const parts = line.split("\t");
      if (parts.length !== 3 && parts.length !== 4) throw new Error(`invalid compact row at ${index + 1}`);
      const sellpiaSku = decodeField(parts[0]).trim();
      const channelCode = decodeField(parts[1]).trim();
      const combo = comboMap.get(Number(parts[2]));
      if (!combo) throw new Error(`missing combo ${parts[2]} at row ${index + 1}`);
      const sourceRowNo = parts.length === 4 ? Number(parts[3]) : index + 2;
      const separator = channelCode.indexOf("-");
      const productCode = separator >= 0 ? channelCode.slice(0, separator) : channelCode;
      const optionCode = separator >= 0 ? channelCode.slice(separator + 1) : null;
      return {
        import_batch_id: batchId,
        source_channel: batch.source_channel,
        sellpia_sku_code: sellpiaSku,
        channel_code: channelCode,
        channel_product_code: productCode || null,
        channel_option_code: optionCode || null,
        match_tier: combo.match_tier,
        match_score: combo.match_score,
        source_row_no: sourceRowNo,
        is_active: true,
      };
    });

    if (rows.length !== Number(batch.expected_row_count)) {
      throw new Error(`row count mismatch: expected ${batch.expected_row_count}, decoded ${rows.length}`);
    }
    for (const [index, row] of rows.entries()) {
      if (!row.sellpia_sku_code || !row.channel_code || !Number.isInteger(row.source_row_no)) {
        throw new Error(`required field missing at decoded row ${index + 1}`);
      }
    }

    const { error: deleteError } = await client.from("channel_sku_mappings").delete().eq("import_batch_id", batchId);
    if (deleteError) throw deleteError;

    const pageSize = 500;
    for (let start = 0; start < rows.length; start += pageSize) {
      const { error: insertError } = await client.from("channel_sku_mappings").insert(rows.slice(start, start + pageSize));
      if (insertError) throw new Error(`insert failed at ${start}: ${insertError.message}`);
    }

    const now = new Date().toISOString();
    const { error: deactivateError } = await client
      .from("channel_sku_mappings")
      .update({ is_active: false, updated_at: now })
      .eq("source_channel", batch.source_channel)
      .neq("import_batch_id", batchId)
      .eq("is_active", true);
    if (deactivateError) throw deactivateError;

    const { error: batchUpdateError } = await client
      .from("mapping_import_batches")
      .update({ imported_row_count: rows.length, import_status: "completed", completed_at: now })
      .eq("import_batch_id", batchId);
    if (batchUpdateError) throw batchUpdateError;

    return new Response(JSON.stringify({ ok: true, batch_id: batchId, channel: batch.source_channel, rows: rows.length }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return new Response(JSON.stringify({ ok: false, error: message }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
});

