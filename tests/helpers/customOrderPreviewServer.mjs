import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const port = Number(process.env.CUSTOM_ORDER_PREVIEW_PORT || 4174);
const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
};

function previewIndex(source) {
  return source
    .replace(
      '<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>',
      '<script src="tests/fixtures/customOrderPreviewSupabase.js"></script>',
    )
    .replace(
      '<div id="app" class="app-shell">',
      '<div style="position:fixed;z-index:99999;right:12px;top:8px;padding:6px 10px;border-radius:999px;background:#7c3aed;color:white;font:800 12px Pretendard,sans-serif;box-shadow:0 4px 14px #0003">LOCAL MOCK · production 미접속</div><div id="app" class="app-shell">',
    );
}

const server = http.createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, "http://127.0.0.1").pathname);
    const requested = pathname === "/" ? "/index.html" : pathname;
    const file = path.resolve(root, `.${requested}`);
    if (!file.startsWith(root)) throw new Error("outside preview root");
    let body = await readFile(file);
    if (requested === "/index.html") body = Buffer.from(previewIndex(body.toString("utf8")));
    response.writeHead(200, {
      "content-type": contentTypes[path.extname(file)] || "application/octet-stream",
      "cache-control": "no-store",
    });
    response.end(body);
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("not found");
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`CUSTOM_ORDER_PREVIEW_READY http://127.0.0.1:${port}/?write=1`);
  console.log("Mock only: no production Supabase or Sellpia connection is used.");
});
