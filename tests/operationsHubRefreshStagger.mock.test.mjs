import assert from 'node:assert/strict';
import fs from 'node:fs';

const migration = fs.readFileSync(
  new URL('../supabase/migrations/20260831180000_stagger_operations_hub_matrix_refresh.sql', import.meta.url),
  'utf8',
);

assert.match(migration, /operations_hub_change_queue_updated_at_idx[\s\S]*?updated_at desc/, 'the stale check must not scan the complete change queue for its newest write');
assert.match(migration, /operations-hub-legacy-mapping-refresh[\s\S]*?operations-hub-csv-export-cache-refresh/, 'both established cron jobs must be resolved by stable names');
assert.match(migration, /schedule := '\*\/2 \* \* \* \*'/, 'the core bridge must run on even minutes');
assert.match(migration, /schedule := '1-59\/2 \* \* \* \*'/, 'the read cache must run on odd minutes');
assert.match(migration, /v_core_job_id is null or v_cache_job_id is null[\s\S]*?raise exception/, 'missing cron jobs must fail closed instead of silently creating duplicates');

console.log('Operations Hub refresh staggering contract: passed');
