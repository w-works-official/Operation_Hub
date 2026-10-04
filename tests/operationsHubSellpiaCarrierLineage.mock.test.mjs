import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {resolveSellpiaCarrierLineage} from '../supabase/functions/operations-hub-original-files/carrier-lineage.mjs';

const FULL='00000000-0000-4000-8000-000000000001';
const PATCH1='00000000-0000-4000-8000-000000000002';
const PATCH2='00000000-0000-4000-8000-000000000003';
const OTHER='00000000-0000-4000-8000-000000000004';
const row=(id,mode,base)=>({snapshot_id:id,metadata:{upload_mode:mode,...(base?{base_snapshot_id:base}:{})}});

test('Sellpia PATCH ancestry resolves its exact immutable FULL carrier',async()=>{
 const rows=new Map([row(FULL,'full'),row(PATCH1,'patch',FULL),row(PATCH2,'patch',PATCH1),row(OTHER,'full')].map(value=>[value.snapshot_id,value]));
 const lookup=async id=>rows.get(id)||null;
 const result=await resolveSellpiaCarrierLineage(rows.get(PATCH2),lookup,FULL);
 assert.equal(result.carrier.snapshot_id,FULL);
 assert.equal(result.stateSnapshotId,PATCH2);
 assert.equal(result.reason,'');
 assert.equal((await resolveSellpiaCarrierLineage(rows.get(PATCH2),lookup,OTHER)).carrier,null,'an unrelated FULL must never be selected');
});

test('inventory-count snapshots remain state snapshots and resolve the original FULL carrier',async()=>{
 const inventory='00000000-0000-4000-8000-000000000005';
 const rows=new Map([row(FULL,'full'),row(PATCH1,'patch',FULL),row(inventory,'inventory_count',PATCH1)].map(value=>[value.snapshot_id,value]));
 const result=await resolveSellpiaCarrierLineage(rows.get(inventory),async id=>rows.get(id)||null,FULL);
 assert.equal(result.carrier.snapshot_id,FULL);
 assert.equal(result.stateSnapshotId,inventory);
 assert.equal(result.reason,'');
});

test('Sellpia carrier lineage fails closed on missing, unready, cyclic and invalid parents',async()=>{
 const full=row(FULL,'full'),patch=row(PATCH1,'patch',FULL);
 assert.match((await resolveSellpiaCarrierLineage(patch,async()=>null)).reason,/ready/);
 assert.equal((await resolveSellpiaCarrierLineage(patch,async()=>full)).carrier.snapshot_id,FULL);
 assert.match((await resolveSellpiaCarrierLineage(row(PATCH1,'patch',PATCH1),async()=>null)).reason,/참조/);
 assert.match((await resolveSellpiaCarrierLineage(row(PATCH1,'unknown'),async()=>null)).reason,/지원하지/);
 assert.match((await resolveSellpiaCarrierLineage(null,async()=>null)).reason,/ready/);
});

test('signed manifest follows DB lineage without accepting a browser Storage path',()=>{
 const edge=fs.readFileSync('supabase/functions/operations-hub-original-files/index.ts','utf8');
 assert.match(edge,/resolveSellpiaCarrierLineage\(latest, readReadySnapshot, cleanText\(body\.snapshot_id\)\)/);
 assert.match(edge,/\.eq\("snapshot_id", id\)\.eq\("upload_status", "ready"\)/);
 assert.match(edge,/state_snapshot_id: lineage\.stateSnapshotId/);
 assert.match(edge,/files\.length === 3/);
 assert.doesNotMatch(edge,/body\.(?:path|storage_path)/);
});
