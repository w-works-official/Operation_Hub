(function initDiscountPriceMath(global) {
  'use strict';

  function discountedBase(basePrice, terms = []) {
    let price = Number(basePrice);
    if (!Number.isFinite(price)) return null;
    for (const term of Array.isArray(terms) ? terms : []) {
      if (!term?.is_baseline) continue;
      const value = Number(term.value);
      if (!Number.isFinite(value)) continue;
      if (term.unit === 'percent') price *= 1 - Math.abs(value) / 100;
      else if (term.unit === 'amount') price -= Math.abs(value);
      const unit = Math.max(1, Number(term.rounding_unit) || 1);
      if (term.rounding_mode === 'down') price = Math.floor(price / unit) * unit;
      else if (term.rounding_mode === 'up') price = Math.ceil(price / unit) * unit;
      else if (term.rounding_mode === 'nearest') price = Math.round(price / unit) * unit;
    }
    return Math.max(0, price);
  }

  function grossBaseForTarget(targetDiscountedPrice, terms = []) {
    const target = Number(targetDiscountedPrice);
    if (!Number.isFinite(target) || target < 0 || !Number.isInteger(target)) {
      return {basePrice:null, discountedPrice:null, exact:false, reason:'목표 할인 적용가는 0원 이상의 정수여야 합니다.'};
    }
    let low = 0;
    let high = Math.max(1, target);
    let steps = 0;
    while (discountedBase(high, terms) < target) {
      high *= 2;
      steps += 1;
      if (high > 1_000_000_000_000 || steps > 64) {
        return {basePrice:null, discountedPrice:null, exact:false, reason:'목표가를 만들 판매가를 찾지 못했습니다.'};
      }
    }
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (discountedBase(middle, terms) < target) low = middle + 1;
      else high = middle;
    }
    const discountedPrice = discountedBase(low, terms);
    const exact = discountedPrice === target;
    return {
      basePrice:low,
      discountedPrice,
      exact,
      reason:exact ? '' : `현재 할인율·절사 단위로 ${target.toLocaleString('ko-KR')}원을 정확히 만들 수 없습니다.`
    };
  }

  function matrixVisibleValues({
    stock = null,
    stockDraft = null,
    sourceBasePrice = null,
    sourceDiscountedBasePrice = null,
    sourceOptionPrice = 0,
    sourceFinalPrice = null,
    sourceDiscountTerms = [],
    priceDraft = null,
    draftBasePrice = null,
    draftDiscountedBasePrice = null,
    draftOptionPrice = null,
    draftFinalPrice = null,
    draftDiscountTerms = null,
    calculatedPrice = null
  } = {}) {
    const calculated = calculatedPrice && !calculatedPrice.error ? calculatedPrice : null;
    const hasStockDraft = Boolean(stockDraft);
    const hasPriceDraft = Boolean(priceDraft);
    const effectiveBasePrice = hasPriceDraft
      ? draftBasePrice
      : calculated?.platformBase ?? sourceBasePrice;
    const effectiveDiscountTerms = hasPriceDraft
      ? (Array.isArray(draftDiscountTerms) ? draftDiscountTerms : sourceDiscountTerms)
      : calculated?.platformTerms ?? sourceDiscountTerms;
    const effectiveDiscountedBasePrice = hasPriceDraft
      ? (draftDiscountedBasePrice ?? discountedBase(effectiveBasePrice, effectiveDiscountTerms))
      : calculated
        ? calculated.platformBase - calculated.platformDiscount
        : sourceDiscountedBasePrice ?? discountedBase(sourceBasePrice, sourceDiscountTerms);
    return {
      stockDisplay:hasStockDraft ? stockDraft.after_value : stock,
      stockVisible:stock !== null && stock !== undefined,
      priceVisible:hasPriceDraft || Boolean(calculated) || (sourceFinalPrice !== null && sourceFinalPrice !== undefined),
      priceOrigin:hasPriceDraft ? 'draft' : calculated ? 'calculated' : 'source',
      effectiveBasePrice,
      effectiveDiscountTerms,
      effectiveDiscountedBasePrice,
      effectiveOptionPrice:hasPriceDraft ? draftOptionPrice : calculated?.platformOption ?? sourceOptionPrice,
      effectiveFinalPrice:hasPriceDraft ? draftFinalPrice : calculated?.platformFinal ?? sourceFinalPrice
    };
  }

  global.SystemV3DiscountPriceMath = Object.freeze({discountedBase, grossBaseForTarget, matrixVisibleValues});
})(typeof window !== 'undefined' ? window : globalThis);
