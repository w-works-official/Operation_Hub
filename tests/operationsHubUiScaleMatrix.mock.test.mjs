import assert from 'node:assert/strict';
import fs from 'node:fs';

const css = fs.readFileSync(
  new URL('../mockups/operations-hub/ui-scale-matrix.css', import.meta.url),
  'utf8'
);

for (const contract of [
  '--oh-matrix-font-caption: 12px',
  '--oh-matrix-font-small: 12px',
  '--oh-matrix-font-body: 13px',
  '--oh-matrix-font-control: 14px',
  '--oh-matrix-control-height: 40px',
  '--oh-matrix-row-height: 64px',
  '--oh-matrix-row-height-image-compact: 58px',
  '--oh-matrix-badge-height: 24px'
]) {
  assert.match(
    css,
    new RegExp(contract.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    `${contract} default matrix scale token is required`
  );
}

assert.match(
  css,
  /\.ui-density-compact\s*\{[\s\S]*?--oh-matrix-font-caption:\s*10px[\s\S]*?--oh-matrix-font-body:\s*12px[\s\S]*?--oh-matrix-row-height:\s*52px/,
  'compact mode must preserve readable 10-12px text and 52px rows'
);

for (const selector of [
  '.matrix-toolbar',
  '.matrix-table',
  '.price-rule-badge',
  '.product-drawer',
  '.mapping-popover',
  '.price-popover',
  '.matrix-context-menu',
  '.advanced-filter-modal',
  '.discount-editor-modal'
]) {
  assert.ok(css.includes(selector), `${selector} must receive a matrix readability override`);
}

assert.match(
  css,
  /\.matrix-table\s*\{[\s\S]*?--matrix-row-height:\s*var\(--oh-matrix-row-height\)/,
  'matrix rows must consume the shared row-height token'
);

assert.match(
  css,
  /\.product-drawer\s*\{[\s\S]*?width:\s*min\(640px,\s*calc\(100vw - 20px\)\)/,
  'the detail drawer must be wide enough for readable forms on FHD screens'
);

const openBraces = (css.match(/\{/g) || []).length;
const closeBraces = (css.match(/\}/g) || []).length;
assert.equal(openBraces, closeBraces, 'matrix scale CSS braces must be balanced');

console.log('operations hub 27-inch matrix UI scale contract tests passed');
