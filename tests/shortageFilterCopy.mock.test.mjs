import assert from "node:assert/strict";
import fs from "node:fs";

const appSource = fs.readFileSync(new URL("../src/app/pickingApp.mjs", import.meta.url), "utf8");
const indexSource = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");

assert.match(
  indexSource,
  /data-shortage-filter="all" type="button">전체\(지연일순\)<\/button>/,
  "the default shortage filter button must explain its delay ordering",
);
assert.match(appSource, /\["shortage", "all", "전체\(지연일순\)"\]/);
assert.match(appSource, /all: "전체\(지연일순\)"/);

console.log("Default shortage filter is labeled 전체(지연일순): passed");
