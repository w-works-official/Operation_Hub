import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {test} from 'node:test';

const context={Blob,console};
vm.createContext(context);
vm.runInContext(fs.readFileSync(process.env.XLSX_BROWSER_SCRIPT||new URL('../../xlsx.full.min.js',import.meta.url),'utf8'),context);
vm.runInContext(fs.readFileSync(new URL('../mockups/operations-hub/seller-export-adapter.js',import.meta.url),'utf8'),context);
const {XLSX,SystemV3SellerExport:adapter}=context;
async function patch(value,expected=5500,overrides={}) {
  const row=['6979661','keep','original, title','','6,500','5,500',value,'keep','','','183170536','','','','silver','1,000'];
  const csv=XLSX.utils.sheet_to_csv(XLSX.utils.aoa_to_sheet([row]));
  const item={source_channel:'ably',source_row_no:1,sellpia_sku_code:'1000-6',seller_product_code:'6979661',seller_option_code:'183170536',field_key:'sellpia_sale_price',expected_source_value:expected,after_value:2500,target_base_price:900,target_discounted_base_price:900,target_option_price:1600,target_final_price:2500,...overrides};
  const conflicts=[],applied=[];
  const blob=await adapter.patchCsvFile({text:async()=>csv},[item],x=>conflicts.push(x),x=>applied.push(x));
  const wb=XLSX.read(await blob.text(),{type:'string',raw:true});
  return {row,after:XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],{header:1,raw:true,defval:''})[0],conflicts,applied};
}
test('real Ably comma-formatted baseline exports and preserves unrelated CSV fields',async()=>{
  for(const [value,expected] of [['5,500',5500],['5,500.00',5500],[5500,'5,500']]){
    const r=await patch(value,expected);assert.equal(r.conflicts.length,0);assert.equal(r.applied.length,1);
    assert.deepEqual(Array.from(r.after.slice(4,7)),['900','900','2500']);
    r.row.forEach((v,i)=>{if(i<4||i>6)assert.equal(r.after[i],String(v));});
  }
});
test('malformed grouping and truly different values remain export conflicts',async()=>{
  for(const [value,expected] of [['5,5',55],['55,00',5500],['5,,500',5500],['5,500',5501],['1,23,456',123456]]){
    const r=await patch(value,expected);assert.equal(r.conflicts.length,1);assert.equal(r.applied.length,0);assert.equal(r.after[6],value);
  }
});
test('numeric stock accepts grouping while text and identifier comparisons stay exact',async()=>{
  const stock=await patch('5,500',1000,{field_key:'sellpia_current_stock',after_value:900});assert.equal(stock.applied.length,1);assert.equal(stock.after[15],'900');
  const text=await patch('5,500','original title',{field_key:'seller_product_name',after_value:'new'});assert.equal(text.conflicts.length,1);
  const code=await patch('5,500',5500,{seller_product_code:'6,979,661'});assert.equal(code.conflicts.length,1);assert.match(code.conflicts[0].reason,/원본 코드/);
});
