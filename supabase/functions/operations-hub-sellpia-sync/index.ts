import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import {createClient} from 'npm:@supabase/supabase-js@2.57.4';
import {QueueProtocol,fail,MAX_FILE_BYTES,sha256} from './protocol.mjs';
import {RpcQueueStore} from './rpc-store.mjs';
import {createHandler} from './handler.mjs';

const url=Deno.env.get('SUPABASE_URL')||'';
const options={auth:{persistSession:false,autoRefreshToken:false}};
const guard=createClient(url,Deno.env.get('SUPABASE_ANON_KEY')||'',options);
const admin=createClient(url,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')||'',options);
const store=new RpcQueueStore(admin);
const bucket=admin.storage.from('seller-originals');
const storage={
  async assertPrivate(){const {data,error}=await admin.storage.getBucket('seller-originals');if(error||data?.public!==false)fail('STORAGE_UNAVAILABLE','private staging Storage 설정을 확인해주세요.');},
  async signUpload(path:string){const {data,error}=await bucket.createSignedUploadUrl(path,{upsert:false});if(error||!data||!data.signedUrl||!data.token)return fail('STORAGE_UNAVAILABLE','원본 업로드 권한을 만들지 못했습니다.');return {signedUrl:data.signedUrl,token:data.token};},
  async signDownload(path:string,ttl:number){const {data,error}=await bucket.createSignedUrl(path,ttl);if(error||!data||!data.signedUrl)return fail('STORAGE_UNAVAILABLE','원본 다운로드 권한을 만들지 못했습니다.');return data.signedUrl;},
  async assertObjects(jobId:string,manifest:Array<{path:string,size:number}>){
    const directory=`sellpia-sync/${jobId}`;
    const {data,error}=await bucket.list(directory,{limit:10});
    const files=(data||[]).filter(x=>x.id);
    if(error||files.length!==manifest.length||files.some(x=>!manifest.some(f=>f.path===`${directory}/${x.name}`&&f.size===Number(x.metadata?.size))))fail('INVALID_ARTIFACT','staging 원본의 실제 개수·이름·크기가 manifest와 다릅니다.');
  },
  async readBytes(path:string,expectedSize:number){
    const {data,error}=await bucket.download(path);
    if(error||!data||data.size!==expectedSize||data.size>MAX_FILE_BYTES)return fail('INVALID_ARTIFACT','실제 원본 크기를 검증하지 못했습니다.');
    return await data.arrayBuffer();
  }
};
let workers:Record<string,string>={};
try{const configured=JSON.parse(Deno.env.get('SELLPIA_SYNC_WORKERS_JSON')||'{}');if(configured&&typeof configured==='object'&&!Array.isArray(configured))workers=configured;}catch{/* malformed configuration fails closed */}
const runtime=async(action:string,body:Record<string,unknown>,actor:Record<string,unknown>,flags:{applyEnabled:boolean})=>{
  const payload={...body};let applyToken:string|undefined;
  if(action==='apply-init'){applyToken=[...crypto.getRandomValues(new Uint8Array(32))].map(x=>x.toString(16).padStart(2,'0')).join('');payload.tokenHash=await sha256(applyToken);}
  const {data,error}=await admin.rpc('hub_sellpia_sync_runtime_v1',{p_action:action,p_payload:payload,p_session_token:actor.sessionToken||null,p_apply_enabled:flags.applyEnabled});
  if(error){const message=String(error.message||'');const code=error.code==='42501'?'UNAUTHORIZED':error.code==='P0002'?'NOT_FOUND':message.includes('APPLY_DISABLED')?'APPLY_DISABLED':message.includes('REVIEW_REQUIRED')?'REVIEW_REQUIRED':error.code==='22023'?'INVALID_REQUEST':error.code==='55000'?'CONFLICT':'QUEUE_UNAVAILABLE';fail(code,code==='REVIEW_REQUIRED'?'SKU 변동 검토 및 별도 승인이 필요합니다.':code==='CONFLICT'?'원본 기준 또는 작업 상태가 변경되었습니다. 상태를 다시 확인해주세요.':code==='APPLY_DISABLED'?'DB 자동 반영이 비활성 상태입니다.':'동기화 상태 또는 권한을 확인해주세요.');}
  const result=Array.isArray(data)?data[0]:data;
  if(action==='hello'){
    // Bounded best-effort housekeeping cannot turn a health report into a
    // failed import or remove permanent original-file paths.
    const {data:candidates,error:cleanupError}=await admin.rpc('hub_sellpia_sync_cleanup_candidates_v1');
    if(!cleanupError&&Array.isArray(candidates)){
      const paths=candidates.map((f:{path?:string})=>String(f.path||'')).filter((p:string)=>/^sellpia-sync\/[0-9a-f-]{36}\/[1-3]\.(csv|xlsx|xls)$/.test(p));
      if(paths.length){const {error:removeError}=await bucket.remove(paths);if(!removeError)await admin.rpc('hub_sellpia_sync_cleanup_ack_v1',{p_paths:paths});}
    }
  }
  return {...result,...(applyToken?{applyToken,job:{...result.job,applyProduction:true}}:{})};
};
Deno.serve(createHandler({queue:new QueueProtocol(store),store,storage,
  guardSession:async(token:string)=>{const {data,error}=await admin.rpc('hub_sellpia_sync_operator_v1',{p_session_token:token});const value=Array.isArray(data)?data[0]:data;return error||!value?.username?false:value;},
  workerToken:Deno.env.get('SELLPIA_SYNC_WORKER_TOKEN')||'',workerId:Deno.env.get('SELLPIA_SYNC_WORKER_ID')||'',
  workers,runtime,applyEnabled:Deno.env.get('SELLPIA_SYNC_APPLY_ENABLED')==='true',
  // Must remain opt-in after schema, Storage ACL and company-PC review.
  enabled:Deno.env.get('SELLPIA_SYNC_ENABLED')==='true'
}));
