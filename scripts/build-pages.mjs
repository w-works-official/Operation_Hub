import fs from "node:fs";
import path from "node:path";
const root=process.cwd(),pkg=JSON.parse(fs.readFileSync("package.json","utf8"));
const output=path.resolve(root,"_site");
if(path.dirname(output)!==root||path.basename(output)!=="_site")throw Error("Invalid Pages output path");
if(fs.existsSync(output))throw Error("_site already exists; use a fresh checkout/output directory");
const paths=pkg.name==="operation-hub"?["index.html","sw.js","mockups/operations-hub","tools"]:["index.html","manifest.webmanifest","sw.js","assets","src","tools"];
fs.mkdirSync(output);
const localWorkerRoot=path.resolve(root,'tools/sellpia-sync');
for(const entry of paths)if(fs.existsSync(entry))fs.cpSync(entry,path.join(output,entry),{
  recursive:true,
  // The local browser worker and its machine-specific setup are not Pages
  // runtime assets. Never publish worker configuration or session artifacts.
  filter:source=>{const absoluteSource=path.resolve(source);return absoluteSource!==localWorkerRoot&&!absoluteSource.startsWith(localWorkerRoot+path.sep);}
});
fs.writeFileSync(path.join(output,".nojekyll"),"");
console.log("Built runtime-only Pages artifact: "+paths.filter(p=>fs.existsSync(p)).join(", "));
