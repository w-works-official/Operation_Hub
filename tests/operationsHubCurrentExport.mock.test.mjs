import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {pathToFileURL} from 'node:url';
const {default:JSZip}=await import(pathToFileURL('C:/Users/hihi0/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/jszip/lib/index.js'));
const source=fs.readFileSync(new URL('../mockups/operations-hub/seller-export-adapter.js',import.meta.url),'utf8');
// Exercise actual ZIP serialization. Node's Blob is adapted only at the ZIP boundary.
class NodeZip extends JSZip {
  pending=[];
  file(name,value){if(value instanceof Blob){this.pending.push(value.arrayBuffer().then(bytes=>super.file(name,bytes)));return this;}return super.file(name,value);}
  async generateAsync(options){await Promise.all(this.pending);return new Blob([await super.generateAsync({...options,type:'uint8array'})]);}
}
const c={console,Blob,File,JSZip:NodeZip,setTimeout};vm.createContext(c);vm.runInContext(source,c);
const a=c.SystemV3SellerExport;
const files=new Map([['smartstore',[new File(['original part 1'],'a.xlsx'),new File(['original part 2'],'b.xlsx')]],['ably',[new File(['original ably'],'a.xlsx')]]]);
const excluded=[{item:{source_channel:'smartstore',sellpia_sku_code:'bad-1',seller_product_code:'p',seller_option_code:'old'},reason:'옵션코드 없음'}];
for(const exclusions of [[],excluded]){
  const result=await a.buildExportArchive(files,[],null,exclusions);
  assert.equal(result.manifest.length,3);
  assert.equal(result.appliedItems.length,0);
  assert.ok(result.manifest.every(x=>x.unchanged));
  const zip=await JSZip.loadAsync(await result.blob.arrayBuffer());
  assert.equal(await zip.file('smartstore/a_SystemV3반영.xlsx').async('string'),'original part 1');
  assert.equal(await zip.file('b_SystemV3반영.xlsx').async('string'),'original part 2');
  assert.equal(await zip.file('ably/a_SystemV3반영.xlsx').async('string'),'original ably');
  if(exclusions.length)assert.match(await zip.file('SystemV3_내보내기_제외목록.csv').async('string'),/옵션코드 없음/);
}
// All runtime conflicts still produce unchanged source files and a reason report.
const c2={global:{JSZip:NodeZip},Blob,outputName:a.outputName,auditCsv:a.auditCsv,conflictCsv:a.conflictCsv,
  patchCsvFile:async(file,items,conflict)=>{conflict({item:items[0],reason:'원본값 불일치'});return new Blob(['must not escape']);}};
vm.createContext(c2);vm.runInContext(source.slice(source.indexOf('  async function buildExportArchive('),source.indexOf('  function downloadBlob('))+'\nthis.build=buildExportArchive;',c2);
const r=await c2.build(new Map([['ably',[new File(['original'],'a.csv'),new File(['untouched'],'b.csv')]]]),[{source_channel:'ably',source_file_name:'a.csv',export_item_id:1}]);
const zip=await JSZip.loadAsync(await r.blob.arrayBuffer());
assert.equal(await zip.file('a_SystemV3반영.csv').async('string'),'original');
assert.equal(await zip.file('b_SystemV3반영.csv').async('string'),'untouched');
assert.equal(r.appliedItems.length,0);
await assert.rejects(a.buildExportArchive(new Map(),[]),/원본.*업로드/);
console.log('Current export: zero changes, all exclusions, actual ZIP byte preservation, all files and same-name source isolation passed');
