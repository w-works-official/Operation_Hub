import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('../mockups/operations-hub/data-service.js',import.meta.url),'utf8');
const plain=value=>JSON.parse(JSON.stringify(value));
const version='a'.repeat(32);
const node=(id,sku=`SKU-${id}`)=>({nodeId:id,nodeType:'sellpia_sku',sellpiaSkuCode:sku,displayName:sku});
const edge=(id,parent,child)=>({edgeId:id,parentNodeId:parent,childNodeId:child,sortOrder:100});
function page(graph,args){
 const nodes=graph.nodes.filter(row=>row.nodeId>args.p_after_node_id).sort((a,b)=>a.nodeId-b.nodeId).slice(0,args.p_page_size);
 const edges=graph.edges.filter(row=>row.edgeId>args.p_after_edge_id).sort((a,b)=>a.edgeId-b.edgeId).slice(0,args.p_page_size);
 const nextNodeId=nodes.at(-1)?.nodeId??args.p_after_node_id,nextEdgeId=edges.at(-1)?.edgeId??args.p_after_edge_id;
 return {contractVersion:1,version:graph.version||version,nodeCount:graph.nodes.length,edgeCount:graph.edges.length,nodes:plain(nodes),edges:plain(edges),nextNodeId,nextEdgeId,
  hasMoreNodes:graph.nodes.some(row=>row.nodeId>nextNodeId),hasMoreEdges:graph.edges.some(row=>row.edgeId>nextEdgeId)};
}
function harness({graph={nodes:[],edges:[]},reply=null,mutate=null}={}){
 const calls=[],events=[];
 const db={rpc(name,args){
  calls.push({name,args:plain(args)});
  const request=Promise.resolve().then(async()=>{
   if(name==='list_operations_hub_relation_graph_page_v1')return reply?reply(args,calls.length):{data:page(graph,args),error:null};
   assert.ok(mutate,`unexpected mutation ${name}`);return mutate(name,args);
  });
  request.abortSignal=()=>request;return request;
 },from(){throw Error('direct table reads/writes are forbidden in this fixture');}};
 const window={supabase:{createClient:()=>db},SystemV3SellerParsers:{},fetch:async()=>{throw Error('network forbidden');},
  CustomEvent:class{constructor(type,options={}){this.type=type;this.detail=options.detail;}},dispatchEvent:event=>events.push(plain(event)),
  HubMatrixClient:{dataset:{rows:[]}}};
 vm.runInNewContext(source,{window,console,URL,TextEncoder,TextDecoder,performance,AbortController,AbortSignal,Blob,setTimeout,clearTimeout,CustomEvent:window.CustomEvent});
 window.SystemV3Data.setOperationsHubSessionToken('offline-test-session');
 return {api:window.SystemV3Data,calls,events};
}

test('1700 nodes and 851 cross-page edges are fully read with independent pinned keysets despite legacy limit',async()=>{
 const graph={nodes:Array.from({length:1700},(_,i)=>node(i+1)),edges:Array.from({length:851},(_,i)=>edge(i+1,i+1,i+850))};
 const h=harness({graph}),progress=[],result=await h.api.loadRelationNodes({limit:20,search:'  SKU  ',folderId:7,onProgress:p=>progress.push(plain(p))});
 assert.equal(result.nodes.length,1700);assert.equal(result.edges.length,851);assert.equal(result.complete,true);assert.equal(result.nodeCount,1700);assert.equal(result.edgeCount,851);
 assert.equal(result.version,version);assert.ok(result.edges.some(row=>row.childNodeId===1700),'an edge may refer to a node loaded on the fourth page');
 assert.deepEqual(h.calls.map(call=>[call.args.p_after_node_id,call.args.p_after_edge_id]),[[0,0],[500,500],[1000,851],[1500,851],[1700,851]]);
 assert.deepEqual(h.calls.map(call=>call.args.p_expected_version),[null,version,version,version,version]);
 assert.ok(h.calls.every(call=>call.name==='list_operations_hub_relation_graph_page_v1'&&call.args.p_page_size===500&&call.args.p_search==='SKU'&&call.args.p_folder_id===7));
 assert.deepEqual(progress.at(-1),{loadedNodes:1700,totalNodes:1700,loadedEdges:851,totalEdges:851});assert.deepEqual(h.events,[]);
});

test('empty graphs still require a successful pinned final confirmation',async()=>{
 const h=harness(),result=await h.api.loadRelationNodes();assert.deepEqual(plain(result.nodes),[]);assert.deepEqual(plain(result.edges),[]);
 assert.equal(result.complete,true);assert.deepEqual(h.calls.map(call=>call.args.p_expected_version),[null,version]);
});

test('no graph result is published before the final version check settles',async()=>{
 let release;const graph={nodes:[node(1)],edges:[]},h=harness({reply:(args,index)=>index===2?new Promise(resolve=>{release=()=>resolve({data:page(graph,args),error:null});}):{data:page(graph,args),error:null}});
 let published=false;const pending=h.api.loadRelationNodes().then(result=>{published=true;return result;});
 while(!release)await new Promise(resolve=>setImmediate(resolve));assert.equal(published,false);release();assert.equal((await pending).complete,true);
});

test('changed versions, totals and final-page drift fail closed without a legacy fallback',async()=>{
 for(const change of ['version','count','final']){
  const graph={nodes:Array.from({length:501},(_,i)=>node(i+1)),edges:[]};
  const h=harness({reply:(args,index)=>{const data=page(graph,args);if(index===(change==='final'?3:2)){if(change==='count')data.nodeCount++;else data.version='b'.repeat(32);}return {data,error:null};}});
  await assert.rejects(h.api.loadRelationNodes(),/변경/);assert.ok(h.calls.every(call=>call.name==='list_operations_hub_relation_graph_page_v1'));
 }
});

test('duplicate IDs, out-of-order IDs, cursor mismatch, empty progress, invalid counts and incomplete endpoints are rejected',async()=>{
 const cases=[
  data=>{data.nodes=[node(1),node(1)];data.nodeCount=2;data.nextNodeId=1;},
  data=>{data.nodes=[node(2),node(1)];data.nodeCount=2;data.nextNodeId=1;},
  data=>{data.nextNodeId++;},
  data=>{data.nodes=[];data.nextNodeId=0;data.nodeCount=2;data.hasMoreNodes=true;},
  data=>{data.nodeCount=-1;},
  data=>{data.hasMoreNodes=true;},
  data=>{data.nodes[0].nodeId=Number.MAX_SAFE_INTEGER+1;data.nextNodeId=data.nodes[0].nodeId;},
  data=>{data.edges=[edge(1,1,999)];data.edgeCount=1;data.nextEdgeId=1;},
  data=>{data.contractVersion=2;},
  data=>{data.version='unversioned';}
 ];
 for(const change of cases){const graph={nodes:[node(1)],edges:[]},h=harness({reply:(args,index)=>{const data=page(graph,args);if(index===1)change(data);return {data,error:null};}});await assert.rejects(h.api.loadRelationNodes(),/관계 전체 조회/);}
});

test('RPC failures and AbortSignals return neither partial data nor mutation events',async()=>{
 const graph={nodes:Array.from({length:501},(_,i)=>node(i+1)),edges:[]};
 const h=harness({reply:(args,index)=>index===2?{data:null,error:{code:'40001',message:'graph changed'}}:{data:page(graph,args),error:null}});
 await assert.rejects(h.api.loadRelationNodes(),error=>error.code==='40001');assert.equal(h.calls.length,2);assert.deepEqual(h.events,[]);
 const controller=new AbortController();controller.abort();const aborted=harness({graph});await assert.rejects(aborted.api.loadRelationNodes({signal:controller.signal}),{name:'AbortError'});assert.equal(aborted.calls.length,0);
});

function mutationFixture({failBefore=false,failAfter=false,mutationError=false}={}){
 const graph={version,nodes:[node(1,'P'),node(2,'C'),node(3,'G'),node(4,'Q'),node(5,'R'),node(6,'UNRELATED')],edges:[edge(1,1,2),edge(2,2,3),edge(3,4,5)]};
 let written=false,reads=0;const writes=[];
 const h=harness({reply:args=>{reads++;if(failBefore&&!written||failAfter&&written)return {data:null,error:{message:'graph read unavailable'}};return {data:page(graph,args),error:null};},mutate:(name,args)=>{
  writes.push({name,args:plain(args)});if(mutationError)return {data:null,error:{message:'write rejected'}};
  written=true;graph.version='b'.repeat(32);let data;
  if(name==='save_operations_hub_relation_edge'){graph.edges.push(edge(4,args.p_parent_node_id,args.p_child_node_id));data={edgeId:4,parentNodeId:args.p_parent_node_id,childNodeId:args.p_child_node_id};}
  else if(name==='update_operations_hub_relation_edge_v1'){Object.assign(graph.edges.find(row=>row.edgeId===args.p_edge_id),{parentNodeId:args.p_parent_node_id,childNodeId:args.p_child_node_id});data={edgeId:args.p_edge_id,parentNodeId:args.p_parent_node_id,childNodeId:args.p_child_node_id};}
  else if(name==='remove_operations_hub_relation_edge'){graph.edges=graph.edges.filter(row=>row.edgeId!==args.p_edge_id);data={edgeId:args.p_edge_id,removed:true};}
  else if(name==='undo_operations_hub_relation_edge_event_v1'){graph.edges=graph.edges.filter(row=>row.edgeId!==1);graph.edges.push(edge(1,4,2));data={eventId:args.p_event_id,edgeId:1};}
  else if(name==='apply_operations_hub_relation_board'){graph.edges=graph.edges.filter(row=>!args.p_remove_edge_ids.includes(row.edgeId));graph.nodes.push(node(7,'NEW'));graph.edges.push(edge(4,5,7));data={nodeMap:{new:7,existing:5},nodeCount:2,savedEdgeCount:1,removedEdgeCount:args.p_remove_edge_ids.length};}
  else if(name==='archive_operations_hub_relation_node'){graph.nodes=graph.nodes.filter(row=>row.nodeId!==args.p_node_id);data={nodeId:args.p_node_id,archived:true};}
  else throw Error(`unexpected write ${name}`);
  return {data,error:null};
 }});
 return {...h,graph,writes,reads:()=>reads};
}
function notifications(h,expected){
 assert.deepEqual(h.events.find(event=>event.type==='hub-matrix-affected')?.detail.skus,expected);
 assert.equal(h.events.filter(event=>event.type==='hub-relations-changed').length,1);
 assert.equal(h.events.find(event=>event.type==='hub-relations-changed').detail.complete,true);
 assert.equal(h.events.filter(event=>event.type==='hub-matrix-price-ownership-changed').length,1);
 assert.equal(h.events.some(event=>event.type==='hub-matrix-source-reloaded'),false);
}

test('edge reparenting notifies former and new endpoint descendant closures without changing prices or unrelated SKUs',async()=>{
 const h=mutationFixture(),result=await h.api.updateRelationEdge({edgeId:1,parentNodeId:4,childNodeId:2});
 assert.deepEqual(plain(result.affected_skus),['C','G','P','Q','R']);assert.equal(result.affected_scope_complete,true);notifications(h,['C','G','P','Q','R']);
 assert.deepEqual(h.writes.map(row=>row.name),['update_operations_hub_relation_edge_v1']);assert.equal(h.reads(),4);
});

test('save, remove and undo each publish one complete relation notification with authoritative descendants',async()=>{
 const cases=[['saveRelationEdge',{parentNodeId:4,childNodeId:2},['C','G','Q','R']],['removeRelationEdge',1,['C','G','P']],['undoRelationEdgeEvent',90,['C','G','P','Q','R']]];
 for(const [method,input,expected]of cases){const h=mutationFixture(),result=await h.api[method](input);assert.deepEqual(plain(result.affected_skus),expected);notifications(h,expected);assert.equal(h.writes.length,1);}
});

test('board changes include removed-edge descendants and new node identities; unlinked node archive also invalidates its SKU',async()=>{
 const h=mutationFixture(),result=await h.api.applyRelationBoard({nodes:[{nodeId:5},{nodeType:'sellpia_sku',sellpiaSkuCode:'NEW'}],edges:[{parentKey:'existing',childKey:'new'}],removeEdgeIds:[2]});
 assert.deepEqual(plain(result.affected_skus),['C','G','NEW','R']);notifications(h,['C','G','NEW','R']);
 const archived=mutationFixture(),saved=await archived.api.archiveRelationNode(6);assert.deepEqual(plain(saved.affected_skus),['UNRELATED']);notifications(archived,['UNRELATED']);
});

test('a pre-read or mutation failure never reports a save or emits a misleading dirty event',async()=>{
 const before=mutationFixture({failBefore:true});await assert.rejects(before.api.removeRelationEdge(1),error=>/unavailable/.test(error.message));assert.equal(before.writes.length,0);assert.deepEqual(before.events,[]);
 const write=mutationFixture({mutationError:true});await assert.rejects(write.api.removeRelationEdge(1),error=>/rejected/.test(error.message));assert.equal(write.writes.length,1);assert.equal(write.reads(),2);assert.deepEqual(write.events,[]);
});

test('post-commit refresh failure returns saved result with warning and invalidates full reads without resubmitting input',async()=>{
 const h=mutationFixture({failAfter:true}),result=await h.api.updateRelationEdge({edgeId:1,parentNodeId:4,childNodeId:2});
 assert.equal(result.edgeId,1);assert.equal(result.affected_scope_complete,false);assert.match(result.relationRefreshWarning,/저장은 완료/);assert.deepEqual(plain(result.affected_skus),['C','G','P','Q','R']);
 assert.equal(h.writes.length,1);assert.equal(h.events.some(event=>event.type==='hub-matrix-source-reloaded'),false,'a relation change must not masquerade as source replacement and clear unsaved price adjustments');
 const event=h.events.find(event=>event.type==='hub-relations-changed');assert.equal(event.detail.complete,false);assert.match(event.detail.warning,/unavailable/);
});
