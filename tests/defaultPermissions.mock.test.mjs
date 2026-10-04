import assert from "node:assert/strict";
import fs from "node:fs";

const appSource = fs.readFileSync(new URL("../src/app/pickingApp.mjs", import.meta.url), "utf8");
const manifest = JSON.parse(fs.readFileSync(new URL("../manifest.webmanifest", import.meta.url), "utf8"));

assert.match(appSource, /const allowWrites = params\.get\("write"\) !== "0";/, "write mode must default to ON");
assert.match(
  appSource,
  /const allowWorkflowEvents = allowWrites && params\.get\("events"\) !== "0";/,
  "workflow events must default to ON while respecting an explicit write=0",
);
assert.equal(manifest.start_url, "./?source=pwa&write=1&events=1", "the installed tablet app must launch with write and events enabled");

console.log("Default write/event permissions: passed");
