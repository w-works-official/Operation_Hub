(function initSellerSourceParsers(global) {
  'use strict';

  const SOURCE_RULES = Object.freeze({
    smartstore:{files:2, maxColumn:67, parserVersion:'operations-hub-smartstore-2026.08.21-v2'},
    makeshop:{files:1, maxColumn:123, parserVersion:'operations-hub-makeshop-2026.08.21-v2'},
    ably:{files:1, maxColumn:28, parserVersion:'operations-hub-ably-2026.08.21-v2'}
  });

  function cleanText(value) {
    return String(value ?? '').replace(/\u00a0/g, ' ').trim();
  }

  function cleanNumber(value, fallback = null) {
    if (value === null || value === undefined || value === '' || value === '-') return fallback;
    const number = Number(String(value).replace(/,/g, '').trim());
    return Number.isFinite(number) ? number : fallback;
  }

  function splitLines(value) {
    const text = cleanText(value);
    return text ? text.split(/\r?\n/).map(item => item.trim()) : [];
  }

  function normalizeDiscountUnit(value) {
    const unit = cleanText(value).toLowerCase();
    if (!unit) return null;
    if (unit.includes('%') || unit.includes('percent')) return 'percent';
    if (unit.includes('원') || unit.includes('amount')) return 'amount';
    return null;
  }

  function applyRounding(value, mode = 'none', unit = 1) {
    if (!Number.isFinite(Number(value))) return null;
    const normalizedUnit = Math.max(1, Number(unit) || 1);
    if (mode === 'down') return Math.floor(Number(value) / normalizedUnit) * normalizedUnit;
    if (mode === 'up') return Math.ceil(Number(value) / normalizedUnit) * normalizedUnit;
    if (mode === 'nearest') return Math.round(Number(value) / normalizedUnit) * normalizedUnit;
    return Number(value);
  }

  function calculateDiscountedBasePrice(basePrice, term) {
    if (!Number.isFinite(Number(basePrice))) return null;
    if (!term || !Number.isFinite(Number(term.value)) || !term.unit) return Number(basePrice);
    const value = Math.abs(Number(term.value));
    let discounted = Number(basePrice);
    if (term.unit === 'percent') discounted *= (1 - value / 100);
    if (term.unit === 'amount') discounted -= value;
    return Math.max(0, applyRounding(discounted, term.rounding_mode, term.rounding_unit));
  }

  function parseMakeshopDiscountTerm({code, title, price, date}) {
    const priceText = cleanText(price);
    if (!cleanText(code) && !cleanText(title) && !priceText && !cleanText(date)) return null;
    const valueMatch = priceText.match(/(-?[\d,.]+)\s*(%|원)/);
    const roundingUnit = priceText.includes('백원') ? 100 : priceText.includes('십원') ? 10 : 1;
    const roundingMode = priceText.includes('올림') ? 'up'
      : priceText.includes('반올림') ? 'nearest'
        : priceText.includes('절사') ? 'down' : 'none';
    return {
      term_key:'period',
      term_type:'period',
      value:cleanNumber(valueMatch?.[1]),
      unit:normalizeDiscountUnit(valueMatch?.[2]),
      rounding_mode:roundingMode,
      rounding_unit:roundingUnit,
      is_baseline:true,
      title:cleanText(title) || null,
      code:cleanText(code) || null,
      period_text:cleanText(date) || null,
      raw_text:priceText || null
    };
  }

  function priceFields(fields, values) {
    const priceSelected = Boolean(fields?.price);
    const discountSelected = fields?.discount === undefined
      ? priceSelected
      : Boolean(fields.discount);
    if (!priceSelected && !discountSelected) {
      return {
        price:null,
        base_price:null,
        option_price:null,
        discounted_base_price:null,
        final_price:null,
        reported_final_price:null,
        discount_calculation_status:null,
        discount_terms:[],
        price_calculation_version:null
      };
    }
    return {
      price:priceSelected ? values.price : null,
      base_price:priceSelected ? values.base_price : null,
      option_price:priceSelected ? values.option_price : null,
      discounted_base_price:discountSelected ? values.discounted_base_price : null,
      final_price:priceSelected ? values.final_price : null,
      reported_final_price:discountSelected ? values.reported_final_price : null,
      discount_calculation_status:discountSelected ? values.discount_calculation_status : null,
      discount_terms:discountSelected ? values.discount_terms : [],
      price_calculation_version:2
    };
  }

  function decodeXmlText(value) {
    return String(value || '')
      .replace(/<[^>]*>/g, '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&')
      .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
      .replace(/&#x([\da-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)));
  }

  function columnIndex(reference) {
    const letters = String(reference || '').match(/^[A-Z]+/i)?.[0]?.toUpperCase() || '';
    let index = 0;
    for (const letter of letters) index = index * 26 + letter.charCodeAt(0) - 64;
    return index - 1;
  }

  function extractXmlAttributes(source) {
    const attributes = {};
    String(source || '').replace(/([\w:]+)="([^"]*)"/g, (_, key, value) => {
      attributes[key] = value;
      return '';
    });
    return attributes;
  }

  function richTextValue(xml) {
    const parts = [];
    String(xml || '').replace(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g, (_, text) => {
      parts.push(decodeXmlText(text));
      return '';
    });
    return parts.join('');
  }

  async function readCompactXlsxRows(file, maxColumn) {
    if (!global.JSZip) throw new Error('대용량 XLSX 보조 해석 모듈을 불러오지 못했습니다.');
    const zip = await global.JSZip.loadAsync(new Uint8Array(await file.arrayBuffer()));
    const workbookXml = await zip.file('xl/workbook.xml')?.async('string');
    const relationshipsXml = await zip.file('xl/_rels/workbook.xml.rels')?.async('string');
    if (!workbookXml || !relationshipsXml) throw new Error(`${file.name}: XLSX 통합문서 정보를 읽지 못했습니다.`);

    const firstSheetAttributes = extractXmlAttributes(workbookXml.match(/<sheet\b([^>]*)\/?>(?:<\/sheet>)?/i)?.[1]);
    const relationshipId = firstSheetAttributes['r:id'];
    let sheetTarget = '';
    relationshipsXml.replace(/<Relationship\b([^>]*)\/?>(?:<\/Relationship>)?/gi, (_, source) => {
      const attributes = extractXmlAttributes(source);
      if (attributes.Id === relationshipId) sheetTarget = attributes.Target || '';
      return '';
    });
    const sheetPath = sheetTarget.startsWith('/')
      ? sheetTarget.slice(1)
      : `xl/${sheetTarget.replace(/^\.\//, '')}`;
    const sheetXml = await zip.file(sheetPath)?.async('string');
    if (!sheetXml) throw new Error(`${file.name}: 첫 번째 시트 XML을 읽지 못했습니다.`);

    const sharedStringsXml = await zip.file('xl/sharedStrings.xml')?.async('string');
    const sharedStrings = [];
    String(sharedStringsXml || '').replace(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g, (_, xml) => {
      sharedStrings.push(richTextValue(xml));
      return '';
    });

    const rows = [];
    sheetXml.replace(/<row\b[^>]*>([\s\S]*?)<\/row>/g, (_, rowXml) => {
      const row = [];
      rowXml.replace(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g, (__, attributeSource, cellXml = '') => {
        const attributes = extractXmlAttributes(attributeSource);
        const index = columnIndex(attributes.r);
        if (index < 0 || index > maxColumn) return '';
        const rawValue = cellXml.match(/<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/)?.[1];
        let value = null;
        if (attributes.t === 's') value = sharedStrings[Number(rawValue)] ?? '';
        else if (attributes.t === 'inlineStr') value = richTextValue(cellXml);
        else if (attributes.t === 'str') value = decodeXmlText(rawValue);
        else if (rawValue !== undefined) {
          const number = Number(rawValue);
          value = rawValue !== '' && Number.isFinite(number) ? number : decodeXmlText(rawValue);
        }
        row[index] = value;
        return '';
      });
      while (row.length && row[row.length - 1] === undefined) row.pop();
      if (row.some(value => value !== undefined && value !== null && value !== '')) rows.push(row);
      return '';
    });
    return rows;
  }

  function selectedValue(fields, name, value) {
    return fields?.[name] ? value : null;
  }

  function findHeader(rows, predicate, sourceName) {
    const index = rows.slice(0, 12).findIndex(predicate);
    if (index < 0) throw new Error(`${sourceName} 원본 헤더를 찾지 못했습니다.`);
    return index;
  }

  function parseSmartstoreRows(rows, fileName, fields) {
    const headerIndex = findHeader(
      rows,
      row => cleanText(row[0]) === '상품번호' && cleanText(row[1]) === '판매자 상품코드' && cleanText(row[18]) === '옵션 재고수량',
      '스마트스토어'
    );
    const output = [];
    rows.slice(headerIndex + 1).forEach((row, relativeIndex) => {
      const productCode = cleanText(row[0]);
      if (!/^\d+$/.test(productCode)) return;
      const sellerCode = cleanText(row[1]) || null;
      const productName = cleanText(row[3]) || null;
      const basePrice = cleanNumber(row[5]);
      const basicDiscountValue = cleanNumber(row[57]);
      const basicDiscountUnit = normalizeDiscountUnit(row[58]);
      const basicDiscount = basicDiscountValue !== null && basicDiscountUnit ? {
        term_key:'basic',
        term_type:'basic',
        value:basicDiscountValue,
        unit:basicDiscountUnit,
        rounding_mode:'nearest',
        rounding_unit:1,
        is_baseline:true,
        title:'즉시할인 기본할인'
      } : null;
      const mobileDiscountValue = cleanNumber(row[59]);
      const mobileDiscountUnit = normalizeDiscountUnit(row[60]);
      const mobileDiscount = mobileDiscountValue !== null && mobileDiscountUnit ? {
        term_key:'mobile',
        term_type:'mobile',
        value:mobileDiscountValue,
        unit:mobileDiscountUnit,
        rounding_mode:'nearest',
        rounding_unit:1,
        is_baseline:false,
        title:'모바일 즉시할인'
      } : null;
      const reservationDiscountValue = cleanNumber(row[61]);
      const reservationDiscountUnit = normalizeDiscountUnit(row[62]);
      const reservationDiscount = reservationDiscountValue !== null && reservationDiscountUnit ? {
        term_key:'reservation',
        term_type:'reservation',
        value:reservationDiscountValue,
        unit:reservationDiscountUnit,
        rounding_mode:'nearest',
        rounding_unit:1,
        is_baseline:false,
        period_text:cleanText(row[63]) || null,
        title:'예약 할인'
      } : null;
      const multiBuyDiscountValue = cleanNumber(row[66]);
      const multiBuyDiscountUnit = normalizeDiscountUnit(row[67]);
      const multiBuyDiscount = multiBuyDiscountValue !== null && multiBuyDiscountUnit ? {
        term_key:'multi_buy',
        term_type:'multi_buy',
        value:multiBuyDiscountValue,
        unit:multiBuyDiscountUnit,
        rounding_mode:'nearest',
        rounding_unit:1,
        is_baseline:false,
        condition_value:cleanNumber(row[64]),
        condition_unit:cleanText(row[65]) || null,
        title:'복수구매 할인'
      } : null;
      const discountTerms = [basicDiscount, mobileDiscount, reservationDiscount, multiBuyDiscount].filter(Boolean);
      const discountedBasePrice = calculateDiscountedBasePrice(basePrice, basicDiscount);
      const optionCodes = splitLines(row[15]);
      const optionNames = splitLines(row[16]);
      const optionPrices = splitLines(row[17]);
      const optionStocks = splitLines(row[18]);
      const optionUse = splitLines(row[19]);
      const sourceRowNo = headerIndex + relativeIndex + 2;

      if (!optionCodes.length) {
        const finalPrice = discountedBasePrice;
        const prices = priceFields(fields, {
          price:finalPrice,
          base_price:basePrice,
          option_price:0,
          discounted_base_price:discountedBasePrice,
          final_price:finalPrice,
          reported_final_price:null,
          discount_calculation_status:basicDiscount ? 'calculated' : 'none',
          discount_terms:discountTerms
        });
        output.push({
          product_code:productCode,
          option_code:'',
          seller_code:selectedValue(fields, 'basic', sellerCode),
          product_name:selectedValue(fields, 'basic', productName),
          option_name:null,
          stock:selectedValue(fields, 'inventory', cleanNumber(row[12])),
          ...prices,
          sale_status:selectedValue(fields, 'status', cleanText(row[4]) || null),
          source_row_no:sourceRowNo,
          raw_payload:{
            source_file_name:fileName,
            base_price:basePrice,
            option_price:0,
            undiscounted_final_price:basePrice,
            smartstore_basic_discount_value:row[57] ?? null,
            smartstore_basic_discount_unit:row[58] ?? null,
            smartstore_mobile_discount_value:row[59] ?? null,
            smartstore_mobile_discount_unit:row[60] ?? null,
            smartstore_reservation_discount_value:row[61] ?? null,
            smartstore_reservation_discount_unit:row[62] ?? null,
            smartstore_reservation_discount_period:row[63] ?? null,
            smartstore_multi_buy_condition_value:row[64] ?? null,
            smartstore_multi_buy_condition_unit:row[65] ?? null,
            smartstore_multi_buy_discount_value:row[66] ?? null,
            smartstore_multi_buy_discount_unit:row[67] ?? null
          }
        });
        return;
      }

      optionCodes.forEach((optionCode, index) => {
        if (!optionCode) return;
        const optionPrice = cleanNumber(optionPrices[index], 0);
        const finalPrice = discountedBasePrice === null ? null : discountedBasePrice + Number(optionPrice || 0);
        const prices = priceFields(fields, {
          price:finalPrice,
          base_price:basePrice,
          option_price:optionPrice,
          discounted_base_price:discountedBasePrice,
          final_price:finalPrice,
          reported_final_price:null,
          discount_calculation_status:basicDiscount ? 'calculated' : 'none',
          discount_terms:discountTerms
        });
        output.push({
          product_code:productCode,
          option_code:optionCode,
          seller_code:selectedValue(fields, 'basic', sellerCode),
          product_name:selectedValue(fields, 'basic', productName),
          option_name:selectedValue(fields, 'basic', optionNames[index] || null),
          stock:selectedValue(fields, 'inventory', cleanNumber(optionStocks[index])),
          ...prices,
          sale_status:selectedValue(fields, 'status', optionUse[index] || cleanText(row[4]) || null),
          source_row_no:sourceRowNo,
          raw_payload:{
            source_file_name:fileName,
            base_price:basePrice,
            option_price:optionPrice,
            undiscounted_final_price:basePrice === null ? null : basePrice + Number(optionPrice || 0),
            smartstore_basic_discount_value:row[57] ?? null,
            smartstore_basic_discount_unit:row[58] ?? null,
            smartstore_mobile_discount_value:row[59] ?? null,
            smartstore_mobile_discount_unit:row[60] ?? null,
            smartstore_reservation_discount_value:row[61] ?? null,
            smartstore_reservation_discount_unit:row[62] ?? null,
            smartstore_reservation_discount_period:row[63] ?? null,
            smartstore_multi_buy_condition_value:row[64] ?? null,
            smartstore_multi_buy_condition_unit:row[65] ?? null,
            smartstore_multi_buy_discount_value:row[66] ?? null,
            smartstore_multi_buy_discount_unit:row[67] ?? null
          }
        });
      });
    });
    return output;
  }

  function parseMakeshopRows(rows, fileName, fields) {
    const headerIndex = findHeader(
      rows,
      isMakeshopHeaderRow,
      '메이크샵'
    );
    const output = [];
    let product = null;
    rows.slice(headerIndex + 1).forEach((row, relativeIndex) => {
      const productCode = cleanText(row[4]);
      if (productCode) {
        product = {
          productCode,
          sellerCode:cleanText(row[39]) || null,
          productName:cleanText(row[12]) || null,
          basePrice:cleanNumber(row[44]),
          productStock:cleanNumber(row[47]),
          saleStatus:cleanText(row[41]) || null,
          periodDiscount:parseMakeshopDiscountTerm({
            code:row[105],
            title:row[106],
            price:row[107],
            date:row[108]
          }),
          membershipDiscount:cleanNumber(row[45], 0) ? {
            term_key:'membership',
            term_type:'membership',
            value:cleanNumber(row[45], 0),
            unit:'percent',
            rounding_mode:'none',
            rounding_unit:1,
            is_baseline:false,
            title:'회원등급 할인'
          } : null,
          powerappExcludedDiscount:cleanText(row[123]) || null
        };
      }
      if (!product) return;
      const optionCode = cleanText(row[43]);
      const hasOptionDetail = optionCode !== '';
      if (!hasOptionDetail && !productCode) return;
      const optionPrice = hasOptionDetail ? cleanNumber(row[31], 0) : 0;
      const discountTerms = [product.periodDiscount, product.membershipDiscount].filter(Boolean);
      const discountedBasePrice = calculateDiscountedBasePrice(product.basePrice, product.periodDiscount);
      const finalPrice = discountedBasePrice === null ? null : discountedBasePrice + Number(optionPrice || 0);
      const prices = priceFields(fields, {
        price:finalPrice,
        base_price:product.basePrice,
        option_price:optionPrice,
        discounted_base_price:discountedBasePrice,
        final_price:finalPrice,
        reported_final_price:null,
        discount_calculation_status:product.periodDiscount ? 'calculated' : 'none',
        discount_terms:discountTerms
      });
      output.push({
        product_code:product.productCode,
        option_code:optionCode,
        seller_code:selectedValue(fields, 'basic', product.sellerCode),
        product_name:selectedValue(fields, 'basic', product.productName),
        option_name:selectedValue(fields, 'basic', hasOptionDetail ? (cleanText(row[29]) || cleanText(row[20]) || null) : null),
        stock:selectedValue(fields, 'inventory', hasOptionDetail ? cleanNumber(row[32]) : product.productStock),
        ...prices,
        sale_status:selectedValue(fields, 'status', cleanText(row[41]) || product.saleStatus),
        source_row_no:headerIndex + relativeIndex + 2,
        raw_payload:{
          source_file_name:fileName,
          base_price:product.basePrice,
          option_price:optionPrice,
          undiscounted_final_price:product.basePrice === null ? null : product.basePrice + Number(optionPrice || 0),
          makeshop_membership_discount:product.membershipDiscount?.value ?? 0,
          makeshop_discount_code:product.periodDiscount?.code ?? null,
          makeshop_discount_title:product.periodDiscount?.title ?? null,
          makeshop_discount_price:product.periodDiscount?.raw_text ?? null,
          makeshop_discount_date:product.periodDiscount?.period_text ?? null,
          makeshop_powerapp_excluded_discount:product.powerappExcludedDiscount
        }
      });
    });
    return output;
  }

  // Official English and Korean workbooks share the same verified physical layout.
  // Match header meaning, not the trailing registration instructions. Keep the
  // three anchors mandatory so unrelated/reordered sheets cannot pass this gate.
  function isMakeshopHeaderRow(row) {
    const token = value => cleanText(value).split(/\r?\n/)[0]
      .replace(/\s*\([^)]*\)\s*$/, '').replace(/\s+/g, '').toLowerCase();
    return ['product_uid', '상품고유번호'].includes(token(row?.[4]))
      && ['sto_stock', '옵션별재고'].includes(token(row?.[32]))
      && ['sell_price', '판매가격'].includes(token(row?.[44]));
  }

  function parseAblyRows(rows, fileName, fields) {
    const headerIndex = findHeader(
      rows,
      row => cleanText(row[0]) === '상품 번호' && cleanText(row[10]) === '옵션 번호' && cleanText(row[15]) === '재고수량',
      '에이블리'
    );
    return rows.slice(headerIndex + 1).flatMap((row, relativeIndex) => {
      const productCode = cleanText(row[0]);
      const optionCode = cleanText(row[10]);
      if (!productCode || !optionCode) return [];
      const basePrice = cleanNumber(row[4]);
      const discountedBasePrice = cleanNumber(row[5], basePrice);
      const reportedFinalPrice = cleanNumber(row[6], discountedBasePrice);
      const discountAmount = basePrice !== null && discountedBasePrice !== null
        ? Math.max(0, basePrice - discountedBasePrice) : null;
      const discountTerm = discountAmount ? {
        term_key:'reported_result',
        term_type:'reported_result',
        value:discountAmount,
        unit:'amount',
        rounding_mode:'none',
        rounding_unit:1,
        is_baseline:true,
        title:'원본 할인 차액',
        reported_discounted_price:discountedBasePrice
      } : null;
      const prices = priceFields(fields, {
        price:reportedFinalPrice,
        base_price:basePrice,
        option_price:0,
        discounted_base_price:discountedBasePrice,
        final_price:reportedFinalPrice,
        reported_final_price:reportedFinalPrice,
        discount_calculation_status:discountTerm
          ? (discountedBasePrice === reportedFinalPrice ? 'reported' : 'reported_mismatch')
          : 'none',
        discount_terms:discountTerm ? [discountTerm] : []
      });
      return [{
        product_code:productCode,
        option_code:optionCode,
        seller_code:selectedValue(fields, 'basic', cleanText(row[1]) || null),
        product_name:selectedValue(fields, 'basic', cleanText(row[2]) || null),
        option_name:selectedValue(fields, 'basic', cleanText(row[14]) || cleanText(row[12]) || null),
        stock:selectedValue(fields, 'inventory', cleanNumber(row[15])),
        ...prices,
        sale_status:selectedValue(fields, 'status', [cleanText(row[18]), cleanText(row[19])].filter(Boolean).join(' · ') || null),
        source_row_no:headerIndex + relativeIndex + 2,
        raw_payload:{
          source_file_name:fileName,
          base_price:basePrice,
          option_price:0,
          undiscounted_final_price:basePrice,
          ably_sale_price:row[4] ?? null,
          ably_discounted_sale_price:row[5] ?? null,
          ably_reported_final_price:row[6] ?? null,
          safety_stock:cleanNumber(row[16])
        }
      }];
    });
  }

  function parseRows(source, rows, fileName, fields) {
    if (source === 'smartstore') return parseSmartstoreRows(rows, fileName, fields);
    if (source === 'makeshop') return parseMakeshopRows(rows, fileName, fields);
    if (source === 'ably') return parseAblyRows(rows, fileName, fields);
    throw new Error(`지원하지 않는 판매처 원본입니다: ${source}`);
  }

  function validateNormalizedRows(source, normalizedRows) {
    if (!normalizedRows.length) throw new Error('저장할 판매처 옵션 행이 없습니다.');
    const unique = new Map();
    for (const row of normalizedRows) {
      const key = `${row.product_code}\u0000${row.option_code}`;
      const previous = unique.get(key);
      if (!previous) {
        unique.set(key, row);
        continue;
      }
      unique.set(key, {
        ...previous,
        ...row,
        raw_payload:{
          ...(previous.raw_payload || {}),
          ...(row.raw_payload || {}),
          duplicate_source_rows:(previous.raw_payload?.duplicate_source_rows || 1) + 1
        }
      });
    }
    return Array.from(unique.values());
  }

  async function readSourceRows(source, file) {
    if (!global.XLSX) throw new Error('XLSX 파일 해석 모듈을 불러오지 못했습니다.');
    if (file.name.toLowerCase().endsWith('.xlsx')) {
      return readCompactXlsxRows(file, SOURCE_RULES[source].maxColumn);
    }
    const workbook = file.name.toLowerCase().endsWith('.csv')
      ? global.XLSX.read(await file.text(), {type:'string', cellDates:false, sheetRows:100000})
      : global.XLSX.read(await file.arrayBuffer(), {type:'array', cellDates:false, sheetRows:100000});
    const worksheet = workbook.Sheets[workbook.SheetNames[0]];
    if (!worksheet?.['!ref']) throw new Error(`${file.name}: 첫 시트에 데이터가 없습니다.`);
    const range = global.XLSX.utils.decode_range(worksheet['!ref']);
    range.s.r = 0;
    range.s.c = 0;
    range.e.c = Math.min(range.e.c, SOURCE_RULES[source].maxColumn);
    return global.XLSX.utils.sheet_to_json(worksheet, {header:1, raw:true, defval:null, blankrows:false, range});
  }

  function validateSelectedFileCount(source, files, fields = {}) {
    const rule = SOURCE_RULES[source];
    if (!rule) throw new Error(`지원하지 않는 판매처 원본입니다: ${source}`);
    const selectedFiles = Array.from(files || []);
    const uploadMode = fields.mode === 'full' ? 'full' : 'patch';
    if (!selectedFiles.length) throw new Error(`${source} 원본 파일을 1개 이상 선택해주세요.`);
    if (selectedFiles.length > rule.files) throw new Error(`${source} 원본 파일은 최대 ${rule.files}개까지 선택할 수 있습니다.`);
    if (uploadMode === 'full' && selectedFiles.length !== rule.files) {
      throw new Error(`${source} 전체 교체에는 원본 파일 ${rule.files}개가 모두 필요합니다.`);
    }
    return selectedFiles;
  }

  async function parseSellerFiles(source, files, fields = {}, onProgress) {
    const rule = SOURCE_RULES[source];
    const selectedFiles = validateSelectedFileCount(source, files, fields);
    const normalizedRows = [];
    let sourceRowCount = 0;
    for (let index = 0; index < selectedFiles.length; index += 1) {
      const file = selectedFiles[index];
      onProgress?.({
        percent:2 + Math.round((index / selectedFiles.length) * 18),
        title:`${file.name} 읽는 중`,
        detail:`${index + 1}/${selectedFiles.length} 파일의 상품·옵션 코드를 확인합니다.`
      });
      const rows = await readSourceRows(source, file);
      sourceRowCount += Math.max(0, rows.length - 1);
      normalizedRows.push(...parseRows(source, rows, file.name, fields));
    }
    const uniqueRows = validateNormalizedRows(source, normalizedRows);
    uniqueRows.sort((a, b) => a.product_code.localeCompare(b.product_code, 'en', {numeric:true}) || a.option_code.localeCompare(b.option_code, 'en', {numeric:true}));
    return {
      normalizedRows:uniqueRows,
      sourceRowCount,
      duplicateRowCount:normalizedRows.length - uniqueRows.length,
      parserVersion:rule.parserVersion
    };
  }

  global.SystemV3SellerParsers = Object.freeze({
    SOURCE_RULES,
    cleanNumber,
    normalizeDiscountUnit,
    calculateDiscountedBasePrice,
    parseMakeshopDiscountTerm,
    parseRows,
    parseSmartstoreRows,
    parseMakeshopRows,
    isMakeshopHeaderRow,
    parseAblyRows,
    validateNormalizedRows,
    validateSelectedFileCount,
    parseSellerFiles
  });
})(typeof window !== 'undefined' ? window : globalThis);
