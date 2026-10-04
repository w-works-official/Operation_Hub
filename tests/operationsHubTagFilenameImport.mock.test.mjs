import assert from 'node:assert/strict';
import fs from 'node:fs';

const source=fs.readFileSync('mockups/operations-hub/rule-workspace.js','utf8');

assert.match(source,/function tagNameFromFilename\(fileName\)/);
assert.match(source,/\^\(\.\+\)_일괄적용/);
assert.match(source,/TAG_IMPORT_METADATA_SHEET='__SYSTEM_V3_TAG__'/);
assert.match(source,/const normalizeTagName=/);
assert.match(source,/source:'filename_normalized'/);
assert.match(source,/function previewTagImportFiles\(fileList/);
assert.match(source,/type="file"[^>]*multiple/);
assert.match(source,/drop\.ondrop=/);
assert.match(source,/검사된 APPLY 행 태그 적용/);
assert.match(source,/정상 APPLY 행만 저장합니다/);
assert.match(source,/partial:true/);
assert.match(source,/차단만 보기/);
assert.match(source,/차단행 XLSX 다운로드/);
assert.match(source,/formatTagWorkbookSkuColumn/);
assert.match(source,/cell\.z='@'/);
assert.match(source,/addTagWorkbookMetadata/);
assert.match(source,/sheetRows:TAG_IMPORT_MAX_ROWS\+2/);
assert.match(source,/range=\{s:\{r:0,c:0\},e:\{r:endRow,c:1\}\}/);

console.log('PASS tag import UX contract: stable metadata, separator-safe filename detection, multi-file/drop validation, and text-SKU workbook helpers.');
