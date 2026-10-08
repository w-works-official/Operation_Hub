(function initSystemV3Data(global) {
  'use strict';

  const SUPABASE_URL = 'https://bpgvqmtsjgegnrdzmpep.supabase.co';
  const SUPABASE_KEY = 'sb_publishable__NVp6Ra227_e1TQqQE40oA_O2PVwv5C';
  const PAGE_SIZE = 50;
  const MATRIX_PAGE_SIZES = new Set([50, 100, 200]);
  const MATRIX_VIEW = 'operations_hub_matrix_managed_live';
  const MATRIX_SELECT = 'sellpia_sku_code,own_code,image_url,display_name,smartstore_name,smartstore_option_name,smartstore_product_code,smartstore_option_code,smartstore_match_tier,smartstore_match_score,smartstore_listing_count,smartstore_name_is_draft,smartstore_sale_status,makeshop_name,makeshop_option_name,makeshop_product_code,makeshop_option_code,makeshop_match_tier,makeshop_match_score,makeshop_listing_count,makeshop_name_is_draft,makeshop_sale_status,ably_name,ably_option_name,ably_product_code,ably_option_code,ably_match_tier,ably_match_score,ably_listing_count,ably_name_is_draft,ably_sale_status,updated_at,sellpia_product_name,sellpia_option_name,sellpia_own_code,sellpia_current_stock,sellpia_available_stock,sellpia_safety_stock,sellpia_sale_price,sellpia_inventory_at,smartstore_stock,smartstore_price,smartstore_policy_price,smartstore_policy_active,smartstore_policy_name,smartstore_inventory_at,makeshop_stock,makeshop_price,makeshop_policy_price,makeshop_policy_active,makeshop_policy_name,makeshop_inventory_at,ably_stock,ably_price,ably_policy_price,ably_policy_active,ably_policy_name,ably_inventory_at,overall_status,sellpia_override_image_url,sellpia_override_updated_at,sellpia_source_sale_price,sellpia_source_stock,sellpia_source_updated_at,system_base_price,system_stock,system_price_version,system_stock_version,system_price_updated_at,system_stock_updated_at,system_updated_at,is_dependent_combination_sku';

  function normalizeConnectionStatus(status) {
    const value = cleanText(status).toLowerCase();
    if (value === 'review') return 'connected';
    if (value === 'attention') return 'unmatched';
    return ['all','connected','unmatched'].includes(value) ? value : 'all';
  }

  function normalizeConnectionConditions(filter) {
    const normalized = filter && typeof filter === 'object' ? filter : {};
    return {
      logic:String(normalized.logic || 'and').toLowerCase() === 'or' ? 'or' : 'and',
      conditions:(Array.isArray(normalized.conditions) ? normalized.conditions : []).slice(0, 12).map(condition => {
        if (condition?.field !== 'overall_status') return {...condition};
        if (normalizeConnectionStatus(condition.value) !== 'connected') return {...condition, value:'unmatched'};
        return {
          ...condition,
          operator:condition.operator === 'neq' ? 'eq' : 'neq',
          value:'unmatched'
        };
      })
    };
  }

  const matrixReadMetrics={requests:0,bytes:0,networkMs:0};
  async function measuredHubFetch(...args){const at=performance.now(),context=fullMatrixReadContext,response=await global.fetch(...args),elapsed=performance.now()-at;matrixReadMetrics.requests++;matrixReadMetrics.networkMs+=elapsed;let endpoint;if(context){const route=new URL(typeof args[0]==='string'?args[0]:args[0].url).pathname.split('/').pop();context.endpoints??={};endpoint=context.endpoints[route]??={requests:0,bytes:0,networkMs:0,bodyReadMs:0};endpoint.requests++;endpoint.networkMs+=elapsed;}const original=response.text.bind(response);response.text=async()=>{const bodyAt=performance.now(),value=await original(),bytes=new TextEncoder().encode(value).byteLength;matrixReadMetrics.bytes+=bytes;if(endpoint){endpoint.bytes+=bytes;endpoint.bodyReadMs+=performance.now()-bodyAt;}return value;};return response;}
  function requireClient() {
    if (!global.supabase?.createClient) {
      throw new Error('Supabase 클라이언트를 불러오지 못했습니다.');
    }
    return global.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global:{fetch:measuredHubFetch}
    });
  }

  const db = requireClient();
  const sellerParsers = global.SystemV3SellerParsers;
  const ORIGINAL_FILES_FUNCTION = `${SUPABASE_URL}/functions/v1/operations-hub-original-files`;
  const originalBoundaryDiagnostics = [];
  let operationsHubSessionToken = '';

  function authPayload(data) {
    return Array.isArray(data) ? (data[0] || {}) : (data || {});
  }

  function notifyOperationsHubAuthRequired(reason = 'invalid_session') {
    if (typeof global.dispatchEvent !== 'function' || typeof global.CustomEvent !== 'function') return;
    global.dispatchEvent(new global.CustomEvent('operations-hub-auth-required', {detail:{reason}}));
  }

  function operationsHubAuthError(message, reason = 'invalid_session') {
    const error = new Error(message);
    error.code = 'OPERATIONS_AUTH_REQUIRED';
    error.operationsHubAuthRequired = true;
    error.authReason = reason;
    notifyOperationsHubAuthRequired(reason);
    return error;
  }

  function requireOperationsHubSessionToken() {
    if (!operationsHubSessionToken) throw operationsHubAuthError('운영 로그인이 필요합니다.', 'missing_session');
    return operationsHubSessionToken;
  }

  function recordOriginalBoundaryDiagnostic(kind, detail = {}) {
    const entry={kind,at:new Date().toISOString(),...detail};
    originalBoundaryDiagnostics.push(entry);
    if(originalBoundaryDiagnostics.length>50)originalBoundaryDiagnostics.shift();
    if(kind.includes('fallback')) console.warn('[Operations Hub original boundary]',kind,detail?.message||detail);
    if(typeof global.dispatchEvent==='function'&&typeof global.CustomEvent==='function')global.dispatchEvent(new global.CustomEvent('hub-original-boundary-diagnostic',{detail:entry}));
    return entry;
  }

  async function originalBoundaryRequest(action, payload = {}) {
    const token=requireOperationsHubSessionToken();
    const response=await global.fetch(ORIGINAL_FILES_FUNCTION,{
      method:'POST',
      headers:{'Content-Type':'application/json','apikey':SUPABASE_KEY,'x-operations-hub-session':token},
      body:JSON.stringify({action,...payload})
    });
    let result={};
    try{result=await response.json();}catch(error){throw new Error(`원본 파일 보안 경계 응답을 해석하지 못했습니다. HTTP ${response.status}`);}
    if(!response.ok||!result?.ok){
      if(response.status===401){setOperationsHubSessionToken('');throw operationsHubAuthError(result?.error||'운영 세션이 만료되었습니다.','permission_denied');}
      const boundaryError=new Error(result?.error||`원본 파일 보안 경계 요청 실패: HTTP ${response.status}`);
      boundaryError.code=result?.code||'ORIGINAL_BOUNDARY_ERROR';boundaryError.secureBoundary=true;boundaryError.httpStatus=response.status;
      throw boundaryError;
    }
    return result.data||{};
  }

  async function sha256File(file) {
    if(!global.crypto?.subtle||!file?.arrayBuffer)return null;
    const digest=await global.crypto.subtle.digest('SHA-256',await file.arrayBuffer());
    return [...new Uint8Array(digest)].map(value=>value.toString(16).padStart(2,'0')).join('');
  }

  async function downloadSignedFiles(files = [], onProgress, source = '') {
    const result=[];
    for(let index=0;index<files.length;index++){
      const stored=files[index];
      onProgress?.({completed:index,total:files.length,source,name:stored.name,boundary:'signed-read-v1'});
      const response=await global.fetch(stored.signed_url,{cache:'no-store'});
      if(!response.ok)throw new Error(`${stored.name||'원본 파일'} signed download 실패: HTTP ${response.status}`);
      const blob=await response.blob();
      result.push(new File([blob],stored.name,{type:stored.type||blob.type||'application/octet-stream'}));
    }
    onProgress?.({completed:result.length,total:files.length,source,boundary:'signed-read-v1'});
    return result;
  }

  function throwOperationsHubRpcError(error) {
    if (!error) return;
    if (String(error.code || '') === '42501') {
      throw operationsHubAuthError('운영 세션이 만료되었거나 저장 권한이 없습니다.', 'permission_denied');
    }
    throw error;
  }

  function setOperationsHubSessionToken(sessionToken) {
    operationsHubSessionToken = cleanText(sessionToken);
    return Boolean(operationsHubSessionToken);
  }

  async function loginOperationsHub({username, password} = {}) {
    const safeUsername = cleanText(username);
    const safePassword = String(password || '');
    if (!safeUsername || !safePassword) return {authenticated:false, error_code:'invalid_credentials'};
    const {data, error} = await db.rpc('operations_hub_login_v1', {
      p_username:safeUsername,
      p_password:safePassword
    });
    if (error) throw error;
    const result = authPayload(data);
    if (result.authenticated && result.session_token) setOperationsHubSessionToken(result.session_token);
    else setOperationsHubSessionToken('');
    return result;
  }

  async function checkOperationsHubSession(sessionToken) {
    const safeToken = cleanText(sessionToken || operationsHubSessionToken);
    if (!safeToken) return {authenticated:false, error_code:'invalid_session'};
    const {data, error} = await db.rpc('operations_hub_check_session_v1', {p_session_token:safeToken});
    if (error) throw error;
    const result = authPayload(data);
    if (result.authenticated) setOperationsHubSessionToken(safeToken);
    else setOperationsHubSessionToken('');
    return result;
  }

  async function logoutOperationsHub(sessionToken) {
    const safeToken = cleanText(sessionToken || operationsHubSessionToken);
    try {
      if (!safeToken) return {logged_out:true};
      const {data, error} = await db.rpc('operations_hub_logout_v1', {p_session_token:safeToken});
      if (error) throw error;
      return authPayload(data);
    } finally {
      setOperationsHubSessionToken('');
    }
  }

  function normalizedSearch(value) {
    return String(value || '').trim().replace(/[^0-9A-Za-z가-힣ㄱ-ㅎㅏ-ㅣ_\-\[\]\/\s]/g, '');
  }

  function splitIntersectionSearch(value) {
    const text = normalizedSearch(value);
    const slashIndex = text.indexOf('/');
    if (slashIndex < 0) return null;
    const productTerm = text.slice(0, slashIndex).trim();
    const optionTerm = text.slice(slashIndex + 1).trim();
    return productTerm && optionTerm ? {productTerm, optionTerm} : null;
  }

  function throwIfAborted(signal) {
    if (!signal?.aborted) return;
    if (typeof signal.throwIfAborted === 'function') signal.throwIfAborted();
    const error = new Error('요청이 취소되었습니다.');
    error.name = 'AbortError';
    throw error;
  }

  function withAbortSignal(query, signal) {
    throwIfAborted(signal);
    return signal && typeof query?.abortSignal === 'function' ? query.abortSignal(signal) : query;
  }

  async function attachSellerDrafts(rows, signal, prefetched = null) {
    const products = Array.isArray(rows) ? rows : [];
    const skus = [...new Set(products.map(row => cleanText(row?.sellpia_sku_code)).filter(Boolean))];
    if (!skus.length) return products;
    let data = prefetched;
    if (!Array.isArray(data)) {
      const result = await withAbortSignal(db
        .from('operations_hub_active_seller_drafts')
        .select('change_id,sellpia_sku_code,source_channel,field_key,before_value,after_value,status,updated_at,price_base_before,price_base_after,price_discounted_base_before,price_discounted_base_after,price_option_before,price_option_after,price_final_before,price_final_after,price_discount_terms_before,price_discount_terms_after,option_price_source,price_rule_set_id')
        .in('sellpia_sku_code', skus)
        .order('updated_at', {ascending:false})
        .order('change_id', {ascending:false}), signal);
      if (result.error) throw result.error;
      data = result.data || [];
    }
    const draftByKey = new Map();
    for (const draft of data || []) {
      const key = `${draft.sellpia_sku_code}|${draft.source_channel}|${draft.field_key}`;
      if (!draftByKey.has(key)) draftByKey.set(key, draft);
    }
    return products.map(product => {
      const sku = cleanText(product?.sellpia_sku_code);
      if (!sku) return product;
      const drafts = {};
      for (const source of ['smartstore','makeshop','ably']) {
        for (const fieldKey of ['sellpia_current_stock','sellpia_sale_price']) {
          const draft = draftByKey.get(`${sku}|${source}|${fieldKey}`);
          if (draft) drafts[`${source}:${fieldKey}`] = draft;
        }
      }
      return {...product, __sellerDrafts:drafts};
    });
  }

  async function attachProductProfiles(rows, signal, prefetched = null) {
    const products = Array.isArray(rows) ? rows : [];
    const skus = [...new Set(products.map(row => cleanText(row?.sellpia_sku_code)).filter(Boolean))];
    if (!skus.length) return products;
    let data = prefetched;
    if (!Array.isArray(data)) {
      const result = await withAbortSignal(db
        .from('operations_hub_product_profiles')
        .select('sellpia_sku_code,sellpia_product_code,material,product_group,shape,material_source,product_group_source,shape_source,classifier_version,classified_at,updated_by,updated_at,product_tags,sku_tags,tag_summary')
        .in('sellpia_sku_code', skus), signal);
      if (result.error) throw result.error;
      data = result.data || [];
    }
    const profiles = new Map((data || []).map(profile => [cleanText(profile.sellpia_sku_code), profile]));
    return products.map(product => {
      const profile = profiles.get(cleanText(product?.sellpia_sku_code));
      return profile ? {...product, __profile:profile} : product;
    });
  }

  async function attachLinkBadges(rows, signal, prefetched = null) {
    const products = Array.isArray(rows) ? rows : [];
    const skus = [...new Set(products.map(row => cleanText(row?.sellpia_sku_code)).filter(Boolean))];
    if (!skus.length) return products;
    let data = prefetched;
    if (!Array.isArray(data)) {
      const result = await withAbortSignal(db.rpc('get_operations_hub_sku_link_badges_v2', {p_skus:skus}), signal);
      if (result.error) throw result.error;
      data = result.data || [];
    }
    const badgesBySku = new Map();
    for (const badge of data || []) {
      const sku = cleanText(badge.sellpia_sku_code);
      if (!badgesBySku.has(sku)) badgesBySku.set(sku, {});
      badgesBySku.get(sku)[cleanText(badge.source_channel)] = badge;
    }
    return products.map(product => ({
      ...product,
      __linkBadges:badgesBySku.get(cleanText(product?.sellpia_sku_code)) || {}
    }));
  }

  async function loadMatrixSellerListingsBySkus(inputSkus = [], {signal = null} = {}) {
    const skus = [...new Set((inputSkus || []).map(cleanText).filter(Boolean))].slice(0, 100);
    if (!skus.length) return new Map();
    if (!global.HubMatrixMultilisting?.combine) throw new Error('Matrix 다중연결 표시 모듈을 불러오지 못했습니다.');
    throwIfAborted(signal);
    const projectionRows = [];
    for (let offset = 0; offset < skus.length; offset += 50) {
      const skuChunk = skus.slice(offset, offset + 50);
      for (let from = 0;; from += 1000) {
        const result = await withAbortSignal(db
          .from('operations_hub_listing_component_projection')
          .select('mapping_source,listing_id,component_id,source_channel,product_code,option_code,product_name,option_name,sellpia_sku_code,component_qty,component_role')
          .in('sellpia_sku_code', skuChunk)
          .order('source_channel', {ascending:true})
          .order('product_code', {ascending:true})
          .order('option_code', {ascending:true})
          .range(from, from + 999), signal);
        if (result.error) throw result.error;
        projectionRows.push(...(result.data || []));
        if (!result.data || result.data.length < 1000) break;
      }
    }
    const inventoryRows = [];
    for (const source of ['smartstore', 'makeshop', 'ably']) {
      const productCodes = [...new Set(projectionRows
        .filter(row => cleanText(row.source_channel) === source)
        .map(row => cleanText(row.product_code)).filter(Boolean))];
      for (let offset = 0; offset < productCodes.length; offset += 100) {
        const codeChunk = productCodes.slice(offset, offset + 100);
        for (let from = 0;; from += 1000) {
          const result = await withAbortSignal(db
            .from('seller_inventory_latest')
            .select('source_channel,product_code,option_code,product_name,option_name,stock,price,sale_status,snapshot_completed_at')
            .eq('source_channel', source)
            .in('product_code', codeChunk)
            .order('product_code', {ascending:true})
            .order('option_code', {ascending:true})
            .range(from, from + 999), signal);
          if (result.error) throw result.error;
          inventoryRows.push(...(result.data || []));
          if (!result.data || result.data.length < 1000) break;
        }
      }
    }
    return global.HubMatrixMultilisting.combine(projectionRows, inventoryRows);
  }

  async function attachLinkSuppressions(rows, signal, prefetched = null) {
    const products = Array.isArray(rows) ? rows : [];
    const skus = [...new Set(products.map(row => cleanText(row?.sellpia_sku_code)).filter(Boolean))];
    if (!skus.length) return products;
    const suppressionRows = Array.isArray(prefetched) ? prefetched : [];
    if (!Array.isArray(prefetched)) {
      for (let offset = 0; offset < skus.length; offset += 500) {
        const {data, error} = await withAbortSignal(db
          .from('operations_hub_link_suppressions')
          .select('source_channel,sellpia_sku_code,product_code,option_code,reason,suppressed_at')
          .in('sellpia_sku_code', skus.slice(offset, offset + 500)), signal);
        if (error) throw error;
        suppressionRows.push(...(data || []));
      }
    }
    const bySkuSource = new Map();
    for (const suppression of suppressionRows) {
      const key = `${cleanText(suppression.sellpia_sku_code)}|${cleanText(suppression.source_channel)}`;
      if (!bySkuSource.has(key)) bySkuSource.set(key, []);
      bySkuSource.get(key).push(suppression);
    }
    const nullableSuffixes = [
      'name','option_name','product_code','option_code','match_tier','match_score',
      'sale_status','stock','price','policy_price','policy_active','policy_name','inventory_at'
    ];
    return products.map(product => {
      const projected = {...product, __linkSuppressions:{}};
      const sku = cleanText(product?.sellpia_sku_code);
      for (const source of ['smartstore','makeshop','ably']) {
        const candidates = bySkuSource.get(`${sku}|${source}`) || [];
        const productCode = cleanText(product?.[`${source}_product_code`]);
        const optionCode = cleanText(product?.[`${source}_option_code`]);
        const viewSuppressed = product?.[`${source}_link_suppressed`] === true;
        const suppression = candidates.find(item => (
          cleanText(item.product_code) === productCode
          && cleanText(item.option_code) === optionCode
        )) || (viewSuppressed ? candidates[0] : null);
        if (!suppression) continue;
        projected.__linkSuppressions[source] = suppression;
        projected[`${source}_link_suppressed`] = true;
        for (const suffix of nullableSuffixes) projected[`${source}_${suffix}`] = null;
        projected[`${source}_listing_count`] = 0;
        projected[`${source}_name_is_draft`] = false;
        if (projected.__sellerPriceComponents?.[source]) {
          projected.__sellerPriceComponents = {...projected.__sellerPriceComponents};
          delete projected.__sellerPriceComponents[source];
        }
      }
      projected.overall_status = ['smartstore','makeshop','ably'].some(source => cleanText(projected[`${source}_product_code`]))
        ? 'connected'
        : 'unmatched';
      return projected;
    });
  }

  async function attachSellerPriceComponents(rows, signal, prefetched = null) {
    const products = Array.isArray(rows) ? rows : [];
    const skus = [...new Set(products.map(row => cleanText(row?.sellpia_sku_code)).filter(Boolean))];
    if (!skus.length) return products;
    let data = prefetched;
    if (!Array.isArray(data)) {
      const result = await withAbortSignal(db.rpc('load_operations_hub_seller_price_components', {p_skus:skus}), signal);
      if (result.error) throw result.error;
      data = result.data || [];
    }
    const bySku = new Map();
    for (const component of data || []) {
      const sku = cleanText(component.sellpia_sku_code);
      const source = cleanText(component.source_channel);
      if (!sku || !source) continue;
      if (!bySku.has(sku)) bySku.set(sku, {});
      bySku.get(sku)[source] = component;
    }
    return products.map(product => {
      const components = bySku.get(cleanText(product?.sellpia_sku_code)) || {};
      const projected = {...product, __sellerPriceComponents:components};
      for (const source of ['smartstore','makeshop','ably']) {
        const component = components[source];
        if (!component) continue;
        projected[`${source}_base_price`] = component.source_base_price;
        projected[`${source}_discounted_base_price`] = component.source_discounted_base_price;
        projected[`${source}_option_price`] = component.source_option_price;
        projected[`${source}_final_price`] = component.source_final_price;
        projected[`${source}_discount_terms`] = component.source_discount_terms || [];
        if (component.source_final_price !== null && component.source_final_price !== undefined) {
          projected[`${source}_price`] = component.source_final_price;
        }
      }
      return projected;
    });
  }

  async function attachPriceRuleAssignments(rows, signal, prefetched = null) {
    const products = Array.isArray(rows) ? rows : [];
    const skus = [...new Set(products.map(row => cleanText(row?.sellpia_sku_code)).filter(Boolean))];
    if (!skus.length) return products;
    let assignments = Array.isArray(prefetched?.assignments) ? prefetched.assignments : null;
    let ruleSets = Array.isArray(prefetched?.ruleSets) ? prefetched.ruleSets : null;
    if (!assignments || !ruleSets) {
      const result = await withAbortSignal(db
        .from('operations_hub_price_rule_assignments')
        .select('source_channel,sellpia_sku_code,price_rule_set_id,updated_at')
        .eq('target_type', 'sellpia_sku')
        .eq('is_active', true)
        .in('sellpia_sku_code', skus), signal);
      if (result.error) throw result.error;
      assignments = result.data || [];
      const ruleSetIds = [...new Set(assignments.map(row => Number(row.price_rule_set_id)).filter(Number.isFinite))];
      ruleSets = [];
      if (ruleSetIds.length) {
        const ruleResult = await withAbortSignal(db
          .from('operations_hub_price_rule_sets')
          .select('price_rule_set_id,set_name,color,is_active')
          .eq('is_active', true)
          .in('price_rule_set_id', ruleSetIds), signal);
        if (ruleResult.error) throw ruleResult.error;
        ruleSets = ruleResult.data || [];
      }
    }
    const ruleSetById = new Map(ruleSets.map(ruleSet => [Number(ruleSet.price_rule_set_id), ruleSet]));
    const bySku = new Map();
    for (const assignment of assignments || []) {
      const sku = cleanText(assignment.sellpia_sku_code);
      const source = cleanText(assignment.source_channel);
      if (!sku || !source) continue;
      if (!bySku.has(sku)) bySku.set(sku, {});
      const ruleSet = ruleSetById.get(Number(assignment.price_rule_set_id));
      bySku.get(sku)[source] = {
        ...assignment,
        set_name:ruleSet?.set_name || `가격규칙 #${assignment.price_rule_set_id}`,
        color:ruleSet?.color || '#1558c0'
      };
    }
    return products.map(product => ({
      ...product,
      __priceRuleAssignments:bySku.get(cleanText(product?.sellpia_sku_code)) || {}
    }));
  }

  async function attachInboundCostDetails(rows, signal, prefetched = null) {
    const products = Array.isArray(rows) ? rows : [];
    const skus = [...new Set(products.map(row => cleanText(row?.sellpia_sku_code)).filter(Boolean))];
    if (!skus.length) return products;
    const details = Array.isArray(prefetched) ? prefetched : [];
    if (!Array.isArray(prefetched)) {
      for (let offset = 0; offset < skus.length; offset += 500) {
        const {data, error} = await withAbortSignal(db
          .from('operations_hub_inbound_cost_live')
          .select('sellpia_sku_code,sellpia_source_purchase_price,sellpia_source_order_unit,sellpia_source_minimum_order_unit,sellpia_purchase_price,sellpia_order_unit,sellpia_minimum_order_unit,sellpia_purchase_price_is_overridden,sellpia_order_unit_is_overridden,sellpia_minimum_order_unit_is_overridden,sellpia_purchase_price_version,sellpia_order_unit_version,sellpia_minimum_order_unit_version,sellpia_purchase_price_updated_at,sellpia_order_unit_updated_at,sellpia_minimum_order_unit_updated_at,actual_inbound_manual_cost,inbound_cost_formula_tag_id,inbound_cost_formula_tag_name,inbound_cost_formula_tag_color,actual_inbound_cost,actual_inbound_cost_mode,actual_inbound_cost_updated_at')
          .in('sellpia_sku_code', skus.slice(offset, offset + 500)), signal);
        if (error) throw error;
        details.push(...(data || []));
      }
    }
    const bySku = new Map(details.map(detail => [cleanText(detail.sellpia_sku_code), detail]));
    return products.map(product => ({...product, ...(bySku.get(cleanText(product?.sellpia_sku_code)) || {})}));
  }

  async function attachSystemOperationalDetails(rows, signal, prefetched = null) {
    const products = Array.isArray(rows) ? rows : [];
    const skus = [...new Set(products.map(row => cleanText(row?.sellpia_sku_code)).filter(Boolean))];
    if (!skus.length) return products;
    const details = Array.isArray(prefetched) ? prefetched : [];
    if (!Array.isArray(prefetched)) {
      for (let offset = 0; offset < skus.length; offset += 500) {
        const {data, error} = await withAbortSignal(db
          .from('operations_hub_sku_operational_live')
          .select('sellpia_sku_code,system_base_price,system_stock,system_price_version,system_stock_version,system_price_updated_at,system_stock_updated_at,system_updated_at,sellpia_source_purchase_price,sellpia_source_order_unit,sellpia_source_minimum_order_unit,sellpia_purchase_price,sellpia_order_unit,sellpia_minimum_order_unit,sellpia_purchase_price_override,sellpia_order_unit_override,sellpia_minimum_order_unit_override,sellpia_purchase_price_version,sellpia_order_unit_version,sellpia_minimum_order_unit_version,sellpia_purchase_price_updated_at,sellpia_order_unit_updated_at,sellpia_minimum_order_unit_updated_at,sellpia_purchase_price_is_overridden,sellpia_order_unit_is_overridden,sellpia_minimum_order_unit_is_overridden')
          .in('sellpia_sku_code', skus.slice(offset, offset + 500)), signal);
        if (error) throw error;
        details.push(...(data || []));
      }
    }
    const bySku = new Map(details.map(detail => [cleanText(detail.sellpia_sku_code), detail]));
    return products.map(product => ({
      ...product,
      sellpia_source_sale_price:product.sellpia_source_sale_price ?? product.sellpia_sale_price ?? null,
      sellpia_source_stock:product.sellpia_source_stock ?? product.sellpia_current_stock ?? null,
      sellpia_source_updated_at:product.sellpia_source_updated_at ?? product.sellpia_inventory_at ?? null,
      system_base_price:null,
      system_stock:null,
      system_price_version:0,
      system_stock_version:0,
      system_price_updated_at:null,
      system_stock_updated_at:null,
      system_updated_at:null,
      ...(bySku.get(cleanText(product?.sellpia_sku_code)) || {})
    }));
  }

  async function attachPriceBasis(rows, signal, prefetched = null) {
    const products = Array.isArray(rows) ? rows : [];
    const skus = [...new Set(products.map(row => cleanText(row?.sellpia_sku_code)).filter(Boolean))];
    if (!skus.length) return products;
    let details = Array.isArray(prefetched) ? prefetched : null;
    if (!details) {
      const result = await withAbortSignal(db.rpc(fullMatrixReadContext?'load_operations_hub_price_basis_batch_v1':'load_operations_hub_price_basis_v1', {p_skus:skus}), signal);
      if (result.error) throw result.error;
      details = Array.isArray(result.data) ? result.data : [];
    }
    const bySku = new Map(details.map(detail => [cleanText(detail?.sellpiaSkuCode), detail]));
    return products.map(product => ({
      ...product,
      __priceBasis:bySku.get(cleanText(product?.sellpia_sku_code)) || null
    }));
  }

  async function attachProductLinkDrafts(rows, signal, prefetched = null) {
    const products = Array.isArray(rows) ? rows : [];
    const skus = [...new Set(products.map(row => cleanText(row?.sellpia_sku_code)).filter(Boolean))];
    if (!skus.length) return products;
    const drafts = Array.isArray(prefetched) ? prefetched : [];
    if (!Array.isArray(prefetched)) {
      for (let offset = 0; offset < skus.length; offset += 500) {
        const {data, error} = await withAbortSignal(db
          .from('operations_hub_product_link_drafts')
          .select('source_channel,sellpia_sku_code,product_code,product_name,updated_at')
          .in('sellpia_sku_code', skus.slice(offset, offset + 500)), signal);
        if (error) throw error;
        drafts.push(...(data || []));
      }
    }
    const bySku = new Map();
    for (const draft of drafts) {
      const sku = cleanText(draft.sellpia_sku_code);
      const source = cleanText(draft.source_channel);
      if (!sku || !['smartstore', 'makeshop', 'ably'].includes(source)) continue;
      if (!bySku.has(sku)) bySku.set(sku, {});
      bySku.get(sku)[source] = draft;
    }
    return products.map(product => {
      const productDrafts = bySku.get(cleanText(product?.sellpia_sku_code)) || {};
      const projected = {...product, __sellerProductLinkDrafts:productDrafts};
      for (const source of ['smartstore', 'makeshop', 'ably']) {
        const draft = productDrafts[source];
        if (!draft || cleanText(projected[`${source}_match_tier`])) continue;
        projected[`${source}_product_code`] = draft.product_code;
        projected[`${source}_name`] = draft.product_name;
        projected[`${source}_option_code`] = null;
        projected[`${source}_option_name`] = null;
      }
      return projected;
    });
  }

  async function attachManualLinks(rows, signal, prefetched = null) {
    const products = Array.isArray(rows) ? rows : [];
    const skus = [...new Set(products.map(row => cleanText(row?.sellpia_sku_code)).filter(Boolean))];
    if (!skus.length) return products;
    const links = Array.isArray(prefetched) ? prefetched : [];
    if (!Array.isArray(prefetched)) {
      for (let offset = 0; offset < skus.length; offset += 500) {
        const {data, error} = await withAbortSignal(db
          .from('operations_hub_manual_links')
          .select('source_channel,sellpia_sku_code,product_code,option_code,product_name,option_name,mapping_origin,match_tier,match_score,updated_at')
          .in('sellpia_sku_code', skus.slice(offset, offset + 500)), signal);
        if (error) throw error;
        links.push(...(data || []));
      }
    }
    const bySku = new Map();
    for (const link of links) {
      const sku = cleanText(link.sellpia_sku_code);
      const source = cleanText(link.source_channel);
      if (!sku || !['smartstore', 'makeshop', 'ably'].includes(source)) continue;
      if (!bySku.has(sku)) bySku.set(sku, {});
      bySku.get(sku)[source] = link;
    }
    return products.map(product => {
      const manualLinks = bySku.get(cleanText(product?.sellpia_sku_code)) || {};
      const projected = {...product, __manualLinks:manualLinks};
      for (const source of ['smartstore', 'makeshop', 'ably']) {
        const link = manualLinks[source];
        if (!link) continue;
        const cachedIdentityMatches = cleanText(projected[`${source}_product_code`]) === cleanText(link.product_code)
          && cleanText(projected[`${source}_option_code`]) === cleanText(link.option_code);
        projected[`${source}_product_code`] = link.product_code;
        projected[`${source}_option_code`] = link.option_code;
        projected[`${source}_name`] = link.product_name;
        projected[`${source}_option_name`] = link.option_name;
        projected[`${source}_match_tier`] = link.match_tier || 'MANUAL_LINKED';
        projected[`${source}_match_score`] = link.match_score ?? 100;
        projected[`${source}_listing_count`] = Math.max(1, Number(projected[`${source}_listing_count`] || 0));
        projected[`${source}_name_is_draft`] = false;
        if (!cachedIdentityMatches) {
          for (const suffix of ['sale_status','stock','price','policy_price','policy_active','policy_name','inventory_at']) {
            projected[`${source}_${suffix}`] = null;
          }
        }
      }
      projected.overall_status = ['smartstore','makeshop','ably'].some(source => cleanText(projected[`${source}_match_tier`]))
        ? 'connected'
        : projected.overall_status;
      return projected;
    });
  }

  async function attachProductMetadata(rows, signal) {
    let products = Array.isArray(rows) ? rows : [];
    const skus = [...new Set(products.map(row => cleanText(row?.sellpia_sku_code)).filter(Boolean))];
    if (!skus.length) return products;
    throwIfAborted(signal);
    const result = await withAbortSignal(db.rpc(fullMatrixReadContext?'load_operations_hub_matrix_metadata_batch_v1':'load_operations_hub_matrix_metadata_v1', {p_skus:skus}), signal);
    if (result.error) throw new Error('Matrix 표시정보 조회: '+(result.error.message||String(result.error)));
    const metadata = result.data || {};
    const steps = [
      [attachInboundCostDetails, metadata.inbound_costs],
      [attachSystemOperationalDetails, metadata.operational_details],
      [attachPriceBasis, null],
      [attachProductLinkDrafts, metadata.product_link_drafts],
      [attachManualLinks, metadata.manual_links],
      [attachProductProfiles, metadata.profiles],
      [attachLinkBadges, metadata.link_badges],
      [attachSellerPriceComponents, metadata.seller_price_components],
      [attachSellerDrafts, metadata.seller_drafts],
      [attachPriceRuleAssignments, {
        assignments:metadata.price_rule_assignments,
        ruleSets:metadata.price_rule_sets
      }],
      [attachLinkSuppressions, metadata.link_suppressions]
    ];
    for (const [attach, prefetched] of steps) {
      throwIfAborted(signal);
      try{products = await attach(products, signal, prefetched);}catch(error){throw new Error('Matrix '+attach.name+': '+(error.message||String(error)));}
    }
    products = await attachStoredCalculatedPrices(products, signal);
    products = await attachCurrentPriceDecisions(products, signal);
    try{products=await attachRepresentativePrices(products);}catch(error){console.warn('representative price detail enrichment failed',error);}
    if(global.HubMatrixShadow)products = await attachMatrixShadow(products, signal);
    throwIfAborted(signal);
    return products;
  }

  async function loadListingGraph({source = 'all', relationType = 'complex', search = '', page = 1, pageSize = 50, folderId = null, organizationScope = 'all'} = {}) {
    const {data, error} = await db.rpc('list_operations_hub_listing_graph_v3', {
      p_source:cleanText(source) || 'all',
      p_relation_type:cleanText(relationType) || 'complex',
      p_search:cleanText(search),
      p_page:Math.max(1, Number(page) || 1),
      p_page_size:Math.max(1, Math.min(Number(pageSize) || 50, 100)),
      p_folder_id:folderId === null || folderId === '' ? null : Number(folderId),
      p_organization_scope:['all','organized','unorganized'].includes(cleanText(organizationScope)) ? cleanText(organizationScope) : 'all'
    });
    if (error) throw error;
    return {
      rows:Array.isArray(data?.rows) ? data.rows : [],
      count:Number(data?.count || 0),
      page:Number(data?.page || page || 1),
      pageSize:Number(data?.pageSize || pageSize || 50)
    };
  }

  async function searchMatrixSellerListingSkus(search, {source = 'all', signal = null, maxRows = 2000} = {}) {
    const term = cleanText(search);
    if (!term) return [];
    const skus = new Set();
    let page = 1;
    let loaded = 0;
    for (;;) {
      throwIfAborted(signal);
      const result = await loadListingGraph({source, relationType:'all', search:term, page, pageSize:100});
      for (const row of result.rows || []) {
        for (const component of row.components || []) {
          const sku = cleanText(component?.sku || component?.sellpia_sku_code);
          if (sku) skus.add(sku);
        }
      }
      loaded += (result.rows || []).length;
      if (!(result.rows || []).length || loaded >= result.count || loaded >= maxRows) break;
      page += 1;
    }
    return [...skus];
  }

  async function saveListingComponent({source, productCode, optionCode = '', sku, qty = 1, role = 'additional'} = {}) {
    const {data, error} = await db.rpc('save_operations_hub_listing_component', {
      p_source:cleanText(source),
      p_product_code:cleanText(productCode),
      p_option_code:cleanText(optionCode),
      p_sellpia_sku_code:cleanText(sku),
      p_component_qty:Math.max(1, Math.trunc(Number(qty) || 1)),
      p_component_role:cleanText(role) || 'additional'
    });
    if (error) throw error;
    return Array.isArray(data) ? data[0] : data;
  }

  async function deactivateListingComponent(componentId) {
    const {data, error} = await db.rpc('deactivate_operations_hub_listing_component', {
      p_component_id:Number(componentId)
    });
    if (error) throw error;
    return Array.isArray(data) ? data[0] : data;
  }

  async function stageListingInventoryDraft({source, productCode, optionCode = '', batchId = null} = {}) {
    const {data, error} = await db.rpc('stage_operations_hub_listing_inventory_draft', {
      p_source:cleanText(source),
      p_product_code:cleanText(productCode),
      p_option_code:cleanText(optionCode),
      p_batch_id:batchId
    });
    if (error) throw error;
    return Array.isArray(data) ? data[0] : data;
  }

  function isMissingMatrixRpc(error, rpcName) {
    const message = `${error?.code || ''} ${error?.message || ''} ${error?.details || ''}`.toLowerCase();
    const requestedName = String(rpcName || '').toLowerCase();
    const mentionsRequestedRpc = requestedName && message.includes(requestedName);
    return (error?.code === 'PGRST202' || error?.code === '42883') && mentionsRequestedRpc
      || ((message.includes('could not find the function') || message.includes('does not exist')) && mentionsRequestedRpc);
  }

  function normalizeMatrixContext(row) {
    const context = row?.matrix_context && typeof row.matrix_context === 'object' ? row.matrix_context : {};
    const kind = cleanText(context.kind || context.matchKind || context.match_kind).toLowerCase() === 'related' ? 'related' : 'direct';
    const rootSku = cleanText(context.rootSku || context.rootSkuCode || context.root_sku_code) || cleanText(row?.sellpia_sku_code);
    const direction = cleanText(context.direction || context.relationDirection || context.relation_direction) || (kind === 'related' ? 'related' : 'self');
    const depth = Math.max(0, Number(context.depth ?? context.hopCount ?? context.hop_count) || 0);
    const rawPath = Array.isArray(context.pathSkus) ? context.pathSkus : (Array.isArray(context.pathSkuCodes) ? context.pathSkuCodes : context.path_sku_codes);
    const pathSkuCodes = (Array.isArray(rawPath) ? rawPath : []).map(cleanText).filter(Boolean);
    const relationshipFamily = cleanText(
      context.relationshipFamily
      || context.relationFamily
      || context.relationship_family
      || context.relation_family
    ).toLowerCase() || (kind === 'related' ? 'relation' : 'direct');
    const relationshipType = cleanText(
      context.relationshipType
      || context.relationType
      || context.relationship_type
      || context.relation_type
    ).toLowerCase() || (kind === 'related' ? 'custom' : 'direct');
    const relationshipDetails = context.relationshipDetails && typeof context.relationshipDetails === 'object'
      ? context.relationshipDetails
      : (context.relationship_details && typeof context.relationship_details === 'object' ? context.relationship_details : {});
    return {
      kind,
      rootSku,
      direction,
      depth,
      pathSkus:pathSkuCodes,
      relationshipFamily,
      relationshipType,
      relationshipDetails,
      // Temporary aliases keep existing and in-flight UI modules compatible
      // while `relationshipFamily` remains the stable public JSON key.
      relationFamily:relationshipFamily,
      relationType:relationshipType
    };
  }

  async function attachMatrixResultMetadata(rows, signal) {
    const products = await attachProductMetadata(rows, signal);
    return products.map(product => ({
      ...product,
      matrix_context:normalizeMatrixContext(product)
    }));
  }

  async function loadProducts({ page = 1, pageSize = PAGE_SIZE, search = '', searchType = 'all', searchSources = ['sellpia','smartstore','makeshop','ably'], status = 'all', sort = 'sku_asc', skus = [], codeListRows = [], advancedFilter = null, excludeCombinationSkus = false, includeRelatedSkuContext = false, signal = null } = {}) {
    status = normalizeConnectionStatus(status);
    const safePage = Math.max(1, Number(page) || 1);
    const safePageSize = MATRIX_PAGE_SIZES.has(Number(pageSize)) ? Number(pageSize) : PAGE_SIZE;
    const loadPagedRpc = async (rpcName, args) => {
      const serverPageSize = Math.min(safePageSize, 100);
      const requestsPerPage = safePageSize / serverPageSize;
      const firstServerPage = ((safePage - 1) * requestsPerPage) + 1;
      const rows = [];
      let count = 0;
      for (let offset = 0; offset < requestsPerPage; offset += 1) {
        throwIfAborted(signal);
        const {data, error} = await withAbortSignal(db.rpc(rpcName, {...args, p_page:firstServerPage + offset, p_page_size:serverPageSize}), signal);
        if (error) throw error;
        const pageRows = Array.isArray(data?.rows) ? data.rows : [];
        rows.push(...pageRows);
        count = Number(data?.count || count || 0);
        if (pageRows.length < serverPageSize) break;
      }
      return {rows:rows.slice(0, safePageSize), count, page:safePage, pageSize:safePageSize};
    };
    const orderedCodeRows = Array.isArray(codeListRows) ? codeListRows : [];
    if (orderedCodeRows.length) {
      const from = (safePage - 1) * safePageSize;
      const pageRows = orderedCodeRows.slice(from, from + safePageSize);
      const pageSkus = [...new Set(pageRows.map(item => cleanText(item.sellpia_sku_code)).filter(Boolean))];
      let products = [];
      if (pageSkus.length) {
        const {data, error} = await withAbortSignal(db
          .from(MATRIX_VIEW)
          .select(MATRIX_SELECT)
          .in('sellpia_sku_code', pageSkus), signal);
        if (error) throw error;
        products = data || [];
      }
      const productsBySku = new Map(products.map(product => [cleanText(product.sellpia_sku_code), product]));
      const orderedRows = pageRows.map(codeRow => {
          const product = productsBySku.get(cleanText(codeRow.sellpia_sku_code));
          return product
            ? {...product, __codeList:codeRow}
            : {sellpia_sku_code:'', __codeList:codeRow, __codeListPlaceholder:true};
        });
      return {
        rows:await attachProductMetadata(orderedRows, signal),
        count:orderedCodeRows.length,
        page:safePage,
        pageSize:safePageSize
      };
    }
    const codeListSkus = [...new Set((skus || []).map(cleanText).filter(Boolean))];
    if (codeListSkus.length) {
      const result = await loadPagedRpc('load_operations_hub_code_list', {p_skus:codeListSkus, p_status:status, p_sort:'input_order'});
      return {
        ...result,
        rows:await attachProductMetadata(result.rows, signal)
      };
    }
    const filterPayload = normalizeConnectionConditions(advancedFilter);
    const normalizedMatrixSearch = normalizedSearch(search);
    if (normalizedMatrixSearch && ['sku','own_code','name'].includes(searchType)) {
      const result = await loadPagedRpc('load_operations_hub_matrix_search_mvp', {
        p_search:normalizedMatrixSearch, p_search_type:searchType, p_search_sources:searchSources,
        p_status:status, p_sort:sort, p_filter:filterPayload, p_exclude_dependent:Boolean(excludeCombinationSkus)
      });
      return {...result, rows:await attachProductMetadata(result.rows, signal),
        directCount:result.count, relatedCount:0, relationContextEnabled:false};
    }
    const includeRelatedContext = Boolean(includeRelatedSkuContext) && Boolean(normalizedMatrixSearch);
    if (includeRelatedContext) {
      throwIfAborted(signal);
      const v5Args = {
        p_page:safePage,
        p_page_size:safePageSize,
        p_search:normalizedMatrixSearch,
        p_search_sources:searchSources,
        p_status:status,
        p_sort:sort,
        p_filter:filterPayload,
        p_skus:[],
        p_exclude_dependent:Boolean(excludeCombinationSkus),
        p_include_related_sku_context:true
      };
      const buildRelatedMatrixResult = async data => {
        const rows = Array.isArray(data?.rows) ? data.rows : [];
        const directCount = Number(data?.directCount ?? data?.direct_count ?? data?.count ?? 0);
        const relatedCount = Number(data?.relatedCount ?? data?.related_count ?? rows.filter(row => normalizeMatrixContext(row).kind === 'related').length);
        return {
          rows:await attachMatrixResultMetadata(rows, signal),
          count:directCount,
          directCount,
          relatedCount,
          directPageSkuCodes:Array.isArray(data?.directPageSkuCodes) ? data.directPageSkuCodes : (Array.isArray(data?.direct_page_sku_codes) ? data.direct_page_sku_codes : []),
          page:Number(data?.page || safePage),
          pageSize:Number(data?.pageSize || data?.page_size || safePageSize),
          relationContextEnabled:true
        };
      };
      const {data:v6Data, error:v6Error} = await withAbortSignal(db.rpc('load_operations_hub_matrix_filtered_v6', v5Args), signal);
      if (!v6Error) {
        return buildRelatedMatrixResult(v6Data);
      }
      // The frontend may ship before the additive V6 migration. A missing V6
      // falls back to the already deployed relation-only V5, while every real
      // V6 query failure remains visible instead of being hidden by fallback.
      if (!isMissingMatrixRpc(v6Error, 'load_operations_hub_matrix_filtered_v6')) throw v6Error;
      const {data:v5Data, error:v5Error} = await withAbortSignal(db.rpc('load_operations_hub_matrix_filtered_v5', v5Args), signal);
      if (!v5Error) {
        return buildRelatedMatrixResult(v5Data);
      }
      if (!isMissingMatrixRpc(v5Error, 'load_operations_hub_matrix_filtered_v5')) throw v5Error;
      console.info('matrix related context RPC unavailable; using existing matrix query until V6 is deployed');
    }
    if (filterPayload.conditions.length) {
      throwIfAborted(signal);
      const {data, error} = await withAbortSignal(db.rpc('load_operations_hub_matrix_filtered_v4', {
        p_page:safePage,
        p_page_size:safePageSize,
        p_search:normalizedSearch(search),
        p_search_sources:searchSources,
        p_status:status,
        p_sort:sort,
        p_filter:filterPayload,
        p_skus:[],
        p_exclude_dependent:Boolean(excludeCombinationSkus)
      }), signal);
      if (error) throw error;
      const rows = Array.isArray(data?.rows) ? data.rows : [];
      return {
        rows:await attachProductMetadata(rows, signal),
        count:Number(data?.count || 0),
        directCount:Number(data?.count || 0),
        relatedCount:0,
        relationContextEnabled:false,
        page:Number(data?.page || safePage),
        pageSize:Number(data?.pageSize || safePageSize)
      };
    }
    throwIfAborted(signal);
    const {data, error} = await withAbortSignal(db.rpc('load_operations_hub_matrix_page_v3', {
      p_page:safePage,
      p_page_size:safePageSize,
      p_search:normalizedSearch(search),
      p_search_sources:searchSources,
      p_status:status,
      p_sort:sort,
      p_exclude_dependent:Boolean(excludeCombinationSkus)
    }), signal);
    if (error) throw error;
    const rows = Array.isArray(data?.rows) ? data.rows : [];
    return {
      rows:await attachProductMetadata(rows, signal),
      count:Number(data?.count || 0),
      directCount:Number(data?.count || 0),
      relatedCount:0,
      relationContextEnabled:false,
      page:Number(data?.page || safePage),
      pageSize:Number(data?.pageSize || safePageSize)
    };
  }

  let fullMatrixReadContext=null;
  function decodeMatrixGridV4(input) {
    if(!Array.isArray(input))return input&&typeof input==='object'?input:{};
    const seller=(source,value,row)=>{
      if(!Array.isArray(value))return;
      [row[`${source}_product_code`],row[`${source}_option_code`],row[`${source}_name`],
        row[`${source}_option_name`],row[`${source}_match_tier`],row[`${source}_listing_count`],
        row[`${source}_name_is_draft`],row[`${source}_stock`],row[`${source}_price`]]=value;
    };
    const row={
      sellpia_sku_code:input[0],image_url:input[1],sellpia_product_name:input[2],sellpia_option_name:input[3],
      sellpia_own_code:input[4],sellpia_current_stock:input[5],sellpia_sale_price:input[6],sellpia_inventory_at:input[7],
      sellpia_override_image_url:input[8],sellpia_override_updated_at:input[9],sellpia_purchase_price:input[10],
      sellpia_source_purchase_price:input[11],sellpia_order_unit:input[12],sellpia_source_order_unit:input[13],
      sellpia_minimum_order_unit:input[14],sellpia_source_minimum_order_unit:input[15],
      sellpia_purchase_price_updated_at:input[16],sellpia_order_unit_updated_at:input[17],
      sellpia_minimum_order_unit_updated_at:input[18],system_base_price:input[19],system_stock:input[20],
      system_price_updated_at:input[21],system_stock_updated_at:input[22],system_updated_at:input[23],updated_at:input[24],
      actual_inbound_cost:input[28],actual_inbound_cost_mode:input[29],inbound_cost_formula_tag_name:input[30],
      inbound_cost_formula_tag_color:input[31],is_dependent_combination_sku:Boolean(input[32]),__grid_compact:true
    };
    seller('smartstore',input[25],row);seller('makeshop',input[26],row);seller('ably',input[27],row);
    const flags=Array.isArray(input[33])?input[33]:[];
    [row.__grid_stale,row.__grid_conflict,row.__grid_pending,row.__grid_stock_mismatch,row.__grid_price_mismatch]=flags.map(Boolean);
    const meta=Array.isArray(input[34])?input[34]:[],profile=Array.isArray(meta[0])?meta[0]:[];
    row.__grid_meta={
      profile:{product_code:profile[0]??null,material:profile[1]??null,product_group:profile[2]??null,shape:profile[3]??null,
        product_tag_ids:Array.isArray(profile[4])?profile[4]:[],sku_tag_ids:Array.isArray(profile[5])?profile[5]:[]},
      drafts:meta[1]||{},link_drafts:meta[2]||{},link_badges:meta[3]||{},seller_prices:meta[4]||{},
      rule_prices:meta[5]||{},internal_prices:meta[6]||{}
    };
    return row;
  }
  function normalizeMatrixGridRow(input,tagCatalog={},linkBadgeCatalog={}) {
    const row={...decodeMatrixGridV4(input)};
    const compact=row.__grid_meta&&typeof row.__grid_meta==='object'?row.__grid_meta:null;
    if(compact){
      const profile=compact.profile&&typeof compact.profile==='object'?compact.profile:{};
      const resolveTags=ids=>(Array.isArray(ids)?ids:[]).map(id=>{
        const tag=tagCatalog?.[String(id)]||{};
        return {tag_id:id,tag_name:tag.name||String(id),tag_color:tag.color||null,tag_group:tag.group||null};
      });
      row.__profile={
        sellpia_sku_code:row.sellpia_sku_code,
        sellpia_product_code:profile.product_code||null,
        material:profile.material||null,
        product_group:profile.product_group||null,
        shape:profile.shape||null,
        product_tags:resolveTags(profile.product_tag_ids),
        sku_tags:resolveTags(profile.sku_tag_ids)
      };
      row.__grid_tag_ids=[...new Set([...row.__profile.product_tags,...row.__profile.sku_tags].map(tag=>String(tag.tag_id)))];
      row.__sellerDrafts={};
      for(const [key,value] of Object.entries(compact.drafts||{}))row.__sellerDrafts[key]={
        change_id:value?.id||null,status:value?.status||null,after_value:value?.after??null,
        price_base_after:value?.b??null,price_discounted_base_after:value?.d??null,
        price_option_after:value?.o??null,price_final_after:value?.f??null,
        price_discount_terms_after:value?.terms??null
      };
      row.__sellerProductLinkDrafts={};
      for(const [source,value] of Object.entries(compact.link_drafts||{}))row.__sellerProductLinkDrafts[source]={
        source_channel:source,sellpia_sku_code:row.sellpia_sku_code,
        product_code:value?.code||null,product_name:value?.name||null
      };
      row.__linkBadges={};
      for(const [source,value] of Object.entries(linkBadgeCatalog[row.sellpia_sku_code]||compact.link_badges||{}))row.__linkBadges[source]={
        source_channel:source,listing_count:Number(row[`${source}_listing_count`]||0),
        max_component_count:Number(value?.max||0),relation_type:value?.relation||'single'
      };
      row.__sellerPriceComponents={};
      for(const [source,value] of Object.entries(compact.seller_prices||{}))row.__sellerPriceComponents[source]={
        seller_product_code:row[`${source}_product_code`]||null,
        seller_option_code:row[`${source}_option_code`]||null,
        source_base_price:value?.b??null,source_discounted_base_price:value?.d??value?.b??null,
        source_option_price:value?.o??0,source_final_price:value?.f??null,
        source_discount_terms:Array.isArray(value?.t)?value.t:[]
      };
      row.__hubRulePrices={};row.__hubActivePriceRules={smartstore:false,makeshop:false,ably:false};row.__priceRuleAssignments={};
      for(const [source,value] of Object.entries(compact.rule_prices||{})){
        const names=Array.isArray(value?.n)?value.n:[];
        row.__hubRulePrices[source]={platformBase:value?.b??null,discounted:value?.d??null,
          platformOption:value?.o??null,platformFinal:value?.f??null,platformTerms:[],ruleNames:names,error:value?.e||null};
        row.__hubActivePriceRules[source]=true;
        row.__priceRuleAssignments[source]={set_name:names.join(' · '),color:value?.e?'#dc2626':'#1558c0'};
      }
      row.__hubInternalPrices={};
      for(const [field,value] of Object.entries(compact.internal_prices||{})){
        const names=Array.isArray(value?.n)?value.n:[],tagIds=Array.isArray(value?.t)?value.t:[];
        row.__hubInternalPrices[field]={value:value?.v??null,error:value?.e||null,ruleNames:names,
          activeOutputRules:names.map((name,index)=>({name,tag_name:name,tag_id:tagIds[index]||tagIds[0]||null,output_field:field,scope:''})),
          stale:Boolean(value?.stale),provenanceMismatch:Boolean(value?.stale)};
      }
      row.own_code=row.sellpia_own_code||null;
      row.display_name=[row.sellpia_product_name,row.sellpia_option_name].filter(Boolean).join(' · ');
      delete row.__grid_meta;
    }
    row.__profile=row.__profile&&typeof row.__profile==='object'?row.__profile:{};
    row.__sellerDrafts=row.__sellerDrafts&&typeof row.__sellerDrafts==='object'?row.__sellerDrafts:{};
    row.__sellerProductLinkDrafts=row.__sellerProductLinkDrafts&&typeof row.__sellerProductLinkDrafts==='object'?row.__sellerProductLinkDrafts:{};
    row.__sellerPriceComponents=row.__sellerPriceComponents&&typeof row.__sellerPriceComponents==='object'?row.__sellerPriceComponents:{};
    row.__hubInternalPrices=row.__hubInternalPrices&&typeof row.__hubInternalPrices==='object'?row.__hubInternalPrices:{};
    row.__hubRulePrices=row.__hubRulePrices&&typeof row.__hubRulePrices==='object'?row.__hubRulePrices:{};
    row.__hubActivePriceRules=row.__hubActivePriceRules&&typeof row.__hubActivePriceRules==='object'?row.__hubActivePriceRules:{};
    row.__priceRuleAssignments=row.__priceRuleAssignments&&typeof row.__priceRuleAssignments==='object'?row.__priceRuleAssignments:{};
    const suppressions=Array.isArray(row.__linkSuppressions)?row.__linkSuppressions:[];
    for(const source of ['smartstore','makeshop','ably']){
      const draft=row.__sellerProductLinkDrafts[source];
      if(draft&&!cleanText(row[`${source}_match_tier`])){
        row[`${source}_product_code`]=draft.product_code;
        row[`${source}_name`]=draft.product_name;
        row[`${source}_option_code`]=null;
        row[`${source}_option_name`]=null;
        for(const suffix of ['sale_status','stock','price','policy_price','policy_active','policy_name','inventory_at'])row[`${source}_${suffix}`]=null;
      }
      const blocked=suppressions.some(item=>cleanText(item?.source_channel)===source
        &&cleanText(item?.product_code)===cleanText(row[`${source}_product_code`])
        &&cleanText(item?.option_code)===cleanText(row[`${source}_option_code`]));
      if(blocked){
        for(const suffix of ['name','option_name','product_code','option_code','match_tier','match_score','sale_status','stock','price','policy_price','policy_active','policy_name','inventory_at'])row[`${source}_${suffix}`]=null;
        row[`${source}_listing_count`]=0;
        row[`${source}_name_is_draft`]=false;
        delete row.__sellerPriceComponents[source];
      }
      if(row.__hubActivePriceRules[source]!==true)row[`${source}_policy_active`]=false;
    }
    row.overall_status=['smartstore','makeshop','ably'].some(source=>cleanText(row[`${source}_product_code`]))?'connected':'unmatched';
    return row;
  }

  function matrixGridTransientError(error) {
    const message=`${error?.code||''} ${error?.message||error}`.toLowerCase();
    if(message.includes('40001')||message.includes('cache version')||message.includes('session')||message.includes('permission'))return false;
    return /57014|statement timeout|canceling statement|fetch failed|failed to fetch|network|load failed|502|503|504/.test(message);
  }

  function waitMatrixGridRetry(delayMs,signal) {
    return new Promise((resolve,reject)=>{
      throwIfAborted(signal);
      const timer=setTimeout(()=>{signal?.removeEventListener('abort',abort);resolve();},delayMs);
      const abort=()=>{clearTimeout(timer);const error=Error('요청이 취소되었습니다.');error.name='AbortError';reject(error);};
      signal?.addEventListener('abort',abort,{once:true});
    });
  }

  async function readMatrixGridRpc(name,args,{signal,page,cursor}={}) {
    const retryDelays=[0,350+Math.round(Math.random()*150),1250+Math.round(Math.random()*500)];
    let lastError;
    for(let attempt=0;attempt<retryDelays.length;attempt++){
      if(retryDelays[attempt])await waitMatrixGridRetry(retryDelays[attempt],signal);
      throwIfAborted(signal);
      const requestAt=performance.now();
      const {data,error}=await withAbortSignal(db.rpc(name,args),signal);
      const clientMs=performance.now()-requestAt;
      if(!error)return {data:data&&typeof data==='object'?data:{},clientMs,retries:attempt,attempts:attempt+1};
      lastError=readableDatabaseError(error);
      if(!matrixGridTransientError(lastError)||attempt===retryDelays.length-1)break;
      console.warn('[Matrix Grid feed] bounded page retry',{page,cursor,attempt:attempt+1,code:error?.code||'',message:error?.message||String(error)});
    }
    const diagnostic=Error(`Matrix Grid feed ${page?`${page}페이지 `:''}실패${cursor?` · cursor ${cursor}`:''}: ${lastError?.message||lastError}`);
    diagnostic.code=lastError?.code||'MATRIX_GRID_FEED_FAILED';
    diagnostic.matrixGridDiagnostic={page:page||0,cursor:cursor||null,sqlState:lastError?.code||null,sourceError:lastError?.message||String(lastError)};
    throw diagnostic;
  }

  async function loadMatrixGridDataset({signal=null,onProgress=null,chunkSize=null}={}) {
    const started=performance.now(),before={...matrixReadMetrics};
    const serverTimes=[],rpcTimes=[],pageDiagnostics=[];
    let dataAttempts=0,badgeAttempts=0,manifestAttempts=0,retryCount=0,loadedTotal=0;
    const requestedChunk=Math.max(250,Math.min(4000,Number(chunkSize)||2000));
    fullMatrixReadContext={mode:'grid-feed-v5',endpoints:{}};
    try{
      const token=requireOperationsHubSessionToken();
      const manifestRead=await readMatrixGridRpc('hub_matrix_grid_manifest_v6',{
        p_session_token:token,p_chunk_size:requestedChunk
      },{signal,page:0,cursor:null});
      manifestAttempts+=manifestRead.attempts;retryCount+=manifestRead.retries;
      rpcTimes.push(manifestRead.clientMs);
      const manifest=manifestRead.data;
      const total=Number(manifest.total),datasetVersion=String(manifest.dataset_version||'');
      if(Number(manifest.contract_version)!==6||!Number.isInteger(total)||total<0||!datasetVersion)throw Error('Matrix Grid v6 manifest가 올바르지 않습니다.');
      const tagCatalog=manifest.tag_catalog&&typeof manifest.tag_catalog==='object'?manifest.tag_catalog:{};
      const maxChunk=Math.max(250,Number(manifest.max_chunk_size)||4000);
      // The manifest builds its keyset cursors from p_chunk_size.  Keep the
      // browser's bounded request size authoritative instead of silently
      // switching back to a larger server recommendation after the cursors
      // have already been generated.
      const safeChunk=Math.max(250,Math.min(maxChunk,requestedChunk));
      if(safeChunk!==requestedChunk)throw Error('Matrix Grid manifest chunk contract가 일치하지 않습니다.');
      const cursors=Array.isArray(manifest.page_cursors)?manifest.page_cursors:[];
      const expectedPages=total?Math.ceil(total/safeChunk):0;
      if(cursors.length!==expectedPages||expectedPages>25||(expectedPages&&cursors[0]!==null))throw Error('Grid feed keyset cursor manifest가 올바르지 않습니다.');
      if(new Set(cursors.slice(1).map(cleanText)).size!==Math.max(0,cursors.length-1))throw Error('Grid feed keyset cursor가 중복되었습니다.');
      const pageResults=Array(cursors.length);let nextPage=0,failed=false;
      const readPage=async index=>{
        const page=index+1,cursor=cursors[index]==null?null:cleanText(cursors[index]);
        const read=await readMatrixGridRpc('hub_matrix_grid_feed_v5',{
          p_session_token:token,p_dataset_version:datasetVersion,p_after_sku:cursor,p_limit:safeChunk
        },{signal,page,cursor});
        dataAttempts+=read.attempts;retryCount+=read.retries;rpcTimes.push(read.clientMs);
        const result=read.data,part=Array.isArray(result.rows)?result.rows:[];
        if(Number(result.contract_version)!==5)throw Error('Grid feed v5 contract가 일치하지 않습니다.');
        if(String(result.dataset_version||'')!==datasetVersion)throw Error('Grid feed 로딩 중 Matrix cache가 변경되었습니다. DB 새로고침 후 다시 시도해주세요.');
        if(Number(result.loaded)!==part.length||part.length>(safeChunk))throw Error('Grid feed 응답 count가 일치하지 않습니다.');
        const expectedNext=index+1<cursors.length?cleanText(cursors[index+1]):null;
        const actualNext=cleanText(result.next_sku)||null;
        if(actualNext!==expectedNext||Boolean(result.has_more)!==Boolean(expectedNext))throw Error('Grid feed keyset cursor가 진행되지 않았습니다.');
        const pageSkus=part.map(raw=>cleanText(Array.isArray(raw)?raw[0]:raw?.sellpia_sku_code));
        if(pageSkus.some(sku=>!sku)||new Set(pageSkus).size!==pageSkus.length)throw Error(`Grid feed ${page}페이지 SKU identity 중복/누락`);
        let badgeRead=null,linkBadgeCatalog={};
        if(pageSkus.length){
          badgeRead=await readMatrixGridRpc('hub_matrix_grid_link_badges_v1',{
            p_session_token:token,p_dataset_version:datasetVersion,p_skus:pageSkus
          },{signal,page,cursor});
          badgeAttempts+=badgeRead.attempts;retryCount+=badgeRead.retries;rpcTimes.push(badgeRead.clientMs);
          const badges=badgeRead.data;
          if(Number(badges.contract_version)!==1||String(badges.dataset_version||'')!==datasetVersion||Number(badges.requested)!==pageSkus.length||!Array.isArray(badges.link_badges))throw Error('Grid feed 연결 배지 응답 contract가 일치하지 않습니다.');
          const allowed=new Set(pageSkus);
          for(const badge of badges.link_badges){
            const sku=cleanText(badge?.[0]),source=cleanText(badge?.[1]);
            if(!allowed.has(sku)||!source||(linkBadgeCatalog[sku]||{})[source])throw Error('Grid feed 연결 배지 SKU/source가 일치하지 않습니다.');
            (linkBadgeCatalog[sku]??={})[source]={max:Number(badge?.[2]||0),relation:cleanText(badge?.[3])||'single'};
          }
        }
        const normalizeAt=performance.now(),normalized=part.map(raw=>normalizeMatrixGridRow(raw,tagCatalog,linkBadgeCatalog));
        const normalizeMs=performance.now()-normalizeAt,serverMs=Number(result.server_ms),payloadBytes=Number(result.payload_bytes);
        if(Number.isFinite(serverMs))serverTimes.push(serverMs);
        pageResults[index]=typeof attachCurrentPriceDecisions==='function'?await attachCurrentPriceDecisions(normalized,signal):normalized;loadedTotal+=normalized.length;
        pageDiagnostics.push({page,cursor,loaded:part.length,nextSku:actualNext,
          serverMs:Number.isFinite(serverMs)?serverMs:null,clientMs:read.clientMs,
          payloadBytes:Number.isFinite(payloadBytes)?payloadBytes:null,normalizeMs,retries:read.retries,
          badgeClientMs:badgeRead?.clientMs??0,badgeServerMs:badgeRead?Number(badgeRead.data.server_ms):0,badgeRetries:badgeRead?.retries??0});
        onProgress?.({loaded:loadedTotal,total,elapsed:performance.now()-started,metrics:{
          mode:'grid-feed-v5',requests:matrixReadMetrics.requests-before.requests,bytes:matrixReadMetrics.bytes-before.bytes,
          networkMs:matrixReadMetrics.networkMs-before.networkMs,serverMeanMs:serverTimes.length?serverTimes.reduce((a,b)=>a+b,0)/serverTimes.length:0,
          serverMaxMs:serverTimes.length?Math.max(...serverTimes):0,chunkSize:safeChunk,datasetVersion,
          dataPages:cursors.length,dataAttempts,badgeAttempts,manifestAttempts,retryCount,failedAttempts:retryCount,
          completedPages:pageResults.filter(Boolean).length,currentPage:page,currentCursor:cursor,
          pageDiagnostics:[...pageDiagnostics].sort((a,b)=>a.page-b.page),endpoints:fullMatrixReadContext.endpoints||{}
        }});
      };
      const workers=Array.from({length:Math.min(1,cursors.length)},async()=>{
        while(!failed){const index=nextPage++;if(index>=cursors.length)return;try{await readPage(index);}catch(error){failed=true;throw error;}}
      });
      await Promise.all(workers);
      const rows=pageResults.flat(),seen=new Set();
      for(const row of rows){const sku=cleanText(row.sellpia_sku_code);if(!sku||seen.has(sku))throw Error(`Grid feed SKU identity 중복/누락: ${sku||'(빈 SKU)'}`);seen.add(sku);}
      const finalManifestRead=await readMatrixGridRpc('hub_matrix_grid_guard_v5',{
        p_session_token:token
      },{signal,page:cursors.length+1,cursor:'manifest-recheck'});
      manifestAttempts+=finalManifestRead.attempts;retryCount+=finalManifestRead.retries;
      rpcTimes.push(finalManifestRead.clientMs);
      const finalManifest=finalManifestRead.data;
      if(Number(finalManifest.total)!==total||String(finalManifest.dataset_version||'')!==datasetVersion){
        throw Error('Grid feed 로딩 중 Matrix cache가 변경되었습니다. 기존 dataset을 유지하고 다시 시도해주세요.');
      }
      if(rows.length!==total||seen.size!==total)throw Error(`Grid feed 전체 SKU 누락: ${rows.length.toLocaleString('ko-KR')} / ${total.toLocaleString('ko-KR')}`);
      pageDiagnostics.sort((a,b)=>a.page-b.page);serverTimes.sort((a,b)=>a-b);
      const percentile=p=>serverTimes.length?serverTimes[Math.min(serverTimes.length-1,Math.ceil(serverTimes.length*p)-1)]:0;
      return {rows,count:total,elapsed:performance.now()-started,metrics:{
        mode:'grid-feed-v5',requests:matrixReadMetrics.requests-before.requests,bytes:matrixReadMetrics.bytes-before.bytes,
        networkMs:matrixReadMetrics.networkMs-before.networkMs,clientRpcMeanMs:rpcTimes.length?rpcTimes.reduce((a,b)=>a+b,0)/rpcTimes.length:0,
        clientRpcMaxMs:rpcTimes.length?Math.max(...rpcTimes):0,serverMeanMs:serverTimes.length?serverTimes.reduce((a,b)=>a+b,0)/serverTimes.length:0,
        serverP50Ms:percentile(.5),serverP95Ms:percentile(.95),serverMaxMs:serverTimes.length?Math.max(...serverTimes):0,
        chunkSize:safeChunk,pageConcurrency:Math.min(1,cursors.length),datasetVersion,
        dataPages:cursors.length,dataAttempts,badgeAttempts,manifestAttempts,retryCount,failedAttempts:retryCount,
        pageDiagnostics,endpoints:fullMatrixReadContext.endpoints||{}
      }};
    }finally{fullMatrixReadContext=null;}
  }

  async function loadMatrixGridRowsBySkus(skus=[],{signal=null}={}) {
    const requested=[...new Set((Array.isArray(skus)?skus:[]).map(cleanText).filter(Boolean))];
    if(!requested.length)return [];
    const token=requireOperationsHubSessionToken(),rows=[],seen=new Set(),versions=new Set();
    for(let offset=0;offset<requested.length;offset+=200){
      const batch=requested.slice(offset,offset+200);
      const read=await readMatrixGridRpc('hub_matrix_grid_rows_v5',{
        p_session_token:token,p_skus:batch
      },{signal,page:Math.floor(offset/200)+1,cursor:'targeted-skus'});
      const response=read.data,part=Array.isArray(response.rows)?response.rows:[];
      if(Number(response.contract_version)!==5||Number(response.requested)!==batch.length||Number(response.loaded)!==part.length)
        throw Error('Matrix targeted row 응답 계약이 일치하지 않습니다.');
      if(!cleanText(response.dataset_version))throw Error('Matrix targeted row 버전이 없습니다.');
      versions.add(cleanText(response.dataset_version));
      if(versions.size>1)throw Error('부분 갱신 중 Matrix cache 버전이 변경됐습니다. 다시 시도해주세요.');
      const tagCatalog=response.tag_catalog&&typeof response.tag_catalog==='object'?response.tag_catalog:{};
      const badges={};
      for(const badge of Array.isArray(response.link_badges)?response.link_badges:[]){
        const sku=cleanText(badge?.[0]),source=cleanText(badge?.[1]);if(!sku||!source)continue;
        (badges[sku]??={})[source]={max:Number(badge?.[2]||0),relation:cleanText(badge?.[3])||'single'};
      }
      const batchSet=new Set(batch),missing=Array.isArray(response.missing_skus)?response.missing_skus:[];
      if(missing.length)throw Error(`Matrix SKU membership 변경: ${missing.slice(0,5).join(', ')} · 전체 DB 새로고침이 필요합니다.`);
      for(const raw of part){
        const row=normalizeMatrixGridRow(raw,tagCatalog,badges),sku=cleanText(row.sellpia_sku_code);
        if(!batchSet.has(sku)||seen.has(sku))throw Error(`Matrix targeted row SKU 중복/범위 오류: ${sku||'(빈 SKU)'}`);
        seen.add(sku);rows.push(row);
      }
      if(part.length!==batch.length)throw Error('Matrix targeted row 누락 · 전체 DB 새로고침이 필요합니다.');
    }
    return typeof attachCurrentPriceDecisions==='function'?attachCurrentPriceDecisions(rows,signal):rows;
  }

  async function loadFullMatrixDataset({signal=null,onProgress=null}={}) {
    fullMatrixReadContext={};try{
    const started=performance.now(),before={...matrixReadMetrics},identity=await loadAllFilteredSkus({status:'all'}),codes=identity.skus;
    const batches=[];for(let i=0;i<codes.length;i+=200)batches.push(codes.slice(i,i+200));
    let cursor=0,loaded=0,failed=false;const rows=[];const complete=part=>part.length>0&&part.every(r=>r.__hubActivePriceRules&&(!global.HubMatrixShadow||['smartstore','makeshop','ably'].every(s=>r.__hubShadow?.[s])));async function readBatch(batch){try{const part=await loadProductsBySkus(batch,{signal});if(part.length!==batch.length||!complete(part))throw Error('필수 shadow 조회 지연');return part;}catch(error){if(batch.length<=25||!/57014|timeout|shadow 조회 지연/i.test(error.message||String(error)))throw new Error((error.message||String(error))+' ['+batch[0]+' ~ '+batch.at(-1)+']');const middle=Math.ceil(batch.length/2);return [...await readBatch(batch.slice(0,middle)),...await readBatch(batch.slice(middle))];}}
    const workers=await Promise.allSettled(Array.from({length:Math.min(2,batches.length)},async()=>{while(!failed&&cursor<batches.length){throwIfAborted(signal);const batch=batches[cursor++];try{const part=await readBatch(batch);if(failed)return;rows.push(...part);loaded+=part.length;onProgress?.({loaded,total:codes.length,elapsed:performance.now()-started,metrics:{requests:matrixReadMetrics.requests-before.requests,bytes:matrixReadMetrics.bytes-before.bytes,networkMs:matrixReadMetrics.networkMs-before.networkMs,endpoints:fullMatrixReadContext.endpoints||{}}});}catch(error){failed=true;throw error;}}}));
    const failure=workers.find(worker=>worker.status==='rejected');if(failure)throw failure.reason;
    const confirm=await loadAllFilteredSkus({status:'all'});
    if(confirm.skus.length!==codes.length||confirm.skus.some((s,i)=>s!==codes[i]))throw Error('로딩 중 전체 SKU membership 변경 · DB 새로고침이 필요합니다.');
    const seen=new Set(rows.map(r=>r.sellpia_sku_code));if(seen.size!==codes.length||codes.some(s=>!seen.has(s)))throw Error('전체 Matrix SKU 중복/누락');
    return {rows,count:codes.length,elapsed:performance.now()-started,metrics:{requests:matrixReadMetrics.requests-before.requests,bytes:matrixReadMetrics.bytes-before.bytes,networkMs:matrixReadMetrics.networkMs-before.networkMs,endpoints:fullMatrixReadContext.endpoints||{}}};
    }finally{fullMatrixReadContext=null;}
  }

  async function loadProductsBySkus(skus = [], {signal = null} = {}) {
    const normalizedSkus = [...new Set((Array.isArray(skus) ? skus : []).map(cleanText).filter(Boolean))];
    if (!normalizedSkus.length) return [];
    const rows = [];
    const batchSize=fullMatrixReadContext?200:500;
    for (let offset = 0; offset < normalizedSkus.length; offset += batchSize) {
      const {data, error} = await withAbortSignal(fullMatrixReadContext?db.rpc('load_operations_hub_matrix_rows_batch_v1',{p_skus:normalizedSkus.slice(offset,offset+batchSize)}):db
        .from(MATRIX_VIEW)
        .select(MATRIX_SELECT)
        .in('sellpia_sku_code', normalizedSkus.slice(offset, offset + batchSize)), signal);
      if (error) throw new Error("Matrix 기본 행 조회: "+(error.message||String(error)));
      rows.push(...(data || []));
    }
    return attachProductMetadata(rows, signal);
  }

  // Mapping templates only need the SKU and its visible thumbnail.  Do not
  // attach pricing, tag, draft, or mapping metadata here: that expanded RPC
  // is intentionally capped and can time out for a multi-thousand-row file.
  async function loadProductThumbnailsBySkus(skus = [], {onProgress = null} = {}) {
    const normalizedSkus = [...new Set((Array.isArray(skus) ? skus : []).map(cleanText).filter(Boolean))];
    const rows = [];
    for (let offset = 0; offset < normalizedSkus.length; offset += 500) {
      const batch = normalizedSkus.slice(offset, offset + 500);
      const {data, error} = await db
        .from(MATRIX_VIEW)
        .select('sellpia_sku_code,image_url,sellpia_override_image_url')
        .in('sellpia_sku_code', batch);
      if (error) throw error;
      rows.push(...(data || []));
      onProgress?.({loaded:Math.min(offset + batch.length, normalizedSkus.length), total:normalizedSkus.length});
    }
    return rows;
  }

  async function loadMatrixExportChunk({
    offset = 0,
    limit = 1000,
    search = '',
    searchSources = ['sellpia','smartstore','makeshop','ably'],
    status = 'all',
    sort = 'sku_asc',
    advancedFilter = null,
    skus = []
  } = {}) {
    const filterPayload = normalizeConnectionConditions(advancedFilter);
    const {data, error} = await db.rpc('export_operations_hub_matrix_chunk', {
      p_offset:Math.max(0, Math.trunc(Number(offset) || 0)),
      p_limit:Math.max(1, Math.min(Math.trunc(Number(limit) || 1000), 1000)),
      p_search:normalizedSearch(search),
      p_search_sources:Array.isArray(searchSources) ? searchSources : [],
      p_status:normalizeConnectionStatus(status),
      p_sort:cleanText(sort) || 'sku_asc',
      p_filter:filterPayload,
      p_skus:[...new Set((skus || []).map(cleanText).filter(Boolean))].slice(0, 1000)
    });
    if (error) throw error;
    return {
      rows:await attachLinkSuppressions(await attachSystemOperationalDetails(await attachInboundCostDetails(Array.isArray(data?.rows) ? data.rows : []))),
      offset:Number(data?.offset || offset || 0),
      limit:Number(data?.limit || limit || 1000)
    };
  }

  async function loadSourceStatus() {
    const { data, error } = await db
      .from('operations_hub_source_status')
      .select('source,event_type,status,event_at,duration_ms,processed_rows,total_rows,output_rows,payload')
      .order('event_at', { ascending: false })
      .limit(80);
    if (error) throw error;

    const latest = {};
    for (const event of data || []) {
      if (!latest[event.source] && ['SOURCE_UPLOAD', 'INVENTORY_MATCH'].includes(event.event_type)) latest[event.source] = event;
    }
    return { events: data || [], latest };
  }

  async function loadDashboardMetrics() {
    const {data, error} = await db
      .from('operations_hub_dashboard_metrics')
      .select('total_sku,connected_sku,unmatched_sku,seller_sku_total,seller_connected_sku,seller_unmatched_sku,seller_unmatched_smartstore,seller_unmatched_makeshop,seller_unmatched_ably,inventory_mismatch_sku,projected_inventory_mismatch_sku,inventory_draft_cells,inventory_failed_cells,latest_sync_at,today_picked,shortage_drawer_qty')
      .single();
    if (error) throw error;
    return data;
  }

  async function loadAllSellerUnmatchedSkus({onProgress = null} = {}) {
    const rows = [];
    const pageSize = 1000;
    onProgress?.({loaded:0, message:'판매처 미연결 SKU 조회 중'});
    for (let from = 0; ; from += pageSize) {
      const {data, error} = await db
        .from('operations_hub_seller_unmatched_live')
        .select('source_channel,product_code,option_code,product_name,option_name')
        .order('source_channel')
        .order('product_code')
        .order('option_code')
        .range(from, from + pageSize - 1);
      if (error) throw error;
      rows.push(...(data || []));
      onProgress?.({loaded:rows.length, message:`판매처 미연결 SKU ${rows.length.toLocaleString()}개 조회`});
      if (!data || data.length < pageSize) break;
    }
    return rows;
  }

  async function loadMappingSyncStatus() {
    const {data, error} = await db
      .from('operations_hub_mapping_sync_status')
      .select('official_mapping_count,manual_mapping_count,automatic_mapping_count,import_mapping_count,latest_official_mapping_at,latest_legacy_mapping_at,core_refreshed_at,core_refreshed_by,core_row_count,core_refresh_needed,latest_batch_id,latest_batch_request_id,latest_batch_origin,latest_batch_actor,latest_batch_status,latest_batch_requested_count,latest_batch_saved_count,latest_batch_failed_count,latest_batch_created_at,latest_batch_completed_at,mapping_version,legacy_auto_refresh_enabled,legacy_auto_refresh_schedule')
      .single();
    if (error) throw error;
    return data;
  }

  async function saveSellpiaChanges(changes, batchId = null, options = {}) {
    const systemChangeSource = cleanText(options?.systemChangeSource) || 'manual';
    const systemMetadata = options?.systemMetadata && typeof options.systemMetadata === 'object' && !Array.isArray(options.systemMetadata)
      ? options.systemMetadata
      : {ui:'integrated-matrix'};
    const grouped = new Map();
    for (const change of changes || []) {
      if (!change?.sku || !change?.fieldKey) continue;
      if (!grouped.has(change.sku)) grouped.set(change.sku, []);
      grouped.get(change.sku).push({
        field_key:change.fieldKey,
        before:String(change.before ?? ''),
        after:String(change.after ?? '')
      });
    }
    let savedCount = 0;
    let queuedCount = 0;
    const priceChanged = [...grouped.values()].some(items => items.some(item => item.field_key === 'sellpia_sale_price'));
    const systemRows = [];
    const systemFieldKeys = new Set([
      'system_base_price',
      'system_stock',
      'sellpia_purchase_price',
      'sellpia_order_unit',
      'sellpia_minimum_order_unit'
    ]);
    for (const [sku, items] of grouped) {
      const systemItems = items.filter(item => systemFieldKeys.has(item.field_key));
      const sourceItems = items.filter(item => !systemFieldKeys.has(item.field_key));
      for (const item of systemItems) {
        const rawValue = cleanText(item.after);
        const {data, error} = await db.rpc('save_operations_hub_sku_operational_value', {
          p_session_token:requireOperationsHubSessionToken(),
          p_sellpia_sku_code:sku,
          p_field_key:item.field_key,
          p_value:rawValue === '' ? null : Number(rawValue),
          p_change_source:systemChangeSource,
          p_actor:'operations-hub',
          p_metadata:systemMetadata
        });
        if (error) throwOperationsHubRpcError(error);
        const savedRow = Array.isArray(data) ? data[0] : data;
        if (savedRow) systemRows.push(savedRow);
        savedCount += 1;
      }
      if (sourceItems.length) {
        const {data, error} = await db.rpc('apply_operations_hub_sellpia_changes', {
          p_sku:sku,
          p_changes:sourceItems,
          p_batch_id:batchId
        });
        if (error) throw error;
        const result = Array.isArray(data) ? data[0] : data;
        savedCount += Number(result?.saved_count || sourceItems.length);
        queuedCount += Number(result?.queued_count || 0);
      }
    }
    let repricedRows = [];
    let repriceRefreshError = '';
    if (priceChanged && batchId) {
      try {
        const {data:repriced, error} = await db
          .from('operations_hub_change_queue')
          .select('sellpia_sku_code')
          .eq('change_batch_id', batchId)
          .eq('field_key', 'sellpia_sale_price')
          .in('source_channel', ['smartstore','makeshop'])
          .in('status', ['pending','validated','failed']);
        if (error) throw error;
        const repricedSkus = [...new Set((repriced || []).map(row => cleanText(row.sellpia_sku_code)).filter(Boolean))];
        if (repricedSkus.length) {
          const seeds = repricedSkus.map(sellpia_sku_code => ({sellpia_sku_code}));
          repricedRows = await attachPriceRuleAssignments(await attachSellerDrafts(await attachSellerPriceComponents(seeds)));
        }
      } catch (error) {
        // The RPC above has already committed. A metadata refresh failure must not
        // make the UI re-submit the same Sellpia edit as though the save failed.
        console.error('sellpia repriced rows refresh failed', error);
        repriceRefreshError = error?.message || String(error);
      }
    }
    return {savedCount, queuedCount, productCount:grouped.size, batchId, repricedRows, systemRows, repriceRefreshError};
  }

  async function refreshMasterColumnFromSource({fieldKey, actor = 'operations-hub', requestId = null, dryRun = true} = {}) {
    const allowedFields = new Set([
      'system_base_price',
      'system_stock',
      'sellpia_purchase_price',
      'sellpia_order_unit',
      'sellpia_minimum_order_unit'
    ]);
    const safeField = cleanText(fieldKey);
    if (!allowedFields.has(safeField)) throw new Error(`원본값 전체 갱신을 지원하지 않는 필드입니다: ${safeField || '-'}`);
    const params = {
      p_session_token:requireOperationsHubSessionToken(),
      p_field_key:safeField,
      p_actor:cleanText(actor) || 'operations-hub',
      p_dry_run:dryRun !== false
    };
    const safeRequestId = cleanText(requestId);
    if (safeRequestId) params.p_request_id = safeRequestId;
    const {data, error} = await db.rpc('refresh_operations_hub_master_column_from_source_v1', params);
    if (error) throwOperationsHubRpcError(error);
    const result = data || {};
    const row = Array.isArray(result) ? result[0] : result;
    if (dryRun !== false) return result;
    try {
      const changedCount = Number(row?.affected_count || 0);
      const recovery = changedCount < 1 && ['system_base_price','sellpia_purchase_price'].includes(safeField);
      if (!changedCount && !recovery) return result;
      const rpc = recovery
        ? 'read_operations_hub_bulk_source_refresh_recovery_skus_v1'
        : 'read_operations_hub_bulk_source_refresh_affected_skus_v1';
      const args = recovery
        ? {p_session_token:requireOperationsHubSessionToken(), p_field_key:safeField}
        : {p_session_token:requireOperationsHubSessionToken(), p_request_id:safeRequestId || row?.request_id, p_field_key:safeField};
      const {data:scope, error:scopeError} = await db.rpc(rpc, args);
      if (scopeError) throwOperationsHubRpcError(scopeError);
      return {
        ...row,
        affected_skus:Array.isArray(scope?.affected_skus) ? scope.affected_skus : [],
        calculation_recovery:recovery && Number(scope?.recovery_count || 0) > 0,
        calculation_recovery_count:Number(scope?.recovery_count || 0),
        calculation_source_request_id:scope?.request_id || null
      };
    } catch (scopeError) {
      return {...row, affected_skus:[], affected_skus_error:readableDatabaseError(scopeError)?.message || String(scopeError)};
    }
  }

  async function loadPendingPurchasePriceRecalculations({limit = 100} = {}) {
    const safeLimit = Math.min(200, Math.max(1, Number(limit) || 100));
    const {data, error} = await db.rpc('read_operations_hub_pending_purchase_price_recalculation_v2', {
      p_session_token:requireOperationsHubSessionToken(),
      p_limit:safeLimit
    });
    if (error) throwOperationsHubRpcError(error);
    const result = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
    return {
      pendingCount:Math.max(0, Number(result.pending_count) || 0),
      batchCount:Math.max(0, Number(result.batch_count) || 0),
      skus:[...new Set((Array.isArray(result.affected_skus) ? result.affected_skus : [])
        .map(value => cleanText(value)).filter(Boolean))]
    };
  }

  async function runSelectedSourceRefreshBatch({
    requestId,
    targets = [],
    scope = {},
    dryRun = true,
    batchId = null,
    retryFailedOnlyFrom = null
  } = {}) {
    const safeRequestId = cleanText(requestId);
    if (!safeRequestId) throw new Error('선택 원본 갱신 요청 ID가 필요합니다.');
    if (Array.isArray(targets) && targets.length > 50) throw new Error('선택 원본 갱신 서버 요청은 한 번에 50개 DB 대상까지 가능합니다.');
    const safeTargets = (Array.isArray(targets) ? targets : []).map(target => ({
      kind:cleanText(target?.kind),
      sku:cleanText(target?.sku),
      source:cleanText(target?.source),
      fieldKey:cleanText(target?.fieldKey),
      priceComponent:cleanText(target?.priceComponent),
      productCode:cleanText(target?.productCode),
      optionCode:cleanText(target?.optionCode)
    }));
    if (dryRun !== false && !safeTargets.length && !cleanText(retryFailedOnlyFrom)) {
      throw new Error('원본값으로 갱신할 선택 대상이 없습니다.');
    }
    const safeScope = scope && typeof scope === 'object' && !Array.isArray(scope) ? {
      type:cleanText(scope.type) || 'selected_cells',
      label:cleanText(scope.label) || '선택 셀',
      selectedCellCount:Math.max(0, Number(scope.selectedCellCount) || 0),
      selectedColumnLabels:(Array.isArray(scope.selectedColumnLabels) ? scope.selectedColumnLabels : []).map(cleanText).filter(Boolean).slice(0, 20),
      visibleRowCount:Math.max(0, Number(scope.visibleRowCount) || 0),
      selectedSkuCount:Math.max(0, Number(scope.selectedSkuCount) || 0),
      databaseTargetCount:safeTargets.length,
      page:Math.max(1, Number(scope.page) || 1),
      pageSize:Math.max(1, Number(scope.pageSize) || 50),
      search:cleanText(scope.search).slice(0, 200),
      retryFailedOnly:Boolean(scope.retryFailedOnly),
      chunkIndex:Math.max(0, Number(scope.chunkIndex) || 0),
      chunkCount:Math.max(0, Number(scope.chunkCount) || 0)
    } : {};
    const {data, error} = await db.rpc('run_operations_hub_selected_source_refresh_batch_v1', {
      p_session_token:requireOperationsHubSessionToken(),
      p_request_id:safeRequestId,
      p_targets:safeTargets,
      p_scope:safeScope,
      p_dry_run:dryRun !== false,
      p_batch_id:cleanText(batchId) || null,
      p_retry_failed_only_from:cleanText(retryFailedOnlyFrom) || null
    });
    if (error) throwOperationsHubRpcError(error);
    return data || {};
  }

  async function loadListingConnection({source, productCode, optionCode = ''} = {}) {
    const {data, error} = await db.rpc('get_operations_hub_listing_graph', {
      p_source:cleanText(source),
      p_product_code:cleanText(productCode),
      p_option_code:cleanText(optionCode)
    });
    if (error) throw error;
    return data || null;
  }

  async function searchSellerItems(source, query, page = 1, pageSize = 24) {
    const safeSource = cleanText(source);
    if (!['smartstore', 'makeshop', 'ably'].includes(safeSource)) throw new Error('판매처를 확인해주세요.');
    const safePage = Math.max(1, Number(page) || 1);
    const safePageSize = Math.max(1, Math.min(Number(pageSize) || 24, 100));
    const {data, error} = await db.rpc('search_operations_hub_seller_items_v2', {
      p_source:safeSource,
      p_query:cleanText(query),
      p_page:safePage,
      p_page_size:safePageSize
    });
    if (error) throw error;
    const rows = data || [];
    return {rows, count:Number(rows[0]?.total_count || 0), page:safePage, pageSize:safePageSize};
  }

  async function loadSellerProductOptions(source, productCode) {
    const exactProductCode = cleanText(productCode);
    if (!exactProductCode) throw new Error('복사할 판매처 상품코드를 확인해주세요.');
    const options = [];
    const seen = new Set();
    const pageSize = 100;
    for (let page = 1; page <= 20; page += 1) {
      const result = await searchSellerItems(source, exactProductCode, page, pageSize);
      const rows = Array.isArray(result.rows) ? result.rows : [];
      for (const row of rows) {
        if (cleanText(row.product_code) !== exactProductCode) continue;
        const optionCode = cleanText(row.option_code);
        if (seen.has(optionCode)) continue;
        seen.add(optionCode);
        options.push(row);
      }
      if (rows.length < pageSize || rows.some(row => cleanText(row.product_code) !== exactProductCode)) break;
    }
    return options.sort((left, right) => cleanText(left.option_code).localeCompare(cleanText(right.option_code), 'ko', {numeric:true}));
  }

  async function resolveRelationImportCodes(codes) {
    const normalized = [...new Set((codes || []).map(cleanText).filter(Boolean))];
    if (!normalized.length) return [];
    if (normalized.length > 500) throw new Error('관계 일괄 등록 코드는 한 번에 최대 500개입니다.');
    const {data, error} = await db.rpc('resolve_operations_hub_relation_import_codes', {
      p_codes:normalized
    });
    if (error) throw error;
    return Array.isArray(data?.items) ? data.items : [];
  }

  async function listBundleGraph(query = '') {
    const {data, error} = await db.rpc('list_operations_hub_bundle_graph_v1', {
      p_query:cleanText(query)
    });
    if (error) throw error;
    return data || {bundles:[]};
  }

  async function resolveBundleImportCodes(codes) {
    const normalized = [...new Set((codes || []).map(cleanText).filter(Boolean))];
    if (!normalized.length) return [];
    if (normalized.length > 500) throw new Error('세트 구성 일괄 등록 코드는 한 번에 최대 500개입니다.');
    const {data, error} = await db.rpc('resolve_operations_hub_bundle_import_codes_v1', {
      p_codes:normalized
    });
    if (error) throw error;
    return Array.isArray(data?.items) ? data.items : (Array.isArray(data) ? data : []);
  }

  async function applyBundleImport(rows) {
    const inputRows = Array.isArray(rows) ? rows : [];
    if (!inputRows.length) throw new Error('저장할 세트 구성 행이 없습니다.');
    if (inputRows.length > 1000) throw new Error('세트 구성은 한 번에 최대 1,000행까지 저장할 수 있습니다.');
    const normalized = inputRows.map((row, index) => ({
      bundle_sku_code:cleanText(row?.bundle_sku_code || row?.bundleSkuCode || row?.bundleCode),
      component_sku_code:cleanText(row?.component_sku_code || row?.componentSkuCode || row?.componentCode),
      component_qty:Number(row?.component_qty ?? row?.componentQty ?? row?.quantity),
      component_role:cleanText(row?.component_role || row?.componentRole || row?.role) || 'component',
      sort_order:Math.max(0, Math.trunc(Number(row?.sort_order ?? row?.sortOrder ?? ((index + 1) * 100)) || 0))
    }));
    normalized.forEach((row, index) => {
      if (!row.bundle_sku_code || !row.component_sku_code) throw new Error(`${index + 1}번째 세트 구성의 SKU를 확인해주세요.`);
      if (row.bundle_sku_code === row.component_sku_code) throw new Error(`${index + 1}번째 세트와 구성품 SKU가 같습니다.`);
      if (!Number.isSafeInteger(row.component_qty) || row.component_qty <= 0 || row.component_qty > 2147483647) throw new Error(`${index + 1}번째 구성수량은 1 이상 2,147,483,647 이하의 정수여야 합니다.`);
      if (!['component','packaging'].includes(row.component_role)) throw new Error(`${index + 1}번째 역할은 구성품 또는 포장재만 사용할 수 있습니다.`);
    });
    const {data, error} = await db.rpc('apply_operations_hub_bundle_import_v1', {
      p_rows:normalized
    });
    if (error) throw error;
    if (data?.applied === false) {
      const details = (Array.isArray(data.errors) ? data.errors : [])
        .map(item => cleanText(item?.message || item?.detail || item?.code || item))
        .filter(Boolean);
      throw new Error(details.join(' / ') || '세트 구성 검증에 실패해 저장하지 않았습니다.');
    }
    return data || null;
  }

  async function saveBundleComponent({bundleSkuCode, componentSkuCode, qty = 1, role = 'component', sortOrder = 100} = {}) {
    const bundleSku = cleanText(bundleSkuCode);
    const componentSku = cleanText(componentSkuCode);
    const componentQty = Number(qty);
    if (!bundleSku || !componentSku) throw new Error('세트 SKU와 구성품 SKU를 확인해주세요.');
    if (bundleSku === componentSku) throw new Error('세트 SKU를 자기 자신의 구성품으로 저장할 수 없습니다.');
    if (!Number.isSafeInteger(componentQty) || componentQty <= 0 || componentQty > 2147483647) throw new Error('구성수량은 1 이상 2,147,483,647 이하의 정수여야 합니다.');
    const {data, error} = await db.rpc('save_operations_hub_bundle_component_v1', {
      p_bundle_sku_code:bundleSku,
      p_component_sku_code:componentSku,
      p_component_qty:componentQty,
      p_component_role:['component','packaging'].includes(cleanText(role)) ? cleanText(role) : 'component',
      p_sort_order:Math.max(0, Math.trunc(Number(sortOrder) || 100))
    });
    if (error) throw error;
    return Array.isArray(data) ? (data[0] || null) : data;
  }

  async function deactivateBundleComponent(componentId) {
    const normalizedId = Number(componentId);
    if (!Number.isFinite(normalizedId) || normalizedId <= 0) throw new Error('해제할 구성품 연결을 확인해주세요.');
    const {data, error} = await db.rpc('deactivate_operations_hub_bundle_component_v1', {
      p_component_id:normalizedId
    });
    if (error) throw error;
    return data || null;
  }

  function normalizeSellerBundleRows(rows) {
    const normalized = (Array.isArray(rows) ? rows : []).map((row, index) => ({
      source_channel:cleanText(row?.source_channel || row?.source || row?.sellerSource).toLowerCase(),
      product_code:cleanText(row?.product_code || row?.productCode),
      option_code:cleanText(row?.option_code || row?.optionCode),
      component_sku_code:cleanText(row?.component_sku_code || row?.componentSkuCode || row?.componentCode || row?.sku),
      component_qty:Number(row?.component_qty ?? row?.componentQty ?? row?.quantity ?? row?.qty),
      bundle_type:cleanText(row?.bundle_type || row?.bundleType || row?.type).toLowerCase()
    }));
    normalized.forEach((row, index) => {
      if (!['smartstore','makeshop','ably'].includes(row.source_channel)) throw new Error(`${index + 1}번째 판매처를 확인해주세요.`);
      if (!row.product_code) throw new Error(`${index + 1}번째 판매처 상품코드를 확인해주세요.`);
      if (!row.option_code) throw new Error(`${index + 1}번째 판매처 옵션코드를 확인해주세요.`);
      if (!row.component_sku_code) throw new Error(`${index + 1}번째 구성품 셀피아 SKU를 확인해주세요.`);
      if (!Number.isSafeInteger(row.component_qty) || row.component_qty < 1 || row.component_qty > 2147483647) throw new Error(`${index + 1}번째 구성수량은 1 이상의 정수여야 합니다.`);
      if (!['one_plus_one','set'].includes(row.bundle_type)) throw new Error(`${index + 1}번째 구성유형은 1+1 또는 세트여야 합니다.`);
    });
    return normalized;
  }

  async function listSellerBundleGraph({source = '', query = ''} = {}) {
    const normalizedSource = cleanText(source);
    if (normalizedSource && !['smartstore','makeshop','ably'].includes(normalizedSource)) throw new Error('판매처를 확인해주세요.');
    const {data, error} = await db.rpc('list_operations_hub_seller_bundle_graph_v1', {
      p_source:normalizedSource,
      p_query:cleanText(query)
    });
    if (error) throw error;
    return data || {listings:[], components:[], counts:{}};
  }

  async function resolveSellerBundleImportRows(rows) {
    const normalized = normalizeSellerBundleRows(rows);
    if (!normalized.length) return {rows:[], errors:[]};
    if (normalized.length > 1000) throw new Error('판매처 전용 구성은 한 번에 최대 1,000행까지 확인할 수 있습니다.');
    const {data, error} = await db.rpc('resolve_operations_hub_seller_bundle_import_rows_v1', {
      p_rows:normalized
    });
    if (error) throw error;
    return data || {rows:[], errors:[]};
  }

  async function applySellerBundleImport(rows) {
    const normalized = normalizeSellerBundleRows(rows);
    if (!normalized.length) throw new Error('저장할 판매처 전용 구성 행이 없습니다.');
    if (normalized.length > 1000) throw new Error('판매처 전용 구성은 한 번에 최대 1,000행까지 저장할 수 있습니다.');
    const {data, error} = await db.rpc('apply_operations_hub_seller_bundle_import_v1', {
      p_rows:normalized
    });
    if (error) throw error;
    return data || null;
  }

  async function saveSellerBundleComponent({source, productCode, optionCode = '', componentSkuCode, qty = 1, bundleType = 'set'} = {}) {
    const graph = await listSellerBundleGraph({source, query:productCode});
    const listing = (graph?.listings || []).find(row => cleanText(row?.sourceChannel || row?.source_channel) === cleanText(source)
      && cleanText(row?.productCode || row?.product_code) === cleanText(productCode)
      && cleanText(row?.optionCode || row?.option_code) === cleanText(optionCode));
    const listingId = cleanText(listing?.listingId || listing?.listing_id);
    const components = (graph?.components || []).filter(row => cleanText(row?.listingId || row?.listing_id) === listingId)
      .sort((left, right) => (cleanText(left?.componentRole || left?.component_role) === 'primary' ? -1 : 0) - (cleanText(right?.componentRole || right?.component_role) === 'primary' ? -1 : 0))
      .map(row => ({
        source_channel:source,
        product_code:productCode,
        option_code:optionCode,
        component_sku_code:cleanText(row?.componentSkuCode || row?.component_sku_code),
        component_qty:cleanNumber(row?.componentQty ?? row?.component_qty, 1),
        bundle_type:bundleType
      }));
    const normalizedSku = cleanText(componentSkuCode);
    const existing = components.find(row => row.component_sku_code === normalizedSku);
    if (existing) existing.component_qty = Number(qty);
    else components.push({source_channel:source, product_code:productCode, option_code:optionCode, component_sku_code:normalizedSku, component_qty:qty, bundle_type:bundleType});
    const result = await applySellerBundleImport(components);
    if (result?.applied === false) throw new Error((result.errors || []).join('\n') || '판매처 전용 구성을 저장하지 못했습니다.');
    return result;
  }

  async function deactivateSellerBundleComponent(componentId) {
    return deactivateListingComponent(componentId);
  }

  async function resolveCodeEntries(entries) {
    const normalized = (entries || []).map(entry => ({
      row_no:Math.max(1, Number(entry.row_no) || 1),
      source:cleanText(entry.source),
      code:cleanText(entry.code)
    })).filter(entry => entry.code);
    if (!normalized.length) return [];
    const chunkSize = 500;
    const resolved = [];
    for (let offset = 0; offset < normalized.length; offset += chunkSize) {
      const {data, error} = await db.rpc('resolve_operations_hub_code_entries', {
        p_entries:normalized.slice(offset, offset + chunkSize)
      });
      if (error) throw error;
      resolved.push(...(data || []));
    }
    return resolved;
  }

  async function refreshListingGraphCache(skus = null) {
    const normalizedSkus = Array.isArray(skus) ? [...new Set(skus.map(cleanText).filter(Boolean))] : null;
    const {data, error} = await db.rpc('refresh_operations_hub_listing_legacy_cache', {
      p_skus:normalizedSkus?.length ? normalizedSkus : null
    });
    if (error) throw error;
    return Number(data || 0);
  }

  async function linkSellerItem({sku, source, productCode, optionCode = ''}) {
    const {data, error} = await db.rpc('link_operations_hub_seller_item_v2', {
      p_sku:cleanText(sku),
      p_source:cleanText(source),
      p_product_code:cleanText(productCode),
      p_option_code:cleanText(optionCode)
    });
    if (error) throw error;
    return Array.isArray(data) ? data[0] : data;
  }

  async function previewMappingImport(entries) {
    if (!entries.length || entries.length > 150) throw new Error('매칭 검사는 한 묶음에 150건까지 가능합니다.');
    const skus = [...new Set(entries.map(row => row.sku))];
    const {data:matrix, error} = await db.from(MATRIX_VIEW)
      .select('sellpia_sku_code,smartstore_product_code,smartstore_option_code,makeshop_product_code,makeshop_option_code,ably_product_code,ably_option_code')
      .in('sellpia_sku_code', skus);
    if (error) throw error;
    const existing = new Map((matrix || []).map(row => [row.sellpia_sku_code, row]));
    const targets = new Map();
    for (const source of ['smartstore','makeshop','ably']) {
      const products = [...new Set(entries.filter(row => row.source === source).map(row => row.productCode))];
      if (!products.length) continue;
      for (let from = 0; ; from += 1000) {
        const result = await db.from('seller_inventory_latest').select('product_code,option_code,product_name,option_name')
          .eq('source_channel', source).in('product_code', products)
          .order('product_code').order('option_code').range(from, from + 999);
        if (result.error) throw result.error;
        for (const row of result.data || []) targets.set(JSON.stringify([source,row.product_code,row.option_code || '']), row);
        if ((result.data || []).length < 1000) break;
      }
    }
    return entries.map(entry => {
      const current = existing.get(entry.sku);
      const target = targets.get(JSON.stringify([entry.source,entry.productCode,entry.optionCode]));
      const before = current ? {productCode:cleanText(current[entry.source + '_product_code']),optionCode:cleanText(current[entry.source + '_option_code'])} : null;
      const reason = !current ? '셀피아 SKU가 최신 매트릭스에 없습니다.' : !target ? '최신 판매처 원본에 정확한 상품·옵션코드가 없습니다.' : '';
      const same = before && before.productCode === entry.productCode && before.optionCode === entry.optionCode;
      return {...entry,before,productName:target?.product_name || '',optionName:target?.option_name || '',status:reason ? 'error' : same ? 'same' : before?.productCode ? 'replace' : 'ready',reason};
    });
  }

  async function saveSellerListing({sku, source, productCode, optionCode = '', productName = '', optionName = '', queue = false, batchId = null}) {
    const {data, error} = await db.rpc('save_operations_hub_seller_listing', {
      p_sku:cleanText(sku),
      p_source:cleanText(source),
      p_product_code:cleanText(productCode),
      p_option_code:cleanText(optionCode),
      p_product_name:cleanText(productName),
      p_option_name:cleanText(optionName),
      p_queue:Boolean(queue),
      p_batch_id:batchId
    });
    if (error) throw error;
    return Array.isArray(data) ? data[0] : data;
  }

  async function attachChangeExportAudit(rows = []) {
    const changeIds = [...new Set(rows.map(row => Number(row.change_id)).filter(Number.isFinite))];
    if (!changeIds.length) return rows;
    const {data, error} = await db
      .from('operations_hub_export_items')
      .select('change_id,status,updated_at')
      .in('change_id', changeIds)
      .in('status', ['exported','applied','cancelled']);
    if (error) throw error;
    const auditByChange = new Map();
    for (const item of data || []) {
      const changeId = Number(item.change_id);
      const audit = auditByChange.get(changeId) || {
        exported_file_count:0,
        applied_file_count:0,
        stale_file_count:0,
        latest_exported_at:null
      };
      if (item.status === 'exported') audit.exported_file_count += 1;
      else if (item.status === 'applied') audit.applied_file_count += 1;
      else if (item.status === 'cancelled') audit.stale_file_count += 1;
      if (!audit.latest_exported_at || new Date(item.updated_at) > new Date(audit.latest_exported_at)) {
        audit.latest_exported_at = item.updated_at;
      }
      auditByChange.set(changeId, audit);
    }
    return rows.map(row => {
      const audit = auditByChange.get(Number(row.change_id)) || {
        exported_file_count:0,
        applied_file_count:0,
        stale_file_count:0,
        latest_exported_at:null
      };
      return {...row, ...audit, has_exported_file:audit.exported_file_count > 0};
    });
  }

  async function loadChangeQueue({status = 'active', source = 'all', batchId = null, limit = 250} = {}) {
    let query = db
      .from('operations_hub_change_queue')
      .select('change_id,change_batch_id,sellpia_sku_code,field_key,before_value,after_value,target_channels,status,requested_by,requested_at,processed_at,error_message,source_channel,seller_product_code,seller_option_code,validation_errors,validated_at,retry_count,max_retry_count,last_attempt_at,next_retry_at,cancelled_at,cancelled_by,status_message,updated_at', {count:'exact'})
      .order('updated_at', {ascending:false})
      .order('change_id', {ascending:false})
      .limit(Math.max(1, Math.min(Number(limit) || 250, 500)));
    if (status === 'active') query = query.in('status', ['pending','validated','failed']);
    else if (status !== 'all') query = query.eq('status', cleanText(status));
    if (source === 'operational') query = query.overlaps('target_channels', ['smartstore','ably']);
    else if (source !== 'all') query = query.contains('target_channels', [cleanText(source)]);
    if (cleanText(batchId)) query = query.eq('change_batch_id', cleanText(batchId));
    const {data, error, count} = await query;
    if (error) throw error;
    // The export receipt badge is optional metadata. If its lookup is delayed,
    // keep the bounded queue page usable, but never claim an unverified file
    // exists (the "confirm applied" action depends on that proof).
    try {
      return {rows:await attachChangeExportAudit(data || []), count:Number(count || 0), auditError:''};
    } catch (auditError) {
      console.warn('change queue export audit lookup failed', auditError);
      return {rows:data || [], count:Number(count || 0), auditError:auditError?.message || String(auditError)};
    }
  }

  async function loadChangeBatchSummaries({sources = ['smartstore','ably'], limit = 20} = {}) {
    const {data, error} = await db.rpc('list_operations_hub_change_batch_summaries_v1', {
      p_sources:[...new Set((sources || []).map(cleanText).filter(Boolean))],
      p_limit:Math.max(1, Math.min(Number(limit) || 20, 30))
    });
    if (error) throw error;
    return Array.isArray(data) ? data : [];
  }

  async function previewChangeTargetSafety({sources = ['smartstore','ably'], limit = 100} = {}) {
    const {data, error} = await db.rpc('preview_operations_hub_change_target_safety_v1', {
      p_sources:[...new Set((sources || []).map(cleanText).filter(Boolean))],
      p_limit:Math.max(1, Math.min(Number(limit) || 100, 500))
    });
    if (error) throw error;
    return Array.isArray(data) ? data : [];
  }

  async function loadChangeQueueStats(sources = []) {
    const selectedSources = [...new Set((sources || []).map(cleanText).filter(Boolean))];
    const statuses = ['pending','validated','failed','applied','saved','cancelled'];
    const counts = await Promise.all(statuses.map(async status => {
      let query = db
        .from('operations_hub_change_queue')
        .select('change_id', {count:'exact', head:true})
        .eq('status', status);
      if (selectedSources.length) query = query.overlaps('target_channels', selectedSources);
      const {error, count} = await query;
      if (error) throw error;
      return [status, Number(count || 0)];
    }));
    const result = Object.fromEntries(counts);
    result.active = result.pending + result.validated + result.failed;
    return result;
  }

  async function loadChangeEvents(changeId) {
    const {data, error} = await db
      .from('operations_hub_change_events')
      .select('event_id,change_id,change_batch_id,event_type,from_status,to_status,message,payload,actor,created_at')
      .eq('change_id', Number(changeId))
      .order('created_at', {ascending:false})
      .order('event_id', {ascending:false})
      .limit(100);
    if (error) throw error;
    return data || [];
  }

  async function loadRelationEdgeHistory({edgeId, limit = 20} = {}) {
    const {data, error} = await db.rpc('list_operations_hub_relation_edge_history_v1', {
      p_session_token:requireOperationsHubSessionToken(),
      p_edge_id:Number(edgeId),
      p_limit:Math.max(1, Math.min(Number(limit) || 20, 100))
    });
    if (error) throwOperationsHubRpcError(error);
    return data || {edgeId:Number(edgeId), events:[]};
  }

  async function undoRelationEdgeEvent(eventId) {
    const {data, error} = await db.rpc('undo_operations_hub_relation_edge_event_v1', {
      p_session_token:requireOperationsHubSessionToken(),
      p_event_id:Number(eventId)
    });
    if (error) throwOperationsHubRpcError(error);
    return data || null;
  }

  async function loadProductHistory(sku, {limit = 60} = {}) {
    const normalizedSku = cleanText(sku);
    if (!normalizedSku) return {changes:[], events:[], links:[]};
    const safeLimit = Math.max(10, Math.min(Number(limit) || 60, 100));
    const [changeResult, linkResult] = await Promise.all([
      db
        .from('operations_hub_change_queue')
        .select('change_id,change_batch_id,sellpia_sku_code,field_key,before_value,after_value,target_channels,status,requested_by,requested_at,processed_at,error_message,source_channel,seller_product_code,seller_option_code,validation_errors,validated_at,retry_count,status_message,updated_at')
        .eq('sellpia_sku_code', normalizedSku)
        .order('updated_at', {ascending:false})
        .order('change_id', {ascending:false})
        .limit(safeLimit),
      db
        .from('operations_hub_link_history')
        .select('link_event_id,sellpia_sku_code,source_channel,before_link,after_link,changed_by,changed_at')
        .eq('sellpia_sku_code', normalizedSku)
        .order('changed_at', {ascending:false})
        .order('link_event_id', {ascending:false})
        .limit(safeLimit)
    ]);
    if (changeResult.error) throw changeResult.error;
    if (linkResult.error) throw linkResult.error;
    const changes = changeResult.data || [];
    const changeIds = changes.map(item => Number(item.change_id)).filter(Number.isFinite);
    let events = [];
    if (changeIds.length) {
      const {data, error} = await db
        .from('operations_hub_change_events')
        .select('event_id,change_id,change_batch_id,event_type,from_status,to_status,message,payload,actor,created_at')
        .in('change_id', changeIds)
        .order('created_at', {ascending:false})
        .order('event_id', {ascending:false})
        .limit(Math.min(300, safeLimit * 5));
      if (error) throw error;
      events = data || [];
    }
    return {changes, events, links:linkResult.data || []};
  }

  async function validateChangeQueue(changeIds) {
    const {data, error} = await db.rpc('validate_operations_hub_changes', {p_change_ids:(changeIds || []).map(Number)});
    if (error) throw error;
    return Array.isArray(data) ? data[0] : data;
  }

  async function cancelChangeQueue(changeIds, reason = '사용자 취소') {
    const {data, error} = await db.rpc('cancel_operations_hub_changes', {
      p_change_ids:(changeIds || []).map(Number),
      p_reason:cleanText(reason) || '사용자 취소'
    });
    if (error) throw error;
    return Array.isArray(data) ? data[0] : data;
  }

  async function retryChangeQueue(changeIds) {
    const {data, error} = await db.rpc('retry_operations_hub_changes', {p_change_ids:(changeIds || []).map(Number)});
    if (error) throw error;
    return Array.isArray(data) ? data[0] : data;
  }

  async function saveSellerValueDraft({sku, source, fieldKey, after, batchId = null}) {
    if(cleanText(fieldKey)==='sellpia_sale_price'){
      const context=await loadCurrentPriceDecisions({source,skus:[sku]});
      const targets=context.groups.flatMap(group=>group.targets).filter(target=>(target.member_skus||[target.sku]).includes(sku));
      if(targets.length!==1)throw Error('가격 입력 대상이 여러 판매처 옵션에 연결되어 있습니다. 가격 셀에서 대상을 확인해주세요.');
      const price=targets[0].current_state?.price||targets[0].price;
      return saveSellerPriceDraft({sku,source,targetBasePrice:price.base,inputMode:'final',targetFinalPrice:Number(after),decisionContext:context,batchId});
    }
    const {data, error} = await db.rpc('save_operations_hub_seller_value_draft', {
      p_sku:cleanText(sku),
      p_source:cleanText(source),
      p_field_key:cleanText(fieldKey),
      p_after:Number(after),
      p_batch_id:batchId
    });
    if (error) throw error;
    return Array.isArray(data) ? data[0] : data;
  }

  async function loadPricePolicies() {
    const {data, error} = await db
      .from('operations_hub_price_policies')
      .select('source_channel,policy_name,is_active,base_field,replace_price,modify_type,modify_value,min_price,max_price,rounding_unit,rounding_mode,source_note,updated_by,updated_at')
      .order('source_channel', {ascending:true});
    if (error) throw error;
    return Object.fromEntries((data || []).map(policy => [policy.source_channel, policy]));
  }

  async function previewPricePolicy({sku, source}) {
    const {data, error} = await db.rpc('preview_operations_hub_price_policy', {
      p_sku:cleanText(sku),
      p_source:cleanText(source)
    });
    if (error) throw error;
    return Array.isArray(data) ? data[0] : data;
  }

  async function savePricePolicy({source, policyName, active, replacePrice, modifyType, modifyValue, minPrice, maxPrice, roundingUnit, roundingMode}) {
    const optionalNumber = value => value === '' || value === null || value === undefined ? null : Number(value);
    const {data, error} = await db.rpc('save_operations_hub_price_policy', {
      p_source:cleanText(source),
      p_policy_name:cleanText(policyName),
      p_is_active:Boolean(active),
      p_replace_price:optionalNumber(replacePrice),
      p_modify_type:cleanText(modifyType) || 'none',
      p_modify_value:Number(modifyValue || 0),
      p_min_price:optionalNumber(minPrice),
      p_max_price:optionalNumber(maxPrice),
      p_rounding_unit:Number(roundingUnit || 1),
      p_rounding_mode:cleanText(roundingMode) || 'nearest',
      p_updated_by:'operations-hub'
    });
    if (error) throw error;
    return Array.isArray(data) ? data[0] : data;
  }

  async function loadCurrentPriceDecisions({source,skus=[],signal=null}={}) {
    const codes=[...new Set(skus.map(cleanText).filter(Boolean))],rows=[],groups=new Map();
    if(!['smartstore','makeshop','ably'].includes(source))throw Error('가격 결정 판매처 오류');
    for(let offset=0;offset<codes.length;offset+=200){
      throwIfAborted(signal);
      const {data,error}=await db.rpc('hub_price_decision_read_v1',{p_session_token:requireOperationsHubSessionToken(),p_source:source,p_skus:codes.slice(offset,offset+200)});
      if(error)throw readableDatabaseError(error);
      if(!Array.isArray(data?.rows)||!Array.isArray(data?.groups))throw Error('현재 가격 응답 형식 오류');
      rows.push(...data.rows);
      for(const group of data.groups){
        const previous=groups.get(group.seller_product_code);
        if(previous&&JSON.stringify(previous)!==JSON.stringify(group))throw Error('현재 가격 조회 중 결정 또는 원본이 변경되었습니다. 다시 확인해주세요.');
        groups.set(group.seller_product_code,group);
      }
    }
    return {rows,groups:[...groups.values()]};
  }

  async function attachCurrentPriceDecisions(products,signal=null) {
    const codes=[...new Set(products.map(row=>cleanText(row.sellpia_sku_code)).filter(Boolean))],bySku=new Map();
    for(let offset=0;offset<codes.length;offset+=2000){
      throwIfAborted(signal);
      const {data,error}=await db.rpc('hub_price_decision_matrix_read_v1',{p_session_token:requireOperationsHubSessionToken(),p_skus:codes.slice(offset,offset+2000)});
      if(error)throw readableDatabaseError(error);
      if(!Array.isArray(data?.rows))throw Error('Matrix 현재 가격 응답 형식 오류');
      for(const row of data.rows){
        const sku=cleanText(row.sku||row.sellpia_sku_code);if(!bySku.has(sku))bySku.set(sku,{});
        (bySku.get(sku)[row.source_channel]??=[]).push(row);
      }
    }
    return products.map(product=>({...product,__priceDecisions:bySku.get(cleanText(product.sellpia_sku_code))||{}}));
  }

  async function applyPriceDecision({source,decisionSource,groups,manualActions=[],reason='',requestId=null,rollbackEventId=null}={}) {
    const body={source,decision_source:decisionSource,groups,reason};
    if(manualActions.length)body.manual_actions=manualActions;
    if(rollbackEventId!==null)body.rollback_event_id=rollbackEventId;
    const id=requestId||global.crypto.randomUUID();
    const {data,error}=await db.rpc('hub_price_decision_apply_v1',{p_session_token:requireOperationsHubSessionToken(),p_request_id:id,p_body:body});
    if(error)throw readableDatabaseError(error);
    if(!Array.isArray(data?.rows)||!Array.isArray(data?.items))throw Error('가격 결정 저장 응답 형식 오류');
    return {...data,items:data.items.map(item=>({...item,result:{...item.result,decision:data.rows.find(row=>(row.sku||row.sellpia_sku_code)===item.sku)}}))};
  }

  async function loadPriceDecisionHistory({source,productCode,limit=100}={}) {
    const {data,error}=await db.rpc('hub_price_decision_history_v1',{p_session_token:requireOperationsHubSessionToken(),p_source:source,p_product_code:productCode,p_limit:limit});
    if(error)throw readableDatabaseError(error);return data;
  }

  function priceDecisionGroups(context,productCode=null) {
    return context.groups.filter(group=>!productCode||group.seller_product_code===productCode).map(group=>({...group,expected_revision:group.revision,
      targets:group.targets.map(target=>({...target,price:target.current_state?.price||target.price,intent:{input_mode:'preserve'}}))}));
  }

  async function saveManualPriceDecision({source,skus,actions,productCode=null,decisionContext=null,requestId=null}) {
    const context=decisionContext||await loadCurrentPriceDecisions({source,skus});
    const groups=priceDecisionGroups(context,productCode);
    if(!groups.length)throw Error('최신 판매처 연결과 원본을 찾지 못했습니다.');
    return applyPriceDecision({source,decisionSource:'matrix_manual',groups,manualActions:actions,reason:'Matrix 가격 저장',requestId});
  }

  async function saveSellerPriceDraft({sku, source, targetBasePrice, inputMode = 'option', targetFinalPrice = null, optionPrice = null, optionPriceSource = 'original', basePriceSource = 'tag', priceRuleSetId = null, batchId = null,decisionContext=null,requestId=null,sellerProductCode=null,sellerOptionCode=null}) {
    const context=decisionContext||await loadCurrentPriceDecisions({source,skus:[sku]});
    const action={kind:'price',sku:cleanText(sku),seller_product_code:sellerProductCode,seller_option_code:sellerOptionCode,target_base_price:Number(targetBasePrice),input_mode:inputMode,option_price:optionPrice,target_final_price:targetFinalPrice,option_price_source:optionPriceSource,base_price_source:basePriceSource,price_rule_set_id:priceRuleSetId};
    const actions=[action];
    if(basePriceSource==='manual'&&inputMode==='option')for(const group of context.groups){
      if(sellerProductCode&&group.seller_product_code!==sellerProductCode)continue;
      if(!group.targets.some(target=>(target.member_skus||[target.sku]).includes(sku)))continue;
      if(group.targets.some(target=>(target.current_state?.price||target.price)?.base!==Number(targetBasePrice))){
        for(const target of group.targets)if(!(target.member_skus||[target.sku]).includes(sku))actions.push({...action,sku:target.sku,seller_product_code:group.seller_product_code,seller_option_code:target.seller_option_code,option_price:(target.current_state?.price||target.price).option,option_price_source:'original'});
      }
    }
    const result=await saveManualPriceDecision({source,skus:[sku],productCode:sellerProductCode,decisionContext:context,requestId:requestId||batchId,actions});
    return result.items.find(item=>item.sku===cleanText(sku))?.result;
  }

  async function saveProductLinkDraft({sku, source, productCode}) {
    const {data, error} = await db.rpc('save_operations_hub_product_link_draft', {
      p_sku:cleanText(sku),
      p_source:cleanText(source),
      p_product_code:cleanText(productCode)
    });
    if (error) throw error;
    return Array.isArray(data) ? data[0] : data;
  }

  async function clearProductLinkDraft({sku, source}) {
    const {data, error} = await db.rpc('clear_operations_hub_product_link_draft', {
      p_sku:cleanText(sku),
      p_source:cleanText(source)
    });
    if (error) throw error;
    return Boolean(data);
  }

  async function linkProductDraftOption({sku, source, optionCode = ''}) {
    const {data, error} = await db.rpc('link_operations_hub_product_link_draft_option', {
      p_sku:cleanText(sku),
      p_source:cleanText(source),
      p_option_code:cleanText(optionCode)
    });
    if (error) throw error;
    return Array.isArray(data) ? data[0] : data;
  }

  async function removeListingComponent({componentId = null, source, productCode, optionCode = '', sku} = {}) {
    const {data, error} = await db.rpc('disconnect_operations_hub_listing_component', {
      p_component_id:componentId ? Number(componentId) : null,
      p_source:cleanText(source),
      p_product_code:cleanText(productCode),
      p_option_code:cleanText(optionCode),
      p_sellpia_sku_code:cleanText(sku)
    });
    if (error) throw error;
    return Array.isArray(data) ? data[0] : data;
  }

  async function saveSellerDiscountDraft({sku,source,discountTerms=[],inputMode='option',targetFinalPrice=null,optionPrice=null,batchId=null,decisionContext=null,requestId=null,sellerProductCode=null,sellerOptionCode=null}) {
    const result=await saveManualPriceDecision({source,skus:[sku],decisionContext,requestId:requestId||batchId,
      actions:[{kind:'discount',sku:cleanText(sku),seller_product_code:sellerProductCode,seller_option_code:sellerOptionCode,discount_terms:discountTerms,input_mode:inputMode,option_price:optionPrice,target_final_price:targetFinalPrice}]});
    return result.items[0]?.result;
  }

  async function sellerProductPriceContext(source,productCode,decisionContext=null) {
    if(decisionContext)return decisionContext;
    const field={smartstore:'smartstore_product_code',makeshop:'makeshop_product_code',ably:'ably_product_code'}[source];
    if(!field||!productCode)throw Error('판매처와 상품코드를 확인해주세요.');
    const rows=[];
    for(let from=0;;from+=1000){
      const {data,error}=await db.from('operations_hub_matrix_cached').select('sellpia_sku_code').eq(field,productCode).range(from,from+999);
      if(error)throw readableDatabaseError(error);rows.push(...data||[]);if((data||[]).length<1000)break;
    }
    if(!rows.length)throw Error('같은 판매처 상품코드에 연결된 SKU를 찾지 못했습니다.');
    return loadCurrentPriceDecisions({source,skus:rows.map(row=>row.sellpia_sku_code)});
  }

  async function saveSellerProductDiscountDrafts({source,productCode,anchorSku=null,discountTerms=[],ruleCode=null,calculationMode='forward',decisionContext=null,requestId=null}) {
    const context=await sellerProductPriceContext(source,productCode,decisionContext),group=context.groups.find(group=>group.seller_product_code===productCode);
    if(!group)throw Error('최신 판매처 상품 연결을 찾지 못했습니다.');
    const actions=source!=='ably'?[{kind:'product_discount',product_code:productCode,anchor_sku:anchorSku,discount_terms:discountTerms,rule_code:ruleCode,calculation_mode:calculationMode}]
      :group.targets.map(target=>({kind:'discount',sku:target.sku,seller_product_code:productCode,seller_option_code:target.seller_option_code,discount_terms:discountTerms,input_mode:'option',option_price:(target.current_state?.price||target.price).option}));
    const result=await saveManualPriceDecision({source,skus:group.targets.map(target=>target.sku),actions,productCode,decisionContext:context,requestId});
    return {...result,count:result.items.length,batchId:result.request_id,atomic:true};
  }

  async function saveSellerProductBaseDrafts({source,productCode,targetBasePrice,basePriceSource='manual',decisionContext=null,requestId=null}) {
    const context=await sellerProductPriceContext(source,productCode,decisionContext),group=context.groups.find(group=>group.seller_product_code===productCode);
    if(!group)throw Error('최신 판매처 상품 연결을 찾지 못했습니다.');
    const actions=group.targets.map(target=>({kind:'price',sku:target.sku,seller_product_code:productCode,seller_option_code:target.seller_option_code,target_base_price:Number(targetBasePrice),input_mode:'option',
      option_price:(target.current_state?.price||target.price).option,option_price_source:'original',base_price_source:basePriceSource}));
    const result=await saveManualPriceDecision({source,skus:group.targets.map(target=>target.sku),actions,productCode,decisionContext:context,requestId});
    return {...result,source,productCode,savedCount:result.items.length};
  }

  async function loadPriceRuleTags() {
    const {data, error} = await db
      .from('operations_hub_price_rule_tags')
      .select('price_rule_tag_id,tag_code,tag_name,color,tag_role,discount_source_channel,discount_rule_code,replace_price,modify_type,modify_value,min_price,max_price,rounding_unit,rounding_mode,is_active,note,updated_at')
      .eq('is_active', true)
      .order('price_rule_tag_id', {ascending:true});
    if (error) throw error;
    return data || [];
  }

  async function loadPriceRuleSets() {
    const {data, error} = await db
      .from('operations_hub_price_rule_set_live')
      .select('price_rule_set_id,set_code,set_name,color,note,updated_at,tags')
      .order('price_rule_set_id', {ascending:true});
    if (error) throw error;
    return data || [];
  }

  async function loadInboundCostFormulaTags() {
    const {data, error} = await db
      .from('operations_hub_inbound_cost_formula_tags')
      .select('tag_id,tag_name,tag_color,multiply_value,divide_value,add_value,rounding_unit,rounding_mode,is_active,description,updated_at')
      .eq('is_active', true)
      .order('tag_id', {ascending:true});
    if (error) throw error;
    return data || [];
  }

  async function saveInboundCostFormulaTag({tagId = null, tagName, tagColor, multiplyValue = 1, divideValue = 1, addValue = 0, roundingUnit = 1, roundingMode = 'nearest', description = ''}) {
    const payload = {
      tag_name:cleanText(tagName),
      tag_color:cleanText(tagColor) || '#7c3aed',
      multiply_value:Number(multiplyValue || 1),
      divide_value:Number(divideValue || 1),
      add_value:Number(addValue || 0),
      rounding_unit:Number(roundingUnit || 1),
      rounding_mode:cleanText(roundingMode) || 'nearest',
      description:cleanText(description) || null,
      updated_at:new Date().toISOString()
    };
    const query = tagId
      ? db.from('operations_hub_inbound_cost_formula_tags').update(payload).eq('tag_id', Number(tagId))
      : db.from('operations_hub_inbound_cost_formula_tags').insert({...payload, created_by:'operations-hub'});
    const {data, error} = await query.select('tag_id,tag_name,tag_color,multiply_value,divide_value,add_value,rounding_unit,rounding_mode,is_active,description,updated_at').single();
    if (error) throw error;
    return data;
  }

  async function deleteInboundCostFormulaTag(tagId) {
    const {count, error:assignedError} = await db
      .from('operations_hub_inbound_cost_settings')
      .select('sellpia_sku_code', {count:'exact', head:true})
      .eq('formula_tag_id', Number(tagId));
    if (assignedError) throw assignedError;
    if (Number(count || 0) > 0) throw new Error(`이 수식태그를 사용 중인 SKU가 ${Number(count).toLocaleString('ko-KR')}개 있습니다. 먼저 상품에서 태그를 해제해주세요.`);
    const {error} = await db
      .from('operations_hub_inbound_cost_formula_tags')
      .update({is_active:false, updated_at:new Date().toISOString()})
      .eq('tag_id', Number(tagId));
    if (error) throw error;
    return {tagId:Number(tagId), assignedCount:0};
  }

  async function saveInboundCost({sku, manualCost = null, formulaTagId = null}) {
    const optionalNumber = value => value === '' || value === null || value === undefined ? null : Number(value);
    const {data, error} = await db.rpc('save_operations_hub_inbound_cost', {
      p_sellpia_sku_code:cleanText(sku),
      p_manual_cost:optionalNumber(manualCost),
      p_formula_tag_id:formulaTagId ? Number(formulaTagId) : null,
      p_actor:'operations-hub'
    });
    if (error) throw error;
    return data || {};
  }

  async function loadInboundCostTagSkus(tagId) {
    const rows=[];
    for(let from=0;;from+=1000){
      const {data,error}=await db.from('operations_hub_inbound_cost_settings').select('sellpia_sku_code').eq('formula_tag_id',Number(tagId)).range(from,from+999);
      if(error)throw error;
      rows.push(...(data||[]));
      if((data||[]).length<1000)break;
    }
    return [...new Set(rows.map(row=>cleanText(row.sellpia_sku_code)).filter(Boolean))];
  }

  async function savePriceRuleTag({tagId = null, tagName, color, tagRole = 'price', discountSource = null, discountRuleCode = null, replacePrice, modifyType, modifyValue, minPrice, maxPrice, roundingUnit, roundingMode, note = ''}) {
    const optionalNumber = value => value === '' || value === null || value === undefined ? null : Number(value);
    const {data, error} = await db.rpc('save_operations_hub_price_rule_tag', {
      p_tag_id:tagId ? Number(tagId) : null,
      p_tag_name:cleanText(tagName),
      p_color:cleanText(color) || '#2f6fd1',
      p_replace_price:optionalNumber(replacePrice),
      p_modify_type:cleanText(modifyType) || 'none',
      p_modify_value:Number(modifyValue || 0),
      p_min_price:optionalNumber(minPrice),
      p_max_price:optionalNumber(maxPrice),
      p_rounding_unit:Number(roundingUnit || 1),
      p_rounding_mode:cleanText(roundingMode) || 'nearest',
      p_note:cleanText(note) || null,
      p_tag_role:cleanText(tagRole) || 'price',
      p_discount_source_channel:cleanText(discountSource) || null,
      p_discount_rule_code:cleanText(discountRuleCode) || null
    });
    if (error) throw error;
    return Array.isArray(data) ? data[0] : data;
  }

  async function savePriceRuleSet({ruleSetId = null, setName, color, tagIds = [], note = ''}) {
    const {data, error} = await db.rpc('save_operations_hub_price_rule_set', {
      p_rule_set_id:ruleSetId ? Number(ruleSetId) : null,
      p_set_name:cleanText(setName),
      p_color:cleanText(color) || '#1558c0',
      p_tag_ids:(tagIds || []).map(Number),
      p_note:cleanText(note) || null
    });
    if (error) throw error;
    return Array.isArray(data) ? data[0] : data;
  }

  async function deletePriceRuleTag(tagId) {
    const {data, error} = await db.rpc('delete_operations_hub_price_rule_tag', {
      p_tag_id:Number(tagId),
      p_updated_by:'operations-hub'
    });
    if (error) throw error;
    return Array.isArray(data) ? data[0] : data;
  }

  async function deletePriceRuleSet(ruleSetId) {
    const {data, error} = await db.rpc('delete_operations_hub_price_rule_set', {
      p_rule_set_id:Number(ruleSetId),
      p_updated_by:'operations-hub'
    });
    if (error) throw error;
    return Array.isArray(data) ? data[0] : data;
  }

  async function loadPriceRuleAssignment({sku, source}) {
    const {data, error} = await db
      .from('operations_hub_price_rule_assignments')
      .select('price_rule_assignment_id,source_channel,target_type,sellpia_sku_code,price_rule_set_id,is_active,updated_at')
      .eq('target_type', 'sellpia_sku')
      .eq('sellpia_sku_code', cleanText(sku))
      .eq('source_channel', cleanText(source))
      .eq('is_active', true)
      .maybeSingle();
    if (error) throw error;
    return data || null;
  }

  async function previewPriceRuleSet({basePrice, ruleSetId, source = null, sourceDiscountTerms = []}) {
    if (!ruleSetId) return {final_price:null, steps:[]};
    if (basePrice === null || basePrice === undefined || basePrice === '' || !Number.isFinite(Number(basePrice))) {
      throw new Error('시스템 기준가격을 먼저 저장해주세요.');
    }
    const {data, error} = source
      ? await db.rpc('calculate_operations_hub_price_rule_plan', {
        p_base_price:Number(basePrice),
        p_rule_set_id:Number(ruleSetId),
        p_source:cleanText(source),
        p_source_discount_terms:Array.isArray(sourceDiscountTerms) ? sourceDiscountTerms : []
      })
      : await db.rpc('calculate_operations_hub_price_rule_set', {
        p_base_price:Number(basePrice),
        p_rule_set_id:Number(ruleSetId)
      });
    if (error) throw error;
    const result = Array.isArray(data) ? data[0] : data;
    if (!source || !result) return result;
    return {
      ...result,
      final_price:result.gross_price,
      steps:[...(result.price_steps || []), ...(result.discount_steps || [])]
    };
  }

  async function loadRelationFolders() {
    const {data, error} = await db.rpc('list_operations_hub_relation_folders_v2');
    if (error) throw error;
    return {
      folders:Array.isArray(data?.folders) ? data.folders : [],
      organizedCount:Number(data?.organizedCount || 0),
      unorganizedExplicitCount:Number(data?.unorganizedExplicitCount || 0)
    };
  }

  async function saveRelationFolder({folderId = null, name, kind = 'custom', sortOrder = 100, parentFolderId = null} = {}) {
    const {data, error} = await db.rpc('save_operations_hub_relation_folder_v2', {
      p_folder_id:folderId === null || folderId === '' ? null : Number(folderId),
      p_folder_name:cleanText(name),
      p_folder_kind:cleanText(kind) || 'custom',
      p_sort_order:Math.max(0, Math.min(Math.trunc(Number(sortOrder) || 100), 10000)),
      p_parent_folder_id:parentFolderId === null || parentFolderId === '' ? null : Number(parentFolderId)
    });
    if (error) throw error;
    return Array.isArray(data) ? data[0] : data;
  }

  async function archiveRelationFolder(folderId) {
    const {data, error} = await db.rpc('archive_operations_hub_relation_folder_v2', {p_folder_id:Number(folderId)});
    if (error) throw error;
    return data || {unassignedListings:0, unassignedNodes:0};
  }

  async function searchSellpiaRelationProducts(search = '', limit = 20) {
    const {data, error} = await db.rpc('search_operations_hub_sellpia_product_groups', {
      p_search:cleanText(search),
      p_limit:Math.max(1, Math.min(Number(limit) || 20, 50))
    });
    if (error) throw error;
    return {
      groups:Array.isArray(data?.groups) ? data.groups : [],
      matchedCount:Number(data?.matchedCount || 0)
    };
  }

  async function loadSellpiaRelationProduct(productCode) {
    const {data, error} = await db.rpc('get_operations_hub_sellpia_product_group', {
      p_product_code:cleanText(productCode)
    });
    if (error) throw error;
    return data || null;
  }

  async function loadSellpiaRelationVisuals(skus = []) {
    const normalizedSkus = [...new Set((Array.isArray(skus) ? skus : []).map(cleanText).filter(Boolean))];
    if (!normalizedSkus.length) return [];
    const rows = [];
    for (let offset = 0; offset < normalizedSkus.length; offset += 500) {
      const {data, error} = await db
        .from(MATRIX_VIEW)
        .select('sellpia_sku_code,sellpia_product_name,sellpia_option_name,image_url,sellpia_override_image_url')
        .in('sellpia_sku_code', normalizedSkus.slice(offset, offset + 500));
      if (error) throw error;
      rows.push(...(data || []));
    }
    return rows;
  }

  async function ensureSellpiaRelationNode({productCode, folderId = null, relationKind = 'individual'} = {}) {
    const {data, error} = await db.rpc('ensure_operations_hub_sellpia_relation_node', {
      p_sellpia_product_code:cleanText(productCode),
      p_folder_id:folderId === null || folderId === '' ? null : Number(folderId),
      p_relation_kind:cleanText(relationKind) || 'individual'
    });
    if (error) throw error;
    return data;
  }

  async function ensureSellpiaSkuRelationNode({sku, folderId = null, relationKind = 'individual'} = {}) {
    const {data, error} = await db.rpc('ensure_operations_hub_sellpia_sku_relation_node', {
      p_sellpia_sku_code:cleanText(sku),
      p_folder_id:folderId === null || folderId === '' ? null : Number(folderId),
      p_relation_kind:cleanText(relationKind) || 'individual'
    });
    if (error) throw error;
    return data;
  }

  async function ensureSellerRelationNode({source, productCode, optionCode = '', folderId = null, relationKind = 'custom'} = {}) {
    const {data, error} = await db.rpc('ensure_operations_hub_seller_relation_node', {
      p_source:cleanText(source),
      p_product_code:cleanText(productCode),
      p_option_code:cleanText(optionCode),
      p_folder_id:folderId === null || folderId === '' ? null : Number(folderId),
      p_relation_kind:cleanText(relationKind) || 'custom'
    });
    if (error) throw error;
    return data;
  }

  async function loadRelationNodes({search = '', folderId = null, limit = 500} = {}) {
    const {data, error} = await db.rpc('list_operations_hub_relation_nodes', {
      p_search:cleanText(search),
      p_folder_id:folderId === null || folderId === '' ? null : Number(folderId),
      p_limit:Math.max(1, Math.min(Number(limit) || 500, 1000))
    });
    if (error) throw error;
    return {
      nodes:Array.isArray(data?.nodes) ? data.nodes : [],
      edges:Array.isArray(data?.edges) ? data.edges : []
    };
  }

  async function saveRelationEdge({parentNodeId, childNodeId, sortOrder = 100} = {}) {
    const {data, error} = await db.rpc('save_operations_hub_relation_edge', {
      p_parent_node_id:Number(parentNodeId),
      p_child_node_id:Number(childNodeId),
      p_sort_order:Math.max(0, Math.min(Number(sortOrder) || 100, 10000))
    });
    if (error) throw error;
    return data;
  }

  async function updateRelationEdge({edgeId, parentNodeId, childNodeId, sortOrder = 100} = {}) {
    const {data, error} = await db.rpc('update_operations_hub_relation_edge_v1', {
      p_session_token:requireOperationsHubSessionToken(),
      p_edge_id:Number(edgeId),
      p_parent_node_id:Number(parentNodeId),
      p_child_node_id:Number(childNodeId),
      p_sort_order:Math.max(0, Math.min(Number(sortOrder) || 100, 10000))
    });
    if (error) throwOperationsHubRpcError(error);
    return data;
  }

  async function removeRelationEdge(edgeId) {
    const {data, error} = await db.rpc('remove_operations_hub_relation_edge', {
      p_edge_id:Number(edgeId)
    });
    if (error) throw error;
    return data;
  }

  async function savePriceBasisSelection({sellpiaProductCode, basisSkuCode = null} = {}) {
    const {data, error} = await db.rpc('save_operations_hub_price_basis_v1', {
      p_session_token:requireOperationsHubSessionToken(),
      p_sellpia_product_code:cleanText(sellpiaProductCode),
      p_basis_sku_code:cleanText(basisSkuCode) || null
    });
    if (error) throwOperationsHubRpcError(error);
    return data || null;
  }

  async function archiveRelationNode(nodeId) {
    const {data, error} = await db.rpc('archive_operations_hub_relation_node', {
      p_node_id:Number(nodeId)
    });
    if (error) throw error;
    return data;
  }

  async function applyRelationBoard({nodes = [], edges = [], removeEdgeIds = []} = {}) {
    const {data, error} = await db.rpc('apply_operations_hub_relation_board', {
      p_nodes:Array.isArray(nodes) ? nodes : [],
      p_edges:Array.isArray(edges) ? edges : [],
      p_remove_edge_ids:[...new Set((removeEdgeIds || []).map(Number).filter(Number.isFinite))]
    });
    if (error) throw error;
    return data || null;
  }

  async function saveListingOrganization({source, productCode, optionCode = '', folderId = null, relationKind = null, groupName = null} = {}) {
    const {data, error} = await db.rpc('save_operations_hub_listing_organization', {
      p_source:cleanText(source),
      p_product_code:cleanText(productCode),
      p_option_code:cleanText(optionCode),
      p_folder_id:folderId === null || folderId === '' ? null : Number(folderId),
      p_relation_kind:cleanText(relationKind) || null,
      p_group_name:cleanText(groupName) || null
    });
    if (error) throw error;
    return data;
  }

  async function saveListingComponentParent({componentId, parentComponentId = null} = {}) {
    const {data, error} = await db.rpc('save_operations_hub_listing_component_parent', {
      p_component_id:Number(componentId),
      p_parent_component_id:parentComponentId === null || parentComponentId === '' ? null : Number(parentComponentId)
    });
    if (error) throw error;
    return data;
  }

  async function savePriceRuleAssignment({sku, source, ruleSetId = null}) {
    const {data, error} = await db.rpc('save_operations_hub_price_rule_assignment', {
      p_sku:cleanText(sku),
      p_source:cleanText(source),
      p_rule_set_id:ruleSetId ? Number(ruleSetId) : null,
      p_updated_by:'operations-hub'
    });
    if (error) throw error;
    return Array.isArray(data) ? (data[0] || null) : data;
  }

  async function savePriceRuleAssignmentsBulk({skus = [], sources = [], ruleSetId = null}) {
    const {data, error} = await db.rpc('save_operations_hub_price_rule_assignments_bulk', {
      p_skus:[...new Set((skus || []).map(cleanText).filter(Boolean))].slice(0, 500),
      p_sources:[...new Set((sources || []).map(cleanText).filter(Boolean))],
      p_rule_set_id:ruleSetId ? Number(ruleSetId) : null,
      p_updated_by:'operations-hub'
    });
    if (error) throw error;
    return data || {};
  }

  async function stageAssignedPriceDraftsBulk({skus = [], sources = [], batchId = null}) {
    const {data, error} = await db.rpc('stage_operations_hub_assigned_price_drafts_bulk', {
      p_skus:[...new Set((skus || []).map(cleanText).filter(Boolean))].slice(0, 100),
      p_sources:[...new Set((sources || []).map(cleanText).filter(Boolean))],
      p_batch_id:batchId
    });
    if (error) throw error;
    return data || {};
  }

  async function stageSellerInventoryDrafts({sources = [], skus = [], batchId = null} = {}) {
    const {data, error} = await db.rpc('stage_operations_hub_seller_inventory_match', {
      p_session_token:requireOperationsHubSessionToken(),
      p_sources:(sources || []).map(cleanText),
      p_skus:(skus || []).map(cleanText),
      p_batch_id:batchId
    });
    if (error) throw error;
    return Array.isArray(data) ? data[0] : data;
  }

  function isTransientDbError(error) {
    const code=String(error?.code||'').toUpperCase();
    const message=String(error?.message||error||'').toLowerCase();
    if(['57014','55P03','40001','40P01','PGRST003'].includes(code))return true;
    return /timeout|timed out|fetch failed|network|connection reset|connection closed|failed to fetch|temporarily unavailable|gateway|502|503|504/.test(message);
  }

  async function withTransientDbRetry(task,{attempts=4,onRetry=null}={}) {
    const delays=[1200,3500,8000];
    let lastError=null;
    for(let attempt=1;attempt<=Math.max(1,attempts);attempt+=1){
      try{return await task(attempt);}
      catch(error){
        lastError=error;
        if(attempt>=attempts||!isTransientDbError(error))throw error;
        const delay=delays[Math.min(attempt-1,delays.length-1)];
        onRetry?.({attempt,nextAttempt:attempt+1,delay,error});
        await new Promise(resolve=>setTimeout(resolve,delay));
      }
    }
    throw lastError;
  }

  async function stageSellerInventoryDraftBatch({sources = [], skus = [], batchId = null, afterSku = null, batchSize = 100, overwriteBlank = false, onRetry = null} = {}) {
    return withTransientDbRetry(async()=>{
      const {data, error} = await db.rpc('stage_operations_hub_seller_inventory_match_batch_v2', {
        p_session_token:requireOperationsHubSessionToken(),
        p_sources:(sources || []).map(cleanText),
        p_skus:(skus || []).map(cleanText),
        p_batch_id:batchId,
        p_after_sku:afterSku,
        p_batch_size:Math.max(25, Math.min(Number(batchSize) || 100, 500)),
        p_overwrite_blank:!!overwriteBlank
      });
      if (error) throw error;
      return Array.isArray(data) ? data[0] : data;
    },{attempts:4,onRetry});
  }

  async function beginReliableExportJob({source,skus=[],includeStock=false,overwriteBlank=false}={}) {
    return withTransientDbRetry(async()=>{
      const {data,error}=await db.rpc('hub_export_job_begin_v1',{
        p_session_token:requireOperationsHubSessionToken(),
        p_source_channel:cleanText(source),
        p_skus:[...new Set((skus||[]).map(cleanText).filter(Boolean))],
        p_include_stock:!!includeStock,
        p_overwrite_blank:!!overwriteBlank
      });
      if(error)throw readableDatabaseError(error);
      return data||{};
    });
  }

  async function checkpointReliableExportJob({jobId,status,phase,processedCount=null,totalCount=null,stagedCount=null,blankPreservedCount=null,blankOverwriteCount=null,afterCursor=null,changeBatchId=null,lastError=null}={}) {
    if(!jobId)throw new Error('저장할 내보내기 작업 ID가 없습니다.');
    return withTransientDbRetry(async()=>{
      const {data,error}=await db.rpc('hub_export_job_checkpoint_v1',{
        p_session_token:requireOperationsHubSessionToken(),
        p_job_id:jobId,
        p_status:cleanText(status),
        p_phase:cleanText(phase),
        p_processed_count:processedCount,
        p_total_count:totalCount,
        p_staged_count:stagedCount,
        p_blank_preserved_count:blankPreservedCount,
        p_blank_overwrite_count:blankOverwriteCount,
        p_after_cursor:afterCursor,
        p_change_batch_id:changeBatchId,
        p_last_error:lastError==null?null:String(lastError).slice(0,1800)
      });
      if(error)throw readableDatabaseError(error);
      return data||{};
    });
  }

  async function getReliableExportJob({jobId=null,source=null}={}) {
    return withTransientDbRetry(async()=>{
      const {data,error}=await db.rpc('hub_export_job_get_v1',{
        p_session_token:requireOperationsHubSessionToken(),
        p_job_id:jobId||null,
        p_source_channel:source?cleanText(source):null
      });
      if(error)throw readableDatabaseError(error);
      return data||null;
    });
  }

  async function countSellerDraftsForExport(sources = [], skus = null) {
    const selectedSources = [...new Set((sources || []).map(cleanText).filter(Boolean))];
    const selectedSkus = Array.isArray(skus) ? [...new Set(skus.map(cleanText).filter(Boolean))] : null;
    if (!selectedSources.length || selectedSkus && !selectedSkus.length) return 0;
    const batches = selectedSkus ? Array.from({length:Math.ceil(selectedSkus.length / 200)}, (_, index) => selectedSkus.slice(index * 200, index * 200 + 200)) : [null];
    let total = 0;
    for (const skuBatch of batches) {
      let query = db.from('operations_hub_change_queue').select('change_id', {count:'exact', head:true})
        .in('source_channel', selectedSources).in('status', ['pending','validated','failed']).limit(0);
      if (skuBatch) query = query.in('sellpia_sku_code', skuBatch);
      const {count, error} = await query;
      if (error) throw error;
      if (!Number.isSafeInteger(count) || count < 0) throw new Error('수정안 개수를 확인하지 못했습니다. 다시 시도해주세요.');
      total += count;
    }
    return total;
  }

  async function loadSellerDraftRows({sources = [], skus = null} = {}) {
    const ss=[...new Set((sources||[]).map(cleanText).filter(Boolean))];
    const ks=Array.isArray(skus)?[...new Set(skus.map(cleanText).filter(Boolean))]:null;
    if(!ss.length||(ks&&!ks.length))return [];
    const fields='change_id,source_channel,sellpia_sku_code,status,field_key,seller_product_code,seller_option_code,target_channels,target_component_skus,target_safety_state,target_safety_details,error_message,validation_errors';
    const rows=[], batches=ks?Array.from({length:Math.ceil(ks.length/200)},(_,i)=>ks.slice(i*200,i*200+200)):[null];
    for(const batch of batches)for(let from=0;;from+=1000){
      let q=db.from('operations_hub_change_queue').select(fields).in('status',['pending','validated','failed']).in('source_channel',ss).order('change_id',{ascending:true}).range(from,from+999);
      if(batch)q=q.in('sellpia_sku_code',batch);
      const {data,error}=await q;if(error)throw readableDatabaseError(error);
      rows.push(...(data||[]));if(!data||data.length<1000)break;
    }
    return rows.sort((left,right)=>Number(left.change_id||0)-Number(right.change_id||0));
  }

  async function validateSellerDraftsForExport(sources = [], skus = null) {
    return (await reviewSellerDraftsForExport({sources, skus})).changeIds;
  }

  function sellerExportExclusionReason(row) {
    if (row.target_safety_state === 'conflict') return '재고 충돌: 연결된 구성 SKU가 서로 다른 수정값을 제안합니다. 연결·세트 구성을 확인해주세요.';
    if (row.target_safety_state === 'incomplete') {
      const detail = row.target_safety_details || {};
      if (Number(detail.knownStockCount) < Number(detail.componentCount)) return '구성 SKU 재고 누락: 계산에 필요한 모든 셀피아 재고를 확인할 수 없습니다.';
      return '판매처 원본 재고 확인 불가: 연결된 상품·옵션코드가 최신 원본에 있는지 확인해주세요.';
    }
    if (row.source_channel && row.target_safety_state !== 'ready') return '내보내기 안전검사 상태를 확인할 수 없습니다.';
    if (row.source_channel && !cleanText(row.seller_product_code)) return '판매처 상품코드 누락: 최신 원본 연결을 확인한 뒤 수정안을 다시 생성해주세요.';
    if (!['pending','validated','failed'].includes(row.status)) return '수정안 상태가 바뀌었습니다. 최신 수정안을 다시 확인해주세요.';
    return '';
  }

  async function reviewSellerDraftsForExport({sources = [], skus = null, changeIds = null, onProgress = null} = {}) {
    const readSelected = async ids => {
      const result = [];
      for (let offset = 0; offset < ids.length; offset += 100) {
        const {data, error} = await db.from('operations_hub_change_queue')
          .select('change_id,source_channel,sellpia_sku_code,status,field_key,seller_product_code,seller_option_code,target_channels,target_component_skus,target_safety_state,target_safety_details,error_message,validation_errors')
          .in('change_id', ids.slice(offset, offset + 100)).order('change_id', {ascending:true});
        if (error) throw error;
        result.push(...(data || []));
      }
      return result;
    };
    const selectedIds = Array.isArray(changeIds) ? [...new Set(changeIds.map(Number))] : null;
    const rows = selectedIds ? await readSelected(selectedIds) : await loadSellerDraftRows({sources, skus});
    const inScope = row => row.source_channel ? sources.includes(row.source_channel) : (row.target_channels || []).some(source => sources.includes(source));
    const candidates = rows.filter(row => inScope(row) && !sellerExportExclusionReason(row) && ['pending','failed'].includes(row.status));
    for (let offset = 0; offset < candidates.length; offset += 50) {
      await validateChangeQueue(candidates.slice(offset, offset + 50).map(row => Number(row.change_id)));
      onProgress?.(Math.min(offset+50,candidates.length),candidates.length);
    }
    // Re-read the same IDs so a new run, another operator, or a failed validation
    // cannot silently expand the export scope.
    const ids = selectedIds || rows.map(row => Number(row.change_id));
    const fresh = new Map((await readSelected(ids)).map(row => [Number(row.change_id), row]));
    const originals = new Map(rows.map(row => [Number(row.change_id), row]));
    const eligible = [], excluded = [];
    for (const id of ids) {
      const row = fresh.get(id);
      const reason = !row ? '수정안을 찾을 수 없거나 조회 권한이 변경되었습니다.'
        : !inScope(row) ? '선택한 판매처 범위 밖의 수정안입니다.'
        : sellerExportExclusionReason(row) || (row.status !== 'validated' ? row.error_message || (row.validation_errors || []).join(' · ') || '수정안 검증을 통과하지 못했습니다.' : '');
      if (reason) excluded.push({item:row || originals.get(id) || {change_id:id}, reason});
      else eligible.push(id);
    }
    return {changeIds:eligible, excluded};
  }

  async function loadLatestSellerOriginalStatusDirect(sources = ['smartstore','makeshop','ably']) {
    const selectedSources = (sources || []).map(cleanText).filter(Boolean);
    const {data, error} = await db
      .from('seller_inventory_snapshots')
      .select('snapshot_id,source_channel,source_file_names,source_storage_files,source_file_size,completed_at,created_at')
      .eq('upload_status', 'ready')
      .in('source_channel', selectedSources)
      .order('completed_at', {ascending:false, nullsFirst:false})
      .order('created_at', {ascending:false})
      .limit(50);
    if (error) throw error;
    const latest = new Map();
    for (const row of data || []) if (!latest.has(row.source_channel)) latest.set(row.source_channel, row);
    return selectedSources.map(source => {
      const snapshot = latest.get(source);
      const files = Array.isArray(snapshot?.source_storage_files) ? snapshot.source_storage_files : [];
      return {
        source,
        snapshotId:snapshot?.snapshot_id || null,
        completedAt:snapshot?.completed_at || snapshot?.created_at || null,
        files,
        fileNames:Array.isArray(snapshot?.source_file_names) ? snapshot.source_file_names : [],
        available:Boolean(snapshot && files.length)
      };
    });
  }

  async function loadLatestSellerOriginalStatus(sources = ['smartstore','makeshop','ably']) {
    const selectedSources=(sources||[]).map(cleanText).filter(Boolean);
    try{
      const rows=await Promise.all(selectedSources.map(source=>originalBoundaryRequest('read-manifest',{kind:'seller',source,include_urls:false})));
      recordOriginalBoundaryDiagnostic('secure-read-ok',{sources:selectedSources.join(','),count:rows.length});
      return rows.map(row=>({source:row.source,snapshotId:row.snapshot_id||null,completedAt:row.completed_at||null,files:Array.isArray(row.files)?row.files:[],fileNames:(row.files||[]).map(file=>file.name),available:Boolean(row.available),boundary:'signed-read-v1',reason:row.reason||''}));
    }catch(error){
      if(error?.operationsHubAuthRequired)throw error;
      recordOriginalBoundaryDiagnostic('secure-read-fallback',{sources:selectedSources.join(','),message:String(error?.message||error)});
      const rows=await loadLatestSellerOriginalStatusDirect(selectedSources);
      return rows.map(row=>({...row,boundary:'direct-anon-fallback'}));
    }
  }

  async function downloadLatestSellerOriginalsDirect(sources = [], onProgress) {
    const statuses = await loadLatestSellerOriginalStatusDirect(sources);
    const missing = statuses.filter(status => !status.available);
    if (missing.length) throw new Error(`${missing.map(status => status.source).join(', ')} 최신 원본 파일이 시스템에 보관되어 있지 않습니다.`);
    const filesBySource = new Map();
    const allFiles = statuses.flatMap(status => status.files.map(file => ({...file, source:status.source})));
    let completed = 0;
    for (const status of statuses) {
      const files = [];
      for (const storedFile of status.files) {
        onProgress?.({completed, total:allFiles.length, source:status.source, name:storedFile.name});
        const {data:blob, error} = await db.storage.from('seller-originals').download(storedFile.path);
        if (error) throw error;
        files.push(new File([blob], storedFile.name, {type:storedFile.type || blob.type || 'application/octet-stream'}));
        completed += 1;
      }
      filesBySource.set(status.source, files);
    }
    onProgress?.({completed, total:allFiles.length});
    return filesBySource;
  }

  async function downloadLatestSellerOriginals(sources = [], onProgress) {
    const selectedSources=(sources||[]).map(cleanText).filter(Boolean);
    try{
      const filesBySource=new Map();let completed=0;
      for(const source of selectedSources){
        const manifest=await originalBoundaryRequest('read-manifest',{kind:'seller',source,include_urls:true});
        if(!manifest.available)throw new Error(manifest.reason||`${source} 최신 원본 파일이 시스템에 보관되어 있지 않습니다.`);
        const files=await downloadSignedFiles(manifest.files,progress=>onProgress?.({...progress,completed:completed+Number(progress.completed||0),total:selectedSources.length}),source);
        completed+=files.length;filesBySource.set(source,files);
      }
      recordOriginalBoundaryDiagnostic('secure-download-ok',{sources:selectedSources.join(','),files:completed});
      return filesBySource;
    }catch(error){
      if(error?.operationsHubAuthRequired)throw error;
      recordOriginalBoundaryDiagnostic('secure-download-fallback',{sources:selectedSources.join(','),message:String(error?.message||error)});
      return downloadLatestSellerOriginalsDirect(selectedSources,onProgress);
    }
  }

  async function loadLatestSellpiaOriginalStatusDirect() {
    const {data,error}=await db
      .from('sellpia_stock_snapshots')
      .select('snapshot_id,source_file_name,source_file_size,metadata,completed_at,created_at')
      .eq('upload_status','ready')
      .order('completed_at',{ascending:false,nullsFirst:false})
      .order('created_at',{ascending:false})
      .order('snapshot_id',{ascending:false})
      .limit(1);
    if(error)throw error;
    const latest=(data||[])[0]||null;
    let snapshot=latest;
    const visited=new Set();
    for(let depth=0;snapshot;depth++){
      if(depth>=256||visited.has(snapshot.snapshot_id))throw Error('Sellpia 원본 carrier 계보가 손상되었거나 너무 깁니다.');
      visited.add(snapshot.snapshot_id);
      const mode=cleanText(snapshot.metadata?.upload_mode||'full').toLowerCase();
      if(mode==='full')break;
      if(!['patch','inventory_count'].includes(mode))throw Error('지원하지 않는 Sellpia 원본 snapshot 종류입니다.');
      const parentId=cleanText(snapshot.metadata?.base_snapshot_id);
      if(!parentId||visited.has(parentId))throw Error('Sellpia 원본 carrier 계보가 불완전합니다.');
      const {data:parent,error:parentError}=await db.from('sellpia_stock_snapshots')
        .select('snapshot_id,source_file_name,source_file_size,metadata,completed_at,created_at')
        .eq('snapshot_id',parentId).eq('upload_status','ready').maybeSingle();
      if(parentError)throw parentError;
      if(!parent)throw Error('Sellpia 부분 갱신의 기준 원본을 찾지 못했습니다.');
      snapshot=parent;
    }
    const files=Array.isArray(snapshot?.metadata?.source_storage_files)?snapshot.metadata.source_storage_files:[];
    const paths=files.map(file=>cleanText(file.path));
    const validFiles=files.length===3&&new Set(paths).size===3&&paths.every(path=>path.startsWith(`sellpia/${snapshot.snapshot_id}/`));
    return {
      snapshotId:snapshot?.snapshot_id||null,
      stateSnapshotId:latest?.snapshot_id||null,
      completedAt:snapshot?.completed_at||snapshot?.created_at||null,
      fileNames:files.length?files.map(file=>file.name):cleanText(snapshot?.source_file_name).split(' | ').filter(Boolean),
      files,
      available:Boolean(snapshot&&validFiles),
      reason:!snapshot?'ready 상태의 Sellpia 전체 원본이 없습니다.'
        :validFiles?'':'Sellpia 전체 원본 carrier 3개가 보관되지 않았습니다.'
    };
  }

  async function loadLatestSellpiaOriginalStatus() {
    try{
      const row=await originalBoundaryRequest('read-manifest',{kind:'sellpia',include_urls:false});
      recordOriginalBoundaryDiagnostic('secure-read-ok',{sources:'sellpia',count:Number(row?.files?.length||0)});
      return {snapshotId:row.snapshot_id||null,stateSnapshotId:row.state_snapshot_id||null,completedAt:row.completed_at||null,fileNames:(row.files||[]).map(file=>file.name),files:row.files||[],available:Boolean(row.available),reason:row.reason||'',boundary:'signed-read-v1'};
    }catch(error){
      if(error?.operationsHubAuthRequired)throw error;
      recordOriginalBoundaryDiagnostic('secure-read-fallback',{sources:'sellpia',message:String(error?.message||error)});
      return {...await loadLatestSellpiaOriginalStatusDirect(),boundary:'direct-anon-fallback'};
    }
  }

  async function downloadLatestSellpiaOriginalsDirect(onProgress) {
    const status=await loadLatestSellpiaOriginalStatusDirect();
    if(!status.available)throw new Error(status.reason||'최신 Sellpia 전체 원본 carrier가 없습니다.');
    const files=[];
    for(let index=0;index<status.files.length;index++){
      const stored=status.files[index];
      onProgress?.({completed:index,total:status.files.length,name:stored.name});
      const {data:blob,error}=await db.storage.from('seller-originals').download(stored.path);
      if(error)throw error;
      files.push(new File([blob],stored.name,{type:stored.type||blob.type||'application/octet-stream'}));
    }
    onProgress?.({completed:files.length,total:files.length});
    return {snapshotId:status.snapshotId,stateSnapshotId:status.stateSnapshotId,completedAt:status.completedAt,files};
  }

  async function downloadLatestSellpiaOriginals(onProgress) {
    try{
      const manifest=await originalBoundaryRequest('read-manifest',{kind:'sellpia',include_urls:true});
      if(!manifest.available)throw new Error(manifest.reason||'최신 Sellpia 전체 원본 carrier가 없습니다.');
      const files=await downloadSignedFiles(manifest.files,onProgress,'sellpia');
      recordOriginalBoundaryDiagnostic('secure-download-ok',{sources:'sellpia',files:files.length});
      return {snapshotId:manifest.snapshot_id,stateSnapshotId:manifest.state_snapshot_id||null,completedAt:manifest.completed_at,files,boundary:'signed-read-v1'};
    }catch(error){
      if(error?.operationsHubAuthRequired)throw error;
      recordOriginalBoundaryDiagnostic('secure-download-fallback',{sources:'sellpia',message:String(error?.message||error)});
      return {...await downloadLatestSellpiaOriginalsDirect(onProgress),boundary:'direct-anon-fallback'};
    }
  }

  async function prepareSellerExport({batchId, mode, changeIds = [], sources = []}) {
    if (cleanText(mode) !== 'change_queue') throw new Error('검토한 수정본 내보내기만 지원합니다.');
    const {data:summaryRows, error} = await db.rpc('prepare_operations_hub_change_export', {
      p_session_token:requireOperationsHubSessionToken(),
      p_export_batch_id:batchId,
      p_change_ids:(changeIds || []).map(Number),
      p_sources:(sources || []).map(cleanText)
    });
    if (error) throw error;
    const items = [];
    const pageSize = 1000;
    for (let from = 0; ; from += pageSize) {
      const {data, error:loadError} = await db
        .from('operations_hub_export_items')
        .select('export_item_id,export_batch_id,change_id,sellpia_sku_code,source_channel,field_key,before_value,after_value,seller_product_code,seller_option_code,source_file_name,source_row_no,expected_source_value,base_price,option_price,target_base_price,target_discounted_base_price,target_option_price,target_final_price,source_discount_terms,target_discount_terms,option_price_source,price_rule_set_id,blocking_reason,status')
        .eq('export_batch_id', batchId)
        .order('export_item_id', {ascending:true})
        .range(from, from + pageSize - 1);
      if (loadError) throw loadError;
      items.push(...(data || []));
      if (!data || data.length < pageSize) break;
    }
    const summary = Array.isArray(summaryRows) ? summaryRows[0] : summaryRows;
    if (!items.length) {
      const {data:batch, error:batchError} = await db.from('operations_hub_export_batches')
        .select('error_message').eq('export_batch_id', batchId).maybeSingle();
      if (batchError) throw batchError;
      throw new Error(batch?.error_message || '내보내기 가능한 수정안이 없습니다. 제외 사유를 확인해주세요.');
    }
    return {items, summary};
  }

  async function completeSellerExport({batchId, success, manifest = [], errorMessage = '', skippedItems = []}) {
    const {data, error} = await db.rpc('complete_operations_hub_export', {
      p_export_batch_id:batchId,
      p_success:Boolean(success),
      p_file_manifest:manifest,
      p_error_message:cleanText(errorMessage),
      p_skipped_items:(skippedItems || []).map(item => ({
        export_item_id:Number(item.export_item_id),
        reason:cleanText(item.reason)
      })).filter(item => Number.isFinite(item.export_item_id) && item.export_item_id > 0)
    });
    if (error) throw error;
    return Array.isArray(data) ? data[0] : data;
  }

  async function confirmChangesApplied(changeIds) {
    const {data, error} = await db.rpc('confirm_operations_hub_changes_applied', {
      p_change_ids:(changeIds || []).map(Number)
    });
    if (error) throw error;
    return Array.isArray(data) ? data[0] : data;
  }

  function decodeImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const image = new Image();
      image.onload = () => resolve({image, url});
      image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('이미지 파일을 읽지 못했습니다.')); };
      image.src = url;
    });
  }

  async function normalizeSellpiaImage(file) {
    if (!file?.type?.startsWith('image/')) throw new Error('이미지 파일만 올릴 수 있습니다.');
    if (file.size > 20 * 1024 * 1024) throw new Error('원본 이미지는 20MB 이하여야 합니다.');
    const {image, url} = await decodeImage(file);
    try {
      const maxDimension = 2400;
      const scale = Math.min(1, maxDimension / Math.max(image.naturalWidth, image.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      canvas.getContext('2d', {alpha:false}).drawImage(image, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.9));
      if (!blob) throw new Error('이미지를 JPG로 변환하지 못했습니다.');
      if (blob.size > 5 * 1024 * 1024) throw new Error('변환된 이미지가 5MB를 초과합니다.');
      return blob;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  async function uploadSellpiaImage(sku, file) {
    const safeSku = cleanText(sku);
    if (!/^[0-9A-Za-z._-]+$/.test(safeSku)) throw new Error('이미지 파일명으로 사용할 수 없는 SKU입니다.');
    const imageBlob = await normalizeSellpiaImage(file);
    const path = `sellpia/${safeSku}.jpg`;
    const {error:uploadError} = await db.storage
      .from('product-images')
      .upload(path, imageBlob, {contentType:'image/jpeg', cacheControl:'3600', upsert:true});
    if (uploadError) throw uploadError;
    const {data:saveResult, error:saveError} = await db.rpc('apply_operations_hub_sellpia_changes', {
      p_sku:safeSku,
      p_changes:[{field_key:'sellpia_image', before:'', after:path}]
    });
    if (saveError) throw saveError;
    const {data:publicData} = db.storage.from('product-images').getPublicUrl(path);
    return {
      path,
      url:`${publicData.publicUrl}?v=${Date.now()}`,
      saved:Array.isArray(saveResult) ? saveResult[0] : saveResult
    };
  }

  async function loadSiblingOptions(sku){
    requireOperationsHubSessionToken();
    const {data:target,error}=await db.from('operations_hub_product_profiles').select('sellpia_product_code').eq('sellpia_sku_code',cleanText(sku)).maybeSingle();if(error)throw error;
    if(!target?.sellpia_product_code)throw Error('해당 SKU의 셀피아 상품코드를 찾지 못했습니다.');
    const {data:siblings,error:err}=await db.from('operations_hub_product_profiles').select('sellpia_sku_code').eq('sellpia_product_code',target.sellpia_product_code).order('sellpia_sku_code').limit(1000);if(err)throw err;
    const codes=siblings.map(r=>r.sellpia_sku_code).filter(code=>code!==cleanText(sku));let rows=[];
    for(let i=0;i<codes.length;i+=200){const {data:part,error:e}=await db.from(MATRIX_VIEW).select('sellpia_sku_code,sellpia_product_name,sellpia_option_name').in('sellpia_sku_code',codes.slice(i,i+200));if(e)throw e;rows.push(...part);}
    return rows;
  }
  async function loadSellpiaPatchRows({skus=null,search='',searchType='sku',withResults=true,snapshotId=null,stateSnapshotId=null,onProgress}={}) {
    const expectedSnapshotId=cleanText(snapshotId);
    const expectedStateId=cleanText(stateSnapshotId);
    if(expectedSnapshotId&&!expectedStateId)throw Error('현재 Sellpia 상태 snapshot을 확인할 수 없습니다. 원본 미리보기를 다시 실행하세요.');
    const rows=[];let count=0,limit=withResults?50:500;
    do {
      const args={p_session_token:requireOperationsHubSessionToken(),p_skus:skus,p_search:search,p_search_type:searchType,p_offset:rows.length,p_limit:limit,p_with_results:withResults};
      if(expectedSnapshotId){args.p_snapshot_id=expectedSnapshotId;args.p_state_snapshot_id=expectedStateId;}
      const {data,error}=await db.rpc(expectedSnapshotId?'hub_sellpia_patch_read_v3':'hub_sellpia_patch_read_v1',args);
      if(error&&/statement timeout|canceling statement/i.test(error.message)&&limit>1){limit=Math.ceil(limit/2);continue;}
      throwOperationsHubRpcError(error);
      if(expectedSnapshotId&&cleanText(data?.snapshot_id)!==expectedSnapshotId)throw Error('Sellpia 원본 snapshot이 조회 중 변경됐습니다. 다시 미리보기하세요.');
      if(expectedStateId&&cleanText(data?.state_snapshot_id)!==expectedStateId)throw Error('Sellpia 현재 상태가 조회 중 변경됐습니다. 다시 미리보기하세요.');
      count=data.count;rows.push(...data.rows);
      onProgress?.({processed:rows.length,total:count});
      if(!data.rows.length)break;
    }while(rows.length<count);
    return rows;
  }
  async function loadInternalFormulaProducts(skus,{legacySkus=skus}={}) {
    const rows=await loadSellpiaPatchRows({skus,withResults:false});
    if(!legacySkus.length)return rows;
    const details=await attachInboundCostDetails(rows.filter(r=>legacySkus.includes(r.sellpia_sku_code))),bySku=new Map(details.map(r=>[r.sellpia_sku_code,r]));
    return rows.map(r=>bySku.get(r.sellpia_sku_code)||r);
  }
  async function loadFormulaProducts(skus, {onProgress} = {}) {
    requireOperationsHubSessionToken();
    const codes=[...new Set(skus)],chunks=[];for(let i=0;i<codes.length;i+=100)chunks.push(codes.slice(i,i+100));
    const results=new Array(chunks.length);let next=0,completed=0;
    const timedOut=error=>/statement timeout|canceling statement/i.test(String(error?.message||error));
    async function loadSellerComponents(chunk, retry=0) {
      try {
        const {data,error}=await db.rpc('load_operations_hub_seller_price_components',{p_skus:chunk});
        if(error)throw readableDatabaseError(error);
        return data||[];
      } catch (error) {
        if (!timedOut(error)) throw error;
        if (chunk.length>10) {
          const middle=Math.ceil(chunk.length/2);
          return [...await loadSellerComponents(chunk.slice(0,middle)),...await loadSellerComponents(chunk.slice(middle))];
        }
        if (retry<2) {
          await new Promise(resolve=>setTimeout(resolve,retry?500:200));
          return loadSellerComponents(chunk,retry+1);
        }
        throw error;
      }
    }
    async function loadChunk(chunk, retry=0) {
      try {
        const {data,error}=await db.from(MATRIX_VIEW).select('sellpia_sku_code,display_name,sellpia_source_sale_price,system_base_price,smartstore_price,makeshop_price,ably_price,smartstore_product_code,makeshop_product_code,ably_product_code').in('sellpia_sku_code',chunk);if(error)throw readableDatabaseError(error);
        let part=await attachProductProfiles(data||[]);part=await attachInboundCostDetails(part);part=await attachSystemOperationalDetails(part);
        const components=await loadSellerComponents(chunk);
        return await attachRepresentativePrices(await attachSellerDrafts(await attachSellerPriceComponents(part,undefined,components)));
      } catch (error) {
        if (!timedOut(error)) throw error;
        if (chunk.length>10) {
          const middle=Math.ceil(chunk.length/2);
          return [...await loadChunk(chunk.slice(0,middle)),...await loadChunk(chunk.slice(middle))];
        }
        if (retry<2) {
          await new Promise(resolve=>setTimeout(resolve,retry?500:200));
          return loadChunk(chunk,retry+1);
        }
        throw error;
      }
    }
    await Promise.all(Array.from({length:Math.min(2,chunks.length)},async()=>{
      while(next<chunks.length){const index=next++,chunk=chunks[index];
        results[index]=await loadChunk(chunk);completed+=chunk.length;onProgress?.(completed,codes.length);
      }
    }));
    return results.flat();
  }
  async function beginCalculationGeneration({reason = '가격 계산 결과 갱신', requestId = global.crypto.randomUUID()} = {}) {
    const {data,error}=await db.rpc('hub_calculation_begin_v1',{
      p_session_token:requireOperationsHubSessionToken(),p_reason:cleanText(reason),p_request_id:requestId
    });
    if(error)throw readableDatabaseError(error);return data||{};
  }
  async function upsertCalculatedPriceResults({generationId,rows} = {}) {
    const entries=Array.isArray(rows)?rows:[];
    if(!entries.length||entries.length>1000)throw Error('계산 결과 저장은 요청당 1~1,000개여야 합니다.');
    const {data,error}=await db.rpc('hub_calculation_results_upsert_v1',{
      p_session_token:requireOperationsHubSessionToken(),p_generation_id:Number(generationId),p_rows:entries
    });
    if(error)throw readableDatabaseError(error);return data||{};
  }
  async function loadCalculatedResults({skus,scope=null,fields=null,onProgress} = {}) {
    const codes=[...new Set((skus||[]).map(cleanText).filter(Boolean))];
    if(!codes.length)return {rows:[],missing:[],missingSkus:[]};
    const rows=[],missing=[],missingSkus=[];
    for(let offset=0;offset<codes.length;offset+=200){
      const chunk=codes.slice(offset,offset+200);let afterKey=null;
      do{
        const {data,error}=await db.rpc(typeof fullMatrixReadContext!=='undefined'&&fullMatrixReadContext?'hub_matrix_calculation_results_batch_v1':'hub_calculation_results_read_v1',{
          p_session_token:requireOperationsHubSessionToken(),p_skus:chunk,p_scope:scope,p_fields:fields,p_after_key:afterKey,p_limit:1000
        });
        if(error)throw readableDatabaseError(error);
        rows.push(...(data?.rows||[]));missing.push(...(data?.missing||[]));missingSkus.push(...(data?.missing_skus||[]));afterKey=data?.next_key||null;
      }while(afterKey);
      onProgress?.(Math.min(offset+chunk.length,codes.length),codes.length);
    }
    return {rows,missing,missingSkus:[...new Set(missingSkus)]};
  }
  async function loadCalculatedResultsForExport({source,onProgress} = {}) {
    const rows=[];let afterSku=null;
    do{
      const {data,error}=await db.rpc('hub_calculation_results_export_read_v1',{
        p_session_token:requireOperationsHubSessionToken(),p_scope:source,p_after_sku:afterSku,p_limit:200
      });
      if(error)throw readableDatabaseError(error);
      rows.push(...(data?.rows||[]));afterSku=data?.next_sku||null;
      const label={smartstore:'스마트스토어',makeshop:'메이크샵',ably:'에이블리'}[source]||source;
      onProgress?.(`저장된 ${label} 가격 ${Math.floor(rows.length/4).toLocaleString('ko-KR')}개 SKU 조회`);
    }while(afterSku);
    return rows;
  }
  async function loadStoredMatrixPrices({sources=['smartstore','makeshop','ably'],skus=null,includeMatrixDrafts=false,onProgress} = {}) {
    const selected=[...new Set(sources.map(cleanText).filter(source=>['smartstore','makeshop','ably'].includes(source)))];
    let codes=skus===null?null:[...new Set((skus||[]).map(cleanText).filter(Boolean))];
    if(!selected.length||codes!==null&&!codes.length)return {rows:[],missing:[]};
    const required=['platform_registration_price','platform_discount_price','platform_option_price','platform_final_price'];
    const flat=[],missing=[];
    const priceRules=await loadActiveSellerPriceRules();
    if(codes===null){
      const results=await Promise.all(selected.map(source=>loadCalculatedResultsForExport({source,onProgress})));
      results.forEach(result=>flat.push(...result));
    }else{
      const jobs=[];let completed=0,total=codes.length*selected.length,nextJob=0;
      for(const source of selected){const requested=typeof fullMatrixReadContext!=='undefined'&&fullMatrixReadContext?codes.filter(sku=>priceRules.has(JSON.stringify([sku,source]))):codes;for(let offset=0;offset<requested.length;offset+=200)jobs.push({source,codes:requested.slice(offset,offset+200)});}
      await Promise.all(Array.from({length:Math.min(6,jobs.length)},async()=>{
        while(nextJob<jobs.length){
          const job=jobs[nextJob++],result=await loadCalculatedResults({skus:job.codes,scope:job.source,fields:required});
          flat.push(...result.rows);missing.push(...result.missing);completed+=job.codes.length;
          onProgress?.(`저장 가격 ${Math.min(completed,total).toLocaleString('ko-KR')} / ${total.toLocaleString('ko-KR')} SKU 조회`);
        }
      }));
    }
    const grouped=new Map();
    for(const row of flat){
      if(!priceRules.has(JSON.stringify([row.sku,row.scope])))continue;
      if(row.mapping_missing||!cleanText(row.seller_product_code))continue;
      const key=JSON.stringify([row.sku,row.scope]),entry=grouped.get(key)||{sellpia_sku_code:row.sku,source_channel:row.scope,seller_product_code:row.seller_product_code||'',seller_option_code:row.seller_option_code||'',fields:new Map(),rule_versions:[]};
      entry.fields.set(row.field,row);entry.rule_versions.push(...(row.rule_versions||[]));grouped.set(key,entry);
    }
    const rows=[...grouped.values()].map(entry=>{
      const get=field=>entry.fields.get(field),values=required.map(get),errors=values.filter(row=>row?.status==='error'||row?.error),generations=new Set(values.map(row=>row?.generation_id).filter(value=>value!==null&&value!==undefined));
      const discountDetails=get('platform_final_price')?.result_details||get('platform_discount_price')?.result_details||{};
      const incomplete=values.some(row=>!row),mixed=generations.size>1;
      const versions=[...new Map(entry.rule_versions.map(version=>[`${version.id}:${version.version}:${version.assignmentVersion||''}`,version])).values()];
      return {sellpia_sku_code:entry.sellpia_sku_code,source_channel:entry.source_channel,seller_product_code:entry.seller_product_code,seller_option_code:entry.seller_option_code,
        base_price:get('platform_registration_price')?.value,discounted_base_price:get('platform_discount_price')?.value,option_price:get('platform_option_price')?.value,final_price:get('platform_final_price')?.value,
        discount_terms:Array.isArray(discountDetails.discount_terms)?discountDetails.discount_terms:[],rule_versions:versions,generation_id:generations.size===1?[...generations][0]:null,input_fingerprint:discountDetails.input_fingerprint,
        status:errors.length||incomplete||mixed?'error':'calculated',error:errors.map(row=>row.error).filter(Boolean).join(' / ')||(incomplete?'저장된 가격 단계가 일부 없습니다.':mixed?'저장된 가격의 계산 세대가 일치하지 않습니다.':'')};
    });
    // Only the new, explicitly product-dependent records acquire this guard.
    // Inactive product definitions still identify their stored history.
    if(typeof productPrice==='function'){
      const definitions=(await productPrice('rules',{include_inactive:true})).rules||[],ids=new Set(definitions.map(r=>r.id));
      const dependent=rows.filter(r=>r.rule_versions.some(v=>ids.has(v.id)));
      if(dependent.length){
        const current=await readRepresentativePrices([...new Set(dependent.map(r=>r.sellpia_sku_code))]),bySku=new Map();
        for(const rep of current)for(const option of rep.contributors||[])bySku.set(option.sku,rep);
        const stamps={};for(const source of selected){const skus=[...new Set(dependent.filter(r=>r.source_channel===source).map(r=>r.sellpia_sku_code))];if(skus.length)stamps[source]=await loadInputFingerprints(skus,source);}
        for(const row of dependent){const rep=bySku.get(row.sellpia_sku_code);if(!rep||rep.status!=='calculated'||row.input_fingerprint!==stamps[row.source_channel]?.[row.sellpia_sku_code]){row.status='error';row.error='상품 대표가 입력 변경 또는 활성 Rule 없음 · 재계산 필요';}}
      }
    }
    const calculatedKeys=new Set(rows.map(row=>JSON.stringify([row.sellpia_sku_code,row.source_channel])));
    if(includeMatrixDrafts){
      const drafts=[],selectDrafts=()=>db.from('operations_hub_active_seller_drafts').select('change_id,sellpia_sku_code,source_channel,price_base_after,price_discounted_base_after,price_option_after,price_final_after,price_discount_terms_after,price_rule_set_id,updated_at').eq('field_key','sellpia_sale_price').in('source_channel',selected).order('updated_at',{ascending:false}).order('change_id',{ascending:false});
      if(codes===null){let from=0;while(true){const {data,error}=await selectDrafts().range(from,from+499);if(error)throw readableDatabaseError(error);drafts.push(...(data||[]));if((data||[]).length<500)break;from+=500;}}
      else{const draftJobs=[];for(let offset=0;offset<codes.length;offset+=500)draftJobs.push(codes.slice(offset,offset+500));let nextDraftJob=0;await Promise.all(Array.from({length:Math.min(6,draftJobs.length)},async()=>{while(nextDraftJob<draftJobs.length){const chunk=draftJobs[nextDraftJob++],{data,error}=await selectDrafts().in('sellpia_sku_code',chunk);if(error)throw readableDatabaseError(error);drafts.push(...(data||[]));}}));}
      const draftByKey=new Map();for(const draft of drafts){const key=JSON.stringify([cleanText(draft.sellpia_sku_code),cleanText(draft.source_channel)]);if(!draftByKey.has(key))draftByKey.set(key,draft);}
      const draftSkus=[...new Set(drafts.map(draft=>cleanText(draft.sellpia_sku_code)).filter(Boolean))],components=[],componentJobs=[];for(let offset=0;offset<draftSkus.length;offset+=200)componentJobs.push(draftSkus.slice(offset,offset+200));let nextComponentJob=0;
      await Promise.all(Array.from({length:Math.min(4,componentJobs.length)},async()=>{while(nextComponentJob<componentJobs.length){const chunk=componentJobs[nextComponentJob++],{data,error}=await db.rpc('load_operations_hub_seller_price_components',{p_skus:chunk});if(error)throw readableDatabaseError(error);components.push(...(data||[]));}}));
      const storedKeys=new Set(rows.map(row=>JSON.stringify([row.sellpia_sku_code,row.source_channel])));
      for(const component of components){const sku=cleanText(component.sellpia_sku_code),source=cleanText(component.source_channel),key=JSON.stringify([sku,source]),draft=draftByKey.get(key);if(!priceRules.has(key)||!draft||!selected.includes(source)||storedKeys.has(key)||!cleanText(component.seller_product_code))continue;const terms=Array.isArray(draft.price_discount_terms_after)?draft.price_discount_terms_after:(Array.isArray(component.source_discount_terms)?component.source_discount_terms:[]);rows.push({sellpia_sku_code:sku,source_channel:source,seller_product_code:component.seller_product_code,seller_option_code:component.seller_option_code||'',base_price:draft.price_base_after??component.draft_base_price??component.source_base_price,discounted_base_price:draft.price_discounted_base_after??component.draft_discounted_base_price??component.source_discounted_base_price,option_price:draft.price_option_after??component.draft_option_price??component.source_option_price??0,final_price:draft.price_final_after??component.draft_final_price??component.source_final_price,discount_terms:terms,rule_versions:[],generation_id:null,status:'matrix_draft',error:null,change_id:draft.change_id});storedKeys.add(key);}
    }
    onProgress?.(`저장된 매트릭스 가격 ${rows.length.toLocaleString('ko-KR')}건을 불러왔습니다.`);
    return {rows,activePriceRules:[...priceRules],missing:missing.filter(item=>calculatedKeys.has(JSON.stringify([item.sellpia_sku_code,item.source_channel])))};
  }
  async function attachStoredCalculatedPrices(products, signal) {
    const codes=[...new Set(products.map(product=>cleanText(product?.sellpia_sku_code)).filter(Boolean))];
    if(!codes.length)return products;
    let internal,platform;
    try {
      [internal,platform]=await Promise.all([
        loadCalculatedResults({skus:codes,scope:'',fields:['actual_inbound_cost','basis_sku_price','calculated_base_price']}),
        loadStoredMatrixPrices({sources:['smartstore','makeshop','ably'],skus:codes})
      ]);
    } catch(error) {
      if(fullMatrixReadContext)throw new Error('Matrix 현재 계산값 조회: '+(error.message||String(error)));
      // Stored prices enrich the matrix; they must never make the core catalog
      // unavailable when this auxiliary read is slow or temporarily fails.
      console.warn('stored matrix price enrichment failed',error);
      return products;
    }
    throwIfAborted(signal);
    const internalBySku=new Map(),platformBySku=new Map();
    for(const stored of internal.rows||[]){
      const sku=cleanText(stored.sku);if(!sku)continue;
      if(!internalBySku.has(sku))internalBySku.set(sku,{});
      const versions=stored.rule_versions||[],ruleNames=[...new Set(versions.map(version=>cleanText(version?.name)).filter(Boolean))];
      internalBySku.get(sku)[stored.field]=stored.status==='error'
        ? {error:stored.error,versions,ruleNames,activeOutputRules:stored.active_output_rules,generationId:stored.generation_id,calculatedAt:stored.calculated_at}
        : {value:Number(stored.value),versions,ruleNames,activeOutputRules:stored.active_output_rules,generationId:stored.generation_id,calculatedAt:stored.calculated_at};
    }
    for(const row of platform.rows){if(!platformBySku.has(row.sellpia_sku_code))platformBySku.set(row.sellpia_sku_code,{});platformBySku.get(row.sellpia_sku_code)[row.source_channel]={platformBase:row.base_price,discounted:row.discounted_base_price,platformDiscount:row.base_price==null||row.discounted_base_price==null?null:Number(row.base_price)-Number(row.discounted_base_price),platformOption:row.option_price,platformFinal:row.final_price,platformTerms:row.discount_terms,versions:row.rule_versions,error:row.error};}
    const activeRules=new Set(platform.activePriceRules||[]);
    return products.map(product=>{
      const sku=cleanText(product?.sellpia_sku_code),row={...product},storedInternal=internalBySku.get(sku),storedPlatform=platformBySku.get(sku);
      row.__hubActivePriceRules=Object.fromEntries(['smartstore','makeshop','ably'].map(source=>[source,activeRules.has(JSON.stringify([sku,source]))]));
      for(const source of ['smartstore','makeshop','ably'])if(!row.__hubActivePriceRules[source])row[source+'_policy_active']=false;
      if(storedInternal){
        const projected={...storedInternal},profileTags=[...(product?.__profile?.product_tags||[]),...(product?.__profile?.sku_tags||[])],formulaTags=profileTags.filter(tag=>cleanText(tag?.tag_group).includes('수식'));
        if(projected.actual_inbound_cost){
          if(Array.isArray(projected.actual_inbound_cost.activeOutputRules)){
            const owners=projected.actual_inbound_cost.activeOutputRules;
            if(!owners.length)delete projected.actual_inbound_cost;
            else projected.actual_inbound_cost={...projected.actual_inbound_cost,ruleNames:[...new Set(owners.map(rule=>cleanText(rule.tag_name||rule.name)).filter(Boolean))]};
          }
          else if(!formulaTags.length)delete projected.actual_inbound_cost;
          else if(!projected.actual_inbound_cost.ruleNames?.length)projected.actual_inbound_cost={...projected.actual_inbound_cost,ruleNames:[...new Set(formulaTags.map(tag=>cleanText(tag?.tag_name)).filter(Boolean))]};
        }
        for(const value of Object.values(projected)){
          if(!Array.isArray(value.activeOutputRules))continue;
          const owners=value.activeOutputRules;
          value.currentRuleNames=[...new Set(owners.map(owner=>cleanText(owner.tag_name||owner.name)).filter(Boolean))];
          const ownerMismatch=owners.some(owner=>!value.versions.some(version=>version.id===owner.id));
          if(ownerMismatch){value.stale=true;value.ruleNames=[];value.provenanceMismatch=true;}
          else if(owners.length)value.ruleNames=value.currentRuleNames;
        }
        if(Object.keys(projected).length)row.__hubInternalPrices=projected;else delete row.__hubInternalPrices;
      }
      else delete row.__hubInternalPrices;
      if(storedPlatform)row.__hubRulePrices=storedPlatform;else delete row.__hubRulePrices;
      return row;
    });
  }
  async function savePlatformRuleGroup(rule) {
    const {data,error}=await db.rpc('hub_platform_rule_group_save_v1',{p_session_token:requireOperationsHubSessionToken(),p_rule:rule});
    if(error)throw readableDatabaseError(error);return data;
  }
  async function loadAllFilteredSkus(options={}, {onProgress}={}) {
    onProgress?.({loaded:0,total:0,message:'현재 필터에 맞는 전체 SKU 조회 중'});
    const codeRows=Array.isArray(options.codeListRows)?options.codeListRows:[];
    const codes=[...new Set((codeRows.length?codeRows.map(r=>r.sellpia_sku_code):options.skus||options.codeListSkus||[]).map(cleanText).filter(Boolean))];
    if(codeRows.length&&!codes.length)return {skus:[],total:0};
    const isCodeList=codeRows.length||codes.length;
    const {data,error}=await db.rpc('hub_filtered_skus_v1',{
      p_session_token:requireOperationsHubSessionToken(),
      p_search:isCodeList?'':normalizedSearch(options.search),
      p_search_sources:options.searchSources||['sellpia','smartstore','makeshop','ably'],
      p_status:codeRows.length?'all':normalizeConnectionStatus(options.status),
      p_sort:'sku_asc',p_filter:normalizeConnectionConditions(isCodeList?null:options.advancedFilter),
      p_skus:codes,p_exclude_dependent:isCodeList?false:Boolean(options.excludeCombinationSkus)
    });
    if(error)throw readableDatabaseError(error);
    const skus=[...new Set((data?.skus||[]).map(cleanText).filter(Boolean))];
    if(Number(data?.total)!==skus.length)throw Error('필터 전체 대상 수와 SKU 목록이 일치하지 않습니다. 다시 조회하세요.');
    onProgress?.({loaded:skus.length,total:skus.length});return {skus,total:skus.length};
  }
  async function applyTagToSkus({tagId,skus,action='add'}) {
    const {data,error}=await db.rpc('hub_tag_assign_v1',{p_session_token:requireOperationsHubSessionToken(),p_tag_id:tagId,p_skus:[...new Set(skus)],p_action:action});
    if(error)throw readableDatabaseError(error);return data;
  }
  async function bulkImportTags({rows,tagId=null,preview=true,partial=false}) {
    const normalized=(Array.isArray(rows)?rows:[]).map(row=>({sku:cleanText(row?.sku),tag_name:cleanText(row?.tag_name),...(partial?{source_row_no:row?.source_row_no,source_file:cleanText(row?.source_file)}:{})}));
    const {data,error}=await db.rpc(partial?'hub_tag_bulk_import_v2':'hub_tag_bulk_import_v1',{p_session_token:requireOperationsHubSessionToken(),p_rows:normalized,p_tag_id:tagId||null,p_preview:Boolean(preview)});
    if(error)throw readableDatabaseError(error);return data||{};
  }
  async function saveTagRule({tag,rule}) {
    const {data,error}=await db.rpc('hub_tag_rule_save_v1',{p_session_token:requireOperationsHubSessionToken(),p_tag:tag,p_rule:rule});
    if(error)throw readableDatabaseError(error);return data;
  }
  async function filterRulePlatformSkus(skus,source) {
    requireOperationsHubSessionToken();if(!['ably','smartstore','makeshop'].includes(source))throw Error('판매처 오류');
    const field=source+'_product_code',codes=[...new Set(skus)],linked=[];
    for(let i=0;i<codes.length;i+=200){const {data,error}=await db.from(MATRIX_VIEW).select('sellpia_sku_code,'+field).in('sellpia_sku_code',codes.slice(i,i+200));if(error)throw error;linked.push(...data.filter(r=>r[field]).map(r=>r.sellpia_sku_code));}return linked;
  }
  async function productPrice(action, body = {}) {
    const key=JSON.stringify(body);if(action==='rules'&&typeof fullMatrixReadContext!=='undefined'&&fullMatrixReadContext){fullMatrixReadContext.productRules??=new Map();if(fullMatrixReadContext.productRules.has(key))return fullMatrixReadContext.productRules.get(key);const read=(async()=>{const {data,error}=await db.rpc('hub_product_price_v1',{p_session_token:requireOperationsHubSessionToken(),p_action:action,p_body:body});if(error)throw readableDatabaseError(error);return data;})();fullMatrixReadContext.productRules.set(key,read);return read;}
    const {data,error}=await db.rpc('hub_product_price_v1',{p_session_token:requireOperationsHubSessionToken(),p_action:action,p_body:body});
    if(error)throw readableDatabaseError(error);return data;
  }
  async function readRepresentativePrices(skus) {
    const codes=[...new Set(skus)],byProduct=new Map();
    for(let i=0;i<codes.length;i+=100){const result=await productPrice('read',{skus:codes.slice(i,i+100)});for(const row of result.rows||[])byProduct.set(row.product_identity,row);}
    return [...byProduct.values()];
  }
  async function attachRepresentativePrices(products) {
    if(!products.length)return products;
    let requested=products;
    if(typeof fullMatrixReadContext!=='undefined'&&fullMatrixReadContext){const definitions=(await productPrice('rules',{include_inactive:true})).rules||[],tagIds=new Set(definitions.map(r=>String(r.tag_id)));requested=products.filter(p=>[...(p.__profile?.product_tags||[]),...(p.__profile?.sku_tags||[])].some(t=>tagIds.has(String(t.tag_id))));}
    const rows=await readRepresentativePrices(requested.map(p=>p.sellpia_sku_code)),bySku=new Map();
    for(const row of rows)for(const option of row.contributors||[])bySku.set(option.sku,row);
    return products.map(product=>bySku.has(product.sellpia_sku_code)?{...product,__hubRepresentativePrice:bySku.get(product.sellpia_sku_code)}:product);
  }
  async function expandRepresentativeMembers(skus) {
    const codes=[...new Set(skus)],members=new Set();
    for(let i=0;i<codes.length;i+=100){const result=await productPrice('members',{skus:codes.slice(i,i+100)});for(const sku of result.skus||[])members.add(sku);}
    return [...members];
  }
  async function materializeRepresentatives(skus, generationId) {
    const current=await readRepresentativePrices(skus),owned=current.filter(r=>r.rule),rows=[];
    for(let i=0;i<owned.length;i+=100){const part=owned.slice(i,i+100),result=await productPrice('materialize',{products:part.map(r=>r.product_identity),generation_id:generationId,expected_fingerprints:Object.fromEntries(part.map(r=>[r.product_identity,r.input_fingerprint]))});rows.push(...result.rows);}
    return rows;
  }
  async function ruleRegistry(action, rule = null) {
    if (action === 'list') {
      if(typeof fullMatrixReadContext!=='undefined'&&fullMatrixReadContext?.registry)return fullMatrixReadContext.registry;
      const read=(async()=>{const {data,error}=await db.rpc('hub_rule_registry_list_v2',{p_session_token:requireOperationsHubSessionToken()});
      if(error)throw readableDatabaseError(error);
      // Transfer shared assignment fields once per group, then restore the engine contract.
      const {assignment_groups = [], ...registry} = data;
      return {...registry, assignments: assignment_groups.flatMap(({entries, ...group}) =>
        entries.map(([sku, version]) => ({...group, sku, version})))};})();
      if(typeof fullMatrixReadContext!=='undefined'&&fullMatrixReadContext)fullMatrixReadContext.registry=read;
      return read;
    }
    const {data,error}=await db.rpc('hub_rule_registry_v1',{p_session_token:requireOperationsHubSessionToken(),p_action:action,p_rule:rule});
    if(error)throw readableDatabaseError(error);return data;
  }
  async function assignRules(action, assignments, requestId = global.crypto.randomUUID()) {
    const {data,error}=await db.rpc('hub_rule_assign_v1',{p_session_token:requireOperationsHubSessionToken(),p_action:action,p_assignments:assignments,p_request_id:requestId});
    if(error)throw readableDatabaseError(error);return data;
  }
  async function loadRulePlatformSiblings(skus, source) {
    requireOperationsHubSessionToken();if(!['ably','smartstore','makeshop'].includes(source))throw Error('판매처 오류');
    const field=source+'_product_code',codes=new Set(),result=new Set(skus);
    for(let i=0;i<skus.length;i+=200){const {data,error}=await db.from('operations_hub_matrix_cached').select(field).in('sellpia_sku_code',skus.slice(i,i+200));if(error)throw error;data.forEach(r=>{if(r[field])codes.add(r[field]);});}
    const groupedCodes=[...codes];for(let i=0;i<groupedCodes.length;i+=100){for(let from=0;;from+=1000){const {data,error}=await db.from('operations_hub_matrix_cached').select('sellpia_sku_code').in(field,groupedCodes.slice(i,i+100)).order('sellpia_sku_code').range(from,from+999);if(error)throw error;data.forEach(r=>result.add(r.sellpia_sku_code));if(data.length<1000)break;}}
    return [...result];
  }
  async function renameProductTag({id,name,expectedName=null}) {
    const {data,error}=await db.rpc('hub_product_tag_rename_v1',{p_session_token:requireOperationsHubSessionToken(),p_tag_id:id,p_name:cleanText(name),p_expected_name:expectedName});
    if(error)throw readableDatabaseError(error);return data;
  }
  async function updateProductTag({id,name,color}) {
    const {data,error}=await db.rpc('hub_product_tag_metadata_update_v1',{p_session_token:requireOperationsHubSessionToken(),p_tag_id:id,p_name:cleanText(name),p_color:color||null,p_expected_name:null});
    if(error)throw readableDatabaseError(error);return data;
  }

  async function workDocument(action,kind,document={}) {
    const {data,error}=await db.rpc('hub_work_documents_v1',{p_session_token:requireOperationsHubSessionToken(),p_action:action,p_kind:kind,p_id:document.id||null,p_title:document.title||null,p_body:document.body||null,p_version:document.version||null});
    if(error)throw error;return data;
  }

  const ablyCarrierPolicyTitle=tagId=>`carrier-policy:tag:${cleanText(tagId)}`;

  async function loadAblyCarrierPolicy(tagId) {
    const id=cleanText(tagId);if(!id)throw new Error('조회할 태그를 확인해주세요.');
    return workDocument('get_title','formula',{title:ablyCarrierPolicyTitle(id)});
  }

  async function saveAblyCarrierPolicy({tagId,strategy='',document=null}={}) {
    const id=cleanText(tagId),selected=cleanText(strategy),allowed=new Set(['lowest','lower_middle','preserve_existing_base']);
    if(!id)throw new Error('저장할 태그를 확인해주세요.');
    if(selected&&!allowed.has(selected))throw new Error('지원하지 않는 에이블리 내보내기 정책입니다.');
    const current=document||await loadAblyCarrierPolicy(id),body=current?.body&&typeof current.body==='object'?structuredClone(current.body):{};
    const carriers=body.carriers&&typeof body.carriers==='object'?{...body.carriers}:{};
    if(selected)carriers.ably={representativeStrategy:selected};else delete carriers.ably;
    const savedBody={...body,version:1,carriers};
    return workDocument('save','formula',{id:current?.id||null,title:ablyCarrierPolicyTitle(id),body:savedBody,version:current?.version||null});
  }

  async function loadAblyCarrierPoliciesForSkus({skus=[]}={}) {
    requireOperationsHubSessionToken();
    const codes=[...new Set((skus||[]).map(cleanText).filter(Boolean))];
    if(!codes.length)return {rows:[],documents:[],fingerprint:'[]'};
    const profiles=[];
    for(let offset=0;offset<codes.length;offset+=200){
      const {data,error}=await db.from('operations_hub_product_profiles').select('sellpia_sku_code,product_tags,sku_tags').in('sellpia_sku_code',codes.slice(offset,offset+200));
      if(error)throw error;profiles.push(...(data||[]));
    }
    const activeTags=await loadTags(),activeById=new Map(activeTags.map(tag=>[cleanText(tag.tag_id),tag]));
    const memberships=new Map();
    for(const profile of profiles){
      const tags=[...(Array.isArray(profile.product_tags)?profile.product_tags:[]),...(Array.isArray(profile.sku_tags)?profile.sku_tags:[])];
      const unique=new Map();
      for(const tag of tags){const id=cleanText(tag?.tag_id);if(id&&activeById.has(id))unique.set(id,{...activeById.get(id),...tag,tag_id:id,is_active:true});}
      memberships.set(cleanText(profile.sellpia_sku_code),[...unique.values()].sort((a,b)=>cleanText(a.tag_id).localeCompare(cleanText(b.tag_id))));
    }
    const tagIds=[...new Set([...memberships.values()].flat().map(tag=>cleanText(tag.tag_id)))].sort();
    const documents=(await Promise.all(tagIds.map(async tagId=>({tagId,document:await loadAblyCarrierPolicy(tagId)})))).filter(entry=>entry.document);
    const documentByTag=new Map(documents.map(entry=>[entry.tagId,entry.document]));
    const rows=codes.map(sku=>({sku,tags:(memberships.get(sku)||[]).map(tag=>({
      tag_id:cleanText(tag.tag_id),tag_name:cleanText(tag.tag_name)||cleanText(tag.tag_id),is_active:true,document:documentByTag.get(cleanText(tag.tag_id))||null
    }))}));
    const fingerprint=JSON.stringify(rows.map(row=>[row.sku,row.tags.map(tag=>[tag.tag_id,tag.document?.id||'',Number(tag.document?.version||0),tag.document?.body?.carriers?.ably?.representativeStrategy||''])]));
    return {rows,documents,fingerprint};
  }

  async function loadTags() {
    const { data, error } = await db
      .from('product_tags')
      .select('tag_id,tag_name,tag_color,tag_group,display_order,description')
      .eq('is_active', true)
      .order('tag_group')
      .order('display_order')
      .order('tag_name');
    if (error) throw error;
    return data || [];
  }

  async function ensureProductProfile(sku) {
    const {data, error} = await db.rpc('ensure_operations_hub_product_profile', {p_sku:cleanText(sku)});
    if (error) throw error;
    return data || null;
  }

  async function saveProductProfile({sku, material, productGroup, shape, productTagIds = [], skuTagIds = []}) {
    const {data, error} = await db.rpc('hub_profile_save_with_rules_v1', {
      p_session_token:requireOperationsHubSessionToken(),
      p_sku:cleanText(sku),
      p_material:cleanText(material),
      p_product_group:cleanText(productGroup),
      p_shape:cleanText(shape),
      p_product_tag_ids:productTagIds,
      p_sku_tag_ids:skuTagIds
    });
    if (error) throw error;
    return data || null;
  }

  async function createProductTag({name, color = '#dbeafe', group = '운영'}) {
    const tagName = cleanText(name);
    if (!tagName) throw new Error('태그 이름을 입력해주세요.');
    const {data, error} = await db
      .from('product_tags')
      .insert({
        tag_name:tagName,
        tag_color:cleanText(color) || '#dbeafe',
        tag_group:cleanText(group) || '운영',
        created_by:'operations-hub'
      })
      .select('tag_id,tag_name,tag_color,tag_group,display_order,description')
      .single();
    if (error) throw error;
    return data;
  }

  function cleanText(value) {
    return String(value ?? '').trim();
  }

  function readableDatabaseError(error) {
    const parts = [error?.message, error?.hint, error?.details].map(cleanText).filter(Boolean);
    const readable = new Error([...new Set(parts)].join(' · ') || '데이터베이스 요청에 실패했습니다.');
    readable.code = error?.code;
    readable.cause = error;
    return readable;
  }

  function cleanNumber(value, fallback = null) {
    if (value === null || value === undefined || value === '') return fallback;
    const number = Number(String(value).replace(/,/g, '').trim());
    return Number.isFinite(number) ? number : fallback;
  }

  const SELLPIA_REQUIRED_HEADERS = Object.freeze({
    rowNo:['#'],
    sku:['상품코드'],
    ownSku:['자사코드'],
    productName:['상품명'],
    optionName:['옵션명'],
    stock:['재고', '현재고'],
    availableStock:['가용재고'],
    soldOut:['품절', '품절여부'],
    discontinued:['단종', '단종여부'],
    salePrice:['판매가'],
    safetyStock:['안전재고'],
    supplierCode:['매입처코드'],
    supplierName:['매입처'],
    supplierGroup:['매입처그룹'],
    supplierAddress:['매입처주소'],
    supplierMarketName:['상가명'],
    supplierPhone:['매입처전화'],
    purchaseProductName:['매입상품명'],
    purchaseOptionName:['매입옵션명'],
    purchasePrice:['매입가'],
    commission:['수수료', '판매수수료'],
    purchaseVat:['매입처부가세', '매입부가세'],
    orderUnit:['발주단위'],
    minimumOrderUnit:['최소발주수량', '최소발주단위']
  });

  const SELLPIA_OPTIONAL_HEADERS = Object.freeze({
    integratedAvailableStock:['통합가용재고', '통합판매가능재고', '통합가용수량'],
  });

  function normalizeSellpiaHeader(value) {
    return cleanText(value)
      .replace(/^\uFEFF/, '')
      .normalize('NFKC')
      .replace(/[\s_\-()[\]{}·./\\]+/g, '')
      .toLowerCase();
  }

  function sellpiaColumnName(index) {
    let value = Number(index) + 1;
    let result = '';
    while (value > 0) {
      value -= 1;
      result = String.fromCharCode(65 + (value % 26)) + result;
      value = Math.floor(value / 26);
    }
    return result;
  }

  function createSellpiaColumnMap(headerRow, fileName) {
    const headers = Array.isArray(headerRow) ? headerRow : [];
    const normalizedHeaders = headers.map(normalizeSellpiaHeader);
    const columnMap = {};
    const fields = {...SELLPIA_REQUIRED_HEADERS, ...SELLPIA_OPTIONAL_HEADERS};
    for (const [fieldName, aliases] of Object.entries(fields)) {
      const normalizedAliases = aliases.map(normalizeSellpiaHeader);
      const indexes = normalizedHeaders.reduce((found, header, index) => {
        if (normalizedAliases.includes(header)) found.push(index);
        return found;
      }, []);
      const isRequired = Object.prototype.hasOwnProperty.call(SELLPIA_REQUIRED_HEADERS, fieldName);
      if (isRequired && indexes.length !== 1) {
        const expected = aliases.join(' 또는 ');
        if (!indexes.length) throw new Error(`${fileName}: 필수 셀피아 헤더 '${expected}'가 없습니다.`);
        throw new Error(`${fileName}: 필수 셀피아 헤더 '${expected}'가 ${indexes.map(index => `${sellpiaColumnName(index)}1`).join(', ')}에 중복되어 있습니다.`);
      }
      if (indexes.length > 1) {
        throw new Error(`${fileName}: 셀피아 헤더 '${aliases.join(' 또는 ')}'가 ${indexes.map(index => `${sellpiaColumnName(index)}1`).join(', ')}에 중복되어 있습니다.`);
      }
      columnMap[fieldName] = indexes.length ? indexes[0] : -1;
    }
    return columnMap;
  }

  function sellpiaCell(row, columnMap, fieldName) {
    const index = columnMap[fieldName];
    return index === undefined || index < 0 ? null : row[index];
  }

  function sellpiaArrayBufferToBinaryString(buffer) {
    const bytes = new Uint8Array(buffer);
    const chunkSize = 32768;
    const chunks = [];
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      const chunk = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length));
      let text = '';
      for (let index = 0; index < chunk.length; index += 1) text += String.fromCharCode(chunk[index]);
      chunks.push(text);
    }
    return chunks.join('');
  }

  function decodeSellpiaBytes(buffer, fileName) {
    const bytes = new Uint8Array(buffer);
    const Decoder = global.TextDecoder || (typeof TextDecoder === 'function' ? TextDecoder : null);
    if (!Decoder) throw new Error(`${fileName}: 브라우저 TextDecoder를 사용할 수 없습니다.`);
    const hasUtf8Bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
    const strictDecode = (encoding) => new Decoder(encoding, {fatal:true}).decode(bytes);
    try {
      return {text:strictDecode('utf-8'), encoding:hasUtf8Bom ? 'utf-8-bom' : 'utf-8', inputType:'string'};
    } catch (utf8Error) {
      // SheetJS 0.18.5 only restores CP949 headers reliably through a binary
      // string with codepage 949. TextDecoder('euc-kr') can replace CP949 bytes.
      return {text:sellpiaArrayBufferToBinaryString(buffer), encoding:'cp949', inputType:'binary'};
    }
  }

  async function readSellpiaSheetRows(file) {
    if (!global.XLSX) throw new Error('XLSX 파일 해석 모듈을 불러오지 못했습니다.');
    const name = cleanText(file?.name) || '선택한 파일';
    const buffer = await file.arrayBuffer();
    const isDelimited = /\.(csv|tsv|txt)$/i.test(name);
    let workbook;
    let encoding = 'binary';
    if (isDelimited) {
      const decoded = decodeSellpiaBytes(buffer, name);
      encoding = decoded.encoding;
      workbook = global.XLSX.read(decoded.text, {
        type:decoded.inputType,
        raw:true,
        cellDates:false,
        ...(decoded.inputType === 'binary' ? {codepage:949} : {})
      });
    } else {
      // Keep the original ArrayBuffer path for XLSX/XLS; never route binary files through TextDecoder.
      workbook = global.XLSX.read(buffer, {type:'array', cellDates:false});
    }
    const worksheet = workbook.Sheets[workbook.SheetNames[0]];
    if (!worksheet?.['!ref']) throw new Error(`${name}: 첫 시트에 데이터가 없습니다.`);
    const range = global.XLSX.utils.decode_range(worksheet['!ref']);
    range.s.r = 0;
    range.s.c = 0;
    const rows = global.XLSX.utils.sheet_to_json(worksheet, {
      header:1,
      raw:true,
      defval:null,
      blankrows:false,
      range
    });
    return {rows, encoding};
  }

  async function parseSellpiaFile(file, fileIndex, fileCount, onProgress) {
    const fileName = cleanText(file?.name) || '선택한 파일';
    onProgress?.({
      percent: Math.max(2, Math.round((fileIndex / Math.max(1, fileCount)) * 20)),
      title: `${fileName} 읽는 중`,
      detail: `${fileIndex + 1}/${fileCount} 파일의 셀피아 헤더와 SKU를 확인합니다.`
    });
    const {rows, encoding} = await readSellpiaSheetRows(file);
    const columnMap = createSellpiaColumnMap(rows[0], fileName);
    const normalizedRows = [];
    for (const row of rows.slice(1)) {
      const sourceRowNo = cleanNumber(sellpiaCell(row, columnMap, 'rowNo'));
      const sku = cleanText(sellpiaCell(row, columnMap, 'sku'));
      if (!sourceRowNo && !sku) continue;
      if (!Number.isInteger(sourceRowNo) || sourceRowNo < 1) {
        throw new Error(`${fileName}: 행번호가 1 이상의 정수가 아닌 행이 있습니다.`);
      }
      if (!sku) throw new Error(`${fileName}: ${sourceRowNo}행 상품코드가 비어 있습니다.`);
      if (!/^\d+-\d+$/.test(sku)) {
        throw new Error(`${fileName}: ${sourceRowNo}행 SKU '${sku}' 형식이 올바르지 않습니다. CSV 날짜 자동변환 여부를 확인해 주세요.`);
      }
      const productCode = sku.replace(/-\d+$/, '');
      const soldOut = cleanText(sellpiaCell(row, columnMap, 'soldOut'));
      const discontinued = cleanText(sellpiaCell(row, columnMap, 'discontinued'));
      const saleStatus = discontinued ? '단종' : soldOut ? '품절' : '정상';
      const available = cleanNumber(
        sellpiaCell(row, columnMap, 'integratedAvailableStock'),
        cleanNumber(sellpiaCell(row, columnMap, 'availableStock'), 0)
      );
      const salePrice = cleanNumber(sellpiaCell(row, columnMap, 'salePrice'), 0);
      normalizedRows.push({
        sellpia_sku_code: sku,
        sellpia_product_code: productCode,
        sellpia_product_name: cleanText(sellpiaCell(row, columnMap, 'productName')) || null,
        sellpia_option_name: cleanText(sellpiaCell(row, columnMap, 'optionName')) || null,
        own_sku: cleanText(sellpiaCell(row, columnMap, 'ownSku')) || null,
        stock: cleanNumber(sellpiaCell(row, columnMap, 'stock'), 0),
        available_stock: available,
        integrated_available_stock: available,
        safety_stock: cleanNumber(sellpiaCell(row, columnMap, 'safetyStock'), 0),
        source_row_no: sourceRowNo,
        supplier_code: cleanText(sellpiaCell(row, columnMap, 'supplierCode')) || null,
        supplier_name: cleanText(sellpiaCell(row, columnMap, 'supplierName')) || null,
        supplier_group: cleanText(sellpiaCell(row, columnMap, 'supplierGroup')) || null,
        supplier_address: cleanText(sellpiaCell(row, columnMap, 'supplierAddress')) || null,
        supplier_market_name: cleanText(sellpiaCell(row, columnMap, 'supplierMarketName')) || null,
        supplier_phone: cleanText(sellpiaCell(row, columnMap, 'supplierPhone')) || null,
        purchase_product_name: cleanText(sellpiaCell(row, columnMap, 'purchaseProductName')) || null,
        purchase_option_name: cleanText(sellpiaCell(row, columnMap, 'purchaseOptionName')) || null,
        purchase_price: cleanNumber(sellpiaCell(row, columnMap, 'purchasePrice')),
        order_unit: cleanNumber(sellpiaCell(row, columnMap, 'orderUnit')),
        minimum_order_unit: cleanNumber(sellpiaCell(row, columnMap, 'minimumOrderUnit')),
        raw_payload: {
          base_price: salePrice,
          sell_price: salePrice,
          purchase_price: cleanNumber(sellpiaCell(row, columnMap, 'purchasePrice')),
          order_unit: cleanNumber(sellpiaCell(row, columnMap, 'orderUnit')),
          minimum_order_unit: cleanNumber(sellpiaCell(row, columnMap, 'minimumOrderUnit')),
          commission: cleanText(sellpiaCell(row, columnMap, 'commission')),
          purchase_vat: cleanText(sellpiaCell(row, columnMap, 'purchaseVat')),
          sale_status: saleStatus,
          source_file_name: fileName
        }
      });
    }
    if (!normalizedRows.length) throw new Error(`${fileName}: 저장할 셀피아 상품 행이 없습니다.`);
    const rowNumbers = normalizedRows.map(row => row.source_row_no);
    return {
      normalizedRows,
      fileInfo:{
        name:fileName,
        encoding,
        columnCount:(rows[0] || []).length,
        rowCount:normalizedRows.length,
        minRowNo:Math.min(...rowNumbers),
        maxRowNo:Math.max(...rowNumbers),
        schemaStatus:'ok'
      }
    };
  }

  async function parseSellpiaUploadFiles(files, options = {}, onProgress) {
    const selectedFiles = Array.from(files || []);
    const uploadMode = options.mode === 'patch' ? 'patch' : 'full';
    const sharedParser = global.SystemV3SellpiaSourceParser;
    if (sharedParser?.parseSellpiaFiles) {
      const parsed = await sharedParser.parseSellpiaFiles(selectedFiles, {mode:uploadMode, XLSX:global.XLSX}, onProgress);
      if (!parsed?.valid) throw new Error((parsed?.errors || ['셀피아 원본을 확인하지 못했습니다.']).join(' '));
      const rows = Array.isArray(parsed.rows) ? parsed.rows : [];
      const filesMeta = (parsed.files || []).map(file => ({
        name:file.name,
        encoding:file.encoding,
        columnCount:file.columnCount,
        rowCount:file.rowCount,
        minRowNo:file.minRowNo,
        maxRowNo:file.maxRowNo,
        schemaStatus:'ok'
      }));
      if (!rows.length) throw new Error('저장할 셀피아 상품 행이 없습니다.');
      return {
        normalizedRows:rows,
        preflight:{
          valid:true,
          errors:[],
          mode:uploadMode,
          uploadMode,
          rows,
          rowCount:rows.length,
          firstRowNo:rows[0].source_row_no,
          lastRowNo:rows[rows.length - 1].source_row_no,
          duplicateSkuCount:0,
          files:filesMeta
        }
      };
    }
    if (uploadMode === 'full' && selectedFiles.length !== 3) throw new Error('셀피아 전체 교체는 분할 원본 3개가 모두 필요합니다.');
    if (uploadMode === 'patch' && (selectedFiles.length < 1 || selectedFiles.length > 3)) throw new Error('셀피아 부분 갱신 파일을 1개 이상 선택해주세요.');
    const normalizedRows = [];
    const fileInfos = [];
    for (let index = 0; index < selectedFiles.length; index += 1) {
      const parsed = await parseSellpiaFile(selectedFiles[index], index, selectedFiles.length, onProgress);
      normalizedRows.push(...parsed.normalizedRows);
      fileInfos.push(parsed.fileInfo);
    }
    normalizedRows.sort((a, b) => a.source_row_no - b.source_row_no || a.sellpia_sku_code.localeCompare(b.sellpia_sku_code));
    const seenSku = new Set();
    for (let index = 0; index < normalizedRows.length; index += 1) {
      const row = normalizedRows[index];
      const expectedRowNo = index + 1;
      if (uploadMode === 'full' && row.source_row_no !== expectedRowNo) {
        throw new Error(`셀피아 행번호가 ${expectedRowNo}에서 이어지지 않습니다. 실제 값: ${row.source_row_no}`);
      }
      if (seenSku.has(row.sellpia_sku_code)) throw new Error(`중복 셀피아 SKU가 있습니다: ${row.sellpia_sku_code}`);
      seenSku.add(row.sellpia_sku_code);
    }
    if (!normalizedRows.length) throw new Error('저장할 셀피아 상품 행이 없습니다.');
    return {
      normalizedRows,
      preflight:{
        valid:true,
        errors:[],
        mode:uploadMode,
        uploadMode,
        rows:normalizedRows,
        rowCount:normalizedRows.length,
        firstRowNo:normalizedRows[0].source_row_no,
        lastRowNo:normalizedRows[normalizedRows.length - 1].source_row_no,
        duplicateSkuCount:0,
        files:fileInfos
      }
    };
  }

  async function preflightSellpiaFiles(files, options = {}, onProgress) {
    const parsed = await parseSellpiaUploadFiles(files, options, onProgress);
    return parsed.preflight;
  }

  async function loadInventoryCountBaseRows(skus = [], onProgress = null) {
    requireOperationsHubSessionToken();
    const codes=[...new Set((skus||[]).map(cleanText).filter(Boolean))];
    if(!codes.length)return {snapshotId:'no-valid-skus',rows:[]};
    let snapshotId=null;const rows=[];
    for(let offset=0;offset<codes.length;offset+=1000){
      const chunk=codes.slice(offset,offset+1000);
      const {data,error}=await db.rpc('hub_sellpia_stock_sources_read_v1',{p_session_token:requireOperationsHubSessionToken(),p_skus:chunk});
      if(error)throw readableDatabaseError(error);
      if(snapshotId&&data?.snapshot_id&&snapshotId!==data.snapshot_id)throw new Error('재고 비교 도중 최신 Sellpia snapshot이 변경되었습니다. 다시 미리보기해주세요.');
      snapshotId=data?.snapshot_id||snapshotId;
      rows.push(...(data?.rows||[]).map(row=>({sellpia_sku_code:row.sellpia_sku_code,stock:row.sellpia_current_stock,available_stock:row.sellpia_available_stock})));
      onProgress?.({percent:35+Math.round((Math.min(offset+chunk.length,codes.length)/Math.max(1,codes.length))*40),title:'현재 재고 비교 중',detail:`${Math.min(offset+chunk.length,codes.length).toLocaleString('ko-KR')} / ${codes.length.toLocaleString('ko-KR')} SKU 비교`});
    }
    if(!snapshotId)throw new Error('재고조사 반영의 기준이 될 최신 셀피아 원본이 없습니다.');
    return {snapshotId,rows};
  }

  async function previewSellpiaInventoryCount(files, onProgress = null) {
    const parser=global.SystemV3SellpiaInventoryCount;
    if(!parser?.parseFiles||!parser?.buildPreview)throw new Error('재고조사 파일 parser를 불러오지 못했습니다.');
    onProgress?.({percent:2,title:'재고조사 파일 읽는 중',detail:'상품코드·재고·가용재고 헤더와 값을 확인합니다.'});
    const parsed=await parser.parseFiles(files,{XLSX:global.XLSX});
    const skus=parsed.rows.filter(row=>row.status==='valid').map(row=>row.sellpia_sku_code);
    const base=await loadInventoryCountBaseRows(skus,onProgress);
    const preview=parser.buildPreview(parsed,base.rows,{baseSnapshotId:base.snapshotId});
    onProgress?.({percent:100,title:'재고조사 미리보기 완료',detail:`실제 변경 ${preview.summary.changedSkuCount.toLocaleString('ko-KR')}개 · 변경 없음 ${preview.summary.unchangedSkuCount.toLocaleString('ko-KR')}개`});
    return preview;
  }

  async function uploadSellpiaInventoryCount(files, expectedPreview, onProgress = null) {
    const selectedFiles=Array.from(files||[]);
    if(!expectedPreview?.fingerprint||!expectedPreview?.baseSnapshotId)throw new Error('재고조사 미리보기를 먼저 실행해주세요.');
    const preview=await previewSellpiaInventoryCount(selectedFiles,onProgress);
    if(preview.fingerprint!==expectedPreview.fingerprint||preview.baseSnapshotId!==expectedPreview.baseSnapshotId)
      throw new Error('미리보기 이후 파일 또는 최신 셀피아 원본이 바뀌었습니다. 다시 미리보기해주세요.');
    if(!preview.changedRows.length)return {...preview,uploadMode:'inventory_count',uploadedRowCount:0,rowCount:0,affectedSkus:[],matrixAffectedSkus:[],unchanged:true};
    let intentId=null,snapshotId=null,ready=false;
    try{
      const sourceFilesMetadata=[];
      for(let index=0;index<selectedFiles.length;index+=1){
        const file=selectedFiles[index],meta=preview.files?.[index]||{};
        sourceFilesMetadata.push({name:file.name,size:Number(file.size||0),mime_type:file.type||'application/octet-stream',sha256:await sha256File(file),row_count:Number(meta.rowCount||0),column_count:Number(meta.columnCount||0)});
      }
      const requestId=global.crypto?.randomUUID?.();
      if(!requestId)throw new Error('브라우저에서 안전한 업로드 request_id를 생성할 수 없습니다.');
      const intent=await originalBoundaryRequest('upload-init',{
        request_id:requestId,upload_mode:'inventory_count',files:sourceFilesMetadata,
        source_row_count:preview.changedRows.length,
        selected_fields:{inventory_count:true,stock:true,available_stock:true,base_snapshot_id:preview.baseSnapshotId,preview_fingerprint:preview.fingerprint,source_read_row_count:preview.summary.readRowCount}
      });
      intentId=intent.intent_id;snapshotId=intent.snapshot_id;
      if(!intentId||!snapshotId||!Array.isArray(intent.manifest)||intent.manifest.length!==selectedFiles.length)throw new Error('서버 upload intent 응답이 완전하지 않습니다.');
      for(const signed of intent.manifest){
        const index=Number(signed.ordinal)-1,file=selectedFiles[index];
        if(!file||!signed.path||!signed.token)throw new Error('signed upload manifest가 선택 파일과 일치하지 않습니다.');
        onProgress?.({percent:78+Math.round(((index+1)/selectedFiles.length)*5),title:'재고조사 원본 보안 업로드 중',detail:`${file.name} provenance 파일을 저장합니다.`});
        const {error}=await db.storage.from('seller-originals').uploadToSignedUrl(signed.path,signed.token,file,{contentType:file.type||'application/octet-stream',upsert:false});
        if(error)throw error;
      }
      const uploaded=await originalBoundaryRequest('upload-finalize',{intent_id:intentId});
      if(uploaded.status!=='uploaded'&&!['parsing','ready'].includes(uploaded.status))throw new Error('서버가 업로드된 재고조사 manifest를 검증하지 못했습니다.');
      for(let offset=0;offset<preview.changedRows.length;offset+=500){
        const chunk=preview.changedRows.slice(offset,offset+500);
        const {error}=await db.rpc('hub_sellpia_upload_rows_v2',{p_session_token:requireOperationsHubSessionToken(),p_intent_id:intentId,p_rows:chunk});
        if(error)throw readableDatabaseError(error);
        onProgress?.({percent:84+Math.round((Math.min(offset+chunk.length,preview.changedRows.length)/preview.changedRows.length)*10),title:'변경 재고 저장 중',detail:`${Math.min(offset+chunk.length,preview.changedRows.length).toLocaleString('ko-KR')} / ${preview.changedRows.length.toLocaleString('ko-KR')} SKU`});
      }
      const {data,error}=await db.rpc('hub_sellpia_upload_complete_v2',{p_session_token:requireOperationsHubSessionToken(),p_intent_id:intentId});
      if(error)throw readableDatabaseError(error);
      const completed=Array.isArray(data)?data[0]:data;
      if(completed?.status!=='ready')throw new Error('재고조사 stock-only snapshot이 ready 상태로 완료되지 않았습니다.');
      ready=true;
      const affectedSkus=Array.isArray(completed?.affected_skus)?completed.affected_skus:preview.changedRows.map(row=>row.sellpia_sku_code);
      return {...preview,snapshotId,intentId,uploadMode:'inventory_count',boundary:'signed-upload-v2',uploadedRowCount:preview.changedRows.length,rowCount:Number(completed?.row_count||0),affectedSkus,matrixAffectedSkus:affectedSkus};
    }catch(error){
      if(intentId&&!ready)try{await originalBoundaryRequest('upload-abort',{intent_id:intentId,reason:String(error?.message||error).slice(0,1000)});}catch(cleanupError){recordOriginalBoundaryDiagnostic('inventory-count-cleanup-failed',{intentId,message:String(cleanupError?.message||cleanupError)});}
      throw error;
    }
  }

  async function uploadSellpiaSnapshot(files, fields = {}, onProgress) {
    const selectedFiles = Array.from(files || []);
    const parsed = await parseSellpiaUploadFiles(selectedFiles, {mode:fields.mode}, onProgress);
    const {normalizedRows, preflight} = parsed;
    const uploadMode = preflight.uploadMode;
    let intentId=null,snapshotId=null,ready=false;
    try {
      onProgress?.({percent:21,title:'보안 upload manifest 준비 중',detail:'원본 파일 checksum을 순서대로 계산합니다.'});
      const sourceFilesMetadata=[];
      for(let index=0;index<selectedFiles.length;index++){
        const file=selectedFiles[index];
        sourceFilesMetadata.push({name:file.name,size:Number(file.size||0),mime_type:file.type||'application/octet-stream',sha256:await sha256File(file),...preflight.files[index]});
        onProgress?.({percent:21+Math.round(((index+1)/selectedFiles.length)*2),title:'보안 upload manifest 준비 중',detail:`${index+1}/${selectedFiles.length} checksum 준비 완료`});
      }

      const requestId=global.crypto?.randomUUID?.();
      if(!requestId)throw new Error('브라우저에서 안전한 업로드 request_id를 생성할 수 없습니다.');
      const intent=await originalBoundaryRequest('upload-init',{
        request_id:requestId,upload_mode:uploadMode,files:sourceFilesMetadata,
        source_row_count:normalizedRows.length,
        selected_fields:{inventory:Boolean(fields.inventory),price:Boolean(fields.price),basePrice:Boolean(fields.basePrice),purchasePrice:Boolean(fields.purchasePrice),basic:Boolean(fields.basic),status:Boolean(fields.status)}
      });
      intentId=intent.intent_id;snapshotId=intent.snapshot_id;
      if(!intentId||!snapshotId||!Array.isArray(intent.manifest)||intent.manifest.length!==selectedFiles.length)throw new Error('서버 upload intent 응답이 완전하지 않습니다.');

      for(const signed of intent.manifest){
        const index=Number(signed.ordinal)-1,file=selectedFiles[index];
        if(!file||!signed.path||!signed.token)throw new Error('signed upload manifest가 선택 파일과 일치하지 않습니다.');
        onProgress?.({percent:24+Math.round(((index+1)/selectedFiles.length)*5),title:'SELLPIA 원본 보안 업로드 중',detail:`${file.name} 파일을 immutable carrier 경로에 저장합니다.`});
        const {error:uploadError}=await db.storage.from('seller-originals').uploadToSignedUrl(signed.path,signed.token,file,{contentType:file.type||'application/octet-stream',upsert:false});
        if(uploadError)throw uploadError;
      }
      const uploaded=await originalBoundaryRequest('upload-finalize',{intent_id:intentId});
      if(uploaded.status!=='uploaded'&&!['parsing','ready'].includes(uploaded.status))throw new Error('서버가 업로드된 원본 manifest를 검증하지 못했습니다.');

      const chunkSize = 500;
      for (let offset = 0; offset < normalizedRows.length; offset += chunkSize) {
        const chunk = normalizedRows.slice(offset, offset + chunkSize);
        const {error}=await db.rpc('hub_sellpia_upload_rows_v1',{p_session_token:requireOperationsHubSessionToken(),p_intent_id:intentId,p_rows:chunk});
        if (error) throw error;
        const loaded = Math.min(offset + chunk.length, normalizedRows.length);
        onProgress?.({
          percent: 30 + Math.round((loaded / normalizedRows.length) * 64),
          title:'셀피아 DB 보안 import 중',
          detail:`${loaded.toLocaleString('ko-KR')} / ${normalizedRows.length.toLocaleString('ko-KR')} SKU 저장 완료`
        });
      }

      let affectedSkus=normalizedRows.map(row=>row.sellpia_sku_code);
      if(uploadMode==='patch'&&(fields.price||fields.purchasePrice)){
        const {data:priceAffected,error:affectedError}=await db.rpc('operations_hub_sellpia_patch_price_affected_skus',{p_patch_snapshot_id:snapshotId,p_selected_fields:{price:Boolean(fields.price),basePrice:Boolean(fields.basePrice),purchasePrice:Boolean(fields.purchasePrice)}});
        if(affectedError)throw readableDatabaseError(affectedError);
        affectedSkus=Array.isArray(priceAffected)?priceAffected:[];
      }else if(uploadMode==='patch')affectedSkus=[];

      onProgress?.({percent:95,title:uploadMode==='patch'?'셀피아 부분 원본 병합 중':'셀피아 snapshot 완료 중',detail:'서버가 object manifest와 저장 행 수를 다시 확인합니다.'});
      const {data:completeData,error:completeError}=await db.rpc('hub_sellpia_upload_complete_v1',{p_session_token:requireOperationsHubSessionToken(),p_intent_id:intentId});
      if(completeError)throw readableDatabaseError(completeError);
      const completed=Array.isArray(completeData)?completeData[0]:completeData;
      if(completed?.status!=='ready')throw new Error('SELLPIA snapshot이 ready 상태로 완료되지 않았습니다.');
      ready=true;
      const finalRowCount=Number(completed?.row_count||normalizedRows.length);
      onProgress?.({percent:97, title:'매트릭스 연결 중', detail:'최신 셀피아 스냅샷을 통합 매트릭스에 반영합니다.'});
      return {
        snapshotId,intentId,uploadMode,boundary:'signed-upload-v1',
        uploadedRowCount:normalizedRows.length,
        rowCount:finalRowCount,affectedSkus,
        // Calculation scope and Matrix refresh scope are different: stock-only
        // patches still change the displayed rows but need no price calculation.
        matrixAffectedSkus:uploadMode==='patch'?normalizedRows.map(row=>row.sellpia_sku_code):[]
      };
    } catch (error) {
      if(intentId&&!ready)try{await originalBoundaryRequest('upload-abort',{intent_id:intentId,reason:String(error?.message||error).slice(0,1000)});}catch(cleanupError){recordOriginalBoundaryDiagnostic('secure-upload-cleanup-failed',{intentId,message:String(cleanupError?.message||cleanupError)});}
      throw error;
    }
  }

  async function uploadSellerSnapshot(source, files, fields = {}, onProgress) {
    if (!sellerParsers?.parseSellerFiles) throw new Error('판매처 원본 파서를 불러오지 못했습니다.');
    const selectedFiles = Array.from(files || []);
    const selectedFields = {
      inventory:Boolean(fields.inventory),
      price:Boolean(fields.price),
      discount:fields.discount === undefined ? Boolean(fields.price) : Boolean(fields.discount),
      basic:Boolean(fields.basic),
      status:Boolean(fields.status)
    };
    const uploadMode = fields.mode === 'full' ? 'full' : 'patch';
    const {normalizedRows, sourceRowCount, duplicateRowCount, parserVersion} = await sellerParsers.parseSellerFiles(
      source,
      selectedFiles,
      {...selectedFields, mode:uploadMode},
      onProgress
    );
    const sourceFileSize = selectedFiles.reduce((sum, file) => sum + Number(file.size || 0), 0);
    let snapshotId = null;
    try {
      onProgress?.({
        percent:22,
        title:'판매처 DB 작업 생성 중',
        detail:`${normalizedRows.length.toLocaleString('ko-KR')}개 상품·옵션 키를 새 스냅샷으로 준비합니다.`
      });
      const {data:snapshot, error:snapshotError} = await db
        .from('seller_inventory_snapshots')
        .insert({
          source_channel:source,
          source_file_names:selectedFiles.map(file => file.name),
          source_file_size:sourceFileSize,
          source_row_count:sourceRowCount,
          valid_row_count:0,
          invalid_row_count:0,
          upload_status:'uploading',
          upload_mode:uploadMode,
          selected_fields:selectedFields,
          uploaded_by:'operations_hub_frontend',
          metadata:{
            parser_version:parserVersion,
            upload_mode:uploadMode,
            duplicate_row_count:duplicateRowCount,
            source_files:selectedFiles.map(file => ({name:file.name, size:file.size}))
          }
        })
        .select('snapshot_id')
        .single();
      if (snapshotError) throw snapshotError;
      snapshotId = snapshot.snapshot_id;

      const storageFiles = [];
      for (let index = 0; index < selectedFiles.length; index += 1) {
        const file = selectedFiles[index];
        const extension = file.name.includes('.') ? `.${file.name.split('.').pop().toLowerCase().replace(/[^0-9a-z]/g, '')}` : '';
        const path = `${source}/${snapshotId}/${String(index + 1).padStart(2, '0')}${extension}`;
        onProgress?.({
          percent:23 + Math.round(((index + 1) / selectedFiles.length) * 3),
          title:'원본 백업 중',
          detail:`${file.name} 파일을 최신 원본 보관소에 저장합니다.`
        });
        const {error:storageError} = await db.storage
          .from('seller-originals')
          .upload(path, file, {contentType:file.type || 'application/octet-stream', cacheControl:'3600', upsert:false});
        if (storageError) throw storageError;
        storageFiles.push({name:file.name, path, size:Number(file.size || 0), type:file.type || 'application/octet-stream'});
      }
      const {error:storageRecordError} = await db
        .from('seller_inventory_snapshots')
        .update({source_storage_files:storageFiles})
        .eq('snapshot_id', snapshotId);
      if (storageRecordError) throw storageRecordError;

      const chunkSize = 400;
      for (let offset = 0; offset < normalizedRows.length; offset += chunkSize) {
        const chunk = normalizedRows.slice(offset, offset + chunkSize).map(row => ({snapshot_id:snapshotId, ...row}));
        const {error} = await db.from('seller_inventory_snapshot_rows').insert(chunk);
        if (error) throw error;
        const loaded = Math.min(offset + chunk.length, normalizedRows.length);
        onProgress?.({
          percent:22 + Math.round((loaded / normalizedRows.length) * 70),
          title:'판매처 DB 저장 중',
          detail:`${loaded.toLocaleString('ko-KR')} / ${normalizedRows.length.toLocaleString('ko-KR')} 상품·옵션 저장 완료`
        });
      }

      onProgress?.({
        percent:94,
        title:uploadMode === 'patch' ? '부분 원본 병합 중' : '선택 필드 병합 중',
        detail:uploadMode === 'patch'
          ? '파일에 없는 판매처 상품·옵션은 이전 최신 원본에서 그대로 보존합니다.'
          : '파일에 없는 판매처 상품·옵션은 최신 원본에서 제외하고, 선택하지 않은 필드만 보존합니다.'
      });
      const {data:finalizedRows, error:finalizeError} = await db.rpc('finalize_seller_inventory_snapshot', {p_snapshot_id:snapshotId});
      if (finalizeError) throw finalizeError;
      const finalized = Array.isArray(finalizedRows) ? finalizedRows[0] : finalizedRows;
      let affectedSkus=[],calculationScopeWarning='';
      if(selectedFields.price||selectedFields.discount){
        const {data:priceAffected,error:affectedError}=await db.rpc('operations_hub_seller_snapshot_price_affected_skus',{p_snapshot_id:snapshotId});
        if(affectedError)calculationScopeWarning=`판매처 원본은 저장됐지만 가격 영향 범위 조회 실패: ${readableDatabaseError(affectedError).message}`;
        else affectedSkus=Array.isArray(priceAffected)?priceAffected:[];
      }
      onProgress?.({percent:97, title:'매트릭스 연결 중', detail:'최신 판매처 재고·가격을 통합 매트릭스에 반영합니다.'});
      return {
        snapshotId,
        source,
        uploadMode,
        uploadedRowCount:normalizedRows.length,
        rowCount:Number(finalized?.row_count || normalizedRows.length),
        affectedSkus,
        calculationScopeWarning
      };
    } catch (error) {
      if (snapshotId) {
        await db.from('seller_inventory_snapshots').update({
          upload_status:'failed',
          upload_note:String(error?.message || error).slice(0, 1000),
          completed_at:new Date().toISOString()
        }).eq('snapshot_id', snapshotId);
      }
      throw error;
    }
  }

  function normalizeSurveyHeader(value) {
    return cleanText(value).toLowerCase().replace(/[\s_\-./()[\]{}]+/g, '');
  }

  function findSurveyColumn(header, aliases) {
    const normalized = header.map(normalizeSurveyHeader);
    return normalized.findIndex(value => aliases.includes(value));
  }

  async function loadSellpiaMatrixSyncStatus() {
    const {data, error} = await db
      .from('operations_hub_sellpia_matrix_sync_status')
      .select('*')
      .maybeSingle();
    if (error) throw error;
    return data || null;
  }

  async function waitForSellpiaMatrixRebuild(snapshotId, onProgress, options = {}) {
    const expectedSnapshotId = cleanText(snapshotId);
    if (!expectedSnapshotId) throw new Error('재구성할 셀피아 스냅샷 ID가 없습니다.');
    const timeoutMs = Math.max(30000, Number(options.timeoutMs) || 150000);
    const pollMs = Math.max(1000, Number(options.pollMs) || 2000);
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const status = await loadSellpiaMatrixSyncStatus();
      if (cleanText(status?.matrix_snapshot_id) === expectedSnapshotId && !status?.rebuild_pending) {
        onProgress?.({
          percent:99,
          title:'매트릭스 전체 재구성 완료',
          detail:`최신 셀피아 ${Number(status?.matrix_row_count || 0).toLocaleString('ko-KR')}개 SKU 기준으로 재구성했습니다.`
        });
        return status;
      }
      const elapsedSeconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
      onProgress?.({
        percent:98,
        title:'매트릭스 전체 재구성 중',
        detail:`최신 셀피아 SKU로 행을 교체하고 저장된 매칭코드를 다시 연결하는 중입니다. ${elapsedSeconds}초 경과`
      });
      await new Promise(resolve => global.setTimeout(resolve, pollMs));
    }
    throw new Error('셀피아 업로드는 완료됐지만 매트릭스 재구성이 아직 대기 중입니다. 잠시 후 DB 새로고침을 눌러주세요.');
  }

  async function syncTagAssignments({tagId, skus = [], preview = true} = {}) {
    const codes=[...new Set((skus||[]).map(cleanText).filter(Boolean))];
    if(!tagId)throw new Error('동기화할 태그를 확인해주세요.');
    if(codes.length>50000)throw new Error('태그 동기화는 한 번에 최대 50,000 SKU까지 가능합니다.');
    const {data,error}=await db.rpc('hub_tag_bulk_sync_v1',{
      p_session_token:requireOperationsHubSessionToken(),
      p_tag_id:tagId,
      p_skus:codes,
      p_preview:preview!==false
    });
    if(error)throw readableDatabaseError(error);
    return data||{};
  }

  async function loadTagCatalog({search=''} = {}) {
    const {data,error}=await db.rpc('hub_tag_catalog_v1',{
      p_session_token:requireOperationsHubSessionToken(),
      p_search:cleanText(search)
    });
    if(error)throw readableDatabaseError(error);
    return data||{rows:[]};
  }

  async function loadTagMembers({tagId,search='',page=1,pageSize=100} = {}) {
    if(!tagId)throw new Error('조회할 태그를 선택해주세요.');
    const {data,error}=await db.rpc('hub_tag_members_v1',{
      p_session_token:requireOperationsHubSessionToken(),
      p_tag_id:tagId,
      p_search:cleanText(search),
      p_page:Math.max(1,Number(page)||1),
      p_page_size:Math.max(1,Math.min(Number(pageSize)||100,1000))
    });
    if(error)throw readableDatabaseError(error);
    return data||{rows:[],count:0,page:1,page_size:pageSize};
  }

  async function loadTagMemberSearch({tagId,search='',page=1,pageSize=100} = {}) {
    if(!tagId)throw new Error('조회할 태그를 선택해주세요.');
    const query=cleanText(search);
    if(!query||query.length>100)throw new Error('검색어는 1~100자여야 합니다.');
    const {data,error}=await db.rpc('hub_tag_member_search_v2',{
      p_session_token:requireOperationsHubSessionToken(),
      p_tag_id:tagId,
      p_search:query,
      p_page:Math.max(1,Number(page)||1),
      p_page_size:Math.max(1,Math.min(Number(pageSize)||100,100))
    });
    if(error)throw readableDatabaseError(error);
    return data||{rows:[],count:0,page:1,page_size:pageSize};
  }

  async function removeTagMembers({tagId,skus=[]} = {}) {
    const codes=[...new Set((skus||[]).map(cleanText).filter(Boolean))];
    if(!tagId)throw new Error('해제할 태그를 선택해주세요.');
    if(!codes.length)throw new Error('해제할 SKU가 없습니다.');
    const {data,error}=await db.rpc('hub_tag_members_remove_v1',{
      p_session_token:requireOperationsHubSessionToken(),
      p_tag_id:tagId,
      p_skus:codes
    });
    if(error)throw readableDatabaseError(error);
    return data||{};
  }

  async function uploadAuxiliarySellerFile({sourceChannel='ably',sourceRole,file,rowCount=null,matchedCount=null,unresolvedCount=null,metadata={}}={}) {
    if(sourceChannel!=='ably'||sourceRole!=='playauto_product')throw new Error('옵션가·재고 carrier는 Storage에 저장하지 않습니다. 판매처 내보내기에서 로컬 파일을 선택해주세요.');
    if(!file||typeof file.arrayBuffer!=='function')throw new Error('업로드할 파일을 선택해주세요.');
    const baseName=cleanText(file.name)||'playauto.xlsx';
    const id=global.crypto?.randomUUID?.()||String(Date.now());
    const storagePath=`ably/aux/${sourceRole}/${id}/source.xlsx`;
    const uploaded=await db.storage.from('seller-originals').upload(storagePath,file,{upsert:false,contentType:file.type||'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',cacheControl:'3600'});
    if(uploaded.error)throw uploaded.error;
    const {data:registered,error}=await db.rpc('hub_channel_file_register_v1',{
      p_session_token:requireOperationsHubSessionToken(),p_source_channel:sourceChannel,p_source_role:sourceRole,
      p_file_name:baseName,p_storage_path:storagePath,p_mime_type:file.type||null,p_file_size:Number(file.size||0),
      p_row_count:rowCount,p_matched_count:matchedCount,p_unresolved_count:unresolvedCount,p_metadata:metadata||{}
    });
    if(error)throw readableDatabaseError(error);
    return registered||{};
  }

  async function loadAuxiliarySellerFiles(sourceChannel='ably') {
    const {data,error}=await db.rpc('hub_channel_file_status_v1',{p_session_token:requireOperationsHubSessionToken(),p_source_channel:sourceChannel});
    if(error)throw readableDatabaseError(error);
    return data||{source_channel:sourceChannel,rows:[]};
  }

  async function downloadAuxiliarySellerFile(fileIdentity) {
    const record=fileIdentity&&typeof fileIdentity==='object'?fileIdentity:{storage_path:cleanText(fileIdentity)};
    try{
      if(!record.file_id)throw new Error('secure auxiliary download에는 file_id가 필요합니다.');
      const manifest=await originalBoundaryRequest('read-manifest',{kind:'auxiliary',file_id:record.file_id,include_urls:true});
      const stored=manifest?.files?.[0];if(!stored?.signed_url)throw new Error('auxiliary signed URL을 받지 못했습니다.');
      const response=await global.fetch(stored.signed_url,{cache:'no-store'});if(!response.ok)throw new Error(`auxiliary signed download 실패: HTTP ${response.status}`);
      recordOriginalBoundaryDiagnostic('secure-download-ok',{sources:`${manifest.source}:${manifest.source_role}`,files:1});
      return response.blob();
    }catch(error){
      if(error?.operationsHubAuthRequired)throw error;
      const safePath=cleanText(record.storage_path);if(!safePath)throw error;
      recordOriginalBoundaryDiagnostic('secure-download-fallback',{sources:'auxiliary',message:String(error?.message||error)});
      const {data,directError}=await db.storage.from('seller-originals').download(safePath);
      if(directError)throw directError;
      return data;
    }
  }

  async function loadPlayautoSellpiaCatalog(productCodes=null,onQuery=null) {
    const requested=Array.isArray(productCodes)?[...new Set(productCodes.map(cleanText).filter(Boolean))]:null;
    if(requested&&requested.length===0)return [];
    const rows=[];const size=1000;
    if(requested){
      for(let offset=0;offset<requested.length;offset+=100){
        for(let from=0;;from+=size){
          const {data}=await carrierRead('carrier Sellpia catalog',requested.slice(offset,offset+100).length,db.from('sellpia_stock_latest')
            .select('sellpia_sku_code,sellpia_product_code,sellpia_product_name,sellpia_option_name,own_sku')
            .in('sellpia_product_code',requested.slice(offset,offset+100))
            .order('sellpia_sku_code',{ascending:true}).range(from,from+size-1),onQuery);
          rows.push(...(data||[]));
          if(!data||data.length<size)break;
        }
      }
      return rows;
    }
    for(let from=0;;from+=size){
      const {data,error}=await db.from('sellpia_stock_latest')
        .select('sellpia_sku_code,sellpia_product_code,sellpia_product_name,sellpia_option_name,own_sku')
        .order('sellpia_sku_code',{ascending:true}).range(from,from+size-1);
      if(error)throw readableDatabaseError(error);
      rows.push(...(data||[]));
      if(!data||data.length<size)break;
      if(rows.length>100000)throw new Error('셀피아 카탈로그 행 수가 안전 한도를 넘었습니다.');
    }
    return rows;
  }

  async function carrierRead(label,scopeSize,query,onQuery){
    const started=global.performance?.now?.()??Date.now();
    try{
      const result=await query;
      if(result.error)throw readableDatabaseError(result.error);
      onQuery?.({query:label,scope_count:scopeSize,latency_ms:Math.round((global.performance?.now?.()??Date.now())-started),status:'ok',full_snapshot:false});
      return result;
    }catch(error){
      onQuery?.({query:label,scope_count:scopeSize,latency_ms:Math.round((global.performance?.now?.()??Date.now())-started),status:'error',error:String(error?.message||error),full_snapshot:false});
      const failure=new Error(`${label} 조회 실패: ${error?.message||error}`);failure.cause=error;failure.stage=label;throw failure;
    }
  }

  async function loadCarrierSellerMappings({source,identities=[],onQuery=null}={}) {
    const safeSource=cleanText(source);
    const fields={
      smartstore:['smartstore_product_code','smartstore_option_code'],
      makeshop:['makeshop_product_code','makeshop_option_code'],
      ably:['ably_product_code','ably_option_code']
    }[safeSource];
    if(!fields)throw new Error('지원하지 않는 판매처입니다.');
    const productCodes=[...new Set((identities||[]).map(item=>cleanText(item?.product_code??item?.seller_product_code)).filter(Boolean))];
    if(!productCodes.length)return {source:safeSource,rows:[]};
    const rows=[],suppressed=new Set(),activeByIdentity=new Map();
    const mappingKey=(sku,product,option)=>JSON.stringify([cleanText(sku),cleanText(product),cleanText(option)]);
    const identityKey=(product,option)=>JSON.stringify([cleanText(product),cleanText(option)]);
    for(let offset=0;offset<productCodes.length;offset+=100){
      const chunk=productCodes.slice(offset,offset+100);
      const listings=[];
      for(let from=0;;from+=1000){
        const {data}=await carrierRead('carrier active seller listings',chunk.length,db.from('operations_hub_seller_listings')
          .select('listing_id,product_code,option_code')
          .eq('source_channel',safeSource)
          .eq('is_active',true)
          .in('product_code',chunk)
          .order('listing_id',{ascending:true}).range(from,from+999),onQuery);
        listings.push(...(data||[]));
        if(!data||data.length<1000)break;
      }
      const listingById=new Map(listings.map(listing=>[String(listing.listing_id),listing]));
      const listingIds=[...listingById.keys()];
      for(let listingOffset=0;listingOffset<listingIds.length;listingOffset+=500){
        const idChunk=listingIds.slice(listingOffset,listingOffset+500);
        for(let from=0;;from+=1000){
          const {data}=await carrierRead('carrier active listing components',idChunk.length,db.from('operations_hub_listing_components')
            .select('listing_id,sellpia_sku_code')
            .eq('is_active',true)
            .in('listing_id',idChunk)
            .order('component_id',{ascending:true}).range(from,from+999),onQuery);
          for(const component of data||[]){
            const listing=listingById.get(String(component.listing_id)),sku=cleanText(component.sellpia_sku_code);
            if(!listing||!sku)continue;
            const key=identityKey(listing.product_code,listing.option_code);
            if(!activeByIdentity.has(key))activeByIdentity.set(key,new Set());
            activeByIdentity.get(key).add(sku);
          }
          if(!data||data.length<1000)break;
        }
      }
      for(let from=0;;from+=1000){
        const {data}=await carrierRead('carrier link suppressions',chunk.length,db.from('operations_hub_link_suppressions')
          .select('sellpia_sku_code,product_code,option_code')
          .eq('source_channel',safeSource)
          .in('product_code',chunk)
          .order('sellpia_sku_code',{ascending:true}).range(from,from+999),onQuery);
        for(const row of data||[])suppressed.add(mappingKey(row.sellpia_sku_code,row.product_code,row.option_code));
        if(!data||data.length<1000)break;
      }
      for(let from=0;;from+=1000){
        const {data}=await carrierRead('carrier seller identity',chunk.length,db.rpc('hub_carrier_seller_identity_read_v1',{
          p_session_token:requireOperationsHubSessionToken(),
          p_source_channel:safeSource,
          p_product_codes:chunk,
          p_offset:from,
          p_limit:1000
        }),onQuery);
        rows.push(...(data||[]).map(row=>({
          sku:cleanText(row.sellpia_sku_code),
          product_code:cleanText(row.product_code),
          option_code:cleanText(row.option_code)
        })).filter(row=>{
          if(!row.sku||!row.product_code||suppressed.has(mappingKey(row.sku,row.product_code,row.option_code)))return false;
          const active=activeByIdentity.get(identityKey(row.product_code,row.option_code));
          return !active?.size||active.has(row.sku);
        }));
        if(!data||data.length<1000)break;
      }
      for(const listing of listings){
        const active=activeByIdentity.get(identityKey(listing.product_code,listing.option_code));
        for(const sku of active||[])if(!suppressed.has(mappingKey(sku,listing.product_code,listing.option_code)))rows.push({sku,product_code:cleanText(listing.product_code),option_code:cleanText(listing.option_code)});
      }
    }
    const unique=new Map();
    for(const row of rows){const key=mappingKey(row.sku,row.product_code,row.option_code);if(!unique.has(key))unique.set(key,row);}
    return {source:safeSource,rows:[...unique.values()]};
  }

  // The source-price overlay must read the uploaded Sellpia value, never the
  // operational override or a calculated Matrix price.
  async function loadSellpiaSourcePricesForExport({skus=[],onQuery=null}={}) {
    requireOperationsHubSessionToken();
    const requested=[...new Set((skus||[]).map(cleanText).filter(Boolean))],rows=[];
    for(let offset=0;offset<requested.length;offset+=100){
      const batch=requested.slice(offset,offset+100);
      const {data}=await carrierRead('latest Sellpia source sale prices',batch.length,
        db.from('operations_hub_matrix_system_live')
          .select('sellpia_sku_code,sellpia_source_sale_price,sellpia_source_updated_at')
          .in('sellpia_sku_code',batch),onQuery);
      rows.push(...(data||[]));
    }
    const bySku=new Map();
    for(const row of rows){
      const sku=cleanText(row.sellpia_sku_code),value=row.sellpia_source_sale_price;
      if(bySku.has(sku)||!requested.includes(sku))throw Error(`셀피아 원본 판매가 조회 identity 오류: ${sku}`);
      if(value===null||value===undefined||value===''||!Number.isSafeInteger(Number(value))||Number(value)<=0||!row.sellpia_source_updated_at)
        throw Error(`셀피아 최신 원본 판매가를 확인할 수 없습니다: ${sku}`);
      bySku.set(sku,Number(value));
    }
    for(const sku of requested)if(!bySku.has(sku))throw Error(`셀피아 최신 원본 SKU가 없습니다: ${sku}`);
    return bySku;
  }

  async function loadSellpiaStockSourcesForExport({skus=[],onQuery=null}={}) {
    requireOperationsHubSessionToken();
    const requested=[...new Set((skus||[]).map(cleanText).filter(Boolean))],rows=[];
    let snapshotId=null;
    for(let offset=0;offset<requested.length;offset+=1000){
      const chunk=requested.slice(offset,offset+1000),started=performance.now();
      const {data,error}=await db.rpc('hub_sellpia_stock_sources_read_v1',{p_session_token:requireOperationsHubSessionToken(),p_skus:chunk});
      if(error)throw readableDatabaseError(error);
      if(snapshotId&&data?.snapshot_id&&snapshotId!==data.snapshot_id)throw new Error('재고 source 조회 도중 최신 Sellpia snapshot이 변경됐습니다. 다시 미리보기해주세요.');
      snapshotId=data?.snapshot_id||snapshotId;
      rows.push(...(data?.rows||[]));
      onQuery?.({query:'latest Sellpia physical/available stock',scope_count:chunk.length,latency_ms:Math.round(performance.now()-started)});
    }
    const bySku=new Map();
    for(const row of rows){
      const sku=cleanText(row.sellpia_sku_code);
      if(bySku.has(sku))throw new Error(`셀피아 재고 source identity가 중복되었습니다: ${sku}`);
      if(!Number.isSafeInteger(Number(row.sellpia_current_stock))||!Number.isSafeInteger(Number(row.sellpia_available_stock)))throw new Error(`셀피아 재고 source를 확인할 수 없습니다: ${sku}`);
      bySku.set(sku,{sellpia_current_stock:Number(row.sellpia_current_stock),sellpia_available_stock:Number(row.sellpia_available_stock)});
    }
    for(const sku of requested)if(!bySku.has(sku))throw new Error(`셀피아 최신 재고 SKU가 없습니다: ${sku}`);
    return {snapshotId,bySku,rows:[...bySku].map(([sku,value])=>({sku,...value}))};
  }

  async function recordStockExportAudit({batchId,sources=[],stockSource,itemCount=0,manifest=[]}={}) {
    const normalizedSources=[...new Set((sources||[]).map(cleanText).filter(source=>['smartstore','makeshop','ably'].includes(source)))].sort();
    if(!batchId)throw new Error('재고 내보내기 감사 batch id가 없습니다.');
    if(!['stock','available_stock'].includes(stockSource))throw new Error('재고 내보내기 감사 기준이 올바르지 않습니다.');
    if(!normalizedSources.length)throw new Error('재고 내보내기 감사 판매처가 없습니다.');
    const {data,error}=await db.rpc('hub_stock_export_audit_v1',{
      p_session_token:requireOperationsHubSessionToken(),
      p_export_batch_id:batchId,
      p_source_channels:normalizedSources,
      p_stock_source:stockSource,
      p_item_count:Number(itemCount||0),
      p_file_manifest:Array.isArray(manifest)?manifest:[]
    });
    if(error)throw readableDatabaseError(error);
    return data;
  }

  async function loadSystemStocks(skus=[]) {
    const codes=[...new Set((skus||[]).map(cleanText).filter(Boolean))],rows=[];
    for(let offset=0;offset<codes.length;offset+=500){
      const {data,error}=await db.from(MATRIX_VIEW).select('sellpia_sku_code,system_stock').in('sellpia_sku_code',codes.slice(offset,offset+500));
      if(error)throw error;
      rows.push(...(data||[]));
    }
    return rows;
  }

  async function loadMatrixStocksForExport({source,skus=null}={}) {
    const s=cleanText(source);if(!['smartstore','makeshop'].includes(s))throw Error('지원하지 않는 판매처입니다.');
    const ks=Array.isArray(skus)?[...new Set(skus.map(cleanText).filter(Boolean))]:null;
    const fields=['sellpia_sku_code','system_stock',s+'_stock',s+'_product_code',s+'_option_code'].join(',');
    const rows=[];
    if(ks){
      for(let i=0;i<ks.length;i+=500){const {data,error}=await db.from(MATRIX_VIEW).select(fields).in('sellpia_sku_code',ks.slice(i,i+500));if(error)throw readableDatabaseError(error);rows.push(...(data||[]));}
    }else{
      for(let from=0;;from+=1000){const {data,error}=await db.from(MATRIX_VIEW).select(fields).order('sellpia_sku_code',{ascending:true}).range(from,from+999);if(error)throw readableDatabaseError(error);rows.push(...(data||[]));if(!data||data.length<1000)break;}
    }
    return rows.filter(r=>cleanText(r?.[s+'_product_code']));
  }

  async function loadMatrixExportSnapshot({source,skus=null,onProgress=null}={}) {
    const safeSource=cleanText(source);
    if(!['smartstore','makeshop'].includes(safeSource))throw new Error('매트릭스 직접 내보내기는 스마트스토어·메이크샵만 지원합니다.');
    const codes=Array.isArray(skus)?[...new Set(skus.map(cleanText).filter(Boolean))]:null;
    const rows=[];let afterSku=null,snapshotId=null,page=0;
    while(true){
      const {data,error}=await db.rpc('hub_matrix_export_snapshot_v1',{
        p_session_token:requireOperationsHubSessionToken(),
        p_source_channel:safeSource,
        p_skus:codes,
        p_after_sku:afterSku,
        p_limit:1000
      });
      if(error)throw readableDatabaseError(error);
      const result=data||{},chunk=Array.isArray(result.rows)?result.rows:[];
      if(snapshotId&&result.snapshot_id&&result.snapshot_id!==snapshotId)throw new Error('내보내기 도중 최신 판매처 원본이 바뀌었습니다. 새 원본 기준으로 다시 생성해주세요.');
      rows.push(...chunk);snapshotId=result.snapshot_id||snapshotId;page+=1;
      onProgress?.({source:safeSource,loaded:rows.length,page});
      if(!result.has_more||!result.next_cursor||!chunk.length)break;
      if(result.next_cursor===afterSku)throw new Error('매트릭스 내보내기 커서가 진행되지 않았습니다.');
      afterSku=result.next_cursor;
      if(page>100)throw new Error('매트릭스 내보내기 페이지 수가 안전 한도를 넘었습니다.');
    }
    const priceRules=await loadActiveSellerPriceRules();
    return {source:safeSource,snapshotId,rows:rows.map(row=>({...row,active_price_rule:priceRules.has(JSON.stringify([row.sku,safeSource]))}))};
  }

  async function loadActiveSellerPriceRules(){
    // Current assignments, not historical result rule_versions, decide whether a
    // seller price is managed. Do not cache across user QA/tag edits.
    const registry=await ruleRegistry('list');
    const rules=new Map((registry.rules||[]).filter(rule=>rule.is_active).map(rule=>[rule.id,rule]));
    return new Set((registry.assignments||[]).filter(assignment=>{
      const rule=rules.get(assignment.rule_id);
      return rule&&rule.scope===assignment.scope&&rule.target_field===assignment.target_field&&String(rule.target_field).startsWith('platform_');
    }).map(assignment=>JSON.stringify([assignment.sku,assignment.scope])));
  }

  async function loadCarrierMatrixTargets({source,skus=[],onQuery=null}={}) {
    const safeSource=cleanText(source);
    if(!['smartstore','makeshop','ably'].includes(safeSource))throw new Error('지원하지 않는 판매처입니다.');
    const codes=[...new Set((skus||[]).map(cleanText).filter(Boolean))];
    if(!codes.length)return {source:safeSource,rows:[]};
    const drafts=[],priceRules=new Set(),stocks=new Map();
    // The RPC returns current facts/instructions only. Historical materialized
    // calculation rows are audit data and must never gate a current export.
    for(let offset=0;offset<codes.length;offset+=200){
      const chunk=codes.slice(offset,offset+200);
      const {data}=await carrierRead('hub_carrier_effective_inputs_read_v1',chunk.length,db.rpc('hub_carrier_effective_inputs_read_v1',{
        p_session_token:requireOperationsHubSessionToken(),p_source:safeSource,p_skus:chunk
      }),onQuery);
      if(!data||!Array.isArray(data.matrix_rows)||!Array.isArray(data.drafts)||!Array.isArray(data.active_price_skus))throw new Error('carrier 현재 입력 응답 형식이 올바르지 않습니다.');
      drafts.push(...data.drafts);
      for(const sku of data.active_price_skus)priceRules.add(JSON.stringify([sku,safeSource]));
      for(const row of data.matrix_rows)stocks.set(row.sku,row.seller_stock);
    }
    const draftByKey=new Map();
    for(const draft of drafts){
      const key=JSON.stringify([cleanText(draft.sellpia_sku_code),cleanText(draft.field_key)]);
      if(!draftByKey.has(key))draftByKey.set(key,draft);
    }
    const priceSkus=codes.filter(sku=>priceRules.has(JSON.stringify([sku,safeSource]))||draftByKey.has(JSON.stringify([sku,'sellpia_sale_price'])));
    const currentBySku=new Map(),currentErrors=new Map();
    if(priceSkus.length){
      if(!global.HubPlatformRules?.calculate)throw new Error('현재 가격 projection을 사용할 수 없습니다.');
      try{
        const result=await global.HubPlatformRules.calculate(priceSkus,safeSource);
        for(const row of result.rows||[])if(!row.error)currentBySku.set(cleanText(row.sku),{
          platformBase:row.platformBase,platformDiscount:row.platformDiscount,platformOption:row.platformOption,
          platformFinal:row.platformFinal,platformTerms:Array.isArray(row.platformTerms)?row.platformTerms:[],versions:Array.isArray(row.versions)?row.versions:[]
        });
        for(const failure of result.errors||[])if(failure?.sku&&!currentErrors.has(cleanText(failure.sku)))currentErrors.set(cleanText(failure.sku),cleanText(failure.error)||'현재 가격 target 계산 실패');
      }catch(error){for(const sku of priceSkus)currentErrors.set(sku,cleanText(error?.message||error)||'현재 가격 target 계산 실패');}
      for(const sku of priceSkus)if(!currentBySku.has(sku)&&!currentErrors.has(sku))currentErrors.set(sku,'현재 가격 target을 산출하지 못했습니다.');
    }
    const rows=codes.map(sku=>{
      return {
        sku,
        active_price_rule:priceRules.has(JSON.stringify([sku,safeSource])),
        seller_stock:stocks.get(sku)??null,
        stock_draft:draftByKey.get(JSON.stringify([sku,'sellpia_current_stock']))||null,
        price_draft:draftByKey.get(JSON.stringify([sku,'sellpia_sale_price']))||null,
        current_effective_price:currentBySku.get(sku)||null,
        current_effective_error:currentErrors.get(sku)||null
      };
    });
    return {source:safeSource,rows,missingSkus:[]};
  }
  async function deleteUnusedProductTag({id,expectedName}) {
    const {data,error}=await db.rpc('hub_product_tag_safe_delete_v1',{
      p_session_token:requireOperationsHubSessionToken(),p_tag_id:id,p_expected_name:cleanText(expectedName)
    });
    if(error)throw readableDatabaseError(error);
    return data;
  }

  async function retireProductTagCascade({id,expectedName,preview=true,expectedOptionCount=null,expectedProductCount=null,expectedRuleCount=null}={}) {
    if(!id||!cleanText(expectedName))throw new Error('삭제할 태그를 다시 선택해주세요.');
    const {data,error}=await db.rpc('hub_product_tag_retire_cascade_v2',{
      p_session_token:requireOperationsHubSessionToken(),
      p_tag_id:id,
      p_expected_name:cleanText(expectedName),
      p_preview:preview!==false,
      p_expected_option_count:expectedOptionCount,
      p_expected_product_count:expectedProductCount,
      p_expected_rule_count:expectedRuleCount
    });
    if(error)throw readableDatabaseError(error);
    return data||{};
  }

  async function summarizeMatrixStocksForExport({source,skus=null}={}) {
    const snapshot=await loadMatrixExportSnapshot({source,skus});
    let applied=0,draft=0,unapplied=0,missing=0,sourceMissing=0;
    for(const row of snapshot.rows){
      const systemRaw=row.system_stock;
      const systemMissing=systemRaw===null||systemRaw===undefined||systemRaw===''||!Number.isFinite(Number(systemRaw));
      const system=systemMissing?null:Number(systemRaw);
      const sellerRaw=row.source_stock??row.seller_stock;
      const seller=sellerRaw===null||sellerRaw===undefined||sellerRaw===''?null:Number(sellerRaw);
      const draftRaw=row.stock_draft?.after_value;
      const draftValue=draftRaw===null||draftRaw===undefined||draftRaw===''?null:Number(draftRaw);
      const validLocation=Boolean(cleanText(row.source_file_name))&&row.source_row_no!==null&&row.source_row_no!==undefined&&row.source_row_no!==''&&Number.isInteger(Number(row.source_row_no))&&Number(row.source_row_no)>0;
      if(!validLocation)sourceMissing+=1;
      else if(systemMissing)missing+=1;
      else if(seller!==null&&Number.isFinite(seller)&&draftValue!==null&&Number.isFinite(draftValue))draft+=1;
      else if(seller!==null&&Number.isFinite(seller)&&seller===system)applied+=1;
      else unapplied+=1;
    }
    return {total:snapshot.rows.length,applied,draft,unapplied,missing,sourceMissing,same:applied,needs:unapplied};
  }

  async function loadAblyComponentStocks(skus) {
    requireOperationsHubSessionToken();
    const unique=[...new Set(skus.map(cleanText).filter(Boolean))];
    const rows=[];
    for(let offset=0;offset<unique.length;offset+=100) {
      const {data,error}=await db.from('operations_hub_matrix_system_live')
        .select('sellpia_sku_code,display_name,sellpia_option_name,system_stock,system_stock_updated_at,system_base_price,sellpia_source_sale_price')
        .in('sellpia_sku_code',unique.slice(offset,offset+100));
      if(error)throw error;
      rows.push(...(data||[]));
    }
    return rows;
  }
  // Phase 2 opt-in comparison only. Production Matrix/export never calls this reader.
  async function loadMatrixShadowMetadata({source,rows=[],withFingerprints=true}={}) {
    if(!['smartstore','makeshop','ably'].includes(source))throw new Error('지원하지 않는 판매처입니다.');
    const unique=new Map();for(const row of rows){const existing=unique.get(row.sku);if(existing&&JSON.stringify(existing)!==JSON.stringify(row))throw new Error('동일 SKU shadow identity 충돌');unique.set(row.sku,row);}rows=[...unique.values()];
    let versionId=null,snapshotId=null,version=null,compact=false;const result=[];
    const batchSize=200;
    for(let offset=0;offset<rows.length;offset+=batchSize){
      const rpc=typeof fullMatrixReadContext!=='undefined'&&fullMatrixReadContext?'hub_matrix_shadow_compact_batch_v1':'hub_matrix_shadow_metadata_v1';
      const {data,error}=await db.rpc(rpc,{p_session_token:requireOperationsHubSessionToken(),p_source:source,p_rows:rows.slice(offset,offset+batchSize)});
      if(error)throw readableDatabaseError(error);
      if(data?.mode!=='shadow'||data.source!==source||!data.version_id||!Array.isArray(data.rows))throw new Error('shadow 응답 형식 오류');
      if(versionId&&(versionId!==data.version_id||snapshotId!==data.snapshot_id))throw new Error('shadow version 변경');
      versionId=data.version_id;snapshotId=data.snapshot_id;version=data.version;compact=compact||data.compact===true;result.push(...data.rows);
    }
    const fingerprintSkus=result.filter(row=>row.calculated?.some(c=>c.scope===source&&c.result_details?.input_fingerprint)).map(row=>row.sku);
    if(withFingerprints&&fingerprintSkus.length){const fingerprints=await loadInputFingerprints(fingerprintSkus,source);for(const row of result)row.current_input_fingerprint=fingerprints[row.sku]||null;}
    const internalSkus=result.filter(row=>row.calculated?.some(c=>!c.scope&&c.result_details?.input_fingerprint)).map(row=>row.sku);
    if(withFingerprints&&internalSkus.length){const fingerprints=await loadInputFingerprints(internalSkus,'');for(const row of result)row.current_internal_input_fingerprint=fingerprints[row.sku]||null;}
    return {source,mode:'shadow',compact,version_id:versionId,snapshot_id:snapshotId,version,rows:result};
  }
  async function attachMatrixShadow(products,signal){
    if(!global.HubMatrixShadow||global.HubMatrixShadowEnabled===false||!products.length)return products;
    try{
      const payloads=await Promise.all(['smartstore','makeshop','ably'].map(source=>loadMatrixShadowMetadata({source,withFingerprints:false,rows:products.map(product=>global.HubMatrixShadow.request(product,source))})));
      const scopes=['','smartstore','makeshop','ably'];
      const productsBySku=new Map(products.map(product=>[product.sellpia_sku_code,product]));
      const fingerprints=await Promise.all(scopes.map(source=>{const codes=[...new Set(payloads.flatMap(p=>p.rows.filter(r=>r.calculated?.some(c=>c.scope===source&&c.result_details?.input_fingerprint&&(!fullMatrixReadContext||(source?productsBySku.get(r.sku)?.__hubRulePrices?.[source]:productsBySku.get(r.sku)?.__hubInternalPrices?.[c.field])))).map(r=>r.sku)))];return codes.length?loadInputFingerprints(codes,source):{};}));
      for(const payload of payloads)for(const row of payload.rows){row.current_internal_input_fingerprint=fingerprints[0][row.sku]||null;row.current_input_fingerprint=fingerprints[scopes.indexOf(payload.source)][row.sku]||null;}
      throwIfAborted(signal);
      // Attach only __hubShadow; no existing numeric, draft, Rule or mapping projection changes.
      return products.map(product=>payloads.reduce((row,payload)=>global.HubMatrixShadow.annotate(row,payload),product));
    }catch(error){throwIfAborted(signal);if(fullMatrixReadContext)throw error;console.warn('matrix shadow annotation unavailable',error);return products;}
  }
  async function loadBaselineShadow({source,identities=[]}={}) {
    const safeSource=cleanText(source);
    if(!['smartstore','makeshop','ably'].includes(safeSource))throw new Error('지원하지 않는 판매처입니다.');
    const selected=[...new Map(identities.map(row=>{
      const identity={product_code:cleanText(row.product_code),option_code:cleanText(row.option_code)};
      if(!identity.product_code)throw new Error('shadow 비교 상품 identity가 없습니다.');
      return [JSON.stringify(identity),identity];
    })).values()];
    let versionId=null,snapshotId=null;const rows=[];
    for(let offset=0;offset<selected.length;offset+=200){
      const {data,error}=await db.rpc('hub_baseline_shadow_read_v1',{
        p_session_token:requireOperationsHubSessionToken(),p_source:safeSource,p_identities:selected.slice(offset,offset+200)
      });
      if(error)throw readableDatabaseError(error);
      if(data?.mode!=='shadow'||data.source!==safeSource||!data.version_id||!Array.isArray(data.rows))throw new Error('shadow 기준본 응답 형식 오류');
      if(versionId&&(versionId!==data.version_id||snapshotId!==data.snapshot_id))throw new Error('비교 도중 기준본/원본 version이 변경됐습니다. 다시 비교해주세요.');
      versionId=data.version_id;snapshotId=data.snapshot_id;rows.push(...data.rows);
    }
    return {source:safeSource,mode:'shadow',versionId,snapshotId,rows};
  }

  async function baselineCanaryRpc(action, args = {}) {
    if(global.HubReleasePolicy?.previewOnly&&action!=='artifact_read')throw new Error('기준본 갱신은 현재 미리보기 배포에서 사용할 수 없습니다.');
    const names = {plan_register:'hub_baseline_plan_register_v1', artifact_seal:'hub_baseline_artifact_seal_v1', confirm_plan:'hub_baseline_confirm_plan_v1', artifact_read:'hub_baseline_artifact_read_v1'};
    if (!names[action]) throw new Error('Baseline canary action 오류');
    const {data, error} = await db.rpc(names[action], {...args, p_session_token:requireOperationsHubSessionToken()});
    throwOperationsHubRpcError(error);
    return data;
  }

  async function loadInputFingerprints(skus, source = '') {
    const selected=[...new Set(skus)],result={};
    async function read(codes){
      const {data,error}=await db.rpc(fullMatrixReadContext?'hub_matrix_input_fingerprints_batch_v1':'hub_input_fingerprints_v1',{p_session_token:requireOperationsHubSessionToken(),p_skus:codes,p_source:source});
      if(error&&/statement timeout|canceling statement/i.test(error.message)&&codes.length>1){const middle=Math.ceil(codes.length/2);await read(codes.slice(0,middle));await read(codes.slice(middle));return;}
      throwOperationsHubRpcError(error);Object.assign(result,data);
    }
    for(let offset=0;offset<selected.length;offset+=25){
      await read(selected.slice(offset,offset+25));
    }
    return result;
  }

  async function loadSourceSnapshotPair(source, snapshotId = null) {
    if(!['sellpia','smartstore','makeshop','ably'].includes(source))throw Error('Source 오류');
    const table=source==='sellpia'?'sellpia_stock_snapshots':'seller_inventory_snapshots';
    let query=db.from(table).select('snapshot_id,created_at,completed_at,metadata').eq('upload_status','ready');
    if(source!=='sellpia')query=query.eq('source_channel',source);
    const {data,error}=await query.order('created_at',{ascending:false}).order('snapshot_id',{ascending:false}).limit(100);
    throwOperationsHubRpcError(error);
    let target=snapshotId?data.find(r=>r.snapshot_id===snapshotId):data[0];
    if(!target&&snapshotId){
      let targetQuery=db.from(table).select('snapshot_id,created_at,completed_at,metadata').eq('upload_status','ready').eq('snapshot_id',snapshotId);
      if(source!=='sellpia')targetQuery=targetQuery.eq('source_channel',source);
      const response=await targetQuery.limit(1);throwOperationsHubRpcError(response.error);target=response.data?.[0];
    }
    if(!target)throw Error('Ready source snapshot 없음');
    let previousId=target.metadata?.base_snapshot_id||null;
    if(!previousId){
      let previousQuery=db.from(table).select('snapshot_id').eq('upload_status','ready')
        .or(`created_at.lt.${target.created_at},and(created_at.eq.${target.created_at},snapshot_id.lt.${target.snapshot_id})`);
      if(source!=='sellpia')previousQuery=previousQuery.eq('source_channel',source);
      const response=await previousQuery.order('created_at',{ascending:false}).order('snapshot_id',{ascending:false}).limit(1);
      throwOperationsHubRpcError(response.error);previousId=response.data?.[0]?.snapshot_id||null;
    }
    return {snapshotId:target.snapshot_id,previousId};
  }

  async function loadSourceDelta({source,snapshotId,previousId=null,persist=false,requestId=global.crypto.randomUUID(),onProgress} = {}) {
    if(global.HubReleasePolicy?.previewOnly&&persist)throw new Error('원본 변경 기록은 현재 미리보기 배포에서 사용할 수 없습니다.');
    let after=null;const rows=[];
    do{
      const {data,error}=await db.rpc('hub_source_delta_page_v1',{p_session_token:requireOperationsHubSessionToken(),p_source:source,p_snapshot_id:snapshotId,p_previous_id:previousId,p_after:after,p_limit:200,p_request_id:requestId,p_persist:persist});
      throwOperationsHubRpcError(error);rows.push(...data.rows);onProgress?.({processed:rows.length});
      if(data.next_after&&data.next_after===after)throw Error('Source delta cursor 반복');after=data.next_after;
    }while(after);
    return {request:{source,snapshotId,previousId,requestId},rows,summary:global.HubSourceLifecycle.deltaSummary(rows)};
  }

  async function loadBaselineReconcile({source,snapshotId} = {}) {
    let after=null,versionId=null;const rows=[];
    do{
      const {data,error}=await db.rpc('hub_baseline_reconcile_page_v1',{p_session_token:requireOperationsHubSessionToken(),p_source:source,p_snapshot_id:snapshotId,p_expected_version_id:versionId,p_after:after,p_limit:200});
      throwOperationsHubRpcError(error);versionId=data.version_id;rows.push(...data.rows);
      if(data.next_after&&data.next_after===after)throw Error('Reconcile cursor 반복');after=data.next_after;
    }while(after);
    return {...global.HubSourceLifecycle.reconcile(rows),versionId,snapshotId,source};
  }

  const api = {
    loadInputFingerprints,
    loadSourceSnapshotPair,
    loadSourceDelta,
    loadBaselineReconcile,
    baselineCanaryRpc,
    loadMatrixShadowMetadata,
    loadBaselineShadow,
    savePlatformRuleGroup,
    filterRulePlatformSkus,
    loadAllFilteredSkus,
    loadAllSellerUnmatchedSkus,
    applyTagToSkus,
    bulkImportTags,
    syncTagAssignments,
    loadTagCatalog,
    loadTagMembers,
    loadTagMemberSearch,
    removeTagMembers,
    loadAblyCarrierPolicy,
    saveAblyCarrierPolicy,
    loadAblyCarrierPoliciesForSkus,
    uploadAuxiliarySellerFile,
    loadAuxiliarySellerFiles,
    downloadAuxiliarySellerFile,
    loadPlayautoSellpiaCatalog,
    loadCarrierSellerMappings,
    loadSellpiaSourcePricesForExport,
    loadSellpiaStockSourcesForExport,
    recordStockExportAudit,
    loadSystemStocks,
    loadMatrixStocksForExport,
    loadMatrixExportSnapshot,
    loadCarrierMatrixTargets,
    loadCurrentPriceDecisions,
    applyPriceDecision,
    loadPriceDecisionHistory,
    summarizeMatrixStocksForExport,
    saveTagRule,
    loadAblyComponentStocks,
    pageSize: PAGE_SIZE,
    loginOperationsHub,
    checkOperationsHubSession,
    logoutOperationsHub,
    setOperationsHubSessionToken,
    getOriginalBoundaryDiagnostics:()=>originalBoundaryDiagnostics.map(entry=>({...entry})),
    loadProducts,
    loadMatrixGridDataset,
    loadMatrixGridRowsBySkus,
    loadMatrixSellerListingsBySkus,
    loadPendingPurchasePriceRecalculations,
    loadFullMatrixDataset,
    loadProductsBySkus,
    loadProductThumbnailsBySkus,
    loadMatrixExportChunk,
    loadListingGraph,
    searchMatrixSellerListingSkus,
    loadRelationFolders,
    saveRelationFolder,
    archiveRelationFolder,
    searchSellpiaRelationProducts,
    loadSellpiaRelationProduct,
    loadSellpiaRelationVisuals,
    ensureSellpiaRelationNode,
    ensureSellpiaSkuRelationNode,
    ensureSellerRelationNode,
    loadRelationNodes,
    saveRelationEdge,
    updateRelationEdge,
    removeRelationEdge,
    savePriceBasisSelection,
    archiveRelationNode,
    applyRelationBoard,
    saveListingOrganization,
    saveListingComponentParent,
    loadListingConnection,
    saveListingComponent,
    deactivateListingComponent,
    removeListingComponent,
    stageListingInventoryDraft,
    loadDashboardMetrics,
    loadMappingSyncStatus,
    loadSourceStatus,
    loadTags,
    workDocument,
    ruleRegistry,
    productPrice,
    readRepresentativePrices,
    expandRepresentativeMembers,
    materializeRepresentatives,
    assignRules,
    loadRulePlatformSiblings,
    loadFormulaProducts,
    loadInternalFormulaProducts,
    loadSellpiaPatchRows,
    beginCalculationGeneration,
    upsertCalculatedPriceResults,
    loadCalculatedResults,
    loadStoredMatrixPrices,
    loadSiblingOptions,
    updateProductTag,
    renameProductTag,
    deleteUnusedProductTag,
    retireProductTagCascade,
    ensureProductProfile,
    saveProductProfile,
    createProductTag,
    saveSellpiaChanges,
    refreshMasterColumnFromSource,
    runSelectedSourceRefreshBatch,
    searchSellerItems,
    loadSellerProductOptions,
    resolveRelationImportCodes,
    listBundleGraph,
    resolveBundleImportCodes,
    applyBundleImport,
    saveBundleComponent,
    deactivateBundleComponent,
    listSellerBundleGraph,
    resolveSellerBundleImportRows,
    applySellerBundleImport,
    saveSellerBundleComponent,
    deactivateSellerBundleComponent,
    resolveCodeEntries,
    refreshListingGraphCache,
    linkSellerItem,
    previewMappingImport,
    saveProductLinkDraft,
    clearProductLinkDraft,
    linkProductDraftOption,
    saveSellerListing,
    loadChangeQueue,
    loadChangeBatchSummaries,
    previewChangeTargetSafety,
    loadChangeQueueStats,
    loadChangeEvents,
    loadRelationEdgeHistory,
    undoRelationEdgeEvent,
    loadProductHistory,
    validateChangeQueue,
    cancelChangeQueue,
    retryChangeQueue,
    saveSellerValueDraft,
    saveSellerPriceDraft,
    saveSellerDiscountDraft,
    saveSellerProductDiscountDrafts,
    saveSellerProductBaseDrafts,
    loadPricePolicies,
    previewPricePolicy,
    savePricePolicy,
    loadPriceRuleTags,
    loadPriceRuleSets,
    loadInboundCostFormulaTags,
    saveInboundCostFormulaTag,
    deleteInboundCostFormulaTag,
    saveInboundCost,
    loadInboundCostTagSkus,
    savePriceRuleTag,
    savePriceRuleSet,
    deletePriceRuleTag,
    deletePriceRuleSet,
    loadPriceRuleAssignment,
    previewPriceRuleSet,
    savePriceRuleAssignment,
    savePriceRuleAssignmentsBulk,
    stageAssignedPriceDraftsBulk,
    stageSellerInventoryDrafts,
    stageSellerInventoryDraftBatch,
    beginReliableExportJob,
    checkpointReliableExportJob,
    getReliableExportJob,
    countSellerDraftsForExport,
    validateSellerDraftsForExport,
    reviewSellerDraftsForExport,
    loadLatestSellerOriginalStatus,
    downloadLatestSellerOriginals,
    loadLatestSellpiaOriginalStatus,
    downloadLatestSellpiaOriginals,
    prepareSellerExport,
    completeSellerExport,
    confirmChangesApplied,
    uploadSellpiaImage,
    preflightSellpiaFiles,
    previewSellpiaInventoryCount,
    uploadSellpiaInventoryCount,
    uploadSellpiaSnapshot,
    loadSellpiaMatrixSyncStatus,
    waitForSellpiaMatrixRebuild,
    uploadSellerSnapshot,
  };
  for(const [name,fn] of Object.entries(api)){if(typeof fn!=='function'||! /^(save|apply|remove|bulkImport|syncTag|rename|assign|delete|cancel|upsertCalculated|uploadSellpiaSnapshot|uploadSellpiaInventoryCount|uploadSellerSnapshot|productPrice|ruleRegistry)/.test(name))continue;api[name]=async function(...args){const result=await fn(...args);if(args[0]?.preview===true||(['productPrice','ruleRegistry'].includes(name)&&['list','rules','read','members','inspect'].includes(args[0])))return result;const isTargetedSellpia=name==='uploadSellpiaSnapshot'&&result?.uploadMode==='patch'||name==='uploadSellpiaInventoryCount';if(isTargetedSellpia)return result; // The upload UI publishes affected rows only after the server's Matrix rebuild completes.
    if(/^(uploadSellpiaSnapshot|uploadSellpiaInventoryCount|uploadSellerSnapshot)$/.test(name))global.dispatchEvent(new CustomEvent('hub-matrix-source-reloaded'));const codes=new Set();const visit=(v,depth=0)=>{if(depth>5||v==null)return;if(Array.isArray(v)){for(const x of v)if(typeof x==='string'&&/^[^\s]+-\d+$/.test(x))codes.add(x);else visit(x,depth+1);}else if(typeof v==='object')for(const [k,x] of Object.entries(v)){if(['sku','sellpia_sku_code'].includes(k)&&typeof x==='string')codes.add(x);else if(['skus','affectedSkus','affected_skus','rows','assignments','applied'].includes(k))visit(x,depth+1);}};args.forEach(a=>visit(a));visit(result);const tag=args[0]?.tagId||args[0]?.tag_id||(/renameProductTag/.test(name)?args[0]?.id:null);if(tag&&/rename|saveTag/.test(name)&&global.HubMatrixClient?.dataset)global.HubMatrixClient.dataset.tagSkus(tag).forEach(s=>codes.add(s));if(global.HubMatrixClient?.dataset){const input=typeof args[0]==='object'?args[0]:args[1],ids=new Set([input?.id,input?.rule_id,result?.id,result?.rule?.id].filter(Boolean).map(String)),product=input?.product_code;for(const row of global.HubMatrixClient.dataset.rows){const owners=[...Object.values(row.__hubInternalPrices||{}).flatMap(r=>[...(r.activeOutputRules||[]),...(r.versions||[])]),...Object.values(row.__hubRulePrices||{}).flatMap(r=>r.versions||[]),row.__hubRepresentativePrice?.rule].filter(Boolean);if(owners.some(o=>ids.has(String(o.id||o.rule_id)))||product&&String(row.__profile?.sellpia_product_code)===String(product))codes.add(row.sellpia_sku_code);}}
    if(codes.size)global.dispatchEvent(new CustomEvent('hub-matrix-affected',{detail:{skus:[...codes]}}));return result&&typeof result==='object'&&!Array.isArray(result)&&codes.size?{...result,affected_skus:[...codes]}:result;};}
  global.SystemV3Data=Object.freeze(api);
})(window);
