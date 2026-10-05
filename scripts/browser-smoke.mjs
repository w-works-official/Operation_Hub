import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {chromium} from "playwright";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = fs.realpathSync(path.resolve(scriptDirectory, ".."));
const pagesPrefix = "/Operation_Hub/";
const supabaseCdnPath = "/npm/@supabase/supabase-js@2.112.3/dist/umd/supabase.js";
const mimeTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

function createStaticServer() {
  const missingLocalAssets = [];
  const server = http.createServer((request, response) => {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(request.url || "/", "http://127.0.0.1").pathname);
    } catch {
      response.writeHead(400).end("Bad request");
      return;
    }

    if (pathname === pagesPrefix.slice(0, -1)) {
      response.writeHead(308, {location: pagesPrefix}).end();
      return;
    }
    if (!pathname.startsWith(pagesPrefix)) {
      response.writeHead(404).end("Not found");
      return;
    }

    let relativePath = pathname.slice(pagesPrefix.length);
    if (!relativePath || relativePath.endsWith("/")) relativePath += "index.html";
    const candidate = path.resolve(repositoryRoot, relativePath);
    if (candidate !== repositoryRoot && !candidate.startsWith(repositoryRoot + path.sep)) {
      response.writeHead(403).end("Forbidden");
      return;
    }

    let realPath;
    try {
      realPath = fs.realpathSync(candidate);
      if (realPath !== repositoryRoot && !realPath.startsWith(repositoryRoot + path.sep)) {
        response.writeHead(403).end("Forbidden");
        return;
      }
      if (!fs.statSync(realPath).isFile()) throw new Error("Not a file");
    } catch {
      missingLocalAssets.push(pathname);
      response.writeHead(404).end("Not found");
      return;
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, {allow: "GET, HEAD"}).end();
      return;
    }
    response.writeHead(200, {
      "content-type": mimeTypes.get(path.extname(realPath).toLowerCase()) || "application/octet-stream",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    if (request.method === "HEAD") response.end();
    else fs.createReadStream(realPath).pipe(response);
  });
  return {server, missingLocalAssets};
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object", "local HTTP server must bind to an ephemeral port");
  return `http://127.0.0.1:${address.port}`;
}

async function main() {
  const {server, missingLocalAssets} = createStaticServer();
  let browser;
  try {
    const origin = await listen(server);
    const executablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH;
    browser = await chromium.launch({headless: true, ...(executablePath ? {executablePath} : {})});
    const page = await browser.newPage();
    const pageErrors = [];
    const failedLocalRequests = [];
    const blockedSupabaseAttempts = [];
    const blockedExternalRequests = [];
    const failedLocalResponses = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("requestfailed", (request) => {
      const requestUrl = new URL(request.url());
      if (requestUrl.origin === origin) failedLocalRequests.push(`${request.method()} ${requestUrl.pathname}`);
    });
    page.on("response", (response) => {
      const responseUrl = new URL(response.url());
      if (responseUrl.origin === origin && response.status() >= 400) {
        failedLocalResponses.push(`${response.status()} ${responseUrl.pathname}`);
      }
    });

    await page.addInitScript(() => {
      try { sessionStorage.removeItem("system-v3-operations-session-v1"); } catch {}
      window.__blockedSupabaseClientCalls = [];
      window.XLSX ||= {
        read() { throw new Error("XLSX is disabled in the offline browser smoke"); },
        utils: {
          aoa_to_sheet() { return {}; },
          book_append_sheet() {},
          book_new() { return {}; },
          sheet_to_json() { return []; },
        },
        writeFile() {},
      };
      window.JSZip ||= class JSZipOfflineStub {};
    });

    await page.route("**/*", async (route) => {
      const requestUrl = new URL(route.request().url());
      if (requestUrl.origin === origin) {
        await route.continue();
        return;
      }
      if (requestUrl.hostname === "cdn.jsdelivr.net" && requestUrl.pathname === supabaseCdnPath) {
        await route.fulfill({
          status: 200,
          contentType: "application/javascript; charset=utf-8",
          body: `window.supabase={createClient:function(){return {rpc:async function(name){window.__blockedSupabaseClientCalls.push(String(name));return {data:null,error:{message:"offline smoke blocked"}}}}}};`,
        });
        return;
      }
      if (requestUrl.hostname === "supabase.co" || requestUrl.hostname.endsWith(".supabase.co")) {
        blockedSupabaseAttempts.push(`${route.request().method()} ${requestUrl.origin}${requestUrl.pathname}`);
      } else {
        blockedExternalRequests.push(`${route.request().method()} ${requestUrl.origin}`);
      }
      await route.abort("blockedbyclient");
    });

    await page.goto(`${origin}${pagesPrefix}`, {waitUntil: "load"});
    await page.waitForURL((url) => url.pathname === `${pagesPrefix}mockups/operations-hub/`, {timeout: 10000});
    await page.waitForLoadState("load");

    assert.equal(new URL(page.url()).pathname, `${pagesPrefix}mockups/operations-hub/`, "Pages root must redirect to the canonical Hub path");
    assert.equal(await page.locator("#operations-auth-gate").isVisible(), true, "operator login gate must be visible");
    assert.equal(await page.locator("#operations-auth-title").textContent(), "상품 운영 허브 로그인");
    assert.equal(await page.locator("#operations-auth-username").isVisible(), true, "username input must render");
    assert.equal(await page.locator("#operations-auth-password").isVisible(), true, "password input must render");
    assert.equal(await page.locator("#operations-auth-submit").isVisible(), true, "login button must render");
    assert.equal(await page.locator("#operations-auth-form").evaluate((form) => form.checkValidity()), false, "empty login form must remain unsubmitted");
    assert.deepEqual(missingLocalAssets, [], "all requested local assets must exist");
    assert.deepEqual(failedLocalResponses, [], "local assets must return successful responses");
    assert.deepEqual(failedLocalRequests, [], "local assets must load without request failures");
    assert.deepEqual(pageErrors, [], "Hub page must render without uncaught JavaScript errors");

    console.log("Hub offline browser smoke: root redirect, login gate, and local assets passed");
    console.log(`Blocked production Supabase requests: ${blockedSupabaseAttempts.length}`);
    if (blockedSupabaseAttempts.length) console.log(JSON.stringify(blockedSupabaseAttempts));
    console.log(`Other external requests aborted: ${blockedExternalRequests.length}`);
  } finally {
    if (browser) await browser.close();
    if (server.listening) {
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
