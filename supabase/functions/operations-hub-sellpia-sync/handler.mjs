import {VERSION,BROWSER_ACTIONS,WORKER_ACTIONS,DOWNLOAD_TTL_SECONDS,allowedOrigin,secureWorkerRequest,sessionHeader,workerTokenMatches,uuid,sha256,assertLease,verifyArtifactBytes,plain,fail} from './protocol.mjs';

const STATUS={UNAUTHORIZED:401,ORIGIN_DENIED:403,NOT_FOUND:404,INVALID_REQUEST:400,AUTOMATION_FULL_ONLY:400,INVALID_MANIFEST:400,INVALID_ARTIFACT:409,CONFLICT:409,LEASE_LOST:409,DISABLED:503,QUEUE_UNAVAILABLE:503,STORAGE_UNAVAILABLE:503};
async function boundedJson(req){
  const reader=req.body?.getReader();if(!reader)fail('INVALID_REQUEST','JSON 요청이 필요합니다.');
  const chunks=[];let length=0;
  try{while(true){const {done,value}=await reader.read();if(done)break;length+=value.byteLength;if(length>65536){await reader.cancel();fail('INVALID_REQUEST','요청 크기를 초과했습니다.');}chunks.push(value);}}
  finally{reader.releaseLock();}
  const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{fail('INVALID_REQUEST','JSON 요청이 필요합니다.');}
}
export function createHandler({queue,store,guardSession,storage,workerToken,workerId,enabled=false}){
  return async function(req){
    const origin=req.headers.get('origin')||'';
    const cors=allowedOrigin(origin)?{'Access-Control-Allow-Origin':origin,'Access-Control-Allow-Headers':'apikey, content-type, x-operations-hub-session','Access-Control-Allow-Methods':'POST, OPTIONS','Vary':'Origin'}:{};
    const respond=(status,payload)=>new Response(JSON.stringify(payload),{status,headers:{...cors,'Content-Type':'application/json','Cache-Control':'no-store'}});
    try{
      if(req.method==='OPTIONS') {if(!allowedOrigin(origin))fail('ORIGIN_DENIED','허용된 운영 화면이 필요합니다.');return respond(200,{ok:true});}
      if(!enabled)fail('DISABLED','원본 동기화 서버는 아직 활성화되지 않았습니다.');
      if(req.method!=='POST')fail('INVALID_REQUEST','POST 요청만 허용합니다.');
      const declared=Number(req.headers.get('content-length')||0);if(declared>65536)fail('INVALID_REQUEST','요청 크기를 초과했습니다.');
      const body=await boundedJson(req);
      if(!plain(body))fail('INVALID_REQUEST','JSON 객체가 필요합니다.');
      const action=body.action;
      let actor;
      if(BROWSER_ACTIONS.has(action)){
        if(!allowedOrigin(origin))fail('ORIGIN_DENIED','허용된 운영 화면이 필요합니다.');
        const token=sessionHeader(req.headers.get('x-operations-hub-session'));
        if(!await guardSession(token))fail('UNAUTHORIZED','운영 세션이 만료되었거나 회수되었습니다.');
        actor={kind:'browser'};
      }else if(WORKER_ACTIONS.has(action)){
        if(!secureWorkerRequest(req.url,origin)||!await workerTokenMatches(req.headers.get('x-sellpia-sync-worker-token'),workerToken)||!workerId||body.workerId!==workerId)fail('UNAUTHORIZED','승인된 회사 PC runner 인증이 필요합니다.');
        actor={kind:'worker',workerId};
      }else fail('INVALID_REQUEST','지원하지 않는 요청입니다.');
      if(Object.keys(body).some(k=>['path','storagePath','snapshot_id','serviceRoleKey','verifiedArtifacts'].includes(k)))fail('INVALID_REQUEST','서버 소유 필드는 요청으로 지정할 수 없습니다.');
      let result;
      if(action==='upload-finalize'){
        const jobId=uuid(body.jobId), snapshot=await store.read({jobId}), job=snapshot.jobs.find(j=>j.jobId===jobId);
        const hash=await sha256(body.leaseToken||'');
        if(job&&['collected','previewed'].includes(job.state)&&job.completedWorkerId===workerId&&job.completedLeaseHash===hash){result=await queue.dispatch(action,body,actor);}
        else{
          assertLease(job,workerId,hash,Number(snapshot.now));
          if(!job.manifest?.length)fail('INVALID_ARTIFACT','먼저 원본 manifest를 선언해주세요.');
          await storage.assertPrivate();
          await storage.assertObjects(jobId,job.manifest);
          const verifiedArtifacts=await verifyArtifactBytes(job.manifest,async file=>storage.readBytes(file.path,file.size));
          // dispatch rechecks the current lease after slow downloads; SQL CAS
          // also checks expiry at commit, so cancellation/expiry wins the race.
          result=await queue.dispatch(action,{...body,verifiedArtifacts},actor);
        }
      }else{
        result=await queue.dispatch(action,body,actor);
        if(action==='upload-init'){
          await storage.assertPrivate();
          const manifest=[];
          for(const file of result.manifest){const signed=await storage.signUpload(file.path);manifest.push({...file,...signed,method:'PUT'});}
          // A lease lost during signing never produces an accepted completion.
          await queue.dispatch('heartbeat',body,actor);
          result={...result,manifest};
        }
        if(action==='artifacts'){
          await storage.assertPrivate();
          const artifacts=[];
          for(const file of result.manifest){artifacts.push({ordinal:file.ordinal,name:file.name,size:file.size,sha256:file.sha256,signedUrl:await storage.signDownload(file.path,DOWNLOAD_TTL_SECONDS)});}
          // Recheck cancellation/session after generating bearer download URLs.
          if(!await guardSession(sessionHeader(req.headers.get('x-operations-hub-session'))))fail('UNAUTHORIZED','운영 세션이 만료되었습니다.');
          await queue.dispatch('artifacts',body,actor);
          result={job:result.job,manifest:result.job.collectionManifest,artifacts,expiresIn:DOWNLOAD_TTL_SECONDS};
        }
      }
      return respond(200,{ok:true,version:VERSION,...result});
    }catch(error){
      const code=Object.hasOwn(STATUS,error?.code)?error.code:'QUEUE_UNAVAILABLE';
      return respond(STATUS[code],{ok:false,code,message:code===error?.code?error.message:'동기화 요청을 처리하지 못했습니다.'});
    }
  };
}
