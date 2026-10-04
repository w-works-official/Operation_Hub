(function initSellerExportAdapter(global) {
  'use strict';

  const SOURCE_LABELS = {smartstore:'스마트스토어', makeshop:'메이크샵', ably:'에이블리'};
  const FIELD_LABELS = {sellpia_current_stock:'재고', sellpia_sale_price:'판매가', seller_product_name:'상품명', seller_option_name:'옵션명'};

  function clean(value) { return String(value ?? '').trim(); }
  function scalar(value) {
    if (value && typeof value === 'object') return value;
    return value === null || value === undefined ? '' : value;
  }
  function xmlEscape(value) {
    return String(value ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
  function xmlDecode(value) {
    const node = global.document?.createElement?.('textarea');
    if (node) { node.innerHTML = String(value || ''); return node.value; }
    return String(value || '')
      .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
      .replace(/&#(\d+);/g, (_, decimal) => String.fromCodePoint(Number(decimal)))
      .replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&amp;/g,'&');
  }
  function extractXmlAttributes(source) {
    const attrs = {}; String(source || '').replace(/([\w:]+)="([^"]*)"/g,(_,key,value)=>{ attrs[key]=value; return ''; }); return attrs;
  }
  function richTextValue(xml) {
    const parts=[]; String(xml||'').replace(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g,(_,text)=>{parts.push(xmlDecode(text));return '';}); return parts.join('');
  }
  function columnIndex(reference) {
    const letters=String(reference||'').match(/^[A-Z]+/i)?.[0]?.toUpperCase()||''; let index=0;
    for(const letter of letters) index=index*26+letter.charCodeAt(0)-64; return index-1;
  }
  function cellValue(rowXml, reference, sharedStrings=[]) {
    const match=String(rowXml||'').match(new RegExp(`<c\\b([^>]*\\br="${reference}"[^>]*)>([\\s\\S]*?)<\\/c>`));
    if(!match) return '';
    const attrs=extractXmlAttributes(match[1]); const body=match[2]; const raw=body.match(/<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/)?.[1];
    if(attrs.t==='s') return sharedStrings[Number(raw)]??'';
    if(attrs.t==='inlineStr') return richTextValue(body);
    return raw===undefined?'':xmlDecode(raw);
  }
  function setCellValue(rowXml, reference, value, type='number') {
    const matcher=new RegExp(`<c\\b([^>]*\\br="${reference}"[^>]*)>[\\s\\S]*?<\\/c>`);
    const current=String(rowXml||'').match(matcher);
    const style=current?.[1]?.match(/\bs="[^"]+"/)?.[0];
    const attrs=[`r="${reference}"`,style].filter(Boolean).join(' ');
    const cell=type==='string'
      ? `<c ${attrs} t="inlineStr"><is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>`
      : `<c ${attrs}><v>${Number(value)}</v></c>`;
    return current ? rowXml.replace(matcher,cell) : rowXml.replace('</row>',`${cell}</row>`);
  }
  function xmlNodes(sectionXml, tagName) {
    return [...String(sectionXml || '').matchAll(new RegExp(`<${tagName}\\b[^>]*?\\/>|<${tagName}\\b[^>]*>[\\s\\S]*?<\\/${tagName}>`, 'g'))].map(match => match[0]);
  }
  function xmlAttribute(source, name, fallback = '') {
    return String(source || '').match(new RegExp(`\\b${name}="([^"]*)"`))?.[1] ?? fallback;
  }
  function setXmlAttribute(source, name, value) {
    const matcher = new RegExp(`\\b${name}="[^"]*"`);
    if (matcher.test(source)) return source.replace(matcher, `${name}="${value}"`);
    return source.replace(/^<([\w:]+)/, `<$1 ${name}="${value}"`);
  }
  function appendStyleNodes(stylesXml, tagName, nodes, count) {
    if (!nodes.length) return stylesXml;
    const matcher = new RegExp(`<${tagName}\\b([^>]*)>([\\s\\S]*?)<\\/${tagName}>`);
    return String(stylesXml).replace(matcher, (_, attrs, body) => {
      const nextAttrs = `${attrs.replace(/\s*count="[^"]*"/g, '')} count="${count}"`;
      return `<${tagName}${nextAttrs}>${body}${nodes.join('')}</${tagName}>`;
    });
  }
  function boldFont(fontXml) {
    if (/<b\b[^>]*\/>/.test(fontXml)) return fontXml.replace(/<b\b[^>]*\/>/, '<b/>');
    if (/<b\b[^>]*>[\s\S]*?<\/b>/.test(fontXml)) return fontXml.replace(/<b\b[^>]*>[\s\S]*?<\/b>/, '<b/>');
    return fontXml.replace(/<font\b([^>]*)>/, '<font$1><b/>');
  }
  function fontIsBold(fontXml) {
    const match = String(fontXml || '').match(/<b\b([^>]*)\/>/);
    if (!match) return false;
    const value = xmlAttribute(match[0], 'val', '1').toLowerCase();
    return value !== '0' && value !== 'false';
  }
  function setCellStyle(sheetXml, reference, styleId) {
    const matcher = new RegExp(`<c\\b([^>]*\\br="${reference}"[^>]*)>`);
    return String(sheetXml).replace(matcher, (_, attrs) => {
      const cleanAttrs = attrs.replace(/\s+s="[^"]*"/, '').replace(/\s+$/, '');
      return `<c${cleanAttrs} s="${styleId}">`;
    });
  }
  function normalizeHighlights(changes) {
    const byReference = new Map();
    for (const change of changes || []) {
      const reference = typeof change === 'string' ? change : change?.reference;
      if (!reference) continue;
      if (!byReference.has(reference)) byReference.set(reference, {reference, full:false, lineIndexes:new Set()});
      const highlight = byReference.get(reference);
      const rawLineIndex = typeof change === 'object' ? change?.lineIndex : null;
      const lineIndex = rawLineIndex === null || rawLineIndex === undefined || rawLineIndex === '' ? NaN : Number(rawLineIndex);
      if (!Number.isInteger(lineIndex) || lineIndex < 0) highlight.full = true;
      else highlight.lineIndexes.add(lineIndex);
    }
    return [...byReference.values()];
  }
  function boldInlineText(sheetXml, highlight) {
    const reference = highlight.reference;
    const matcher = new RegExp(`<c\\b([^>]*\\br="${reference}"[^>]*)>([\\s\\S]*?)<\\/c>`);
    let applied = false;
    const nextSheetXml = String(sheetXml).replace(matcher, (cellXml, attrs, body) => {
      if (xmlAttribute(attrs, 't') !== 'inlineStr') return cellXml;
      const lines = richTextValue(body).split(/\r?\n/);
      const runs = lines.map((line, index) => {
        const text = `${line}${index < lines.length - 1 ? '\n' : ''}`;
        const bold = highlight.full || highlight.lineIndexes.has(index);
        return `<r>${bold ? '<rPr><b/></rPr>' : ''}<t xml:space="preserve">${xmlEscape(text)}</t></r>`;
      }).join('');
      applied = true;
      return `<c${attrs}><is>${runs}</is></c>`;
    });
    return {sheetXml:nextSheetXml, applied};
  }
  function applyChangeHighlights(sheetXml, stylesXml, changes, {fillColor='FFFFFF00',preserveText=false}={}) {
    if(!/^[A-F0-9]{8}$/i.test(fillColor))throw new Error('XLSX 강조 색상 형식이 올바르지 않습니다.');
    const highlights = normalizeHighlights(changes);
    if (!highlights.length) return {sheetXml, stylesXml};
    const fontsSection = String(stylesXml).match(/<fonts\b[^>]*>[\s\S]*?<\/fonts>/)?.[0];
    const fillsSection = String(stylesXml).match(/<fills\b[^>]*>[\s\S]*?<\/fills>/)?.[0];
    const xfsSection = String(stylesXml).match(/<cellXfs\b[^>]*>[\s\S]*?<\/cellXfs>/)?.[0];
    if (!fontsSection || !fillsSection || !xfsSection) throw new Error('원본 XLSX 스타일 정보를 읽지 못했습니다.');

    const fonts = xmlNodes(fontsSection, 'font');
    const fills = xmlNodes(fillsSection, 'fill');
    const xfs = xmlNodes(xfsSection, 'xf');
    const addedFonts = [];
    const boldFontBySource = new Map();
    const addedXfs = [];
    const highlightedStyleByBase = new Map();
    const yellowFillId = fills.length;

    function highlightedStyle(baseStyleId, boldCell) {
      const safeBaseId = xfs[baseStyleId] ? baseStyleId : 0;
      const styleKey = `${safeBaseId}:${boldCell ? 'bold' : 'fill'}`;
      if (highlightedStyleByBase.has(styleKey)) return highlightedStyleByBase.get(styleKey);
      const baseXf = xfs[safeBaseId] || '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>';
      const sourceFontId = Number(xmlAttribute(baseXf, 'fontId', '0')) || 0;
      let boldFontId = sourceFontId;
      if (boldCell && !fontIsBold(fonts[sourceFontId])) {
        if (!boldFontBySource.has(sourceFontId)) {
          boldFontBySource.set(sourceFontId, fonts.length + addedFonts.length);
          addedFonts.push(boldFont(fonts[sourceFontId] || '<font/>'));
        }
        boldFontId = boldFontBySource.get(sourceFontId);
      }
      let nextXf = boldCell ? setXmlAttribute(baseXf, 'fontId', boldFontId) : baseXf;
      nextXf = setXmlAttribute(nextXf, 'fillId', yellowFillId);
      if (boldCell) nextXf = setXmlAttribute(nextXf, 'applyFont', '1');
      nextXf = setXmlAttribute(nextXf, 'applyFill', '1');
      const nextStyleId = xfs.length + addedXfs.length;
      addedXfs.push(nextXf);
      highlightedStyleByBase.set(styleKey, nextStyleId);
      return nextStyleId;
    }

    const byReference = new Map(highlights.map(highlight => [highlight.reference, highlight]));
    // Visit the sheet once; text/style edits below only scan the matching cell.
    const nextSheetXml = String(sheetXml).replace(/<c\b([^>]*?)(?:\/>|>[\s\S]*?<\/c>)/g, (cellXml, cellAttrs) => {
      const highlight = byReference.get(xmlAttribute(cellAttrs, 'r'));
      if (!highlight) return cellXml;
      const baseStyleId = Number(xmlAttribute(cellAttrs, 's', '0')) || 0;
      const richText = preserveText?{sheetXml:cellXml,applied:false}:boldInlineText(cellXml, highlight);
      const styleId = highlightedStyle(baseStyleId, !preserveText&&!richText.applied);
      return richText.sheetXml.replace(/^<c\b[^>]*>/, opening => opening.replace(/\s+s="[^"]*"/, '').replace(/\s*(\/?>)$/, ` s="${styleId}"$1`));
    });
    const yellowFill = `<fill><patternFill patternType="solid"><fgColor rgb="${fillColor}"/><bgColor indexed="64"/></patternFill></fill>`;
    let nextStylesXml = appendStyleNodes(stylesXml, 'fonts', addedFonts, fonts.length + addedFonts.length);
    nextStylesXml = appendStyleNodes(nextStylesXml, 'fills', [yellowFill], fills.length + 1);
    nextStylesXml = appendStyleNodes(nextStylesXml, 'cellXfs', addedXfs, xfs.length + addedXfs.length);
    return {sheetXml:nextSheetXml, stylesXml:nextStylesXml};
  }
  function replaceLine(value,index,next) {
    const lines=String(value??'').split(/\r?\n/); while(lines.length<=index) lines.push(''); lines[index]=String(next??''); return lines.join('\n');
  }
  function sameValue(left,right,field) {
    if(field==='sellpia_current_stock'||field==='sellpia_sale_price') {
      const numericValue=value=>{
        const text=clean(value);
        if(!text.includes(',')) return Number(value);
        return /^[+-]?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(text)?Number(text.replace(/,/g,'')):NaN;
      };
      const actual=numericValue(left),expected=numericValue(right);
      return Number.isFinite(actual)&&Number.isFinite(expected)&&actual===expected;
    }
    return clean(left)===clean(right);
  }
  function exportConflict(item,message) {
    const error=new Error(message); error.exportConflict=true; error.exportItem=item; return error;
  }
  function verifyExpected(actual,item) {
    const expected=scalar(item.expected_source_value);
    if(expected===''||expected===null) return;
    if(!sameValue(actual,expected,item.field_key)) throw exportConflict(item,`${SOURCE_LABELS[item.source_channel]} ${item.sellpia_sku_code}: DB 스냅샷 값(${expected})과 보관 원본 값(${actual})이 다릅니다.`);
  }

  function applyNativeDiscount(basePrice, value, unit, roundingMode='nearest', roundingUnit=1) {
    let discounted=Number(basePrice);
    const amount=Math.abs(Number(value));
    if(!Number.isFinite(discounted)||!Number.isFinite(amount)) return discounted;
    if(String(unit).includes('%')) discounted*=1-amount/100;
    else if(String(unit).includes('원')) discounted-=amount;
    const step=Math.max(1,Number(roundingUnit)||1);
    if(roundingMode==='down') discounted=Math.floor(discounted/step)*step;
    else if(roundingMode==='up') discounted=Math.ceil(discounted/step)*step;
    else discounted=Math.round(discounted/step)*step;
    return Math.max(0,discounted);
  }
  function smartstoreDiscountedBase(rowXml,row,sharedStrings,basePrice) {
    const value=cellValue(rowXml,`BF${row}`,sharedStrings);
    const unit=clean(cellValue(rowXml,`BG${row}`,sharedStrings));
    return value===''||!unit?Number(basePrice):applyNativeDiscount(basePrice,value,unit);
  }
  function makeshopDiscountedBase(rowXml,row,sharedStrings,basePrice) {
    const raw=clean(cellValue(rowXml,`DD${row}`,sharedStrings));
    const match=raw.match(/(-?[\d,.]+)\s*(%|원)/);
    if(!match) return Number(basePrice);
    const roundingUnit=raw.includes('백원')?100:raw.includes('십원')?10:1;
    const roundingMode=raw.includes('올림')?'up':raw.includes('반올림')?'nearest':raw.includes('절사')?'down':'nearest';
    return applyNativeDiscount(basePrice,String(match[1]).replace(/,/g,''),match[2],roundingMode,roundingUnit);
  }

  function priceTargets(item) {
    const base=Number(item.target_base_price);
    const discountedBase=Number(item.target_discounted_base_price ?? item.target_base_price);
    const option=Number(item.target_option_price ?? 0);
    const finalPrice=Number(item.target_final_price ?? scalar(item.after_value));
    if(!Number.isFinite(base)||!Number.isFinite(discountedBase)||!Number.isFinite(option)||!Number.isFinite(finalPrice)) throw exportConflict(item,`${SOURCE_LABELS[item.source_channel]} ${item.sellpia_sku_code}: 판매가·할인 적용 판매가·옵션가·최종구매가 계산값이 없습니다.`);
    if(base<0||discountedBase<0||finalPrice<0||discountedBase+option!==finalPrice) throw exportConflict(item,`${SOURCE_LABELS[item.source_channel]} ${item.sellpia_sku_code}: 할인 적용 판매가 ${discountedBase} + 옵션가 ${option}가 최종구매가 ${finalPrice}와 일치하지 않습니다.`);
    if(item.source_channel==='smartstore'&&item.pricing_input_mode==='sellpia_source') {
      const allowed=Math.floor((base*0.5)/10)*10;
      if(![base,discountedBase,option,finalPrice].every(Number.isSafeInteger)||option < -allowed||option > allowed||global.SystemV3DiscountPriceMath?.discountedBase(base,item.target_discount_terms)!==discountedBase) throw exportConflict(item,`스마트스토어 ${item.sellpia_sku_code}: 옵션가 허용범위 또는 할인 적용 최종가 재검증 실패`);
    }
    return {base,discountedBase,option,finalPrice,discountTerms:Array.isArray(item.target_discount_terms)?item.target_discount_terms:[]};
  }

  function discountTermMap(terms) { return new Map((Array.isArray(terms)?terms:[]).map(term=>[clean(term.term_key),term])); }
  function discountUnitLabel(unit) { return unit==='percent'?'%':unit==='amount'?'원':''; }
  function stableJson(value) {
    if(Array.isArray(value)) return value.map(stableJson);
    if(value&&typeof value==='object') return Object.fromEntries(Object.keys(value).sort().map(key=>[key,stableJson(value[key])]));
    return value;
  }
  function canonicalDiscountTerms(terms) {
    return (Array.isArray(terms)?terms:[]).map(term=>stableJson(term)).sort((left,right)=>clean(left.term_key).localeCompare(clean(right.term_key),'ko'));
  }
  function discountTermsFingerprint(terms) { return JSON.stringify(canonicalDiscountTerms(terms)); }
  function discountTermsChanged(item) { return discountTermsFingerprint(item.source_discount_terms)!==discountTermsFingerprint(item.target_discount_terms); }
  function patchSmartstoreDiscounts(rowXml,row,item) {
    if(!discountTermsChanged(item)) return {rowXml,references:[]};
    let output=rowXml; const terms=discountTermMap(item.target_discount_terms); const references=[];
    for(const [key,valueRef,unitRef] of [['basic','BF','BG'],['mobile','BH','BI'],['reservation','BJ','BK'],['multi_buy','BO','BP']]) {
      const term=terms.get(key); const value=term?.value??''; const unit=term?discountUnitLabel(term.unit):'';
      output=setCellValue(output,`${valueRef}${row}`,value,value===''?'string':'number');
      output=setCellValue(output,`${unitRef}${row}`,unit,'string');
      references.push({reference:`${valueRef}${row}`},{reference:`${unitRef}${row}`});
    }
    return {rowXml:output,references};
  }
  function makeshopPeriodText(term) {
    if(!term) return '';
    const rounding={down:'절사',up:'올림',nearest:'반올림'}[term.rounding_mode]||'';
    const roundingUnit=Number(term.rounding_unit||1)===100?'백원':Number(term.rounding_unit||1)===10?'십원':'';
    return `${term.value}${discountUnitLabel(term.unit)}${roundingUnit||rounding?` ${roundingUnit}${rounding}`:''}`.trim();
  }

  function patchSmartstoreRow(rowXml, items, sharedStrings, onConflict, onApplied) {
    let output=rowXml;
    for(const item of items) {
      try {
        const row=Number(item.source_row_no); const optionCode=clean(item.seller_option_code); let optionIndex=-1;
        if(optionCode) {
          const codes=String(cellValue(output,`P${row}`,sharedStrings)).split(/\r?\n/).map(clean); optionIndex=codes.indexOf(optionCode);
          if(optionIndex<0) throw exportConflict(item,`스마트스토어 ${item.sellpia_sku_code}: ${row}행에서 옵션번호 ${optionCode}를 찾지 못했습니다.`);
        }
        const after=scalar(item.after_value);
        let changedRef='';
        if(item.field_key==='sellpia_current_stock') {
          const ref=optionCode?`S${row}`:`M${row}`; const current=optionCode?String(cellValue(output,ref,sharedStrings)).split(/\r?\n/)[optionIndex]:cellValue(output,ref,sharedStrings);
          verifyExpected(current,item); output=setCellValue(output,ref,optionCode?replaceLine(cellValue(output,ref,sharedStrings),optionIndex,after):after,optionCode?'string':'number'); changedRef=ref;
        } else if(item.field_key==='sellpia_sale_price') {
          const targets=priceTargets(item);
          const originalBase=Number(cellValue(rowXml,`F${row}`,sharedStrings)||item.base_price||0);
          const originalOption=optionCode?Number(String(cellValue(rowXml,`R${row}`,sharedStrings)).split(/\r?\n/)[optionIndex]||0):0;
          verifyExpected(smartstoreDiscountedBase(rowXml,row,sharedStrings,originalBase)+originalOption,item);
          output=setCellValue(output,`F${row}`,targets.base,'number');
          if(optionCode) output=setCellValue(output,`R${row}`,replaceLine(cellValue(output,`R${row}`,sharedStrings),optionIndex,targets.option),'string');
          changedRef=optionCode?[{reference:`F${row}`},{reference:`R${row}`,lineIndex:optionIndex}]:[{reference:`F${row}`}];
          const discountPatch=patchSmartstoreDiscounts(output,row,item);
          output=discountPatch.rowXml;
          changedRef=[...changedRef,...discountPatch.references];
        } else if(item.field_key==='seller_product_name') {
          changedRef=`D${row}`; verifyExpected(cellValue(output,changedRef,sharedStrings),item); output=setCellValue(output,changedRef,after,'string');
        } else if(item.field_key==='seller_option_name') {
          const current=String(cellValue(output,`Q${row}`,sharedStrings)).split(/\r?\n/)[optionIndex]??''; verifyExpected(current,item);
          changedRef=`Q${row}`; output=setCellValue(output,changedRef,replaceLine(cellValue(output,changedRef,sharedStrings),optionIndex,after),'string');
        }
        const changedLineIndex = optionCode && ['sellpia_current_stock','seller_option_name'].includes(item.field_key) ? optionIndex : null;
        if(changedRef) onApplied?.(item,changedRef,{lineIndex:changedLineIndex});
      } catch(error) {
        if(error?.exportConflict && onConflict) onConflict({item,reason:error.message}); else throw error;
      }
    }
    return output;
  }

  function makeshopProductRows(sheetXml,sharedStrings) {
    const map=new Map(); String(sheetXml).replace(/<row\b[^>]*\br="(\d+)"[^>]*>[\s\S]*?<\/row>/g,(rowXml,rowNo)=>{ const code=clean(cellValue(rowXml,`E${rowNo}`,sharedStrings)); if(code) map.set(code,Number(rowNo)); return rowXml; }); return map;
  }
  function makeshopPhysicalProductRows(sheetXml,sharedStrings) {
    const dataRowNumbers=[],rowsByProduct=new Map(),rowXmlByNumber=new Map();let product='';
    String(sheetXml).replace(/<row\b[^>]*\br="(\d+)"[^>]*>[\s\S]*?<\/row>/g,(rowXml,rowNo)=>{
      const row=Number(rowNo);if(row<2)return rowXml;
      rowXmlByNumber.set(row,rowXml);
      const code=clean(cellValue(rowXml,`E${row}`,sharedStrings));
      if(code)product=code;
      dataRowNumbers.push(row);
      if(product){if(!rowsByProduct.has(product))rowsByProduct.set(product,[]);rowsByProduct.get(product).push({row,rowXml});}
      return rowXml;
    });
    return {dataRowNumbers,rowsByProduct,rowXmlByNumber};
  }
  async function readMakeshopPhysicalProductRows(file) {
    const {sheetXml,shared}=await xlsxParts(file),scope=makeshopPhysicalProductRows(sheetXml,shared);
    return {dataRowNumbers:scope.dataRowNumbers,rowsByProduct:Object.fromEntries([...scope.rowsByProduct].map(([code,rows])=>[code,rows.map(value=>value.row)]))};
  }
  function makeshopOptionList(block,sharedStrings,productCode) {
    const parent=block?.[0];
    if(!parent)throw new Error(`메이크샵 ${productCode}: 상품 원본 행을 찾지 못했습니다.`);
    const choices=String(cellValue(parent.rowXml,`U${parent.row}`,sharedStrings)).split(',').map(clean);
    const prices=String(cellValue(parent.rowXml,`V${parent.row}`,sharedStrings)).split(',').map(clean);
    const options=block.filter(({row,rowXml})=>clean(cellValue(rowXml,`AR${row}`,sharedStrings)));
    const names=options.map(({row,rowXml})=>clean(cellValue(rowXml,`AD${row}`,sharedStrings)));
    if(!choices.length||choices.length!==prices.length||choices.length!==options.length||choices.some((name,index)=>!name||name!==names[index]))
      throw new Error(`메이크샵 ${productCode}: 옵션값(U)·옵션가(V)와 옵션조합(AD/AF)의 순서 또는 개수가 다릅니다.`);
    return {parent,prices,options,indexByRow:new Map(options.map((entry,index)=>[entry.row,index]))};
  }
  function sheetRowXml(sheetXml,row) {
    return String(sheetXml||'').match(new RegExp(`<row\\b[^>]*\\br="${Number(row)}"[^>]*>[\\s\\S]*?<\\/row>`))?.[0]||'';
  }
  function preflightSharedPriceGroups(sheetXml,items,sharedStrings,onConflict,physicalRows=null) {
    const source=items[0]?.source_channel;
    if(!['smartstore','makeshop'].includes(source)) return {items,workingSheetXml:sheetXml};
    const productRows=source==='makeshop'?makeshopProductRows(sheetXml,sharedStrings):new Map();
    const blocks=source==='makeshop'?(physicalRows||makeshopPhysicalProductRows(sheetXml,sharedStrings)).rowsByProduct:new Map();
    const groups=new Map();
    for(const item of items.filter(value=>value.field_key==='sellpia_sale_price')) {
      const key=clean(item.seller_product_code)||`row:${Number(item.source_row_no)}`;
      if(!groups.has(key)) groups.set(key,[]);
      groups.get(key).push(item);
    }
    const parentUpdates=new Map();
    const originalRow=row=>physicalRows?.rowXmlByNumber.get(row)||sheetRowXml(sheetXml,row);
    for(const [productCode,group] of groups) {
      try {
        const targets=group.map(priceTargets);
        if(new Set(targets.map(value=>value.base)).size!==1) throw exportConflict(group[0],`${SOURCE_LABELS[source]} ${productCode}: 같은 상품의 목표 판매가가 서로 다릅니다.`);
        if(new Set(targets.map(value=>discountTermsFingerprint(value.discountTerms))).size!==1) throw exportConflict(group[0],`${SOURCE_LABELS[source]} ${productCode}: 같은 상품의 목표 할인조건이 서로 다릅니다.`);
        let productRow=null;
        let originalBase=null;
        if(source==='makeshop') {
          productRow=productRows.get(clean(group[0].seller_product_code));
          if(!productRow) throw exportConflict(group[0],`${SOURCE_LABELS[source]} ${productCode}: 상품 기본 판매가 행을 찾지 못했습니다.`);
          originalBase=Number(cellValue(originalRow(productRow),`AS${productRow}`,sharedStrings));
          if(!Number.isFinite(originalBase)) throw exportConflict(group[0],`${SOURCE_LABELS[source]} ${productCode}: 원본 기본 판매가를 읽지 못했습니다.`);
          if(group.some(item=>clean(item.seller_option_code))) {
            try {
              const optionList=makeshopOptionList(blocks.get(productCode),sharedStrings,productCode);
              for(const item of group) {
                const row=Number(item.source_row_no),index=optionList.indexByRow.get(row);
                if(!clean(item.seller_option_code))continue;
                if(index===undefined)throw new Error(`메이크샵 ${productCode}: ${row}행의 옵션조합을 옵션가 목록에서 찾지 못했습니다.`);
                const before=Number(cellValue(optionList.options[index].rowXml,`AF${row}`,sharedStrings));
                const target=priceTargets(item).option;
                if(target===before)continue;
                const listedPrice=optionList.prices[index];
                if(!Number.isSafeInteger(before)||listedPrice===''||!Number.isSafeInteger(Number(listedPrice))||Number(listedPrice)!==before)
                  throw new Error(`메이크샵 ${productCode}: ${row}행의 옵션가(V)와 옵션조합가(AF)가 원본에서 일치하지 않습니다.`);
              }
            } catch(error) {throw exportConflict(group[0],error.message);}
          }
        }
        for(const item of group) {
          const row=Number(item.source_row_no);
          const rowXml=originalRow(row);
          if(!rowXml) throw exportConflict(item,`${SOURCE_LABELS[source]} ${item.sellpia_sku_code}: 보관 원본에서 ${row}행을 찾지 못했습니다.`);
          const optionCode=clean(item.seller_option_code);
          if(source==='smartstore') {
            const base=Number(cellValue(rowXml,`F${row}`,sharedStrings)||0);
            let option=0;
            if(optionCode) {
              const codes=String(cellValue(rowXml,`P${row}`,sharedStrings)).split(/\r?\n/).map(clean);
              const optionIndex=codes.indexOf(optionCode);
              if(optionIndex<0) throw exportConflict(item,`${SOURCE_LABELS[source]} ${item.sellpia_sku_code}: ${row}행에서 옵션번호 ${optionCode}를 찾지 못했습니다.`);
              option=Number(String(cellValue(rowXml,`R${row}`,sharedStrings)).split(/\r?\n/)[optionIndex]||0);
            }
            verifyExpected(smartstoreDiscountedBase(rowXml,row,sharedStrings,base)+option,item);
          } else {
            if(Number.isFinite(Number(item.base_price))&&originalBase!==Number(item.base_price)) throw exportConflict(item,`${SOURCE_LABELS[source]} ${item.sellpia_sku_code}: DB 기본 판매가(${item.base_price})와 보관 원본 값(${originalBase})이 다릅니다.`);
            if(optionCode&&clean(cellValue(rowXml,`AR${row}`,sharedStrings))!==optionCode) throw exportConflict(item,`${SOURCE_LABELS[source]} ${item.sellpia_sku_code}: ${row}행 옵션코드가 DB와 다릅니다.`);
            const option=optionCode?Number(cellValue(rowXml,`AF${row}`,sharedStrings)||0):0;
            verifyExpected(makeshopDiscountedBase(originalRow(productRow),productRow,sharedStrings,originalBase)+option,item);
            item._product_row_no=productRow;
          }
        }
        if(source==='makeshop') {
          const updates=[{reference:`AS${productRow}`,value:targets[0].base,type:'number'}];
          if(discountTermsChanged(group[0])) {
            const terms=discountTermMap(group[0].target_discount_terms);
            updates.push({reference:`DD${productRow}`,value:makeshopPeriodText(terms.get('period')),type:'string'});
            updates.push({reference:`AT${productRow}`,value:terms.get('membership')?.value??0,type:'number'});
            for(const item of group) item._shared_discount_refs=[{reference:`DD${productRow}`},{reference:`AT${productRow}`}];
          }
          parentUpdates.set(productRow,updates);
        }
      } catch(error) {
        if(!error?.exportConflict||!onConflict) throw error;
        for(const item of group) {
          item._preflight_conflict=true;
          onConflict({item,reason:`${error.message} 공유 판매가가 있는 옵션 묶음 전체를 제외했습니다.`});
        }
      }
    }
    const workingSheetXml=parentUpdates.size?String(sheetXml).replace(/<row\b[^>]*\br="(\d+)"[^>]*>[\s\S]*?<\/row>/g,(rowXml,rowNo)=>{
      const updates=parentUpdates.get(Number(rowNo));
      if(!updates)return rowXml;
      return updates.reduce((current,update)=>setCellValue(current,update.reference,update.value,update.type),rowXml);
    }):sheetXml;
    return {items,workingSheetXml};
  }
  function patchMakeshopRow(rowXml,items,sharedStrings,onConflict,onApplied) {
    let output=rowXml;
    for(const item of items) {
      try {
        const row=Number(item.source_row_no); const optionCode=clean(item.seller_option_code); const after=scalar(item.after_value);
        if(optionCode && clean(cellValue(output,`AR${row}`,sharedStrings))!==optionCode) throw exportConflict(item,`메이크샵 ${item.sellpia_sku_code}: ${row}행 옵션코드가 DB와 다릅니다.`);
        let changedRef='';
        if(item.field_key==='sellpia_current_stock') {
          changedRef=optionCode?`AG${row}`:`AV${row}`; const current=cellValue(output,changedRef,sharedStrings); verifyExpected(current,item); output=setCellValue(output,changedRef,after,'number');
        } else if(item.field_key==='sellpia_sale_price') {
          const targets=priceTargets(item); const current=Number(scalar(item.expected_source_value)); verifyExpected(current,item);
          if(optionCode) {
            changedRef=[{reference:`AS${Number(item._product_row_no)}`},{reference:`AF${row}`},...(item._shared_discount_refs||[])];
            output=setCellValue(output,`AF${row}`,targets.option,'number');
          } else {
            changedRef=[{reference:`AS${row}`},...(item._shared_discount_refs||[])];
            output=setCellValue(output,`AS${row}`,targets.base,'number');
          }
        } else if(item.field_key==='seller_option_name') {
          changedRef=`AD${row}`; verifyExpected(cellValue(output,changedRef,sharedStrings),item); output=setCellValue(output,changedRef,after,'string');
        } else if(item.field_key==='seller_product_name') {
          changedRef=`M${row}`; verifyExpected(cellValue(output,changedRef,sharedStrings),item); output=setCellValue(output,changedRef,after,'string');
        }
        if(changedRef) onApplied?.(item,changedRef);
      } catch(error) {
        if(error?.exportConflict && onConflict) onConflict({item,reason:error.message}); else throw error;
      }
    }
    return output;
  }

  async function xlsxParts(file) {
    if(!global.JSZip) throw new Error('원본 보존 모듈을 불러오지 못했습니다.');
    const zip=await global.JSZip.loadAsync(new Uint8Array(await file.arrayBuffer()));
    const workbookXml=await zip.file('xl/workbook.xml')?.async('string'); const rels=await zip.file('xl/_rels/workbook.xml.rels')?.async('string');
    const sheetAttrs=extractXmlAttributes(workbookXml?.match(/<sheet\b([^>]*)\/?>(?:<\/sheet>)?/i)?.[1]); let target='';
    String(rels||'').replace(/<Relationship\b([^>]*)\/?>(?:<\/Relationship>)?/gi,(_,source)=>{const attrs=extractXmlAttributes(source);if(attrs.Id===sheetAttrs['r:id'])target=attrs.Target||'';return '';});
    const sheetPath=target.startsWith('/')?target.slice(1):`xl/${target.replace(/^\.\//,'')}`; const sheetXml=await zip.file(sheetPath)?.async('string');
    if(!sheetXml) throw new Error(`${file.name}: 첫 번째 시트 XML을 읽지 못했습니다.`);
    const sharedXml=await zip.file('xl/sharedStrings.xml')?.async('string'); const shared=[];
    String(sharedXml||'').replace(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g,(_,xml)=>{shared.push(richTextValue(xml));return '';});
    const stylesPath='xl/styles.xml'; const stylesXml=await zip.file(stylesPath)?.async('string');
    if(!stylesXml) throw new Error(`${file.name}: 원본 스타일 XML을 읽지 못했습니다.`);
    return {zip,sheetPath,sheetXml,shared,stylesPath,stylesXml};
  }

  async function patchXlsxFile(file,items,onConflict,onApplied,{dataRowNumbers=null,keepOnlyRows=null}={}) {
    const {zip,sheetPath,sheetXml,shared,stylesPath,stylesXml}=await xlsxParts(file);
    const makeshopRows=items[0]?.source_channel==='makeshop'?makeshopPhysicalProductRows(sheetXml,shared):null;
    let workingSheetXml=sheetXml;
    if(items[0]?.source_channel==='makeshop') {
      const productRows=makeshopProductRows(sheetXml,shared);
      for(const item of items.filter(value=>value.field_key==='seller_product_name')) item.source_row_no=productRows.get(clean(item.seller_product_code))||item.source_row_no;
    }
    workingSheetXml=preflightSharedPriceGroups(sheetXml,items,shared,onConflict,makeshopRows).workingSheetXml;
    const rowNumbers=new Set([...String(workingSheetXml).matchAll(/<row\b[^>]*\br="(\d+)"/g)].map(match=>Number(match[1])));
    const byRow=new Map();
    for(const item of items){if(item._preflight_conflict)continue;const row=Number(item.source_row_no);if(!rowNumbers.has(row)){const reason=`${SOURCE_LABELS[item.source_channel]} ${item.sellpia_sku_code}: 보관 원본에서 ${row}행을 찾지 못했습니다.`;if(onConflict)onConflict({item,reason});else throw exportConflict(item,reason);continue;}if(!byRow.has(row))byRow.set(row,[]);byRow.get(row).push(item);}
    const appliedHighlights=[],appliedMakeshopOptions=[];
    const recordApplied=(item,reference,highlight)=>{const refs=Array.isArray(reference)?reference:[reference?{reference,...(highlight||{})}:null];for(const entry of refs.filter(Boolean))appliedHighlights.push(entry);if(makeshopRows&&item.field_key==='sellpia_sale_price'&&clean(item.seller_option_code))appliedMakeshopOptions.push(item);onApplied?.(item);};
    let patched=workingSheetXml.replace(/<row\b[^>]*\br="(\d+)"[^>]*>[\s\S]*?<\/row>/g,(rowXml,rowNo)=>{
      const changes=byRow.get(Number(rowNo)); if(!changes) return rowXml;
      return items[0].source_channel==='smartstore'?patchSmartstoreRow(rowXml,changes,shared,onConflict,recordApplied):patchMakeshopRow(rowXml,changes,shared,onConflict,recordApplied);
    });
    if(appliedMakeshopOptions.length) {
      const changedByProduct=new Map();
      const optionListUpdates=new Map();
      for(const item of appliedMakeshopOptions){const code=clean(item.seller_product_code);if(!changedByProduct.has(code))changedByProduct.set(code,[]);changedByProduct.get(code).push(item);}
      for(const [code,group] of changedByProduct){
        const optionList=makeshopOptionList(makeshopRows.rowsByProduct.get(code),shared,code),values=[...optionList.prices];let changed=false;
        for(const item of group){
          const index=optionList.indexByRow.get(Number(item.source_row_no));
          if(index===undefined)throw new Error(`메이크샵 ${code}: 변경 옵션의 원본 목록 위치를 찾지 못했습니다.`);
          const target=priceTargets(item).option;
          if(Number(values[index])!==target){values[index]=String(target);changed=true;}
        }
        if(changed){
          const row=optionList.parent.row;
          optionListUpdates.set(row,values.join(','));
          appliedHighlights.push({reference:`V${row}`});
        }
      }
      if(optionListUpdates.size)patched=patched.replace(/<row\b[^>]*\br="(\d+)"[^>]*>[\s\S]*?<\/row>/g,(rowXml,rowNo)=>{
        const row=Number(rowNo),values=optionListUpdates.get(row);
        return values===undefined?rowXml:setCellValue(rowXml,`V${row}`,values,'string');
      });
    }
    let scoped=patched,highlights=appliedHighlights;
    if(dataRowNumbers&&keepOnlyRows){
      const result=scopeWorksheetRowsWithMap(scoped,dataRowNumbers,keepOnlyRows);
      scoped=result.sheetXml;
      highlights=remapHighlights(appliedHighlights,result.rowMap);
    }
    const highlighted=applyChangeHighlights(scoped,stylesXml,highlights);
    assertWorksheetXmlWellFormed(highlighted.sheetXml);
    zip.file(sheetPath,highlighted.sheetXml); zip.file(stylesPath,highlighted.stylesXml); return zip.generateAsync({type:'blob',compression:'DEFLATE',compressionOptions:{level:6}});
  }

  function remapWorksheetRow(rowXml,fromRow,toRow){
    if(fromRow===toRow)return rowXml;
    let output=String(rowXml).replace(new RegExp('(<row\\b[^>]*\\br=")'+fromRow+'("[^>]*>)'),(_,head,tail)=>head+toRow+tail);
    output=output.replace(new RegExp('\\br="([A-Z]+)'+fromRow+'"','g'),(_,column)=>'r="'+column+toRow+'"');
    return output;
  }
  function scopeWorksheetRowsWithMap(sheetXml,dataRowNumbers,keepOnlyRows){
    const dataRows=[...new Set([...(dataRowNumbers||[])].map(Number).filter(row=>Number.isInteger(row)&&row>0))].sort((a,b)=>a-b);
    if(!dataRows.length)return {sheetXml:String(sheetXml),rowMap:null};
    const first=dataRows[0],last=dataRows[dataRows.length-1];
    const kept=new Set([...(keepOnlyRows||[])].map(Number).filter(row=>Number.isInteger(row)&&row>0));
    const rowMap=new Map();
    let nextRow=first-1,previousSourceRow=0,lastTargetRow=0;
    let output=String(sheetXml).replace(/<row\b[^>]*\br="(\d+)"[^>]*>[\s\S]*?<\/row>/g,(rowXml,rowNo)=>{
      const sourceRow=Number(rowNo);
      if(sourceRow<=previousSourceRow)throw new Error('원본 XLSX의 행 번호가 중복되거나 순서가 바뀌었습니다.');
      previousSourceRow=sourceRow;
      // Parsed data rows omit auxiliary/empty physical rows. Keeping those
      // at old IDs while compacting selected rows corrupts the worksheet.
      if(sourceRow>=first&&sourceRow<=last&&!kept.has(sourceRow))return '';
      const targetRow=sourceRow<first?sourceRow:++nextRow;
      lastTargetRow=targetRow;
      rowMap.set(sourceRow,targetRow);
      return remapWorksheetRow(rowXml,sourceRow,targetRow);
    });
    if(lastTargetRow){
      output=output.replace(/<dimension\b([^>]*\bref=")([A-Z]+)1:([A-Z]+)\d+("[^>]*)\/?>(?:<\/dimension>)?/i,(_,head,left,right,tail)=>'<dimension'+head+left+'1:'+right+lastTargetRow+tail.replace(/\/\s*$/,'')+'/>');
    }
    return {sheetXml:output,rowMap};
  }
  function scopeWorksheetRows(sheetXml,dataRowNumbers,keepOnlyRows){
    return scopeWorksheetRowsWithMap(sheetXml,dataRowNumbers,keepOnlyRows).sheetXml;
  }
  function remapHighlights(highlights,rowMap){
    if(!rowMap)return highlights;
    return highlights.map(highlight=>{
      const reference=typeof highlight==='string'?highlight:highlight.reference;
      const match=String(reference||'').match(/^([A-Z]+)(\d+)$/);
      const row=match&&rowMap.get(Number(match[2]));
      if(!row)throw new Error('변경 셀 '+(reference||'?')+'이 변경분 파일의 선택 행에서 누락됐습니다.');
      const nextReference=match[1]+row;
      return typeof highlight==='string'?nextReference:{...highlight,reference:nextReference};
    });
  }
  function assertWorksheetXmlWellFormed(xml){
    if(/<dimension\b[^>]*\/\/>/i.test(xml))throw new Error('XLSX worksheet dimension XML이 잘못되어 파일 생성을 중단했습니다.');
    let previousRow=0;
    for(const match of String(xml).matchAll(/<row\b[^>]*\br="(\d+)"/g)){
      const row=Number(match[1]);
      if(row<=previousRow)throw new Error('XLSX worksheet 행 번호가 중복되거나 순서가 바뀌어 파일 생성을 중단했습니다.');
      previousRow=row;
    }
    if(typeof global.DOMParser==='function'){
      const parsed=new global.DOMParser().parseFromString(xml,'application/xml');
      if(parsed.getElementsByTagName('parsererror').length||parsed.documentElement?.localName==='parsererror')
        throw new Error('XLSX worksheet XML을 읽을 수 없어 파일 생성을 중단했습니다.');
    }
  }

  async function transformSellerFile(file,items,options={}){
    const skippedItems=[],appliedItems=[];
    if(!Array.isArray(items)||!items.length){
      if(options.dataRowNumbers&&options.keepOnlyRows){
        const parts=await xlsxParts(file),scoped=scopeWorksheetRows(parts.sheetXml,options.dataRowNumbers,options.keepOnlyRows);
        assertWorksheetXmlWellFormed(scoped);parts.zip.file(parts.sheetPath,scoped);
        return {blob:await parts.zip.generateAsync({type:'blob',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',compression:'DEFLATE'}),skippedItems,appliedItems};
      }
      return {blob:new Blob([await file.arrayBuffer()],{type:file.type||'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}),skippedItems,appliedItems};
    }
    const blob=await patchXlsxFile(file,items,entry=>skippedItems.push(entry),item=>appliedItems.push(item),options);
    return {blob,skippedItems,appliedItems};
  }

  async function transformTabularXlsx(file,changes,{dataRowNumbers=null,keepOnlyRows=null,renumberColumn='',renumberStart=1}={}){
    const parts=await xlsxParts(file), conflicts=[], applied=[];
    const rows=new Set([...String(parts.sheetXml).matchAll(/<row\b[^>]*\br="(\d+)"/g)].map(match=>Number(match[1])));
    let sheetXml=parts.sheetXml;
    for(const change of changes||[]){
      try{
        const row=Number(change.row), column=clean(change.column).toUpperCase();
        if(!Number.isInteger(row)||row<1||!column||!rows.has(row))throw exportConflict(change,`${file.name}: ${row || '?'}행을 원본에서 찾지 못했습니다.`);
        const reference=`${column}${row}`, rowMatcher=new RegExp(`<row\\b[^>]*\\br="${row}"[^>]*>[\\s\\S]*?<\\/row>`), rowXml=sheetXml.match(rowMatcher)?.[0]||'';
        const actual=cellValue(rowXml,reference,parts.shared);
        if(change.expected!==undefined&&change.expected!==null&&!sameValue(actual,change.expected,change.numeric?'sellpia_sale_price':''))throw exportConflict(change,`${file.name} ${change.sku}: 보관 원본 값(${actual})과 DB 원본 값(${change.expected})이 다릅니다.`);
        const next=setCellValue(rowXml,reference,change.value,change.numeric===false?'string':'number');
        sheetXml=sheetXml.replace(rowMatcher,next);
        applied.push({...change,reference});
      }catch(error){if(error?.exportConflict)conflicts.push({change,reason:error.message});else throw error;}
    }
    let rowMap=null;
    if(dataRowNumbers&&keepOnlyRows){
      const ordered=[...dataRowNumbers].map(Number).filter(Number.isInteger).sort((a,b)=>a-b), kept=ordered.filter(row=>new Set(keepOnlyRows).has(row)), first=ordered[0];
      rowMap=new Map(kept.map((row,index)=>[row,first+index]));
      sheetXml=scopeWorksheetRows(sheetXml,ordered,kept);
      if(renumberColumn){
        kept.forEach((sourceRow,index)=>{
          const row=rowMap.get(sourceRow), matcher=new RegExp(`<row\\b[^>]*\\br="${row}"[^>]*>[\\s\\S]*?<\\/row>`), xml=sheetXml.match(matcher)?.[0];
          if(xml)sheetXml=sheetXml.replace(matcher,setCellValue(xml,`${renumberColumn}${row}`,Number(renumberStart)+index,'number'));
        });
      }
    }
    const highlights=applied.map(change=>{
      const row=rowMap?.get(Number(change.row))||Number(change.row);
      return `${clean(change.column).toUpperCase()}${row}`;
    });
    const highlighted=applyChangeHighlights(sheetXml,parts.stylesXml,highlights);
    assertWorksheetXmlWellFormed(highlighted.sheetXml);
    parts.zip.file(parts.sheetPath,highlighted.sheetXml);parts.zip.file(parts.stylesPath,highlighted.stylesXml);
    const blob=await parts.zip.generateAsync({type:'blob',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',compression:'DEFLATE',compressionOptions:{level:6}});
    return {blob,applied,conflicts};
  }

  function carrierWarningReferences(source,row,parents=null){
    const rowNo=Number(row?.source_row_no);
    if(!Number.isInteger(rowNo)||rowNo<=0)return [];
    if(row.warning_field==='price'||row.shared_price_warning&&row.status!=='warn_keep_original'){
      if(source==='smartstore')return ['F','BF','BG',...(row.option_code?['R']:[])].map(column=>column+rowNo);
      const refs=row.option_code?['AF'+rowNo]:[],parent=parents?.get(clean(row.product_code));
      if(parent)refs.push(...['AS','DD','AT'].map(column=>column+parent));
      return refs;
    }
    const refs=(source==='smartstore'?['F','BF','BG',...(row.option_code?['R','S']:['M'])]:(row.option_code?['AF','AG']:['AV'])).map(column=>column+rowNo);
    if(parents){const parent=parents.get(clean(row.product_code));if(parent)refs.push(...['AS','DD','AT'].map(column=>column+parent));}
    return refs;
  }

  async function markCarrierWarnings(file,source,preview){
    const warnings=(preview||[]).filter(row=>row.status==='warn_keep_original'||row.status==='blocked'||row.shared_price_warning);
    if(!warnings.length)return file;
    if(!['smartstore','makeshop'].includes(source))throw new Error('지원되지 않는 carrier 강조 양식입니다.');
    const parts=await xlsxParts(file),references=[];
    const parents=source==='makeshop'?makeshopProductRows(parts.sheetXml,parts.shared):null;
    for(const row of warnings){
      references.push(...carrierWarningReferences(source,row,parents));
    }
    if(!references.length)return file;
    const marked=applyChangeHighlights(parts.sheetXml,parts.stylesXml,references,{fillColor:'FFFFC7CE',preserveText:true});
    parts.zip.file(parts.sheetPath,marked.sheetXml);parts.zip.file(parts.stylesPath,marked.stylesXml);
    return parts.zip.generateAsync({type:'blob',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',compression:'DEFLATE'});
  }

  async function patchCsvFile(file,items,onConflict,onApplied) {
    if(!global.XLSX) throw new Error('CSV 처리 모듈을 불러오지 못했습니다.');
    const workbook=global.XLSX.read(await file.text(),{type:'string',raw:true}); const sheet=workbook.Sheets[workbook.SheetNames[0]];
    const rows=global.XLSX.utils.sheet_to_json(sheet,{header:1,raw:true,defval:''});
    for(const item of items){try{const index=Number(item.source_row_no)-1;const row=rows[index];if(!row)throw exportConflict(item,`에이블리 ${item.sellpia_sku_code}: ${item.source_row_no}행이 없습니다.`);
      if(clean(row[0])!==clean(item.seller_product_code)||clean(row[10])!==clean(item.seller_option_code))throw exportConflict(item,`에이블리 ${item.sellpia_sku_code}: 원본 코드가 DB와 다릅니다.`);
      const column={sellpia_current_stock:15,sellpia_sale_price:6,seller_product_name:2,seller_option_name:14}[item.field_key];
      verifyExpected(row[column],item);
      if(item.field_key==='sellpia_sale_price') {
        const targets=priceTargets(item);
        row[4]=targets.base;
        row[5]=targets.discountedBase;
        row[6]=targets.finalPrice;
      } else {
        const after=scalar(item.after_value);
        row[column]=item.field_key.includes('stock')?Number(after):String(after);
      }
      onApplied?.(item);
      }catch(error){if(error?.exportConflict&&onConflict)onConflict({item,reason:error.message});else throw error;}
    }
    const output=global.XLSX.utils.sheet_to_csv(global.XLSX.utils.aoa_to_sheet(rows),{FS:',',RS:'\r\n'}); return new Blob([new Uint8Array([0xEF,0xBB,0xBF]),output],{type:'text/csv;charset=utf-8'});
  }

  function outputName(name) { const dot=name.lastIndexOf('.'); return dot<0?`${name}_SystemV3반영`:`${name.slice(0,dot)}_SystemV3반영${name.slice(dot)}`; }
  function csvCell(value){const text=String(value??'');return /[",\r\n]/.test(text)?`"${text.replace(/"/g,'""')}"`:text;}
  function discountRuleCode(item){return clean((Array.isArray(item.target_discount_terms)?item.target_discount_terms:[]).find(term=>term?.term_key==='period')?.rule_code);}
  function auditCsv(items){const rows=[['판매처','셀피아 SKU','변경항목','판매처 상품코드','옵션코드','변경 전','변경 후','원본 판매가','원본 옵션가','목표 판매가','할인 적용 판매가','목표 옵션가','목표 최종구매가','할인코드','원본 할인조건','목표 할인조건','입력 기준','가격 태그','원본파일','원본행']];for(const item of items)rows.push([SOURCE_LABELS[item.source_channel],item.sellpia_sku_code,FIELD_LABELS[item.field_key]||item.field_key,item.seller_product_code,item.seller_option_code,scalar(item.expected_source_value),scalar(item.after_value),item.base_price,item.option_price,item.target_base_price,item.target_discounted_base_price,item.target_option_price,item.target_final_price,discountRuleCode(item),JSON.stringify(item.source_discount_terms||[]),JSON.stringify(item.target_discount_terms||[]),item.pricing_input_mode||'legacy_final',item.price_rule_set_id||'',item.source_file_name,item.source_row_no]);return '\uFEFF'+rows.map(row=>row.map(csvCell).join(',')).join('\r\n');}
  function conflictCsv(conflicts){const rows=[['판매처','셀피아 SKU','변경항목','판매처 상품코드','옵션코드','제외 사유','원본파일','원본행','수정안 ID','구성 SKU']];for(const conflict of conflicts){const item=conflict.item;rows.push([SOURCE_LABELS[item.source_channel]||item.source_channel||'공통',item.sellpia_sku_code,FIELD_LABELS[item.field_key]||item.field_key,item.seller_product_code,item.seller_option_code,conflict.reason,item.source_file_name,item.source_row_no,item.change_id,(item.target_component_skus||[]).join(' · ')]);}return '\uFEFF'+rows.map(row=>row.map(value=>csvCell(typeof value==='string'&&/^[=+@-]/.test(value)?"'"+value:value)).join(',')).join('\r\n');}

  async function buildExportArchive(filesBySource,items = [],onProgress,excludedItems = []) {
    const key=(source,name)=>JSON.stringify([source,name]);
    const files=[...filesBySource].flatMap(([source,entries])=>entries.map(file=>({source,file})));
    if(!files.length)throw new Error('보관된 판매처 원본 파일이 없습니다. 원본을 먼저 업로드해주세요.');
    const available=new Set(files.map(({source,file})=>key(source,file.name)));
    const grouped=new Map(), archive=new global.JSZip(), manifest=[], appliedItems=[], skippedItems=[...excludedItems];
    for(const item of items){
      const fileKey=key(item.source_channel,item.source_file_name);
      const reason=item.blocking_reason||(!available.has(fileKey)?'해당 수정안의 원본 파일이 최신 보관본에 없습니다. 원본값을 유지했습니다.':'');
      if(reason){skippedItems.push({item,reason,export_item_id:Number(item.export_item_id)});continue;}
      if(!grouped.has(fileKey))grouped.set(fileKey,[]);
      grouped.get(fileKey).push({...item});
    }
    const nameCounts=new Map();
    for(const {file} of files)nameCounts.set(file.name,(nameCounts.get(file.name)||0)+1);
    for(const [index,{source,file}] of files.entries()){
      const name=file.name, fileItems=grouped.get(key(source,name))||[], fileApplied=[];
      onProgress?.(Math.round(index/files.length*85),`${name} ${fileItems.length?'검증·반영 중':'원본 그대로 포함'}`);
      const recordApplied=item=>fileApplied.push(item);
      const recordConflict=conflict=>skippedItems.push({...conflict,export_item_id:Number(conflict.item.export_item_id)});
      // No edits means a byte-for-byte copy; never reserialize an unchanged XLSX.
      let blob=file;
      if(fileItems.length)blob=name.toLowerCase().endsWith('.csv')?await patchCsvFile(file,fileItems,recordConflict,recordApplied):await patchXlsxFile(file,fileItems,recordConflict,recordApplied);
      if(!fileApplied.length)blob=file;
      appliedItems.push(...fileApplied);
      const nextName=(nameCounts.get(name)>1?source+'/':'')+outputName(name);
      archive.file(nextName,blob);
      manifest.push({source,source_name:name,output_name:nextName,item_count:fileApplied.length,skipped_count:fileItems.length-fileApplied.length,unchanged:!fileApplied.length,size:blob.size});
    }
    archive.file('SystemV3_내보내기_검증.csv',auditCsv(appliedItems));if(skippedItems.length)archive.file('SystemV3_내보내기_제외목록.csv',conflictCsv(skippedItems));onProgress?.(90,'ZIP 파일 압축 중');
    const blob=await archive.generateAsync({type:'blob',compression:'DEFLATE',compressionOptions:{level:6}});return{blob,manifest,appliedItems,skippedItems};
  }
  function downloadBlob(blob,name){const url=URL.createObjectURL(blob);const anchor=document.createElement('a');anchor.href=url;anchor.download=name;document.body.appendChild(anchor);anchor.click();anchor.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);}

  global.SystemV3SellerExport=Object.freeze({cellValue,setCellValue,applyChangeHighlights,carrierWarningReferences,markCarrierWarnings,preflightSharedPriceGroups,patchSmartstoreRow,patchMakeshopRow,scopeWorksheetRows,readMakeshopPhysicalProductRows,patchXlsxFile,transformSellerFile,transformTabularXlsx,patchCsvFile,buildExportArchive,downloadBlob,outputName,auditCsv,conflictCsv,discountTermsFingerprint});
})(typeof window!=='undefined'?window:globalThis);
