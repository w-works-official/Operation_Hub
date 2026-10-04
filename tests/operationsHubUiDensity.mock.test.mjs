import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../mockups/operations-hub/index.html', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../mockups/operations-hub/app.js', import.meta.url), 'utf8');

assert.match(html, /ui-scale-base\.css\?v=[^"\s]+[\s\S]*?ui-scale-matrix\.css\?v=[^"\s]+[\s\S]*?ui-scale-workspaces\.css\?v=[^"\s]+/, '27-inch scale overrides must load after the legacy page styles');
assert.match(html, /id="ui-density-select"[\s\S]*?value="comfortable"[\s\S]*?value="compact"/, 'the header must expose comfortable and compact density choices');
assert.match(app, /UI_DENSITY_KEY = 'system-v3-ui-density'[\s\S]*?classList\.toggle\('ui-density-compact'[\s\S]*?dataset\.uiDensity = density[\s\S]*?localStorage\.setItem\(UI_DENSITY_KEY/, 'density must be applied globally and persist across refreshes');

console.log('operations hub UI density contract tests passed');
