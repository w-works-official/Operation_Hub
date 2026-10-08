(function initInventoryBatchUi(global){
 'use strict';
 const page=document.getElementById('inventory'),button=document.getElementById('inventory-batch-run'),sellpiaPicker=document.getElementById('inventory-sellpia-files');
 if(!page||!button||!sellpiaPicker)return;
 const fileList=document.getElementById('inventory-sellpia-file-list'),clearFilesButton=document.getElementById('inventory-sellpia-clear-files'),dropzone=document.getElementById('inventory-sellpia-dropzone');
 const status=document.getElementById('inventory-batch-status'),title=document.getElementById('inventory-batch-title'),detail=document.getElementById('inventory-batch-detail'),progress=document.getElementById('inventory-batch-progress'),result=document.getElementById('inventory-batch-result');
 const previewPanel=document.getElementById('inventory-update-preview'),previewTitle=document.getElementById('inventory-preview-title'),previewMessage=document.getElementById('inventory-preview-message'),summaryPanel=document.getElementById('inventory-preview-summary'),mappingStatus=document.getElementById('inventory-ably-mapping-status');
 const radios=[...page.querySelectorAll('input[name="inventory-stock-source"]')],destinationName=document.getElementById('inventory-download-destination-name'),destinationHint=document.getElementById('inventory-download-destination-hint'),chooseDestinationButton=document.getElementById('inventory-choose-destination'),clearDestinationButton=document.getElementById('inventory-clear-destination'),blockedReport=document.getElementById('inventory-blocked-report'),blockedReportSummary=document.getElementById('inventory-blocked-report-summary'),blockedDownloadButton=document.getElementById('inventory-blocked-preview-download'),allControls=[sellpiaPicker,...radios,button,clearFilesButton,chooseDestinationButton,clearDestinationButton,blockedDownloadButton];
 const summaryFields={fileCount:'inventory-preview-files',readRowCount:'inventory-preview-read-rows',validSkuCount:'inventory-preview-valid-skus',changedSkuCount:'inventory-preview-changed',unchangedSkuCount:'inventory-preview-unchanged',unknownSkuCount:'inventory-preview-unconfirmed',duplicateSameCount:'inventory-preview-duplicate-same',duplicateConflictCount:'inventory-preview-duplicate-conflict',errorRowCount:'inventory-preview-errors',blockedSkuCount:'inventory-preview-blocked-skus',blockedRowCount:'inventory-preview-blocked-rows'};
 const state={busy:false,requestId:0,previewStatus:'idle',preview:null,previewSignature:'',previewError:'',mappingStatus:'idle',mapping:null,mappingError:'',mappingRequest:0,retrySignature:'',retryAvailable:false,files:[],destination:null,destinationBusy:false,lastDownloadFiles:[]};
 const selectionLocked=()=>state.busy||state.destinationBusy||state.previewStatus==='checking';
 const selectedSellpiaFiles=()=>state.files.slice();
 function identity(file){return `${file.name}\u0000${file.size}\u0000${file.lastModified}\u0000${file.type}`;}
 function sellpiaSignature(){return selectedSellpiaFiles().map(identity).join('|');}
 function stockSource(){return radios.find(input=>input.checked)?.value||'available_stock';}
 function signature(){return `${sellpiaSignature()}||${stockSource()}`;}
 function number(value){return Number(value||0).toLocaleString('ko-KR');}
 function showStatus(heading,message,kind=''){status.hidden=false;status.dataset.state=kind;title.textContent=heading;detail.textContent=message||'';}
 function clearResult(){result.replaceChildren();result.hidden=true;status.hidden=true;state.lastDownloadFiles=[];}
 function previewCurrent(){return state.previewStatus==='success'&&state.preview&&state.previewSignature===sellpiaSignature()&&selectedSellpiaFiles().length>0;}
 function previewHasBlockers(){return Number(state.preview?.summary?.validSkuCount||0)<=0;}
 function mappingsReady(){return state.mappingStatus==='success'&&Boolean(state.mapping?.ready)&&Number(state.mapping?.eligibleCount)>0&&Boolean(state.mapping?.templateFile);}
 function retryCurrent(){return state.retryAvailable&&state.retrySignature===signature()&&previewCurrent()&&mappingsReady();}
 function ready(){return previewCurrent()&&!previewHasBlockers()&&mappingsReady();}
 function updateAction(){if(state.busy||state.destinationBusy)return;const retry=retryCurrent();button.disabled=!ready();button.textContent=retry?'판매처 파일 다시 생성':'재고 반영 후 판매처 파일 4개 생성';button.setAttribute('aria-busy','false');}
 function lock(locked){allControls.forEach(control=>{if(control)control.disabled=locked;});if(clearFilesButton)clearFilesButton.disabled=locked||!state.files.length;if(chooseDestinationButton)chooseDestinationButton.disabled=locked||state.destination?.supported===false;if(clearDestinationButton)clearDestinationButton.disabled=locked||!state.destination?.configured;if(blockedDownloadButton)blockedDownloadButton.disabled=locked||!previewCurrent()||!(state.preview?.blockedRows?.length);result.querySelectorAll('[data-redownload-index]').forEach(control=>{control.disabled=locked;});renderFileStatus();if(locked){button.textContent=state.retryAvailable?'판매처 파일 다시 생성 중…':'재고 반영 및 파일 4개 생성 중…';button.setAttribute('aria-busy','true');}else updateAction();}
 function renderFileStatus(){const node=document.getElementById('inventory-sellpia-file-status'),files=selectedSellpiaFiles();if(node){node.textContent=files.length?`${files.length}/10개 파일 선택`:'선택한 파일 없음';node.dataset.ready=String(files.length>0);}if(clearFilesButton)clearFilesButton.disabled=selectionLocked()||!files.length;if(dropzone)dropzone.setAttribute('aria-disabled',String(selectionLocked()));if(fileList){fileList.replaceChildren();files.forEach((file,index)=>{const li=document.createElement('li'),name=document.createElement('span'),remove=document.createElement('button');name.textContent=`${file.name} · ${(file.size/1024/1024).toFixed(2)} MB`;remove.type='button';remove.className='btn secondary';remove.dataset.removeFile=String(index);remove.textContent='삭제';remove.setAttribute('aria-label',`${file.name} 삭제`);remove.disabled=selectionLocked();li.append(name,remove);fileList.append(li);});}}
 function addFiles(items){if(selectionLocked()){showStatus('미리보기 진행 중','파일 비교가 끝난 뒤 파일을 추가하거나 변경해주세요.');return;}const incoming=Array.from(items||[]),accepted=[],rejected=[],duplicates=[];for(const file of incoming){if(!/\.xlsx$/i.test(file.name)){rejected.push(`${file.name}: XLSX 파일이 아닙니다`);continue;}if(state.files.includes(file)||accepted.includes(file)){duplicates.push(file.name);continue;}if(state.files.length+accepted.length>=10){rejected.push(`${file.name}: 최대 10개까지 선택할 수 있습니다`);continue;}accepted.push(file);}if(accepted.length){state.files.push(...accepted);invalidatePreview();invalidateRetry();clearResult();void previewSelectedFiles();}renderFileStatus();if(rejected.length||duplicates.length)showStatus('파일 선택 확인',[...rejected,...duplicates.map(name=>`${name}: 같은 파일 항목이 이미 선택되어 있습니다`)].join('\n'),'error');}
 function renderMappingStatus(){if(!mappingStatus)return;mappingStatus.dataset.state=state.mappingStatus;if(state.mappingStatus==='checking'){mappingStatus.textContent='에이블리 재고 매핑을 확인하고 있습니다.';return;}if(state.mappingStatus==='error'){mappingStatus.textContent=`에이블리 재고 매핑 확인 실패 · ${state.mappingError||'다시 확인해주세요.'}`;return;}if(state.mappingStatus!=='success'||!state.mapping){mappingStatus.textContent='매핑 확인 대기';return;}const {eligibleCount=0,reviewCount=0,excludedCount=0,reason=''}=state.mapping;mappingStatus.textContent=state.mapping.ready&&eligibleCount?`에이블리 재고 매핑 ${number(eligibleCount)}행 준비됨 · 검토 ${number(reviewCount)} · 제외 ${number(excludedCount)}`:`에이블리 재고 매핑을 확인할 수 없습니다 · ${reason||`검토 ${number(reviewCount)} · 제외 ${number(excludedCount)}`}`;}
 function renderPreview(){
  if(!previewPanel)return;previewPanel.dataset.state=state.previewStatus;
  if(state.previewStatus==='checking'){previewTitle.textContent='재고 반영 미리보기 확인 중';previewMessage.textContent=state.previewError||'읽기 전용으로 파일과 현재 DB를 비교하고 있습니다.';summaryPanel.hidden=true;if(blockedReport)blockedReport.hidden=true;return;}
  if(state.previewStatus==='error'){previewTitle.textContent='재고 반영 미리보기 실패';previewMessage.textContent=state.previewError||'파일 형식과 최신 DB 상태를 확인해주세요.';summaryPanel.hidden=true;if(blockedReport)blockedReport.hidden=true;return;}
  if(state.previewStatus!=='success'||!state.preview){previewTitle.textContent='재고 반영 미리보기';previewMessage.textContent=selectedSellpiaFiles().length?'파일을 읽기 전용으로 비교할 준비 중입니다.':'셀피아 파일을 선택하면 현재 DB와 자동 비교합니다.';summaryPanel.hidden=true;if(blockedReport)blockedReport.hidden=true;return;}
  const counts=state.preview.summary||{};for(const [key,id] of Object.entries(summaryFields)){const node=document.getElementById(id);if(node)node.textContent=number(counts[key]);}
  summaryPanel.hidden=false;const blocked=previewHasBlockers(),unknown=Number(counts.unknownSkuCount||0),blockedRows=state.preview.blockedRows||[],blockedSkus=state.preview.blockedSkus||[],blockedCount=Number(counts.blockedRowCount??blockedRows.length),blockedSkuCount=Number(counts.blockedSkuCount??blockedSkus.length);
  previewTitle.textContent=blocked?'미리보기 완료 · 반영 가능한 SKU 없음':'재고 반영 미리보기 완료';
  previewMessage.textContent=blocked?'유효한 SKU가 없습니다. 파일의 SKU와 재고 값을 확인해주세요.':`${number(counts.changedSkuCount)}개 변경 · ${number(counts.unchangedSkuCount)}개 동일${unknown?` · 미확인 ${number(unknown)}개`:''}${blockedCount?` · 차단 ${number(blockedSkuCount)}개 SKU / ${number(blockedCount)}개 행`:''}. 차단된 SKU만 제외하고 나머지는 계속 처리합니다.`;
  if(blockedReport){blockedReport.hidden=blockedCount===0;blockedReportSummary.textContent=`차단 ${number(blockedSkuCount)}개 SKU · ${number(blockedCount)}개 행`;blockedDownloadButton.disabled=state.busy||blockedCount===0;}
 }
 function invalidateRetry(){state.retryAvailable=false;state.retrySignature='';}
 function invalidatePreview(){state.requestId+=1;state.previewStatus='idle';state.preview=null;state.previewSignature='';state.previewError='';}
 async function refreshMappingReadiness({duringRun=false}={}){
  if(state.busy&&!duringRun)return;
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
  if(state.busy||state.destinationBusy)return;
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
 function renderFiles(output,saveResult){
  const heading=document.createElement('b');heading.textContent='최근 작업 결과';result.append(heading);
  const resultLabel=saveResult?.destination==='directory'?'저장 완료':'다운로드 요청';
  const summary=document.createElement('p');summary.textContent=`판매처 XLSX 4개 ${resultLabel} · 에이블리 재고 수량 변경 ${number(output.ablySummary?.eligibleCount||0)}행`;result.append(summary);
  const list=document.createElement('ul');state.lastDownloadFiles.forEach((entry,index)=>{const item=document.createElement('li'),name=document.createElement('span'),again=document.createElement('button');name.textContent=entry.fileName||entry.name||entry.originalName||'판매처 XLSX';again.type='button';again.className='btn secondary';again.dataset.redownloadIndex=String(index);again.textContent='다시 받기';again.setAttribute('aria-label',`${name.textContent} 다시 받기`);item.append(name,again);list.append(item);});result.append(list);
  if(output.blockedFile){const item=document.createElement('p');item.textContent=`차단 목록 XLSX ${resultLabel} · ${number(output.blockedFile.rowCount||0)}개 행`;result.append(item);}
  if(output.warnings?.length||output.ablySummary?.reviewCount||output.ablySummary?.excludedCount){const note=document.createElement('p');note.textContent=`매핑 검토 ${number(output.ablySummary?.reviewCount||0)}건 · 제외 ${number(output.ablySummary?.excludedCount||0)}건${output.warnings?.length?` · 셀피아 원본 유지 경고 ${number(output.warnings.length)}건`:''}`;result.append(note);}
  result.hidden=false;
 }
 async function blockedFileFor(rows,existing){if(existing)return existing;if(!rows?.length)return null;const helper=global.SystemV3SellpiaInventoryCount;if(typeof helper?.buildBlockedWorkbook!=='function')throw Error('차단 목록 XLSX 생성 기능을 불러오지 못했습니다.');return helper.buildBlockedWorkbook(rows,{XLSX:global.XLSX});}
 async function saveFiles(output,destination){if(!Array.isArray(output?.files)||output.files.length!==4||output.files.some(file=>!file?.blob||!(file.fileName||file.name)))throw Error('판매처 XLSX 4개를 확인하지 못했습니다. 다시 실행해주세요.');const blocked=await blockedFileFor(output.blockedRows||[],output.blockedFile);const files=[...output.files,...(blocked?[{blob:blocked.blob,name:blocked.fileName,fileName:blocked.fileName,source:'blocked',originalName:'차단 목록'}]:[])];const module=global.HubInventoryFileDownloads;if(typeof module?.saveFiles!=='function')throw Error('파일 저장 기능을 불러오지 못했습니다. 새로고침 후 다시 실행해주세요.');const saveResult=await module.saveFiles(files,{destination,onProgress:progressUpdate});return {blocked,saveResult,files};}
 async function refreshDestination(){const module=global.HubInventoryFileDownloads;if(!module?.loadDestination)return;try{state.destination=await module.loadDestination();destinationName.textContent=state.destination?.name||'브라우저 기본 다운로드 폴더';chooseDestinationButton.hidden=state.destination?.supported===false;chooseDestinationButton.disabled=state.destination?.supported===false;clearDestinationButton.hidden=!state.destination?.configured;destinationHint.hidden=false;destinationHint.textContent=state.destination?.supported===false?'폴더 선택을 지원하지 않아 브라우저 기본 다운로드 폴더에 저장합니다.':state.destination?.configured&&state.destination?.persistent===false?'선택 폴더는 현재 브라우저 세션에서만 기억됩니다. 다시 방문하면 폴더를 선택해야 할 수 있습니다.':'';destinationHint.hidden=!destinationHint.textContent;}catch{destinationName.textContent='브라우저 기본 다운로드 폴더';chooseDestinationButton.hidden=false;chooseDestinationButton.disabled=false;clearDestinationButton.hidden=true;destinationHint.hidden=true;}}
 async function downloadPreviewBlocked(){if(state.busy||state.destinationBusy)return;const rows=state.preview?.blockedRows||[];if(!rows.length)return;state.destinationBusy=true;lock(true);try{const module=global.HubInventoryFileDownloads;if(!module?.prepareDestination||!module?.saveFiles)throw Error('파일 저장 기능을 불러오지 못했습니다.');const destination=await module.prepareDestination(),blocked=await blockedFileFor(rows,null);const saved=await module.saveFiles([{blob:blocked.blob,name:blocked.fileName,fileName:blocked.fileName,source:'blocked',originalName:'차단 목록'}],{destination});showStatus(saved?.destination==='directory'?'차단 목록 저장 완료':'차단 목록 다운로드 요청 완료',`${blocked.fileName} · ${number(blocked.rowCount)}개 행`,'success');}catch(error){showStatus('차단 목록 저장 실패',String(error?.message||error),'error');}finally{state.destinationBusy=false;lock(false);}}
 async function downloadFileAgain(index){if(state.busy||state.destinationBusy)return;const file=state.lastDownloadFiles[index];if(!file)return;const module=global.HubInventoryFileDownloads;if(!module?.prepareDestination||!module?.saveFiles)return;state.destinationBusy=true;lock(true);try{const destinationPromise=module.prepareDestination(),destination=await destinationPromise,saved=await module.saveFiles([file],{destination});showStatus(saved?.destination==='directory'?'파일 저장 완료':'다운로드 요청 완료',`${file.fileName||file.name} · ${saved?.destination==='directory'?'저장 완료':'브라우저에 다운로드를 요청했습니다.'}`,'success');}catch(error){showStatus('파일 다시 받기 실패',String(error?.message||error),'error');}finally{state.destinationBusy=false;lock(false);}}
 function progressUpdate(update){const message=typeof update==='string'?update:update?.message||update?.detail||'';if(message)detail.textContent=message;if(Number.isFinite(update?.percent))progress.value=Math.max(0,Math.min(100,update.percent));}
 async function startWork(){
  if(state.busy||state.destinationBusy)return;
  clearResult();progress.hidden=true;
  if(!previewCurrent()){showStatus('재고 반영 중단','최신 셀피아 파일 미리보기를 먼저 완료해주세요.','error');return;}
  if(previewHasBlockers()){showStatus('재고 반영 중단','유효한 SKU가 없어 반영을 시작할 수 없습니다. 차단 목록을 내려받아 확인해주세요.','error');return;}
  if(global.__systemV3DirectExportBusy){showStatus('재고 반영 대기','진행 중인 판매처 내보내기가 끝난 뒤 다시 실행해주세요.');return;}
  const bridge=global.SystemV3SellerExportBridge;
  const files=selectedSellpiaFiles(),expectedPreview=state.preview,source=stockSource(),retry=retryCurrent(),method=retry?'retryInventoryBatchExport':'runInventoryUpdateBatch';
  if(!bridge?.[method]){showStatus('재고 반영 중단','재고 반영 기능을 불러오지 못했습니다. 새로고침 후 다시 실행해주세요.','error');return;}
  const downloadModule=global.HubInventoryFileDownloads;if(typeof downloadModule?.prepareDestination!=='function'){showStatus('재고 반영 중단','브라우저 파일 저장 기능을 불러오지 못했습니다. 새로고침 후 다시 실행해주세요.','error');return;}
  let destinationPromise;try{destinationPromise=downloadModule.prepareDestination();}catch(error){showStatus('재고 반영 중단',String(error?.message||error),'error');return;}
  state.busy=true;lock(true);progress.value=0;progress.hidden=false;
  showStatus(retry?'판매처 파일 다시 생성 중…':'재고 반영 및 판매처 파일 생성 중…','저장 위치와 작업 조건을 확인합니다.','processing');
  try{
   const destination=await destinationPromise;
   await refreshMappingReadiness({duringRun:true});
   if(!mappingsReady()){showStatus('재고 반영 중단',state.mappingError||state.mapping?.reason||'에이블리 재고 매핑을 확인해주세요.','error');return;}
   const output=retry?await bridge.retryInventoryBatchExport({stockSource:source,onProgress:progressUpdate}):await bridge.runInventoryUpdateBatch({files,expectedPreview,stockSource:source,onProgress:progressUpdate});
   let saveBundle;try{saveBundle=await saveFiles(output,destination);}catch(error){if(output?.uploaded===true){error.uploaded=true;error.retryAvailable=true;}throw error;}
   invalidateRetry();progress.value=100;progress.hidden=true;const changed=Number(expectedPreview.summary?.changedSkuCount||0);
   if(saveBundle.blocked)output.blockedFile=saveBundle.blocked;state.lastDownloadFiles=saveBundle.files;
   const savedLabel=saveBundle.saveResult?.destination==='directory'?'저장 완료':'브라우저 다운로드 요청';
   showStatus(changed?'재고 반영 및 판매처 파일 생성 완료':'변경 없이 판매처 파일 생성 완료',`판매처 XLSX 4개 ${savedLabel}${saveBundle.blocked?` · 차단 목록 ${number(saveBundle.blocked.rowCount)}행 포함`:''}${retry?' · DB를 다시 변경하지 않았습니다.':''}`,'success');renderFiles(output,saveBundle.saveResult);
  }catch(error){
   progress.hidden=true;
   if(error?.uploaded===true&&error?.retryAvailable===true){state.retryAvailable=true;state.retrySignature=signature();showStatus('재고 업데이트 완료 · 파일 저장 실패',`DB 재고 반영은 완료됐지만 파일 저장에 실패했습니다. 판매처 파일 다시 생성으로 최신 DB 재고를 읽어 다시 저장할 수 있습니다.\n${String(error?.message||error)}`,'error');}
   else showStatus(retry?'판매처 파일 재생성 실패':'재고 반영 중단',String(error?.message||error),'error');
  }finally{state.busy=false;lock(false);}
 }
 sellpiaPicker.addEventListener('change',()=>{const files=Array.from(sellpiaPicker.files||[]);sellpiaPicker.value='';if(selectionLocked()){showStatus('미리보기 진행 중','파일 비교가 끝난 뒤 파일을 추가하거나 변경해주세요.');return;}addFiles(files);});
 fileList?.addEventListener('click',event=>{const remove=event.target.closest('[data-remove-file]');if(!remove||selectionLocked())return;state.files.splice(Number(remove.dataset.removeFile),1);invalidatePreview();invalidateRetry();clearResult();renderFileStatus();void previewSelectedFiles();});
 clearFilesButton?.addEventListener('click',()=>{if(selectionLocked())return;state.files=[];invalidatePreview();invalidateRetry();clearResult();renderFileStatus();void previewSelectedFiles();});
 dropzone?.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();sellpiaPicker.click();}});
 dropzone?.addEventListener('dragover',event=>{event.preventDefault();if(!selectionLocked())dropzone.dataset.dragging='true';});
 dropzone?.addEventListener('dragleave',event=>{if(!dropzone.contains(event.relatedTarget))delete dropzone.dataset.dragging;});
 dropzone?.addEventListener('drop',event=>{event.preventDefault();delete dropzone.dataset.dragging;addFiles(event.dataTransfer?.files);});
 radios.forEach(radio=>radio.addEventListener('change',()=>{if(!state.busy&&!state.destinationBusy){invalidateRetry();clearResult();updateAction();}}));
 blockedDownloadButton?.addEventListener('click',()=>void downloadPreviewBlocked());
 result.addEventListener('click',event=>{const button=event.target.closest('[data-redownload-index]');if(button&&!button.disabled)void downloadFileAgain(Number(button.dataset.redownloadIndex));});
 chooseDestinationButton?.addEventListener('click',async()=>{if(state.busy||state.destinationBusy)return;const module=global.HubInventoryFileDownloads;if(!module?.chooseDestination)return;state.destinationBusy=true;lock(true);try{state.destination=await module.chooseDestination();await refreshDestination();}catch(error){showStatus('저장 폴더 선택 실패',String(error?.message||error),'error');}finally{state.destinationBusy=false;lock(false);}});
 clearDestinationButton?.addEventListener('click',async()=>{if(state.busy||state.destinationBusy)return;const module=global.HubInventoryFileDownloads;if(!module?.clearDestination)return;state.destinationBusy=true;lock(true);try{await module.clearDestination();await refreshDestination();}catch(error){showStatus('기본 다운로드 위치 설정 실패',String(error?.message||error),'error');}finally{state.destinationBusy=false;lock(false);}});
 button.addEventListener('click',()=>{void startWork();});
 document.addEventListener('click',event=>{if(event.target.closest?.('[data-page="inventory"]'))void refreshMappingReadiness();});
 global.addEventListener('ably-inventory-mappings-changed',()=>{if(!state.busy){invalidateRetry();clearResult();void refreshMappingReadiness();}});
 let authLocked=document.body.classList.contains('operations-auth-locked');
 const authObserver=new MutationObserver(()=>{
  const locked=document.body.classList.contains('operations-auth-locked');
  if(locked===authLocked)return;
  authLocked=locked;if(!locked)void refreshMappingReadiness();
 });authObserver.observe(document.body,{attributes:true,attributeFilter:['class']});
 renderFileStatus();renderPreview();renderMappingStatus();updateAction();void refreshDestination();void refreshMappingReadiness();
})(window);
