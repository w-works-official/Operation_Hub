(function (global) {
  'use strict';

  const SOURCES = ['smartstore', 'makeshop', 'ably'];
  const clean = value => String(value ?? '').trim();
  const identityKey = row => JSON.stringify([
    clean(row?.source_channel),
    clean(row?.product_code),
    clean(row?.option_code)
  ]);

  function listingCount(row, source) {
    const details = row?.__sellerListings?.[source];
    const detailed = Array.isArray(details) ? details.length : 0;
    const badge = Number(row?.__linkBadges?.[source]?.listing_count || 0);
    const compact = Number(row?.[`${source}_listing_count`] || 0);
    const representative = clean(row?.[`${source}_product_code`]) ? 1 : 0;
    return Math.max(detailed, badge, compact, representative);
  }

  function groupHeight(row) {
    if (row?.__codeListPlaceholder) return 1;
    return Math.max(1, ...SOURCES.map(source => listingCount(row, source)));
  }

  function virtualLayout(rows, baseHeight) {
    const unit = Math.max(1, Number(baseHeight) || 72);
    const offsets = [0];
    for (const row of rows || []) offsets.push(offsets.at(-1) + groupHeight(row) * unit);
    return {rows:rows || [], offsets, total:offsets.at(-1) || 0, baseHeight:unit};
  }

  function lowerBound(offsets, value) {
    let low = 0;
    let high = Math.max(0, offsets.length - 1);
    while (low < high) {
      const middle = Math.floor((low + high + 1) / 2);
      if (offsets[middle] <= value) low = middle;
      else high = middle - 1;
    }
    return low;
  }

  function virtualRange(layout, scrollTop, viewportHeight, overscanRows = 6) {
    const count = layout?.rows?.length || 0;
    if (!count) return {start:0, end:0, top:0, bottom:0};
    const startVisible = Math.min(count - 1, lowerBound(layout.offsets, Math.max(0, Number(scrollTop) || 0)));
    const endVisible = Math.min(count, lowerBound(layout.offsets, Math.max(0, Number(scrollTop) || 0) + Math.max(1, Number(viewportHeight) || 1)) + 1);
    const start = Math.max(0, startVisible - Math.max(0, overscanRows));
    const end = Math.min(count, endVisible + Math.max(0, overscanRows));
    return {
      start,
      end,
      top:layout.offsets[start],
      bottom:layout.total - layout.offsets[end]
    };
  }

  function combine(projectionRows, inventoryRows) {
    const inventoryByIdentity = new Map((inventoryRows || []).map(row => [identityKey(row), row]));
    const bySku = new Map();
    for (const edge of projectionRows || []) {
      const sku = clean(edge?.sellpia_sku_code);
      const source = clean(edge?.source_channel);
      const productCode = clean(edge?.product_code);
      const optionCode = clean(edge?.option_code);
      if (!sku || !SOURCES.includes(source) || !productCode) continue;
      if (!bySku.has(sku)) bySku.set(sku, Object.fromEntries(SOURCES.map(key => [key, []])));
      const listings = bySku.get(sku)[source];
      const key = identityKey(edge);
      if (listings.some(item => item.identity_key === key)) continue;
      const inventory = inventoryByIdentity.get(key) || {};
      listings.push({
        identity_key:key,
        source_channel:source,
        product_code:productCode,
        option_code:optionCode,
        product_name:clean(inventory.product_name || edge.product_name),
        option_name:clean(inventory.option_name || edge.option_name),
        stock:inventory.stock ?? null,
        price:inventory.price ?? null,
        sale_status:clean(inventory.sale_status),
        snapshot_completed_at:inventory.snapshot_completed_at || null,
        mapping_source:clean(edge.mapping_source),
        component_qty:Number(edge.component_qty || 1),
        component_role:clean(edge.component_role || 'primary')
      });
    }
    const collator = new Intl.Collator('en', {numeric:true});
    for (const listingsBySource of bySku.values()) {
      for (const source of SOURCES) listingsBySource[source].sort((a, b) => collator.compare(`${a.product_code}\u0000${a.option_code}`, `${b.product_code}\u0000${b.option_code}`));
    }
    return bySku;
  }

  function identitySearchValues(row) {
    return SOURCES.flatMap(source => (row?.__sellerListings?.[source] || []).flatMap(listing => [
      listing.product_code,
      listing.option_code,
      listing.product_name,
      listing.option_name
    ]));
  }

  global.HubMatrixMultilisting = {
    SOURCES,
    identityKey,
    listingCount,
    groupHeight,
    virtualLayout,
    virtualRange,
    combine,
    identitySearchValues
  };
})(typeof window === 'undefined' ? globalThis : window);
