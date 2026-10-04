import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../mockups/operations-hub/app.js', import.meta.url), 'utf8');
const helperStart = source.indexOf('function parseEditableInputValue');
const helperEnd = source.indexOf('\nfunction commitEditableCellValue', helperStart);

assert.ok(helperStart >= 0 && helperEnd > helperStart, 'the shared editable-value parser must exist');

const helperSource = source.slice(helperStart, helperEnd);
const context = {};
vm.createContext(context);
vm.runInContext(`${helperSource}\nthis.parseEditableInputValue = parseEditableInputValue;`, context);
const parse = context.parseEditableInputValue;

assert.deepEqual(
  {...parse('22,000', 'number')},
  {value:'22000', numeric:true, signedNumber:false, valid:true},
  'Sellpia prices must accept comma-formatted non-negative numbers'
);
assert.deepEqual(
  {...parse('-3000', 'signed-number')},
  {value:'-3000', numeric:true, signedNumber:true, valid:true},
  'seller option prices must accept negative values'
);
assert.equal(parse('-1', 'number').valid, false, 'stock and final prices must reject negative values');
assert.equal(parse('price', 'number').valid, false, 'numeric cells must reject text');
assert.deepEqual(
  {...parse('  OWN-001  ', 'text')},
  {value:'OWN-001', numeric:false, signedNumber:false, valid:true},
  'text cells must keep the existing trim behavior'
);

assert.match(source, /function commitEditableCellValue[\s\S]*?parseEditableInputValue\(value, cell\.dataset\.valueType\)[\s\S]*?if \(!parsed\.valid\) return/, 'paste and direct Sellpia commits must use the shared parser');
assert.match(source, /function openMatrixInlineEditor\(cell\)[\s\S]*?const \{numeric, signedNumber\} = parseEditableInputValue\(before, valueType\)[\s\S]*?const parsed = parseEditableInputValue\(save \? input\.value : before, valueType\)/, 'shared inline editing must declare signed-number state before validation');
assert.match(source, /matrixBody\.addEventListener\('dblclick'[\s\S]*?openMatrixInlineEditor\(cell\)/, 'double-click editing must use the shared inline editor');
assert.match(source, /let completed = false[\s\S]*?if \(completed\) return;[\s\S]*?completed = true/, 'blur after Enter must not save the same edit twice');
assert.match(source, /keyEvent\.key === 'Enter'\) finish\(true\)[\s\S]*?keyEvent\.key === 'Escape'\) finish\(false\)[\s\S]*?input\.addEventListener\('blur', \(\) => finish\(true\)\)/, 'Enter, Escape and blur completion paths must remain wired');
assert.match(source, /cell\.matches\('\.sellpia-edit'\)[\s\S]*?commitEditableCellValue\(cell, after\)/, 'system-master and permitted Sellpia metadata edits must enter the immediate-save queue');
assert.match(source, /function addPendingChange[\s\S]*?scheduleSellpiaAutosave\(\)[\s\S]*?function flushPendingSellpiaChanges[\s\S]*?liveData\.saveSellpiaChanges/, 'matrix master edits must continue from the short debounce to the Supabase save adapter');

console.log('Operations hub inline edit validation and save flow: passed');
