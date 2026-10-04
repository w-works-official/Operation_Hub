(function(root){
 'use strict';
 const fields={purchase:{label:'매입가',before:'sellpia_source_purchase_price',after:'sellpia_purchase_price'},base:{label:'기준가격',before:'sellpia_source_sale_price',after:'system_base_price'},stock:{label:'재고',before:'sellpia_source_stock',after:'system_stock'}};
 const parseSkus=text=>[...new Set(String(text||'').split(/[\s,;]+/).map(value=>value.trim()).filter(Boolean))];
 const esc=value=>String(value??'—').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
 function valueFor(row,key){
  if(row.__missing)throw Error('Sellpia 원본에 없는 SKU');
  if(key==='base'){
   const result=row.__hubInternalPrices?.calculated_base_price;
   if(row.__activeBaseOwner||result?.activeOutputRules?.length){
    if(!result||result.error||result.stale||result.provenanceMismatch)throw Error(result?.error||'기준가격 재계산 필요');
    return result.value;
   }
  }
  return row[fields[key].after];
 }
 function buildPreview(rows,keys){
  if(!keys.length||keys.some(key=>!fields[key]))throw Error('지원하는 필드를 하나 이상 선택하세요.');
  const unique=new Map((rows||[]).filter(row=>row.sellpia_sku_code&&!row.__codeListPlaceholder).map(row=>[row.sellpia_sku_code,row]));
  const preview=[],values=[],errors=[],blockedSkus=new Set();
  for(const [sku,row] of unique){
   const exported={sku};
   for(const key of keys){
    let value=null,error='';
    try{
     value=valueFor(row,key);
     if(value===null||value===undefined||value===''||!Number.isSafeInteger(Number(value))||Number(value)<0)throw Error('내보낼 값이 미설정 또는 유효한 정수가 아닙니다.');
     value=Number(value);
    }catch(caught){error=caught.message;errors.push({sku,field:fields[key].label,key,reason:error});}
    const before=row[fields[key].before]??null;
    exported[key]=value;
    const warning=key==='base'&&!row.__activeBaseOwner&&!row.__hubInternalPrices?.calculated_base_price?.activeOutputRules?.length;
    if(error)blockedSkus.add(sku);
    preview.push({sku,key,field:fields[key].label,before,after:value,error,status:error?'차단':warning?'경고':Number(before)===value?'변경 없음':'변경',note:warning?'수식 없음 · 기존 시스템 기준가격 유지':''});
   }
   values.push(exported);
  }
  if(!values.length)throw Error('내보낼 SKU가 없습니다.');
  return {keys,values,preview:[...preview.filter(row=>row.error),...preview.filter(row=>!row.error)],errors,blockedSkus:[...blockedSkus]};
 }
 function blockedWorkbook(blocks){
  const X=root.XLSX;if(!X)throw Error('XLSX 모듈을 불러오지 못했습니다.');if(!blocks.length)throw Error('차단건이 없습니다.');
  const sheet=X.utils.aoa_to_sheet([['Sellpia SKU','필드','현재 원본값','상태','차단 사유'],...blocks.map(row=>[row.sku,row.field,row.before??'','BLOCK',row.reason])]);
  sheet['!cols']=[{wch:20},{wch:14},{wch:16},{wch:10},{wch:56}];sheet['!autofilter']={ref:sheet['!ref']};
  const book=X.utils.book_new();X.utils.book_append_sheet(book,sheet,'차단건');return book;
 }
 function mount(host=document.querySelector('#export-workflow-v2 .export-channel-grid')){
  if(!host?.prepend||document.getElementById('sellpia-patch-panel'))return;
  const panel=document.createElement('article');panel.id='sellpia-patch-panel';panel.className='sellpia-patch-panel';
  panel.innerHTML='<header><h4>SELLPIA · 원본 양식 내보내기</h4><span>저장된 최신 전체 원본 carrier에서 실제 변경 셀만 수정</span></header><div class="patch-columns"><div class="patch-controls"><label>내보내기 방식<select id="sellpia-patch-mode"><option value="full">전체 원본 반영</option><option value="changed_only">변경분만</option></select></label><label>대상 범위<select id="sellpia-patch-scope"><option value="manual">직접 SKU 입력</option><option value="tag">태그 적용 SKU</option><option value="file">파일 A열 SKU</option><option value="search">DB 검색 결과</option></select></label><label id="sellpia-patch-tag-wrap" hidden>태그<select id="sellpia-patch-tag"><option value="">태그 선택</option></select><span id="sellpia-patch-scope-summary"></span></label><label id="sellpia-patch-manual-wrap">SKU 목록<textarea id="sellpia-patch-skus" rows="5" placeholder="5566-1&#10;5566-2 · 줄바꿈 / 쉼표 / 공백"></textarea></label><label id="sellpia-patch-file-wrap" hidden>A열 SKU 파일<input id="sellpia-patch-file" type="file" accept=".xlsx,.xls,.csv"></label><div class="patch-search" id="sellpia-patch-search-wrap" hidden><select id="sellpia-patch-search-type" aria-label="셀피아 검색 유형"><option value="sku">Sellpia SKU</option><option value="own_code">자사코드</option><option value="name">상품/옵션명</option></select><input id="sellpia-patch-search" aria-label="셀피아 검색어"><button class="btn" id="sellpia-patch-search-run">DB 검색</button></div><fieldset><legend>내보낼 필드</legend>'+Object.entries(fields).map(([key,field])=>'<label><input type="checkbox" data-patch-field="'+key+'"'+(key==='base'?' checked':'')+'> '+field.label+'</label>').join('')+'</fieldset><p>매입가는 현재 운영 매입가이며 실입고가와 구분합니다. CSV 원본도 열 구조와 값을 유지한 XLSX로 변환해 변경 셀을 노란색·굵게 표시합니다.</p><div class="patch-actions"><button class="btn" id="sellpia-patch-preview-run">원본 carrier 미리보기</button><button class="btn primary" id="sellpia-patch-download" disabled>파일 다운로드</button><button class="btn patch-blocked-download" id="sellpia-patch-blocked-download" disabled>차단건 XLSX</button><button class="btn" id="sellpia-patch-recalculate">대상 SKU 내부 수식 재계산</button><button class="btn" id="sellpia-patch-reset">초기화</button></div></div><div class="patch-output"><div id="sellpia-patch-status" role="status">최신 Sellpia 전체 원본 carrier 상태를 확인합니다.</div><div class="sellpia-patch-table"><table><thead><tr><th>SKU</th><th>필드</th><th>업로드 원본값</th><th>내보낼 값</th><th>상태</th></tr></thead><tbody id="sellpia-patch-preview"></tbody></table></div><div class="patch-pages"><button class="btn" id="sellpia-patch-prev">이전</button><span id="sellpia-patch-page"></span><button class="btn" id="sellpia-patch-next">다음</button></div></div></div>';
  host.prepend(panel);
  const $=id=>panel.querySelector('#sellpia-patch-'+id);
  let plan=null,prepared=null,output=null,carrierSnapshotId='',stateSnapshotId='',rows=[],page=1,busy=false,proofLoaded=false,fileCodes=[],loadedScope=[];
  const status=text=>{$('status').textContent=text;};
  const combinedBlocks=()=>prepared?.blocks||plan?.errors||[];
  function lock(value){busy=value;panel.querySelectorAll('button,input,select,textarea').forEach(element=>{element.disabled=value;});$('download').disabled=value||!output;$('blocked-download').disabled=value||!combinedBlocks().length;}
  function invalidate(message='대상 변경 · 원본 carrier 미리보기를 다시 실행하세요.'){rows=[];loadedScope=[];plan=null;prepared=null;output=null;carrierSnapshotId='';stateSnapshotId='';$('download').disabled=true;$('blocked-download').disabled=true;$('preview').innerHTML='';$('page').textContent='';status(message);}
  function render(){
   if(!plan)return;
   const blocks=combinedBlocks(),blockKeys=new Set(blocks.map(row=>row.sku+'|'+row.field));
   const display=[...blocks.map(row=>({sku:row.sku,field:row.field,before:row.before,after:'—',status:'차단',error:row.reason})),...plan.preview.filter(row=>!blockKeys.has(row.sku+'|'+row.field))];
   const pages=Math.max(1,Math.ceil(display.length/100));page=Math.min(page,pages);
   $('preview').innerHTML=display.slice((page-1)*100,page*100).map(row=>'<tr'+(row.status==='차단'?' class="patch-error"':'')+'><td>'+esc(row.sku)+'</td><td>'+esc(row.field)+'</td><td>'+esc(row.before)+'</td><td>'+esc(row.after)+'</td><td title="'+esc(row.error||row.note)+'">'+esc(row.error||row.status)+'</td></tr>').join('');
   $('page').textContent=page+' / '+pages+' · '+plan.values.length+' SKU';
   $('download').disabled=busy||!output;$('blocked-download').disabled=busy||!blocks.length;
   $('download').textContent=blocks.length?'정상건 원본 양식 다운로드':'원본 양식 다운로드';$('blocked-download').textContent='차단건 XLSX'+(blocks.length?' '+new Set(blocks.map(row=>row.sku)).size+'건':'');
   if(prepared)status(plan.values.length+' SKU · 가격 변경 '+prepared.priceChangeCount+' / 재고 변경 '+prepared.stockChangeCount+' / 매입가 변경 '+prepared.purchaseChangeCount+' / 경고 상품 '+prepared.warningSkuCount+' / 경고 identity '+prepared.warningIdentityCount+' / scope 제외 '+prepared.excludedIdentityCount);
  }
  async function run(fn){if(busy)return;plan=prepared=output=null;lock(true);const started=Date.now();try{await fn();render();status($('status').textContent+' · '+((Date.now()-started)/1000).toFixed(1)+'초');}catch(error){output=null;status('실패: '+error.message);render();}finally{lock(false);}}
  async function loadTags(){if($('tag').options.length>1)return;const result=await root.SystemV3Data.loadTagCatalog({search:''});$('tag').innerHTML='<option value="">태그 선택</option>'+(result.rows||[]).map(tag=>'<option value="'+esc(tag.tag_id)+'">'+esc(tag.tag_name)+' · '+tag.option_count+' SKU</option>').join('');}
  function summary(){const id=$('tag').value,client=root.HubMatrixClient?.dataset,count=client?.tagSkus(id).length,selected=$('tag').selectedOptions[0];$('scope-summary').textContent=id?selected.textContent+(count!=null?' · client '+count+' SKU':''):'';}
  async function setScope(mode,tagId=null){$('scope').value=mode;for(const key of ['manual','tag','file','search'])$(key+'-wrap').hidden=key!==mode;invalidate();if(mode==='tag'){await loadTags();if(tagId)$('tag').value=tagId;summary();}}
  $('scope').onchange=()=>void setScope($('scope').value);$('tag').onchange=()=>{invalidate();summary();};$('mode').onchange=()=>invalidate('내보내기 방식 변경 · 미리보기를 다시 실행하세요.');$('skus').oninput=()=>invalidate();$('search').oninput=()=>invalidate();$('search-type').onchange=()=>invalidate();
  const globalMode=document.getElementById('export-scope-mode'),globalTag=document.getElementById('export-scope-tag');
  globalMode?.addEventListener('change',()=>void setScope(globalMode.value==='tag'?'tag':'manual',globalTag?.value));globalTag?.addEventListener('change',()=>{if(globalMode?.value==='tag')void setScope('tag',globalTag.value);});
  async function scopeCodes(){
   const mode=$('scope').value;
   if(mode==='tag'){
    const tagId=$('tag').value;if(!tagId)throw Error('태그를 선택하세요.');const all=[];let count=null;
    for(let current=1;;current++){const result=await root.SystemV3Data.loadTagMembers({tagId,page:current,pageSize:1000,search:''});if(count!=null&&count!==Number(result.count))throw Error('태그 적용 범위 변경 · 다시 조회하세요.');count=Number(result.count);all.push(...(result.rows||[]).map(row=>row.sellpia_sku_code));if(all.length>=count)break;if(!(result.rows||[]).length)throw Error('태그 SKU 조회 누락');}
    const codes=[...new Set(all)];if(codes.length!==count)throw Error('태그 SKU 중복/누락');if(!codes.length||codes.length>5000)throw Error('1~5,000 SKU 범위만 지원합니다.');$('scope-summary').textContent=$('tag').selectedOptions[0].textContent+' · 서버 확인 '+codes.length+' SKU';return codes;
   }
   if(mode==='file'){if(!fileCodes.length)throw Error('A열 SKU 파일을 선택하세요.');return fileCodes;}
   if(mode==='search'){if(!loadedScope.length)throw Error('DB 검색을 먼저 실행하세요.');return loadedScope;}
   const codes=parseSkus($('skus').value);if(!codes.length||codes.length>5000)throw Error('1~5,000 SKU를 입력하세요.');return codes;
  }
  const wantsResults=()=>panel.querySelector('[data-patch-field=base]').checked,progress=value=>status('DB 조회 '+value.processed+' / '+value.total+' SKU');
  async function prepareCarrier(carrier){
   plan=buildPreview(rows,[...panel.querySelectorAll('[data-patch-field]:checked')].map(input=>input.dataset.patchField));
   carrierSnapshotId=carrier.snapshotId;stateSnapshotId=carrier.stateSnapshotId||carrier.snapshotId;prepared=await root.SystemV3SellpiaCarrierExport.prepare(carrier.files,plan,$('mode').value);
   if(prepared.changedSkuCount)output=await root.SystemV3SellpiaCarrierExport.build(prepared);
  }
  async function latestCarrier(){return root.SystemV3Data.downloadLatestSellpiaOriginals(value=>status('저장 원본 다운로드 '+value.completed+' / '+value.total));}
  $('preview-run').onclick=()=>run(async()=>{const carrier=await latestCarrier();rows=await root.SystemV3Data.loadSellpiaPatchRows({skus:loadedScope=await scopeCodes(),snapshotId:carrier.snapshotId,stateSnapshotId:carrier.stateSnapshotId||carrier.snapshotId,withResults:proofLoaded=wantsResults(),onProgress:progress});page=1;await prepareCarrier(carrier);});
  $('search-run').onclick=()=>run(async()=>{$('scope').value='search';const search=$('search').value.trim();if(!search)throw Error('검색어를 입력하세요.');const carrier=await latestCarrier();rows=await root.SystemV3Data.loadSellpiaPatchRows({search,searchType:$('search-type').value,snapshotId:carrier.snapshotId,stateSnapshotId:carrier.stateSnapshotId||carrier.snapshotId,withResults:proofLoaded=wantsResults(),onProgress:value=>{if(value.total>5000)throw Error('결과가 5,000 SKU를 넘습니다. 검색어를 좁히세요.');progress(value);}});loadedScope=rows.map(row=>row.sellpia_sku_code);page=1;await prepareCarrier(carrier);});
  $('file').onchange=()=>run(async()=>{const file=$('file').files[0];if(!file)return;const book=root.XLSX.read(await file.arrayBuffer(),{type:'array'}),sheet=book.Sheets[book.SheetNames[0]],range=root.XLSX.utils.decode_range(sheet['!ref']||'A1'),codes=[];for(let row=range.s.r;row<=range.e.r;row++){const cell=sheet['A'+(row+1)];if(!cell||cell.v===null||cell.v===undefined||cell.v==='')continue;if(cell.t==='e')throw Error('A'+(row+1)+' SKU 오류 셀 · Excel error '+cell.v);const value=String(cell.v).trim();if(row===range.s.r&&/^(SKU|Sellpia SKU|셀피아 SKU)$/i.test(value))continue;codes.push(value);}fileCodes=parseSkus(codes.join('\n'));if(fileCodes.length>5000)throw Error('5,000 SKU 범위만 지원합니다.');const carrier=await latestCarrier();rows=await root.SystemV3Data.loadSellpiaPatchRows({skus:loadedScope=await scopeCodes(),snapshotId:carrier.snapshotId,stateSnapshotId:carrier.stateSnapshotId||carrier.snapshotId,withResults:proofLoaded=wantsResults(),onProgress:progress});page=1;await prepareCarrier(carrier);});
  $('recalculate').onclick=()=>run(async()=>{const skus=await scopeCodes(),result=await root.HubPriceMaterializer.materialize({skus,boundedSkus:skus,sources:[],reason:'sellpia-bounded-internal-refresh',onProgress:value=>status('내부 수식 '+value.completedSkus+' / '+value.totalSkus+' SKU · 저장 '+value.persistedRows+' · 오류 '+value.errorRows)});invalidate('내부 재계산 완료 · generation '+result.generationId+' · '+result.completedSkus+' SKU · 미리보기를 다시 실행하세요.');root.dispatchEvent(new CustomEvent('hub-rules-changed',{detail:{persisted:true,affectedSkus:skus}}));});
  panel.querySelectorAll('[data-patch-field]').forEach(input=>input.onchange=()=>invalidate('내보낼 필드 변경 · 미리보기를 다시 실행하세요.'));
  $('prev').onclick=()=>{if(page>1){page--;render();}};$('next').onclick=()=>{if(plan&&page<Math.ceil((plan.preview.length+combinedBlocks().length)/100)){page++;render();}};
  $('reset').onclick=()=>{fileCodes=[];loadedScope=[];$('skus').value='';$('file').value='';$('search').value='';invalidate('SKU를 입력하거나 검색하세요.');lock(false);};
  async function revalidate(){
   if($('scope').value==='tag'){const current=await scopeCodes(),expected=new Set(loadedScope);if(current.length!==loadedScope.length||current.some(sku=>!expected.has(sku))){invalidate();throw Error('태그 assignment가 변경됐습니다. 미리보기를 다시 실행하세요.');}}
   const carrier=await root.SystemV3Data.loadLatestSellpiaOriginalStatus();
   if(!carrier.available||carrier.snapshotId!==carrierSnapshotId||(carrier.stateSnapshotId||carrier.snapshotId)!==stateSnapshotId){invalidate();throw Error('Sellpia 원본 또는 현재 상태가 변경됐습니다. 미리보기를 다시 실행하세요.');}
   const currentRows=await root.SystemV3Data.loadSellpiaPatchRows({skus:loadedScope,snapshotId:carrierSnapshotId,stateSnapshotId,withResults:proofLoaded});
   const currentPlan=buildPreview(currentRows,plan.keys);
   const signature=value=>JSON.stringify(value.preview.map(row=>[row.sku,row.key,row.before,row.after,row.status,row.error,row.note]).sort((a,b)=>String(a[0]+'|'+a[1]).localeCompare(String(b[0]+'|'+b[1]))));
   if(currentPlan.values.length!==plan.values.length||signature(currentPlan)!==signature(plan)){invalidate();throw Error('선택 SKU의 원본값 또는 현재 운영·계산값이 변경됐습니다. 미리보기를 다시 실행하세요.');}
  }
  $('download').onclick=async()=>{try{if(!output||busy)return;lock(true);await revalidate();root.SystemV3SellerExport.downloadBlob(output.blob,output.name);status('정상 원본 양식 생성 완료 · '+prepared.changedSkuCount+' SKU 변경'+(combinedBlocks().length?' · 차단건은 별도 파일로 확인하세요.':''));}catch(error){status(error.message);}finally{lock(false);}};
  $('blocked-download').onclick=async()=>{try{if(!combinedBlocks().length||busy)return;lock(true);await revalidate();root.XLSX.writeFile(blockedWorkbook(combinedBlocks()),'Sellpia_차단건_'+new Date().toISOString().slice(0,10).replace(/-/g,'')+'.xlsx');status('차단 '+new Set(combinedBlocks().map(row=>row.sku)).size+' SKU · 검토 파일 생성 완료');}catch(error){status(error.message);}finally{lock(false);}};
  void root.SystemV3Data.loadLatestSellpiaOriginalStatus().then(carrier=>status(carrier.available?'최신 전체 원본 '+carrier.fileNames.length+'개 보관됨 · 대상 SKU를 선택하세요.':'내보내기 준비 필요: '+carrier.reason)).catch(error=>status('원본 carrier 상태 조회 실패: '+error.message));
 }
 root.SellpiaPatchExport={buildPreview,blockedWorkbook,mount,parseSkus};
})(typeof window!=='undefined'?window:globalThis);
