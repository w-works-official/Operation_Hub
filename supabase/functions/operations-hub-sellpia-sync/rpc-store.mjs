import {fail} from './protocol.mjs';

// The only persistence RPC operates on private queue metadata. It never calls
// original-file import RPCs or touches operational source tables.
export class RpcQueueStore {
  constructor(client){this.client=client;}
  async command(action,payload){
    const {data,error}=await this.client.rpc('hub_sellpia_sync_queue_v1',{p_action:action,p_payload:payload});
    if(error)fail(error.code==='40001'?'RETRY':error.code==='42501'?'LEASE_LOST':'QUEUE_UNAVAILABLE','동기화 큐를 처리하지 못했습니다.');
    return Array.isArray(data)?data[0]:data;
  }
  async read(selector={}){return this.command('read',selector);}
  async transact(fn,selector={}){
    for(let attempt=0;attempt<8;attempt++){
      const snapshot=await this.read(selector);
      const state={jobs:structuredClone(snapshot.jobs||[]),now:Number(snapshot.now)};
      const result=fn(state);
      const before=new Map((snapshot.jobs||[]).map(j=>[j.jobId,JSON.stringify(j)]));
      const changed=state.jobs.filter(j=>before.get(j.jobId)!==JSON.stringify(j));
      if(!changed.length)return result;
      try{await this.command('apply',{expectedRevision:snapshot.revision,changed,leaseGuard:selector.leaseGuard||null});return result;}
      catch(error){if(error.code!=='RETRY')throw error;}
    }
    fail('CONFLICT','동시 요청이 많습니다. 같은 requestId로 다시 확인해주세요.');
  }
}
