(function initInventoryBatchUi(global){
 'use strict';
 const page=document.getElementById('inventory'),button=document.getElementById('inventory-batch-run'),picker=document.getElementById('inventory-ably-file');
 if(!page||!button||!picker)return;
 const status=document.getElementById('inventory-batch-status'),title=document.getElementById('inventory-batch-title'),detail=document.getElementById('inventory-batch-detail'),progress=document.getElementById('inventory-batch-progress'),result=document.getElementById('inventory-batch-result'),fileStatus=document.getElementById('inventory-file-status');
 const radios=[...page.querySelectorAll('input[name="inventory-stock-source"]')];
 let running=false;
 function showStatus(heading,message,kind=''){
  status.hidden=false;status.dataset.state=kind;title.textContent=heading;detail.textContent=message||'';
 }
 function lock(locked){
  button.disabled=locked;picker.disabled=locked;radios.forEach(input=>input.disabled=locked);
  button.textContent=locked?'재고 파일 생성 중…':'재고 파일 4개 ZIP 생성';
  button.setAttribute('aria-busy',String(locked));
 }
 function clearResult(){result.replaceChildren();result.hidden=true;status.hidden=true;}
 picker.addEventListener('change',()=>{
  if(running)return;
  clearResult();const file=picker.files?.[0];
  fileStatus.textContent=file?`${file.name} ✓ 선택됨`:'선택한 파일 없음';
  fileStatus.dataset.ready=String(Boolean(file));
 });
 radios.forEach(radio=>radio.addEventListener('change',()=>{if(!running)clearResult();}));
 button.addEventListener('click',async()=>{
  if(running)return;
  clearResult();progress.hidden=true;
  const file=picker.files?.[0],stockSource=radios.find(input=>input.checked)?.value||'available_stock';
  if(!file){showStatus('재고 파일 생성 중단','에이블리 PlayAuto 원본 파일을 먼저 선택해주세요.','error');return;}
  if(global.__systemV3DirectExportBusy){showStatus('재고 파일 생성 대기','진행 중인 판매처 내보내기가 끝난 뒤 다시 실행해주세요.');return;}
  running=true;lock(true);progress.value=0;progress.hidden=false;
  showStatus('재고 파일 생성 중…','원본을 확인합니다.','processing');
  try{
   const bridge=global.SystemV3SellerExportBridge;
   if(!bridge?.runInventoryBatch)throw Error('재고 파일 생성 기능을 불러오지 못했습니다. 새로고침 후 다시 실행해주세요.');
   const output=await bridge.runInventoryBatch({file,stockSource,onProgress:update=>{
    const message=typeof update==='string'?update:update?.message||update?.detail||'';
    if(message)detail.textContent=message;
    if(Number.isFinite(update?.percent))progress.value=Math.max(0,Math.min(100,update.percent));
   }});
   if(!output?.blob||output.files?.length!==4||!output.fileName)throw Error('재고 파일 4개를 확인하지 못했습니다. 다시 실행해주세요.');
   const url=URL.createObjectURL(output.blob),anchor=document.createElement('a');
   anchor.href=url;anchor.download=output.fileName;document.body.append(anchor);
   try{anchor.click();}finally{anchor.remove();global.setTimeout(()=>URL.revokeObjectURL(url),60000);}
   progress.value=100;progress.hidden=true;
   showStatus('재고 파일 생성 완료',`${output.fileName} · 총 4개 파일`,'success');
   const heading=document.createElement('b');heading.textContent='최근 작업 결과';result.append(heading);
   const summary=document.createElement('p');summary.textContent='스마트스토어 2개 ✓ · 메이크샵 1개 ✓ · 에이블리 1개 ✓';result.append(summary);
   const list=document.createElement('ul');for(const entry of output.files){const item=document.createElement('li');item.textContent=typeof entry==='string'?entry:entry.fileName||entry.name;list.append(item);}result.append(list);
   if(output.warnings?.length){const note=document.createElement('p');note.textContent=`원본 유지 경고 ${output.warnings.length}건 · 해당 행은 기존 안전 정책에 따라 보존했습니다.`;result.append(note);}
   result.hidden=false;
  }catch(error){progress.hidden=true;showStatus('재고 파일 생성 중단',String(error?.message||error),'error');}
  finally{running=false;lock(false);}
 });
})(window);
