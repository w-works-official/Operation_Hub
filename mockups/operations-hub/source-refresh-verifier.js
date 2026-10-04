(function initSourceRefreshVerifier(global) {
  'use strict';

  function cleanText(value) {
    return String(value ?? '').trim();
  }

  function canonicalJson(value) {
    if (Array.isArray(value)) {
      return value
        .map(canonicalJson)
        .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    }
    if (value && typeof value === 'object') {
      return Object.keys(value).sort().reduce((result, key) => {
        result[key] = canonicalJson(value[key]);
        return result;
      }, {});
    }
    return value;
  }

  function sameJson(left, right) {
    return JSON.stringify(canonicalJson(left)) === JSON.stringify(canonicalJson(right));
  }

  function numericValue(value) {
    if (value === null || value === undefined || value === '') return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function sourceRefreshTargetKey(target) {
    return [
      cleanText(target?.kind),
      cleanText(target?.sku),
      cleanText(target?.source),
      cleanText(target?.fieldKey),
      cleanText(target?.priceComponent)
    ].join('|');
  }

  function effectiveSellerPriceComponent(product, target) {
    const component = product?.__sellerPriceComponents?.[target.source];
    if (!component) return {found:false, value:null};
    const field = {
      base:['draft_base_price', 'source_base_price'],
      option:['draft_option_price', 'source_option_price'],
      final:['draft_final_price', 'source_final_price']
    }[target.priceComponent];
    if (!field) return {found:false, value:null};
    return {found:true, value:component[field[0]] ?? component[field[1]] ?? null};
  }

  function inspectSourceRefreshTarget(target, product) {
    if (!product) return {ok:false, reason:'missing_sku', actual:null};
    if (target.kind === 'system') {
      const actual = numericValue(product[target.fieldKey]);
      return {ok:actual === numericValue(target.after), reason:'value_mismatch', actual};
    }
    if (target.kind === 'seller_stock') {
      const draft = product.__sellerDrafts?.[`${target.source}:sellpia_current_stock`];
      const actual = numericValue(draft?.after_value ?? product[`${target.source}_stock`]);
      return {ok:actual === numericValue(target.after), reason:'value_mismatch', actual};
    }
    if (target.kind === 'seller_price') {
      const resolved = effectiveSellerPriceComponent(product, target);
      if (!resolved.found) return {ok:false, reason:'missing_price_component', actual:null};
      const actual = numericValue(resolved.value);
      return {ok:actual === numericValue(target.after), reason:'value_mismatch', actual};
    }
    if (target.kind === 'seller_discount') {
      const component = product.__sellerPriceComponents?.[target.source] || {};
      const draft = product.__sellerDrafts?.[`${target.source}:sellpia_sale_price`];
      const actual = draft?.price_discount_terms_after
        ?? component.draft_discount_terms
        ?? component.source_discount_terms
        ?? product[`${target.source}_discount_terms`]
        ?? [];
      return {ok:sameJson(actual, target.sourceTerms || []), reason:'discount_mismatch', actual};
    }
    return {ok:false, reason:'unsupported_target', actual:null};
  }

  function verifySourceRefreshTargets(targets, rows) {
    const rowsBySku = new Map((Array.isArray(rows) ? rows : []).map(row => [cleanText(row?.sellpia_sku_code), row]));
    const uniqueTargets = [];
    const seen = new Set();
    for (const target of Array.isArray(targets) ? targets : []) {
      const key = sourceRefreshTargetKey(target);
      if (!target?.sku || seen.has(key)) continue;
      seen.add(key);
      uniqueTargets.push(target);
    }
    const results = uniqueTargets.map(target => ({
      target,
      ...inspectSourceRefreshTarget(target, rowsBySku.get(cleanText(target.sku)))
    }));
    return {
      requestedCount:uniqueTargets.length,
      verifiedCount:results.filter(result => result.ok).length,
      failures:results.filter(result => !result.ok),
      results
    };
  }

  global.SystemV3SourceRefreshVerifier = Object.freeze({
    canonicalJson,
    sourceRefreshTargetKey,
    inspectSourceRefreshTarget,
    verifySourceRefreshTargets
  });
})(typeof window === 'undefined' ? globalThis : window);
