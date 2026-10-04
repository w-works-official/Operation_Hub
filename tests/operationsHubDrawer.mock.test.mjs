import assert from "node:assert/strict";
import fs from "node:fs";

const html = fs.readFileSync(new URL("../mockups/operations-hub/index.html", import.meta.url), "utf8");
const app = fs.readFileSync(new URL("../mockups/operations-hub/app.js", import.meta.url), "utf8");
const data = fs.readFileSync(new URL("../mockups/operations-hub/data-service.js", import.meta.url), "utf8");
const tagMigration = fs.readFileSync(new URL("../supabase/migrations/20260910043254_hub_tag_rule_assignments.sql", import.meta.url), "utf8");
const css = fs.readFileSync(new URL("../mockups/operations-hub/style.css", import.meta.url), "utf8");

for (const tab of ["connections", "inventory", "attributes", "history"]) {
  assert.match(html, new RegExp(`data-drawer-tab="${tab}"[\\s\\S]*?data-drawer-panel="${tab}"`), `drawer tab ${tab} must own a real panel`);
}
assert.match(html, /id="drawer-inventory-list"[\s\S]*?id="drawer-history-list"/, "inventory and history panels must have live render targets");
assert.match(html, /id="drawer-attributes-content"/, "attribute and tag editing must own a live render target");
assert.match(data, /function loadProductHistory[\s\S]*?operations_hub_change_queue[\s\S]*?operations_hub_link_history[\s\S]*?operations_hub_change_events/, "drawer history must combine queue, link, and event audit data");
assert.match(data, /loadProductHistory,[\s\S]*?saveSellerValueDraft/, "the public data adapter must expose history and seller value drafts together");
assert.match(app, /function setDrawerTab[\s\S]*?loadDrawerHistory[\s\S]*?function openProductDrawer/, "drawer tabs must switch panels and lazily load SKU history");
assert.match(app, /function renderDrawerInventoryChannel[\s\S]*?data-drawer-value="sellpia_current_stock"[\s\S]*?data-drawer-price-component="base"[\s\S]*?data-drawer-price-component="option"[\s\S]*?data-drawer-price-component="final"/, "drawer inventory must expose stock and all three price inputs per seller");
assert.match(app, /function renderDrawerPricePolicy[\s\S]*?판매처 원본 판매가[\s\S]*?시스템 기준가격[\s\S]*?태그 계산 판매가[\s\S]*?할인 적용가/, "drawer prices must expose source, system, gross, and discounted user-facing price layers");
assert.match(app, /function renderDrawerPricePolicy[\s\S]*?이 상품에 적용할 가격 조합[\s\S]*?태그 배정 저장[\s\S]*?수정안으로 적용/, "drawer prices must expose product-scoped price-combination selection and explicit export-draft application");
assert.match(app, /function renderDrawerAttributesPanel[\s\S]*?상품 공통 태그[\s\S]*?현재 SKU 예외 태그[\s\S]*?drawer-save-attributes/, "drawer attributes must separate product-level values from SKU exceptions");
assert.match(data, /operations_hub_product_profiles[\s\S]*?ensure_operations_hub_product_profile[\s\S]*?hub_profile_save_with_rules_v1/, "product profiles must load and save through the durable Supabase profile API and rule-aware transaction");
assert.match(tagMigration, /create function public\.hub_profile_save_with_rules_v1[\s\S]*?require_operations_hub_operator_session\(p_session_token\)[\s\S]*?public\.save_operations_hub_product_profile\(p_sku,p_material,p_product_group,p_shape,p_product_tag_ids,p_sku_tag_ids,actor->>'username'\)[\s\S]*?operations_private\.hub_sync_tag_rules/, "rule-aware profile save must preserve authenticated durable profile persistence and synchronize tag rules in the same RPC");
assert.match(app, /drawer-value-save[\s\S]*?saveSellerValueDraft\(\{sku, source, fieldKey:'sellpia_current_stock'[\s\S]*?saveSellerPriceDraft\([\s\S]*?targetFinalPrice[\s\S]*?optionPrice/, "drawer stock and price writes must use stock and atomic component RPCs under one batch ID");
assert.match(app, /drawer-value-save[\s\S]*?applyLocalSellerDraft[\s\S]*?applyLocalSellerPriceDraft[\s\S]*?renderLiveMatrixRows\(matrixState\.rows\)[\s\S]*?renderDrawerInventory/, "drawer seller writes must reflect locally in the matrix and open drawer");
assert.match(css, /\.price-tag-composer[\s\S]*?\.price-tag-composer-steps[\s\S]*?\.price-tag-composer-result/, "inline composite tags must have a compact ordered builder and preview");
assert.match(app, /function renderDrawerHistory[\s\S]*?CHANNEL_LABELS[\s\S]*?drawerStatusLabel/, "drawer history must render source, field, status, and time context");
assert.match(css, /\.drawer-tab-panel\[hidden\]/, "inactive drawer panels must be hidden");
assert.match(css, /\.drawer-inventory-channel\.drawer-dirty/, "edited inventory sections must expose a dirty state");
assert.match(css, /\.drawer-history-item/, "history entries must have a dedicated visual treatment");
assert.match(css, /\.drawer-price-policy[\s\S]*?\.attribute-tag-choice/, "price formulas and tag choices must have dedicated compact drawer styles");

console.log("Operations hub live product drawer contract: passed");
