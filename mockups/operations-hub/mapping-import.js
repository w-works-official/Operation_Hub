(function(global) {
  'use strict';
  const headers=['셀피아sku','스스 상품코드','스스 옵션코드','메이크샵 상품코드','메이크샵 옵션코드','에이블리 상품코드','에이블리 옵션코드'];
  const templateHeaders=['썸네일',...headers];
  const sellerTemplateHeaders=[...templateHeaders,'판매처','판매처 상품명','판매처 옵션명'];
  const sources=['smartstore','makeshop','ably'];
  const labels={smartstore:'스마트스토어',makeshop:'메이크샵',ably:'에이블리'};
  const text=value=>String(value??'').trim();
  const header=value=>text(value).toLowerCase().replace(/\s/g,'').replace('스마트스토어','스스');
  const escape=value=>text(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
  function parse(rows) {
    if(!Array.isArray(rows)||!rows.length)throw new Error('파일이 비어 있습니다.');
    const actual=rows[0].map(header), columns=headers.map(value=>actual.indexOf(header(value)));
    if(columns.some(index=>index<0)||new Set(actual.filter(Boolean)).size!==actual.filter(Boolean).length)throw new Error('7개 필수 헤더를 확인해주세요. 양식을 내려받아 사용해주세요.');
    if(rows.length>20001)throw new Error('한 번에 최대 20,000행까지 올릴 수 있습니다.');
    const entries=[], errors=[], keys=new Map();
    const code=value=>{
      if(typeof value==='number' && (!Number.isSafeInteger(value)||value<0))throw new Error('숫자 코드가 손상되었습니다. 엑셀에서 텍스트 형식으로 입력해주세요.');
      const result=text(value);
      if(/[\r\n\t]/.test(result)||/^[+-]?\d+(?:\.\d+)?e[+-]?\d+$/i.test(result))throw new Error('코드는 지수표기나 줄바꿈 없이 텍스트로 입력해주세요.');
      return result;
    };
    rows.slice(1).forEach((raw,index)=>{
      const rowNo=index+2;
      if(!columns.some(col=>text(raw?.[col])))return;
      let values;
      try{values=columns.map(col=>code(raw?.[col]));}catch(error){errors.push({rowNo,sku:text(raw?.[columns[0]]),status:'error',reason:error.message});return;}
      const sku=values[0];
      if(!sku){errors.push({rowNo,status:'error',reason:'셀피아 SKU가 없습니다.'});return;}
      sources.forEach((source,index)=>{
        const productCode=values[index*2+1],optionCode=values[index*2+2];
        if(!productCode&&!optionCode)return;
        if(!productCode){errors.push({rowNo,sku,source,optionCode,status:'error',reason:'옵션코드만 있습니다. 상품코드도 입력해주세요.'});return;}
        const entry={rowNo,sku,source,productCode,optionCode};
        const key=JSON.stringify([sku,source]);
        if(keys.has(key)){
          const previous=keys.get(key);
          if(previous.productCode!==productCode||previous.optionCode!==optionCode){previous.conflict=true;errors.push({...entry,status:'error',reason:'같은 SKU·판매처에 서로 다른 연결값이 입력됐습니다.'});}
        }else{keys.set(key,entry);entries.push(entry);}
      });
    });
    const valid=entries.filter(entry=>!entry.conflict);
    for(const entry of entries.filter(entry=>entry.conflict))errors.push({...entry,status:'error',reason:'같은 SKU·판매처에 서로 다른 연결값이 입력됐습니다.'});
    return {entries:valid,errors};
  }
  const thumbnailUrl=product=>text(product?.sellpia_override_image_url||product?.image_url);
  const THUMBNAIL_MAX_PX=96;
  async function thumbnailDimensions(buffer) {
    if(!global.createImageBitmap||!global.Blob)return {width:THUMBNAIL_MAX_PX,height:THUMBNAIL_MAX_PX};
    let image;
    try{
      image=await global.createImageBitmap(new global.Blob([buffer],{type:'image/jpeg'}));
      return {width:Number(image.width)||THUMBNAIL_MAX_PX,height:Number(image.height)||THUMBNAIL_MAX_PX};
    }catch(error){
      console.warn('thumbnail image dimensions unavailable',error);
      return {width:THUMBNAIL_MAX_PX,height:THUMBNAIL_MAX_PX};
    }finally{image?.close?.();}
  }
  function thumbnailSize(image={}) {
    const width=Math.max(1,Number(image.width)||THUMBNAIL_MAX_PX);
    const height=Math.max(1,Number(image.height)||THUMBNAIL_MAX_PX);
    const scale=Math.min(THUMBNAIL_MAX_PX/width,THUMBNAIL_MAX_PX/height);
    return {width:Math.max(1,Math.round(width*scale)),height:Math.max(1,Math.round(height*scale))};
  }
  async function loadThumbnailImages(products,onProgress) {
    const targets=products.map((product,index)=>({index,url:thumbnailUrl(product)})).filter(target=>target.url);
    const images=new Map();let completed=0,next=0;
    const report=()=>onProgress?.({completed,total:targets.length,missing:products.length-targets.length});
    report();
    const worker=async()=>{
      while(next<targets.length){
        const target=targets[next++];
        try{
          const response=await fetch(target.url);
          if(!response.ok)throw new Error(`HTTP ${response.status}`);
          const buffer=await response.arrayBuffer();
          if(buffer.byteLength)images.set(target.index,{buffer,...await thumbnailDimensions(buffer)});
        }catch(error){console.warn('thumbnail image download failed',target.url,error);}
        completed++;report();
      }
    };
    await Promise.all(Array.from({length:Math.min(8,targets.length)},worker));
    return images;
  }
  async function buildThumbnailTemplate(products=[],{onProgress}={}) {
    if(!global.ExcelJS?.Workbook)throw new Error('썸네일 XLSX 모듈을 불러오지 못했습니다. 새로고침 후 다시 시도해주세요.');
    const images=await loadThumbnailImages(products,onProgress);
    const book=new global.ExcelJS.Workbook();
    book.creator='System V3';book.created=new Date();
    const sheet=book.addWorksheet('매칭값',{views:[{state:'frozen',xSplit:2,ySplit:1}]});
    sheet.columns=[
      {header:'썸네일',key:'thumbnail',width:18},{header:headers[0],key:'sellpia',width:18},
      {header:headers[1],key:'smartstoreProduct',width:19},{header:headers[2],key:'smartstoreOption',width:19},
      {header:headers[3],key:'makeshopProduct',width:21},{header:headers[4],key:'makeshopOption',width:21},
      {header:headers[5],key:'ablyProduct',width:19},{header:headers[6],key:'ablyOption',width:19}
    ];
    const header=sheet.getRow(1);header.height=24;header.font={bold:true};header.alignment={vertical:'middle'};
    header.eachCell(cell=>{cell.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FFE8EFF7'}};cell.border={bottom:{style:'thin',color:{argb:'FF9DAFC5'}}};});
    products.forEach((product,index)=>{
      const row=sheet.addRow({sellpia:text(product?.sellpia_sku_code)});row.height=76;
      row.eachCell({includeEmpty:true},cell=>{cell.alignment={vertical:'middle'};});
      for(let col=2;col<=8;col++)row.getCell(col).numFmt='@';
      const image=images.get(index);
      if(image){
        const imageId=book.addImage({buffer:image.buffer,extension:'jpeg'});
        sheet.addImage(imageId,{tl:{col:0,row:row.number-1},ext:thumbnailSize(image)});
      }else{
        const cell=row.getCell(1);cell.value='이미지 없음';cell.font={color:{argb:'FF7A8796'},size:9};cell.alignment={horizontal:'center',vertical:'middle',wrapText:true};
      }
    });
    sheet.autoFilter={from:'A1',to:`H${Math.max(1,products.length+1)}`};
    return book.xlsx.writeBuffer();
  }
  async function buildSellerUnmatchedTemplate(items=[]) {
    if(!global.ExcelJS?.Workbook)throw new Error('썸네일 XLSX 모듈을 불러오지 못했습니다. 새로고침 후 다시 시도해주세요.');
    const book=new global.ExcelJS.Workbook();
    book.creator='System V3';book.created=new Date();
    const sheet=book.addWorksheet('판매처미매칭',{views:[{state:'frozen',xSplit:2,ySplit:1}]});
    sheet.columns=[
      {header:'썸네일',key:'thumbnail',width:16},{header:headers[0],key:'sellpia',width:18},
      {header:headers[1],key:'smartstoreProduct',width:19},{header:headers[2],key:'smartstoreOption',width:19},
      {header:headers[3],key:'makeshopProduct',width:21},{header:headers[4],key:'makeshopOption',width:21},
      {header:headers[5],key:'ablyProduct',width:19},{header:headers[6],key:'ablyOption',width:19},
      {header:'판매처',key:'source',width:15},{header:'판매처 상품명',key:'productName',width:44},{header:'판매처 옵션명',key:'optionName',width:44}
    ];
    const header=sheet.getRow(1);header.height=24;header.font={bold:true};header.alignment={vertical:'middle'};
    header.eachCell(cell=>{cell.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FFFFF1DC'}};cell.border={bottom:{style:'thin',color:{argb:'FFC89E55'}}};});
    items.forEach(item=>{
      const sourceIndex=sources.indexOf(text(item?.source_channel));
      const row=sheet.addRow({thumbnail:'셀피아 미연결',source:labels[item?.source_channel]||text(item?.source_channel),productName:text(item?.product_name),optionName:text(item?.option_name)});
      if(sourceIndex>=0){
        row.getCell(3+sourceIndex*2).value=text(item?.product_code);
        row.getCell(4+sourceIndex*2).value=text(item?.option_code);
      }
      row.height=32;row.eachCell({includeEmpty:true},cell=>{cell.alignment={vertical:'middle',wrapText:cell.col>=10};});
      for(let col=2;col<=8;col++)row.getCell(col).numFmt='@';
    });
    sheet.autoFilter={from:'A1',to:`K${Math.max(1,items.length+1)}`};
    return book.xlsx.writeBuffer();
  }
  global.SystemV3MappingImport={parse,headers,templateHeaders,sellerTemplateHeaders,buildThumbnailTemplate,buildSellerUnmatchedTemplate};
  if(!global.document)return;
  const byId=id=>document.getElementById('mapping-import-'+id);
  if(!byId('modal'))return;
  const state={busy:false,stop:false,results:[]};
  const names={ready:'신규 등록',replace:'기존 연결 변경',same:'이미 동일',error:'오류',saved:'저장 완료',failed:'저장 실패'};
  const eligible=row=>['ready','replace'].includes(row.status);
  function render(message='') {
    const counts={};for(const row of state.results)counts[row.status]=(counts[row.status]||0)+1;
    byId('status').textContent=message||Object.entries(counts).map(([key,count])=>(names[key]||key)+' '+count+'건').join(' · ')||'파일을 선택해주세요.';
    byId('rows').innerHTML=state.results.slice(0,100).map(row=>'<tr><td>'+row.rowNo+'</td><td>'+escape(row.sku)+'</td><td>'+escape(labels[row.source])+'</td><td>'+escape(row.before?.productCode||'-')+' / '+escape(row.before?.optionCode||'-')+'</td><td>'+escape(row.productCode)+' / '+escape(row.optionCode||'-')+'</td><td>'+escape(names[row.status]||row.status)+'</td><td>'+escape(row.reason||[row.productName,row.optionName].filter(Boolean).join(' · '))+'</td></tr>').join('');
    byId('apply').disabled=state.busy||!state.results.some(eligible);
    byId('apply').textContent=state.busy?'처리 중…':state.results.some(eligible)?'가능 '+state.results.filter(eligible).length+'건 등록':'등록할 항목 없음';
    byId('file').disabled=state.busy;
    byId('cancel').textContent=state.busy?(state.stop?'중단 요청됨':'작업 중단'):'닫기';
    byId('report').disabled=!state.results.length;
  }
  const download=(content,name,type='text/csv;charset=utf-8')=>{
    const url=URL.createObjectURL(new Blob([content],{type})),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);
  };
  const csv=rows=>'\uFEFF'+rows.map(row=>row.map(value=>'"'+text(typeof value==='string'&&/^[=+@-]/.test(value)?"'"+value:value).replaceAll('"','""')+'"').join(',')).join('\r\n');
  byId('template').onclick=async()=>{
    const button=byId('template'),original=button.textContent;
    if(!global.SystemV3Data?.loadAllFilteredSkus||!global.SystemV3Data?.loadProductThumbnailsBySkus){
      download(csv([templateHeaders]),'매칭값_일괄등록_양식.csv');
      return;
    }
    button.disabled=true;
    try{
      button.textContent='미매칭 셀피아 SKU 조회 중…';
      const target=await global.SystemV3Data.loadAllFilteredSkus({status:'unmatched'});
      const products=await global.SystemV3Data.loadProductThumbnailsBySkus(target.skus,{onProgress:progress=>{
        button.textContent=`썸네일 조회 ${progress.loaded.toLocaleString()} / ${progress.total.toLocaleString()}개 SKU`;
      }});
      const bySku=new Map(products.map(product=>[text(product?.sellpia_sku_code),product]));
      const ordered=target.skus.map(sku=>bySku.get(text(sku))||{sellpia_sku_code:sku});
      const imageCount=ordered.filter(product=>thumbnailUrl(product)).length;
      const bytes=await buildThumbnailTemplate(ordered,{onProgress:progress=>{
        button.textContent=`사진 삽입 ${progress.completed.toLocaleString()} / ${progress.total.toLocaleString()}개 · 이미지 없음 ${progress.missing.toLocaleString()}개`;
      }});
      download(bytes,'매칭값_일괄등록_미매칭셀피아SKU_썸네일포함.xlsx','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      byId('status').textContent=`미매칭 셀피아 SKU ${ordered.length.toLocaleString()}개를 채운 XLSX 양식을 받았습니다. A열에는 실제 이미지 ${imageCount.toLocaleString()}개를 삽입했고, 원본 이미지가 없는 ${Math.max(0,ordered.length-imageCount).toLocaleString()}개는 ‘이미지 없음’으로 표시합니다. B열 셀피아 SKU부터 매칭값을 입력하세요.`;
    }catch(error){
      console.error('mapping thumbnail template download failed',error);
      byId('status').textContent=`썸네일 포함 양식을 만들지 못했습니다: ${error?.message||error}`;
    }finally{
      button.disabled=false;
      button.textContent=original;
    }
  };
  byId('seller-template').onclick=async()=>{
    const button=byId('seller-template'),original=button.textContent;
    if(!global.SystemV3Data?.loadAllSellerUnmatchedSkus){
      download(csv([sellerTemplateHeaders]),'매칭값_일괄등록_판매처SKU미매칭.csv');
      return;
    }
    button.disabled=true;
    try{
      button.textContent='판매처 미연결 SKU 조회 중…';
      const items=await global.SystemV3Data.loadAllSellerUnmatchedSkus({onProgress:progress=>{
        button.textContent=progress?.message||'판매처 미연결 SKU 조회 중…';
      }});
      const bytes=await buildSellerUnmatchedTemplate(items);
      download(bytes,'매칭값_일괄등록_판매처SKU미매칭.xlsx','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      const counts=items.reduce((result,item)=>{const source=text(item?.source_channel);result[source]=(result[source]||0)+1;return result;},{});
      byId('status').textContent=`판매처 미연결 SKU ${items.length.toLocaleString()}개를 채운 XLSX 양식을 받았습니다. 스마트스토어 ${(counts.smartstore||0).toLocaleString()}개 · 메이크샵 ${(counts.makeshop||0).toLocaleString()}개 · 에이블리 ${(counts.ably||0).toLocaleString()}개입니다. B열 셀피아 SKU를 채운 뒤 그대로 업로드하세요.`;
    }catch(error){
      console.error('seller unmatched mapping template download failed',error);
      byId('status').textContent=`판매처 SKU 미매칭 양식을 만들지 못했습니다: ${error?.message||error}`;
    }finally{
      button.disabled=false;
      button.textContent=original;
    }
  };
  byId('report').onclick=()=>download(csv([['행','셀피아 SKU','판매처','이전 상품코드','이전 옵션코드','상품코드','옵션코드','상태','사유'],...state.results.map(row=>[row.rowNo,row.sku,labels[row.source],row.before?.productCode,row.before?.optionCode,row.productCode,row.optionCode,names[row.status],row.reason])]),'매칭값_등록결과.csv');
  byId('cancel').onclick=()=>{
    if(state.busy){state.stop=true;render('현재 요청을 마친 뒤 중단합니다. 저장 완료 건은 유지됩니다.');}
    else byId('modal').hidden=true;
  };
  document.getElementById('mapping-import-open').onclick=()=>{byId('modal').hidden=false;render();byId('file').focus();};
  document.addEventListener('keydown',event=>{if(event.key==='Escape'&&!byId('modal').hidden){event.preventDefault();byId('cancel').click();}});
  byId('file').onchange=async()=>{
    const file=byId('file').files[0];if(!file||state.busy)return;
    state.busy=true;state.stop=false;state.results=[];render('파일 읽는 중');
    try {
      if(file.size>20*1024*1024)throw new Error('파일 크기는 최대 20MB입니다.');
      const isCsv=/\.csv$/i.test(file.name);
      const bytes=await file.arrayBuffer();
      let input=bytes;
      if(isCsv){try{input=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{input=new TextDecoder('euc-kr').decode(bytes);}}
      const workbook=global.XLSX.read(input,{type:isCsv?'string':'array',cellDates:false,raw:true});
      const rows=global.XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]],{header:1,defval:'',raw:true});
      const parsed=parse(rows);state.results=parsed.errors;render('원본 코드 검사 중');
      for(let offset=0;offset<parsed.entries.length;offset+=150){
        if(state.stop)break;
        const checked=await global.SystemV3Data.previewMappingImport(parsed.entries.slice(offset,offset+150));
        state.results.push(...checked);render('원본 코드 검사 '+Math.min(offset+150,parsed.entries.length)+' / '+parsed.entries.length+'건');
      }
      if(state.stop)state.results=state.results.map(row=>({...row,status:'error',reason:'검사가 중단됐습니다. 파일을 다시 선택해주세요.'}));
    }catch(error){state.results=state.results.map(row=>({...row,status:'error',reason:'검사가 완료되지 않았습니다. 파일을 다시 선택해주세요.'}));state.results.push({status:'error',reason:error.message||String(error)});}
    finally{state.busy=false;byId('file').value='';render();}
  };
  byId('apply').onclick=async()=>{
    if(state.busy)return;
    const targets=state.results.filter(eligible);if(!targets.length)return;
    state.busy=true;state.stop=false;render('등록 시작');
    try {
      for(let offset=0;offset<targets.length;offset+=50){
        if(state.stop)break;
        const batch=targets.slice(offset,offset+50);
        // Recheck source availability and displayed old links before applying.
        const current=await global.SystemV3Data.previewMappingImport(batch);
        for(let index=0;index<batch.length;index++){
          if(state.stop)break;
          const row=batch[index],fresh=current[index];
          if(fresh.status==='error'){row.status='failed';row.reason=fresh.reason;continue;}
          if(fresh.status==='same'){row.status='same';continue;}
          if(JSON.stringify(fresh.before)!==JSON.stringify(row.before)){row.status='failed';row.reason='검사 후 기존 연결이 변경됐습니다. 다시 확인해주세요.';continue;}
          try{
            const saved=await global.SystemV3Data.linkSellerItem(row);
            if(text(saved?.product_code)!==row.productCode||text(saved?.option_code)!==row.optionCode)throw new Error('저장 응답을 확인하지 못했습니다. 새로 검사해주세요.');
            row.status='saved';row.reason='공식 매칭값으로 저장됨';
          }catch(error){row.status='failed';row.reason=(error.message||String(error))+' · 저장 여부를 다시 검사해주세요.';}
          render('등록 처리 '+(offset+index+1)+' / '+targets.length+'건');
        }
      }
    }catch(error){for(const row of targets.filter(eligible)){row.status='failed';row.reason=error.message||String(error);}}
    finally{state.busy=false;render(state.stop?'중단되었습니다. 저장 완료 건은 유지되고 미처리 건은 다시 등록할 수 있습니다.':'');document.getElementById('matrix-refresh-btn')?.click();}
  };
})(typeof window==='undefined'?globalThis:window);
