/* Date-based order stock operations. Picking is a read-only data source. */
(function(global) {
  'use strict';
  const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function plan(rows,mode='deduct') {
    const groups=new Map(),excluded=[];
    for(const row of rows) {
      if(row.reason) {excluded.push(row);continue;}
      const quantity=Number(row.quantity),applied=Number(row.applied),before=Number(row.before);
      if(!Number.isSafeInteger(quantity)||quantity<=0||!Number.isSafeInteger(before)||row.before===null) {excluded.push({...row,reason:'수량 또는 현재재고 확인 필요'});continue;}
      if(mode==='included' && row.ledger_revision!=='0') {excluded.push({...row,reason:'이미 반영된 주문'});continue;}
      if(-quantity===applied) {excluded.push({...row,reason:'이미 반영됨'});continue;}
      const group=groups.get(row.sku)||{sku:row.sku,before,delta:0,rows:[]};
      group.delta+=mode==='included'?0:-quantity-applied;group.rows.push(row);groups.set(row.sku,group);
    }
    const cells=[];
    for(const group of groups.values()) {
      group.after=group.before+group.delta;
      if(group.after<0||group.after>2147483647) excluded.push(...group.rows.map(row=>({...row,reason:'현재재고 부족 또는 수량 초과'})));
      else cells.push(group);
    }
    return {cells,rows:cells.flatMap(cell=>cell.rows),excluded};
  }
  global.OperationsOrderStockModel={plan};
  if(!global.document) return;
  const page=document.getElementById('inventory');
  [...page.children].forEach(el=>{el.hidden=true;});
  const shell=document.createElement('section');shell.className='order-stock';page.append(shell);
  shell.innerHTML=`<div class="page-head"><div><h2>재고조사 · 접수 주문</h2><p>접수일별 주문을 확인하고 선택한 주문만 현재재고에 반영합니다.</p></div><button class="btn" id="order-history-open">반영 이력</button></div>
    <section class="panel order-stock-controls"><div class="order-stock-query"><label>접수일 <input id="order-stock-date" type="date"></label><button class="btn primary" id="order-stock-load">주문 조회</button><label>SKU 검색 <input id="order-stock-search" placeholder="현재 페이지에서 찾기"></label><select id="order-stock-filter" aria-label="반영 상태"><option value="all">전체 상태</option><option value="new">미반영</option><option value="done">이미 반영</option><option value="issue">확인 필요</option></select></div>
    <p class="order-stock-note">셀피아 원본에 이미 포함된 주문은 <b>이미 원본에 포함</b>으로 기록하세요. 이 처리는 재고를 차감하지 않습니다. 시간으로 반영 여부를 추측하지 않습니다.</p>
    <div id="order-stock-status" role="status">접수일을 선택해 주문을 조회하세요.</div></section>
    <section class="panel"><div class="order-stock-selection"><button class="btn" id="order-stock-select">현재 목록의 미반영 선택</button><button class="btn" id="order-stock-clear">선택 해제</button><span id="order-stock-count">0건</span><span class="spacer"></span><button class="btn" id="order-stock-prev">이전 200건</button><button class="btn" id="order-stock-next">다음 200건</button></div>
    <div class="order-stock-table"><table class="data-table"><thead><tr><th>선택</th><th>주문항목</th><th>SKU · 상품</th><th>접수일</th><th>주문 상태</th><th>주문 수량</th><th>현재재고</th><th>반영 상태</th></tr></thead><tbody id="order-stock-body"></tbody></table></div></section>
    <section class="panel order-stock-preview"><div class="order-stock-selection"><b>선택 주문 미리보기</b><label>처리 <select id="order-stock-mode"><option value="deduct">미반영 수량 차감</option><option value="included">이미 원본에 포함 · 재고 유지</option></select></label><span class="spacer"></span><button class="btn primary" id="order-stock-apply" disabled>선택 주문 적용</button><button class="btn" id="order-stock-retry" hidden>같은 요청 결과 확인 / 재시도</button></div><div id="order-stock-preview"></div></section>
    <section class="panel order-stock-result" id="order-stock-result" hidden aria-live="polite"></section>
    <section class="panel order-stock-history" id="order-stock-history" hidden></section>`;
  const el=id=>document.getElementById('order-stock-'+id);
  el('date').value=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Seoul'}).format(new Date());
  let rows=[],offset=0,hasMore=false,loadedDate='',busy=false,pending=null,loaded=false;
  const selected=new Set();
  const status=message=>{el('status').textContent=message;};
  const done=row=>Number(row.applied)===-Number(row.quantity);
  const visible=()=>rows.filter(row=>(!el('search').value||row.sku.includes(el('search').value.trim()))&&
    (el('filter').value==='all'||el('filter').value==='done'&&done(row)||el('filter').value==='new'&&!row.reason&&!done(row)||el('filter').value==='issue'&&Boolean(row.reason)));
  function setBusy(value){busy=value;render();}
  function render() {
    const shown=visible();
    el('body').innerHTML=shown.length?shown.map(row=>`<tr><td><input type="checkbox" data-order-id="${escape(row.id)}" aria-label="${escape(row.id)} 선택" ${selected.has(row.id)?'checked':''} ${row.reason||done(row)||busy||pending?'disabled':''}></td><td class="order-stock-id">${escape(row.id)}</td><td><b>${escape(row.sku)}</b><small class="order-product">${escape(row.product_name)}<br>${escape(row.option_name)}</small></td><td>${escape(row.date)}</td><td>${escape(row.source_status)}</td><td>${escape(row.quantity)}</td><td>${escape(row.before??'미설정')}</td><td class="${row.reason?'issue':done(row)?'done':''}">${escape(row.reason|| (done(row)?'이미 반영':row.ledger_revision!=='0'?'수량 변경 · 차이만 반영':'미반영'))}</td></tr>`).join(''):'<tr><td colspan="8" class="order-stock-empty">조회된 주문이 없습니다.</td></tr>';
    const preview=plan(rows.filter(row=>selected.has(row.id)),el('mode').value);
    el('count').textContent=`${loadedDate||el('date').value} · ${offset+1}번째부터 ${rows.length}건 · 표시 ${shown.length}건 · 선택 ${selected.size}건`;
    el('preview').innerHTML=preview.cells.length?`<table class="data-table"><thead><tr><th>SKU</th><th>현재</th><th>증감</th><th>반영 후</th></tr></thead><tbody>${preview.cells.map(cell=>`<tr><td>${escape(cell.sku)}</td><td>${cell.before}</td><td>${cell.delta>0?'+':''}${cell.delta}</td><td><b>${cell.after}</b></td></tr>`).join('')}</tbody></table>`:'<p>목록에서 반영할 주문을 선택하세요.</p>';
    if(preview.excluded.length) el('preview').innerHTML+=`<p class="issue">제외 ${preview.excluded.length}건: ${preview.excluded.map(row=>`${escape(row.sku)} · ${escape(row.reason)}`).join(', ')}</p>`;
    for(const id of ['date','load','search','filter','select','clear','mode','prev','next']) el(id).disabled=busy||Boolean(pending);
    el('prev').disabled=busy||Boolean(pending)||offset===0;el('next').disabled=busy||Boolean(pending)||!hasMore;
    el('apply').disabled=busy||Boolean(pending)||!preview.rows.length||loadedDate!==el('date').value;
    el('apply').textContent=el('mode').value==='included'?`${preview.rows.length}건 원본 포함 기록`:`${preview.rows.length}건 재고 반영`;
    el('retry').hidden=!pending;el('retry').disabled=busy;
    document.getElementById('order-history-open').disabled=busy||Boolean(pending);
    shell.querySelectorAll('[data-inventory-undo]').forEach(button=>{button.disabled=busy||Boolean(pending);});
  }
  async function load(newOffset=0) {
    if(busy||pending)return;
    const date=el('date').value;
    if(!/^\d{4}-\d{2}-\d{2}$/.test(date)){status('접수일을 선택하세요.');return;}
    selected.clear();rows=[];hasMore=false;loadedDate='';setBusy(true);status('접수 주문과 반영 이력을 조회하고 있습니다.');
    try {
      const result=await global.SystemV3Data.listOrderStock({date,offset:newOffset});
      rows=result.rows||[];offset=newOffset;hasMore=Boolean(result.has_more);loadedDate=date;loaded=true;
      status(`${date} 접수 주문상품 ${rows.length}건 조회${hasMore?' · 다음 페이지가 있습니다.':''}. 조회만으로 재고는 바뀌지 않습니다.`);
    } catch(error){status(`주문 조회 실패: ${error.message}`);}
    finally{setBusy(false);}
  }
  function report(result) {
    el('result').hidden=false;
    const items=result.items||[],saved=items.filter(item=>item.status==='saved');
    el('result').innerHTML=`<b>${result.status==='undone'?'이미 실행취소된 요청입니다.':`처리 완료 · 반영 ${saved.length} SKU · 제외/동일 ${items.length-saved.length}건`}</b><ul>${items.map(item=>`<li>${escape(item.sku)}: ${item.status==='saved'?`${item.before} → ${item.after}`:escape(item.reason)}</li>`).join('')}</ul>`;
  }
  async function apply() {
    if(busy)return;
    if(!pending) {
      const preview=plan(rows.filter(row=>selected.has(row.id)),el('mode').value);
      if(!preview.rows.length||loadedDate!==el('date').value)return;
      pending={actionId:crypto.randomUUID(),date:loadedDate,mode:el('mode').value,excluded:preview.excluded,rows:preview.rows.map(row=>({
        id:row.id,sku:row.sku,source_hash:row.source_hash,before:row.before,stock_revision:row.stock_revision,ledger_revision:row.ledger_revision}))};
    }
    setBusy(true);status('선택한 주문을 재확인하고 재고와 반영 이력을 저장하고 있습니다.');
    let result;
    try {result=await global.SystemV3Data.saveOrderStock(pending);}
    catch(error){status(`응답 확인 필요: ${error.message}. 같은 요청으로 결과 확인 또는 재시도할 수 있습니다.`);setBusy(false);return;}
    result={...result,items:[...(result.items||[]),...(pending.excluded||[]).map(row=>({sku:row.sku,status:'excluded',reason:row.reason}))]};
    pending=null;report(result);selected.clear();setBusy(false);
    global.OperationsWorkspaceActions?.unjournaledEdit();
    await load(offset);await history();
    global.dispatchEvent(new CustomEvent('operations-stock-changed'));
  }
  async function history() {
    if(busy||pending)return;setBusy(true);el('history').hidden=false;
    try {
      const actions=await global.SystemV3Data.listStockHistory();
      el('history').innerHTML=`<h3>최근 반영 이력</h3><p>본인의 최근 30개 작업입니다. 이후 재고가 수정된 작업은 덮어쓰지 않고 실행취소를 멈춥니다.</p>`+(actions.length?actions.map(action=>`<article><span>${escape(new Date(action.created_at).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'}))} · ${action.kind==='included'?'원본 포함 기록':'주문 재고 반영'} · ${(action.items||[]).filter(i=>i.status==='saved').length} SKU · ${action.status==='undone'?'취소됨':'저장됨'}</span>${action.status==='saved'?`<button class="btn" data-inventory-undo="${escape(action.action_id)}">이 작업 실행취소</button>`:''}</article>`).join(''):'<p>반영 이력이 없습니다.</p>');
    }catch(error){el('history').textContent=`이력 조회 실패: ${error.message}`;}
    finally{setBusy(false);}
  }
  async function undo(id) {
    if(busy||pending)return;setBusy(true);
    try {
      const result=await global.SystemV3Data.undoOrderStock(id);
      el('result').hidden=false;el('result').textContent=result.status==='undone'?'재고와 주문 반영 이력을 함께 되돌렸습니다.':result.reason;
    }catch(error){el('result').hidden=false;el('result').textContent=`실행취소 결과 확인 필요: ${error.message}. 같은 작업의 실행취소를 다시 누르면 결과를 확인합니다.`;}
    finally{setBusy(false);}
    await load(offset);await history();global.OperationsWorkspaceActions?.unjournaledEdit();global.dispatchEvent(new CustomEvent('operations-stock-changed'));
  }
  el('body').addEventListener('change',event=>{const id=event.target.dataset.orderId;if(!id)return;event.target.checked?selected.add(id):selected.delete(id);render();});
  el('load').onclick=()=>load(0);el('date').onchange=()=>{selected.clear();rows=[];loadedDate='';hasMore=false;render();status('선택한 접수일의 주문을 조회하세요.');};
  el('search').oninput=el('filter').onchange=()=>{selected.clear();render();};
  el('select').onclick=()=>{visible().filter(row=>!row.reason&&!done(row)).forEach(row=>selected.add(row.id));render();};
  el('clear').onclick=()=>{selected.clear();render();};el('mode').onchange=render;
  el('prev').onclick=()=>load(Math.max(0,offset-200));el('next').onclick=()=>load(offset+200);
  el('apply').onclick=el('retry').onclick=apply;document.getElementById('order-history-open').onclick=history;
  el('history').addEventListener('click',event=>{const id=event.target.closest('[data-inventory-undo]')?.dataset.inventoryUndo;if(id)void undo(id);});
  global.OperationsOrderStock={open:()=>{if(!loaded&&!busy)void load(0);},refresh:()=>load(offset)};
  render();
})(typeof window==='undefined'?globalThis:window);
