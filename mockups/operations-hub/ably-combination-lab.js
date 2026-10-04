(function(global) {
  'use strict';
  const definitions=[
    {sku:'1000-1+2',name:'테스트 2종 조합',memo:'1000-1/1000-2'},
    {sku:'1000-3+4+5',name:'테스트 3종 조합',memo:'[1000-3],[1000-4],[1000-5]'},
    {sku:'1000-6+7+8',name:'테스트 품절 조합',memo:'1000-6/1000-7/1000-8'},
    {sku:'1000-9',name:'테스트 단일 SKU',memo:'[1000-9]'}
  ];
  function initialState() {
    return {stocks:Object.fromEntries([20,12,30,8,16,10,0,25,7].map((stock,index)=>[`1000-${index+1}`,String(stock)])),
      combinations:definitions.map(row=>({...row,stock:'999'}))};
  }
  function calculate(memo,stocks) {
    const parsed=global.AblyCombinationModel.parseSkuMemo(memo);
    if(parsed.error)return {...parsed,value:null};
    const components=[];
    for(const sku of parsed.skus) {
      const raw=stocks[sku];
      if(raw===undefined||raw===null||String(raw).trim()==='')return {...parsed,value:null,error:`${sku} 재고 없음`};
      if(!/^\d+$/.test(String(raw).trim())||!Number.isSafeInteger(Number(raw)))return {...parsed,value:null,error:`${sku} 재고는 0 이상의 정수로 입력하세요`};
      components.push({sku,stock:Number(raw)});
    }
    return {...parsed,components,value:Math.min(...components.map(row=>row.stock))};
  }
  global.AblyCombinationLabModel={initialState,calculate};
})(typeof window==='undefined'?globalThis:window);
