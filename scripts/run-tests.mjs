import fs from "node:fs";
import { spawnSync } from "node:child_process";
const files=JSON.parse(fs.readFileSync("tests/regression-list.json","utf8")).map(f=>"tests/"+f);
for(const file of files)if(!fs.existsSync(file))throw Error("Regression source missing: "+file);
const result=spawnSync(process.execPath,["--test","--test-concurrency=4",...files],{stdio:"inherit"});
process.exit(result.status??1);
