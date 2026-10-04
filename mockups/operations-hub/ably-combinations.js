(function(global) {
  'use strict';
  function parseSkuMemo(value) {
    const text=String(value??'').trim();
    if(!text)return {skus:[],error:'Q열 연결 SKU 미등록'};
    let parts;
    if(/[\[\]]/.test(text)) {
      if(!/^\[[^\[\],/]+\](?:\s*,\s*\[[^\[\],/]+\])*$/.test(text))return {skus:[],error:'[SKU1],[SKU2] 형식을 확인하세요'};
      parts=[...text.matchAll(/\[([^\[\]]+)\]/g)].map(match=>match[1].trim());
    } else {
      if(text.includes(','))return {skus:[],error:'쉼표는 [SKU1],[SKU2] 형식에서 사용하세요'};
      parts=text.split('/').map(part=>part.trim());
    }
    if(parts.some(part=>!part))return {skus:[],error:'빈 SKU가 있습니다'};
    // A repeated SKU is one stock source, not an implied component quantity.
    return {skus:[...new Set(parts)],error:''};
  }
  function groupProducts(items) {
    const groups=new Map();
    for(const item of items) {
      const row=item.row;
      const key=JSON.stringify([row[0],row[1],String(row[4]??'').trim()||row[2],row[3]].map(value=>String(value??'').trim()));
      if(!groups.has(key))groups.set(key,{title:String(row[3]??'').trim()||'온라인 상품명 미입력',code:String(row[2]??''),items:[]});
      groups.get(key).items.push(item);
    }
    return [...groups.values()];
  }
  global.AblyCombinationModel={parseSkuMemo,groupProducts};
  if(!global.document)return;
  const el=id=>document.getElementById(id);
  const input=el('ably-combination-file'),status=el('ably-combination-file-status'),body=el('ably-combination-preview');
  const products=el('ably-imported-products'),home=el('ably-products-home'),detail=el('ably-imported-detail');
  const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let groups=[],activeGroup=null,shown=0,sourceFile=null,stockRows=[],busy=false,request=0;
  el('ably-all-stock-download').onclick=async()=>{
    if(busy)return;
    if(!sourceFile||!groups.length){status.textContent='먼저 갱신할 옵션기본 엑셀을 선택하세요.';return;}
    busy=true;home.querySelectorAll('button,input').forEach(control=>control.disabled=true);
    status.textContent='전체 상품의 연결 SKU 재고를 조회하고 있습니다.';
    try{
      const items=groups.flatMap(group=>group.items);
      const skus=[...new Set(items.flatMap(item=>parseSkuMemo(item.memoText).skus))];
      const rows=await global.SystemV3Data.loadAblyComponentStocks(skus);
      const stockMap=Object.fromEntries(rows.map(row=>[row.sellpia_sku_code,row.system_stock]));
      const results=items.map(item=>global.AblyCombinationLabModel.calculate(item.memoText,stockMap));
      const blob=await global.AblyStockExport.build({file:sourceFile,items,results});
      global.SystemV3SellerExport.downloadBlob(blob,sourceFile.name.replace(/\.xls[xm]$/i,'')+'_전체조합_재고갱신.xlsx');
      const valid=results.filter(result=>!result.error).length;
      status.textContent=`전체 ${groups.length}개 상품 · ${items.length}개 조합 · 재고 갱신 ${valid}행 · 확인 필요 ${items.length-valid}행은 원본 재고 유지. 다운로드 완료.`;
    }catch(error){status.textContent=`전체 재고 파일 생성 실패: ${error.message}`;}
    finally{busy=false;home.querySelectorAll('button,input').forEach(control=>control.disabled=false);}
  };
  const stocks=()=>Object.fromEntries(stockRows.map(row=>[row.sellpia_sku_code,row.system_stock]));
  const calculations=()=>activeGroup.items.map(item=>global.AblyCombinationLabModel.calculate(item.memoText,stocks()));
  function setBusy(value){busy=value;el('ably-product-back').disabled=value;el('ably-stock-refresh').disabled=value;el('ably-stock-download').disabled=value;body.querySelectorAll('input').forEach(input=>{input.disabled=value;});}
  function render(){
    const results=calculations();
    body.innerHTML=activeGroup.items.slice(0,shown).map((item,index)=>{
      const row=item.row,result=results[index];
      return `<tr><td>${item.line}</td><td>${escape(row[11])} / ${escape(row[13])}</td><td>${escape(row[17])||'미등록'}</td><td><input class="ably-lab-memo" data-ably-memo="${index}" aria-label="${item.line}행 Q열 연결" value="${escape(item.memoText)}" ${busy?'disabled':''}></td><td>${result.components?.map(c=>`${escape(c.sku)}: ${c.stock}`).join('<br>')||'—'}</td><td>${escape(row[23])||'—'}</td><td>${result.value??'—'}</td><td>${escape(result.error||'다운로드 가능')}</td></tr>`;
    }).join('');
    el('ably-product-row-count').textContent=`조합 ${activeGroup.items.length}행 · 표시 ${shown}행 · 계산 가능 ${results.filter(r=>!r.error).length} · 확인 필요 ${results.filter(r=>r.error).length}`;
    el('ably-product-more').hidden=shown>=activeGroup.items.length;
    el('ably-stock-components').innerHTML=stockRows.map(row=>`<article><b>${escape(row.sellpia_sku_code)}</b><p>${escape(row.display_name)}</p><strong>${row.system_stock??'재고 없음'}</strong><small>재고 갱신 ${row.system_stock_updated_at?escape(new Date(row.system_stock_updated_at).toLocaleString('ko-KR')):'시각 없음'}</small></article>`).join('');
  }
  async function refresh(){
    const id=++request,group=activeGroup;stockRows=[];setBusy(true);render();el('ably-stock-status').textContent='연결된 개별 SKU의 시스템 현재재고를 조회하고 있습니다.';
    try{
      const skus=[...new Set(group.items.flatMap(item=>parseSkuMemo(item.memoText).skus))];
      const rows=await global.SystemV3Data.loadAblyComponentStocks(skus);
      if(id!==request||activeGroup!==group)return false;
      stockRows=rows;el('ably-stock-status').textContent=`시스템 현재재고 조회 완료 · ${new Date().toLocaleTimeString('ko-KR')} · ${rows.length}/${skus.length}개 SKU. 원본 재고 갱신 시각은 아래에 표시합니다.`;
      return true;
    }catch(error){if(id===request)el('ably-stock-status').textContent=`재고 조회 실패: ${error.message}`;return false;}
    finally{if(id===request){setBusy(false);render();}}
  }
  function open(group){if(global.AblyWorkspace){void global.AblyWorkspace.openImported(group,sourceFile);return;}activeGroup=group;shown=Math.min(200,group.items.length);home.hidden=true;detail.hidden=false;el('ably-product-title').textContent=group.title;el('ably-stock-export-note').textContent=group.test?'테스트 상품입니다. 다운로드는 플랫폼 35컬럼의 테스트 파일이며 실제 판매처 상품 식별값이 없습니다.':'원본 엑셀 전체 양식을 유지하며 이 상품의 Q열 수정값과 계산 가능한 X열(*판매수량)만 반영합니다. 확인 필요 행의 재고와 다른 상품은 원본 그대로 유지합니다.';void refresh();el('ably-product-back').focus();}
  products.addEventListener('click',event=>{const button=event.target.closest('[data-ably-product]');if(button)open(groups[Number(button.dataset.ablyProduct)]);});
  el('ably-product-back').onclick=()=>{++request;busy=false;detail.hidden=true;home.hidden=false;input.focus();};
  el('ably-product-more').onclick=()=>{shown=Math.min(shown+200,activeGroup.items.length);render();};
  el('ably-stock-refresh').onclick=()=>{if(!busy)void refresh();};
  body.addEventListener('input',event=>{
    if(event.target.dataset.ablyMemo===undefined||busy)return;
    activeGroup.items[Number(event.target.dataset.ablyMemo)].memoText=event.target.value;
    stockRows=[];
    body.querySelectorAll('tr').forEach(row=>{row.cells[4].textContent='—';row.cells[6].textContent='—';row.cells[7].textContent='재조회 필요';});
    el('ably-stock-status').textContent='Q열 변경됨 · 재고 새로고침 또는 다운로드 시 다시 조회합니다.';
  });
  el('ably-stock-download').onclick=async()=>{
    if(busy)return;
    const group=activeGroup;
    if(!await refresh()||activeGroup!==group)return;
    setBusy(true);
    try{
      const results=calculations(),valid=results.filter(r=>!r.error).length;
      const blob=await global.AblyStockExport.build({file:sourceFile,items:group.items,results,test:group.test});
      const name=(group.test?'테스트_1000':sourceFile.name.replace(/\.xls[xm]$/i,''))+'_조합재고반영.xlsx';
      global.SystemV3SellerExport.downloadBlob(blob,name);
      el('ably-stock-status').textContent=`엑셀 다운로드 완료 · 재고 반영 ${valid}행 · 확인 필요 ${results.length-valid}행은 원본 재고 유지. Q열 수정값 포함. 시스템 재고는 변경하지 않았습니다.`;
    }catch(error){el('ably-stock-status').textContent=`다운로드 실패: ${error.message}`;}
    finally{setBusy(false);}
  };
  global.AblyImportedWorkspace={snapshot:()=>({file:sourceFile,groups}),downloadAll:el('ably-all-stock-download').onclick};
  input.addEventListener('change',async()=>{
    const file=input.files?.[0];products.innerHTML='';groups=[];sourceFile=null;if(!file)return;
    if(file.size>20*1024*1024){status.textContent='20MB 이하의 엑셀 파일을 선택하세요.';return;}
    input.disabled=true;
    try{
      const book=global.XLSX.read(await file.arrayBuffer(),{type:'array'}),sheet=book.Sheets['옵션기본'];
      if(!sheet)throw new Error('옵션기본 시트가 없습니다.');
      const range=global.XLSX.utils.decode_range(sheet['!ref']||'A1');if(range.e.r>20000)throw new Error('20,000행 이하의 파일을 선택하세요.');
      const data=global.XLSX.utils.sheet_to_json(sheet,{header:1,defval:'',raw:true,blankrows:true,range:'A1:AI'+(range.e.r+1)});
      for(const [index,name] of global.AblyStockExport.headers.entries())if(String(data[0]?.[index]??'').trim()!==name)throw new Error(`${global.XLSX.utils.encode_col(index)}열의 ${name} 헤더를 확인하세요.`);
      const items=data.slice(1).map((row,index)=>({row,line:index+2,memoText:String(row[16]??'')})).filter(item=>String(item.row[9]).trim()==='조합형');
      sourceFile=file;groups=groupProducts(items);
      products.innerHTML=groups.map((group,index)=>`<button type="button" class="ably-product-card" data-ably-product="${index}"><span><b>${escape(group.title)}</b><small>${escape(group.code)} · 조합 ${group.items.length}개</small></span><span>조합 보기 →</span></button>`).join('')||'<p>조합형 상품이 없습니다.</p>';
      status.textContent=`${file.name} · 상품 ${groups.length}개 · 조합 ${items.length}행. 상품을 선택하면 Q열 SKU의 실제 재고를 조회합니다.`;
    }catch(error){status.textContent=`파일 확인 실패: ${error.message}`;}
    finally{input.disabled=false;}
  });
})(typeof window==='undefined'?globalThis:window);
