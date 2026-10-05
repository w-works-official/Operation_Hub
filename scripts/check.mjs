import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
const root=process.cwd(), pkg=JSON.parse(fs.readFileSync("package.json","utf8")), hub=pkg.name==="operation-hub";
const walk=(dir)=>fs.existsSync(dir)?fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?(e.name==="vendor"?[]:walk(path.join(dir,e.name))):[path.join(dir,e.name)]):[];
const files=["index.html","sw.js",...walk("src"),...walk(hub?"mockups/operations-hub":"tools"),...walk("scripts")].filter(f=>fs.existsSync(f));
let checked=0;
function assertLocal(reference,source){
  if(!reference||/^(https?:|data:|blob:|mailto:|javascript:|#|\/\/)/i.test(reference))return;
  const clean=reference.split(/[?#]/)[0];
  if(!clean)return;
  if(clean.startsWith("/"))throw Error("Absolute site path requires review: "+source);
  const target=path.resolve(path.dirname(source),decodeURIComponent(clean));
  if(target!==root&&!target.startsWith(root+path.sep))throw Error("Reference escapes repo: "+source);
  if(!fs.existsSync(target))throw Error("Missing local asset: "+source+" -> "+clean);
}
for(const file of files){
 const text=fs.readFileSync(file,"utf8");
 if(/\.(mjs|js)$/.test(file)){
   const result=spawnSync(process.execPath,["--check",file],{encoding:"utf8"});
   if(result.status!==0)throw Error(file+" syntax check failed\n"+result.stderr);
   checked++;
   for(const match of text.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)["'](\.[^"']+)["']/g))assertLocal(match[1],path.resolve(file));
 }
 if(/\.html$/.test(file)){
   for(const tag of text.matchAll(/<(?:script|link|img)\b[^>]*>/gi)){
     for(const ref of tag[0].matchAll(/(?:src|href)=["']([^"']+)["']/gi))assertLocal(ref[1],path.resolve(file));
   }
 }
 if(/\.css$/.test(file))for(const ref of text.matchAll(/url\(["']?([^"')]+)["']?\)/g))assertLocal(ref[1],path.resolve(file));
 if(/\.(mjs|js|html)$/.test(file)){
   if(/["']sb_secret_[A-Za-z0-9_-]+/.test(text)||/-----BEGIN (?:OPENSSH|RSA|EC) PRIVATE KEY-----/.test(text))throw Error("Private credential in runtime: "+file);
   for(const jwt of text.matchAll(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g)){
     try{if(JSON.parse(Buffer.from(jwt[0].split(".")[1],"base64url")).role==="service_role")throw Error("service_role client credential in "+file);}catch(e){if(e.message.startsWith("service_role"))throw e;}
   }
 }
}
if(hub){
 if(fs.existsSync("src/app/pickingApp.mjs")||fs.existsSync("manifest.webmanifest"))throw Error("Picking runtime leaked into Hub");
 const entry=fs.readFileSync("index.html","utf8");
 if(!entry.includes("./mockups/operations-hub/")||/<script\b/i.test(entry))throw Error("Hub landing must be static and point to Hub");
}else{
 if(fs.existsSync("mockups/operations-hub")||fs.existsSync("src/adapters/operationsHubMappingAdapter.mjs"))throw Error("Hub runtime leaked into Picking");
 const manifest=JSON.parse(fs.readFileSync("manifest.webmanifest","utf8"));
 if(manifest.scope!=="./"||manifest.id!=="./"||!manifest.start_url.startsWith("./"))throw Error("PWA must remain repo-relative");
 for(const icon of manifest.icons)assertLocal(icon.src,path.resolve("manifest.webmanifest"));
}
console.log(pkg.name+": "+checked+" syntax checks; local assets/imports, repo boundary and client credential checks passed");
