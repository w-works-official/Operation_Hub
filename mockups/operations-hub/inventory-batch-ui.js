(function initInventoryBatchUi(global){
 'use strict';
 const page=document.getElementById('inventory'),button=document.getElementById('inventory-batch-run'),sellpiaPicker=document.getElementById('inventory-sellpia-files');
 if(!page||!button||!sellpiaPicker)return;
 const status=document.getElementById('inventory-batch-status'),title=document.getElementById('inventory-batch-title'),detail=document.getElementById('inventory-batch-detail'),progress=document.getElementById('inventory-batch-progress'),result=document.getElementById('inventory-batch-result');
 const previewPanel=document.getElementById('inventory-update-preview'),previewTitle=document.getElementById('inventory-preview-title'),previewMessage=document.getElementById('inventory-preview-message'),summaryPanel=document.getElementById('inventory-preview-summary'),mappingStatus=document.getElementById('inventory-ably-mapping-status');
 const radios=[...page.querySelectorAll('input[name="inventory-stock-source"]')],allControls=[sellpiaPicker,...radios,button];
 const summaryFields={fileCount:'inventory-preview-files',readRowCount:'inventory-preview-read-rows',validSkuCount:'inventory-preview-valid-skus',changedSkuCount:'inventory-preview-changed',unchangedSkuCount:'inventory-preview-unchanged',unknownSkuCount:'inventory-preview-unconfirmed',duplicateSameCount:'inventory-preview-duplicate-same',duplicateConflictCount:'inventory-preview-duplicate-conflict',errorRowCount:'inventory-preview-errors'};
 const fileIds=new WeakMap();let nextFileId=0;
 const state={busy:false,requestId:0,previewStatus:'idle',preview:null,previewSignature:'',previewError:'',mappingStatus:'idle',mapping:null,mappingError:'',mappingRequest:0,retrySignature:'',retryAvailable:false};
 const selectedSellpiaFiles=()=>Array.from(sellpiaPicker.files||[]);
 function identity(file){if(!fileIds.has(file))fileIds.set(file,++nextFileId);return `${fileIds.get(file)}:${file.name}:${file.size}:${file.lastModified}:${file.type}`;}
 function sellpiaSignature(){return selectedSellpiaFiles().map(identity).join('|');}
 function stockSource(){return radios.find(input=>input.checked)?.value||'available_stock';}
 function signature(){return `${sellpiaSignature()}||${stockSource()}`;}
 function number(value){return Number(value||0).toLocaleString('ko-KR');}
 function showStatus(heading,message,kind=''){status.hidden=false;status.dataset.state=kind;title.textContent=heading;detail.textContent=message||'';}
 function clearResult(){result.replaceChildren();result.hidden=true;status.hidden=true;}
 function previewCurrent(){return state.previewStatus==='success'&&state.preview&&state.previewSignature===sellpiaSignature()&&selectedSellpiaFiles().length>0;}
 function previewHasBlockers(){const counts=state.preview?.summary||{};return Number(counts.errorRowCount||0)>0||Number(counts.duplicateConflictCount||0)>0;}
 function mappingsReady(){return state.mappingStatus==='success'&&Boolean(state.mapping?.ready)&&Number(state.mapping?.eligibleCount)>0&&Boolean(state.mapping?.templateFile);}
 function retryCurrent(){return state.retryAvailable&&state.retrySignature===signature()&&previewCurrent()&&mappingsReady();}
 function ready(){return previewCurrent()&&!previewHasBlockers()&&mappingsReady();}
 function updateAction(){if(state.busy)return;const retry=retryCurrent();button.disabled=!ready();button.textContent=retry?'판매처 파일 다시 생성':'재고 반영 후 4개 ZIP 생성';button.setAttribute('aria-busy','false');}
 function lock(locked){allControls.forEach(control=>control.disabled=locked);if(locked){button.textContent=state.retryAvailable?'판매처 파일 다시 생성 중…':'재고 반영 및 ZIP 생성 중…';button.setAttribute('aria-busy','true');}else updateAction();}
 function renderFileStatus(){const node=document.getElementById('inventory-sellpia-file-status'),files=selectedSellpiaFiles();if(!node)return;node.textContent=files.length?`${files.length}개 파일 선택 · ${files.map(file=>file.name).join(' · ')}`:'선택한 파일 없음';node.dataset.ready=String(files.length>0);}
 function renderMappingStatus(){if(!mappingStatus)return;mappingStatus.dataset.state=state.mappingStatus;if(state.mappingStatus==='checking'){mappingStatus.textContent='에이블리 재고 매핑을 확인하고 있습니다.';return;}if(state.mappingStatus==='error'){mappingStatus.textContent=`에이블리 재고 매핑 확인 실패 · ${state.mappingError||'다시 확인해주세요.'}`;return;}if(state.mappingStatus!=='success'||!state.mapping){mappingStatus.textContent='매핑 확인 대기';return;}const {eligibleCount=0,reviewCount=0,excludedCount=0,reason=''}=state.mapping;mappingStatus.textContent=state.mapping.ready&&eligibleCount?`에이블리 재고 매핑 ${number(eligibleCount)}행 준비됨 · 검토 ${number(reviewCount)} · 제외 ${number(excludedCount)}`:`에이블리 재고 매핑을 확인할 수 없습니다 · ${reason||`검토 ${number(reviewCount)} · 제외 ${number(excludedCount)}`}`;}
 function renderPreview(){
  if(!previewPanel)return;previewPanel.dataset.state=state.previewStatus;
  if(state.previewStatus==='checking'){previewTitle.textContent='재고 반영 미리보기 확인 중';previewMessage.textContent=state.previewError||'읽기 전용으로 파일과 현재 DB를 비교하고 있습니다.';summaryPanel.hidden=true;return;}
  if(state.previewStatus==='error'){previewTitle.textContent='재고 반영 미리보기 실패';previewMessage.textContent=state.previewError||'파일 형식과 최신 DB 상태를 확인해주세요.';summaryPanel.hidden=true;return;}
  if(state.previewStatus!=='success'||!state.preview){previewTitle.textContent='재고 반영 미리보기';previewMessage.textContent=selectedSellpiaFiles().length?'파일을 읽기 전용으로 비교할 준비 중입니다.':'셀피아 파일을 선택하면 현재 DB와 자동 비교합니다.';summaryPanel.hidden=true;return;}
  const counts=state.preview.summary||{};for(const [key,id] of Object.entries(summaryFields)){const node=document.getElementById(id);if(node)node.textContent=number(counts[key]);}
  summaryPanel.hidden=false;const blocked=previewHasBlockers(),unknown=Number(counts.unknownSkuCount||0);
  previewTitle.textContent=blocked?'미리보기 완료 · 오류를 확인해주세요':'재고 반영 미리보기 완료';
  previewMessage.textContent=blocked?'중복 충돌 또는 오류 행이 있어 반영할 수 없습니다. 파일을 수정한 뒤 다시 선택해주세요.':`${number(counts.changedSkuCount)}개 변경 · ${number(counts.unchangedSkuCount)}개 동일${unknown?` · 미확인 ${number(unknown)}개는 반영 대상에서 제외됩니다`:''}. 최종 실행 전 서버에서 미리보기를 다시 검증합니다.`;
 }
 function invalidateRetry(){state.retryAvailable=false;state.retrySignature='';}
 function invalidatePreview(){state.requestId+=1;state.previewStatus='idle';state.preview=null;state.previewSignature='';state.previewError='';}
 async function refreshMappingReadiness(){
  if(state.busy)return;
  const request=++state.mappingRequest,bridge=global.SystemV3SellerExportBridge;
  state.mappingStatus='checking';state.mapping=null;state.mappingError='';renderMappingStatus();updateAction();
  try{
   if(typeof bridge?.preflightInventoryMappings!=='function')throw Error('에이블리 재고 매핑 확인 기능을 불러오지 못했습니다.');
   const mapping=await bridge.preflightInventoryMappings();
   if(request!==state.mappingRequest)return;
   state.mapping=mapping;state.mappingStatus='success';
   if(!mapping?.ready||!Number(mapping.eligibleCount))state.mappingError=mapping?.reason||'사용 가능한 매핑이 없습니다.';
  }catch(error){if(request!==state.mappingRequest)return;state.mapping=null;state.mappingStatus='error';state.mappingError=String(error?.message||error);}
  renderMappingStatus();updateAction();
 }
 async function previewSelectedFiles(){
  if(state.busy)return;
  const files=selectedSellpiaFiles(),request=++state.requestId,currentSignature=files.map(identity).join('|');
  clearResult();invalidateRetry();state.preview=null;state.previewError='';state.previewSignature=currentSignature;
  if(!files.length){state.previewStatus='idle';renderPreview();updateAction();return;}
  state.previewStatus='checking';renderFileStatus();renderPreview();lock(true);
  try{
   const api=global.SystemV3Data;if(!api?.previewSellpiaInventoryCount)throw Error('셀피아 재고 미리보기 기능을 불러오지 못했습니다. 새로고침 후 다시 선택해주세요.');
   const preview=await api.previewSellpiaInventoryCount(files,update=>{if(request!==state.requestId||currentSignature!==sellpiaSignature())return;previewMessage.textContent=update?.detail||update?.title||'현재 DB 재고와 비교 중';});
   if(request!==state.requestId||currentSignature!==sellpiaSignature())return;state.preview=preview;state.previewStatus='success';state.previewSignature=currentSignature;
  }catch(error){if(request!==state.requestId||currentSignature!==sellpiaSignature())return;state.previewStatus='error';state.previewError=String(error?.message||error);}
  renderPreview();lock(false);
 }
 function renderFiles(output){
  const heading=document.createElement('b');heading.textContent='최근 작업 결과';result.append(heading);
  const summary=document.createElement('p');summary.textContent=`스마트스토어 2개 · 메이크샵 1개 · 에이블리 재고 수량 변경 ${number(output.ablySummary?.eligibleCount||0)}행`;result.append(summary);
  const list=document.createElement('ul');for(const entry of output.files||[]){const item=document.createElement('li');item.textContent=typeof entry==='string'?entry:entry.fileName||entry.name;list.append(item);}result.append(list);
  if(output.warnings?.length||output.ablySummary?.reviewCount||output.ablySummary?.excludedCount){const note=document.createElement('p');note.textContent=`매핑 검토 ${number(output.ablySummary?.reviewCount||0)}건 · 제외 ${number(output.ablySummary?.excludedCount||0)}건${output.warnings?.length?` · 셀피아 원본 유지 경고 ${number(output.warnings.length)}건`:''}`;result.append(note);}
  result.hidden=false;
 }
 function downloadOutput(output){if(!output?.blob||output.files?.length!==4||!output.fileName)throw Error('재고 파일 4개를 확인하지 못했습니다. 다시 실행해주세요.');const url=URL.createObjectURL(output.blob),anchor=document.createElement('a');anchor.href=url;anchor.download=output.fileName;document.body.append(anchor);try{anchor.click();}finally{anchor.remove();global.setTimeout(()=>URL.revokeObjectURL(url),60000);}}
 function progressUpdate(update){const message=typeof update==='string'?update:update?.message||update?.detail||'';if(message)detail.textContent=message;if(Number.isFinite(update?.percent))progress.value=Math.max(0,Math.min(100,update.percent));}
 async function startWork(){
  if(state.busy)return;
  clearResult();progress.hidden=true;
  if(!previewCurrent()){showStatus('재고 반영 중단','최신 셀피아 파일 미리보기를 먼저 완료해주세요.','error');return;}
  if(previewHasBlockers()){showStatus('재고 반영 중단','미리보기의 중복 충돌 또는 오류 행을 먼저 해결해주세요.','error');return;}
  if(global.__systemV3DirectExportBusy){showStatus('재고 반영 대기','진행 중인 판매처 내보내기가 끝난 뒤 다시 실행해주세요.');return;}
  const bridge=global.SystemV3SellerExportBridge;
  try{await refreshMappingReadiness();}catch{}
  if(!mappingsReady()){showStatus('재고 반영 중단',state.mappingError||state.mapping?.reason||'에이블리 재고 매핑을 확인해주세요.','error');return;}
  const files=selectedSellpiaFiles(),expectedPreview=state.preview,source=stockSource(),retry=retryCurrent(),method=retry?'retryInventoryBatchExport':'runInventoryUpdateBatch';
  if(!bridge?.[method]){showStatus('재고 반영 중단','재고 반영 기능을 불러오지 못했습니다. 새로고침 후 다시 실행해주세요.','error');return;}
  state.busy=true;lock(true);progress.value=0;progress.hidden=false;
  showStatus(retry?'판매처 파일 다시 생성 중…':'재고 반영 및 ZIP 생성 중…','작업 전 최종 조건을 확인합니다.','processing');
  try{
   const output=retry?await bridge.retryInventoryBatchExport({stockSource:source,onProgress:progressUpdate}):await bridge.runInventoryUpdateBatch({files,expectedPreview,stockSource:source,onProgress:progressUpdate});
   try{downloadOutput(output);}catch(error){if(output?.uploaded===true){error.uploaded=true;error.retryAvailable=true;}throw error;}
   invalidateRetry();progress.value=100;progress.hidden=true;const changed=Number(expectedPreview.summary?.changedSkuCount||0);
   showStatus(changed?'재고 반영 및 ZIP 생성 완료':'변경 없이 ZIP 생성 완료',`${output.fileName} · 총 4개 파일${retry?' · DB를 다시 변경하지 않았습니다.':''}`,'success');renderFiles(output);
  }catch(error){
   progress.hidden=true;
   if(error?.uploaded===true&&error?.retryAvailable===true){state.retryAvailable=true;state.retrySignature=signature();showStatus('재고 업데이트 완료 · 파일 생성 실패',`DB 재고 반영은 완료됐지만 ZIP은 생성되지 않았습니다. 판매처 파일 다시 생성으로 최신 DB 재고를 읽어 ZIP만 재시도할 수 있습니다.\n${String(error?.message||error)}`,'error');}
   else showStatus(retry?'판매처 파일 재생성 실패':'재고 반영 중단',String(error?.message||error),'error');
  }finally{state.busy=false;lock(false);}
 }
 sellpiaPicker.addEventListener('change',()=>{if(state.busy)return;invalidatePreview();invalidateRetry();renderFileStatus();clearResult();void previewSelectedFiles();});
 radios.forEach(radio=>radio.addEventListener('change',()=>{if(!state.busy){invalidateRetry();clearResult();updateAction();}}));
 button.addEventListener('click',()=>{void startWork();});
 document.addEventListener('click',event=>{if(event.target.closest?.('[data-page="inventory"]'))void refreshMappingReadiness();});
 global.addEventListener('ably-inventory-mappings-changed',()=>{if(!state.busy){invalidateRetry();clearResult();void refreshMappingReadiness();}});
 const authObserver=new MutationObserver(()=>{if(!document.body.classList.contains('operations-auth-locked'))void refreshMappingReadiness();});authObserver.observe(document.body,{attributes:true,attributeFilter:['class']});
 renderFileStatus();renderPreview();renderMappingStatus();updateAction();void refreshMappingReadiness();
})(window);
