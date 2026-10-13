// Diagnostic helper. Production reads occur through the separately authorized
// SELECT connector; this file accepts only a hashed numeric projection on stdin.
// It does not connect to a database or read credentials.
import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const md5=value=>createHash('md5').update(String(value)).digest('hex');
const nullableHash=value=>value==null?'~':md5(value);
const basicFields=['sellpia_product_code','sellpia_product_name','sellpia_option_name','own_sku','supplier_code','supplier_name','supplier_group','supplier_address','supplier_market_name','supplier_phone','purchase_product_name','purchase_option_name'];
const statuses=['정상','품절','단종','(missing_or_other)'];
const zeroStatuses=()=>Object.fromEntries(statuses.map(status=>[status,0]));
const numericEqual=(left,right)=>left==null||right==null?left==null&&right==null:Number(left)===Number(right);
export function projectSourceRow(row){
 return {key:md5(row.sellpia_sku_code),stock:row.stock,available_stock:row.available_stock,integrated_available_stock:row.integrated_available_stock,safety_stock:row.safety_stock,
  purchase_price:row.purchase_price,order_unit:row.order_unit,minimum_order_unit:row.minimum_order_unit,
  basic_text_hash:md5(basicFields.map(field=>nullableHash(row[field])).join('|')),
  procurement_metadata_hash:md5([nullableHash(row.raw_payload?.commission),nullableHash(row.raw_payload?.purchase_vat)].join('|')),
  commission_known:Object.hasOwn(row.raw_payload||{},'commission'),purchase_vat_known:Object.hasOwn(row.raw_payload||{},'purchase_vat'),
  base_price:row.raw_payload?.base_price,sell_price:row.raw_payload?.sell_price,raw_purchase_price:row.raw_payload?.purchase_price,
  base_price_known:Object.hasOwn(row.raw_payload||{},'base_price'),sell_price_known:Object.hasOwn(row.raw_payload||{},'sell_price'),raw_purchase_price_known:Object.hasOwn(row.raw_payload||{},'purchase_price'),
  sale_status:statuses.includes(row.raw_payload?.sale_status)?row.raw_payload.sale_status:'(missing_or_other)',sale_status_known:Object.hasOwn(row.raw_payload||{},'sale_status')};
}
export function compareProjectedRows(sourceRows,dbRows){
 const source=new Map(sourceRows.map(row=>[row.key,row])),db=new Map(dbRows.map(row=>[row.key,row]));
 if(source.size!==sourceRows.length||db.size!==dbRows.length)throw Error('QA_DIGEST_IDENTITY_NOT_UNIQUE');
 const sourceOnly=zeroStatuses(),dbOnly=zeroStatuses(),commonSourceStatuses=zeroStatuses(),commonDbStatuses=zeroStatuses(),transitions={};
 const fieldGroups={inventory:{changed:0,unknown:0},price:{changed:0,unknown:0},purchasePrice:{changed:0,unknown:0},basic:{changed:0,unknown:0},status:{changed:0,unknown:0}};
 const perSourceStatus=Object.fromEntries(statuses.map(status=>[status,{common:0,anyChanged:0,anyUnknown:0,inventoryChanged:0,priceChanged:0,purchasePriceChanged:0,basicChanged:0,statusChanged:0}]));
 let common=0,changed=0,unchanged=0,unknown=0;
 const checkNumeric=(left,right,fields)=>fields.some(field=>!numericEqual(left[field],right[field]));
 for(const row of sourceRows){
  const old=db.get(row.key),status=row.sale_status;
  if(!old){sourceOnly[status]++;continue;}
  common++;commonSourceStatuses[status]++;commonDbStatuses[old.sale_status]++;perSourceStatus[status].common++;
  transitions[`${old.sale_status}→${status}`]=(transitions[`${old.sale_status}→${status}`]||0)+1;
  const purchaseKnown=row.commission_known&&row.purchase_vat_known&&old.commission_known&&old.purchase_vat_known;
  const priceKnown=(row.base_price_known||row.sell_price_known)&&(old.base_price_known||old.sell_price_known);
  const oldBase=old.base_price_known?old.base_price:old.sell_price,oldSell=old.sell_price_known?old.sell_price:old.base_price;
  const newBase=row.base_price_known?row.base_price:row.sell_price,newSell=row.sell_price_known?row.sell_price:row.base_price;
  const oldPurchase=old.raw_purchase_price_known?old.raw_purchase_price:old.purchase_price,newPurchase=row.raw_purchase_price_known?row.raw_purchase_price:row.purchase_price;
  const statusKnown=row.sale_status_known&&old.sale_status_known&&status!=='(missing_or_other)'&&old.sale_status!=='(missing_or_other)';
  const groups={inventory:{known:true,changed:checkNumeric(row,old,['stock','available_stock','integrated_available_stock','safety_stock'])},
   price:{known:priceKnown,changed:!numericEqual(oldBase,newBase)||!numericEqual(oldSell,newSell)},
   purchasePrice:{known:purchaseKnown,changed:!numericEqual(old.purchase_price,row.purchase_price)||!numericEqual(oldPurchase,newPurchase)||row.procurement_metadata_hash!==old.procurement_metadata_hash},
   basic:{known:true,changed:row.basic_text_hash!==old.basic_text_hash||checkNumeric(row,old,['order_unit','minimum_order_unit'])},
   status:{known:statusKnown,changed:old.sale_status!==status}};
  let anyChanged=false,anyUnknown=false;
  for(const [name,group] of Object.entries(groups)){
   if(!group.known){fieldGroups[name].unknown++;anyUnknown=true;}
   else if(group.changed){fieldGroups[name].changed++;perSourceStatus[status][name+'Changed']++;anyChanged=true;}
  }
  if(anyUnknown){unknown++;perSourceStatus[status].anyUnknown++;}
  if(anyChanged){changed++;perSourceStatus[status].anyChanged++;}else if(!anyUnknown)unchanged++;
 }
 for(const row of dbRows)if(!source.has(row.key))dbOnly[row.sale_status]++;
 return {sourceRowCount:sourceRows.length,dbRowCount:dbRows.length,commonSkuCount:common,sourceOnlySkuCount:sourceRows.length-common,dbOnlySkuCount:dbRows.length-common,
  changedCommonSkuCount:changed,unchangedCommonSkuCount:unchanged,unknownCommonSkuCount:unknown,sourceOnlyByStatus:sourceOnly,dbOnlyByStatus:dbOnly,
  commonSourceStatusCounts:commonSourceStatuses,commonDbStatusCounts:commonDbStatuses,statusTransitions:transitions,fieldGroups,perSourceStatus};
}

async function receiveProjection(){
 // Interactive exec supplies a PTY. Raw mode prevents its echo from printing
 // private hashed projection rows while we receive newline-delimited JSON.
 const fileIndex=process.argv.indexOf('--projection-file');
 const input=fileIndex>=0?createReadStream(path.resolve(process.argv[fileIndex+1])):process.stdin;
 if(input===process.stdin&&process.stdin.isTTY)process.stdin.setRawMode(true);
 const rows=[];let meta;
 const reader=readline.createInterface({input,crlfDelay:Infinity,terminal:false});
 for await(const line of reader){
  const packet=JSON.parse(line);
  if(packet.type==='metadata'){if(meta)throw Error('QA_DUPLICATE_METADATA');meta=packet;continue;}
  if(packet.type==='page'){
   if(!Array.isArray(packet.rows)||packet.rows.some(row=>!/^[0-9a-f]{32}$/.test(row.key)||!/^[0-9a-f]{32}$/.test(row.basic_text_hash)))throw Error('QA_INVALID_PROJECTION');
   rows.push(...packet.rows);continue;
  }
  if(packet.type!=='finish')throw Error('QA_UNEXPECTED_INPUT');
  if(!meta||rows.length!==meta.initial.rowCount||meta.final.snapshotId!==meta.initial.snapshotId||meta.final.rowCount!==meta.initial.rowCount)throw Error('QA_PINNED_READ_INCOMPLETE');
  const runDirectory=path.resolve(process.env.SELLPIA_QA_RUN_DIRECTORY||'');
  const outputDirectory=path.resolve(process.env.SELLPIA_QA_OUTPUT_DIRECTORY||'');
  const privateDirectory=path.resolve(process.env.SELLPIA_QA_PRIVATE_DIRECTORY||'');
  if(path.basename(runDirectory)!=='804883ac-0600-4ea6-89c7-24d69e37995e'||path.basename(outputDirectory)!=='outputs'||path.basename(privateDirectory)!=='sellpia-qa')throw Error('QA_DIRECTORY_SCOPE');
  const journal=JSON.parse(await fs.readFile(path.join(runDirectory,'journal.json'),'utf8'));
  if(journal.state!=='collected'||journal.expectedRowCount!==27278||journal.files.length!==3)throw Error('QA_SOURCE_JOURNAL');
  const files=[];
  for(const [index,file] of journal.files.entries()){
   const target=path.join(runDirectory,`part-${index+1}.csv`);
   if(path.resolve(file.localPath)!==target)throw Error('QA_SOURCE_PATH');
   const bytes=await fs.readFile(target);
   if(bytes.length!==file.size||createHash('sha256').update(bytes).digest('hex')!==file.sha256)throw Error('QA_SOURCE_SHA256');
   files.push({name:file.name,size:bytes.length,arrayBuffer:async()=>bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)});
  }
  const parser=require('../mockups/operations-hub/sellpia-source-parser.js'),XLSX=require('./vendor/xlsx-0.18.5.full.min.js');
  const parsed=await parser.parseSellpiaFiles(files,{mode:'full',strictNumeric:true,XLSX});
  if(!parsed.valid||parsed.rowCount!==27278)throw Error('QA_SOURCE_PARSE');
  const source=parsed.rows.map(projectSourceRow),comparison=compareProjectedRows(source,rows);
  const result={verifiedAt:new Date().toISOString(),scope:'Authorized Production read-only pinned source snapshot versus actual native full source',
   projectId:'bpgvqmtsjgegnrdzmpep',projectName:'System_v1',sourceRunId:journal.jobId,sourceCollectedAt:journal.updatedAt,sourceManifest:journal.collectionManifest,
   dbSnapshotBefore:meta.initial,dbSnapshotAfter:meta.final,baselineUnchanged:true,pagesRead:meta.pages,projectionComplete:true,
   ...comparison,productionWrites:0,productionReadQueries:meta.pages+2,credentialTablesRead:0,profileFilesRead:0,
   methodology:{identity:'MD5 of exact SKU string; no raw SKU returned. Distinct source and DB digest counts match their unique SKU counts.',
    basic:'MD5 of 12 ordered typed text field digests; numeric order unit/minimum quantity compared separately. Commission and purchase VAT belong to purchasePrice, matching the actual SQL patch contract.',
    numeric:'Minimal selected numeric source fields only; null remains distinct from zero.',
    groups:'Overlapping field groups count changes among common SKUs. New/DB-only SKUs are separate; group counts must not be added to obtain unique changed SKUs.',
    status:'Existing sale_status normal/sold-out/discontinued labels; unknown/missing payload keys reported separately.'},
   limitations:['DB snapshot is Oct 8 inventory_count; native source capture is Oct 13. Stock differences are normal observations, not identity errors.',
    'This compares source data, not system/operational master, manual prices, links, rules or tags.',
    'No DB source apply, retention, deletion, schema migration or external write was performed.',
    'The digest projection is diagnostic and is not an authentication or authorization identity.']};
  await fs.mkdir(privateDirectory,{recursive:true});
  await fs.writeFile(path.join(privateDirectory,'private-pinned-db-projection-20261013.json'),JSON.stringify({meta,rows}));
  await fs.mkdir(outputDirectory,{recursive:true});
  await fs.writeFile(path.join(outputDirectory,'sellpia-production-readonly-source-comparison-20261013.json'),JSON.stringify(result,null,2));
  const report=['현재 운영 원본과 실제 셀피아 전체 파일 읽기 전용 대조 — 2026-10-13','',
   `프로젝트: System_v1 / bpgvqmtsjgegnrdzmpep. DB 최신 ready snapshot ${meta.initial.snapshotId}, mode ${meta.initial.mode}, 완료 ${meta.initial.completedAt}.`,
   `DB ${rows.length}행과 실제 native 전체 원본 ${source.length}행을 비교했다. DB 읽기 전후 snapshot/행 수가 동일하고, digest keyset ${meta.pages}페이지를 완전히 수신했다.`,
   `공통 SKU ${comparison.commonSkuCount}, 실제 파일에만 있는 SKU ${comparison.sourceOnlySkuCount}, DB에만 있는 SKU ${comparison.dbOnlySkuCount}.`,
   `파일에만 있는 상태별 집계: ${JSON.stringify(comparison.sourceOnlyByStatus)}. DB에만 있는 상태별 집계: ${JSON.stringify(comparison.dbOnlyByStatus)}.`,
   `공통 SKU 변경 ${comparison.changedCommonSkuCount}, 동일 ${comparison.unchangedCommonSkuCount}, 비교 미확인 ${comparison.unknownCommonSkuCount}.`,
   `필드군 차이: ${JSON.stringify(comparison.fieldGroups)}. 상태 전이: ${JSON.stringify(comparison.statusTransitions)}.`,
   '재고/가격/기본정보 그룹은 같은 SKU에서 겹칠 수 있으므로 단순 합산하지 않는다. 신규와 DB-only는 공통 SKU의 변경 건수에 포함하지 않았다.',
   '10월 8일의 inventory_count 상태 원본과 10월 13일의 전체 수집 시각이 다르다. 수량 변동은 정상 관측으로 구분하고 identity 오류나 자동 수정 대상으로 판정하지 않았다.',
   '원문 SKU와 상품/매입처 문자열은 SELECT에서 반환하지 않고 digest로 대조했다. per-row digest/숫자 projection은 Git 밖 private scratch에만 저장했다. outputs에는 집계만 있다.',
   '이 결과는 운영 master/system 값, 수동 가격/매핑/태그/규칙의 반영 대상 판단을 포함하지 않는다. 실제 full source 적용 전에는 새 기준 snapshot과 승인을 다시 검증해야 한다.',
   '운영 쓰기 0, credential table 읽기 0, profile 읽기 0. 상세 집계: sellpia-production-readonly-source-comparison-20261013.json'];
  await fs.writeFile(path.join(outputDirectory,'sellpia-production-readonly-source-comparison-20261013.txt'),report.join('\n')+'\n');
  console.log(JSON.stringify({valid:true,commonSkuCount:comparison.commonSkuCount,sourceOnlySkuCount:comparison.sourceOnlySkuCount,dbOnlySkuCount:comparison.dbOnlySkuCount,
   sourceOnlyByStatus:comparison.sourceOnlyByStatus,dbOnlyByStatus:comparison.dbOnlyByStatus,changed:comparison.changedCommonSkuCount,unchanged:comparison.unchangedCommonSkuCount,
   unknown:comparison.unknownCommonSkuCount,fieldGroups:comparison.fieldGroups,productionWrites:0,baselineUnchanged:true}));
  reader.close();process.stdin.pause();return;
 }
 throw Error('QA_INPUT_FINISH_MISSING');
}
if(process.argv.includes('--stdin-projection')||process.argv.includes('--projection-file'))receiveProjection().catch(error=>{console.log(JSON.stringify({valid:false,code:/^QA_[A-Z0-9_]+$/.test(error.message)?error.message:'READONLY_COMPARISON_FAILED'}));process.exitCode=1;});
