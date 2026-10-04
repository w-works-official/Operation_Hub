import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../mockups/operations-hub/attributes-page.js', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../mockups/operations-hub/attributes-page.css', import.meta.url), 'utf8');

assert.match(source, /SystemV3Data\.loadProducts\([\s\S]*?searchSources:\['sellpia'\][\s\S]*?SystemV3Data\.loadTags\(\)/, 'attributes page must use the existing live matrix/profile and tag contracts');
assert.match(source, /const MAX_SELECTED = 50[\s\S]*?state\.selected\.size >= MAX_SELECTED/, 'bulk selection must have an explicit upper bound');
assert.match(source, /data-attributes-apply[\s\S]*?if \(!draft\.applies\.size\)[\s\S]*?saveProductProfile/, 'writes must require an explicit apply choice and save action');
assert.match(source, /for \(let index = 0; index < rows\.length; index \+= 1\)[\s\S]*?await global\.SystemV3Data\.saveProductProfile/, 'bulk writes must run sequentially to expose progress and reduce database pressure');
assert.match(source, /savedSkus\.push\(sku\)[\s\S]*?HubPriceMaterializer\?\.materialize[\s\S]*?reason:'attributes-tag-save'/, 'tag assignment saves must materialize only the successfully affected SKUs');
assert.match(source, /profile\.material \|\| ''[\s\S]*?profile\.product_group \|\| ''[\s\S]*?profile\.shape \|\| ''/, 'unchecked attributes must preserve an existing empty value instead of inventing 기타');
assert.match(source, /material:\['14K','925 실버','써지컬'[\s\S]*?productGroup:\['부품\/소모품'[\s\S]*?shape:\['세트','링','바벨\/바'/, 'bulk editor vocabulary must match the established drawer profile vocabulary');
assert.match(source, /errors\.push[\s\S]*?속성 저장 \$\{saved\}건 완료/, 'partial failures must stay visible to the operator');
assert.match(source, /태그 생성\(DB 저장\)/, 'tag creation control must visibly disclose its immediate database write');
assert.match(source, /SystemV3Data\.createProductTag/, 'tag creation must reuse the existing constrained data contract');
assert.doesNotMatch(source, /service_role|SUPABASE_KEY|createClient\(/, 'the page module must not introduce a privileged or standalone database client');
assert.match(css, /\.attributes-layout[\s\S]*?grid-template-columns:minmax\(0,1fr\) 370px/, 'live list and explicit editor must be visually separated');

console.log('Operations hub live attributes page contract: passed');
