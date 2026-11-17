// Temporary, data-free integration probe. No credentials, no database writes.
const headers = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const reply = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), { status, headers });

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);

  if (req.method === "GET" && url.searchParams.get("probe") === "egress") {
    try {
      const response = await fetch("https://api.ipify.org?format=json", {
        signal: AbortSignal.timeout(4000),
        headers: { "accept": "application/json" },
      });
      if (!response.ok) return reply({ ok: false, phase: "egress", upstreamStatus: response.status }, 502);
      const body = await response.json();
      return reply({
        ok: true, phase: "egress", observedIp: typeof body.ip === "string" ? body.ip : null,
        staticIpGuaranteed: false, storageWrites: 0
      });
    } catch {
      return reply({ ok: false, phase: "egress", reason: "outbound_fetch_failed" }, 502);
    }
  }

  if (req.method === "GET") {
    return reply({ ok: true, phase: "health", function: "makeshop-bridge-probe-20261117", storageWrites: 0 });
  }

  if (req.method === "POST") {
    // A real provider webhook MUST NOT be acknowledged until signature verification
    // and durable storage are implemented. Never drop a real event with HTTP 2xx.
    if (req.headers.has("webhook-id") || req.headers.has("webhook-signature")) {
      return reply({ ok: false, reason: "real_webhook_not_configured" }, 503);
    }
    if (!req.headers.get("content-type")?.toLowerCase().includes("application/json")) {
      return reply({ ok: false, reason: "json_required" }, 415);
    }
    if (Number(req.headers.get("content-length") || "0") > 2048) {
      return reply({ ok: false, reason: "payload_too_large" }, 413);
    }
    let body: unknown;
    try {
      const raw = await req.text();
      if (new TextEncoder().encode(raw).byteLength > 2048) return reply({ ok: false, reason: "payload_too_large" }, 413);
      body = JSON.parse(raw);
    } catch {
      return reply({ ok: false, reason: "invalid_json" }, 400);
    }
    if (typeof body !== "object" || body === null || (body as Record<string,unknown>).probe !== "makeshop-bridge-probe-20261117") {
      return reply({ ok: false, reason: "probe_marker_required" }, 400);
    }
    return reply({ ok: true, phase: "synthetic_post", persisted: false, storageWrites: 0 });
  }

  return reply({ ok: false, reason: "method_not_allowed" }, 405);
});
