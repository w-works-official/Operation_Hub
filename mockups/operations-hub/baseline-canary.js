(function(g){
 'use strict';
 const M=()=>g.HubValueStateModel, finite=sku=>/^5566-[1-4]$|^1181-([1-9]|[12][0-9]|3[01])$/.test(String(sku));
 const enabled=new Set(), key=r=>JSON.stringify([r.product_code,String(r.option_code||'')]);
 const canonicalOps=ops=>structuredClone(ops).sort((a,b)=>key(a).localeCompare(key(b))||a.field.localeCompare(b.field));
 function eligible(product,source,field){const r=product.__hubShadow?.[source],s=r?.[field];return finite(product.sellpia_sku_code)&&!!r?.baselineVersion?.id&&['matched','crosswalk'].includes(r.lookup)&&s?.baseline!=null&&s.disposition!=='BLOCK'&&s.disposition!=='WARN_KEEP_ORIGINAL';}
 function enable(source,value){if(g.HubReleasePolicy?.previewOnly&&value)throw Error('목표값 전환은 현재 미리보기 배포에서 사용할 수 없습니다.');if(!['smartstore','makeshop','ably'].includes(source))throw Error('판매처 범위 오류');value?enabled.add(source):enabled.delete(source);}
 function select(product,source,field,legacy){return !g.HubReleasePolicy?.previewOnly&&enabled.has(source)&&eligible(product,source,field)?product.__hubShadow[source][field].effectiveTarget:legacy;}
 function projectVisible(product,source,legacy){const v={...legacy};v.stockDisplay=select(product,source,'stock',v.stockDisplay);const old={base:v.effectiveBasePrice,discounted:v.effectiveDiscountedBasePrice,option:v.effectiveOptionPrice,final:v.effectiveFinalPrice,terms:v.effectiveDiscountTerms},p=select(product,source,'price',old);if(p){v.effectiveBasePrice=p.base;v.effectiveDiscountedBasePrice=p.discounted;v.effectiveOptionPrice=p.option;v.effectiveFinalPrice=p.final;v.effectiveDiscountTerms=p.terms;}v.canaryPrice=enabled.has(source)&&eligible(product,source,'price');return v;}
 function compare(product,source,current){const r=product.__hubShadow?.[source];return ['price','stock'].map(field=>{const s=r?.[field],same=M().equal(current[field],s?.effectiveTarget);return {sku:product.sellpia_sku_code,source,field,production_current:current[field],shadow_baseline:s?.baseline??null,shadow_effective_target:s?.effectiveTarget??null,discrepancy_reason:same?'same':r?.lookup==='conflict'?'identity conflict':s?.disposition==='WARN_KEEP_ORIGINAL'?s.reason:s?.origin==='manual'?'explicit override':s?.origin==='calculated'?'active Rule calculation':'seller baseline vs legacy current',canary_eligible:eligible(product,source,field)};});}
 function price(row){return M().priceTuple({base:row.base_price,discounted:row.discounted_base_price,option:row.option_price,final:row.final_price,terms:row.discount_terms||[]});}
 function prepare(source,fileName,carrierRows,products,{ably=false,qaSkus=null}={}){
  const inScope=qaSkus?sku=>new Set(qaSkus).has(sku):finite;
  const operations=[],warnings=[],blocks=[],versions=new Map(),seen=new Set();
  for(const c of carrierRows){const sku=c.sku??c.resolution?.sku;if(!inScope(sku))continue;
   const candidates=products.filter(p=>p.sellpia_sku_code===sku);if(candidates.length!==1){blocks.push({sku,reason:'Matrix SKU unique identity 미확인'});continue;}
   const p=candidates[0],r=p.__hubShadow?.[source];
   if(!r||r.lookup==='conflict'){blocks.push({sku,reason:'baseline identity conflict / shadow 없음'});continue;}
   if(r.lookup==='unavailable'){warnings.push({sku,disposition:'WARN_KEEP_ORIGINAL',reason:'baseline unavailable / seller original 유지'});continue;}
   versions.set(r.baselineVersion.id,r.baselineVersion);
   const carrierKey=ably?JSON.stringify([c.source_row_no,c.option_index??'']):key(c);
   if(seen.has(carrierKey)){blocks.push({sku,reason:'duplicate carrier identity'});continue;}seen.add(carrierKey);
   if(!ably&&key(c)!==key(r.identity)){blocks.push({sku,reason:'carrier/baseline identity mismatch'});continue;}
   for(const field of ['price','stock']){
    const state=r[field],before=field==='stock'?(ably?c.sales_quantity:c.stock):price(c);
    if(state?.disposition==='BLOCK'){blocks.push({sku,field,reason:'BLOCK'});continue;}
    const fieldEligible=qaSkus?!!r.baselineVersion?.id&&['matched','crosswalk'].includes(r.lookup)&&state?.baseline!=null&&!['BLOCK','WARN_KEEP_ORIGINAL'].includes(state.disposition):eligible(p,source,field);
    if(!fieldEligible||field==='price'&&state.origin==='baseline'){
     if(state?.disposition==='WARN_KEEP_ORIGINAL'||state?.baseline==null)warnings.push({sku,field,disposition:'WARN_KEEP_ORIGINAL',reason:state?.reason||'target unavailable'});
     continue;
    }
    if(ably&&field==='price'&&!M().equal(state.baseline,state.effectiveTarget)){blocks.push({sku,field,reason:'PlayAuto 가격 전체 tuple 적용 검증 미지원; 기존 경로 유지'});continue;}
    if(ably&&field==='price')continue;
    const target=state.effectiveTarget;if(M().equal(before,target))continue;
    if(before==null){blocks.push({sku,field,reason:'carrier before 미확인'});continue;}
    operations.push({sku,product_code:r.identity.product_code,option_code:r.identity.option_code||'',field,
     baseline_before:structuredClone(state.baseline),carrier_before:structuredClone(before),effective_target:structuredClone(target),disposition:'CHANGE',provenance:state.origin,
     ...(state.overrideId!=null?{override_id:state.overrideId}:{}),...(state.generationId!=null?{generation_id:state.generationId,freshness:state.freshness,current_input_fingerprint:r.calculated?.find(c=>c.scope===source&&c.field==='platform_final_price')?.result_details?.input_fingerprint}:{}),
     source_row_no:c.source_row_no,source_file_name:fileName,...(ably?{option_index:c.option_index??null}:{}),carrier_key:carrierKey});
   }
  }
  if(versions.size!==1)blocks.push({reason:'expected baseline version unique 미확인'});
  if(!ably)for(const op of operations.filter(o=>o.field==='price')){
   if(M().equal(op.carrier_before.base,op.effective_target.base)&&M().equal(op.carrier_before.terms,op.effective_target.terms))continue;
   const siblings=carrierRows.filter(c=>source==='smartstore'?c.source_row_no===op.source_row_no:String(c.product_code)===String(op.product_code));
   const missing=siblings.filter(c=>!operations.some(o=>o.field==='price'&&o.carrier_key===key(c)));
   if(missing.length)blocks.push({sku:op.sku,field:'price',reason:'공유 등록가/할인 변경에 필요한 전체 옵션 price operations 미확인',affected_skus:missing.map(c=>c.sku)});
  }
  const operationKeys=operations.map(o=>key(o)+':'+o.field);if(new Set(operationKeys).size!==operationKeys.length)blocks.push({reason:'duplicate baseline operation identity/field'});
  return {source,operations:canonicalOps(operations),warnings,blocks,baselineVersion:[...versions.values()][0]??null,carrierRows:structuredClone(carrierRows),ably,qaOnly:!!qaSkus};
 }
 function verify(plan,reopened,appliedItems){
  if(plan.blocks.length)throw Error('BLOCK artifact');
  if(appliedItems&&appliedItems.length!==plan.operations.length)throw Error('serializer applied operation count mismatch');
  const lookup=(rows,c)=>rows.filter(r=>plan.ably?r.source_row_no===c.source_row_no&&(r.option_index??null)===(c.option_index??null):key(r)===key(c));
  if(reopened.length!==plan.carrierRows.length)throw Error('serializer row count mismatch');
  const receipts=[];
  for(const before of plan.carrierRows){const afterRows=lookup(reopened,before);if(afterRows.length!==1)throw Error('serializer target identity ambiguous/missing');const after=afterRows[0];
   const ck=plan.ably?JSON.stringify([before.source_row_no,before.option_index??'']):key(before);
   for(const field of ['price','stock']){
    const old=field==='price'?(plan.ably?{base:before.base_price,option:before.option_price}:price(before)):(plan.ably?before.sales_quantity:before.stock);
    const actual=field==='price'?(plan.ably?{base:after.base_price,option:after.option_price}:price(after)):(plan.ably?after.sales_quantity:after.stock);
    const op=plan.operations.find(o=>o.carrier_key===ck&&o.field===field);
    if(op){if(!M().equal(actual,op.effective_target))throw Error('serialized_after != effective_target');receipts.push({...op,serialized_after:structuredClone(actual)});}
    else if(!M().equal(old,actual))throw Error('serializer extra mutation');
   }
   if(plan.ably&&!M().equal(before.available_stock,after.available_stock))throw Error('Ably W 판매가능재고 changed');
  }
  if(receipts.length!==plan.operations.length)throw Error('serializer missing mutation');return canonicalOps(receipts);
 }
 async function digest(blob){return [...new Uint8Array(await g.crypto.subtle.digest('SHA-256',await blob.arrayBuffer()))].map(v=>v.toString(16).padStart(2,'0')).join('');}
 async function base64(blob){const bytes=new Uint8Array(await blob.arrayBuffer());let s='';for(let i=0;i<bytes.length;i+=32768)s+=String.fromCharCode(...bytes.subarray(i,i+32768));return g.btoa(s);}
 function fileFromReceipt(receipt){return new File([Uint8Array.from(g.atob(receipt.artifact_base64),c=>c.charCodeAt(0))],receipt.file_name,{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});}
 async function generate(plan,file,api=g.SystemV3Data){
  if(g.HubReleasePolicy?.previewOnly)throw Error('기준본 검증용 파일 생성은 현재 미리보기 배포에서 사용할 수 없습니다.');
  if(plan.qaOnly&&api?.baselineCanaryMock!==true)throw Error('QA scope는 mock API에서만 사용 가능');
  if(plan.blocks.length)throw Error('BLOCK: '+plan.blocks.map(b=>b.reason).join(' / '));
  const registered=await api.baselineCanaryRpc('plan_register',{p_request_id:g.crypto.randomUUID(),p_source:plan.source,p_expected_version_id:plan.baselineVersion.id,p_expected_version:plan.baselineVersion.version,p_carrier_digest:await digest(file),p_operations:plan.operations,p_warning_count:plan.warnings.length,p_blocked_count:0});
  let blob,rows,applied;
  if(plan.ably){const items=plan.carrierRows.map(r=>{const op=plan.operations.find(o=>o.source_row_no===r.source_row_no&&(o.option_index??null)===(r.option_index??null)&&o.field==='stock');return {...r,target_stock:op?.effective_target??null,target_base_price:null,target_option_price:null};});blob=await g.AblyPlayautoExport.buildOptionPriceStock(file,items);rows=(await g.AblyPlayautoExport.readTemplate(new File([blob],file.name))).items;}
  else{const items=plan.operations.map(op=>M().serializerItem({source_channel:plan.source,seller_product_code:op.product_code,seller_option_code:op.option_code,sellpia_sku_code:op.sku,field_key:op.field==='stock'?'sellpia_current_stock':'sellpia_sale_price',before:op.carrier_before,after:op.effective_target},{fileName:file.name,sourceRowNo:op.source_row_no}));const result=await g.SystemV3SellerExport.transformSellerFile(file,items);if(result.skippedItems.length)throw Error('serializer skipped operation');blob=result.blob;applied=result.appliedItems;rows=(await g.SystemV3SellerParsers.parseSellerFiles(plan.source,[new File([blob],file.name)],{price:true,discount:true,inventory:true})).normalizedRows;}
  const operations=verify(plan,rows,applied),artifactDigest=await digest(blob),fileName=file.name.replace(/\.xlsx$/i,'')+'_canary.xlsx';
  await api.baselineCanaryRpc('artifact_seal',{p_plan_id:registered.plan_id,p_plan_token:registered.plan_token,p_artifact_digest:artifactDigest,p_artifact_base64:await base64(blob),p_file_name:fileName,p_applied_operations:operations,p_serializer_success:true});
  return {plan,registered,blob,fileName,artifactDigest,operations,confirmRequestId:g.crypto.randomUUID(),status:'platform_upload_pending'};
 }
 async function confirm(artifact,uploadConfirmed,api=g.SystemV3Data){if(g.HubReleasePolicy?.previewOnly)throw Error('기준본 갱신은 현재 미리보기 배포에서 사용할 수 없습니다.');if(uploadConfirmed!==true)throw Error('실제 업로드 완료 확인 필요');const p=artifact.plan,r=artifact.registered;return api.baselineCanaryRpc('confirm_plan',{p_request_id:artifact.confirmRequestId,p_source:p.source,p_export_job_id:r.export_job_id,p_artifact_digest:artifact.artifactDigest,p_expected_version_id:p.baselineVersion.id,p_expected_version:p.baselineVersion.version,p_plan_token:r.plan_token,p_operations:artifact.operations,p_upload_confirmed:true});}
 g.HubBaselineCanary=Object.freeze({finite,eligible,enable,select,projectVisible,compare,prepare,verify,digest,fileFromReceipt,generate,confirm});
})(typeof window==='undefined'?globalThis:window);
