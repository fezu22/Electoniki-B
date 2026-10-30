/**
 * Pure business logic & financial calculation utilities for ElectroHub SaaS.
 * Used across server API routes and verified via unit tests.
 */

export function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, n) : 0;
}

export function signedNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function calculateCashSessionTotals(transactions, session, endTime = Date.now()) {
  const start = new Date(session.openedAt).getTime();
  let cashIn = 0;
  let cashOut = 0;
  for (const transaction of transactions) {
    if (String(transaction.method || '').toLowerCase() !== 'cash') continue;
    const createdAt = new Date(transaction.createdAt || 0).getTime();
    if (!Number.isFinite(createdAt) || createdAt < start || createdAt > endTime) continue;
    const amount = num(transaction.amount);
    if (transaction.direction === 'in') cashIn += amount;
    if (transaction.direction === 'out') cashOut += amount;
  }
  return { cashIn, cashOut, expectedClosingAmount: num(session.openingAmount) + cashIn - cashOut };
}

const STOCK_WARRANTY_OPTIONS = new Set(Array.from({ length: 16 }, (_, index) => `${(index + 1) * 3} Months`));

/**
 * Enforces strict tenant isolation between authenticated user's shopId
 * and a target record's shopId. Never trusts client-provided shopId.
 */
export function verifyTenantAccess(recordShopId, authenticatedShopId) {
  if (!recordShopId || !authenticatedShopId) return false;
  return String(recordShopId) === String(authenticatedShopId);
}

/**
 * Calculates complete sale financial breakdown for Cash and Installment sales.
 * Unpaid balances on cash/credit sales are tracked as customer receivable (Udhaar),
 * never counted as collected cash.
 */
export function calculateSaleTotals({
  items = [],
  billDiscount = 0,
  saleType = 'cash',
  installmentPercent = 0,
  advance = 0,
  months = 12,
  paymentMethod = 'cash',
  cashAmount = 0,
  bankAmount = 0,
}) {
  const normalizedItems = items.map((item) => {
    const qty = Math.max(1, Math.floor(num(item.qty)));
    const price = num(item.price);
    const cost = num(item.cost);
    const gross = qty * price;
    const totalCost = qty * cost;
    return {
      ...item,
      qty,
      price,
      cost,
      gross,
      total: gross,
      totalCost,
    };
  });

  const gross = normalizedItems.reduce((sum, i) => sum + i.gross, 0);
  const totalCost = normalizedItems.reduce((sum, i) => sum + i.totalCost, 0);
  const appliedDiscount = Math.min(gross, num(billDiscount));
  const discounted = Math.max(0, gross - appliedDiscount);

  const pct = saleType === 'installment' ? num(installmentPercent) : 0;
  const add = saleType === 'installment' ? Math.round((discounted * pct) / 100) : 0;
  const final = discounted + add;

  let rawReceived = 0;
  let cashCollected = 0;
  let bankCollected = 0;
  const chequeCollected = 0; // retained in returned shape for historical sale documents

  if (saleType === 'installment') {
    rawReceived = num(advance);
    if (paymentMethod === 'bank') {
      bankCollected = Math.min(final, rawReceived);
    } else {
      cashCollected = Math.min(final, rawReceived);
    }
  } else {
    if (paymentMethod === 'bank') {
      rawReceived = num(bankAmount);
      bankCollected = Math.min(final, rawReceived);
    } else {
      rawReceived = num(cashAmount);
      cashCollected = Math.min(final, rawReceived);
    }
  }

  const paid = cashCollected + bankCollected;
  const excess = Math.max(0, rawReceived - final);
  const balance = Math.max(0, final - paid);
  const durationMonths = saleType === 'installment' ? Math.max(1, Math.floor(num(months) || 12)) : 0;
  const monthly = saleType === 'installment' && durationMonths > 0 ? Math.round(balance / durationMonths) : 0;
  const grossMargin = final - totalCost;

  return {
    items: normalizedItems,
    gross,
    billDiscount: appliedDiscount,
    discounted,
    installmentPercent: pct,
    add,
    final,
    totalCost,
    grossMargin,
    rawReceived,
    paid,
    cashCollected,
    bankCollected,
    chequeCollected,
    excess,
    balance,
    months: durationMonths,
    monthly,
  };
}

/**
 * Validates that every cart item has sufficient stock in inventory.
 * Prevents accidental overselling.
 */
export function validateStockAvailability(cartItems = [], productsById = new Map()) {
  const errors = [];
  if (!Array.isArray(cartItems) || cartItems.length === 0) {
    return { valid: false, errors: ['Cart is empty. Add at least one product.'] };
  }

  // Aggregate quantities by product ID in case the same product is in multiple cart lines
  const requestedByProduct = new Map();
  for (const line of cartItems) {
    const rawQty = Number(line?.qty);
    if (!Number.isSafeInteger(rawQty) || rawQty < 1) {
      errors.push('Every sale item needs a whole quantity of at least 1.');
      continue;
    }
    const pid = String(line.productId || line.id || '');
    requestedByProduct.set(pid, (requestedByProduct.get(pid) || 0) + rawQty);
  }

  for (const [pid, reqQty] of requestedByProduct.entries()) {
    const prod = productsById.get(pid);
    if (!prod) {
      errors.push(`Product (${pid}) was not found in this shop's inventory.`);
      continue;
    }
    if (prod.active === false) {
      errors.push(`"${prod.name}" is currently inactive and cannot be sold.`);
      continue;
    }
    const available = num(prod.stock);
    if (reqQty > available) {
      errors.push(
        `Insufficient stock for "${prod.name}": requested ${reqQty}, but only ${available} unit${available === 1 ? '' : 's'} available.`
      );
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Validates and calculates a customer return against an original sale bill
 * and any prior returns recorded for that bill.
 */
export function calculateCustomerReturn({ bill, returnItems = [], priorReturns = [] }) {
  if (!bill || !Array.isArray(bill.items)) {
    return { valid: false, error: 'Original sale invoice not found.' };
  }
  if (!Array.isArray(returnItems) || returnItems.length === 0) {
    return { valid: false, error: 'Select at least one item and quantity to return.' };
  }

  // Sum already returned quantities per productId/name
  const returnedMap = new Map();
  for (const ret of priorReturns) {
    for (const ri of ret.items || []) {
      const key = String(ri.productId || ri.name);
      returnedMap.set(key, (returnedMap.get(key) || 0) + num(ri.qty));
    }
  }

  const totalSoldGross = bill.items.reduce((s, i) => s + num(i.price) * num(i.qty), 0) || 1;
  const effectiveRatio = num(bill.total) / totalSoldGross;

  const processedItems = [];
  let totalReturnAmount = 0;
  let totalCostRestored = 0;

  for (const reqItem of returnItems) {
    const reqQty = Number(reqItem?.qty);
    if (!Number.isSafeInteger(reqQty) || reqQty < 1) {
      return { valid: false, error: 'Every return item needs a whole quantity of at least 1.' };
    }

    const billItem = bill.items.find(
      (bi) =>
        (reqItem.productId && String(bi.productId) === String(reqItem.productId)) ||
        String(bi.name).toLowerCase() === String(reqItem.name || '').toLowerCase()
    );

    if (!billItem) {
      return {
        valid: false,
        error: `Item "${reqItem.name || reqItem.productId}" was not part of invoice ${bill.invoiceNo || bill.id}.`,
      };
    }

    const key = String(billItem.productId || billItem.name);
    const alreadyReturned = returnedMap.get(key) || 0;
    const maxReturnable = Math.max(0, num(billItem.qty) - alreadyReturned);

    if (reqQty > maxReturnable) {
      return {
        valid: false,
        error: `Cannot return ${reqQty} of "${billItem.name}". Sold: ${billItem.qty}, Already returned: ${alreadyReturned}, Eligible: ${maxReturnable}.`,
      };
    }

    const unitEffectivePrice = Math.round(num(billItem.price) * effectiveRatio);
    const lineRefund = unitEffectivePrice * reqQty;
    const unitCost = num(billItem.cost);
    const lineCostRestored = unitCost * reqQty;

    processedItems.push({
      productId: billItem.productId,
      name: billItem.name,
      code: billItem.code || '',
      qty: reqQty,
      unitPrice: unitEffectivePrice,
      unitCost,
      lineRefund,
      lineCostRestored,
    });

    totalReturnAmount += lineRefund;
    totalCostRestored += lineCostRestored;
  }

  if (processedItems.length === 0) {
    return { valid: false, error: 'Return quantity must be at least 1.' };
  }

  const marginLost = totalReturnAmount - totalCostRestored;

  return {
    valid: true,
    items: processedItems,
    totalReturnAmount,
    totalCostRestored,
    marginLost,
  };
}

/**
 * Validates and calculates an installment payment on an active plan.
 */
export function calculateInstallmentPayment({ plan, amount }) {
  if (!plan) {
    return { valid: false, error: 'Installment plan not found.' };
  }
  const payAmount = num(amount);
  const currentBalance = num(plan.balance);

  if (payAmount <= 0) {
    return { valid: false, error: 'Payment amount must be greater than zero.' };
  }
  if (currentBalance <= 0) {
    return { valid: false, error: 'This installment plan is already paid in full.' };
  }
  if (payAmount > currentBalance) {
    return {
      valid: false,
      error: `Payment (Rs. ${payAmount.toLocaleString()}) cannot exceed remaining balance (Rs. ${currentBalance.toLocaleString()}).`,
    };
  }

  const newPaid = num(plan.paid) + payAmount;
  const newBalance = Math.max(0, currentBalance - payAmount);
  const newStatus = newBalance === 0 ? 'Paid' : 'Active';

  return {
    valid: true,
    amount: payAmount,
    newPaid,
    newBalance,
    newStatus,
  };
}

/**
 * Validates supplier stock receipt items and totals.
 */
export function validateStockReceipt({ supplier, invoiceNo, invoiceTotal, paidNow = 0, items = [], existingReceipts = [] }) {
  const cleanSupplier = String(supplier || '').trim();
  const cleanInvoiceNo = String(invoiceNo || '').trim();

  if (!cleanSupplier) {
    return { valid: false, error: 'Supplier name is required.' };
  }
  if (!cleanInvoiceNo) {
    return { valid: false, error: 'Supplier invoice number is required.' };
  }
  if (!Array.isArray(items) || items.length === 0) {
    return { valid: false, error: 'Add at least one item to the supplier invoice.' };
  }

  for (const item of items) {
    const warranty = String(item?.warranty || '').trim();
    if (warranty && !STOCK_WARRANTY_OPTIONS.has(warranty)) {
      return { valid: false, error: 'Warranty must be optional or between 3 and 48 months.' };
    }
    if (item && item.price !== undefined && item.price !== null && item.price !== '' &&
        (!Number.isFinite(Number(item.price)) || Number(item.price) <= 0)) {
      return { valid: false, error: 'Sale price must be positive when entered.' };
    }
    if (!item || !String(item.name || '').trim() || !Number.isSafeInteger(Number(item.qty)) || Number(item.qty) < 1 ||
        !Number.isFinite(Number(item.cost)) || Number(item.cost) <= 0) {
      return {
        valid: false,
        error: 'Every item must have a product name, a whole quantity >= 1, and purchase cost > 0.',
      };
    }
  }

  const duplicate = existingReceipts.some(
    (r) =>
      String(r.invoiceNo || '').trim().toLowerCase() === cleanInvoiceNo.toLowerCase() &&
      String(r.supplier || '').trim().toLowerCase() === cleanSupplier.toLowerCase()
  );
  if (duplicate) {
    return {
      valid: false,
      error: `Duplicate supplier invoice "${cleanInvoiceNo}" for "${cleanSupplier}" is blocked.`,
    };
  }

  const calculatedTotal = Math.round(items.reduce((sum, x) => sum + Number(x.qty) * Number(x.cost), 0) * 100) / 100;
  const statedTotal = Number(invoiceTotal);

  if (invoiceTotal === undefined || invoiceTotal === '' || invoiceTotal === null || !Number.isFinite(statedTotal) ||
      !Number.isFinite(calculatedTotal) || Math.abs(calculatedTotal - statedTotal) > 0.005) {
    return {
      valid: false,
      error: `Invoice total (Rs. ${statedTotal.toLocaleString()}) does not match sum of item costs (Rs. ${calculatedTotal.toLocaleString()}).`,
    };
  }

  const paid = Number(paidNow);
  if (!Number.isFinite(paid) || paid < 0 || paid > calculatedTotal) {
    return {
      valid: false,
      error: `Paid amount must be non-negative and cannot exceed invoice total (Rs. ${calculatedTotal.toLocaleString()}).`,
    };
  }

  return {
    valid: true,
    calculatedTotal,
    paidNow: paid,
    supplierPayableAdded: Math.max(0, calculatedTotal - paid),
  };
}

/**
 * Calculates comprehensive shop dashboard & financial report totals from database records.
 * Profit = (Net Sales Revenue - Cost of Goods Sold) - Return Margin Lost - Shop Expenses.
 */
export function calculateShopFinancialSummary({
  bills = [],
  returns = [],
  expenses = [],
  products = [],
  suppliers = [],
  bankAccounts = [],
  installmentPayments = [],
  openingCash = 0,
  supplierPayments = [],
  fromDate = null,
  toDate = null,
}) {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const tomorrowStart = new Date(todayStart);
  tomorrowStart.setDate(tomorrowStart.getDate() + 1);

  const inPeriod = (dateStr) => {
    if (!fromDate && !toDate) return true;
    const d = new Date(dateStr || now);
    if (fromDate && d < new Date(fromDate)) return false;
    if (toDate) {
      const end = new Date(toDate);
      end.setHours(23, 59, 59, 999);
      if (d > end) return false;
    }
    return true;
  };

  const todayBills = bills.filter((b) => {
    const d = new Date(b.createdAt || now);
    return d >= todayStart && d < tomorrowStart;
  });

  const periodBills = bills.filter((b) => inPeriod(b.createdAt));
  const periodReturns = returns.filter((r) => inPeriod(r.createdAt));
  const periodExpenses = expenses.filter((e) => inPeriod(e.date || e.createdAt));
  const periodInstallmentPayments = installmentPayments.filter((p) => inPeriod(p.createdAt));

  const todaySales = todayBills.reduce((s, b) => s + num(b.total), 0);
  const grossSales = periodBills.reduce((s, b) => s + num(b.gross || b.total), 0);
  const totalDiscounts = periodBills.reduce((s, b) => s + num(b.billDiscount), 0);
  const netSales = periodBills.reduce((s, b) => s + num(b.total), 0);

  const cogs = periodBills.reduce((s, b) => {
    if (b.totalCost !== undefined) return s + num(b.totalCost);
    const itemsCost = (b.items || []).reduce((is, it) => is + num(it.cost) * num(it.qty), 0);
    return s + itemsCost;
  }, 0);

  // Collected payments in period: initial paid amounts on sales + subsequent installment/customer payments
  // Excludes unpaid credit/udhaar balances!
  const salesCollectedInPeriod = periodBills.reduce((s, b) => s + num(b.initialPaid !== undefined ? b.initialPaid : b.paid), 0);
  const khataCollectedInPeriod = periodInstallmentPayments.reduce((s, p) => s + num(p.amount), 0);
  const collectedPayments = salesCollectedInPeriod + khataCollectedInPeriod;

  // Customer balances (Cash/Credit sales with balance > 0 vs Installment plans with balance > 0)
  const cashCreditBillsWithBalance = bills.filter((b) => b.type !== 'installment' && num(b.balance) > 0);
  const customerCreditBalance = cashCreditBillsWithBalance.reduce((s, b) => s + num(b.balance), 0);

  const installmentBills = bills.filter((b) => b.type === 'installment');
  const activeInstallmentPlans = installmentBills.filter((b) => num(b.balance) > 0);
  const installmentBalance = activeInstallmentPlans.reduce((s, b) => s + num(b.balance), 0);

  const totalCustomerOutstanding = customerCreditBalance + installmentBalance;

  // Returns impact in period
  const returnsTotal = periodReturns.reduce((s, r) => s + num(r.totalReturnAmount), 0);
  const returnsCostRestored = periodReturns.reduce((s, r) => s + num(r.totalCostRestored), 0);
  const returnsMarginLost = returnsTotal - returnsCostRestored;

  // Expenses in period
  const expensesTotal = periodExpenses.reduce((s, e) => s + num(e.amount), 0);

  // Net Profit = (Net Sales - COGS) - Return Margin Lost - Expenses
  const grossProfit = netSales - cogs - returnsMarginLost;
  const netProfit = grossProfit - expensesTotal;

  // Cash in hand & Bank balances (all-time current state)
  const allCashSalesIn = bills.reduce((s, b) => s + num(b.cashCollected), 0);
  const allCashInstallmentsIn = installmentPayments
    .filter((p) => (p.method || 'cash').toLowerCase() === 'cash')
    .reduce((s, p) => s + num(p.amount), 0);
  const allCashExpensesOut = expenses
    .filter((e) => (e.paymentMethod || 'cash').toLowerCase() === 'cash')
    .reduce((s, e) => s + num(e.amount), 0);
  const allCashReturnsOut = returns
    .filter((r) => (r.refundMethod || 'cash').toLowerCase() === 'cash')
    .reduce((s, r) => s + num(r.totalReturnAmount), 0);
  const allCashSupplierOut = supplierPayments
    .filter((p) => (p.method || 'cash').toLowerCase() === 'cash')
    .reduce((s, p) => s + num(p.amount), 0);

  const cashInHand =
    num(openingCash) +
    allCashSalesIn +
    allCashInstallmentsIn -
    allCashExpensesOut -
    allCashReturnsOut -
    allCashSupplierOut;

  const bankBalancesTotal = bankAccounts.reduce((s, b) => s + signedNum(b.balance), 0);

  // Supplier payables
  const supplierPayablesTotal = suppliers.reduce((s, sup) => s + num(sup.balancePayable), 0);

  // Inventory valuation
  const stockUnits = products.reduce((s, p) => s + num(p.stock), 0);
  const stockCostValuation = products.reduce((s, p) => s + num(p.cost) * num(p.stock), 0);
  const stockRetailValuation = products.reduce((s, p) => s + num(p.price) * num(p.stock), 0);
  const lowStockCount = products.filter((p) => num(p.stock) <= num(p.reorderThreshold || 5)).length;

  return {
    todaySales,
    todayBillsCount: todayBills.length,
    periodBillsCount: periodBills.length,
    grossSales,
    totalDiscounts,
    netSales,
    cogs,
    collectedPayments,
    customerCreditBalance,
    installmentBalance,
    activeInstallmentPlansCount: activeInstallmentPlans.length,
    totalCustomerOutstanding,
    returnsTotal,
    returnsCount: periodReturns.length,
    expensesTotal,
    expensesCount: periodExpenses.length,
    grossProfit,
    netProfit,
    cashInHand,
    bankBalancesTotal,
    supplierPayablesTotal,
    stockUnits,
    stockCostValuation,
    stockRetailValuation,
    lowStockCount,
  };
}
