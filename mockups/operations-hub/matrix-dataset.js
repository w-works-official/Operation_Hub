(function(g){
 'use strict';
 const collator=new Intl.Collator('en',{numeric:true});const text=v=>String(v??'').toLocaleLowerCase(),sources=['sellpia','smartstore','makeshop','ably'];
 const tags=r=>[...(r.__profile?.product_tags||[]),...(r.__profile?.sku_tags||[])];
 const compactTagIds=r=>Array.isArray(r.__grid_tag_ids)?r.__grid_tag_ids.map(String):null;
 function state(r,key){const shadows=Object.values(r.__hubShadow||{}),internal=Object.values(r.__hubInternalPrices||{});
  if(key==='stale'&&typeof r.__grid_stale==='boolean')return r.__grid_stale;
  if(key==='conflict'&&typeof r.__grid_conflict==='boolean')return r.__grid_conflict;
  if(key==='pending'&&typeof r.__grid_pending==='boolean')return r.__grid_pending;
  if(key==='stock_mismatch'&&typeof r.__grid_stock_mismatch==='boolean')return r.__grid_stock_mismatch;
  if(key==='price_mismatch'&&typeof r.__grid_price_mismatch==='boolean')return r.__grid_price_mismatch;
  if(key==='stale')return internal.some(x=>x.stale||x.provenanceMismatch)||Object.keys(r.__hubInternalPrices||{}).some(field=>g.HubMatrixShadow?.internalState?.(r,field).freshness==='stale')||shadows.some(x=>x.price?.freshness==='stale'||x.stock?.freshness==='stale');
  if(key==='conflict')return shadows.some(x=>x.lookup==='conflict'||x.price?.disposition==='BLOCK'||x.stock?.disposition==='BLOCK');
  if(key==='baseline_unavailable')return shadows.some(x=>x.lookup==='unavailable'||x.price?.sellerSyncState==='baseline unavailable');
  if(key==='pending')return Object.values(r.__sellerDrafts||{}).some(x=>!['applied','cancelled'].includes(x.status))||shadows.some(x=>x.price?.sellerSyncState==='업로드 대기'||x.stock?.sellerSyncState==='업로드 대기');
  if(key==='stock_mismatch')return sources.slice(1).some(s=>r[s+'_product_code']&&r[s+'_stock']!=null&&Number(r[s+'_stock'])!==Number(r.system_stock));
  if(key==='price_mismatch')return sources.slice(1).some(s=>r[s+'_product_code']&&r[s+'_price']!=null&&r.system_base_price!=null&&Number(r[s+'_price'])!==Number(r.system_base_price));
  return false;
 }
 function field(r,k){if(k==='tag_summary')return tags(r).map(t=>t.tag_name).join(' ');if(k==='sellpia_own_code')return r.sellpia_own_code||r.own_code;if(['material','shape','product_group'].includes(k))return r.__profile?.[k]??r[k];return r[k];}
 function condition(r,c){const v=field(r,c.field),q=c.value,empty=v==null||v==='';switch(c.operator){case 'empty':return empty;case 'not_empty':return !empty;case 'contains':return text(v).includes(text(q));case 'not_contains':return !text(v).includes(text(q));case 'eq':return !empty&&text(v)===text(q);case 'neq':return text(v)!==text(q);case 'gt':return !empty&&Number(v)>Number(q);case 'gte':return !empty&&Number(v)>=Number(q);case 'lt':return !empty&&Number(v)<Number(q);case 'lte':return !empty&&Number(v)<=Number(q);default:throw Error('지원하지 않는 filter operator: '+c.operator);}}
 function searchMatch(r,term,type,selected){const t=text(term).trim();if(!t)return true;if(type==='sku')return text(r.sellpia_sku_code).startsWith(t);if(type==='own_code')return text(field(r,'sellpia_own_code')).startsWith(t);if(type==='tag')return tags(r).some(x=>text(x.tag_name).includes(t));const channels=selected?.length?selected:sources;const values=channels.map(s=>s==='sellpia'?[r.sellpia_product_name,r.sellpia_option_name,r.sellpia_sku_code,field(r,'sellpia_own_code')]:[r[s+'_name'],r[s+'_option_name'],r[s+'_product_code'],r[s+'_option_code']]).flat();if(type==='name')return channels.some(s=>text(s==='sellpia'?r.sellpia_product_name:r[s+'_name']).includes(t)||text(s==='sellpia'?r.sellpia_option_name:r[s+'_option_name']).includes(t));return t.split(/\s+/).every(w=>values.some(v=>text(v).includes(w)));}
 class Dataset{
  constructor(rows,count=rows.length){this.bySku=new Map();for(const r of rows){const sku=String(r.sellpia_sku_code||'').trim();if(!sku||this.bySku.has(sku))throw Error('Matrix SKU identity 중복/누락: '+sku);this.bySku.set(sku,r);}if(this.bySku.size!==count)throw Error('서버/client Matrix count 불일치');this.rows=[...this.bySku.values()];this.version=1;}
  patch(rows){const changed=[];for(const r of rows){const sku=r.sellpia_sku_code;if(!this.bySku.has(sku))throw Error('전체 reload가 필요한 신규 SKU: '+sku);this.bySku.set(sku,r);changed.push(sku);}const keys=new Set(changed);this.rows=this.rows.map(r=>keys.has(r.sellpia_sku_code)?this.bySku.get(r.sellpia_sku_code):r);this.version++;return changed;}
  tagSkus(id){return this.rows.filter(r=>tags(r).some(t=>String(t.tag_id)===String(id))).map(r=>r.sellpia_sku_code);}
  select(o={}){const allowed=o.skus?.length?new Set(o.skus):null,identitySkus=new Set(o.sellerIdentitySkus||[]),cs=o.advancedFilter?.conditions||[];let rows=this.rows.filter(r=>!allowed||allowed.has(r.sellpia_sku_code));const exact=o.search&&['sku','own_code'].includes(o.searchType)?rows.some(r=>text(o.searchType==='sku'?r.sellpia_sku_code:field(r,'sellpia_own_code'))===text(o.search).trim()):false;
   rows=rows.filter(r=>(!exact?(identitySkus.has(r.sellpia_sku_code)||searchMatch(r,o.search,o.searchType,o.searchSources)):text(o.searchType==='sku'?r.sellpia_sku_code:field(r,'sellpia_own_code'))===text(o.search).trim())&&(!o.excludeCombinationSkus||!r.is_dependent_combination_sku)&&(!o.status||o.status==='all'||(o.status==='unmatched'?!sources.slice(1).some(s=>r[s+'_product_code']):sources.slice(1).some(s=>r[s+'_product_code'])))&&(!o.seller||!!r[o.seller+'_product_code']||Number(r.__linkBadges?.[o.seller]?.listing_count||0)>0)&&(!o.tagId||(compactTagIds(r)||tags(r).map(t=>String(t.tag_id))).includes(String(o.tagId)))&&(!o.state||state(r,o.state))&&(!cs.length||(o.advancedFilter.logic==='or'?cs.some(c=>condition(r,c)):cs.every(c=>condition(r,c)))));
   const key={stock_desc:'system_stock',price_desc:'system_base_price',updated_desc:'updated_at'}[o.sort];return rows.sort((a,b)=>{if(key){const av=a[key],bv=b[key];const d=key==='updated_at'?String(bv||'').localeCompare(String(av||'')):Number(bv??-Infinity)-Number(av??-Infinity);if(d&&!Number.isNaN(d))return d;}return collator.compare(String(a.sellpia_sku_code),String(b.sellpia_sku_code));});
  }
 }
 g.HubMatrixDataset={Dataset,state,tags,condition};
})(typeof window==='undefined'?globalThis:window);
