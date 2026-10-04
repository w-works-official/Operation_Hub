import { alimtalkSendNaturalKey } from "../domain/alimtalk.mjs";

function text(value) {
  return String(value ?? "").trim();
}

function oneRow(data, error, label) {
  if (error) throw error;
  if (!data || data.length !== 1) throw new Error(`${label}: expected exactly one row.`);
  return data[0];
}

function batchId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error("A valid Alimtalk export batch id is required.");
  return id;
}

export function createAlimtalkSendAdapter(db) {
  if (!db?.from) throw new Error("A Supabase client is required.");

  async function loadUnconfirmedBatches() {
    const { data, error } = await db
      .from("alimtalk_send_batches")
      .select("*")
      .eq("status", "exported")
      .order("created_at", { ascending: false });
    if (error) throw error;
    return data || [];
  }

  async function loadBatchItems(value) {
    const id = batchId(value);
    const { data, error } = await db
      .from("alimtalk_send_items")
      .select("ord_no,inv_no,template_key,basis_date,status")
      .eq("batch_id", id)
      .order("id", { ascending: true });
    if (error) throw error;
    return data || [];
  }

  async function createExportBatch({ items = [], createdBy = null } = {}) {
    const unique = new Map();
    for (const source of items) {
      const ordNo = text(source?.ord_no);
      const templateKey = text(source?.template_key);
      if (!ordNo || !templateKey) continue;
      unique.set(alimtalkSendNaturalKey(ordNo, templateKey), {
        ord_no: ordNo,
        inv_no: text(source?.inv_no) || null,
        template_key: templateKey,
        basis_date: text(source?.basis_date) || null,
        target_snapshot: source?.target_snapshot || {},
      });
    }
    if (!unique.size) throw new Error("No Alimtalk targets were supplied for the export batch.");

    const { data: batchData, error: batchError } = await db
      .from("alimtalk_send_batches")
      .insert({ status: "exported", target_count: unique.size, created_by: text(createdBy) || null })
      .select("*");
    const batch = oneRow(batchData, batchError, "create Alimtalk export batch");
    const itemRows = [...unique.values()].map((item) => ({ ...item, batch_id: batch.id, status: "exported" }));
    const { error: itemError } = await db.from("alimtalk_send_items").insert(itemRows);
    if (itemError) {
      await db.from("alimtalk_send_batches").update({ status: "failed" }).eq("id", batch.id);
      throw itemError;
    }
    return batch;
  }

  async function confirmExportBatch(value, confirmedBy = null) {
    const id = batchId(value);
    const sentAt = new Date().toISOString();
    const { error: itemError } = await db
      .from("alimtalk_send_items")
      .update({ status: "sent", sent_at: sentAt })
      .eq("batch_id", id)
      .eq("status", "exported");
    if (itemError) throw itemError;
    const { data, error } = await db
      .from("alimtalk_send_batches")
      .update({ status: "sent", confirmed_at: sentAt, confirmed_by: text(confirmedBy) || null })
      .eq("id", id)
      .select("*");
    return oneRow(data, error, "confirm Alimtalk export batch");
  }

  return { loadUnconfirmedBatches, loadBatchItems, createExportBatch, confirmExportBatch };
}
