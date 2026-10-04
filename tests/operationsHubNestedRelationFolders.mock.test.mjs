import assert from "node:assert/strict";
import fs from "node:fs";

const migration = fs.readFileSync(new URL("../supabase/migrations/20260831143000_nested_relation_folders_and_node_archive.sql", import.meta.url), "utf8");
const html = fs.readFileSync(new URL("../mockups/operations-hub/index.html", import.meta.url), "utf8");
const app = fs.readFileSync(new URL("../mockups/operations-hub/app.js", import.meta.url), "utf8");
const data = fs.readFileSync(new URL("../mockups/operations-hub/data-service.js", import.meta.url), "utf8");
const css = fs.readFileSync(new URL("../mockups/operations-hub/style.css", import.meta.url), "utf8");

assert.match(migration, /parent_folder_id bigint[\s\S]*references public\.operations_hub_relation_folders\(folder_id\)[\s\S]*on delete restrict/, "folders must support durable parent-child nesting");
assert.match(migration, /save_operations_hub_relation_folder_v2[\s\S]*with recursive descendants[\s\S]*순환 구조는 만들 수 없습니다/, "folder moves must reject descendant-to-parent cycles");
assert.match(migration, /validate_operations_hub_relation_folder_parent[\s\S]*operations_hub_relation_folder_parent_guard/, "direct table writes must also reject invalid folder parents");
assert.match(migration, /archive_operations_hub_relation_folder_v2[\s\S]*하위 폴더를 먼저 이동하거나 보관해주세요[\s\S]*operations_hub_relation_nodes[\s\S]*folder_id = null/, "folder archive must preserve child structure and move contained nodes to unorganized");
assert.match(migration, /archive_operations_hub_relation_node[\s\S]*operations_hub_relation_edges[\s\S]*관계를 먼저 해제해주세요[\s\S]*is_active = false/, "only unlinked relation nodes may be recoverably archived");
assert.doesNotMatch(migration, /delete\s+from\s+public\.operations_hub_relation_nodes/i, "node deletion must remain recoverable");
assert.match(migration, /security invoker[\s\S]*revoke all[\s\S]*grant execute/i, "new folder and node tools must preserve invoker permissions");

assert.match(html, /id="relation-folder-form-title"[\s\S]*id="relation-folder-parent"[\s\S]*최상위 폴더/, "the folder form must let operators choose or clear a parent");
assert.match(html, /폴더와 하위 폴더는 원하는 단계까지 직접 만들고 이동할 수 있습니다/, "the UI must explain that folder nesting is separate from product relations");
assert.match(app, /relationFolderRows[\s\S]*parentFolderId[\s\S]*__depth/, "the left panel must render a recursive folder tree");
assert.match(app, /relationFolderDescendantIds[\s\S]*relationScopeNodes[\s\S]*folderIds\.has/, "selecting a parent folder must include nodes from every descendant folder");
assert.match(app, /data-folder-child[\s\S]*openRelationFolderForm\(null, folder\.folderId\)/, "every folder must provide a direct add-child action");
assert.match(app, /data-folder-edit[\s\S]*renderRelationFolderParentOptions/, "editing a folder must allow moving it under another parent");
assert.match(app, /data-archive-relation-node[\s\S]*archiveRelationNode[\s\S]*원본 상품 데이터는 유지됩니다/, "pending relation nodes must expose a safe delete action");
assert.match(data, /list_operations_hub_relation_folders_v2[\s\S]*save_operations_hub_relation_folder_v2[\s\S]*archive_operations_hub_relation_folder_v2[\s\S]*archive_operations_hub_relation_node/, "the browser adapter must only call the bounded hierarchy and archive RPCs");
assert.match(css, /--folder-depth[\s\S]*data-folder-child[\s\S]*relation-node-delete/, "nested folders and delete controls must be visually distinct");

console.log("Operations hub nested relation folders and recoverable node archive contract: passed");
