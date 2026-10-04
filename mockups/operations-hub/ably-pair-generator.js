(function(global){
  'use strict';
  function generate(products,{title,account='',code='',price='',option1='옵션1',option2='옵션2',option3='옵션3',size=2,autoDefaults=false}={}){
    if(!products.length)throw new Error('상품을 선택하세요.');
    if(products.length>100)throw new Error('한 번에 100개 상품까지 선택하세요.');
    if(!String(title||'').trim())throw new Error('온라인 상품명을 입력하세요.');
    if(new Set(products.map(p=>p.sellpia_sku_code)).size!==products.length)throw new Error('선택 SKU가 중복되었습니다.');
    for(const p of products)if(p.system_stock===null||p.system_stock===undefined||String(p.system_stock).trim()===''||!Number.isSafeInteger(Number(p.system_stock))||Number(p.system_stock)<0)throw new Error(`${p.sellpia_sku_code} 재고를 확인하세요.`);
    const names=products.map(p=>p.sellpia_option_name||p.display_name||p.sellpia_sku_code);
    const label=p=>{const name=p.sellpia_option_name||p.display_name||p.sellpia_sku_code;return names.filter(n=>n===name).length>1?`${name} [${p.sellpia_sku_code}]`:name;};
    if(![2,3].includes(size)||products.length**size>20000)throw new Error('조합은 20,000행 이하로 생성하세요.');
    const tuples=products.flatMap(first=>products.flatMap(second=>size===3?products.map(third=>[first,second,third]):[[first,second]]));
    return tuples.map(([first,second,third])=>{
      const row=Array(35).fill('');
      row[0]='에이블리';row[1]=account;row[2]=code;row[3]=title;row[5]=price;
      row[8]='일반';row[9]='조합형';row[10]=option1;row[11]=label(first);
      row[12]=option2;row[13]=label(second);
      const components=[first,second,...(third?[third]:[])]; if(third){row[14]=option3;row[15]=label(third);}
      if(autoDefaults){
        row[1]='pink_rocket@naver.com';
        const prefixes=[...new Set(components.map(p=>String(p.sellpia_sku_code).replace(/-[^-]+$/,'')))];
        if(prefixes.length!==1)throw Error('서로 다른 상품 접두부의 조합입니다: '+components.map(p=>p.sellpia_sku_code).join(', ')+' · 확인된 관리코드 규칙이 없어 자동 생성을 중단했습니다. 기존 엑셀의 행 코드는 그대로 사용할 수 있습니다.');
        row[2]='sellpia_'+prefixes[0];
        row[5]=components.reduce((sum,p)=>{const price=p.system_base_price??p.sellpia_source_sale_price;if(price===null||price===undefined||String(price).trim()===''||!Number.isFinite(Number(price))||Number(price)<0)throw Error(p.sellpia_sku_code+' 기준가격 없음');return sum+Number(price);},0);
      }
      row[16]=components.map(p=>`[${p.sellpia_sku_code}]`).join(',');
      row[17]=components.map(p=>p.sellpia_sku_code).join('+');
      row[21]=0;row[23]=Math.min(...components.map(p=>Number(p.system_stock)));row[34]='Y';
      return row;
    });
  }
  global.AblyPairGenerator={generate};
})(typeof window==='undefined'?globalThis:window);
