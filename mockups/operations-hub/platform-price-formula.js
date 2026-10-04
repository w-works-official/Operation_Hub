(function(g){
 'use strict';
 function compose(rows,settings,math=g.SystemV3DiscountPriceMath){
  const multiplier=Number(settings.multiplier),add=Number(settings.add),discount=Number(settings.discountValue);
  if(!Number.isFinite(multiplier)||multiplier<0||!Number.isFinite(add)||!Number.isFinite(discount)||discount<0||(settings.discount==='percent'&&discount>=100))throw Error('플랫폼 배율·추가금액·할인값을 확인하세요.');
  if(!rows.length)return [];
  const amounts=rows.map(r=>Math.round(r.value*multiplier+add));
  if(amounts.some(v=>!Number.isSafeInteger(v)||v<0))throw Error('플랫폼 가격은 0원 이상이어야 합니다.');
  const ordered=[...amounts].sort((a,b)=>a-b),anchor=settings.anchor==='middle'?ordered[Math.floor((ordered.length-1)/2)]:ordered[0];
  const original=rows[0].discountTerms||[];
  const terms=settings.discount==='keep'?original:[...original.filter(t=>!t.is_baseline),...(discount>0?[{term_key:'basic',term_type:'basic',title:'플랫폼 수식 할인',input_source:'manual',unit:settings.discount,value:discount,is_baseline:true,rounding_mode:'nearest',rounding_unit:1}]:[])];
  let base=anchor;
  if(settings.mode==='reverse'){const result=math.grossBaseForTarget(anchor,terms);if(!result.exact)throw Error(result.reason);base=result.basePrice;}
  const discountedBase=math.discountedBase(base,terms);
  return rows.map((r,i)=>({...r,platformBase:base,platformOption:amounts[i]-anchor,platformFinal:discountedBase+amounts[i]-anchor,platformTerms:terms}));
 }
 g.PlatformPriceFormula={compose};
})(typeof window==='undefined'?globalThis:window);
