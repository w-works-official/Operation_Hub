import assert from "node:assert/strict";
import fs from "node:fs";

const migration = fs.readFileSync(
  new URL("../supabase/image-project-migrations/20260812032000_allow_dashboard_sellpia_photo_upsert.sql", import.meta.url),
  "utf8",
);
const deleteMigration = fs.readFileSync(
  new URL("../supabase/image-project-migrations/20260903031502_allow_dashboard_sellpia_photo_delete.sql", import.meta.url),
  "utf8",
);

assert.match(migration, /for insert[\s\S]*?to anon, authenticated[\s\S]*?bucket_id = 'product-images'/);
assert.match(migration, /for update[\s\S]*?using[\s\S]*?with check/);
assert.match(migration, /name ~ '\^sellpia\/\[\^\/\]\+\[\.\]jpg\$'/);
assert.match(deleteMigration, /for delete[\s\S]*?to anon, authenticated[\s\S]*?bucket_id = 'product-images'/);
assert.match(deleteMigration, /name ~ '\^sellpia\/\[\^\/\]\+\[\.\]jpg\$'/);

console.log("Hub product image storage policy contract: passed");
