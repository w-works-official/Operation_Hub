(function(g){
 'use strict';
 const sources=['smartstore','makeshop','ably'];
 const rawInputs=new Set(['sellpia_purchase_price','sellpia_order_unit','sellpia_minimum_order_unit','system_stock','sellpia_current_stock','sellpia_own_code','sellpia_sale_price']);
 const key=(sku,scope,field)=>JSON.stringify([String(sku||''),String(scope||''),field]);
 let registry=null,owners=new Map(),pending=null,epoch=0,error='';
 function setRegistry(value){
  if(!value||!Array.isArray(value.rules)||!Array.isArray(value.assignments))throw Error('수식 배정 정보를 확인하지 못했습니다.');
  const rules=new Map(value.rules.filter(rule=>rule.is_active!==false&&rule.tag_active!==false).map(rule=>[String(rule.id),rule]));
  const next=new Map();
  for(const assignment of value.assignments){const rule=rules.get(String(assignment.rule_id));if(!rule||rule.target_field!==assignment.target_field||String(rule.scope||'')!==String(assignment.scope||''))continue;
   const slot=key(assignment.sku,assignment.scope,assignment.target_field),list=next.get(slot)||[];
   list.push({...rule,output_field:assignment.target_field,scope:assignment.scope||''});next.set(slot,list);
  }
  registry=value;owners=next;error='';return value;
 }
 function reset(){epoch++;registry=null;owners=new Map();pending=null;error='';}
 async function ensure({force=false}={}){
  if(force)reset();
  if(registry)return registry;if(pending)return pending;
  const version=epoch;
  pending=(async()=>{try{const value=await g.SystemV3Data.ruleRegistry('list');if(version===epoch)setRegistry(value);return version===epoch?value:null;}
   catch(failure){if(version===epoch)error=String(failure?.message||failure);throw failure;}
   finally{if(version===epoch)pending=null;}})();return pending;
 }
 function policy(product,{field='',source='',component=''}={}){
  if(rawInputs.has(field)&&!sources.includes(source))return {locked:false,known:true,owners:[],reason:''};
  if(field==='sellpia_current_stock')return {locked:false,known:true,owners:[],reason:''};
  const sku=product?.sellpia_sku_code||product?.sku;
  const platform=sources.includes(source),target=platform?({base:'platform_registration_price',discount:'platform_discount_price',option:'platform_option_price',final:'platform_final_price'}[component]||field):field==='system_base_price'?'calculated_base_price':field;
  if(!['actual_inbound_cost','basis_sku_price','calculated_base_price','platform_registration_price','platform_discount_price','platform_option_price','platform_final_price','platform_price'].includes(target))return {locked:false,known:true,owners:[],reason:''};
  const fields=platform?{
   platform_registration_price:['platform_registration_price'],
   platform_discount_price:['platform_registration_price','platform_discount_price'],
   platform_option_price:['platform_registration_price','platform_option_price','platform_final_price','platform_price'],
   platform_final_price:['platform_registration_price','platform_discount_price','platform_option_price','platform_final_price','platform_price'],
   platform_price:['platform_registration_price','platform_discount_price','platform_option_price','platform_final_price','platform_price']
  }[target]:target==='calculated_base_price'?['calculated_base_price','basis_sku_price','actual_inbound_cost']:target==='basis_sku_price'?['basis_sku_price','actual_inbound_cost']:['actual_inbound_cost'];
  let found=[];let known=Boolean(registry);
  if(registry)found=fields.flatMap(output=>owners.get(key(sku,platform?source:'',output))||[]);
  else if(!platform){
   const results=fields.map(output=>product?.__hubInternalPrices?.[output]).filter(Boolean);
   found=results.flatMap(result=>Array.isArray(result.activeOutputRules)?result.activeOutputRules:result.versions||[]);
   known=found.length>0||results.some(result=>Array.isArray(result.activeOutputRules));
  }else if(product?.__hubActivePriceRules?.[source]===false)known=true;
  // Legacy inbound tags live outside the unified registry. The read projection
  // supplies a name only after joining an active legacy tag; an old id alone
  // is not evidence of an active formula.
  if(!platform&&target==='actual_inbound_cost'&&product?.actual_inbound_cost_mode==='formula'&&String(product?.inbound_cost_formula_tag_name||'').trim()){
   found.push({name:product.inbound_cost_formula_tag_name||'실입고가 수식',output_field:'actual_inbound_cost'});known=true;
  }
  const unique=[...new Map(found.map(owner=>[owner.id||owner.rule_id||owner.name||owner.tag_name,owner])).values()];
  const locked=unique.length>0||!known;
  return {locked,known,owners:unique,reason:unique.length?`수식이 계산하는 가격입니다. ${(unique.map(owner=>owner.name||owner.tag_name).filter(Boolean).join(' · ')||'상품 태그 / 가격 수식')}에서 변경해주세요.`:!known?(error?'수식 배정을 확인하지 못했습니다. 새로고침 후 다시 확인해주세요.':'수식 배정을 확인하고 있습니다. 잠시 후 다시 시도해주세요.'):'',field:target};
 }
 g.HubMatrixPriceEditPolicy={policy,setRegistry,ensure,reset,get ready(){return Boolean(registry);}};
})(typeof window==='undefined'?globalThis:window);
