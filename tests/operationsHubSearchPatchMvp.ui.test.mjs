import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';import {chromium} from 'playwright';

test('Sellpia preview uses current formula values and never inactive history',()=>{
 const source=fs.readFileSync('mockups/operations-hub/sellpia-patch-export.js','utf8'),context={};vm.createContext(context);vm.runInContext(source,context);
 const rows=[{sellpia_sku_code:'5566-1',sellpia_source_sale_price:80000,system_base_price:80000,__activeBaseOwner:true,__hubInternalPrices:{calculated_base_price:{value:59000,activeOutputRules:[{id:'2.2'}]}}},{sellpia_sku_code:'5566-4',sellpia_source_sale_price:4000,system_base_price:4000,__hubInternalPrices:{calculated_base_price:{value:48000,activeOutputRules:[],versions:[{id:'old'}]}}}];
 const plan=context.SellpiaPatchExport.buildPreview(rows,['base']);
 assert.equal(plan.values[0].base,59000);assert.equal(plan.values[1].base,4000);
 rows[0].__hubInternalPrices.calculated_base_price.stale=true;const stale=context.SellpiaPatchExport.buildPreview(rows,['base']);assert.equal(stale.blockedSkus[0],'5566-1');assert.match(stale.errors[0].reason,/재계산 필요/);
});

test('typed Matrix search calls DB independently of loaded page and preserves pagination/filter arguments',async()=>{
 const source=fs.readFileSync('mockups/operations-hub/data-service.js','utf8'),calls=[];
 const ctx={PAGE_SIZE:50,MATRIX_PAGE_SIZES:new Set([50,100,200]),normalizeConnectionStatus:value=>value,cleanText:value=>String(value??'').trim(),normalizedSearch:value=>String(value??'').trim(),normalizeConnectionConditions:value=>value||{logic:'and',conditions:[]},throwIfAborted:()=>{},withAbortSignal:query=>query,attachProductMetadata:async rows=>rows,db:{rpc:async(name,args)=>{calls.push({name,args});return {data:{count:1,rows:[{sellpia_sku_code:'5566-1'}]},error:null};}}};
 vm.createContext(ctx);vm.runInContext(source.slice(source.indexOf('  async function loadProducts('),source.indexOf('  async function loadProductsBySkus(')),ctx);
 for(const type of ['sku','own_code','name']){const result=await ctx.loadProducts({search:'5566-1',searchType:type,page:3,pageSize:200,includeRelatedSkuContext:true,advancedFilter:{logic:'and',conditions:[{field:'overall_status',operator:'eq',value:'connected'}]}});assert.equal(result.rows[0].sellpia_sku_code,'5566-1');const call=calls.at(-1);assert.equal(call.name,'load_operations_hub_matrix_search_mvp');assert.equal(call.args.p_search_type,type);assert.equal(call.args.p_search,'5566-1');assert.equal(call.args.p_page,5);assert.equal(call.args.p_page_size,100);assert.equal(call.args.p_filter.conditions[0].value,'connected');}
});

test('real app toolbar connects typed search and does not host Sellpia export',async()=>{
 const browser=await chromium.launch({channel:'msedge',headless:true});try{
  const html=fs.readFileSync('mockups/operations-hub/index.html','utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<link\b[^>]*>/gi,'');
  const page=await browser.newPage({viewport:{width:1440,height:900}}),errors=[];page.on('pageerror',error=>errors.push(error.message));await page.route('**/*',route=>route.request().url()==='http://hub-mvp.test/'?route.fulfill({contentType:'text/html',body:html}):route.abort());await page.goto('http://hub-mvp.test/');
  await page.addScriptTag({path:process.env.XLSX_BROWSER_SCRIPT});
  await page.evaluate(()=>{window.requests=[];window.SystemV3Data={loadProducts:async args=>{requests.push({...args,signal:null});return {count:1,page:args.page,pageSize:args.pageSize,rows:[{sellpia_sku_code:'5566-1',system_base_price:59000,system_stock:100,sellpia_purchase_price:53500}]};}};});
  for(const file of ['discount-price-math.js','matrix-csv-export.js','sellpia-patch-export.js','app.js'])await page.addScriptTag({path:'mockups/operations-hub/'+file});
  assert.deepEqual(errors,[]);await page.evaluate(()=>{document.getElementById('operations-auth-gate').hidden=true;document.getElementById('operations-app-shell').hidden=false;document.getElementById('operations-app-shell').inert=false;});
  await page.locator('#matrix-search-type').selectOption('sku');await page.locator('#matrix-search').fill('5566-1');await page.locator('#matrix-search').press('Enter');await page.waitForFunction(()=>requests.some(request=>request.search==='5566-1')&&!matrixState.loading,{},{timeout:5000});
  assert.equal(await page.evaluate(()=>requests.at(-1).searchType),'sku');assert.equal(await page.locator('#matrix-body tr[data-sku="5566-1"]').count(),1);assert.equal(await page.locator('#sellpia-patch-open').count(),0);assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
