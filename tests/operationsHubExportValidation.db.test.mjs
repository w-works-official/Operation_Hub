import assert from 'node:assert/strict';
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
const {PGlite}=await import(pathToFileURL('C:/Users/hihi0/Documents/Codex/2026-08-11/https-docs-google-com-spreadsheets-d/work/System_V3/tests/workspace-db/node_modules/@electric-sql/pglite/dist/index.js'));
const db=new PGlite();
try {
  await db.exec(`create table public.operations_hub_change_queue(
    change_id bigint primary key,status text,source_channel text,seller_product_code text,
    target_safety_state text,field_key text,before_value jsonb,after_value jsonb,target_channels text[],
    validation_errors jsonb,validated_at timestamptz,error_message text,status_message text,updated_at timestamptz
  );
  insert into public.operations_hub_change_queue(change_id,status,source_channel,seller_product_code,target_safety_state,field_key,before_value,after_value,target_channels)
  values(1,'pending','smartstore','p1','ready','sellpia_current_stock','1','2','{smartstore}'),
        (2,'failed','smartstore','p2','incomplete','sellpia_current_stock','1','2','{smartstore}'),
        (3,'failed','smartstore','p3','conflict','sellpia_current_stock','1','2','{smartstore}'),
        (4,'pending','smartstore','p4','ready','sellpia_current_stock','1','-2','{smartstore}'),
        (5,'pending',null,null,'ready','sellpia_current_stock','1','3','{smartstore}');`);
  await db.exec(fs.readFileSync(new URL('../outputs/db-maintenance/20260908_export_validation_safety.sql',import.meta.url),'utf8'));
  const result=await db.query('select * from public.validate_operations_hub_changes(array[1,2,3,4,5]::bigint[])');
  assert.deepEqual(result.rows,[{validated_count:2,failed_count:3}]);
  const states=await db.query('select change_id::int,status,validation_errors from public.operations_hub_change_queue order by change_id');
  assert.deepEqual(states.rows.map(r=>r.status),['validated','failed','failed','failed','validated']);
  assert.match(states.rows[1].validation_errors[0],/원본의 재고/);
  assert.match(states.rows[2].validation_errors[0],/충돌/);
  console.log('Postgres validation regression: ready/global pass; incomplete/conflict/negative remain failed');
} finally {await db.close();}
