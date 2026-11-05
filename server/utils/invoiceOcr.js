export function normalizeInvoiceDraft(parsed) {
  const text = (value) => typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
  const numeric = (value) => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) ? Number(value) : '';
  const stripModel = (value, model) => {
    const name = text(value);
    if (!name || !model) return name;
    const escaped = model.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return name
      .replace(new RegExp(`(?:\\bmodel|\\bmdl|ماڈل)\\s*[:#-]?\\s*${escaped}(?=$|[\\s,;])`, 'gi'), '')
      .replace(new RegExp(`(?:\\s+|[-,:]\\s*)${escaped}\\s*$`, 'i'), '')
      .replace(/\s*[-,:]\s*$/, '').replace(/\s+/g, ' ').trim();
  };
  const cleanNote = (value) => [...new Set(text(value)
    .replace(/\bDitto mark (?:applied|copied|carried forward)[^.]*\.?\s*/gi, '')
    .replace(/\b(?:Appears |Listed )?below (?:the )?(?:handwritten )?subtotal(?: and balance)? (?:lines|rows),? included as a valid (?:row )?item(?: per instructions)?\.?\s*/gi, '')
    .replace(/\bSize\s+\d+(?:\.\d+)?\s*(?:inches|inch|in\.?)\s+recorded as warranty\/size attribute\.?\s*/gi, 'Please verify the product size against the invoice. ')
    .replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s+(?=[A-Z])/).filter(Boolean))].join(' ');
  const warnings = Array.isArray(parsed.warnings) ? parsed.warnings.map(cleanNote).filter(Boolean) : [];
  let previousDescription = null;
  const extractedItems = (Array.isArray(parsed.items) ? parsed.items : []).filter((x) => x && typeof x === 'object').map((x) => {
    const codeType = ['sku', 'barcode', 'model'].includes(x.codeType) ? x.codeType : '';
    const code = codeType ? text(x.code) : '';
    const suppliedName = text(x.name);
    const suppliedOriginalName = text(x.originalName || x.name);
    const explicitModel = suppliedName.match(/^model\s*[:#-]?\s*(\S+)$/i)?.[1] || '';
    const model = text(x.model) || (codeType === 'model' ? code : '') || explicitModel;
    const dittoMark = /^(?:["'`]{1,}|[〃〞″]+|ditto|same|do)$/i.test(suppliedName);
    const repeatMarks = /^(?:["'`\u201c\u201d\u2032\u2033\u3003\u301e]{2,}|\/{2,}|\\{2,})(?:\s|(?=\d)|$)/u;
    const onlyRepeatMarks = /^(?:["'`\u201c\u201d\u2032\u2033\u3003\u301e]{2,}|\/{2,}|\\{2,})$/u;
    const descriptionDitto = x.descriptionDitto === true || x.ditto === true || dittoMark ||
      repeatMarks.test(text(x.descriptionMarks)) || repeatMarks.test(suppliedName) || repeatMarks.test(suppliedOriginalName);
    let descriptionName = descriptionDitto && previousDescription?.name ? previousDescription.name : dittoMark || onlyRepeatMarks.test(suppliedName) ? '' : suppliedName;
    let descriptionOriginalName = descriptionDitto && previousDescription?.originalName
      ? previousDescription.originalName
      : dittoMark || onlyRepeatMarks.test(suppliedOriginalName) ? '' : suppliedOriginalName;
    if (descriptionDitto && !previousDescription?.name) {
      warnings.push('A ditto mark was found on a row without a readable product description above it; review this row against the invoice.');
    }
    let name = descriptionName;
    if (/^model\s*[:#-]?\s*\S+$/i.test(name) && model && name.replace(/^model\s*[:#-]?\s*/i, '').toLocaleLowerCase() === model.toLocaleLowerCase()) {
      name = '';
      descriptionName = '';
    }
    if (name && model && !name.toLocaleLowerCase().includes(model.toLocaleLowerCase())) {
      name = [name, `Model ${model}`].filter(Boolean).join(' - ');
    }
    const rawWarranty = text(x.warranty);
    const sizeMatch = rawWarranty.match(/\b(\d+(?:\.\d+)?)\s*(?:inches|inch|in\.?)\b/i);
    if (sizeMatch && name && !new RegExp(`\\b${sizeMatch[1]}\\s*(?:inches|inch|in\\.?)\\b`, 'i').test(name)) {
      name += ` ${sizeMatch[1]} inch`;
    }
    const warrantyMatch = rawWarranty.match(/^\s*(\d{1,2})\s*(?:months?|mos?)\s*$/i);
    const warranty = warrantyMatch && Number(warrantyMatch[1]) >= 3 && Number(warrantyMatch[1]) <= 48 && Number(warrantyMatch[1]) % 3 === 0
      ? `${Number(warrantyMatch[1])} Months` : '';
    const originalName = descriptionOriginalName;
    previousDescription = { name: stripModel(descriptionName, model), originalName: stripModel(descriptionOriginalName, model) };
    const confidence = Object.fromEntries(['name', 'model', 'qty', 'cost', 'lineTotal'].map((field) => [
      field, ['high', 'medium', 'low'].includes(x.confidence?.[field]) ? x.confidence[field] : '',
    ]));
    const lowConfidenceFields = Object.entries(confidence).filter(([, value]) => value === 'low').map(([field]) => field);
    const missingFields = [['qty', 'quantity'], ['cost', 'purchase rate']]
      .filter(([field]) => numeric(x[field]) === '')
      .map(([, label]) => label);
    const reviewNote = cleanNote(x.reviewNote) || (lowConfidenceFields.length
      ? `Please verify unclear ${lowConfidenceFields.join(', ')} against the original bill.`
      : missingFields.length ? `Please enter the unreadable ${missingFields.join(' and ')} from the original bill.` : '');
    return {
      name, originalName, model, code, codeType, confidence,
      descriptionDitto,
      qty: numeric(x.qty), cost: numeric(x.cost),
      lineTotal: numeric(x.lineTotal), warranty, reviewNote: reviewNote.trim(),
    };
  });
  const declaredInvoiceTotal = numeric(parsed.invoiceTotal);
  const possibleSummaryRows = extractedItems.filter((item) =>
    declaredInvoiceTotal !== '' && item.lineTotal !== '' && Math.abs(item.lineTotal - declaredInvoiceTotal) < 0.005 &&
    (item.qty === '' || item.cost === '' || !item.name || Math.abs(item.qty * item.cost - item.lineTotal) > 0.01)
  );
  const summaryRowSet = new Set(possibleSummaryRows);
  const invoiceTotalMatchesSummaryRow = possibleSummaryRows.length > 0;
  const items = extractedItems.filter((item) => {
    if (summaryRowSet.has(item)) return false;
    const hasProductIdentity = Boolean(item.name || item.model || item.code) ||
      (item.cost !== '' && /description.*(?:unreadable|obscured|unclear|missing)/i.test(item.reviewNote));
    const hasRowValue = item.qty !== '' || item.cost !== '' || item.lineTotal !== '';
    return hasProductIdentity && hasRowValue;
  });
  const missingQuantityRows = items.filter((item) => item.qty === '');
  if (possibleSummaryRows.length) warnings.push('The amount entered as invoice total also matches a non-product summary row, so it was left blank for review instead of being treated as the invoice total.');
  if (missingQuantityRows.length) warnings.push(missingQuantityRows.length + ' product-like rows have no readable quantity. They are kept for review and cannot be posted until completed.');
  const consistentRows = extractedItems.filter((item) => item.qty !== '' && item.cost !== '' && item.lineTotal !== '' && Math.abs(item.qty * item.cost - item.lineTotal) <= 0.01);
  for (let index = warnings.length - 1; index >= 0; index -= 1) {
    const warning = warnings[index];
    const callsItExcluded = /excluded|not a product|subtotal|payment note/i.test(warning);
    const duplicatesValidRow = consistentRows.some((item) => warning.includes(String(item.qty)) && warning.includes(String(item.cost)) && warning.includes(String(item.lineTotal)));
    if (callsItExcluded && duplicatesValidRow) warnings.splice(index, 1);
  }
  if (items.some((x) => !x.name || x.qty === '' || x.cost === '')) warnings.push('Some handwritten fields are unclear. Review each item against the invoice.');
  for (const [index, item] of items.entries()) {
    if (item.qty !== '' && item.cost !== '' && item.lineTotal !== '' && Math.abs(item.qty * item.cost - item.lineTotal) > 0.01) {
      warnings.push(`Item ${index + 1}: quantity x purchase cost does not match the written line total.`);
    }
  }
  let date = text(parsed.date);
  if (date && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number(date.slice(0, 4)) < 1000)) {
    date = '';
    warnings.push('The invoice date could not be read in full; verify and enter it before posting.');
  }
  return { supplier: text(parsed.supplier), originalSupplier: text(parsed.originalSupplier || parsed.supplier), invoiceNo: text(parsed.invoiceNo), date,
    invoiceTotal: invoiceTotalMatchesSummaryRow ? '' : declaredInvoiceTotal, paidAmount: numeric(parsed.paidAmount), balanceAmount: numeric(parsed.balanceAmount),
    warnings: [...new Set(warnings)], items };
}
