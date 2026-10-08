import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('../mockups/operations-hub/inventory-file-downloads.js',import.meta.url),'utf8');
function storageFixture(initial=null){
 const shared={value:initial,fail:null,calls:[]};
 shared.indexedDB={open(name,version){
  shared.calls.push(['open',name,version]);const request={};
  queueMicrotask(()=>{
   const database={objectStoreNames:{contains:()=>true},close(){},transaction(store,mode){
    shared.calls.push(['transaction',store,mode]);const transaction={};
    transaction.objectStore=()=>Object.fromEntries(['get','put','delete'].map(action=>[action,(...args)=>{
     shared.calls.push([action,...args]);const operation={};
     queueMicrotask(()=>{
      if(shared.fail===action){operation.error=Error(`synthetic ${action} failure`);operation.onerror?.();return;}
      if(action==='put')shared.value=args[0];if(action==='delete')shared.value=null;
      operation.result=action==='get'?shared.value:undefined;operation.onsuccess?.();
      queueMicrotask(()=>transaction.oncomplete?.());
     });return operation;
    }]));return transaction;
   }};request.result=database;request.onsuccess?.();
  });return request;
 }};return shared;
}
function directoryFixture({name='Inventory',permission='granted',requested='granted',failWriteAt=0}={}){
 const calls=[];let current=permission,writes=0;
 const handle={kind:'directory',name,async queryPermission(options){calls.push(['query',options.mode]);return current;},async requestPermission(options){calls.push(['request',options.mode]);current=requested;return current;},async getFileHandle(fileName,options){
  calls.push(['file',fileName,options.create]);return {async createWritable(){calls.push(['writable',fileName]);return {
   async write(blob){calls.push(['write',fileName,await blob.text()]);writes++;if(writes===failWriteAt)throw Error('disk full');},
   async close(){calls.push(['close',fileName]);},async abort(){calls.push(['abort',fileName]);}
  };}};
 }};return {handle,calls,setPermission(value){current=value;}};
}
function harness({storage=storageFixture(),directory=directoryFixture(),supported=true,indexedDB=true}={}){
 const downloads=[],revokes=[],timers=[],pickerCalls=[];
 const context={console,Blob,Promise,Error,Set,Array,String,indexedDB:indexedDB?storage.indexedDB:undefined,
  URL:{createObjectURL:blob=>{const id=`blob:${downloads.length+1}`;return id;},revokeObjectURL:url=>revokes.push(url)},
  document:{body:{append(){}},createElement(){return {click(){downloads.push({name:this.download,url:this.href});},remove(){}};}},
  setTimeout(fn,ms){timers.push(ms);if(ms===200)queueMicrotask(fn);return timers.length;},
 };
 if(supported)context.showDirectoryPicker=options=>{pickerCalls.push(options);return Promise.resolve(directory.handle);};
 context.window=context;vm.createContext(context);vm.runInContext(source,context,{filename:'inventory-file-downloads.js'});
 return {api:context.HubInventoryFileDownloads,storage,directory,downloads,revokes,timers,pickerCalls};
}
const files=()=>['SMART1.xlsx','SMART2.xlsx','MAKE.xlsx','AB.xlsx'].map((name,index)=>({name,blob:new Blob([`file-${index}`])}));

test('unsupported browsers use individual downloads in file order with progress and delayed URL release',async()=>{
 const h=harness({supported:false});const state=await h.api.loadDestination();
 assert.equal(state.supported,false);assert.equal(state.configured,false);
 await assert.rejects(()=>h.api.chooseDestination(),/지원하지/);
 const destination=await h.api.prepareDestination(),progress=[];
 assert.equal(destination.kind,'browser');const result=await h.api.saveFiles(files(),{destination,onProgress:value=>progress.push(value.percent)});
 assert.equal(result.savedCount,4);assert.deepEqual(h.downloads.map(row=>row.name),files().map(row=>row.name));
 assert.deepEqual(progress,[25,50,75,100]);assert.equal(h.timers.filter(ms=>ms===200).length,4);assert.equal(h.timers.filter(ms=>ms===60000).length,4);assert.equal(h.revokes.length,0);
});

test('directory selection persists and a fresh module restores the handle before requesting write permission',async()=>{
 const storage=storageFixture(),directory=directoryFixture({permission:'prompt'}),h=harness({storage,directory});
 const pending=h.api.chooseDestination();assert.equal(h.pickerCalls.length,1,'picker is invoked synchronously during user activation');
 const state=await pending;assert.equal(state.configured,true);assert.equal(state.persistent,true);
 assert.equal(storage.calls.find(row=>row[0]==='open')[1],'operations-hub-file-destinations');
 assert.equal(storage.calls.find(row=>row[0]==='put')[2],'inventory');
 const fresh=harness({storage,directory});assert.equal((await fresh.api.loadDestination()).name,'Inventory');
 const destination=await fresh.api.prepareDestination();assert.equal(destination.handle,directory.handle);
 assert.deepEqual(directory.calls.slice(0,2),[['query','readwrite'],['request','readwrite']]);
 await fresh.api.saveFiles(files(),{destination});
 assert.deepEqual(directory.calls.filter(row=>row[0]==='close').map(row=>row[1]),files().map(row=>row.name));
 assert.equal(fresh.downloads.length,0);
 await fresh.api.clearDestination();assert.equal(storage.value,null);assert.equal((await fresh.api.prepareDestination()).kind,'browser');
});

test('permission denial and revoked permission fail before any file write',async()=>{
 const directory=directoryFixture({permission:'prompt',requested:'denied'}),h=harness({directory});await h.api.chooseDestination();
 await assert.rejects(()=>h.api.prepareDestination(),/쓰기 권한/);assert.equal(directory.calls.some(row=>row[0]==='file'),false);
 directory.setPermission('granted');const destination=await h.api.prepareDestination();directory.setPermission('denied');
 await assert.rejects(()=>h.api.saveFiles(files(),{destination}),/권한이 해제/);assert.equal(directory.calls.some(row=>row[0]==='file'),false);
});

test('unavailable persistence retains a session-only selected destination, while failed clearing never falsely reports success',async()=>{
 const directory=directoryFixture(),session=harness({directory,indexedDB:false});
 const state=await session.api.chooseDestination();assert.equal(state.configured,true);assert.equal(state.persistent,false);
 assert.equal((await session.api.prepareDestination()).handle,directory.handle);
 await session.api.clearDestination();assert.equal((await session.api.loadDestination()).configured,false);
 const storage=storageFixture(),persistent=harness({storage});await persistent.api.chooseDestination();storage.fail='delete';
 await assert.rejects(()=>persistent.api.clearDestination(),/delete failure/);
 assert.equal((await persistent.api.loadDestination()).configured,true);assert.ok(storage.value);
});

test('partial folder save aborts the failing writable and exposes the failed filename and completed count',async()=>{
 const directory=directoryFixture({failWriteAt:2}),h=harness({directory});await h.api.chooseDestination();const destination=await h.api.prepareDestination();
 await assert.rejects(()=>h.api.saveFiles(files(),{destination}),/SMART2.xlsx 저장 실패 \(1\/4개 저장\).*disk full/);
 assert.deepEqual(directory.calls.filter(row=>row[0]==='close').map(row=>row[1]),['SMART1.xlsx']);
 assert.deepEqual(directory.calls.filter(row=>row[0]==='abort').map(row=>row[1]),['SMART2.xlsx']);
 assert.equal(directory.calls.some(row=>row[0]==='file'&&row[1]==='MAKE.xlsx'),false);
});

test('invalid or duplicate filenames are rejected as a batch before any download or directory write',async()=>{
 const h=harness({supported:false}),destination=await h.api.prepareDestination();
 for(const input of [[...files(),files()[0]],[{name:'../bad.xlsx',blob:new Blob(['bad'])}],[{name:'no-blob.xlsx'}]])await assert.rejects(()=>h.api.saveFiles(input,{destination}),/이름 또는 내용/);
 assert.equal(h.downloads.length,0);
});
