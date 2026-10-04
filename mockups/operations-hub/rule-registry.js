(function(g){
 'use strict';
 const fields={purchase_price:'셀피아 매입가',source_base_price:'셀피아 기준가격',actual_inbound_cost:'실입고가',basis_sku_price:'이전 계산 결과',calculated_base_price:'시스템 기준가격',system_stock:'시스템 현재재고',calculated_stock:'계산 재고',platform_registration_price:'판매처 등록가',platform_option_price:'판매처 옵션가',platform_discount_price:'할인 적용 후 등록가',platform_final_price:'판매처 최종가',platform_price:'판매처 가격 · 구형 호환',platform_option_input:'옵션가 계산 입력값 · 고급',platform_final_input:'최종가 계산 입력값 · 고급'};
 const platformTargets=['platform_registration_price','platform_option_price','platform_discount_price','platform_final_price','platform_price'];
 const platformFields=[...platformTargets,'platform_option_input','platform_final_input'];
 const targets=['actual_inbound_cost','basis_sku_price','calculated_base_price','calculated_stock',...platformTargets];
 const raw={purchase_price:'sellpia_source_purchase_price',source_base_price:'sellpia_source_sale_price',actual_inbound_cost:'actual_inbound_cost',basis_sku_price:'system_base_price',calculated_base_price:'system_base_price',system_stock:'system_stock',calculated_stock:'system_stock'};
 fields.representative_base_price='상품 대표 기준가';
 const key=(sku,field,scope='')=>JSON.stringify([sku,field,scope||'']);
 const isPlatform=field=>platformFields.includes(field);
 const validScope=scope=>['ably','smartstore','makeshop'].includes(scope);
 const makeshopDiscountCatalog={NONE:{label:'기간할인 없음',steps:[]},M10:{label:'10% · 10원 절사',steps:[{op:'multiply',value:.9},{op:'round',unit:10,rounding:'down'}]},M15:{label:'15% · 10원 절사',steps:[{op:'multiply',value:.85},{op:'round',unit:10,rounding:'down'}]},M20:{label:'20% · 100원 절사',steps:[{op:'multiply',value:.8},{op:'round',unit:100,rounding:'down'}]}};
 const makeshopDiscountConfig=code=>{const key=String(code||'').toUpperCase(),entry=makeshopDiscountCatalog[key];if(!entry)throw Error('메이크샵 할인코드는 NONE, M10, M15, M20 중 하나여야 합니다.');return {discount_mode:'makeshop_code',discount_rule_code:key,steps:structuredClone(entry.steps)};};
 function numeric(value,label){if(value===null||value===undefined||value===''||typeof value==='boolean'||!Number.isFinite(Number(value)))throw Error(label+' 없음');return Number(value);}
 function parseSteps(text){return String(text).split(/[\n;]/).map(s=>s.trim()).filter(Boolean).map(s=>{
  const round=s.match(/^round\s+(up|down|nearest)\s+(\d+)$/i);
  if(round){const step={op:'round',unit:Number(round[2]),rounding:round[1].toLowerCase()};validateStep(step);return step;}
  const m=s.match(/^([+\-*/=])\s*(-?\d+(?:\.\d+)?)$/);if(!m)throw Error('연산은 +2000, -300, *3, /2, =5000 또는 round up 100 형식으로 입력하세요.');
  const step={op:{'+':'add','-':'subtract','*':'multiply','/':'divide','=':'set'}[m[1]],value:Number(m[2])};validateStep(step);return step;
 });}
 const stepsText=steps=>(steps||[]).map(s=>s.op==='round'?`round ${s.rounding} ${s.unit}`:({add:'+',subtract:'-',multiply:'*',divide:'/',set:'='}[s.op])+s.value).join('\n');
 function validateStep(s){
  if(!s||typeof s!=='object')throw Error('연산 값 오류');
  if(s.op==='round'){if(!Number.isSafeInteger(s.unit)||s.unit<1||!['up','down','nearest'].includes(s.rounding))throw Error('끝자리 처리 오류');}
  else if(!['add','subtract','multiply','divide','set'].includes(s.op)||!Number.isFinite(s.value)||(s.op==='divide'&&s.value===0))throw Error('연산 값 오류');
 }
 function validateConfig(c){
  if(!c||typeof c!=='object'||Array.isArray(c)||!Array.isArray(c.steps)||c.steps.length>20)throw Error('연산은 최대 20개 배열이어야 합니다.');
  c.steps.forEach(validateStep);
  // Legacy terminal rounding is applied only when explicitly present.
  if(c.unit!=null||c.rounding!=null){const unit=numeric(c.unit??1,'끝자리 단위');if(unit<1||!Number.isSafeInteger(unit)||!['up','down','nearest'].includes(c.rounding||'nearest'))throw Error('끝자리 처리 오류');}
  for(const name of ['min','max'])if(c[name]!==''&&c[name]!=null&&(!Number.isFinite(Number(c[name]))||typeof c[name]==='boolean'||Number(c[name])<0))throw Error('가격 범위 오류');
  if(c.min!==''&&c.min!=null&&c.max!==''&&c.max!=null&&Number(c.min)>Number(c.max))throw Error('최저값이 최고값보다 큽니다.');
  return c;
 }
 function validateRule(rule){
  if(!rule||!targets.includes(rule.target_field))throw Error('적용 항목을 선택하세요.');
  if(!Object.hasOwn(fields,rule.source_field))throw Error('참조 항목을 선택하세요.');
  if(!['self','parent'].includes(rule.input_origin))throw Error('참조 위치를 선택하세요.');
  if(isPlatform(rule.target_field)?!validScope(rule.scope):!!rule.scope)throw Error('적용 판매처를 확인하세요.');
  if(isPlatform(rule.source_field)?!validScope(rule.source_scope||rule.scope):!!rule.source_scope)throw Error('참조 판매처를 확인하세요.');
  if(rule.source_field==='representative_base_price'&&(rule.target_field!=='platform_registration_price'||rule.input_origin!=='self'||!validScope(rule.scope)))throw Error('상품 대표가는 해당 SKU의 판매처 등록가 수식에서 명시적으로 선택하세요.');
  if(rule.target_field==='platform_discount_price'){
   if(!validScope(rule.scope))throw Error('할인 수식 태그의 저장 판매처를 선택하세요.');
   if(rule.input_origin!=='self'||rule.source_field!=='platform_registration_price'||!['',rule.scope].includes(rule.source_scope||''))throw Error('할인 수식 태그는 같은 판매처의 등록가격에서 시작해야 합니다.');
   if(rule.scope==='makeshop'){
    const expected=makeshopDiscountConfig(rule.config?.discount_rule_code);
    if(rule.config?.discount_mode!=='makeshop_code'||JSON.stringify(rule.config.steps)!==JSON.stringify(expected.steps)||['min','max','unit','rounding'].some(key=>rule.config[key]!==undefined&&rule.config[key]!==null&&rule.config[key]!==''))throw Error('메이크샵 할인은 저장된 할인코드와 해당 코드의 계산 방식으로만 설정할 수 있습니다.');
   }else if(rule.config?.discount_rule_code!=null||!['',null,undefined,'numeric'].includes(rule.config?.discount_mode))throw Error('스마트스토어·에이블리 할인에는 메이크샵 할인코드를 사용할 수 없습니다.');
  }
  validateConfig(rule.config);return rule;
 }
 // Price Rule numbers are decimal facts. Keep exact fractions through ordered
 // arithmetic so a binary float just above 93,500 cannot ceil to 94,000.
 function fraction(value){
  const [mantissa,exponent='0']=String(value).toLowerCase().split('e');const sign=mantissa.startsWith('-')?-1n:1n;
  const [whole,decimal='']=mantissa.replace(/^[+-]/,'').split('.');const scale=decimal.length-Number(exponent);
  return reduced(sign*BigInt(whole+decimal)*(scale<0?10n**BigInt(-scale):1n),scale>0?10n**BigInt(scale):1n);
 }
 function reduced(n,d){if(d<0n){n=-n;d=-d;}let a=n<0n?-n:n,b=d;while(b){const t=a%b;a=b;b=t;}return {n:n/(a||1n),d:d/(a||1n)};}
 const plus=(a,b)=>reduced(a.n*b.d+b.n*a.d,a.d*b.d);
 const times=(a,b)=>reduced(a.n*b.n,a.d*b.d);
 const compare=(a,b)=>a.n*b.d-b.n*a.d;
 function rounded(value,unit,mode){
  const q=reduced(value.n*unit.d,value.d*unit.n);let whole=q.n/q.d,rest=q.n%q.d;
  if(mode==='up'&&rest>0n)whole++;
  if(mode==='down'&&rest<0n)whole--;
  if(mode==='nearest'){if(rest<0n){whole--;rest+=q.d;}if(rest*2n>=q.d)whole++;}
  return times({n:whole,d:1n},unit);
 }
 function transformFraction(base,config){
  let value=fraction(base);
  for(const step of config.steps){const n=step.op==='round'?null:fraction(step.value);switch(step.op){case 'add':value=plus(value,n);break;case 'subtract':value=plus(value,{n:-n.n,d:n.d});break;case 'multiply':value=times(value,n);break;case 'divide':value=times(value,{n:n.d,d:n.n});break;case 'set':value=n;break;case 'round':value=rounded(value,fraction(step.unit),step.rounding);break;}}
  if(config.min!==''&&config.min!=null){const min=fraction(Number(config.min));if(compare(value,min)<0n)value=min;}
  if(config.max!==''&&config.max!=null){const max=fraction(Number(config.max));if(compare(value,max)>0n)value=max;}
  if(config.unit!=null||config.rounding!=null)value=rounded(value,fraction(Number(config.unit??1)),config.rounding||'nearest');
  return value;
 }
 function transformValue(base,config){const value=transformFraction(base,config);return Number(value.n)/Number(value.d);}
 function transform(base,config,{allowNegative=false,roundToWon=false}={}){
  validateConfig(config);const input=numeric(base,'기준값');
  const exact=roundToWon?rounded(transformFraction(input,config),fraction(1),'nearest'):null;
  const value=roundToWon?Number(exact.n)/Number(exact.d):transformValue(input,config);
  if(!Number.isSafeInteger(value)||!allowNegative&&value<0)throw Error(allowNegative?'계산값은 안전한 정수여야 합니다.':'계산값은 0 이상의 안전한 정수여야 합니다.');return value;
 }
 function inverse(value,config){
  validateConfig(config);const target=numeric(value,'역산값');
  if(!Number.isSafeInteger(target)||target<0)throw Error('역산값은 0 이상의 안전한 정수여야 합니다.');
  let direction=1;
  for(const step of config.steps){
   if(step.op==='set'||step.op==='multiply'&&step.value===0)throw Error('고정값 연산은 원본이 정해지지 않아 자동 역산할 수 없습니다.');
   if((step.op==='multiply'||step.op==='divide')&&step.value<0)direction*=-1;
  }
  // Arithmetic, ordered rounding and clamps are monotone. Find the smallest
  // integer input in the matching plateau, then verify by the forward engine.
  let low=0,high=Number.MAX_SAFE_INTEGER;
  while(low<high){
   const mid=low+Math.floor((high-low)/2),result=transformValue(mid,config);
   if(Number.isNaN(result))throw Error('연산 범위를 초과해 역산할 수 없습니다.');
   if(direction>0?result>=target:result<=target)high=mid;else low=mid+1;
  }
  try {if(transform(low,config)===target)return low;}catch{}
  throw Error('요청 가격과 일치하는 정수 원본을 찾지 못했습니다.');
 }
 function createEvaluator({products={},rules=[],assignments=[],dependencies=[],legacyCalculate,resolvedValues=new Map()}={}){
  const registry=new Map(),slots=new Map(),refs=new Map(),cache=new Map();
  for(const r of rules){if(registry.has(r.id))throw Error('중복 규칙 ID');registry.set(r.id,r);}
  for(const d of dependencies){const k=key(d.child_sku,d.target_field,d.scope);if(refs.has(k))throw Error(d.child_sku+': 같은 항목에 상위 참조가 여러 개입니다.');refs.set(k,d);}
  for(const a of assignments){const k=key(a.sku,a.target_field,a.scope);if(slots.has(k))throw Error(a.sku+': 같은 항목에 규칙이 여러 개입니다.');slots.set(k,a);}
  function evaluate(sku,field='calculated_base_price',scope='',stack=[]){
   if(!Object.hasOwn(fields,field))throw Error('알 수 없는 가격 단계');
   const k=key(sku,field,scope);if(stack.includes(k)||stack.length>=64)throw Error('필드 참조 순환 또는 64단계 초과: '+[...stack,k].join(' → '));
   const resolved=resolvedValues instanceof Map?resolvedValues.get(k):Object.hasOwn(resolvedValues,k)?resolvedValues[k]:undefined;
   if(resolved!==undefined){const value=numeric(resolved.value,'완료 단계 계산값');if(!Number.isSafeInteger(value)||value<0&&!['platform_option_price','platform_option_input'].includes(field))throw Error('완료 단계 계산값 오류');return {...resolved,value,base:resolved.base??value,versions:resolved.versions||[],trace:resolved.trace||[{sku,field,scope,value}],formula:resolved.formula||fields[field]};}
   if(cache.has(k))return cache.get(k);
   const p=products instanceof Map?products.get(sku):Object.hasOwn(products,sku)?products[sku]:null;if(!p)throw Error(sku+' 원본 없음');const assignment=slots.get(k);
   if(!assignment){
    if(field==='representative_base_price'){
     const r=p.__hubRepresentativePrice;
     if(!r||r.status!=='calculated'||r.freshness!=='fresh'||!r.rule?.rule_id||!r.input_fingerprint)throw Error(sku+': 상품 대표가가 없거나 재계산/입력 확인이 필요합니다.');
     const value=numeric(r.value,'상품 대표가');if(!Number.isSafeInteger(value)||value<0)throw Error('상품 대표가 오류');
     const result={value,base:value,versions:[{id:r.rule.rule_id,version:r.rule.rule_version,assignmentVersion:r.rule.version}],trace:[{sku,field,value,product_identity:r.product_identity,input_fingerprint:r.input_fingerprint,contributors:r.contributors,selected_options:r.selected_options}],formula:r.rule.tag_name||'상품 대표가'};
     cache.set(k,result);return result;
    }
    if(isPlatform(field))throw Error(sku+': 판매처 가격 규칙 미배정');
    const upstream=field==='basis_sku_price'&&slots.has(key(sku,'actual_inbound_cost'))?'actual_inbound_cost':field==='calculated_base_price'&&(slots.has(key(sku,'basis_sku_price'))||slots.has(key(sku,'actual_inbound_cost')))?'basis_sku_price':null;
    if(upstream){const input=evaluate(sku,upstream,'',[...stack,k]);const result={...input,trace:[...input.trace,{sku,field,value:input.value,inherited_from:upstream}]};cache.set(k,result);return result;}
    if(field==='calculated_base_price'&&legacyCalculate){const legacy=legacyCalculate(sku);if(legacy){const result={...legacy,versions:legacy.versions||[],trace:legacy.trace||[{sku,field,value:legacy.value}]};numeric(result.value,'계산값');cache.set(k,result);return result;}}
    const value=numeric(p[field]??p[raw[field]],sku+' '+fields[field]);if(value<0)throw Error('음수 기준값');const result={value,base:value,trace:[{sku,field,value}],formula:fields[field],versions:[]};cache.set(k,result);return result;
   }
   const rule=registry.get(assignment.rule_id);if(!rule||rule.is_active===false)throw Error('적용된 규칙이 없거나 비활성 상태입니다.');validateRule(rule);
   if(rule.target_field!==field||(rule.scope||'')!==(scope||''))throw Error('배정된 규칙의 단계 또는 판매처가 다릅니다.');
   let sourceSku=sku,sourceField=rule.source_field,sourceScope=isPlatform(sourceField)?rule.source_scope||rule.scope:'';
   if(rule.input_origin==='parent'){
    const d=refs.get(k);if(!d||d.rule_id!==rule.id)throw Error(sku+': 상위 참조 미지정');
    if(d.parent_sku===sku)throw Error(sku+': 자기 자신을 상위 SKU로 참조할 수 없습니다.');
    if(d.relation_valid===false)throw Error(sku+': 원래 종속관계가 변경 또는 해제되었습니다.');
    if(!Object.hasOwn(fields,d.source_field))throw Error(sku+': 상위 참조 항목이 없습니다.');
    sourceSku=d.parent_sku;sourceField=d.source_field;sourceScope=isPlatform(sourceField)?d.source_scope||rule.source_scope||rule.scope:'';
    if(isPlatform(sourceField)&&!validScope(sourceScope))throw Error(sku+': 참조 판매처를 확인하세요.');
   }
   const input=evaluate(sourceSku,sourceField,sourceScope,[...stack,k]);
   const value=transform(input.value,rule.config,{allowNegative:field==='platform_option_price',roundToWon:field==='actual_inbound_cost'});
   const result={value,base:input.value,rule,formula:`${sourceSku} ${fields[sourceField]} ${stepsText(rule.config.steps).replace(/\n/g,' ')}`,versions:[...input.versions,{id:rule.id,version:rule.version,assignmentVersion:assignment.version}],trace:[...input.trace,{sku,field,scope,value,rule_id:rule.id,version:rule.version}]};cache.set(k,result);return result;
  }
  return {evaluate};
 }
 function expandSkus(requested,dependencies,includeChildren=false,{maxSkus=2000}={}){
  const all=new Set(requested);let changed=true;
  while(changed){changed=false;for(const d of dependencies){if(all.has(d.child_sku)&&!all.has(d.parent_sku)){all.add(d.parent_sku);changed=true;}if(includeChildren&&all.has(d.parent_sku)&&!all.has(d.child_sku)){all.add(d.child_sku);changed=true;}}if(all.size>maxSkus)throw Error(`연결 SKU가 ${maxSkus.toLocaleString('ko-KR')}개를 넘습니다. 범위를 나누세요.`);}
  return [...all];
 }
 function descendants(requested,dependencies){const all=new Set(requested);let changed=true;while(changed){changed=false;for(const d of dependencies)if(all.has(d.parent_sku)&&!all.has(d.child_sku)){all.add(d.child_sku);changed=true;}if(all.size>2000)throw Error('연결 SKU가 2,000개를 넘습니다.');}return [...all];}
 function validateGraph(input){const evaluator=createEvaluator(input);return {valid:true,results:(input.assignments||[]).map(a=>({sku:a.sku,target_field:a.target_field,scope:a.scope||'',result:evaluator.evaluate(a.sku,a.target_field,a.scope||'')}))};}
 g.HubRuleRegistry={fields,targets,platformFields,makeshopDiscountCatalog,makeshopDiscountConfig,isPlatform,key,parseSteps,stepsText,validateRule,validateConfig,transform,inverse,inverseTransform:inverse,createEvaluator,validateGraph,expandSkus,descendants};
})(typeof window==='undefined'?globalThis:window);
