(function initInventoryBatchUi(global){
 'use strict';
 const page=document.getElementById('inventory'),button=document.getElementById('inventory-batch-run'),sellpiaPicker=document.getElementById('inventory-sellpia-files'),ablyPicker=document.getElementById('inventory-ably-file');
 if(!page||!button||!sellpiaPicker||!ablyPicker)return;
 const status=document.getElementById('inventory-batch-status'),title=document.getElementById('inventory-batch-title'),detail=document.getElementById('inventory-batch-detail'),progress=document.getElementById('inventory-batch-progress'),result=document.getElementById('inventory-batch-result');
 const previewPanel=document.getElementById('inventory-update-preview'),previewTitle=document.getElementById('inventory-preview-title'),previewMessage=document.getElementById('inventory-preview-message'),summaryPanel=document.getElementById('inventory-preview-summary');
 const radios=[...page.querySelectorAll('input[name="inventory-stock-source"]')],allControls=[sellpiaPicker,ablyPicker,...radios,button];
 const summaryFields={fileCount:'inventory-preview-files',readRowCount:'inventory-preview-read-rows',validSkuCount:'inventory-preview-valid-skus',changedSkuCount:'inventory-preview-changed',unchangedSkuCount:'inventory-preview-unchanged',unknownSkuCount:'inventory-preview-unconfirmed',duplicateSameCount:'inventory-preview-duplicate-same',duplicateConflictCount:'inventory-preview-duplicate-conflict',errorRowCount:'inventory-preview-errors'};
 const fileIds=new WeakMap();let nextFileId=0;
 const state={busy:false,requestId:0,previewStatus:'idle',preview:null,previewSignature:'',previewError:'',retrySignature:'',retryAvailable:false};
 const selectedSellpiaFiles=()=>Array.from(sellpiaPicker.files||[]);
 const selectedAblyFile=()=>ablyPicker.files?.[0]||null;
 function identity(file){if(!fileIds.has(file))fileIds.set(file,++nextFileId);return `${fileIds.get(file)}:${file.name}:${file.size}:${file.lastModified}:${file.type}`;}
 function signature(){return `${selectedSellpiaFiles().map(identity).join('|')}||${selectedAblyFile()?identity(selectedAblyFile()):''}`;}
 function sellpiaSignature(){return selectedSellpiaFiles().map(identity).join('|');}
 function stockSource(){return radios.find(input=>input.checked)?.value||'available_stock';}
 function number(value){return Number(value||0).toLocaleString('ko-KR');}
 function showStatus(heading,message,kind=''){status.hidden=false;status.dataset.state=kind;title.textContent=heading;detail.textContent=message||'';}
 function clearResult(){result.replaceChildren();result.hidden=true;status.hidden=true;}
 function previewCurrent(){return state.previewStatus==='success'&&state.preview&&state.previewSignature===sellpiaSignature()&&selectedSellpiaFiles().length>0;}
 function previewHasBlockers(){const summary=state.preview?.summary||{};return Number(summary.duplicateConflictCount||0)>0||Number(summary.errorRowCount||0)>0;}
 function retryCurrent(){return state.retryAvailable&&state.retrySignature===signature()&&previewCurrent()&&Boolean(selectedAblyFile());}
 function ready(){return previewCurrent()&&!previewHasBlockers()&&Boolean(selectedAblyFile());}
 function updateAction(){if(state.busy)return;const retry=retryCurrent();button.disabled=!ready();button.textContent=retry?'판매처 파일 다시 생성':'재고 반영 후 4개 ZIP 생성';button.setAttribute('aria-busy','false');}
 function lock(locked){allControls.forEach(control=>control.disabled=locked);if(locked){button.textContent=!state.busy?'셀피아 파일 비교 중…':state.retryAvailable?'판매처 파일 다시 생성 중…':'재고 반영 및 ZIP 생성 중…';button.setAttribute('aria-busy','true');}else updateAction();}
 function renderFileStatus(){const sellpiaStatus=document.getElementById('inventory-sellpia-file-status'),ablyStatus=document.getElementById('inventory-file-status');const files=selectedSellpiaFiles();sellpiaStatus.textContent=files.length?`${files.length}개 파일 선택 · ${files.map(file=>file.name).join(' · ')}`:'선택한 파일 없음';sellpiaStatus.dataset.ready=String(files.length>0);const file=selectedAblyFile();ablyStatus.textContent=file?`${file.name} ✓ 선택됨`:'선택한 파일 없음';ablyStatus.dataset.ready=String(Boolean(file));}
 function renderPreview(){
  previewPanel.dataset.state=state.previewStatus;
  if(state.previewStatus==='checking'){previewTitle.textContent='재고 반영 미리보기 확인 중';previewMessage.textContent=state.previewError||'읽기 전용으로 파일과 현재 DB를 비교하고 있습니다.';summaryPanel.hidden=true;return;}
  if(state.previewStatus==='error'){previewTitle.textContent='재고 반영 미리보기 실패';previewMessage.textContent=state.previewError||'파일 형식과 최신 DB 상태를 확인해주세요.';summaryPanel.hidden=true;return;}
  if(state.previewStatus!=='success'||!state.preview){previewTitle.textContent='재고 반영 미리보기';previewMessage.textContent=selectedSellpiaFiles().length?'파일을 읽기 전용으로 비교할 준비 중입니다.':'셀피아 파일을 선택하면 현재 DB와 자동 비교합니다.';summaryPanel.hidden=true;return;}
  const counts=state.preview.summary||{};
  for(const [key,id] of Object.entries(summaryFields)){const node=document.getElementById(id);if(node)node.textContent=number(counts[key]);}
  summaryPanel.hidden=false;
  const blocked=previewHasBlockers(),unconfirmed=Number(counts.unknownSkuCount||0);
  previewTitle.textContent=blocked?'미리보기 완료 · 오류를 확인해주세요':'재고 반영 미리보기 완료';
  previewMessage.textContent=blocked?'중복 충돌 또는 오류 행이 있어 반영할 수 없습니다. 파일을 수정한 뒤 다시 선택해주세요.':`${number(counts.changedSkuCount)}개 변경 · ${number(counts.unchangedSkuCount)}개 동일${unconfirmed?` · 미확인 ${number(unconfirmed)}개는 반영 대상에서 제외됩니다`:''}. 최종 실행 전 서버에서 미리보기를 다시 검증합니다.`;
 }
 function invalidateRetry(){state.retryAvailable=false;state.retrySignature='';}
 function invalidatePreview(){state.requestId+=1;state.previewStatus='idle';state.preview=null;state.previewSignature='';state.previewError='';}
 async function previewSelectedFiles(){
  if(state.busy)return;
  const files=selectedSellpiaFiles(),requestId=++state.requestId,currentSignature=files.map(identity).join('|');
  clearResult();invalidateRetry();state.preview=null;state.previewError='';state.previewSignature=currentSignature;
  if(!files.length){state.previewStatus='idle';renderPreview();updateAction();return;}
  state.previewStatus='checking';renderFileStatus();renderPreview();lock(true);
  try{
   const api=global.SystemV3Data;
   if(!api?.previewSellpiaInventoryCount)throw Error('셀피아 재고 미리보기 기능을 불러오지 못했습니다. 새로고침 후 다시 선택해주세요.');
   const preview=await api.previewSellpiaInventoryCount(files,update=>{if(requestId!==state.requestId||currentSignature!==sellpiaSignature())return;previewMessage.textContent=update?.detail||update?.title||'현재 DB 재고와 비교 중';});
   if(requestId!==state.requestId||currentSignature!==sellpiaSignature())return;
   state.preview=preview;state.previewStatus='success';state.previewSignature=currentSignature;
  }catch(error){if(requestId!==state.requestId||currentSignature!==sellpiaSignature())return;state.previewStatus='error';state.previewError=String(error?.message||error);}
  renderPreview();lock(false);
 }
 function renderFiles(output){
  const heading=document.createElement('b');heading.textContent='최근 작업 결과';result.append(heading);
  const summary=document.createElement('p');summary.textContent='스마트스토어 2개 · 메이크샵 1개 · 에이블리 1개';result.append(summary);
  const list=document.createElement('ul');for(const entry of output.files){const item=document.createElement('li');item.textContent=typeof entry==='string'?entry:entry.fileName||entry.name;list.append(item);}result.append(list);
  if(output.warnings?.length){const note=document.createElement('p');note.textContent=`원본 유지 경고 ${output.warnings.length}건 · 해당 행은 기존 안전 정책에 따라 보존했습니다.`;result.append(note);}
  result.hidden=false;
 }
 function downloadOutput(output){
  if(!output?.blob||output.files?.length!==4||!output.fileName)throw Error('재고 파일 4개를 확인하지 못했습니다. 다시 실행해주세요.');
  const url=URL.createObjectURL(output.blob),anchor=document.createElement('a');anchor.href=url;anchor.download=output.fileName;document.body.append(anchor);
  try{anchor.click();}finally{anchor.remove();global.setTimeout(()=>URL.revokeObjectURL(url),60000);}
 }
 function progressUpdate(update){const message=typeof update==='string'?update:update?.message||update?.detail||'';if(message)detail.textContent=message;if(Number.isFinite(update?.percent))progress.value=Math.max(0,Math.min(100,update.percent));}
 async function startWork(){
  if(state.busy)return;
  clearResult();progress.hidden=true;
  if(!previewCurrent()){showStatus('재고 반영 중단','최신 셀피아 파일 미리보기를 먼저 완료해주세요.','error');return;}
  if(previewHasBlockers()){showStatus('재고 반영 중단','미리보기의 중복 충돌 또는 오류 행을 먼저 해결해주세요.','error');return;}
  const files=selectedSellpiaFiles(),file=selectedAblyFile(),expectedPreview=state.preview,source=stockSource();
  if(!file){showStatus('재고 반영 중단','에이블리 PlayAuto 원본 파일을 먼저 선택해주세요.','error');return;}
  if(global.__systemV3DirectExportBusy){showStatus('재고 반영 대기','진행 중인 판매처 내보내기가 끝난 뒤 다시 실행해주세요.');return;}
  const retry=retryCurrent(),bridge=global.SystemV3SellerExportBridge,method=retry?'retryInventoryBatchExport':'runInventoryUpdateBatch';
  if(!bridge?.[method]){showStatus('재고 반영 중단','재고 반영 기능을 불러오지 못했습니다. 새로고침 후 다시 실행해주세요.','error');return;}
  state.busy=true;lock(true);progress.value=0;progress.hidden=false;
  showStatus(retry?'판매처 파일 다시 생성 중…':'재고 반영 및 ZIP 생성 중…','작업 전 최종 조건을 확인합니다.','processing');
  try{
   const output=retry
    ?await bridge.retryInventoryBatchExport({file,stockSource:source,onProgress:progressUpdate})
    :await bridge.runInventoryUpdateBatch({files,expectedPreview,file,stockSource:source,onProgress:progressUpdate});
   try{downloadOutput(output);}catch(error){if(output?.uploaded===true){error.uploaded=true;error.retryAvailable=true;}throw error;}
   invalidateRetry();progress.value=100;progress.hidden=true;
   const changed=Number(expectedPreview.summary?.changedSkuCount||0);
   showStatus(changed?'재고 반영 및 ZIP 생성 완료':'변경 없이 ZIP 생성 완료',`${output.fileName} · 총 4개 파일${retry?' · DB를 다시 변경하지 않았습니다.':''}`,'success');renderFiles(output);
  }catch(error){
   progress.hidden=true;
   if(error?.uploaded===true&&error?.retryAvailable===true){state.retryAvailable=true;state.retrySignature=signature();showStatus('재고 업데이트 완료 · 파일 생성 실패',`DB 재고 반영은 완료됐지만 ZIP은 생성되지 않았습니다. 판매처 파일 다시 생성으로 최신 DB 재고를 읽어 ZIP만 재시도할 수 있습니다.\n${String(error?.message||error)}`,'error');}
   else showStatus(retry?'판매처 파일 재생성 실패':'재고 반영 중단',String(error?.message||error),'error');
  }finally{state.busy=false;lock(false);}
 }
 sellpiaPicker.addEventListener('change',()=>{if(state.busy)return;invalidatePreview();invalidateRetry();renderFileStatus();clearResult();void previewSelectedFiles();});
 ablyPicker.addEventListener('change',()=>{if(state.busy)return;invalidatePreview();invalidateRetry();renderFileStatus();clearResult();void previewSelectedFiles();});
 radios.forEach(radio=>radio.addEventListener('change',()=>{if(!state.busy){clearResult();updateAction();}}));
 button.addEventListener('click',()=>{void startWork();});
 renderFileStatus();renderPreview();updateAction();
})(window);
