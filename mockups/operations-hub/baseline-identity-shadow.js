(function(g){
 'use strict';
 const clean=v=>String(v??'').trim(),key=r=>JSON.stringify([clean(r.product_code),clean(r.option_code)]);
 // GOODS_LIST labels join the complete ordered carrier option values with ", ".
 // This bridge consumes an already resolved SKU; it never resolves or edits SKU identity.
 function crosswalk({carrier,resolvedSku,baselineRows,declaredLinks=[]}={}){
  if(!clean(resolvedSku)||!clean(carrier?.seller_product_code)||!Array.isArray(carrier?.option_pairs)||!carrier.option_pairs.length)
   return {disposition:'BLOCK',reason:'검증된 SKU/상품 ID/전체 옵션 구성 없음',row:null};
  const label=carrier.option_pairs.map(p=>clean(p.value)).join(', ');
  if(carrier.option_pairs.some(p=>!clean(p.value)))return {disposition:'BLOCK',reason:'빈 옵션 구성',row:null};
  const native=(baselineRows||[]).filter(r=>clean(r.product_code)===clean(carrier.seller_product_code)&&clean(r.option_name)===label);
  // Duplicate records cannot be collapsed into a safe identity.
  if(native.length>1)return {disposition:'BLOCK',reason:'동일 상품·전체 옵션 baseline 후보 복수',row:null};
  const linkedKeys=new Set(declaredLinks.filter(l=>clean(l.sku)===clean(resolvedSku)).map(key));
  if(native.length===1){
   if(linkedKeys.size&&(linkedKeys.size!==1||!linkedKeys.has(key(native[0]))))return {disposition:'BLOCK',reason:'기존 SKU 연결과 native baseline identity 불일치',row:null};
   return {disposition:'MATCH',reason:'실제 seller 상품 ID + 전체 옵션 문자열 exact unique',row:structuredClone(native[0]),
    evidence:{sku:resolvedSku,carrierIdentity:carrier.carrier_identity,productCode:carrier.seller_product_code,fullOptionLabel:label,baselineIdentity:key(native[0])}};
  }
  return {disposition:'WARN_KEEP_ORIGINAL',reason:'해당 seller 상품·전체 옵션 baseline 행 없음',row:null};
 }
 g.HubBaselineIdentityShadow=Object.freeze({crosswalk});
})(typeof window==='undefined'?globalThis:window);
