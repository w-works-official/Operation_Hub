import assert from 'node:assert/strict';
import fs from 'node:fs';

const css = fs.readFileSync(
  new URL('../mockups/operations-hub/ui-scale-base.css', import.meta.url),
  'utf8'
);

for (const contract of [
  '--ui-font-caption: 11px',
  '--ui-font-support: 12px',
  '--ui-font-body: 14px',
  '--ui-font-control: 14px',
  '--ui-control-height: 40px',
  '--ui-control-height-compact: 38px',
  '--ui-badge-height: 24px',
  '--ui-table-row-height: 54px'
]) {
  assert.match(css, new RegExp(contract.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${contract} token is required`);
}

for (const scope of ['#dashboard', '#upload', '#inventory', '#jobs']) {
  assert.match(css, new RegExp(scope), `${scope} must receive the 27-inch scale overrides`);
}

assert.match(css, /@media \(max-width: 1560px\)/, 'desktop fallback must protect narrower workspaces');
assert.match(css, /@media \(max-width: 1180px\)/, 'single-column fallback must protect laptop layouts');
assert.match(css, /@media \(max-width: 760px\)/, 'small-screen fallback must remain available');

const directFontSizes = [...css.matchAll(/font-size:\s*(\d+)px/g)].map((match) => Number(match[1]));
assert.ok(directFontSizes.length > 0, 'the scale sheet must contain explicit readable font sizes');
assert.ok(directFontSizes.every((size) => size >= 11), 'the base scale sheet must not introduce text smaller than 11px');

for (const excludedFeature of ['.matrix-', '.multi-link-', '.price-rule-']) {
  assert.doesNotMatch(css, new RegExp(`^${excludedFeature.replace('.', '\\.')}`, 'm'), `${excludedFeature} selectors belong to a feature-specific scale sheet`);
}

assert.doesNotMatch(css, /!important/, 'the scale layer must remain order-driven and avoid specificity escalation');

console.log('operations hub 27-inch base UI scale contract tests passed');
