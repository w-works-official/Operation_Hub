(function (global, factory) {
  const api = factory(global);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.SystemV3SellpiaSourceParser = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (global) {
  'use strict';

  const REQUIRED_HEADERS = Object.freeze({
    rowNo:['#'], sku:['상품코드'], ownSku:['자사코드'], productName:['상품명'], optionName:['옵션명'],
    stock:['재고', '현재고'], availableStock:['가용재고'], soldOut:['품절', '품절여부'], discontinued:['단종', '단종여부'],
    salePrice:['판매가'], safetyStock:['안전재고'], supplierCode:['매입처코드'], supplierName:['매입처'],
    supplierGroup:['매입처그룹'], supplierAddress:['매입처주소'], supplierMarketName:['상가명'],
    supplierPhone:['매입처전화'], purchaseProductName:['매입상품명'], purchaseOptionName:['매입옵션명'],
    purchasePrice:['매입가'], commission:['수수료', '판매수수료'], purchaseVat:['매입처부가세', '매입부가세'],
    orderUnit:['발주단위'], minimumOrderUnit:['최소발주수량', '최소발주단위']
  });
  const OPTIONAL_HEADERS = Object.freeze({
    integratedAvailableStock:['통합가용재고', '통합판매가능재고', '통합가용수량']
  });

  function clean(value) { return String(value ?? '').trim(); }
  function number(value, fallback = null) {
    if (value === null || value === undefined || value === '') return fallback;
    const parsed = Number(String(value).replace(/,/g, '').trim());
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  function columnName(index) {
    let value = Number(index) + 1;
    let result = '';
    while (value > 0) { value -= 1; result = String.fromCharCode(65 + (value % 26)) + result; value = Math.floor(value / 26); }
    return result;
  }
  function normalizeHeader(value) {
    return clean(value).replace(/^\uFEFF/, '').normalize('NFKC').replace(/[\s_\-()[\]{}·./\\]+/g, '').toLowerCase();
  }
  function cell(row, columns, key) {
    const index = columns[key];
    return index === undefined || index < 0 ? null : row[index];
  }
  function arrayBufferToBinaryString(buffer) {
    const bytes = new Uint8Array(buffer);
    const chunks = [];
    for (let offset = 0; offset < bytes.length; offset += 32768) {
      const chunk = bytes.subarray(offset, Math.min(offset + 32768, bytes.length));
      let text = '';
      for (let index = 0; index < chunk.length; index += 1) text += String.fromCharCode(chunk[index]);
      chunks.push(text);
    }
    return chunks.join('');
  }

  // UTF-8 is accepted only when it has no malformed sequence. CP949 input is
  // intentionally returned as a binary string for SheetJS codepage:949 parsing.
  function decodeSellpiaBytes(buffer) {
    const bytes = new Uint8Array(buffer);
    const Decoder = global.TextDecoder || (typeof TextDecoder === 'function' ? TextDecoder : null);
    if (!Decoder) throw new Error('브라우저 TextDecoder를 사용할 수 없습니다.');
    const hasBom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
    const decodeUtf8 = () => new Decoder('utf-8', {fatal:true}).decode(bytes);
    try {
      return {text:decodeUtf8(), encoding:hasBom ? 'utf-8-bom' : 'utf-8', inputType:'string'};
    } catch (error) {
      const binaryText = arrayBufferToBinaryString(buffer);
      // Preview text is only for diagnostics and the UMD contract. The actual
      // SheetJS parse below uses binaryText + codepage 949, never this preview.
      const preview = new Decoder('euc-kr', {fatal:false}).decode(bytes);
      return {text:preview, binaryText, encoding:'euc-kr', parserEncoding:'cp949', inputType:'binary'};
    }
  }

  function buildSellpiaColumnMap(headerRow) {
    const headers = Array.isArray(headerRow) ? headerRow : [];
    const normalized = headers.map(normalizeHeader);
    const columns = {};
    const errors = [];
    for (const [key, aliases] of Object.entries({...REQUIRED_HEADERS, ...OPTIONAL_HEADERS})) {
      const candidates = aliases.map(normalizeHeader);
      const indexes = normalized.reduce((result, header, index) => {
        if (candidates.includes(header)) result.push(index);
        return result;
      }, []);
      const required = Object.prototype.hasOwnProperty.call(REQUIRED_HEADERS, key);
      if (required && indexes.length !== 1) {
        const label = aliases.join(' 또는 ');
        errors.push(indexes.length
          ? `필수 헤더 '${label}'가 ${indexes.map(index => `${columnName(index)}1`).join(', ')}에 중복되어 있습니다.`
          : `필수 헤더 '${label}'가 없습니다.`);
      } else if (indexes.length > 1) {
        errors.push(`헤더 '${aliases.join(' 또는 ')}'가 ${indexes.map(index => `${columnName(index)}1`).join(', ')}에 중복되어 있습니다.`);
      }
      columns[key] = indexes.length === 1 ? indexes[0] : -1;
    }
    return {valid:errors.length === 0, columns, errors};
  }

  function rowsFromWorksheet(workbook, XLSX, fileName) {
    const worksheet = workbook?.Sheets?.[workbook?.SheetNames?.[0]];
    if (!worksheet?.['!ref']) throw new Error(`${fileName}: 첫 시트에 데이터가 없습니다.`);
    const range = XLSX.utils.decode_range(worksheet['!ref']);
    range.s.r = 0;
    range.s.c = 0;
    return XLSX.utils.sheet_to_json(worksheet, {header:1, raw:true, defval:null, blankrows:false, range});
  }

  function parseDelimitedMatrix(text, fileName) {
    const delimiter = /\.tsv$/i.test(fileName) ? '\t' : ',';
    const rows = [];
    let row = [];
    let cellValue = '';
    let quoted = false;
    for (let index = 0; index < text.length; index += 1) {
      const character = text[index];
      if (quoted) {
        if (character === '"' && text[index + 1] === '"') { cellValue += '"'; index += 1; }
        else if (character === '"') quoted = false;
        else cellValue += character;
      } else if (character === '"') {
        quoted = true;
      } else if (character === delimiter) {
        row.push(cellValue); cellValue = '';
      } else if (character === '\n' || character === '\r') {
        if (character === '\r' && text[index + 1] === '\n') index += 1;
        row.push(cellValue); cellValue = '';
        if (row.some(value => value !== '')) rows.push(row);
        row = [];
      } else {
        cellValue += character;
      }
    }
    row.push(cellValue);
    if (row.some(value => value !== '')) rows.push(row);
    return rows;
  }

  function readDelimitedRows(decoded, XLSX, fileName) {
    if (!XLSX) {
      if (decoded.inputType !== 'string') throw new Error(`${fileName}: CP949 원본은 XLSX 파서가 필요합니다.`);
      return parseDelimitedMatrix(decoded.text, fileName);
    }
    const workbook = XLSX.read(decoded.binaryText || decoded.text, {
      type:decoded.inputType,
      raw:true,
      cellDates:false,
      ...(decoded.inputType === 'binary' ? {codepage:949} : {})
    });
    return rowsFromWorksheet(workbook, XLSX, fileName);
  }

  function normalizeRows(matrix, columns, fileName) {
    const rows = [];
    for (const source of matrix.slice(1)) {
      const sourceRowNo = number(cell(source, columns, 'rowNo'));
      const sku = clean(cell(source, columns, 'sku'));
      if (!sourceRowNo && !sku) continue;
      if (!Number.isInteger(sourceRowNo) || sourceRowNo < 1) throw new Error(`${fileName}: 행번호가 1 이상의 정수가 아닌 행이 있습니다.`);
      if (!sku) throw new Error(`${fileName}: ${sourceRowNo}행 상품코드가 비어 있습니다.`);
      if (!/^\d+-\d+$/.test(sku)) throw new Error(`${fileName}: ${sourceRowNo}행 SKU '${sku}' 형식이 올바르지 않습니다.`);
      const soldOut = clean(cell(source, columns, 'soldOut'));
      const discontinued = clean(cell(source, columns, 'discontinued'));
      const available = number(cell(source, columns, 'integratedAvailableStock'), number(cell(source, columns, 'availableStock'), 0));
      const salePrice = number(cell(source, columns, 'salePrice'), 0);
      rows.push({
        sellpia_sku_code:sku,
        sellpia_product_code:sku.replace(/-\d+$/, ''),
        sellpia_product_name:clean(cell(source, columns, 'productName')) || null,
        sellpia_option_name:clean(cell(source, columns, 'optionName')) || null,
        own_sku:clean(cell(source, columns, 'ownSku')) || null,
        stock:number(cell(source, columns, 'stock'), 0),
        available_stock:available,
        integrated_available_stock:available,
        safety_stock:number(cell(source, columns, 'safetyStock'), 0),
        source_row_no:sourceRowNo,
        supplier_code:clean(cell(source, columns, 'supplierCode')) || null,
        supplier_name:clean(cell(source, columns, 'supplierName')) || null,
        supplier_group:clean(cell(source, columns, 'supplierGroup')) || null,
        supplier_address:clean(cell(source, columns, 'supplierAddress')) || null,
        supplier_market_name:clean(cell(source, columns, 'supplierMarketName')) || null,
        supplier_phone:clean(cell(source, columns, 'supplierPhone')) || null,
        purchase_product_name:clean(cell(source, columns, 'purchaseProductName')) || null,
        purchase_option_name:clean(cell(source, columns, 'purchaseOptionName')) || null,
        purchase_price:number(cell(source, columns, 'purchasePrice')),
        order_unit:number(cell(source, columns, 'orderUnit')),
        minimum_order_unit:number(cell(source, columns, 'minimumOrderUnit')),
        raw_payload:{
          base_price:salePrice, sell_price:salePrice,
          purchase_price:number(cell(source, columns, 'purchasePrice')),
          order_unit:number(cell(source, columns, 'orderUnit')),
          minimum_order_unit:number(cell(source, columns, 'minimumOrderUnit')),
          commission:clean(cell(source, columns, 'commission')),
          purchase_vat:clean(cell(source, columns, 'purchaseVat')),
          sale_status:discontinued ? '단종' : soldOut ? '품절' : '정상',
          source_file_name:fileName
        }
      });
    }
    if (!rows.length) throw new Error(`${fileName}: 저장할 셀피아 상품 행이 없습니다.`);
    return rows;
  }

  async function parseSellpiaFile(file, options = {}) {
    const XLSX = options.XLSX || global.XLSX;
    const fileName = clean(file?.name) || '선택한 파일';
    try {
      const buffer = await file.arrayBuffer();
      const delimited = /\.(csv|tsv|txt)$/i.test(fileName);
      let encoding = 'binary';
      let matrix;
      if (delimited) {
        const decoded = decodeSellpiaBytes(buffer);
        matrix = readDelimitedRows(decoded, XLSX, fileName);
        let headerMap = buildSellpiaColumnMap(matrix[0]);
        // A rare CP949 byte sequence can also be valid UTF-8. If its schema is
        // not valid, retry the original bytes through SheetJS codepage 949.
        if (!headerMap.valid && decoded.encoding !== 'cp949') {
          const cp949 = {text:arrayBufferToBinaryString(buffer), encoding:'cp949', inputType:'binary'};
          matrix = readDelimitedRows(cp949, XLSX, fileName);
          headerMap = buildSellpiaColumnMap(matrix[0]);
          encoding = cp949.encoding;
        } else {
          encoding = decoded.parserEncoding || decoded.encoding;
        }
        if (!headerMap.valid) throw new Error(`${fileName}: ${headerMap.errors.join(' ')}`);
        return {valid:true, rows:normalizeRows(matrix, headerMap.columns, fileName), headerMap:headerMap.columns, columnCount:(matrix[0] || []).length, encoding, errors:[]};
      }
      if (!XLSX) throw new Error(`${fileName}: XLSX/XLS 원본은 XLSX 파일 해석 모듈이 필요합니다.`);
      const workbook = XLSX.read(buffer, {type:'array', cellDates:false});
      matrix = rowsFromWorksheet(workbook, XLSX, fileName);
      const headerMap = buildSellpiaColumnMap(matrix[0]);
      if (!headerMap.valid) throw new Error(`${fileName}: ${headerMap.errors.join(' ')}`);
      return {valid:true, rows:normalizeRows(matrix, headerMap.columns, fileName), headerMap:headerMap.columns, columnCount:(matrix[0] || []).length, encoding, errors:[]};
    } catch (error) {
      return {valid:false, rows:[], headerMap:null, encoding:null, errors:[String(error?.message || error)]};
    }
  }

  async function parseSellpiaFiles(files, options = {}, onProgress) {
    const selected = Array.from(files || []);
    const mode = options.mode === 'patch' ? 'patch' : 'full';
    const errors = [];
    if (mode === 'full' && selected.length !== 3) errors.push('셀피아 전체 교체는 분할 원본 3개가 모두 필요합니다.');
    if (mode === 'patch' && (selected.length < 1 || selected.length > 3)) errors.push('셀피아 부분 갱신 파일을 1개 이상 선택해주세요.');
    if (errors.length) return {valid:false, mode, rows:[], files:[], errors};
    const rows = [];
    const filesMeta = [];
    for (let index = 0; index < selected.length; index += 1) {
      onProgress?.({percent:Math.max(2, Math.round((index / Math.max(1, selected.length)) * 20)), title:`${clean(selected[index]?.name) || '파일'} 읽는 중`, detail:`${index + 1}/${selected.length} 파일의 셀피아 헤더와 SKU를 확인합니다.`});
      const parsed = await parseSellpiaFile(selected[index], options);
      if (!parsed.valid) { errors.push(...parsed.errors); continue; }
      rows.push(...parsed.rows);
      const rowNumbers = parsed.rows.map(row => row.source_row_no);
      filesMeta.push({
        name:clean(selected[index]?.name) || '선택한 파일', encoding:parsed.encoding,
        columnCount:parsed.columnCount, rowCount:parsed.rows.length,
        minRowNo:Math.min(...rowNumbers), maxRowNo:Math.max(...rowNumbers), schemaStatus:'ok'
      });
    }
    if (errors.length) return {valid:false, mode, rows:[], files:filesMeta, errors};
    rows.sort((a, b) => a.source_row_no - b.source_row_no || a.sellpia_sku_code.localeCompare(b.sellpia_sku_code));
    const seen = new Set();
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      if (mode === 'full' && row.source_row_no !== index + 1) errors.push(`셀피아 행번호가 ${index + 1}에서 이어지지 않습니다. 실제 값: ${row.source_row_no}`);
      if (seen.has(row.sellpia_sku_code)) errors.push(`중복 셀피아 SKU가 있습니다: ${row.sellpia_sku_code}`);
      seen.add(row.sellpia_sku_code);
    }
    if (!rows.length) errors.push('저장할 셀피아 상품 행이 없습니다.');
    const valid = errors.length === 0;
    return {
      valid, mode, rows:valid ? rows : [], files:filesMeta, errors,
      rowCount:valid ? rows.length : 0,
      firstRowNo:valid && rows.length ? rows[0].source_row_no : null,
      lastRowNo:valid && rows.length ? rows[rows.length - 1].source_row_no : null,
      duplicateSkuCount:0
    };
  }

  return {decodeSellpiaBytes, buildSellpiaColumnMap, parseSellpiaFile, parseSellpiaFiles};
});
