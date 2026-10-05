import { createClient } from 'npm:@supabase/supabase-js@2';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const BUCKET = 'product-images';
const MAX_BYTES = 5 * 1024 * 1024;

function json(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'content-type': 'application/json' },
  });
}

function photoSafeName(code: string) {
  return String(code || 'photo').trim().replace(/[\\/:*?"<>|#%&{}$!`'@+=\s]+/g, '_') || 'photo';
}

function getServiceKey() {
  const legacy = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (legacy) return legacy;

  const rawSecretKeys = Deno.env.get('SUPABASE_SECRET_KEYS');
  if (!rawSecretKeys) return '';

  try {
    const parsed = JSON.parse(rawSecretKeys);
    return parsed.service_role || parsed.service_role_key || parsed.SUPABASE_SERVICE_ROLE_KEY || '';
  } catch {
    return '';
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS });
  }

  if (req.method !== 'POST') {
    return json({ ok: false, error: 'method_not_allowed' }, 405);
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL') || 'https://bpgvqmtsjgegnrdzmpep.supabase.co';
    const serviceKey = getServiceKey();
    if (!serviceKey) return json({ ok: false, error: 'service_key_missing' }, 500);

    const form = await req.formData();
    const pCode = String(form.get('p_code') || '').trim();
    const ownCode = String(form.get('own_code') || '').trim();
    const dryRun = String(form.get('dry_run') || '').trim() === '1';
    const file = form.get('file');

    if (!/^[0-9]{3,}(-[0-9]+)?$/.test(pCode)) {
      return json({ ok: false, error: 'invalid_p_code' }, 400);
    }
    if (!(file instanceof File)) {
      return json({ ok: false, error: 'file_required' }, 400);
    }
    if (file.size <= 0 || file.size > MAX_BYTES) {
      return json({ ok: false, error: 'invalid_file_size', maxBytes: MAX_BYTES }, 400);
    }

    const incomingType = String(file.type || '').toLowerCase();
    if (incomingType && !['image/jpeg', 'image/jpg'].includes(incomingType)) {
      return json({ ok: false, error: 'invalid_content_type' }, 400);
    }

    const safe = photoSafeName(pCode);
    const path = `sellpia/${safe}.jpg`;
    const supabase = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    if (dryRun) {
      return json({ ok: true, dryRun: true, bucket: BUCKET, path, p_code: pCode });
    }

    const bytes = await file.arrayBuffer();
    const { error: uploadError } = await supabase.storage
      .from(BUCKET)
      .upload(path, bytes, {
        contentType: 'image/jpeg',
        cacheControl: '3600',
        upsert: true,
      });
    if (uploadError) {
      return json({ ok: false, error: 'storage_upload_failed', message: uploadError.message }, 500);
    }

    const { data: publicUrlData } = supabase.storage.from(BUCKET).getPublicUrl(path);
    const publicUrl = publicUrlData?.publicUrl || '';

    const { data, error: rpcError } = await supabase.rpc('upsert_uploaded_product_image', {
      p_p_code: pCode,
      p_own_code: ownCode || null,
      p_original_file_name: file.name || `${safe}.jpg`,
      p_storage_bucket: BUCKET,
      p_storage_path: path,
      p_storage_public_url: publicUrl,
      p_content_type: 'image/jpeg',
      p_byte_size: file.size,
    });
    if (rpcError) {
      return json({ ok: false, error: 'metadata_upsert_failed', message: rpcError.message }, 500);
    }

    const row = Array.isArray(data) ? data[0] : data;
    return json({
      ok: true,
      p_code: pCode,
      own_code: row?.own_code || ownCode || '',
      storage_bucket: BUCKET,
      storage_path: path,
      storage_public_url: publicUrl,
      upload_status: row?.upload_status || 'uploaded',
    });
  } catch (err) {
    return json({ ok: false, error: 'unexpected_error', message: String(err?.message || err) }, 500);
  }
});
