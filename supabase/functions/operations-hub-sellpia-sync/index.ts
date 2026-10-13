import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import {createClient} from 'npm:@supabase/supabase-js@2.57.4';
import {QueueProtocol,fail,MAX_FILE_BYTES} from './protocol.mjs';
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
  async signUpload(path:string){const {data,error}=await bucket.createSignedUploadUrl(path,{upsert:false});if(error||!data?.signedUrl||!data?.token)fail('STORAGE_UNAVAILABLE','원본 업로드 권한을 만들지 못했습니다.');return {signedUrl:data.signedUrl,token:data.token};},
  async signDownload(path:string,ttl:number){const {data,error}=await bucket.createSignedUrl(path,ttl);if(error||!data?.signedUrl)fail('STORAGE_UNAVAILABLE','원본 다운로드 권한을 만들지 못했습니다.');return data.signedUrl;},
  async assertObjects(jobId:string,manifest:Array<{path:string,size:number}>){
    const directory=`sellpia-sync/${jobId}`;
    const {data,error}=await bucket.list(directory,{limit:10});
    const files=(data||[]).filter(x=>x.id);
    if(error||files.length!==manifest.length||files.some(x=>!manifest.some(f=>f.path===`${directory}/${x.name}`&&f.size===Number(x.metadata?.size))))fail('INVALID_ARTIFACT','staging 원본의 실제 개수·이름·크기가 manifest와 다릅니다.');
  },
  async readBytes(path:string,expectedSize:number){
    const {data,error}=await bucket.download(path);
    if(error||!data||data.size!==expectedSize||data.size>MAX_FILE_BYTES)fail('INVALID_ARTIFACT','실제 원본 크기를 검증하지 못했습니다.');
    return await data.arrayBuffer();
  }
};
Deno.serve(createHandler({queue:new QueueProtocol(store),store,storage,
  guardSession:async(token:string)=>{const {data,error}=await guard.rpc('operations_hub_check_session_v1',{p_session_token:token});const value=Array.isArray(data)?data[0]:data;return !error&&value?.authenticated===true;},
  workerToken:Deno.env.get('SELLPIA_SYNC_WORKER_TOKEN')||'',workerId:Deno.env.get('SELLPIA_SYNC_WORKER_ID')||'',
  // Must remain opt-in after schema, Storage ACL and company-PC review.
  enabled:Deno.env.get('SELLPIA_SYNC_ENABLED')==='true'
}));
