import assert from 'node:assert/strict';
import {fileURLToPath,pathToFileURL} from 'node:url';

const {chromium}=await import(pathToFileURL('C:/Users/hihi0/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs'));

const root=new URL('../mockups/operations-hub/',import.meta.url);
const browser=await chromium.launch({channel:'msedge',headless:true});
try{
  const page=await browser.newPage();
  await page.setContent(`<main>
    <div id="rw-backdrop">
      <h2 id="rw-drawer-title">엑셀 태그 일괄등록</h2>
      <div id="rw-drawer-body"></div>
      <p id="rw-drawer-status"></p>
    </div>
  </main>`);
  await page.evaluate(()=>{
    window.HubPriceWorkspace={state:{tagImport:null},refresh:async()=>{}};
    window.SystemV3Data={syncTagAssignments:async()=>({current_count:0,target_count:3,add_count:3,remove_count:0})};
  });
  await page.addScriptTag({path:fileURLToPath(new URL('ui-cleanup-v1.js',root))});
  await page.waitForSelector('.ui-tag-sync-panel',{state:'attached'});

  const timerAdvanced=await page.evaluate(()=>new Promise(resolve=>setTimeout(()=>resolve(true),50)));
  assert.equal(timerAdvanced,true,'tag import observer must not starve the browser event loop');
  assert.equal(await page.locator('.ui-tag-sync-panel').isHidden(),true);

  await page.evaluate(()=>{
    HubPriceWorkspace.state.tagImport={
      mode:'metadata_tag',
      rows:[{sku:'10000-1'},{sku:'10000-2'},{sku:'10000-3'}],
      files:[{
        parsed:{mode:'metadata_tag'},
        resolution:{tag:{tag_id:'tag-1',tag_name:'소스_2000'}},
        rows:[{sku:'10000-1'},{sku:'10000-2'},{sku:'10000-3'}]
      }]
    };
    document.body.classList.add('qa-sync-ready');
  });
  await page.waitForFunction(()=>document.querySelector('[data-sync-copy]')?.textContent.includes('최종 SKU 목록'));
  assert.equal(await page.locator('.ui-tag-sync-panel').isVisible(),true);
  assert.match(await page.locator('.ui-tag-sync-counts').innerText(),/파일 3/);

  await page.evaluate(()=>{
    HubPriceWorkspace.state.tagImport=null;
    document.body.classList.add('qa-sync-cleared');
  });
  await page.waitForFunction(()=>document.querySelector('.ui-tag-sync-panel')?.hidden===true);
  assert.equal(await page.evaluate(()=>new Promise(resolve=>setTimeout(()=>resolve(true),50))),true);
  console.log('PASS tag sync observer: idle panel does not self-trigger hidden mutations or freeze navigation timers.');
}finally{
  await browser.close();
}
