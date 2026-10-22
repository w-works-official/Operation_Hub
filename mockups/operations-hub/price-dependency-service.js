(function(g){
 'use strict';
 const data=()=>g.SystemV3Data;
 const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
 const proof=value=>JSON.stringify(canonical(value));
 async function parentPrices(source,skus,priceMode,onQuery){
  if(!skus.length)return new Map();
  const D=data(),R=g.HubCurrentPriceDecisionResolver;
  const response=await D.loadExportCurrentPriceDecisions({source,skus,allowLargeGroups:true,onQuery});
  const decisions=R.normalize(response,{source,skus});
  R.validateGroups(decisions);
  const prices=new Map(),remaining=[];
  for(const sku of skus){
   const rows=decisions.rowsBySku.get(sku)||[],values=new Set(rows.map(row=>row.price.final));
   if(rows.length)for(const group of decisions.groups||[])for(const target of group.targets||[]){
    const members=[...(target.member_skus||[]),target.sku].map(value=>String(value||'').trim());
    if(members.includes(sku)){
     const final=target.current_state?.price?.final??target.price?.final;
     if(Number.isSafeInteger(final))values.add(final);
    }
   }
   if(values.size>1){prices.set(sku,{error:`${sku}: 상위 SKU의 판매처별 연결 가격이 서로 다릅니다.`});continue;}
   if(rows.length){prices.set(sku,{final:rows[0].price.final,proof:{origin:'current_decision',decisions:rows.map(row=>({event_id:row.event_id,revision:row.revision,product:row.seller_product_code,option:row.seller_option_code,price:row.price}))}});continue;}
   remaining.push(sku);
  }
  if(priceMode==='sellpia_source'){
   const raw=remaining.length?await D.loadSellpiaSourcePricesForExport({skus:remaining,onQuery}):new Map();
   for(const sku of remaining)prices.set(sku,{final:raw.get(sku),proof:{origin:'sellpia_source',decisionProof:R.proof(decisions)}});
  }else if(remaining.length){
   const targets=await D.loadCarrierMatrixTargets({source,skus:remaining,onQuery}),internal=[];
   for(const row of targets.rows||[]){
    const target=g.HubCurrentPriceExport.matrixPriceTarget(row);
    if(target?.invalid)prices.set(row.sku,{error:target.reason});
    else if(target)prices.set(row.sku,{final:target.final,proof:{origin:target.origin,tuple:target,decisionProof:R.proof(decisions)}});
    else internal.push(row.sku);
   }
   if(internal.length){
    const registry=await D.ruleRegistry('list'),expanded=g.HubRuleRegistry.expandSkus(internal,registry.dependencies,false,{maxSkus:50000});
    const products=await D.loadInternalFormulaProducts(expanded),evaluator=g.HubRuleRegistry.createEvaluator({...registry,products:Object.fromEntries(products.map(row=>[row.sellpia_sku_code,row]))});
    for(const sku of internal)try{
     const value=evaluator.evaluate(sku,'calculated_base_price');
     prices.set(sku,{final:value.value,proof:{origin:'matrix_base_price',value,decisionProof:R.proof(decisions)}});
    }catch(error){prices.set(sku,{error:error.message});}
   }
  }
  for(const sku of skus)if(!prices.has(sku))prices.set(sku,{error:`${sku}: 상위 가격을 확인할 수 없습니다.`});
  return prices;
 }
 async function prepare({source,skus=null,priceMode='rules',onQuery=null,expectedVersion=null}={}){
  if(!['smartstore','makeshop','ably'].includes(source)||!['rules','sellpia_source'].includes(priceMode))throw Error('종속관계 가격 계산 방식을 확인해주세요.');
  const context=await data().loadExportSkuDependencies({skus,expectedVersion,onQuery});
  const structure=g.HubPriceDependencyExport.plan({context,selection:skus??context.requested_skus});
  const roots=[...new Set(structure.rows.filter(row=>row.inherited&&!row.error).map(row=>row.root_sku))].sort();
  const prices=await parentPrices(source,roots,priceMode,onQuery);
  const resolution=g.HubPriceDependencyExport.resolve({context,parentPrices:prices,selection:skus??context.requested_skus});
  // A selected parent with only an internal Matrix price has no platform Rule
  // export intent yet. Export that same scalar for the parent as well as its
  // children, without fabricating a Rule assignment or writing a price draft.
  resolution.rows=resolution.rows.map(row=>{
   const input=prices.get(row.sku);
   return !row.inherited&&input?.proof?.origin==='matrix_base_price'?{...row,dependency_root:true,final:input.final,price_proof:input.proof}:row;
  });
  resolution.bySku=new Map(resolution.rows.map(row=>[row.sku,row]));
  const rows=resolution.rows.filter(row=>row.inherited||row.error),summary={enabled:true,requestedCount:context.requested_skus.length,autoIncludedCount:resolution.rows.filter(row=>row.automatically_included).length,inheritedCount:rows.filter(row=>row.inherited&&!row.error).length,rows};
  const version=proof({source,priceMode,graph:context.version,rows,prices:[...prices].sort(([a],[b])=>a.localeCompare(b))});
  return {source,skus,priceMode,context,resolution,outputSkus:resolution.outputSkus,summary,proof:version};
 }
 async function verify(prepared){
  const current=await prepare({source:prepared.source,skus:prepared.skus,priceMode:prepared.priceMode,expectedVersion:prepared.context.version});
  if(current.proof!==prepared.proof)throw Error('파일 생성 도중 상위 가격 또는 종속관계가 변경되었습니다. 미리보기를 다시 확인해주세요.');
  return true;
 }
 g.HubPriceDependencyService=Object.freeze({prepare,verify});
})(typeof window==='undefined'?globalThis:window);
