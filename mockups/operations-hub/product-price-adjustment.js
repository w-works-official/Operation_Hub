(function initProductPriceAdjustment(global) {
 'use strict';
 const source='smartstore',keys=['basic','mobile','reservation','multi_buy'];
 const compare=(a,b)=>a<b?-1:a>b?1:0;
 function canonical(value,seen=new Set()) {
  if(value===undefined||value===null)return null;
  if(typeof value==='string'||typeof value==='boolean')return value;
  if(typeof value==='number'&&Number.isFinite(value))return value;
  if(typeof value!=='object'||seen.has(value))throw Error('상품 가격 조정 증거를 읽을 수 없습니다.');
  seen.add(value);
  let result;
  if(value instanceof Map)result=[...value].map(([key,item])=>[canonical(key,seen),canonical(item,seen)]).sort((a,b)=>compare(JSON.stringify(a[0]),JSON.stringify(b[0])));
  else if(Array.isArray(value))result=value.map(item=>canonical(item,seen));
  else result=Object.fromEntries(Object.keys(value).sort(compare).map(key=>[key,canonical(value[key],seen)]));
  seen.delete(value);return result;
 }
 const proof=value=>JSON.stringify(canonical(value));
 function clone(value,seen=new Set()) {
  if(value===null||typeof value!=='object')return value;
  if(seen.has(value))throw Error('상품 가격 조정 원본에 순환 참조가 있습니다.');
  seen.add(value);
  const result=value instanceof Map?new Map([...value].map(([key,item])=>[clone(key,seen),clone(item,seen)]))
   :Array.isArray(value)?value.map(item=>clone(item,seen)):Object.fromEntries(Object.keys(value).map(key=>[key,clone(value[key],seen)]));
  seen.delete(value);return result;
 }
 const clean=value=>String(value??'').trim();
 function code(value,label) {
  if(typeof value!=='string'||!value.trim()||value!==value.trim())throw Error(`${label}를 확인해주세요.`);
  return value;
 }
 function integer(value,label,{signed=false}={}) {
  if(typeof value==='string'){
   if(!(signed?/^-?\d+$/:/^\d+$/).test(value))throw Error(`${label}는 ${signed?'':'0원 이상 '}정수여야 합니다.`);
   value=Number(value);
  }
  if(typeof value!=='number'||!Number.isSafeInteger(value)||(!signed&&value<0))throw Error(`${label}는 안전한 ${signed?'':'0원 이상 '}정수여야 합니다.`);
  return value;
 }
 function math() {
  const api=global.SystemV3DiscountPriceMath;
  if(typeof api?.discountedBase!=='function')throw Error('할인 가격 계산 모듈이 없습니다.');
  return api;
 }
 function termFingerprint(terms) {return proof([...terms].sort((a,b)=>compare(a.term_key,b.term_key)));}
 function unit(value) {
  const text=clean(value).toLowerCase();
  if(text==='원'||text==='amount')return 'amount';
  if(text==='%'||text==='percent')return 'percent';
  return null;
 }
 function readTerms(row,productCode) {
  if(!Array.isArray(row.discount_terms))throw Error(`${productCode}: 판매처 원본 할인조건을 읽지 못했습니다.`);
  const terms=row.discount_terms,byKey=new Map();
  for(const term of terms){
   if(!term||typeof term!=='object'||Array.isArray(term)||!keys.includes(term.term_key)||byKey.has(term.term_key))throw Error(`${productCode}: 알 수 없거나 중복된 할인조건은 수정할 수 없습니다.`);
   if(term.is_baseline!==(term.term_key==='basic'))throw Error(`${productCode}: 기본할인 외의 기준 할인조건은 수정할 수 없습니다.`);
   for(const flag of ['active','is_active','writable','is_writable'])if(Object.hasOwn(term,flag)&&typeof term[flag]!=='boolean')throw Error(`${productCode}: 할인조건의 활성·수정 권한을 확인할 수 없습니다.`);
   if(!['amount','percent'].includes(term.unit)||typeof term.value!=='number'||!Number.isFinite(term.value)||term.value<0||term.unit==='amount'&&!Number.isSafeInteger(term.value)||term.unit==='percent'&&term.value>100)throw Error(`${productCode}: 원본 할인금액·할인단위를 읽을 수 없습니다.`);
   // Smartstore's carrier encodes amounts/percentages, without rounding cells.
   // The real parser always projects nearest/1; another rule is not writable.
   if(term.rounding_mode!=='nearest'||term.rounding_unit!==1)throw Error(`${productCode}: 판매처 원본의 할인 반올림 규칙을 안전하게 보존할 수 없습니다.`);
   if(term.term_key==='basic'&&[term.active,term.is_active,term.writable,term.is_writable].some(value=>value===false))throw Error(`${productCode}: 비활성 또는 읽기 전용 기본할인은 수정할 수 없습니다.`);
   byKey.set(term.term_key,term);
  }
  const raw=row.raw_payload;
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error(`${productCode}: 판매처 원본 할인정보를 읽지 못했습니다.`);
  for(const key of keys){
   const valueKey=`smartstore_${key}_discount_value`,unitKey=`smartstore_${key}_discount_unit`;
   if(!Object.hasOwn(raw,valueKey)||!Object.hasOwn(raw,unitKey))throw Error(`${productCode}: 판매처 원본 ${key} 할인정보를 읽지 못했습니다.`);
   const hasValue=clean(raw[valueKey])!=='',hasUnit=clean(raw[unitKey])!=='';
   const term=byKey.get(key);
   if(hasValue!==hasUnit||hasValue!==Boolean(term))throw Error(`${productCode}: 판매처 원본 ${key} 할인정보가 불완전합니다.`);
   if(term){
    const rawValue=typeof raw[valueKey]==='number'?raw[valueKey]:Number(clean(raw[valueKey]).replace(/,/g,''));
    if(!Number.isFinite(rawValue)||rawValue!==term.value||unit(raw[unitKey])!==term.unit)throw Error(`${productCode}: 원본 ${key} 할인정보와 계산 조건이 다릅니다.`);
   }
  }
  return {terms:clone(terms),basic:byKey.get('basic')||null};
 }
 function context(group) {
  if(!group||group.source!==source)throw Error('상품별 기준가·기본할인 조정은 스마트스토어만 지원합니다.');
  const productCode=code(group.productCode,'판매처 상품코드');
  if(group.blockedReason||group.mappingAmbiguous)throw Error(clean(group.blockedReason)||`${productCode}: 상품 연결이 모호합니다.`);
  if(!Array.isArray(group.rows)||!group.rows.length)throw Error(`${productCode}: 전체 형제 옵션 원본이 필요합니다.`);
  const seen=new Set(),entries=[];let basePrice,discountedBase,sharedTerms,basic=null,minFinal=Infinity,maxFinal=-Infinity;
  for(const entry of group.rows){
   const row=entry?.row;
   if(!row||typeof row!=='object'||Array.isArray(row)||clean(row.product_code)!==productCode)throw Error(`${productCode}: 원본 상품 identity가 다릅니다.`);
   if(entry.blockedReason||entry.mappingAmbiguous||row.mapping_blocked||row.mapping_valid===false)throw Error(clean(entry.blockedReason)||`${productCode}: 여러 SKU 또는 유효하지 않은 연결은 수정할 수 없습니다.`);
   const optionCode=clean(row.option_code),identity=proof([productCode,optionCode]);
   if(seen.has(identity))throw Error(`${productCode}/${optionCode}: 판매처 원본 상품·옵션 identity가 중복됩니다.`);
   seen.add(identity);
   const rowNo=integer(row.source_row_no,'원본 행 위치');
   if(rowNo<1||!clean(row.raw_payload?.source_file_name||row.source_file_name))throw Error(`${productCode}: 원본 파일·행 위치를 확인할 수 없습니다.`);
   const originalBase=integer(row.base_price,'원본 기준가'),originalDiscounted=integer(row.discounted_base_price,'원본 할인 적용가');
   const originalOption=integer(row.option_price,'원본 옵션가',{signed:true}),originalFinal=integer(row.final_price,'원본 최종가');
   const read=readTerms(row,productCode);
   if(math().discountedBase(originalBase,read.terms)!==originalDiscounted||originalDiscounted+originalOption!==originalFinal)throw Error(`${productCode}/${optionCode}: 원본 기준가·할인·옵션·최종가가 일치하지 않습니다.`);
   if(basePrice===undefined){basePrice=originalBase;discountedBase=originalDiscounted;sharedTerms=read.terms;basic=read.basic;}
   else if(basePrice!==originalBase||discountedBase!==originalDiscounted||termFingerprint(sharedTerms)!==termFingerprint(read.terms))throw Error(`${productCode}: 같은 상품의 기준가·할인조건이 옵션별로 다릅니다.`);
   const final=integer(entry.final,'확정 목표 최종가');
   minFinal=Math.min(minFinal,final);maxFinal=Math.max(maxFinal,final);
   entries.push({row:clone(row),final,proof:clone(entry.proof),identity});
  }
  const basicDiscount=basic?.unit==='amount'?basic.value:basePrice-discountedBase;
  const hasOptions=entries.some(entry=>clean(entry.row.option_code)!=='');
  if(hasOptions&&entries.some(entry=>clean(entry.row.option_code)===''))throw Error(`${productCode}: 옵션 상품과 옵션 없는 원본 행이 혼재되어 있습니다.`);
  return {source,productCode,entries,basePrice,basicDiscount,discountedBase,terms:sharedTerms,basic:clone(basic),minFinal,maxFinal,hasOptions};
 }
 function normalizeDraft(ctx,draft) {
  if(!draft||draft.source!==source||draft.productCode!==ctx.productCode)throw Error('상품별 가격 조정의 판매처·상품코드가 현재 상품과 다릅니다.');
  if(Object.keys(draft).some(key=>!['source','productCode','basePrice','basicDiscount'].includes(key)))throw Error('상품별 가격 조정에는 기준가와 기본할인 금액만 입력할 수 있습니다.');
  const basePrice=integer(draft.basePrice,'기준가'),basicDiscount=integer(draft.basicDiscount,'기본할인 금액');
  if(basicDiscount>basePrice)throw Error('기본할인 금액은 기준가를 초과할 수 없습니다.');
  return {source,productCode:ctx.productCode,basePrice,basicDiscount};
 }
 function targetTerms(ctx,basicDiscount) {
  const terms=clone(ctx.terms).filter(term=>term.term_key!=='basic');
  if(basicDiscount>0){
   const basic=ctx.basic?{...clone(ctx.basic),value:basicDiscount,unit:'amount'}:{term_key:'basic',term_type:'basic',value:basicDiscount,unit:'amount',rounding_mode:'nearest',rounding_unit:1,is_baseline:true,title:'즉시할인 기본할인'};
   const oldIndex=ctx.terms.findIndex(term=>term.term_key==='basic');terms.splice(oldIndex<0?0:oldIndex,0,basic);
  }
  return terms;
 }
 const optionLimit=basePrice=>Math.floor((basePrice*0.5)/10)*10;
 function build(ctx,draft,{preview=false}={}) {
  const normalized=normalizeDraft(ctx,draft),terms=targetTerms(ctx,normalized.basicDiscount),discountedBase=math().discountedBase(normalized.basePrice,terms);
  if(!Number.isSafeInteger(discountedBase)||discountedBase<0)throw Error('조정한 기준가와 기본할인으로 할인 적용가를 확인할 수 없습니다.');
  const limit=optionLimit(normalized.basePrice),errors=[];
  const rows=ctx.entries.map(entry=>{
   const option=entry.final-discountedBase;
   const error=!Number.isSafeInteger(option)||option < -limit||option > limit||discountedBase+option!==entry.final?`${ctx.productCode}/${clean(entry.row.option_code)}: 옵션가가 기준가의 ±50%·10원 단위 허용범위를 초과합니다.`
    :ctx.hasOptions&&normalized.basePrice<2000&&option<0?`${ctx.productCode}/${clean(entry.row.option_code)}: 기준가 2,000원 미만에서는 음수 옵션가를 사용할 수 없습니다.`:null;
   if(error){if(!preview)throw Error(error);errors.push(error);}
   return {row:clone(entry.row),final:entry.final,option,optionPrice:option,proof:clone(entry.proof),...(error?{valid:false,error}:{} )};
  });
  const sharedError=ctx.hasOptions&&!rows.some(row=>row.option===0)?`${ctx.productCode}: 추가금 0원인 옵션이 1개 이상 필요합니다.`
   :!ctx.hasOptions&&(rows.length!==1||rows[0].option!==0)?`${ctx.productCode}: 옵션 없는 상품의 할인 적용가는 확정 최종가와 같아야 합니다.`:null;
  if(sharedError){if(!preview)throw Error(sharedError);errors.push(sharedError);}
  const result={valid:errors.length===0,editable:true,errors,draft:normalized,discountedBase,discountedBasePrice:discountedBase,terms,rows};
  if(result.valid)result.proof=proof({contract_version:1,draft:normalized,discounted_base:discountedBase,terms,
   rows:rows.map(row=>({original:row.row,final:row.final,option:row.option,proof:row.proof})).sort((a,b)=>compare(proof([a.original.product_code,clean(a.original.option_code)]),proof([b.original.product_code,clean(b.original.option_code)])))});
  return result;
 }
 function recommended(ctx) {
  // The shared discounted anchor must itself be one of the fixed final prices:
  // Smartstore requires at least one zero-price option. Never invent a midpoint
  // that would keep the range valid but leave every option nonzero.
  const middle=ctx.minFinal+Math.floor((ctx.maxFinal-ctx.minFinal)/2);
  const candidates=[...new Set(ctx.entries.map(entry=>entry.final))].sort((a,b)=>a-b);
  let anchor=candidates[0];
  for(const value of candidates)if(Math.abs(value-middle)<Math.abs(anchor-middle))anchor=value;
  const maximum=Math.max(anchor-ctx.minFinal,ctx.maxFinal-anchor),required=Math.ceil(maximum/10)*20;
  if(!Number.isSafeInteger(required))throw Error('전체 옵션의 최종가를 유지할 기준가를 안전하게 추천할 수 없습니다.');
  let base=Math.max(ctx.basePrice,anchor,required,ctx.hasOptions&&ctx.minFinal<anchor?2000:0);
  const rounded=Math.ceil(base/100)*100;if(Number.isSafeInteger(rounded))base=rounded;
  const draft={source,productCode:ctx.productCode,basePrice:base,basicDiscount:base-anchor};
  build(ctx,draft);return draft;
 }
 function plan(group) {return build(context(group),group.draft);}
 function validate(group,draft) {
  try{return build(context(group),draft,{preview:true});}catch(error){return {valid:false,editable:false,errors:[error.message],blockedReason:error.message,reason:error.message};}
 }
 function analyze(group) {
  try{
   const ctx=context(group),current={basePrice:ctx.basePrice,basicDiscount:ctx.basicDiscount,discountedBase:ctx.discountedBase,terms:clone(ctx.terms)};
   let currentValid=true;try{build(ctx,{source,productCode:ctx.productCode,basePrice:ctx.basePrice,basicDiscount:ctx.basicDiscount});}catch(_){currentValid=false;}
   let recommendedDraft=null,recommendationReason='';try{recommendedDraft=recommended(ctx);}catch(error){recommendationReason=error.message;}
   return {valid:true,editable:true,errors:[],blockedReason:null,reason:recommendationReason,needsAdjustment:!currentValid,source,productCode:ctx.productCode,current,
    currentBasePrice:ctx.basePrice,currentBasicDiscount:ctx.basicDiscount,discountedBasePrice:ctx.discountedBase,minFinal:ctx.minFinal,maxFinal:ctx.maxFinal,optionCount:ctx.entries.length,recommendedDraft};
  }catch(error){return {valid:false,editable:false,errors:[error.message],blockedReason:error.message,reason:error.message,needsAdjustment:false,current:null,recommendedDraft:null};}
 }
 function recommend(group) {
  try{const ctx=context(group),draft=recommended(ctx);return {...build(ctx,draft),recommendedDraft:draft};}
  catch(error){return {valid:false,editable:false,errors:[error.message],blockedReason:error.message,reason:error.message,draft:null,recommendedDraft:null};}
 }
 function basePriceOptions(group,options={}) {
  const empty={valid:false,editable:false,basicDiscount:null,discrete:true,allowedBasePrices:[],candidates:[],minBasePrice:null,maxBasePrice:null};
  let ctx,basicDiscount;
  try{ctx=context(group);}catch(error){return {...empty,reason:'이 상품의 판매가 후보를 계산할 수 없습니다.',blockedReason:error.message,issues:[{code:'PRODUCT_NOT_EDITABLE',message:error.message}]};}
  try{
   if(!options||typeof options!=='object'||Array.isArray(options)||Object.keys(options).some(key=>key!=='basicDiscount'))throw Error('고정할 기본할인 금액을 확인해주세요.');
   basicDiscount=integer(Object.hasOwn(options,'basicDiscount')?options.basicDiscount:ctx.basicDiscount,'기본할인 금액');
  }catch(error){return {...empty,reason:'기본할인을 0원 이상 정수로 입력해주세요.',issues:[{code:'INVALID_BASIC_DISCOUNT',message:error.message}]};}
  // With C fixed, the zero-option contract requires B-C to equal a fixed final.
  // The complete set is therefore discrete: B=C+F. Its extrema are labels only;
  // a price between them is not implicitly allowed. Check the extreme finals to
  // cover every sibling in O(n log n), without rebuilding n rows per candidate.
  const allowed=[],rejections=new Set();
  for(const anchor of [...new Set(ctx.entries.map(entry=>entry.final))].sort((a,b)=>a-b)){
   const basePrice=anchor+basicDiscount;
   if(!Number.isSafeInteger(basePrice)){rejections.add('UNSAFE_BASE_PRICE');continue;}
   if(Math.max(anchor-ctx.minFinal,ctx.maxFinal-anchor)>optionLimit(basePrice)){rejections.add('OPTION_BOUNDS');continue;}
   if(ctx.hasOptions&&basePrice<2000&&ctx.minFinal<anchor){rejections.add('NEGATIVE_OPTION_BELOW_2000');continue;}
   allowed.push(basePrice);
  }
  const valid=allowed.length>0;
  const messages={UNSAFE_BASE_PRICE:'목표가와 기본할인의 합이 안전한 정수 범위를 초과합니다.',OPTION_BOUNDS:'전체 옵션가가 판매가의 허용범위에 들어야 합니다.',NEGATIVE_OPTION_BELOW_2000:'판매가 2,000원 미만에서는 음수 옵션가를 사용할 수 없습니다.'};
  return {valid,editable:true,basicDiscount,discrete:true,allowedBasePrices:allowed,candidates:[...allowed],minBasePrice:allowed[0]??null,maxBasePrice:allowed.at(-1)??null,
   reason:valid?'':'현재 할인액으로 가능한 판매가가 없습니다.',issues:valid?[]:[{code:'NO_ALLOWED_BASE_PRICE',message:'고정 최종가와 현재 기본할인을 유지할 수 있는 판매가 후보가 없습니다.'},...[...rejections].sort(compare).map(code=>({code,message:messages[code]}))]};
 }
 global.HubProductPriceAdjustment=Object.freeze({analyze,inspect:analyze,validate,recommend,plan,basePriceOptions,priceRange:basePriceOptions});
})(typeof window==='undefined'?globalThis:window);
