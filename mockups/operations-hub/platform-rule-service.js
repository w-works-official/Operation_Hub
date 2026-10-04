(function(g){
 'use strict';
 const model=()=>g.HubRuleRegistry, data=()=>g.SystemV3Data;
 const ruleFor=(registry,id,field,source)=>{if(!id)return null;const r=registry.rules.find(r=>r.id===id);if(!r||!r.is_active||r.target_field!==field||r.scope!==source)throw Error('판매처 규칙의 단계·판매처를 확인하세요.');model().validateRule(r);return r;};
 const fingerprint=terms=>JSON.stringify((terms||[]).map(t=>Object.fromEntries(Object.entries(t).sort(([a],[b])=>a.localeCompare(b)))).sort((a,b)=>String(a.term_key).localeCompare(String(b.term_key))));
 function manualIntent(product,source){
  const c=product.__sellerPriceComponents?.[source]||{},d=product.__sellerDrafts?.[source+':sellpia_sale_price'];
  const active=d||c.draft_change_id||c.draft_status&&c.draft_status!=='unchanged';if(!active)return {};
  const get=(draft,component)=>d?.[draft]??c[component];
  const mode=get('pricing_input_mode','pricing_input_mode'),baseSource=get('base_price_source','base_price_source'),optionSource=get('option_price_source','option_price_source');
  const result={change_id:d?.change_id??c.draft_change_id,mode};
  const amount=(value,label,signed=false)=>{if(value===null||value===undefined||value===''||!Number.isSafeInteger(Number(value))||!signed&&Number(value)<0)throw Error(label+' 수동값이 유효하지 않습니다.');return Number(value);};
  if(baseSource==='manual')result.base=amount(get('price_base_after','draft_base_price'),'판매가');
  if(mode==='final')result.final=amount(get('price_final_after','draft_final_price')??d?.after_value,'최종가');
  else if(optionSource==='manual'){
   if(mode!=='option')throw Error('수동 옵션가의 입력 방식이 불명확합니다. option 또는 final로 다시 저장하세요.');
   result.option=amount(get('price_option_after','draft_option_price'),'옵션가',true);
  }
  const terms=get('price_discount_terms_after','draft_discount_terms'),before=d?.price_discount_terms_before??c.source_discount_terms??[];
  if(Array.isArray(terms)&&fingerprint(terms)!==fingerprint(before)&&(baseSource==='discount'||terms.some(t=>t.input_source==='manual'))){result.discountTerms=terms;result.discountMode=mode==='discount_anchor'?'reverse':'forward';}
  return result;
 }
 function compose(rows,settings,registry){
  const registration=ruleFor(registry,settings.registration_rule_id,'platform_registration_price',settings.source);
  const discountIds=[...new Set(rows.map(r=>r.discount_rule_id||settings.discount_rule_id||''))];
  if(discountIds.length>1)throw Error('같은 판매처 상품에 서로 다른 할인 Rule이 있습니다.');
  const discount=ruleFor(registry,discountIds[0],'platform_discount_price',settings.source);
  if(discount&&(discount.input_origin!=='self'||discount.source_field!=='platform_registration_price'))throw Error('플랫폼 상품 할인 Rule은 해당 상품 등록가격을 입력값으로 선택하세요.');
  if(!rows.length)return [];
  if(!['forward','reverse'].includes(settings.mode)||!['lowest','middle'].includes(settings.anchor))throw Error('플랫폼 계산 방식을 선택하세요.');
  const registrationRules=rows.map(r=>ruleFor(registry,r.registration_rule_id||settings.registration_rule_id,'platform_registration_price',settings.source));
  const amounts=rows.map((r,i)=>r.registrationValue??(registrationRules[i]?model().transform(r.registrationInput??r.value,registrationRules[i].config):r.value));
  const sorted=[...amounts].sort((a,b)=>a-b),anchor=sorted[settings.anchor==='middle'?Math.floor((sorted.length-1)/2):0];
  const originals=rows[0].discountTerms||[];
  const bases=[...new Set(rows.filter(r=>r.manual?.base!==undefined).map(r=>r.manual.base))];
  if(bases.length>1)throw Error('같은 판매처 상품에 서로 다른 수동 판매가가 있습니다.');
  const discountOverrides=rows.filter(r=>r.manual?.discountTerms!==undefined).map(r=>r.manual);
  if(new Set(discountOverrides.map(m=>fingerprint(m.discountTerms)+'|'+m.discountMode)).size>1)throw Error('같은 판매처 상품에 서로 다른 수동 할인조건이 있습니다.');
  const manualDiscount=discountOverrides[0],original=manualDiscount?.discountTerms??originals;
  const effectiveDiscount=manualDiscount?null:discount;
  let base=anchor, discounted;
  if(effectiveDiscount){
   if(settings.mode==='reverse')base=model().inverse(anchor,effectiveDiscount.config);
   if(bases.length)base=bases[0];
   discounted=model().transform(base,effectiveDiscount.config);
   if(discounted>base)throw Error('할인 Rule의 계산 결과가 등록가격보다 큽니다.');
  }else{
   if((manualDiscount?.discountMode||settings.mode)==='reverse'&&!bases.length){const inv=g.SystemV3DiscountPriceMath.grossBaseForTarget(anchor,original);if(!inv.exact)throw Error(inv.reason);base=inv.basePrice;}
   if(bases.length)base=bases[0];
   discounted=g.SystemV3DiscountPriceMath.discountedBase(base,original);
  }
  const discountKey=settings.source==='makeshop'?'period':'basic';
  let replacement=[];
  if(effectiveDiscount&&settings.source==='makeshop'){
   const code=effectiveDiscount.config.discount_rule_code,percent={M10:10,M15:15,M20:20}[code];
   if(code!=='NONE')replacement=[{term_key:'period',term_type:'period',title:effectiveDiscount.name,rule_code:code,input_source:'formula_tag',unit:'percent',value:percent,is_baseline:true,rounding_mode:'down',rounding_unit:code==='M20'?100:10}];
  }else if(effectiveDiscount&&base!==discounted)replacement=[{term_key:discountKey,term_type:discountKey,title:effectiveDiscount.name,input_source:'formula_tag',unit:'amount',value:base-discounted,is_baseline:true,rounding_mode:'nearest',rounding_unit:1}];
  const terms=effectiveDiscount?[...original.filter(t=>!t.is_baseline&&t.term_key!==discountKey),...replacement]:original;
  return rows.map((r,i)=>({...r,platformBase:base,platformOption:amounts[i]-anchor,platformDiscount:base-discounted,platformFinal:discounted+amounts[i]-anchor,platformTerms:terms,versions:[...(r.versions||[]),...[registrationRules[i],discount].filter(Boolean).map(x=>({id:x.id,version:x.version}))]}));
 }
 async function settings(source){const title='registry-platform:'+source,found=await data().workDocument('get_title','formula',{title});return found||{title,body:{source,mode:'reverse',anchor:'lowest',registration_rule_id:null,discount_rule_id:null}};}
 async function calculate(skus,source,context={}){
  const [registry,config]=await Promise.all([context.registry??data().ruleRegistry('list'),context.config??settings(source)]);
  const requested=[...new Set(skus)];if(!requested.length)throw Error('대상 SKU를 선택하세요.');
  const siblings=context.siblings??await data().loadRulePlatformSiblings(requested,source);
  const targets=[...new Set([...requested,...siblings])];
  const all=model().expandSkus(targets,registry.dependencies,false,{maxSkus:50000});
  const products=context.products?(context.products instanceof Map?Object.fromEntries(context.products):context.products):Object.fromEntries((await data().loadFormulaProducts(all)).map(p=>[p.sellpia_sku_code,p]));
  const evaluator=model().createEvaluator({...registry,products,resolvedValues:context.resolvedValues});
  const assignmentSlots=new Map(registry.assignments.map(a=>[model().key(a.sku,a.target_field,a.scope),a]));
  const groups=new Map(), errors=[];
  for(const sku of targets){try{
   const p=products[sku];if(!p)throw Error('SKU 원본 없음');const component=p.__sellerPriceComponents?.[source];if(!component?.seller_product_code)throw Error('판매처 연결 없음');
   const row={sku,product:p,component,discountTerms:component.source_discount_terms||[],manual:manualIntent(p,source),...evaluator.evaluate(sku)};
   for(const kind of ['registration','discount']){
    const assignment=assignmentSlots.get(model().key(sku,'platform_'+kind+'_price',source));
    const defaultId=config.body[kind+'_rule_id'];if(assignment&&defaultId&&assignment.rule_id!==defaultId)throw Error('같은 플랫폼 단계에 SKU Rule과 판매처 Rule이 충돌합니다.');
    row[kind+'_rule_id']=assignment?.rule_id||defaultId;
    if(kind==='registration'&&row.registration_rule_id){const rule=ruleFor(registry,row.registration_rule_id,'platform_registration_price',source);let computed;
     if(assignment){computed=evaluator.evaluate(sku,'platform_registration_price',source);row.registrationValue=computed.value;}
     else{if(rule.input_origin!=='self')throw Error('상위 입력 등록 Rule은 SKU 종속관계에 연결하세요.');computed=evaluator.evaluate(sku,rule.source_field,model().isPlatform(rule.source_field)?rule.source_scope||source:'');row.registrationInput=computed.value;}
     row.versions.push(...computed.versions);
    }
   }
   const key=component.seller_product_code;if(!groups.has(key))groups.set(key,[]);groups.get(key).push(row);
  }catch(e){errors.push({sku,product_code:products[sku]?.__sellerPriceComponents?.[source]?.seller_product_code||products[sku]?.[source+'_product_code']||'',option_code:products[sku]?.__sellerPriceComponents?.[source]?.seller_option_code??products[sku]?.[source+'_option_code']??'',group_error:false,unresolved_product:!products[sku],error:e.message});}}
  const rows=[];for(const group of groups.values()){try{rows.push(...compose(group,{...config.body,source},registry));}catch(e){errors.push(...group.map(r=>({sku:r.sku,product_code:r.component.seller_product_code,option_code:r.component.seller_option_code||'',group_error:true,error:e.message})));}}
  const resolved=new Map(context.resolvedValues||[]);
  const freeze=(row,field,value)=>resolved.set(model().key(row.sku,field,source),{value,base:value,versions:row.versions,trace:[{sku:row.sku,field,value}],formula:model().fields[field]});
  for(const row of rows){freeze(row,'platform_registration_price',row.platformBase);freeze(row,'platform_discount_price',row.platformBase-row.platformDiscount);freeze(row,'platform_option_input',row.platformOption);}
  const stages=model().createEvaluator({...registry,products,resolvedValues:resolved});
  const assigned=(row,field)=>assignmentSlots.has(model().key(row.sku,field,source));
  for(const row of rows)if(row.manual.option!==undefined){row.platformOption=row.manual.option;freeze(row,'platform_option_price',row.platformOption);}else if(!assigned(row,'platform_option_price'))freeze(row,'platform_option_price',row.platformOption);
  for(const row of rows){try{
   if(row.manual.option===undefined&&assigned(row,'platform_option_price')){const value=stages.evaluate(row.sku,'platform_option_price',source);row.platformOption=value.value;row.versions.push(...value.versions);}
   freeze(row,'platform_option_price',row.platformOption);row.platformFinal=row.platformBase-row.platformDiscount+row.platformOption;freeze(row,'platform_final_input',row.platformFinal);
   if(row.manual.final!==undefined){row.platformFinal=row.manual.final;row.platformOption=row.platformFinal-(row.platformBase-row.platformDiscount);freeze(row,'platform_final_price',row.platformFinal);freeze(row,'platform_price',row.platformFinal);}
   else if(!assigned(row,'platform_final_price')&&!assigned(row,'platform_price')){freeze(row,'platform_final_price',row.platformFinal);freeze(row,'platform_price',row.platformFinal);}
  }catch(e){row.error=e.message;errors.push({sku:row.sku,product_code:row.component.seller_product_code,option_code:row.component.seller_option_code||'',group_error:false,error:e.message});}}
  // Complete every option input before traversing the final-price dependency DAG.
  for(const row of rows){if(row.error)continue;try{
   const has=field=>assigned(row,field);
   if(has('platform_final_price')&&has('platform_price'))throw Error('플랫폼 최종가 단계에 호환 Rule과 새 Rule이 충돌합니다.');
   const finalField=has('platform_final_price')?'platform_final_price':has('platform_price')?'platform_price':null;
   if(finalField&&row.manual.final===undefined){const value=stages.evaluate(row.sku,finalField,source);const option=value.value-(row.platformBase-row.platformDiscount);if(row.manual.option!==undefined&&option!==row.manual.option)throw Error('수동 옵션가와 최종가격 Rule이 충돌합니다. 수동 옵션가 또는 최종가격 Rule을 조정하세요.');row.platformFinal=value.value;row.platformOption=option;row.versions.push(...value.versions);}
   if(!Number.isSafeInteger(row.platformFinal)||row.platformFinal<0)throw Error('최종가격이 유효하지 않습니다.');freeze(row,'platform_final_price',row.platformFinal);freeze(row,'platform_price',row.platformFinal);
  }catch(e){row.error=e.message;errors.push({sku:row.sku,product_code:row.component.seller_product_code,option_code:row.component.seller_option_code||'',group_error:false,error:e.message});}}
  return {rows,errors,registry,config,requested,source};
 }
 async function exportLatest(skus,source,{fileNames=[],onProgress}={}){
  // Never reuse UI previews or fixed drafts: all five inputs are read for this generation.
  const filesBySource=await data().downloadLatestSellerOriginals([source]);
  const files=(filesBySource.get(source)||[]).filter(f=>!fileNames.length||fileNames.includes(f.name));
  if(!files.length)throw Error('선택한 최신 원본 파일이 없습니다.');
  const parsed=await g.SystemV3SellerParsers.parseSellerFiles(source,files,{price:true,discount:true});
  const result=await calculate(skus,source);
  let {items,excludedItems}=partitionExportGroups(result,parsed.normalizedRows);
  const noApplied=skipped=>{const error=Error('내보낼 수 있는 상품 묶음이 없습니다. 원본을 변경하지 않았습니다. '+skipped.slice(0,5).map(r=>r.reason).join(' / '));error.preflightFailure=true;error.skippedItems=skipped;return error;};
  if(!items.length)throw noApplied(excludedItems);
  let archive=await g.SystemV3SellerExport.buildExportArchive(new Map([[source,files]]),items,onProgress,excludedItems);
  // A serializer conflict must also roll back that entire product, rebuilding from untouched originals.
  while(true){
   const currentProducts=new Set(items.map(item=>item.seller_product_code)),currentIds=new Set(items.map(item=>item.export_item_id)),blocked=new Map();
   for(const entry of archive.skippedItems)if(currentIds.has(entry.item.export_item_id)&&currentProducts.has(entry.item.seller_product_code))blocked.set(entry.item.seller_product_code,entry.reason);
   if(!blocked.size)break;
   excludedItems.push(...items.filter(item=>blocked.has(item.seller_product_code)).map(item=>({item,export_item_id:item.export_item_id,reason:'상품 묶음 전체 제외: '+blocked.get(item.seller_product_code)})));
   items=items.filter(item=>!blocked.has(item.seller_product_code));
   if(!items.length)throw noApplied(excludedItems);
   archive=await g.SystemV3SellerExport.buildExportArchive(new Map([[source,files]]),items,onProgress,excludedItems);
  }
  if(!archive.appliedItems.length)throw noApplied(archive.skippedItems);
  const appliedSkus=new Set(archive.appliedItems.filter(i=>!i.preserve_unmapped&&i.sellpia_sku_code).map(i=>i.sellpia_sku_code));
  const versions=[...new Map(result.rows.filter(r=>appliedSkus.has(r.sku)).flatMap(r=>r.versions||[]).map(v=>[v.id,v])).values()];
  await data().workDocument('save','formula',{title:'registry-export:'+g.crypto.randomUUID(),body:{source,created_at:new Date().toISOString(),rule_versions:versions,platform_version:result.config.version||0,sku_count:appliedSkus.size,manifest:archive.manifest,skipped_count:archive.skippedItems.length,actual_items:archive.appliedItems}});
  return {...archive,calculation:result};
 }
 function partitionExportGroups(result,originalRows){
  const groups=new Map(),originals=new Map(),failures=new Map(),excludedItems=[],items=[];
  for(const row of originalRows){if(!originals.has(row.product_code))originals.set(row.product_code,[]);originals.get(row.product_code).push(row);}
  for(const row of result.rows){const product=row.component.seller_product_code;if(!groups.has(product))groups.set(product,[]);groups.get(product).push(row);}
  const rowBySku=new Map(result.rows.map(row=>[row.sku,row]));
  for(const failure of result.errors||[]){const product=failure.product_code||rowBySku.get(failure.sku)?.component.seller_product_code||'';if(!failures.has(product))failures.set(product,[]);failures.get(product).push(failure);}
  const exclude=(product,rows,errors,reason,prefix='상품 묶음 전체 제외: ')=>{
   const skus=new Map(rows.map(row=>[row.sku,row]));for(const error of errors)if(error.sku&&!skus.has(error.sku))skus.set(error.sku,null);
   for(const [sku,row] of skus)excludedItems.push({item:{sellpia_sku_code:sku,source_channel:result.source,field_key:'sellpia_sale_price',seller_product_code:product,seller_option_code:row?.component.seller_option_code??errors.find(e=>e.sku===sku)?.option_code??''},reason:prefix+reason});
  };
  for(const product of new Set([...groups.keys(),...failures.keys()])){
   const allRows=groups.get(product)||[],errors=failures.get(product)||[],failedSkus=new Set(errors.map(e=>e.sku));
   const rows=allRows.filter(row=>!row.error&&!failedSkus.has(row.sku));
   if(errors.some(e=>e.group_error)){exclude(product,allRows,errors,[...new Set(errors.map(e=>(e.sku?e.sku+': ':'')+e.error))].join(' / '));continue;}
   for(const error of errors)exclude(product,[],[error],error.error,'SKU 계산 오류: ');
   if(!rows.length)continue;
   try{
    const sourceRows=originals.get(product)||[],keys=new Set();
    for(const row of sourceRows){const key=row.option_code||'';if(keys.has(key))throw Error('원본에 동일 판매처 상품·옵션이 여러 번 있습니다: '+product+'/'+key);keys.add(key);}
    for(const error of errors)if(Object.hasOwn(error,'option_code')&&rows.some(row=>row.sku!==error.sku&&(row.component.seller_option_code||'')===error.option_code))throw Error('동일 판매처 상품·옵션에 여러 SKU가 연결되어 있습니다: '+product+'/'+error.option_code);
    items.push(...itemsFromCalculation({...result,rows},sourceRows));
   }catch(error){exclude(product,rows,[],error.message);}
  }
  items.forEach((item,index)=>{item.export_item_id=index+1;});
  excludedItems.forEach((entry,index)=>{entry.export_item_id=entry.item.export_item_id=items.length+index+1;});
  return {items,excludedItems};
 }
 function itemsFromCalculation(result,originalRows){
  const source=result.source,sourceMap=new Map(originalRows.map(r=>[JSON.stringify([r.product_code,r.option_code||'']),r]));
  const candidates=result.rows.map((r,i)=>{
   const c=r.component,s=sourceMap.get(JSON.stringify([c.seller_product_code,c.seller_option_code||'']));
   if(!s)throw Error(r.sku+': 선택 원본에서 판매처 상품·옵션을 찾지 못했습니다.');
   return {export_item_id:i+1,sellpia_sku_code:r.sku,source_channel:source,field_key:'sellpia_sale_price',seller_product_code:c.seller_product_code,seller_option_code:c.seller_option_code||'',source_file_name:s.raw_payload?.source_file_name,source_row_no:s.source_row_no,expected_source_value:s.final_price??s.price,before_value:s.final_price??s.price,after_value:r.platformFinal,base_price:s.base_price,option_price:s.option_price,target_base_price:r.platformBase,target_discounted_base_price:r.platformBase-r.platformDiscount,target_option_price:r.platformOption,target_final_price:r.platformFinal,source_discount_terms:s.discount_terms||[],target_discount_terms:r.platformTerms};
  });
  const mapped=new Map();for(const item of candidates){const key=JSON.stringify([item.seller_product_code,item.seller_option_code]);const previous=mapped.get(key);if(previous){
   if(previous.sellpia_sku_code!==item.sellpia_sku_code)throw Error('동일 판매처 상품·옵션에 여러 SKU가 연결되어 있습니다: '+key);
   if(['target_base_price','target_discounted_base_price','target_option_price','target_final_price'].some(field=>previous[field]!==item[field])||g.SystemV3SellerExport.discountTermsFingerprint(previous.target_discount_terms)!==g.SystemV3SellerExport.discountTermsFingerprint(item.target_discount_terms))throw Error('동일 SKU의 계산 결과가 서로 다릅니다: '+item.sellpia_sku_code);
   continue;
  }mapped.set(key,item);}
  const items=[...mapped.values()];
  if(source!=='ably'){
   const changedProducts=new Set(items.filter(i=>i.target_base_price!==Number(i.base_price)||g.SystemV3SellerExport.discountTermsFingerprint(i.source_discount_terms)!==g.SystemV3SellerExport.discountTermsFingerprint(i.target_discount_terms)).map(i=>i.seller_product_code));
   const productTargets=new Map(items.map(item=>[item.seller_product_code,item]));
   const productsWithOptions=new Set(originalRows.filter(r=>r.option_code).map(r=>r.product_code));
   for(const row of originalRows){
    const key=JSON.stringify([row.product_code,row.option_code||'']);
    if(!changedProducts.has(row.product_code)||mapped.has(key))continue;
    // Makeshop's blank-code parent row stores shared prices when detail options exist.
    if(source==='makeshop'&&!row.option_code&&productsWithOptions.has(row.product_code))continue;
    const target=productTargets.get(row.product_code),originalFinal=row.final_price??row.price;
    if(originalFinal===null||originalFinal===undefined||originalFinal===''||!Number.isSafeInteger(Number(originalFinal))||Number(originalFinal)<0)throw Error('미연결 옵션의 원본 최종가를 확인할 수 없습니다: '+row.product_code+'/'+(row.option_code||'기본'));
    const final=Number(originalFinal),option=final-target.target_discounted_base_price;
    if(!Number.isSafeInteger(option))throw Error('미연결 옵션의 최종가 보정값이 유효하지 않습니다: '+row.product_code+'/'+(row.option_code||'기본'));
    const preserve={export_item_id:items.length+1,sellpia_sku_code:null,preserve_unmapped:true,source_channel:source,field_key:'sellpia_sale_price',seller_product_code:row.product_code,seller_option_code:row.option_code||'',source_file_name:row.raw_payload?.source_file_name,source_row_no:row.source_row_no,expected_source_value:final,before_value:final,after_value:final,base_price:row.base_price,option_price:row.option_price,target_base_price:target.target_base_price,target_discounted_base_price:target.target_discounted_base_price,target_option_price:option,target_final_price:final,source_discount_terms:row.discount_terms||[],target_discount_terms:target.target_discount_terms};
    items.push(preserve);mapped.set(key,preserve);
   }
  }
  return items;
 }
 async function refreshExportItems(items,filesBySource){
  const registry=await data().ruleRegistry('list');let output=[...items];
  for(const source of new Set(items.map(i=>i.source_channel))){
   const platform=await settings(source);
   const applicable=new Set(registry.assignments.filter(a=>a.target_field!=='calculated_stock'&&(!a.scope||a.scope===source)).map(a=>a.sku));
   const skus=[...new Set(items.filter(i=>i.source_channel===source&&i.field_key==='sellpia_sale_price'&&(platform.id||applicable.has(i.sellpia_sku_code))).map(i=>i.sellpia_sku_code))];
   if(!skus.length)continue;
   const result=await calculate(skus,source,{registry,config:platform});if(result.errors.length)throw Error(result.errors.map(e=>e.sku+': '+e.error).join(' / '));
   const parsed=await g.SystemV3SellerParsers.parseSellerFiles(source,filesBySource.get(source)||[],{price:true,discount:true});
   const generated=itemsFromCalculation(result,parsed.normalizedRows);
   const calculatedBySku=new Map(result.rows.map(r=>[r.sku,r]));
   const original=new Map(output.filter(i=>i.source_channel===source&&i.field_key==='sellpia_sale_price').map(i=>[i.sellpia_sku_code,i]));
   const replaced=new Set(generated.map(i=>i.sellpia_sku_code));
   output=output.filter(i=>!(i.source_channel===source&&i.field_key==='sellpia_sale_price'&&replaced.has(i.sellpia_sku_code)));
   output.push(...generated.map((i,n)=>({...original.get(i.sellpia_sku_code),...i,export_item_id:original.get(i.sellpia_sku_code)?.export_item_id||-(n+1),rule_versions:calculatedBySku.get(i.sellpia_sku_code)?.versions||[]})));
  }
  return output;
 }
 async function projectRows(products){
  if(!products.length)return products;
  const [registry,documents]=await Promise.all([data().ruleRegistry('list'),data().workDocument('list','formula')]);
  const configured=new Set(documents.filter(d=>d.title?.startsWith('registry-platform:')).map(d=>d.title.slice('registry-platform:'.length)));
  const internal=new Map(),resolvedValues=new Map(),names=new Map(registry.rules.map(r=>[r.id,r.name]));
  const internalNames=new Map();
  for(const a of registry.assignments)if(!a.scope&&['actual_inbound_cost','basis_sku_price','calculated_base_price'].includes(a.target_field)){
   if(!internalNames.has(a.sku))internalNames.set(a.sku,new Set());if(names.get(a.rule_id))internalNames.get(a.sku).add(names.get(a.rule_id));
  }
  const internalSkus=new Set(internalNames.keys());
  const internalTargets=products.filter(p=>internalSkus.has(p.sellpia_sku_code)).map(p=>p.sellpia_sku_code);
  if(internalTargets.length){
   const fallbackNames=sku=>[...(internalNames.get(sku)||[])];
   try{
    const all=model().expandSkus(internalTargets,registry.dependencies,false,{maxSkus:50000});
    const inputs=Object.fromEntries((await data().loadFormulaProducts(all)).map(p=>[p.sellpia_sku_code,p]));
    const evaluator=model().createEvaluator({...registry,products:inputs});
    for(const sku of internalTargets){try{
     const value=evaluator.evaluate(sku,'calculated_base_price');
     internal.set(sku,{calculated_base_price:{...value,ruleNames:[...new Set(value.versions.map(v=>names.get(v.id)).filter(Boolean))]}});
     resolvedValues.set(model().key(sku,'calculated_base_price',''),value);
    }catch(error){internal.set(sku,{calculated_base_price:{error:error.message,ruleNames:fallbackNames(sku),versions:[]}});}}
   }catch(error){for(const sku of internalTargets)internal.set(sku,{calculated_base_price:{error:error.message,ruleNames:fallbackNames(sku),versions:[]}});}
  }
  const projections=new Map();
  for(const source of ['smartstore','makeshop','ably']){
   const applicable=new Set(registry.assignments.filter(a=>a.target_field!=='calculated_stock'&&(!a.scope||a.scope===source)).map(a=>a.sku));
   const selected=products.filter(p=>(p.__sellerPriceComponents?.[source]?.seller_product_code||p[source+'_product_code'])&&(configured.has(source)||applicable.has(p.sellpia_sku_code)));
   if(!selected.length)continue;
   const set=(sku,value)=>{if(!projections.has(sku))projections.set(sku,{});projections.get(sku)[source]=value;};
   try{
    const document=documents.find(d=>d.title==='registry-platform:'+source);
    const config=document?await data().workDocument('get','formula',{id:document.id}):{body:{source,mode:'reverse',anchor:'lowest',registration_rule_id:null,discount_rule_id:null}};
    const result=await calculate(selected.map(p=>p.sellpia_sku_code),source,{registry,config,resolvedValues});
    const names=new Map(result.registry.rules.map(r=>[r.id,r.name]));
    for(const row of result.rows){const {product,component,...projection}=row;set(row.sku,{...projection,ruleNames:[...new Set((row.versions||[]).map(v=>names.get(v.id)).filter(Boolean))]});}
    for(const failure of result.errors)set(failure.sku,{error:failure.error,ruleNames:[],versions:[]});
   }catch(error){for(const p of selected)set(p.sellpia_sku_code,{error:error.message,ruleNames:[],versions:[]});}
  }
  return products.map(p=>{
   const sku=p.sellpia_sku_code;
   if(!projections.has(sku)&&!internal.has(sku)&&!p.__hubRulePrices&&!p.__hubInternalPrices)return p;
   const {__hubRulePrices:oldPlatform,__hubInternalPrices:oldInternal,...row}=p;
   if(projections.has(sku))row.__hubRulePrices=projections.get(sku);
   if(internal.has(sku))row.__hubInternalPrices=internal.get(sku);
   return row;
  });
 }
 g.HubPlatformRules={compose,settings,calculate,exportLatest,refreshExportItems,itemsFromCalculation,partitionExportGroups,manualIntent,projectRows};
})(typeof window==='undefined'?globalThis:window);
