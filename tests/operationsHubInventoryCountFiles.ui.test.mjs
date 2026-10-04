import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { chromium } from 'playwright';

test('inventory-count uploader shows only the files that were selected', async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const html = fs.readFileSync('mockups/operations-hub/index.html', 'utf8')
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<link\b[^>]*>/gi, '');
    const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => route.request().url() === 'http://inventory-count-files.test/'
      ? route.fulfill({ contentType: 'text/html', body: html })
      : route.abort());
    await page.goto('http://inventory-count-files.test/');
    await page.addStyleTag({ path: 'mockups/operations-hub/style.css' });
    await page.evaluate(() => {
      window.SystemV3Data = {
        previewSellpiaInventoryCount: async files => ({
          summary: {
            fileCount: files.length,
            readRowCount: files.length,
            validSkuCount: files.length,
            changedSkuCount: files.length,
            unchangedSkuCount: 0,
            unknownSkuCount: 0,
            duplicateSameCount: 0,
            duplicateConflictCount: 0,
            errorRowCount: 0
          },
          rows: []
        })
      };
    });
    for (const file of ['discount-price-math.js', 'matrix-csv-export.js', 'sellpia-patch-export.js', 'app.js']) {
      await page.addScriptTag({ path: `mockups/operations-hub/${file}` });
    }
    await page.evaluate(() => {
      document.body.classList.remove('operations-auth-locked');
      document.getElementById('operations-auth-gate').hidden = true;
      document.getElementById('operations-app-shell').hidden = false;
      document.getElementById('operations-app-shell').inert = false;
      document.getElementById('operations-app-shell').setAttribute('aria-hidden', 'false');
      showPage('upload');
    });
    await page.locator('#source-select').selectOption('inventory_count');

    assert.equal(await page.locator('#file-slots > div').count(), 0);
    assert.equal(await page.getByText('파일 10 · 선택').count(), 0);

    await page.locator('#mock-file').setInputFiles([
      { name: 'DATA pinkrocket01.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: Buffer.from('fixture-01') },
      { name: 'DATA pinkrocket02.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: Buffer.from('fixture-02') }
    ]);

    await page.getByText('DATA pinkrocket01.xlsx', { exact: true }).waitFor();
    assert.equal(await page.locator('#file-slots > .inventory-count-file').count(), 2);
    assert.equal(await page.locator('#file-slots .inventory-count-file-remove').count(), 2);
    assert.equal(await page.getByText('파일 3 · 선택').count(), 0);

    await page.locator('#file-slots .inventory-count-file-remove').first().click();
    assert.equal(await page.locator('#file-slots > .inventory-count-file').count(), 1);
    assert.equal(await page.getByText('DATA pinkrocket01.xlsx', { exact: true }).count(), 0);
    assert.equal(await page.getByText('DATA pinkrocket02.xlsx', { exact: true }).count(), 1);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
