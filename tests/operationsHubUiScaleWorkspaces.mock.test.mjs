import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const css = await readFile(
  new URL('../mockups/operations-hub/ui-scale-workspaces.css', import.meta.url),
  'utf8',
);

assert.match(
  css,
  /--ui-workspace-caption:\s*12px[\s\S]*?--ui-workspace-body:\s*13px[\s\S]*?--ui-workspace-control:\s*14px[\s\S]*?--ui-workspace-control-height:\s*40px/,
  'workspace scale must expose a readable 27-inch default token set',
);

assert.match(
  css,
  /\.multi-link-page \.relation-folder-list > button,[\s\S]*?min-height:\s*44px[\s\S]*?font-size:\s*13px/,
  'folder rows must have readable text and a useful click target',
);

assert.match(
  css,
  /\.multi-link-page \.relation-board-node\s*\{[\s\S]*?grid-template-columns:\s*54px[\s\S]*?min-height:\s*94px/,
  'relationship cards must reserve space for the enlarged thumbnail and copy',
);

assert.match(
  css,
  /\.multi-link-page \.relation-board-node-image\s*\{[\s\S]*?width:\s*54px;[\s\S]*?height:\s*54px/,
  'relationship thumbnails must render at 52-56px in comfortable mode',
);

assert.match(
  css,
  /\.multi-link-page \.relation-board-port\s*\{[\s\S]*?width:\s*22px;[\s\S]*?height:\s*22px/,
  'relationship ports must have a larger visible and interactive target',
);

assert.match(
  css,
  /\.multi-link-page \.relation-board-node\.dragging\s*\{[\s\S]*?opacity:\s*\.72[\s\S]*?outline:\s*3px solid/,
  'dragging must remain visible instead of fading the source card away',
);

assert.match(
  css,
  /\.multi-link-page \.bundle-search-form input,[\s\S]*?height:\s*var\(--ui-workspace-control-height\);[\s\S]*?font-size:\s*var\(--ui-workspace-control\)/,
  'canonical and seller bundle forms must use the shared readable controls',
);

assert.match(
  css,
  /\.price-rule-page \.price-rule-editor-form input,[\s\S]*?height:\s*var\(--ui-workspace-control-height\);[\s\S]*?font-size:\s*var\(--ui-workspace-control\)/,
  'price and inbound-cost editors must use the shared readable controls',
);

assert.match(
  css,
  /\.ui-density-compact \.multi-link-page,[\s\S]*?--ui-workspace-caption:\s*11px[\s\S]*?--ui-workspace-control:\s*12px[\s\S]*?--ui-workspace-control-height:\s*34px/,
  'compact density must remain usable and must not regress to legacy micro text',
);

assert.doesNotMatch(css, /font-size:\s*(?:[0-9]|10)px/, 'workspace scale must not introduce text below 11px');
assert.doesNotMatch(css, /!important/, 'workspace scale must stay composable without important overrides');

console.log('operations hub relationship, bundle, and price workspace UI scale contract tests passed');
