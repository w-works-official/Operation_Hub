import assert from 'node:assert/strict';
import fs from 'node:fs';

const migration = fs.readFileSync(new URL('../supabase/migrations/20260827062022_operations_hub_product_link_drafts.sql', import.meta.url), 'utf8');
const data = fs.readFileSync(new URL('../mockups/operations-hub/data-service.js', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../mockups/operations-hub/app.js', import.meta.url), 'utf8');

assert.match(migration, /create table if not exists public\.operations_hub_product_link_drafts[\s\S]*?primary key \(source_channel, sellpia_sku_code\)/, 'product-code-only state must live outside the actual manual-link table');
assert.match(migration, /save_operations_hub_product_link_draft[\s\S]*?operations_hub_matrix_core[\s\S]*?operations_hub_manual_links[\s\S]*?raise exception '이미 실제 연결이 있는 행입니다[\s\S]*?seller_inventory_latest/, 'saving a product draft must validate the SKU and seller source while refusing to overwrite a real link');
assert.match(migration, /link_operations_hub_product_link_draft_option[\s\S]*?for update[\s\S]*?link_operations_hub_seller_item_v2[\s\S]*?delete from public\.operations_hub_product_link_drafts/, 'choosing an option must atomically create the real link and clear the staging row');
assert.match(migration, /revoke all on table public\.operations_hub_product_link_drafts from anon, authenticated[\s\S]*?grant select on table public\.operations_hub_product_link_drafts/, 'browser roles must be able to read drafts but mutate them only through validated RPCs');

assert.match(data, /async function attachProductLinkDrafts[\s\S]*?operations_hub_product_link_drafts[\s\S]*?__sellerProductLinkDrafts[\s\S]*?match_tier[\s\S]*?option_code`] = null/, 'matrix rows must overlay copied product identity without fabricating a match tier or option identity');
assert.match(data, /saveProductLinkDraft[\s\S]*?save_operations_hub_product_link_draft[\s\S]*?linkProductDraftOption[\s\S]*?link_operations_hub_product_link_draft_option/, 'the data service must keep the two persistence operations separate');
assert.match(data, /async function attachManualLinks[\s\S]*?operations_hub_manual_links[\s\S]*?__manualLinks[\s\S]*?MANUAL_LINKED/, 'focused matrix reads must overlay committed manual links without waiting for a full export-cache refresh');
assert.match(app, /mappingState\.mode === 'remaining-options'[\s\S]*?linkProductDraftOption[\s\S]*?else[\s\S]*?linkSellerItem/, 'only the follow-up remaining-option picker may convert a product draft into a real link');
assert.match(app, /function applyLocalSellerLink[\s\S]*?renderLiveMatrixRows\(matrixState\.rows\)[\s\S]*?refreshMatrixSkus\(\[sku\]\)\.catch/, 'a committed option link must render locally first and use only a focused SKU reread');
assert.match(app, /saved seller link targeted refresh failed[\s\S]*?연결은 저장됐지만 최신 상세값 조회가 지연됩니다/, 'a failed post-write reread must not be reported as a failed link mutation');
assert.doesNotMatch(app.slice(app.indexOf("mappingSearchResults.addEventListener('click'"), app.indexOf('const pricePopover')), /await refreshLiveData\(\)/, 'seller linking must not trigger a full matrix and dashboard reload in the write transaction');
assert.match(app, /option-selection-pending[\s\S]*?옵션 선택 대기/, 'the matrix must clearly show that copied product identity is not connected yet');

console.log('Operations hub product-link draft contract: passed');
