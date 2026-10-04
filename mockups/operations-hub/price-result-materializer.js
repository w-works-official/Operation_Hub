(function(g){
 'use strict';
 const ALL_SOURCES=['smartstore','makeshop','ably'],CHUNK=200;
 const INTERNAL_FIELDS=['actual_inbound_cost','basis_sku_price','calculated_base_price'];
 const PLATFORM_FIELDS={platform_registration_price:'platformBase',platform_discount_price:'discountedBase',platform_option_price:'platformOption',platform_final_price:'platformFinal'};
 const unique=values=>[...new Set(values.map(value=>String(value??'').trim()).filter(Boolean))];
 function aborted(signal){if(signal?.aborted){const error=new Error('계산 결과 저장을 중단했습니다. 완료된 배치는 유지됩니다.');error.name='AbortError';throw error;}}
 const message=error=>String(error?.message||error);
 function versions(result){return [...new Map((result?.versions||[]).map(v=>[JSON.stringify([v.id,v.version,v.assignmentVersion]),{id:v.id,version:v.version,...(v.assignmentVersion!==undefined?{assignmentVersion:v.assignmentVersion}:{})}])).values()];}
 async function materialize({skus,sources=ALL_SOURCES,reason='price-input-change',requestId,signal,onProgress,activeRulesOnly=false,boundedSkus=null,maxAffectedSkus=50000}={}){
  const D=g.SystemV3Data,M=g.HubRuleRegistry,P=g.HubPlatformRules;
  const selected=unique(sources);if(selected.some(source=>!ALL_SOURCES.includes(source)))throw Error('지원하지 않는 판매처입니다.');
  const seeds=unique(skus||[]);aborted(signal);
  const bound=boundedSkus?new Set(unique(boundedSkus)):null;
  if(!seeds.length)return {generationId:null,status:'complete',totalSkus:0,persistedRows:0,errorRows:0};
  const generation=await D.beginCalculationGeneration({reason,requestId:requestId||g.crypto.randomUUID()});
  const generationId=generation?.generation_id;if(!generationId)throw Error('계산 세대 응답을 확인하지 못했습니다.');
  const summary={generationId,calculatedAt:generation.calculated_at,status:'running',totalSkus:0,completedSkus:0,persistedRows:0,errorRows:0};
  const progress=phase=>{aborted(signal);onProgress?.({...summary,phase});};
  let registry=await D.ruleRegistry('list');aborted(signal);
  const configs={},sourceErrors=new Map(),sourceExpanded=Object.fromEntries(selected.map(source=>[source,new Set()]));
  for(const source of selected){try{configs[source]=await P.settings(source);}catch(error){aborted(signal);sourceErrors.set(source,message(error));}}
  const descendants=new Map();for(const edge of registry.dependencies||[]){if(!descendants.has(edge.parent_sku))descendants.set(edge.parent_sku,[]);descendants.get(edge.parent_sku).push(edge.child_sku);}
  const maximum=Math.min(50000,Math.max(seeds.length,Number(maxAffectedSkus)||50000));
  const affected=new Set(),queue=[];
  function add(values){const pending=[...values];for(let i=0;i<pending.length;i++){const sku=pending[i];if(affected.has(sku))continue;if(bound&&!bound.has(sku))throw Error('지정한 bounded 계산 범위 밖의 의존 SKU: '+sku);affected.add(sku);queue.push(sku);if(affected.size>maximum)throw Error(`영향 SKU가 이 작업의 안전 한도 ${maximum.toLocaleString('ko-KR')}개를 넘습니다. 범위를 나누세요.`);pending.push(...(descendants.get(sku)||[]));}summary.totalSkus=affected.size;}
  add(seeds);
  // Close sibling and downstream dependencies before writing any result.
  // Each seed is queried once per source, in bounded requests.
  const batches=[];let hasRepresentative=false;
  for(let offset=0;offset<queue.length;){
   const batch={seeds:queue.slice(offset,offset+CHUNK),bySource:{}};
   if(D.expandRepresentativeMembers){const members=await D.expandRepresentativeMembers(batch.seeds);if(members.length){hasRepresentative=true;add(members);}}
   for(const source of selected){
    aborted(signal);
    if(sourceErrors.has(source)){batch.bySource[source]=batch.seeds;continue;}
    try{const pending=batch.seeds.filter(sku=>!sourceExpanded[source].has(sku));const siblings=pending.length?unique(await D.loadRulePlatformSiblings(pending,source)):[];batch.bySource[source]=unique([...batch.seeds,...siblings]);batch.bySource[source].forEach(sku=>sourceExpanded[source].add(sku));add(siblings);}
    catch(error){aborted(signal);sourceErrors.set(source,message(error));batch.bySource[source]=batch.seeds;}
   }
   offset+=batch.seeds.length;batches.push(batch);progress('resolve');
  }
  const internalDone=new Set(),platformDone=Object.fromEntries(selected.map(source=>[source,new Set()]));
  async function persist(rows){for(let i=0;i<rows.length;i+=CHUNK){aborted(signal);const part=rows.slice(i,i+CHUNK);await D.upsertCalculatedPriceResults({generationId,rows:part});summary.persistedRows+=part.length;summary.errorRows+=part.filter(row=>row.status==='error').length;progress('persist');}}
  const record=(sku,field,scope,result,error)=>({sku,field,scope,value:error?null:result.value,status:error?'error':'calculated',error:error||null,rule_versions:[...new Map(versions(result).map(v=>{const a=registry.assignments.find(a=>a.sku===sku&&a.rule_id===v.id),full=v.assignmentVersion===undefined&&a?{...v,assignmentVersion:a.version}:v;return [JSON.stringify(full),full];})).values()],result_details:{}});
  const platformFailure=(sku,error)=>Object.keys(PLATFORM_FIELDS).map(field=>record(sku,field,'',null,error));
  async function load(codes,pass){const products={};for(let i=0;i<codes.length;i+=CHUNK){aborted(signal);const chunk=codes.slice(i,i+CHUNK),loader=pass==='internal'&&D.loadInternalFormulaProducts?D.loadInternalFormulaProducts:D.loadFormulaProducts;const legacySkus=chunk.filter(sku=>!registry.assignments.some(a=>a.sku===sku&&a.scope===''&&a.target_field==='actual_inbound_cost'&&registry.rules.some(r=>r.id===a.rule_id&&r.is_active!==false)));for(const product of await loader(chunk,{legacySkus}))products[product.sellpia_sku_code]=product;}return products;}
  // A product may cross a batch boundary. Finish ALL option base writes before
  // materializing its representative value, then stamp seller input proofs.
  for(const pass of ['internal',...(selected.length||hasRepresentative?['seller']:[])]){
   if(pass==='seller'&&hasRepresentative){const results=await D.materializeRepresentatives([...affected],generationId);summary.representativeProducts=results.length;summary.representativeErrors=results.filter(r=>r.status!=='calculated').length;summary.errorRows+=summary.representativeErrors;progress('representative');}
  for(const batch of batches){
   progress('calculate');
   const targets=unique([...batch.seeds,...Object.values(batch.bySource).flat()]);
   if(targets.every(sku=>pass==='internal'?internalDone.has(sku):selected.every(source=>platformDone[source].has(sku))))continue;
   const beforeFingerprints={};
   if(D.loadInputFingerprints){
    for(const scope of pass==='internal'?['']:selected)beforeFingerprints[scope]=await D.loadInputFingerprints(targets,scope);
    // Read definitions/policy/products after the input stamp, then compare again before persisting.
    registry=await D.ruleRegistry('list');
    if(pass==='seller')for(const source of selected)if(!sourceErrors.has(source))configs[source]=await P.settings(source);
   }
   let products,loadError;
   try{products=await load(M.expandSkus(targets,registry.dependencies,false,{maxSkus:50000}),pass);}catch(error){aborted(signal);loadError=message(error);}
   let evaluator,evaluationError;try{if(products)evaluator=M.createEvaluator({...registry,products});}catch(error){evaluationError=message(error);}
   const resolvedValues=new Map(),internalRows=[];
   for(const sku of targets){
    if(internalDone.has(sku))continue;
    const fields=INTERNAL_FIELDS.filter(field=>field==='calculated_base_price'||registry.assignments.some(a=>a.sku===sku&&(a.scope||'')===''&&a.target_field===field));
    for(const field of fields){
     try{if(loadError||evaluationError)throw Error(loadError||evaluationError);const result=evaluator.evaluate(sku,field);const stored={value:result.value,base:result.base,versions:versions(result)};resolvedValues.set(M.key(sku,field,''),stored);internalRows.push(record(sku,field,'',result));}
     catch(error){internalRows.push(record(sku,field,'',null,message(error)));}
    }
   }
   if(D.loadInputFingerprints&&internalRows.length){const after=await D.loadInputFingerprints(targets,'');for(const row of internalRows){if(row.status==='calculated'&&beforeFingerprints[''][row.sku]!==after[row.sku]){row.value=null;row.status='error';row.error='계산 도중 원본/Rule 입력이 변경됐습니다.';}else if(row.status==='calculated')row.result_details.input_fingerprint=after[row.sku];}}
   await persist(internalRows);internalRows.forEach(row=>internalDone.add(row.sku));
   if(pass==='internal'){summary.completedSkus=internalDone.size;progress('internal-complete');continue;}
   for(const source of selected){
    aborted(signal);
    const requested=batch.bySource[source].filter(sku=>!platformDone[source].has(sku));if(!requested.length)continue;
    // Unlinked seller scopes are omitted; the read API checks current identity.
    const linked=requested.filter(sku=>products?.[sku]?.__sellerPriceComponents?.[source]?.seller_product_code);
    const writable=new Set(linked.filter(sku=>!activeRulesOnly||registry.assignments.some(a=>a.sku===sku&&a.scope===source&&a.target_field.startsWith('platform_')&&registry.rules.some(r=>r.id===a.rule_id&&r.is_active!==false))));
    if(activeRulesOnly&&!writable.size){requested.forEach(sku=>platformDone[source].add(sku));continue;}
    const rows=[];
    if(loadError){
     // A newer generation already exists, so invalidate every requested
     // platform tuple. The read adapter drops scopes that are currently
     // unlinked from a seller product.
     for(const sku of requested)if(!activeRulesOnly||writable.has(sku))rows.push(...platformFailure(sku,loadError).map(row=>({...row,scope:source})));
     progress('batch-error');
    }
    if(sourceErrors.has(source)){
     for(const sku of linked)if(writable.has(sku))rows.push(...platformFailure(sku,sourceErrors.get(source)).map(row=>({...row,scope:source})));
    }else if(linked.length){
     try{
      const result=await P.calculate(linked,source,{registry,config:configs[source],products,siblings:linked,resolvedValues});aborted(signal);
      const badGroups=new Map();
      for(const failure of result.errors||[]){const code=failure.product_code||products[failure.sku]?.__sellerPriceComponents?.[source]?.seller_product_code;if(code)badGroups.set(code,failure.error);}
      const bySku=new Map(result.rows.map(row=>[row.sku,row]));
      for(const sku of linked){
       if(!writable.has(sku))continue;
       const row=bySku.get(sku),code=products[sku].__sellerPriceComponents[source].seller_product_code;
       const error=badGroups.get(code)||row?.error||(!row?'계산 결과를 확인하지 못했습니다.':null);
       if(error){rows.push(...platformFailure(sku,error).map(item=>({...item,scope:source})));continue;}
       for(const [field,column] of Object.entries(PLATFORM_FIELDS)){const value=column==='discountedBase'?row.platformBase-row.platformDiscount:row[column];rows.push({...record(sku,field,source,{value,versions:row.versions}),result_details:['platform_discount_price','platform_final_price'].includes(field)?{discount_terms:row.platformTerms||[]}:{}});}
      }
     }catch(error){aborted(signal);for(const sku of linked)if(writable.has(sku))rows.push(...platformFailure(sku,message(error)).map(row=>({...row,scope:source})));}
    }
    if(D.loadInputFingerprints&&rows.length){const after=await D.loadInputFingerprints(requested,source);for(const row of rows){if(row.status==='calculated'&&beforeFingerprints[source][row.sku]!==after[row.sku]){row.value=null;row.status='error';row.error='계산 도중 원본/Rule 입력이 변경됐습니다.';row.result_details={};}else if(row.status==='calculated')row.result_details.input_fingerprint=after[row.sku];}}
    await persist(rows);requested.forEach(sku=>platformDone[source].add(sku));
   }
   summary.completedSkus=internalDone.size;progress('batch-complete');
   // Yield between bounded batches so a browser can paint progress or cancel.
   await new Promise(resolve=>setTimeout(resolve,0));aborted(signal);
  }
  }
  summary.affectedSkus=[...affected];
  summary.status=summary.errorRows?'partial':'complete';progress('complete');return summary;
 }
 g.HubPriceMaterializer={materialize};
})(typeof window==='undefined'?globalThis:window);
