(function(global){
  'use strict';

  const STATE_VALUES = ['verified','review','conflict'];
  const POLICY_VALUES = ['shared','individual','excluded','review'];
  const HEADER_ALIASES = {
    product: ['상품 번호','상품번호','상품코드'],
    option: ['옵션 번호','옵션번호','옵션코드'],
    solution: ['(신) 솔루션사 고유코드 (셀피아코드)','솔루션사 고유코드 (셀피아코드)','셀피아코드'],
    stock: ['재고수량','재고 수량','재고'],
    safety: ['안전재고','안전 재고']
  };
  const cleanCell = value => value == null ? '' : String(value);
  const identityKey = (product, option) => `${String(product ?? '')}\u001f${String(option ?? '')}`;
  const escapeHtml = value => cleanCell(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const findHeader = (header, aliases) => header.findIndex(value => aliases.includes(cleanCell(value).trim()));
  const intOrNull = value => {
    if (value == null || String(value).trim() === '') return null;
    const normalized = String(value).replace(/,/g,'').trim();
    if (!/^-?\d+$/.test(normalized)) return null;
    const number = Number(normalized);
    return Number.isSafeInteger(number) ? number : null;
  };

  function parseRows(matrix){
    if(!Array.isArray(matrix))throw new Error('워크시트 행 데이터가 없습니다.');
    const headerIndex=matrix.findIndex(row=>Array.isArray(row)&&findHeader(row,HEADER_ALIASES.solution)>=0&&findHeader(row,HEADER_ALIASES.product)>=0&&findHeader(row,HEADER_ALIASES.option)>=0);
    if(headerIndex<0)throw new Error('상품 번호, 옵션 번호, 솔루션사 고유코드 열을 찾지 못했습니다.');
    const header=matrix[headerIndex];
    const columns={product:findHeader(header,HEADER_ALIASES.product),option:findHeader(header,HEADER_ALIASES.option),solution:findHeader(header,HEADER_ALIASES.solution),stock:findHeader(header,HEADER_ALIASES.stock),safety:findHeader(header,HEADER_ALIASES.safety)};
    if(columns.stock<0||columns.safety<0)throw new Error('재고수량 또는 안전재고 열을 찾지 못했습니다.');
    const rows=[];
    for(let index=headerIndex+1;index<matrix.length;index++){
      const row=matrix[index]||[];
      if(row.every(value=>cleanCell(value).trim()===''))continue;
      rows.push({
        product_code:cleanCell(row[columns.product]),
        option_code:cleanCell(row[columns.option]),
        solution_code:cleanCell(row[columns.solution]),
        source_stock:intOrNull(row[columns.stock]),
        safety_stock:intOrNull(row[columns.safety]),
        source_row_no:index+1
      });
    }
    return {header_row_no:headerIndex+1,rows};
  }

  async function parseWorkbook(file){
    if(!global.XLSX?.read||!global.XLSX?.utils?.sheet_to_json)throw new Error('XLSX 판독기를 불러오지 못했습니다.');
    const book=global.XLSX.read(await file.arrayBuffer(),{type:'array',raw:true,cellDates:false});
    const sheetName=book.SheetNames?.[0];
    if(!sheetName)throw new Error('첫 번째 시트를 찾지 못했습니다.');
    return {sheet_name:sheetName,...parseRows(global.XLSX.utils.sheet_to_json(book.Sheets[sheetName],{header:1,raw:true,defval:''}))};
  }

  function candidateFromSolutionCode(solutionCode){
    const exact=cleanCell(solutionCode);
    return exact.startsWith('sellpia_')&&exact.length>8?exact.slice(8):null;
  }

  function classifyRows(rows,{existingMappings=[],manualMappings=existingMappings,matrixStock={},suppressions=[]}={}){
    const identityCounts=new Map(),codeCounts=new Map();
    for(const row of rows||[]){
      const key=identityKey(row.product_code,row.option_code);
      identityCounts.set(key,(identityCounts.get(key)||0)+1);
      if(row.solution_code)codeCounts.set(row.solution_code,(codeCounts.get(row.solution_code)||0)+1);
    }
    const existing=new Map((existingMappings||[]).map(row=>[identityKey(row.product_code,row.option_code),row]));
    const manual=new Map((manualMappings||[]).map(row=>[identityKey(row.product_code,row.option_code),row]));
    const manualOwners=new Map();
    for(const row of manualMappings||[]){
      const key=identityKey(row.product_code,row.option_code),sku=cleanCell(row.sellpia_sku_code);
      if(!sku)continue;
      if(!manualOwners.has(key))manualOwners.set(key,new Set());
      manualOwners.get(key).add(sku);
    }
    const blocked=new Set((suppressions||[]).map(row=>identityKey(row.product_code,row.option_code)));
    return (rows||[]).map(row=>{
      const candidateSku=candidateFromSolutionCode(row.solution_code),key=identityKey(row.product_code,row.option_code),saved=existing.get(key),manualRow=manual.get(key)||saved;
      const ownerCount=manualOwners.get(key)?.size||0;
      const reasons=[];
      if(!row.product_code||!row.option_code)reasons.push('seller_identity_incomplete');
      if(!row.solution_code)reasons.push('solution_code_blank');
      else if(!candidateSku)reasons.push('solution_code_prefix_unrecognized');
      if(identityCounts.get(key)>1)reasons.push('duplicate_seller_identity');
      if(row.solution_code&&codeCounts.get(row.solution_code)>1)reasons.push('duplicate_solution_code');
      const exactExistingMapping=Boolean(manualRow&&manualRow.sellpia_sku_code===candidateSku);
      if(!manualRow)reasons.push('no_exact_manual_identity_match');
      else if(!exactExistingMapping)reasons.push('saved_mapping_differs');
      if(ownerCount>1)reasons.push('ambiguous_manual_identity_owners');
      const currentStock=matrixStock instanceof Map?matrixStock.get(candidateSku):matrixStock?.[candidateSku];
      if(currentStock==null)reasons.push('matrix_stock_missing');
      else if(row.source_stock==null||Number(currentStock)!==Number(row.source_stock))reasons.push('stock_differs');
      if(blocked.has(key)||saved?.suppression_active||manualRow?.suppression_active)reasons.push('legacy_suppression_active');
      if(saved?.solution_code&&saved.solution_code!==row.solution_code)reasons.push('source_solution_code_changed');
      const conflict=reasons.includes('duplicate_seller_identity')||reasons.includes('ambiguous_manual_identity_owners');
      const trustedMapping=Boolean(manualRow&&(manualRow.mapping_state==='verified'||manualRow.mapping_origin==='manual'||manualRow.mappingOrigin==='manual'));
      const fullyConfirmed=Boolean(candidateSku&&exactExistingMapping&&trustedMapping&&reasons.length===0);
      return {...row,candidate_sku_code:candidateSku,mapping_state:conflict?'conflict':fullyConfirmed?'verified':'review',review_reasons:reasons};
    });
  }

  function summarize(rows){
    const counts={total:rows.length,verified:0,review:0,conflict:0,blank_code:0,duplicate_code:0,stock_differs:0,suppressed:0,missing_identity:0,inverse_owner_conflicts:0};
    for(const row of rows){
      counts[row.mapping_state]=(counts[row.mapping_state]||0)+1;
      if(!row.solution_code)counts.blank_code++;
      if(row.review_reasons?.includes('duplicate_solution_code'))counts.duplicate_code++;
      if(row.review_reasons?.includes('stock_differs'))counts.stock_differs++;
      if(row.review_reasons?.includes('legacy_suppression_active'))counts.suppressed++;
      if(row.review_reasons?.includes('seller_identity_incomplete'))counts.missing_identity++;
      if(row.review_reasons?.includes('ambiguous_manual_identity_owners'))counts.inverse_owner_conflicts++;
    }
    return counts;
  }

  function renderRows(rows){
    return rows.slice(0,250).map((row,index)=>`<tr><td>${escapeHtml(row.product_code)}</td><td>${escapeHtml(row.option_code)}</td><td>${escapeHtml(row.solution_code)}</td><td>${escapeHtml(row.candidate_sku_code||row.sellpia_sku_code||'')}</td><td>${escapeHtml(row.source_stock??'')}</td><td>${escapeHtml(row.mapping_state||'review')}</td><td>${escapeHtml((row.review_reasons||[]).join(', '))}</td><td><button type="button" data-edit-index="${index}">수정</button></td></tr>`).join('');
  }

  async function render(container,{data=global.SystemV3Data}={}){
    if(!container)throw new Error('에이블리 매핑 관리 영역을 찾지 못했습니다.');
    if(!data?.loadAblyInventoryMappings||!data?.importAblyInventoryMappings||!data?.updateAblyInventoryMapping){
      container.innerHTML='<p role="status">에이블리 매핑 저장 RPC가 준비되지 않았습니다.</p>';return;
    }
    container.innerHTML=`<div class="ably-mapping-toolbar"><label>에이블리 원본 파일 <input type="file" id="ably-map-file" accept=".xlsx,.xls"></label><button type="button" id="ably-map-preview">미리보기</button><button type="button" id="ably-map-import" disabled>후보 저장</button><button type="button" id="ably-map-refresh">목록 새로고침</button></div><p id="ably-map-status" role="status">파일을 선택하면 서버 쓰기 없이 미리보기합니다. 저장은 후보 레코드만 추가하며 기존 수정값과 연결 억제를 변경하지 않습니다.</p><p id="ably-map-summary"></p><label>매핑 검색 <input type="search" id="ably-map-search" placeholder="상품 번호, 옵션 번호, 솔루션 코드, SKU, 상태"></label><p id="ably-map-list-count"></p><div style="max-height:420px;overflow:auto"><table><thead><tr><th>상품 번호 (A)</th><th>옵션 번호 (H)</th><th>솔루션 코드 (J, 원문)</th><th>후보 SKU</th><th>원본 재고 N</th><th>상태</th><th>검토 사유</th><th></th></tr></thead><tbody id="ably-map-rows"></tbody></table></div><dialog id="ably-map-edit-dialog"><form id="ably-map-edit-form"><h3>에이블리 매핑 확인</h3><p id="ably-map-edit-identity"></p><label>연결된 Sellpia SKU <input id="ably-map-edit-sku" required></label><label>매핑 상태 <select id="ably-map-edit-state"><option value="verified">연결 확인됨</option><option value="review">검토 필요</option><option value="conflict">충돌</option></select></label><label>재고 정책 <select id="ably-map-edit-policy"><option value="shared">공유 재고 사용</option><option value="individual">개별 수량 사용</option><option value="excluded">재고 자동 반영 제외</option><option value="review">재고 정책 검토</option></select></label><label>개별 재고 수량 <input id="ably-map-edit-stock" type="number" min="0" step="1"></label><label><input id="ably-map-edit-active" type="checkbox"> 내보내기 대상 사용</label><label>수정 사유 <textarea id="ably-map-edit-reason" required rows="3"></textarea></label><div><button type="button" id="ably-map-edit-cancel">취소</button><button type="submit">수정 저장</button></div></form></dialog>`;
    const $=selector=>container.querySelector(selector),status=$('#ably-map-status'),rowsBody=$('#ably-map-rows');
    let workbook=null,sourceFile=null,current=[],renderedRows=[],allRows=[],editingRow=null,previewRevision=0,importing=false;
    const load=async()=>{
      const result=await data.loadAblyInventoryMappings();
      if(global.document.body.classList.contains('operations-auth-locked')){current=[];return result;}
      current=result?.rows||[];status.textContent=`저장된 에이블리 매핑 ${current.length.toLocaleString('ko-KR')}건을 조회했습니다. 원본 파일은 미리보기 후 저장할 수 있습니다.`;return result;
    };
    const renderList=rows=>{
      allRows=rows;const query=$('#ably-map-search').value.trim().toLocaleLowerCase();
      const filtered=query?allRows.filter(row=>[row.product_code,row.option_code,row.solution_code,row.sellpia_sku_code,row.candidate_sku_code,row.mapping_state,(row.review_reasons||[]).join(' ')].join(' ').toLocaleLowerCase().includes(query)):allRows;
      renderedRows=filtered.slice(0,250);rowsBody.innerHTML=renderRows(renderedRows);
      $('#ably-map-list-count').textContent=`표시 ${renderedRows.length}행 / 검색 결과 ${filtered.length}행 (화면 표시 한도 250행)`;
    };
    const preview=async()=>{
      if(importing)return;
      const file=$('#ably-map-file').files?.[0];if(!file){status.textContent='에이블리 원본 파일을 선택하세요.';return;}
      const revision=++previewRevision;workbook=null;sourceFile=null;$('#ably-map-import').disabled=true;
      try{
        const parsedWorkbook=await parseWorkbook(file);if(revision!==previewRevision)return;
        status.textContent='현재 Matrix 재고와 판매처 매핑을 읽어 미리보기 검증 중입니다.';
        let manualMappings=[],matrixStock={},suppressions=current.filter(row=>row.suppression_active);
        if(data.loadAblyInventoryMappingContext){
          const context=await data.loadAblyInventoryMappingContext({rows:parsedWorkbook.rows});
          manualMappings=context?.manualMappings||[];matrixStock=context?.matrixStock||{};suppressions=context?.suppressions||suppressions;
        }else if(data.loadMatrixGridDataset){
          const matrix=await data.loadMatrixGridDataset();
          for(const row of matrix.rows||[]){
            if(row.sellpia_sku_code)matrixStock[row.sellpia_sku_code]=row.sellpia_current_stock??null;
            if(row.ably_product_code){manualMappings.push({product_code:row.ably_product_code,option_code:row.ably_option_code||'',sellpia_sku_code:row.sellpia_sku_code,mapping_origin:'manual'});}
          }
        }
        if(revision!==previewRevision)return;
        const classified=classifyRows(parsedWorkbook.rows,{existingMappings:current,manualMappings,matrixStock,suppressions});
        workbook=parsedWorkbook;sourceFile=file;
        workbook.classified_rows=classified;renderList(classified);
        const counts=summarize(classified);$('#ably-map-summary').textContent=`총 ${counts.total}행 · verified ${counts.verified} · review ${counts.review} · conflict ${counts.conflict} · 중복 코드 ${counts.duplicate_code} · 재고 불일치 ${counts.stock_differs} · 억제 ${counts.suppressed}`;
        $('#ably-map-import').disabled=false;status.textContent=`미리보기 완료 · ${file.name} · 이 계산은 사전 검토이며 저장 RPC가 실제 매핑·재고·중복·억제를 다시 확인합니다. 후보 코드는 원문 J의 sellpia_ 접두부만 제거해 추출했으며 나머지 문자는 그대로 보존합니다.`;
      }catch(error){if(revision!==previewRevision)return;workbook=null;sourceFile=null;$('#ably-map-import').disabled=true;status.textContent=error?.message||String(error);}
    };
    $('#ably-map-file').addEventListener('change',()=>{
      ++previewRevision;workbook=null;sourceFile=null;$('#ably-map-import').disabled=true;
      $('#ably-map-summary').textContent='';renderList(current);status.textContent='원본 파일이 변경됐습니다. 미리보기 후 저장해주세요.';
    });
    $('#ably-map-preview').addEventListener('click',()=>void preview());
    $('#ably-map-search').addEventListener('input',()=>renderList(allRows));
    $('#ably-map-refresh').addEventListener('click',async()=>{try{await load();renderList(current);status.textContent=`저장 목록 ${current.length}건을 불러왔습니다.`;}catch(error){status.textContent=error?.message||String(error);}});
    $('#ably-map-import').addEventListener('click',async()=>{
      if(importing||!workbook||!sourceFile)return;
      const importingFile=sourceFile,importingRows=workbook.rows;importing=true;++previewRevision;
      $('#ably-map-file').disabled=true;$('#ably-map-preview').disabled=true;
      const button=$('#ably-map-import');button.disabled=true;status.textContent='서버에서 현재 매핑·재고·중복·억제 조건을 다시 검증하고 있습니다.';
      try{
        const bytes=await importingFile.arrayBuffer(),digest=await global.crypto.subtle.digest('SHA-256',bytes),sha256=[...new Uint8Array(digest)].map(byte=>byte.toString(16).padStart(2,'0')).join('');
        const result=await data.importAblyInventoryMappings({batchKey:sha256,fileName:importingFile.name,sha256,rows:importingRows});
        await load();renderList(current);status.textContent=`서버 저장 완료 · ${JSON.stringify(result)}`;$('#ably-map-summary').textContent=`저장 후 읽은 매핑 ${current.length}건 · SHA-256 ${sha256}`;
      }catch(error){status.textContent=error?.message||String(error);button.disabled=!workbook||!sourceFile;}
      finally{importing=false;$('#ably-map-file').disabled=false;$('#ably-map-preview').disabled=false;}
    });
    rowsBody.addEventListener('click',event=>{
      const button=event.target.closest('[data-edit-index]');if(!button)return;
      editingRow=renderedRows[Number(button.dataset.editIndex)];if(!editingRow)return;
      $('#ably-map-edit-identity').textContent=`상품 ${editingRow.product_code} · 옵션 ${editingRow.option_code} · 원문 코드 ${editingRow.solution_code}`;
      $('#ably-map-edit-sku').value=editingRow.sellpia_sku_code||editingRow.candidate_sku_code||'';
      $('#ably-map-edit-state').value=STATE_VALUES.includes(editingRow.mapping_state)?editingRow.mapping_state:'review';
      $('#ably-map-edit-policy').value=POLICY_VALUES.includes(editingRow.stock_policy)?editingRow.stock_policy:'review';
      $('#ably-map-edit-stock').value=editingRow.individual_stock??'';
      $('#ably-map-edit-active').checked=Boolean(editingRow.is_active);
      $('#ably-map-edit-reason').value='';
      const dialog=$('#ably-map-edit-dialog');if(dialog.showModal)dialog.showModal();else dialog.setAttribute('open','');
    });
    $('#ably-map-edit-cancel').addEventListener('click',()=>$('#ably-map-edit-dialog').close?.());
    $('#ably-map-edit-form').addEventListener('submit',async event=>{
      event.preventDefault();if(!editingRow)return;
      const qtyText=$('#ably-map-edit-stock').value.trim(),qty=qtyText===''?null:intOrNull(qtyText);
      if(qtyText!==''&&qty===null){status.textContent='개별 재고 수량을 정수로 입력하세요.';return;}
      const button=$('#ably-map-edit-form').querySelector('[type="submit"]');button.disabled=true;
      try{
        await data.updateAblyInventoryMapping({...editingRow,sellpia_sku_code:$('#ably-map-edit-sku').value.trim(),mapping_state:$('#ably-map-edit-state').value,
          stock_policy:$('#ably-map-edit-policy').value,individual_stock:qty,is_active:$('#ably-map-edit-active').checked,reason:$('#ably-map-edit-reason').value.trim()});
        $('#ably-map-edit-dialog').close?.();await load();renderList(current);status.textContent='매핑 변경을 감사 이력과 함께 저장했습니다.';
      }catch(error){status.textContent=error?.message||String(error);}finally{button.disabled=false;}
    });
    const isLocked=()=>global.document.body.classList.contains('operations-auth-locked');
    let wasLocked=isLocked();
    const authObserver=new global.MutationObserver(()=>{
      const locked=isLocked();
      if(locked){++previewRevision;workbook=null;sourceFile=null;$('#ably-map-import').disabled=true;current=[];renderList([]);status.textContent='운영 로그인 후 매핑을 조회할 수 있습니다.';}
      else if(wasLocked){void load().then(()=>renderList(current)).catch(error=>{status.textContent=error?.message||String(error);});}
      wasLocked=locked;
    });
    authObserver.observe(global.document.body,{attributes:true,attributeFilter:['class']});
    if(wasLocked){status.textContent='운영 로그인 후 매핑을 조회할 수 있습니다.';}
    else{try{await load();renderList(current);}catch(error){status.textContent=`저장 목록을 불러오지 못했습니다: ${error?.message||error}`;}}
  }

  global.AblyMappingManagement=Object.freeze({parseRows,parseWorkbook,candidateFromSolutionCode,classifyRows,summarize,render});
  if(global.document){
    const autoMount=()=>{const node=global.document.getElementById('ably-mapping-management');if(node&&!node.dataset.mappingInitialized){node.dataset.mappingInitialized='true';void render(node);}};
    if(global.document.readyState==='loading')global.document.addEventListener('DOMContentLoaded',autoMount,{once:true});else autoMount();
  }
})(window);
