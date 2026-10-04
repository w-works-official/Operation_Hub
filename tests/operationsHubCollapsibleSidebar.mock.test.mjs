import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../mockups/operations-hub/index.html', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../mockups/operations-hub/app.js', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../mockups/operations-hub/style.css', import.meta.url), 'utf8');

assert.match(html, /id="sidebar-toggle"[\s\S]*?aria-controls="primary-sidebar"[\s\S]*?aria-expanded="true"/, 'the header must expose an accessible sidebar toggle');
assert.match(html, /id="primary-sidebar"[\s\S]*?class="side-metrics"[\s\S]*?id="live-total-sku"[\s\S]*?id="live-latest-sync"[\s\S]*?class="side-foot"/, 'the compact live summary must live at the bottom of the primary sidebar');
assert.doesNotMatch(html, /<section class="status-strip"/, 'the redundant full-width metric strip must be removed');
assert.match(app, /SIDEBAR_COLLAPSED_KEY = 'system-v3-primary-sidebar-collapsed'[\s\S]*?classList\.toggle\('sidebar-collapsed'[\s\S]*?setAttribute\('aria-expanded'[\s\S]*?localStorage\.setItem\(SIDEBAR_COLLAPSED_KEY/, 'sidebar state must remain accessible and persist across refreshes');
assert.match(css, /\.app-shell\.sidebar-collapsed \.main-grid\{grid-template-columns:0 minmax\(0,1fr\)[\s\S]*?\.app-shell\.sidebar-collapsed \.sidebar\{visibility:hidden/, 'collapsing the sidebar must give its full width to the content area');
assert.match(css, /\.side-metrics-grid\{display:grid;grid-template-columns:repeat\(2,minmax\(0,1fr\)\)[\s\S]*?\.side-metric em\{display:none\}/, 'sidebar metrics must use a compact two-column presentation');
assert.match(html, /style\.css\?v=[^"\s]+[\s\S]*?app\.js\?v=[^"\s]+/, 'the deployed page must invalidate cached shell assets');

console.log('operations hub collapsible sidebar contract tests passed');
