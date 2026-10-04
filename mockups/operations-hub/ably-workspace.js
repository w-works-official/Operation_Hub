(function(g){
 'use strict';
 const $=id=>document.getElementById(id),esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const api=(action,doc)=>g.SystemV3Data.workDocument(action,'ably',doc);
 const home=$('ably-products-home'),panel=document.createElement('section');panel.className='panel ably-workspace';panel.hidden=true;$('ably-combinations').append(panel);
 const saved=document.createElement('section');saved.className='panel ably-saved';saved.innerHTML='<div class="ably-section-head"><h3>저장된 상품</h3><button class="btn" id="ably-saved-refresh">목록 새로고침</button></div><p id="ably-saved-status" role="status"></p><div id="ably-saved-list"></div>';home.prepend(saved);
 const importButton=document.createElement('button');importButton.className='btn';importButton.textContent='불러온 엑셀 상품 저장';$('ably-combination-file').parentElement.after(importButton);
 let imported=false,doc={},rows=[],products=[],selected=new Set(),template=null,dirty=false,busy=false,page=0,importGroup=null,sourceLines=null,initialForm={};
 const status=t=>$('aw-status').textContent=t;
 function lock(v){busy=v;panel.querySelectorAll('button,input,select,textarea').forEach(x=>x.disabled=v);}
 function form(){return Object.fromEntries(['title','account','code','price','size','option1','option2','option3'].map(k=>[k,$('aw-'+k).value]));}
 function shell(){panel.innerHTML=`<div class="ably-section-head"><div><button class="btn" id="aw-back">← 상품 목록</button><h2>조합 상품 편집</h2></div><div class="ably-actions"><button class="btn primary" id="aw-save">상품 저장</button><button class="btn" id="aw-download">XLSX 다운로드</button></div></div>
 <p id="aw-status" role="status">상품 선택 후 조합 미리보기를 생성하세요.</p>
 <section class="ably-form-grid"><label>온라인 상품명<input id="aw-title" maxlength="200"></label><label>계정<input id="aw-account" readonly></label><input id="aw-code" type="hidden"><p>판매자관리코드는 아래 각 행에서 생성·수정하며 저장과 다운로드에 그대로 사용합니다.</p><label>판매가<input id="aw-price" readonly placeholder="조합별 기준가격 합산 · 아래 표에서 확인"></label><label>조합 방식<select id="aw-size"><option value="2">1+1</option><option value="3">1+1+1</option></select></label><label>옵션1 명칭<input id="aw-option1" value="옵션1"></label><label>옵션2 명칭<input id="aw-option2" value="옵션2"></label><label id="aw-option3-wrap">옵션3 명칭<input id="aw-option3" value="옵션3"></label></section>
 <div class="ably-template"><b>에이블리 기본 XLSX 양식 자동 적용</b><span id="aw-template-name">별도 템플릿 선택 없이 다운로드할 수 있습니다.</span></div>
 <details class="ably-select-panel" open><summary>구성 상품 선택</summary><div class="ably-search-row"><label>SKU 목록<textarea id="aw-codes" rows="3" placeholder="SKU를 줄바꿈 또는 쉼표로 구분"></textarea></label><label>상품 검색<input id="aw-search" placeholder="상품명 또는 SKU"><button class="btn" id="aw-search-run">검색</button></label></div><div class="ably-actions"><button class="btn" id="aw-load">SKU 조회</button><button class="btn" id="aw-all">전체 선택</button><button class="btn" id="aw-none">선택 해제</button></div><div id="aw-products" class="ably-product-grid"></div></details>
 <div class="ably-section-head"><div><h3>조합 미리보기</h3><span id="aw-count"></span></div><div class="ably-actions"><button class="btn primary" id="aw-generate">선택 상품으로 조합 생성</button><button class="btn" id="aw-stock">현재재고 갱신</button></div></div><p>구성 상품 변경은 조합 생성 버튼을 누르면 반영됩니다. 저장 후에도 수정할 수 있습니다.</p><input id="aw-filter" type="search" placeholder="옵션 값 또는 SKU 검색"><div class="ably-table-scroll"><table class="data-table"><thead><tr><th>옵션1</th><th>옵션2</th><th>옵션3</th><th>판매자관리코드</th><th>연결 SKU (Q)</th><th>판매가</th><th>재고</th></tr></thead><tbody id="aw-rows"></tbody></table></div><div class="ably-pagination"><button class="btn" id="aw-prev">이전</button><span id="aw-page"></span><button class="btn" id="aw-next">다음</button></div>`;
 $('aw-back').onclick=()=>{if(dirty&&!g.confirm('저장하지 않은 변경이 있습니다. 목록으로 나갈까요?'))return;panel.hidden=true;home.hidden=false;void list();};
 panel.querySelectorAll('.ably-form-grid input,.ably-form-grid select').forEach(x=>x.oninput=()=>{dirty=true;$('aw-option3-wrap').hidden=$('aw-size').value!=='3';});
 $('aw-load').onclick=()=>run(async()=>{const codes=[...new Set($('aw-codes').value.split(/[\s,]+/).filter(Boolean))];if(!codes.length||codes.length>100)throw Error('SKU를 1~100개 입력하세요.');products=await g.SystemV3Data.loadAblyComponentStocks(codes);selected=new Set(products.map(p=>p.sellpia_sku_code));renderProducts();status(`조회 ${products.length}/${codes.length}개 · 구성 변경 후 조합 생성 버튼을 눌러주세요.`);});
 $('aw-search-run').onclick=()=>run(async()=>{const result=await g.SystemV3Data.loadProducts({search:$('aw-search').value,page:1,pageSize:50,searchSources:['sellpia'],status:'all',sort:'sku_asc'});const found=result.rows||[];products=[...new Map([...products,...found].map(p=>[p.sellpia_sku_code,p])).values()];renderProducts();});
 $('aw-all').onclick=()=>{selected=new Set(products.map(p=>p.sellpia_sku_code));renderProducts();};$('aw-none').onclick=()=>{selected.clear();renderProducts();};
 $('aw-products').onchange=e=>{const sku=e.target.dataset.sku;if(sku){e.target.checked?selected.add(sku):selected.delete(sku);renderProducts();}};
 $('aw-generate').onclick=()=>run(async()=>{if(imported)throw Error('불러온 상품의 고정값은 유지합니다. 새 조합은 상품 목록에서 새로 생성하세요.');if(rows.length&&!g.confirm('현재 조합을 선택 상품의 모든 경우의 수로 다시 생성할까요?'))return;const f=form();if(!selected.size)throw Error('상품을 선택하세요.');const fresh=await g.SystemV3Data.loadAblyComponentStocks([...selected]);if(fresh.length!==selected.size)throw Error('조회되지 않은 SKU가 있습니다.');rows=g.AblyPairGenerator.generate(fresh,{...f,price:f.price===''?'':Number(f.price),size:Number(f.size),autoDefaults:true});$('aw-account').value='pink_rocket@naver.com';const codes=[...new Set(rows.map(r=>r[2]))];$('aw-code').value=codes.length===1?codes[0]:f.code;$('aw-price').value='';dirty=true;page=0;renderRows();status(`${rows.length}개 조합 생성 · 상품 저장 버튼으로 저장하세요.`);});
 $('aw-stock').onclick=()=>run(refreshStock);$('aw-save').onclick=()=>run(save);$('aw-download').onclick=()=>run(async()=>{const f=form();syncFields();validate(true);await refreshStock({requireComplete:true});const blob=await g.AblyStockExport.buildFromTemplate(await defaultTemplate(),rows,sourceLines);g.SystemV3SellerExport.downloadBlob(blob,safe(f.title)+'.xlsx');status('XLSX 다운로드 완료'+(rows.some(r=>!String(r[1]).trim()||!String(r[2]).trim()||r[5]===''||r[5]===null)?' · 계정/관리코드/판매가 빈칸은 플랫폼 업로드 전에 채워주세요.':''));});
 $('aw-rows').oninput=e=>{if(e.target.dataset.row!==undefined){rows[Number(e.target.dataset.row)][Number(e.target.dataset.column)]=e.target.value;dirty=true;status('조합 수정됨 · Q열을 변경했다면 현재재고를 갱신하세요.');}};
 $('aw-filter').oninput=()=>{page=0;renderRows();};$('aw-prev').onclick=()=>{page--;renderRows();};$('aw-next').onclick=()=>{page++;renderRows();};
 }
 async function run(fn){if(busy)return;lock(true);try{await fn();}catch(e){status(e.message);}finally{lock(false);renderRows();}}
 function renderProducts(){$('aw-products').innerHTML=products.map(p=>`<label><input type="checkbox" data-sku="${esc(p.sellpia_sku_code)}" ${selected.has(p.sellpia_sku_code)?'checked':''}><b>${esc(p.sellpia_sku_code)}</b><span>${esc(p.display_name||p.sellpia_product_name)}</span><small>${esc(p.sellpia_option_name)} · 재고 ${esc(p.system_stock??'조회 필요')}</small></label>`).join('');$('aw-count').textContent=`선택 ${selected.size}개 · 생성 예상 ${selected.size**Number($('aw-size').value)}개`;
 }
 function renderRows(){const q=$('aw-filter').value.toLowerCase(),filtered=rows.filter(r=>[r[11],r[13],r[15],r[16]].join(' ').toLowerCase().includes(q));const pages=Math.max(1,Math.ceil(filtered.length/50));page=Math.max(0,Math.min(page,pages-1));$('aw-rows').innerHTML=filtered.slice(page*50,page*50+50).map(r=>`<tr>${[11,13,15,2,16].map(c=>`<td><input data-row="${rows.indexOf(r)}" data-column="${c}" value="${esc(r[c])}"  aria-label="조합 ${rows.indexOf(r)+1} 열 ${c}"></td>`).join('')}<td>${esc(r[5])}</td><td>${esc(r[23])}</td></tr>`).join('');$('aw-count').textContent=`저장 대상 ${rows.length}개 · 검색 ${filtered.length}개`;$('aw-page').textContent=`${page+1} / ${pages}`;}
 function syncFields(){const f=form();rows.forEach(r=>{if(!imported)r[1]='pink_rocket@naver.com';for(const [key,column] of [['title',3],['option1',10],['option2',12],['option3',14]])if((!imported||f[key]!==initialForm[key])&&(column!==14||r[15]!==''))r[column]=f[key];});}
 function validate(download=false){const f=form();if(!f.title.trim())throw Error('온라인 상품명을 입력하세요.');if(f.price!==''&&(!Number.isFinite(Number(f.price))||Number(f.price)<0))throw Error('판매가를 확인하세요.');if(!rows.length)throw Error('조합을 먼저 생성하세요.');if(download&&rows.some(r=>g.AblyCombinationModel.parseSkuMemo(r[16]).error))throw Error('Q열 연결 SKU 형식을 확인하세요. 편집 중인 상품은 저장할 수 있습니다.');}
 async function loadDefaultForExport(){const r=await fetch('./ably-option-template.xlsx?v=1');if(!r.ok)throw Error('기본 양식 조회 실패');return new File([await r.arrayBuffer()],'에이블리_기본양식.xlsx');}
 async function defaultTemplate(){if(template)return template;const response=await fetch('./ably-option-template.xlsx?v=1');if(!response.ok)throw Error('기본 양식을 불러오지 못했습니다. 다시 다운로드하세요.');template=new File([await response.arrayBuffer()],'에이블리_기본양식.xlsx',{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});return template;}
 async function refreshStock({requireComplete=false}={}){if(!rows.length)throw Error('조합을 먼저 생성하세요.');const skus=[...new Set(rows.flatMap(r=>g.AblyCombinationModel.parseSkuMemo(r[16]).skus))];const stock=await g.SystemV3Data.loadAblyComponentStocks(skus),map=Object.fromEntries(stock.map(p=>[p.sellpia_sku_code,p.system_stock]));let invalid=0;rows.forEach(r=>{const result=g.AblyCombinationLabModel.calculate(r[16],map);if(result.error)invalid++;else r[23]=result.value;});dirty=true;if(requireComplete&&invalid)throw Error(`현재재고를 확인할 수 없는 조합 ${invalid}개가 있습니다. Q열 연결과 개별 SKU 재고를 확인하세요.`);status(`현재재고 갱신 ${rows.length-invalid}개 · 확인 필요 ${invalid}개는 기존 재고 유지`);renderRows();}
 async function encode(file){const bytes=new Uint8Array(await file.arrayBuffer());let text='';for(let i=0;i<bytes.length;i+=8192)text+=String.fromCharCode(...bytes.subarray(i,i+8192));return {name:file.name,base64:btoa(text)};}
 function decode(t){return new File([Uint8Array.from(atob(t.base64),c=>c.charCodeAt(0))],t.name,{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});}
 async function save(){
  syncFields();validate();
  const body={origin:imported?'imported':'generated',form:form(),rows,sourceLines,template:template?await encode(template):null,skus:[...new Set([...selected,...rows.flatMap(r=>g.AblyCombinationModel.parseSkuMemo(r[16]).skus)])]};
  const payload=JSON.parse(JSON.stringify(body));
  status('상품 저장 중…');
  try {doc=await api('save',{...doc,title:form().title,body:payload});}
  catch(e){throw Error('저장 요청 실패 · 편집 내용은 유지됩니다. '+e.message);}
  if(importGroup)importGroup.savedDoc=doc;
  status('저장 응답 확인 · 저장한 상품을 다시 읽고 있습니다.');
  let verified;
  try {verified=await api('get',{id:doc.id});}
  catch(e){throw Error('DB 저장 응답을 받았으나 재조회 실패 · 다시 저장하면 같은 상품을 갱신합니다. '+e.message);}
  verifySaved(verified,payload);
  doc=verified;
  if(importGroup){importGroup.savedDoc=doc;importGroup.title=doc.title;importGroup.items.forEach((item,i)=>{item.row=[...rows[i]];item.memoText=String(rows[i][16]??'');});}
  initialForm=form();
  dirty=false;
  const listed=await list({throwOnError:true});
  if(!listed.some(item=>item.id===doc.id))throw Error('저장 데이터는 확인했지만 목록 조회에 없습니다. 목록을 새로고침하세요.');
  panel.hidden=true;home.hidden=false;
  $('ably-saved-status').textContent=`${doc.title} · ${rows.length}개 조합 저장 및 재조회 확인 완료`;
  $('ably-saved-list').scrollIntoView({block:'start'});
 }
 function verifySaved(verified,payload){
  for(const key of ['origin','rows','sourceLines','skus','template'])if(JSON.stringify(verified?.body?.[key]??null)!==JSON.stringify(payload[key]??null))throw Error('저장 데이터 불일치: '+key+' · 편집 내용을 유지했습니다.');
  for(const [key,value] of Object.entries(payload.form))if(verified.body.form?.[key]!==value)throw Error('저장 설정 불일치: '+key);
 }
 async function openImported(group,file){
  if(dirty&&!g.confirm('저장하지 않은 편집을 종료할까요?'))return;
  await open();importGroup=group;doc=group.savedDoc||{};imported=true;
  rows=group.items.map(item=>{const row=[...item.row];row[16]=item.memoText??row[16]??'';return row;});
  sourceLines=group.items.map(item=>item.line);template=file;
  const first=rows[0];if(!first)return;
  const f={title:first[3],account:first[1],code:'',price:'',size:first[15]?3:2,option1:first[10],option2:first[12],option3:first[14]||'옵션3'};
  Object.entries(f).forEach(([key,value])=>{$('aw-'+key).value=value??'';});
  selected=new Set(rows.flatMap(row=>g.AblyCombinationModel.parseSkuMemo(row[16]).skus));
  $('aw-codes').value=[...selected].join('\n');$('aw-option3-wrap').hidden=Number(f.size)!==3;
  $('aw-template-name').textContent=file.name+' · 원본 행과 서식 보존';initialForm=form();dirty=false;renderRows();
  status('불러온 행을 편집한 뒤 상품 저장을 누르세요.');
 }
 function safe(v){return String(v).replace(/[\\/:*?"<>|]/g,'_').slice(0,100);}
 async function open(id){try{importGroup=null;sourceLines=null;doc=id?await api('get',{id}):{};importGroup=id?(g.AblyImportedWorkspace?.snapshot().groups.find(group=>group.savedDoc?.id===id)||null):null;imported=!!id&&doc.body?.origin!=='generated';rows=doc.body?.rows||[];sourceLines=doc.body?.sourceLines||null;products=[];selected=new Set(doc.body?.skus||[]);template=doc.body?.template?decode(doc.body.template):null;dirty=false;page=0;shell();const f=doc.body?.form||{title:'',account:'pink_rocket@naver.com',size:2,option1:'옵션1',option2:'옵션2',option3:'옵션3'};Object.entries(f).forEach(([k,v])=>{if($('aw-'+k))$('aw-'+k).value=v;});$('aw-code').readOnly=true;$('aw-codes').value=[...selected].join('\n');$('aw-option3-wrap').hidden=String(f.size)!=='3';$('aw-template-name').textContent=template?template.name+' · 저장된 양식':'기본 양식 자동 적용 · 템플릿 선택 불필요';home.hidden=true;$('ably-imported-detail').hidden=true;panel.hidden=false;initialForm=form();renderRows();if(selected.size){products=await g.SystemV3Data.loadAblyComponentStocks([...selected]);renderProducts();}}catch(e){$('ably-saved-status').textContent=e.message;}}
 async function list({throwOnError=false}={}){try{const docs=await api('list');$('ably-saved-list').innerHTML=docs.map(d=>`<button class="ably-product-card" data-saved="${d.id}"><span><b>${esc(d.title)}</b><small>조합 ${d.row_count}개 · ${esc(new Date(d.updated_at).toLocaleString())}</small></span><span>관리 →</span></button>`).join('')||'<p>저장된 상품이 없습니다. 새 조합을 만들거나 엑셀을 불러와 저장하세요.</p>';$('ably-saved-status').textContent=`저장된 상품 ${docs.length}개`;return docs;}catch(e){$('ably-saved-status').textContent=e.message;if(throwOnError)throw e;}}
 $('ably-saved-list').onclick=e=>{const b=e.target.closest('[data-saved]');if(b)void open(b.dataset.saved);};$('ably-saved-refresh').onclick=list;$('ably-virtual-product-open').onclick=()=>open();
 importButton.onclick=async()=>{
  const snapshot=g.AblyImportedWorkspace?.snapshot();
  if(!snapshot?.file||!snapshot.groups.length){$('ably-saved-status').textContent='먼저 옵션기본 엑셀을 불러오세요.';return;}
  importButton.disabled=true;
  let count=0;
  try{
   const encoded=await encode(snapshot.file);
   for(const group of snapshot.groups){
    const rr=group.items.map(item=>{const row=[...item.row];row[16]=item.memoText??row[16]??'';return row;}),r=rr[0];
    const body={origin:'imported',rows:rr,sourceLines:group.items.map(item=>item.line),template:encoded,skus:[...new Set(rr.flatMap(row=>g.AblyCombinationModel.parseSkuMemo(row[16]).skus))],form:{title:r[3],account:r[1],code:'',price:'',size:r[15]?3:2,option1:r[10],option2:r[12],option3:r[14]||'옵션3'}};
    group.savedDoc=await api('save',{...group.savedDoc,title:group.title,body});
    const check=await api('get',{id:group.savedDoc.id});
    verifySaved(check,JSON.parse(JSON.stringify(body)));group.savedDoc=check;count++;
   }
   const listed=await list({throwOnError:true});if(snapshot.groups.some(group=>!listed.some(d=>d.id===group.savedDoc.id)))throw Error('저장한 상품이 목록에 없습니다. 목록을 새로고침하세요.');$('ably-saved-status').textContent=`${count}개 상품 저장 및 재조회 완료`;
  }catch(e){$('ably-saved-status').textContent=`${count}개 저장 완료 · 다음 상품 저장 실패: ${e.message}`;}
  finally{importButton.disabled=false;}
 };
 // Each saved template remains intact; multiple products are delivered as separate XLSX files in one ZIP.
 $('ably-all-stock-download').onclick=async()=>{if(g.AblyImportedWorkspace?.snapshot().file)return g.AblyImportedWorkspace.downloadAll();const button=$('ably-all-stock-download');button.disabled=true;try{const docs=await api('list');if(!docs.length)throw Error('먼저 상품을 저장하세요.');const zip=new g.JSZip();for(let i=0;i<docs.length;i++){const d=await api('get',{id:docs[i].id}),rr=d.body.rows,skus=[...new Set(rr.flatMap(r=>g.AblyCombinationModel.parseSkuMemo(r[16]).skus))],stock=await g.SystemV3Data.loadAblyComponentStocks(skus),map=Object.fromEntries(stock.map(p=>[p.sellpia_sku_code,p.system_stock]));for(const r of rr){const result=g.AblyCombinationLabModel.calculate(r[16],map);if(result.error)throw Error(`${d.title}: ${result.error}`);r[23]=result.value;}const blob=await g.AblyStockExport.buildFromTemplate(d.body.template?decode(d.body.template):await loadDefaultForExport(),rr,d.body.sourceLines);zip.file(`${i+1}_${safe(d.title)}.xlsx`,await blob.arrayBuffer());}g.SystemV3SellerExport.downloadBlob(await zip.generateAsync({type:'blob'}),'전체조합_재고갱신.zip');$('ably-saved-status').textContent=`${docs.length}개 상품 XLSX를 ZIP으로 다운로드했습니다.`;}catch(e){$('ably-saved-status').textContent=e.message;}finally{button.disabled=false;}};
 g.AblyWorkspace={refresh:list,openImported};
})(window);
