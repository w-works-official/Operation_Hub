import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {performance} from 'node:perf_hooks';
export const sqlLiteral=value=>"'"+String(value).replaceAll("'","''")+"'";
export const sqlJson=value=>sqlLiteral(JSON.stringify(value))+'::jsonb';
export async function createNativeSqlRunner(){
 const local=process.env.LOCALAPPDATA;
 if(!local)throw Error('QA_LOCALAPPDATA_REQUIRED');
 const executable=path.join(local,'Codex/sellpia-timeout-pg17/pgsql/bin/psql.exe');
 const passwordFile=path.join(local,'OperationHubSellpiaSyncQA/pg-password.local');
 const password=(await fs.readFile(passwordFile,'utf8')).trim();
 if(!password)throw Error('QA_LOCAL_PASSWORD_EMPTY');
 const call=async(statement,{timeoutMs=125000}={})=>{
  const started=performance.now();
  const outcome=await new Promise((resolve,reject)=>{
   const child=spawn(executable,['-X','-qAt','-v','ON_ERROR_STOP=1','-h','127.0.0.1','-p','55474','-U','postgres','-d','operation_hub_sync_qa'],
    {windowsHide:true,env:{...process.env,PGPASSWORD:password,PGCLIENTENCODING:'UTF8',PGAPPNAME:'operation_hub_sync_qa'}});
   let stdout='',stderr='';
   child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
   child.stdout.on('data',value=>{stdout+=value;});child.stderr.on('data',value=>{stderr+=value;});
   const timer=setTimeout(()=>child.kill(),timeoutMs);
   child.on('error',()=>{clearTimeout(timer);reject(Error('QA_NATIVE_POSTGRES_PROCESS_FAILED'));});
   child.on('close',code=>{
    clearTimeout(timer);
    if(code!==0){const reasons=['REVIEW_REQUIRED','APPLY_DISABLED','baseline snapshot changed','Matrix is not ready','authorization','permission denied','statement timeout','another import','scope expired'];
     const reason=reasons.find(value=>stderr.includes(value))||'unclassified_sql_failure';
     const error=Error('QA_NATIVE_SQL_FAILED');error.safeReason=reason;error.wallMs=performance.now()-started;resolve({ok:false,error});
    }else resolve({ok:true,stdout:stdout.trim(),wallMs:performance.now()-started});
   });
   child.stdin.end(statement+'\n');
  });
  if(!outcome.ok)throw outcome.error;
  return outcome;
 };
 const json=async statement=>{
  const result=await call(statement);const lines=result.stdout.split(/\r?\n/).filter(Boolean);
  if(!lines.length)throw Error('QA_NATIVE_JSON_MISSING');
  try{return {data:JSON.parse(lines.at(-1)),wallMs:result.wallMs};}catch{throw Error('QA_NATIVE_JSON_INVALID');}
 };
 const identity=(await json("select jsonb_build_object('database',current_database(),'address',inet_server_addr()::text,'port',inet_server_port(),'version',current_setting('server_version'))")).data;
 if(identity.database!=='operation_hub_sync_qa'||identity.address!=='127.0.0.1'||identity.port!==55474)throw Error('QA_NATIVE_DATABASE_SCOPE');
 return {call,json,identity,passwordFileRead:true};
}
