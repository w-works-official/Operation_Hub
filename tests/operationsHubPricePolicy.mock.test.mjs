import assert from "node:assert/strict";
import fs from "node:fs";

const migration = fs.readFileSync(new URL("../supabase/migrations/20260818031045_operations_hub_price_policy_engine.sql", import.meta.url), "utf8");
const baselineMigration = fs.readFileSync(new URL("../supabase/migrations/20260820061850_simplify_price_rules_and_baseline_save.sql", import.meta.url), "utf8");
const assignmentMigration = fs.readFileSync(new URL("../supabase/migrations/20260820210000_price_rule_assignment_flow.sql", import.meta.url), "utf8");
const sellpiaRepriceMigration = fs.readFileSync(new URL("../supabase/migrations/20260825013259_reprice_on_sellpia_price_change.sql", import.meta.url), "utf8");
const splitTagMigration = fs.readFileSync(new URL("../supabase/migrations/20260825043000_split_price_and_discount_rule_tags.sql", import.meta.url), "utf8");
const data = fs.readFileSync(new URL("../mockups/operations-hub/data-service.js", import.meta.url), "utf8");
const app = fs.readFileSync(new URL("../mockups/operations-hub/app.js", import.meta.url), "utf8");

assert.match(migration, /operations_hub_price_policies[\s\S]*?replace_price[\s\S]*?modify_type[\s\S]*?min_price[\s\S]*?rounding_unit/, "price policies must use constrained structured stages");
assert.match(migration, /preview_operations_hub_price_policy[\s\S]*?BASE[\s\S]*?REPLACE[\s\S]*?MODIFY[\s\S]*?GUARD[\s\S]*?ROUND/, "the preview must expose every deterministic policy stage");
assert.match(migration, /enable row level security[\s\S]*?security invoker[\s\S]*?grant execute/i, "policy storage and RPCs must keep explicit client permissions");
assert.doesNotMatch(migration, /\beval\s*\(/, "price policies must never evaluate free-form code");
assert.match(data, /loadPriceRuleAssignment[\s\S]*?previewPriceRuleSet[\s\S]*?savePriceRuleAssignment/, "the frontend adapter must expose per-SKU price tag assignment methods");
assert.match(app, /이 상품에 적용할 가격 조합[\s\S]*?태그 배정 저장[\s\S]*?수정안으로 적용/, "the drawer must select and save a price combination before applying its calculated price");
assert.match(app, /tagApply[\s\S]*?stageAssignedPriceDraftsBulk\(\{skus:\[sku\], sources:\[source\][\s\S]*?pending_drafts/, "applying a composite tag must stage its gross-price and discount layers together");
assert.match(app, /새 가격 조합을 여기서 바로 만들기[\s\S]*?data-price-composer-add[\s\S]*?조합 저장 · 현재 상품에 배정/, "the drawer must build and assign a reusable price combination without leaving the current product");
assert.match(app, /composerSave[\s\S]*?savePriceRuleSet\([\s\S]*?savePriceRuleAssignment\([\s\S]*?previewPriceRuleSet/, "inline composite creation must save the ordered set, assign it to the current SKU, and verify its calculated price");
assert.match(app, /data-composer-edit[\s\S]*?data-composer-tag-mode[\s\S]*?data-composer-tag-value[\s\S]*?수정본은 새 계산 태그로 저장/, "selected calculation tags must be directly editable without mutating existing price combinations");
assert.match(app, /composerTagField[\s\S]*?applyPriceRuleTagSimpleMode[\s\S]*?composer\.tagEdits[\s\S]*?renderCurrentPricePolicy/, "atomic tag edits must recalculate the current composite locally before saving");
assert.match(app, /savedTagIds[\s\S]*?savePriceRuleTag\(priceRuleTagSavePayload[\s\S]*?savePriceRuleSet/, "edited atomic steps must be cloned before the composite tag is saved");
assert.match(app, /tagApply[\s\S]*?stageAssignedPriceDraftsBulk[\s\S]*?loadLiveMatrix\(\)[\s\S]*?renderDrawerInventory[\s\S]*?refreshChangeQueueInBackground/, "tagged price and discount application must reload the authoritative staged components");
const taggedApplyBlock = app.slice(app.indexOf('if (tagApply)'), app.indexOf('const selectedRuleSetId', app.indexOf('if (tagApply)')));
assert.match(taggedApplyBlock, /loadLiveMatrix\(/, "tagged price and discount application must reload the full product-wide result");
assert.doesNotMatch(app, /가격 규칙 저장·계산/, "the product drawer must not present a seller-wide legacy policy as if it were product-specific");
assert.match(assignmentMigration, /target_type = 'sellpia_sku'[\s\S]*?source_channel = p_source[\s\S]*?sellpia_sku_code = v_sku/, "price tag assignments must be scoped by Sellpia SKU and seller channel");
assert.doesNotMatch(assignmentMigration, /operations_hub_change_queue/, "saving a price tag assignment must not create an export draft implicitly");
assert.match(baselineMigration, /v_field = 'sellpia_current_stock'[\s\S]*?then 'pending'[\s\S]*?else 'saved'/, "the baseline workflow must keep Sellpia price edits local while stock retains its queue behavior");
assert.match(baselineMigration, /field_key = 'sellpia_sale_price'[\s\S]*?source_channel is null[\s\S]*?status in \('pending', 'validated', 'failed'\)/, "legacy raw-price seller queues must be cancelled during the workflow transition");
assert.match(sellpiaRepriceMigration, /save_operations_hub_seller_discount_draft[\s\S]*?v_has_price_change[\s\S]*?reprice_operations_hub_sellpia_price_change/, "the current workflow must atomically turn tagged Sellpia price edits into reviewable seller drafts");
assert.match(sellpiaRepriceMigration, /source_channel in \('smartstore', 'makeshop'\)/, "automatic Sellpia repricing must leave Ably unchanged");
assert.match(splitTagMigration, /tag_role in \('price', 'discount'\)[\s\S]*?calculate_operations_hub_price_rule_plan/, "price and discount tags must be stored and calculated as separate layers");
assert.match(splitTagMigration, /save_operations_hub_seller_discount_draft_inverse_legacy[\s\S]*?case when lower\(btrim\(coalesce\(p_input_mode, 'option'\)\)\) = 'discount_anchor' then 'option'/, "active discount saves must bypass the legacy inverse-pricing path");

console.log("Operations hub structured price policy contract: passed");
