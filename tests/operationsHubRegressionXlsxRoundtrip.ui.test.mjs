import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';

// Integration QA only: real workbook bytes and browser XML/ZIP APIs; no DB or marketplace calls.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = process.env.ABLY_QA_SOURCE || 'C:/Users/hihi0/OneDrive/문서/2026/0908/에블test.xlsx';
const runtime = 'C:/Users/hihi0/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules';
const source = fs.readFileSync(sourcePath);
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const beforeHash = digest(source);
const browser = await chromium.launch({channel:'msedge', headless:true});
try {
  const page = await browser.newPage();
  await page.route('**/*', route => route.abort());
  await page.setContent('<html><body><h1>Isolated XLSX roundtrip QA</h1></body></html>');
  await page.addScriptTag({path:path.resolve(root, '../xlsx.full.min.js')});
  await page.addScriptTag({path:path.join(runtime, 'jszip/dist/jszip.min.js')});
  await page.addScriptTag({path:path.join(root, 'mockups/operations-hub/ably-stock-export.js')});
  const report = await page.evaluate(async base64 => {
    const verify = (condition, message) => {if (!condition) throw Error(message);};
    const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    const file = new File([bytes], 'read-only-source.xlsx');
    const originalBook = XLSX.read(bytes, {type:'array'});
    const originalSheet = originalBook.Sheets['옵션기본'];
    const raw = XLSX.utils.sheet_to_json(originalSheet, {header:1, defval:'', raw:true});
    const rows = raw.slice(1).filter(row => row.some(value => value !== ''));
    verify(rows.length === 90, `Expected source 90 data rows, got ${rows.length}`);
    verify(rows.every(row => row[2] === 'sellpia_8149'), 'Source seller identity changed');
    verify(rows.every(row => row[16] === ''), 'Expected Q blank in source');
    verify(AblyStockExport.headers.every((header, index) => raw[0][index] === header), '35 source headers');
    const originalZip = await JSZip.loadAsync(bytes);
    const workbookXml = new DOMParser().parseFromString(await originalZip.file('xl/workbook.xml').async('string'), 'application/xml');
    const descriptor = [...workbookXml.getElementsByTagName('sheet')].find(sheet => sheet.getAttribute('name') === '옵션기본');
    const relationships = new DOMParser().parseFromString(await originalZip.file('xl/_rels/workbook.xml.rels').async('string'), 'application/xml');
    const target = [...relationships.getElementsByTagName('Relationship')].find(rel => rel.getAttribute('Id') === descriptor.getAttribute('r:id')).getAttribute('Target');
    const sheetPath = target.startsWith('/') ? target.slice(1) : 'xl/' + target.replace(/^\.\//, '');
    async function verifyPreservation(blob, changedCells, expectedRows = 90) {
      const array = await blob.arrayBuffer();
      const afterZip = await JSZip.loadAsync(array);
      const originalNames = Object.keys(originalZip.files).filter(name => !originalZip.files[name].dir).sort();
      const afterNames = Object.keys(afterZip.files).filter(name => !afterZip.files[name].dir).sort();
      verify(JSON.stringify(originalNames) === JSON.stringify(afterNames), 'ZIP parts changed');
      for (const name of originalNames) if (name !== sheetPath) {
        verify(await originalZip.file(name).async('base64') === await afterZip.file(name).async('base64'), `Unrelated ZIP part changed: ${name}`);
      }
      const book = XLSX.read(array, {type:'array'});
      verify(JSON.stringify(book.SheetNames) === JSON.stringify(originalBook.SheetNames), 'Sheet names changed');
      const after = book.Sheets['옵션기본'];
      verify(XLSX.utils.decode_range(after['!ref']).e.r === expectedRows, 'Export row count changed');
      if (expectedRows === 90) {
        for (let r = 0; r <= 90; r++) for (let c = 0; c < 35; c++) {
          const cell = XLSX.utils.encode_cell({r, c});
          const wanted = Object.hasOwn(changedCells, cell) ? changedCells[cell] : originalSheet[cell]?.v ?? '';
          verify((after[cell]?.v ?? '') === wanted, `Unexpected value at ${cell}: ${after[cell]?.v} versus ${wanted}`);
        }
      }
      return {sheet:after, zip:afterZip, originalNames};
    }
    const item0 = {line:2, row:[...raw[1]], memoText:'001-1/001-2'};
    const item1 = {line:3, row:[...raw[2]], memoText:''};
    const mixed = await AblyStockExport.build({file, items:[item0,item1], results:[{value:0},{value:null,error:'fixture missing stock'}]});
    const first = await verifyPreservation(mixed, {Q2:'001-1/001-2',X2:0});
    verify(first.sheet.X2.t === 'n', 'Zero stock must remain numeric in *판매수량');
    verify(first.sheet.Q2.t === 's', 'Leading-zero SKU memo must remain text');
    const finalRow = [...raw[90]]; finalRow[23] = 5;
    const selected = await AblyStockExport.buildFromTemplate(file, [finalRow], [91]);
    await verifyPreservation(selected, {X91:5});
    let duplicateRejected = false;
    try {await AblyStockExport.buildFromTemplate(file, [finalRow,finalRow], [91,91]);} catch {duplicateRejected = true;}
    verify(duplicateRejected, 'Duplicate source row mapping must reject');
    const generatedRows = Array.from({length:12}, (_, index) => {
      const row = [...raw[1]];row[3] = `QA & <pair> ${index + 1}`;row[16] = `001-${index + 1}`;row[23] = index;return row;
    });
    const generated = await AblyStockExport.buildFromTemplate(file, generatedRows);
    const generatedResult = await verifyPreservation(generated, {}, 12);
    verify(generatedResult.sheet.D13.v === 'QA & <pair> 12', 'XML escaping at multi-digit row');
    verify(generatedResult.sheet.Q13.v === '001-12', 'Text SKU at multi-digit row');
    verify(generatedResult.sheet.X13.v === 11, 'Last generated stock');
    const xml = await generatedResult.zip.file(sheetPath).async('string');
    verify(new DOMParser().parseFromString(xml, 'application/xml').getElementsByTagName('parsererror').length === 0, 'Export XML must parse');
    return {sourceRows:rows.length, columns:35, zipParts:first.originalNames.length, selectiveExports:2, generatedRows:12, externalRequests:0};
  }, source.toString('base64'));
  assert.equal(digest(fs.readFileSync(sourcePath)), beforeHash, 'Source workbook must be byte-identical after QA');
  console.log('PASS real XLSX browser roundtrip: '+JSON.stringify(report));
} finally {
  await browser.close();
}
