(function initInventoryFileDownloads(global){
 'use strict';
 const DATABASE='operations-hub-file-destinations',STORE='directories',KEY='inventory';
 let directory=null,loaded=false,loading=null,revision=0,persistent=true;
 const supported=()=>typeof global.showDirectoryPicker==='function';
 const destinationState=()=>({supported:supported(),configured:Boolean(directory),name:directory?.name||'브라우저 기본 다운로드 폴더',persistent});
 async function storage(action,value){
  if(!global.indexedDB)throw Error('브라우저 저장소를 사용할 수 없습니다.');
  const database=await new Promise((resolve,reject)=>{
   const request=global.indexedDB.open(DATABASE,1);
   request.onupgradeneeded=()=>{if(!request.result.objectStoreNames.contains(STORE))request.result.createObjectStore(STORE);};
   request.onsuccess=()=>resolve(request.result);
   request.onerror=()=>reject(request.error||Error('저장 폴더 설정을 읽지 못했습니다.'));
   request.onblocked=()=>reject(Error('다른 탭이 저장 폴더 설정을 사용 중입니다.'));
  });
  try{return await new Promise((resolve,reject)=>{
   const transaction=database.transaction(STORE,action==='get'?'readonly':'readwrite'),store=transaction.objectStore(STORE);
   let request,result;
   try{request=action==='get'?store.get(KEY):action==='delete'?store.delete(KEY):store.put(value,KEY);}catch(error){reject(error);return;}
   request.onsuccess=()=>{result=request.result;};
   request.onerror=()=>reject(request.error||Error('저장 폴더 설정 처리에 실패했습니다.'));
   transaction.oncomplete=()=>resolve(result);
   transaction.onabort=()=>reject(transaction.error||Error('저장 폴더 설정 처리가 취소됐습니다.'));
   transaction.onerror=()=>reject(transaction.error||Error('저장 폴더 설정 처리에 실패했습니다.'));
  });}finally{database.close();}
 }
 async function loadDestination(){
  if(!loaded){
   if(!loading){const currentRevision=revision;loading=(async()=>{
    try{const saved=await storage('get');if(currentRevision===revision)directory=supported()&&saved?.kind==='directory'?saved:null;}
    catch{persistent=false;}
    finally{loaded=true;loading=null;}
   })();}
   await loading;
  }
  return destinationState();
 }
 async function chooseDestination(){
  if(!supported())throw Error('이 브라우저에서는 폴더 선택을 지원하지 않습니다. 브라우저 기본 다운로드 폴더를 사용해주세요.');
  // Open during the click's user activation, before asynchronous storage work.
  const handle=await global.showDirectoryPicker({id:'operation-hub-inventory',mode:'readwrite',startIn:'downloads'});
  if(handle?.kind!=='directory')throw Error('저장할 폴더를 선택해주세요.');
  revision++;directory=handle;loaded=true;
  try{await storage('put',handle);persistent=true;}catch{persistent=false;}
  return destinationState();
 }
 async function clearDestination(){
  // Never report a cleared preference if its saved handle could return on reload.
  if(global.indexedDB)await storage('delete');
  revision++;directory=null;loaded=true;return destinationState();
 }
 async function prepareDestination(){
  await loadDestination();
  if(!directory)return {kind:'browser'};
  const permission={mode:'readwrite'};
  let state=await directory.queryPermission(permission);
  if(state!=='granted')state=await directory.requestPermission(permission);
  if(state!=='granted')throw Error('선택한 저장 폴더의 쓰기 권한이 필요합니다. 권한을 허용하거나 기본 다운로드 폴더로 변경해주세요.');
  return {kind:'directory',handle:directory,name:directory.name};
 }
 async function saveFiles(files,{destination,onProgress=null}={}){
  if(!Array.isArray(files)||!files.length)throw Error('저장할 파일이 없습니다.');
  const names=new Set(),entries=files.map(file=>{
   const name=String(file?.fileName||file?.name||'');
   if(!name||/[\\/\u0000-\u001f]/.test(name)||names.has(name)||!file?.blob||typeof file.blob.arrayBuffer!=='function')throw Error('저장할 파일의 이름 또는 내용을 확인할 수 없습니다.');
   names.add(name);return {name,blob:file.blob};
  });
  if(!destination||!['browser','directory'].includes(destination.kind))throw Error('파일 저장 위치를 먼저 확인해주세요.');
  let saved=0;
  for(const file of entries){
   if(destination.kind==='directory'){
    const handle=destination.handle;
    if(!handle||await handle.queryPermission({mode:'readwrite'})!=='granted')throw Error('저장 폴더의 쓰기 권한이 해제됐습니다. 폴더 설정을 확인한 뒤 파일 생성을 다시 실행해주세요.');
    let writable=null;
    try{
     const target=await handle.getFileHandle(file.name,{create:true});
     writable=await target.createWritable();await writable.write(file.blob);await writable.close();writable=null;
    }catch(error){if(writable){try{await writable.abort();}catch{}}throw Error(`${file.name} 저장 실패 (${saved}/${entries.length}개 저장): ${error?.message||error}`);}
   }else{
    const url=global.URL.createObjectURL(file.blob),anchor=global.document.createElement('a');
    anchor.href=url;anchor.download=file.name;global.document.body.append(anchor);
    try{anchor.click();}finally{anchor.remove();global.setTimeout(()=>global.URL.revokeObjectURL(url),60000);}
    await new Promise(resolve=>global.setTimeout(resolve,200));
   }
   saved++;onProgress?.({detail:`${file.name} · ${saved}/${entries.length}개 ${destination.kind==='directory'?'저장':'다운로드 요청'}`,percent:Math.round(saved/entries.length*100)});
  }
  return {savedCount:saved,destination:destination.kind,name:destination.name||'브라우저 기본 다운로드 폴더'};
 }
 global.HubInventoryFileDownloads={loadDestination,chooseDestination,clearDestination,prepareDestination,saveFiles};
})(window);
