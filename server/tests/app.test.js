import test from 'node:test';
import assert from 'node:assert/strict';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'electrohub-test-only-secret-which-is-long-enough';
process.env.ALLOW_PUBLIC_SHOP_REGISTRATION = 'true';
const {
  verifyTenantAccess,
  calculateSaleTotals,
  validateStockAvailability,
  calculateCustomerReturn,
  calculateInstallmentPayment,
  validateStockReceipt,
  calculateShopFinancialSummary,
} = await import('../utils/calculations.js');
const { resetInMemoryStateForTests } = await import('../db.js');
const { createApp } = await import('../index.js');

// ============================================================================
// PART 1: PURE UNIT TESTS (Calculations, Stock, Returns, Installments, Finance)
// ============================================================================

test('verifyTenantAccess strictly enforces matching shopId', () => {
  assert.equal(verifyTenantAccess('shop_1', 'shop_1'), true);
  assert.equal(verifyTenantAccess('shop_1', 'shop_2'), false);
  assert.equal(verifyTenantAccess('', 'shop_1'), false);
  assert.equal(verifyTenantAccess(null, 'shop_1'), false);
});

test('calculateSaleTotals handles partial cash payments and unpaid udhaar accurately', () => {
  // Partial cash sale (unpaid balance goes to balance/udhaar, never counted as cashCollected)
  const partialCash = calculateSaleTotals({
    items: [{ id: 'p1', name: 'Samsung A15', qty: 1, price: 80000, cost: 71000 }],
    billDiscount: 5000,
    saleType: 'cash',
    paymentMethod: 'cash',
    cashAmount: 50000,
  });

  assert.equal(partialCash.gross, 80000);
  assert.equal(partialCash.discounted, 75000);
  assert.equal(partialCash.final, 75000);
  assert.equal(partialCash.paid, 50000);
  assert.equal(partialCash.cashCollected, 50000);
  assert.equal(partialCash.balance, 25000);
  assert.equal(partialCash.grossMargin, 4000); // 75,000 - 71,000
});

test('calculateSaleTotals computes installment plan surcharge, advance, balance, and monthly payment', () => {
  const inst = calculateSaleTotals({
    items: [{ id: 'p1', name: 'Samsung A15', qty: 1, price: 80000, cost: 71000 }],
    billDiscount: 5000,
    saleType: 'installment',
    installmentPercent: 10,
    advance: 15000,
    months: 12,
  });

  assert.equal(inst.discounted, 75000);
  assert.equal(inst.add, 7500);
  assert.equal(inst.final, 82500);
  assert.equal(inst.paid, 15000);
  assert.equal(inst.balance, 67500);
  assert.equal(inst.monthly, 5625);
});

test('validateStockAvailability prevents overselling when cart qty exceeds stock', () => {
  const map = new Map([
    ['p1', { id: 'p1', name: 'Haier Smart LED TV 43″', stock: 3, active: true }],
  ]);

  const okCheck = validateStockAvailability([{ productId: 'p1', qty: 3 }], map);
  assert.equal(okCheck.valid, true);

  const overCheck = validateStockAvailability([{ productId: 'p1', qty: 4 }], map);
  assert.equal(overCheck.valid, false);
  assert.match(overCheck.errors[0], /Insufficient stock/i);
  assert.equal(validateStockAvailability([{ productId: 'p1', qty: -1 }], map).valid, false);
  assert.equal(validateStockAvailability([{ productId: 'p1', qty: 1.5 }], map).valid, false);
});

test('calculateCustomerReturn prevents returning more than sold and prorates discount', () => {
  const bill = {
    invoiceNo: 'INV-2001',
    total: 75000,
    items: [{ productId: 'p1', name: 'Samsung A15', qty: 2, price: 40000, cost: 32000 }],
  };

  // First return of 1 unit
  const ret1 = calculateCustomerReturn({
    bill,
    returnItems: [{ productId: 'p1', qty: 1 }],
    priorReturns: [],
  });
  assert.equal(ret1.valid, true);
  assert.equal(ret1.totalReturnAmount, 37500);
  assert.equal(ret1.totalCostRestored, 32000);

  // Attempt to return 2 more units when only 1 remains eligible
  const retOver = calculateCustomerReturn({
    bill,
    returnItems: [{ productId: 'p1', qty: 2 }],
    priorReturns: [{ items: [{ productId: 'p1', qty: 1 }] }],
  });
  assert.equal(retOver.valid, false);
  assert.match(retOver.error, /Cannot return 2/i);
});

test('calculateInstallmentPayment updates balance and transitions status to Paid at zero', () => {
  const plan = { id: 'plan1', paid: 15000, balance: 20000, status: 'Active' };

  const partial = calculateInstallmentPayment({ plan, amount: 8000 });
  assert.equal(partial.valid, true);
  assert.equal(partial.newPaid, 23000);
  assert.equal(partial.newBalance, 12000);
  assert.equal(partial.newStatus, 'Active');

  const over = calculateInstallmentPayment({ plan, amount: 25000 });
  assert.equal(over.valid, false);

  const full = calculateInstallmentPayment({ plan, amount: 20000 });
  assert.equal(full.valid, true);
  assert.equal(full.newBalance, 0);
  assert.equal(full.newStatus, 'Paid');
});

test('validateStockReceipt blocks duplicate invoices and mismatched totals', () => {
  const existing = [{ supplier: 'Ali Electronics', invoiceNo: 'INV-99' }];
  const dup = validateStockReceipt({
    supplier: 'Ali Electronics',
    invoiceNo: 'inv-99',
    invoiceTotal: 71000,
    items: [{ name: 'Phone', qty: 1, cost: 71000, price: 80000 }],
    existingReceipts: existing,
  });
  assert.equal(dup.valid, false);
  assert.match(dup.error, /Duplicate supplier invoice/i);

  const mismatch = validateStockReceipt({
    supplier: 'Ali Electronics',
    invoiceNo: 'INV-100',
    invoiceTotal: 90000,
    items: [{ name: 'Phone', qty: 1, cost: 71000, price: 80000 }],
    existingReceipts: existing,
  });
  assert.equal(mismatch.valid, false);
  assert.match(mismatch.error, /does not match/i);

  const optionalWarranty = validateStockReceipt({
    supplier: 'Ali Electronics', invoiceNo: 'INV-101', invoiceTotal: 71000,
    items: [{ name: 'Phone', qty: 1, cost: 71000, price: 80000 }],
  });
  assert.equal(optionalWarranty.valid, true);
  const invalidWarranty = validateStockReceipt({
    supplier: 'Ali Electronics', invoiceNo: 'INV-102', invoiceTotal: 71000,
    items: [{ name: 'Phone', qty: 1, cost: 71000, price: 80000, warranty: '60 Months' }],
  });
  assert.equal(invalidWarranty.valid, false);
  assert.match(invalidWarranty.error, /3 and 48 months/i);
});

test('calculateShopFinancialSummary computes profit, cash in hand, and excludes unpaid udhaar from cash', () => {
  const nowIso = new Date().toISOString();
  const summary = calculateShopFinancialSummary({
    openingCash: 40000,
    bills: [
      {
        total: 80000,
        gross: 80000,
        billDiscount: 0,
        totalCost: 65000,
        initialPaid: 50000,
        paid: 50000,
        cashCollected: 50000,
        balance: 30000, // 30k unpaid credit/udhaar
        type: 'cash',
        createdAt: nowIso,
      },
    ],
    returns: [],
    expenses: [{ amount: 5000, paymentMethod: 'Cash', createdAt: nowIso }],
    products: [{ stock: 4, cost: 50000, price: 60000, reorderThreshold: 5 }],
    suppliers: [{ balancePayable: 20000 }],
    bankAccounts: [{ balance: 100000 }],
    installmentPayments: [],
    supplierPayments: [],
  });

  // Net profit = (80,000 - 65,000) - 5,000 = 10,000
  assert.equal(summary.netProfit, 10000);
  // Collected payments = 50,000 (30,000 unpaid credit is NOT counted as collected cash)
  assert.equal(summary.collectedPayments, 50000);
  assert.equal(summary.customerCreditBalance, 30000);
  // Cash in hand = 40,000 opening + 50,000 cash sale - 5,000 cash expense = 85,000
  assert.equal(summary.cashInHand, 85000);
});

// ============================================================================
// PART 2: API INTEGRATION, RBAC, AND MULTI-TENANT ISOLATION TESTS
// ============================================================================

test('Multi-tenant isolation, RBAC permissions, sales, returns, installments, and finance API flow', async () => {
  resetInMemoryStateForTests();

  const app = createApp();
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}/api`;

  async function api(path, { method = 'GET', token = '', body } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json();
    return { status: res.status, data };
  }

  try {
    process.env.ALLOW_PUBLIC_SHOP_REGISTRATION = 'false';
    const blockedRegistration = await api('/auth/register-shop', { method: 'POST', body: { shopName: 'Blocked', ownerName: 'Intruder', email: 'intruder@test.invalid', password: 'TestPass123' } });
    assert.equal(blockedRegistration.status, 403, 'Public shop registration is blocked by default in production');
    process.env.ALLOW_PUBLIC_SHOP_REGISTRATION = 'true';
    // Register clean tenants through the same flow a new shop uses.
    const ownerLogin = await api('/auth/register-shop', {
      method: 'POST',
      body: { shopName: 'First Electronics', ownerName: 'First Owner', email: 'owner@first.test', password: 'TestPass123' },
    });
    assert.equal(ownerLogin.status, 201);
    const ownerToken = ownerLogin.data.token;
    assert.equal(ownerLogin.data.shop.name, 'First Electronics');
    const failedOwnerLogin = await api('/auth/login', { method: 'POST', body: { email: 'owner@first.test', password: 'WrongPass123' } });
    assert.equal(failedOwnerLogin.status, 401, 'Incorrect login password is rejected');
    const staffCreate = await api('/users', {
      method: 'POST',
      token: ownerToken,
      body: { name: 'Shop Staff', email: 'staff@first.test', password: 'StaffPass123', role: 'shop_account' },
    });
    assert.equal(staffCreate.status, 201);
    const staffLogin = await api('/auth/login', { method: 'POST', body: { email: 'staff@first.test', password: 'StaffPass123' } });
    assert.equal(staffLogin.status, 200);
    const staffToken = staffLogin.data.token;

    const viewerCreate = await api('/users', { method: 'POST', token: ownerToken, body: { name: 'Store Reviewer', email: 'reviewer@first.test', password: 'ReviewPass123', role: 'overview_viewer' } });
    assert.equal(viewerCreate.status, 201);
    const viewerLogin = await api('/auth/login', { method: 'POST', body: { email: 'reviewer@first.test', password: 'ReviewPass123' } });
    assert.equal(viewerLogin.status, 200);
    const viewerToken = viewerLogin.data.token;
    const viewerOverview = await api('/overview', { token: viewerToken });
    assert.equal(viewerOverview.status, 200);
    assert.equal(viewerOverview.data.shop.name, 'First Electronics');
    assert.equal(viewerOverview.data.products, undefined, 'Overview response does not expose product/customer records');
    assert.equal((await api('/bootstrap', { token: viewerToken })).status, 403, 'Overview account cannot load full workspace records');
    assert.equal((await api('/products', { token: viewerToken })).status, 403, 'Overview account cannot access product pages or APIs');
    const secondViewer = await api('/users', { method: 'POST', token: ownerToken, body: { name: 'Second Reviewer', email: 'reviewer2@first.test', password: 'ReviewPass123', role: 'overview_viewer' } });
    assert.equal(secondViewer.status, 201);
    const thirdViewer = await api('/users', { method: 'POST', token: ownerToken, body: { name: 'Third Reviewer', email: 'reviewer3@first.test', password: 'ReviewPass123', role: 'overview_viewer' } });
    assert.equal(thirdViewer.status, 400, 'A store cannot have more than two active Overview accounts');
    assert.equal((await api(`/users/${viewerCreate.data.user.id}`, { method: 'PUT', token: ownerToken, body: { active: false } })).status, 200);
    const replacementViewer = await api('/users', { method: 'POST', token: ownerToken, body: { name: 'Replacement Reviewer', email: 'reviewer3@first.test', password: 'ReviewPass123', role: 'overview_viewer' } });
    assert.equal(replacementViewer.status, 201);
    assert.equal((await api(`/users/${viewerCreate.data.user.id}`, { method: 'PUT', token: ownerToken, body: { active: true } })).status, 400, 'Reactivating a third overview email cannot exceed the two active seats');

    const shop2Login = await api('/auth/register-shop', {
      method: 'POST',
      body: { shopName: 'Second Electronics', ownerName: 'Second Owner', email: 'owner@second.test', password: 'TestPass123' },
    });
    assert.equal(shop2Login.status, 201);
    const shop2Token = shop2Login.data.token;

    // 4. Verify Tenant Isolation: Shop 1 cannot see Shop 2's PS5 product, and spoofing shopId is blocked
    const shop1Boot = await api('/bootstrap', { token: ownerToken });
    assert.equal(shop1Boot.status, 200);
    assert.equal(shop1Boot.data.products.length, 0, 'New shop starts without sample inventory');

    const spoofAttempt = await api('/products?shopId=shop_citydigital_02', {
      token: ownerToken,
    });
    assert.equal(spoofAttempt.status, 403, 'Spoofing another tenant shopId must return 403');

    // 5. Verify Role Permissions: Staff can view finance/bootstrap, but cannot change Shop Settings or add Users
    const staffBoot = await api('/bootstrap', { token: staffToken });
    assert.equal(staffBoot.status, 200);
    assert.equal(staffBoot.data.financialTransactions.length, 0, 'New shop starts without sample finance records');

    const staffSettingsAttempt = await api('/settings', {
      method: 'PUT',
      token: staffToken,
      body: { name: 'Hacked Shop Name' },
    });
    assert.equal(staffSettingsAttempt.status, 403, 'Shop Account cannot modify Owner settings');

    // 6. Owner updates Shop Name & WhatsApp Number
    const ownerSettingsUpdate = await api('/settings', {
      method: 'PUT',
      token: ownerToken,
      body: { name: 'First Flagship Store', whatsapp: '+923009998877' },
    });
    assert.equal(ownerSettingsUpdate.status, 200);
    assert.equal(ownerSettingsUpdate.data.shop.name, 'First Flagship Store');
    assert.equal(ownerSettingsUpdate.data.shop.whatsapp, '+923009998877');
    const invalidAutomationSettings = await api('/settings', {
      method: 'PUT', token: ownerToken,
      body: { name: 'First Flagship Store', automation: { lowStockAlertsEnabled: true, lowStockRecipients: ['03001234567', 'bad'] } },
    });
    assert.equal(invalidAutomationSettings.status, 400, 'low-stock automation requires two valid WhatsApp numbers');
    const automationSettings = await api('/settings', {
      method: 'PUT', token: ownerToken,
      body: { name: 'First Flagship Store', automation: {
        installmentRemindersEnabled: true,
        lowStockAlertsEnabled: true,
        lowStockRecipients: ['03001234567', '+923007654321'],
      } },
    });
    assert.deepEqual(automationSettings.data.shop.automation.lowStockRecipients, ['923001234567', '923007654321']);

    const productRes = await api('/products', {
      method: 'POST', token: ownerToken,
      body: { name: 'Test Bluetooth Speaker', code: 'TEST-SPK-1', cost: 10000, price: 15000, stock: 4 },
    });
    assert.equal(productRes.status, 201);
    assert.equal(productRes.data.product.warranty, '', 'warranty is blank unless explicitly entered');
    const productId = productRes.data.product.id;
    const staleCustomerProductRes = await api('/products', {
      method: 'POST', token: ownerToken,
      body: { name: 'Stale Customer Test Product', code: 'TEST-STALE-1', cost: 1000, price: 1500, stock: 1 },
    });
    assert.equal(staleCustomerProductRes.status, 201);

    // Create a sale and verify stock deduction + idempotency.
    const saleRes = await api('/sales', {
      method: 'POST',
      token: staffToken,
      body: {
        idempotencyKey: 'idem-sale-001',
        customerId: 'walkin',
        saleType: 'cash',
        items: [{ productId, qty: 2, price: 15000 }],
        billDiscount: 1000,
        salePayment: { method: 'cash', cash: '29000' },
      },
    });
    assert.equal(saleRes.status, 201);
    assert.equal(saleRes.data.sale.total, 29000);
    assert.equal(saleRes.data.sale.items[0].warranty, '', 'sale invoices do not invent a warranty');

    // Older browser sessions can retain the demo customer ID "c1". A walk-in sale
    // should still complete safely instead of sending that value through ObjectId casting.
    const staleCustomerSale = await api('/sales', {
      method: 'POST',
      token: staffToken,
      body: {
        idempotencyKey: 'idem-sale-stale-customer',
        customerId: 'c1',
        customerInfo: { name: 'Walk-in customer' },
        saleType: 'cash',
        items: [{ productId: staleCustomerProductRes.data.product.id, qty: 1, price: 1500 }],
        salePayment: { method: 'cash', cash: '1500' },
      },
    });
    assert.equal(staleCustomerSale.status, 201, staleCustomerSale.data.error);
    assert.equal(staleCustomerSale.data.sale.customer, 'Walk-in customer');

    const unpaidWalkInSale = await api('/sales', {
      method: 'POST',
      token: staffToken,
      body: {
        idempotencyKey: 'idem-sale-unpaid-walkin',
        customerId: 'walkin',
        customerInfo: { name: 'Walk-in customer' },
        saleType: 'cash',
        items: [{ productId, qty: 1, price: 15000 }],
        salePayment: { method: 'cash', cash: '10000' },
      },
    });
    assert.equal(unpaidWalkInSale.status, 400);
    assert.match(unpaidWalkInSale.data.error, /walk-in sales must be paid in full/i);

    const missingCustomerSale = await api('/sales', {
      method: 'POST',
      token: staffToken,
      body: {
        idempotencyKey: 'idem-sale-missing-customer',
        customerId: 'missing-customer-id',
        customerInfo: { name: 'A real customer' },
        saleType: 'cash',
        items: [{ productId, qty: 1, price: 15000 }],
        salePayment: { method: 'cash', cash: '15000' },
      },
    });
    assert.equal(missingCustomerSale.status, 400);
    assert.match(missingCustomerSale.data.error, /customer was not found/i);

    // Duplicate submission with same idempotencyKey does not double-deduct stock
    const dupSaleRes = await api('/sales', {
      method: 'POST',
      token: staffToken,
      body: {
        idempotencyKey: 'idem-sale-001',
        customerId: 'walkin',
        saleType: 'cash',
        items: [{ productId, qty: 2, price: 15000 }],
        billDiscount: 1000,
        salePayment: { method: 'cash', cash: '29000' },
      },
    });
    assert.equal(dupSaleRes.data.duplicate, true);

    const afterSaleProducts = await api('/products', { token: ownerToken });
    const testSpeaker = afterSaleProducts.data.products.find((p) => p.id === productId);
    assert.equal(testSpeaker.stock, 2);

    // 8. Customer Return restores stock and blocks returning more than sold
    const retRes = await api('/returns', {
      method: 'POST',
      token: ownerToken,
      body: {
        invoiceNo: saleRes.data.sale.invoiceNo,
        items: [{ productId, qty: 1 }],
        reason: 'Customer exchanged model',
        refundMethod: 'cash',
      },
    });
    assert.equal(retRes.status, 201);

    const afterReturnProducts = await api('/products', { token: ownerToken });
    const testSpeakerAfterReturn = afterReturnProducts.data.products.find((p) => p.id === productId);
    assert.equal(testSpeakerAfterReturn.stock, 3);

    // 10. Shop 2 data remained completely untouched
    const shop2Boot = await api('/bootstrap', { token: shop2Token });
    assert.equal(shop2Boot.data.sales.length, 0);
    assert.equal(shop2Boot.data.products.length, 0);
  } finally {
    server.close();
  }
});

test('Gallery invoice upload remains a draft, accepts large images, and posts only on confirmation', async () => {
  resetInMemoryStateForTests();
  const { db } = await import('../db.js');
  const oldKey = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  const server = await new Promise((resolve) => {
    const listener = createApp().listen(0, '127.0.0.1', () => resolve(listener));
  });
  let token = '';
  const api = async (path, body) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() };
  };
  try {
    const registration = await api('/auth/register-shop', { shopName: 'Upload Test', ownerName: 'Test Owner', email: 'upload@test.invalid', password: 'UploadTest123' });
    assert.equal(registration.status, 201);
    token = registration.data.token;
    const shopId = registration.data.shop.id;
    const image = { fileName: 'gallery-invoice.png', mimeType: 'image/png', dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jM7sAAAAASUVORK5CYII=' };
    const draft = await api('/ocr/invoice', image);
    assert.equal(draft.status, 200);
    assert.equal(draft.data.ocrStatus, 'manual_required');
    assert.match(draft.data.limitationNote, /not configured/i);
    assert.deepEqual(draft.data.draft.items, []);
    assert.equal(draft.data.draft.invoiceNo, '');
    assert.equal(draft.data.draft.invoiceTotal, '');
    assert.equal(draft.data.draft.date, '');
    const largeImage = { ...image, dataUrl: `data:image/png;base64,${Buffer.alloc(9 * 1024 * 1024).toString('base64')}` };
    assert.equal((await api('/ocr/invoice', largeImage)).status, 200, '9 MiB upload fits after base64 expansion');
    const oversized = { ...image, dataUrl: `data:image/png;base64,${Buffer.alloc(10 * 1024 * 1024 + 1).toString('base64')}` };
    assert.equal((await api('/ocr/invoice', oversized)).status, 413);
    assert.equal((await api('/ocr/invoice', { ...image, mimeType: 'text/html' })).status, 400);
    const pdf = await api('/ocr/invoice', { fileName: 'invoice.pdf', mimeType: 'application/pdf', dataUrl: 'data:application/pdf;base64,JVBERi0xLjQ=' });
    assert.equal(pdf.data.ocrStatus, 'manual_required');
    for (const name of ['Product', 'Supplier', 'StockReceipt', 'StockMovement', 'FinancialTransaction']) {
      assert.equal(await db[name].count({ shopId }), 0, `${name} is unchanged before confirmation`);
    }
    const receipt = {
      supplier: 'Upload Supplier', invoiceNo: 'UPLOAD-01', invoiceDate: '2026-10-22', invoiceTotal: 200,
      items: [{ name: 'Uploaded Product', code: 'UPLOAD-SKU', qty: 2, cost: 100, price: 150, warranty: '24 Months' }],
      paymentMethod: 'cash', paidNow: 50, documentName: image.fileName, documentType: image.mimeType,
      documentDataUrl: image.dataUrl, ocrDraftUsed: true,
    };
    assert.equal((await api('/stock-receipts', { ...receipt, invoiceTotal: 201 })).status, 400);
    assert.equal((await api('/stock-receipts', { ...receipt, invoiceNo: 'UPLOAD-LARGE', documentDataUrl: oversized.dataUrl })).status, 400,
      'the receipt endpoint enforces the same 10 MiB document ceiling as OCR');
    assert.equal((await api('/stock-receipts', { ...receipt, invoiceNo: 'UPLOAD-MIME', documentType: 'application/pdf' })).status, 400,
      'a declared MIME type must match the uploaded document');
    assert.equal(await db.Product.count({ shopId }), 0);
    const saved = await api('/stock-receipts', receipt);
    assert.equal(saved.status, 201);
    assert.equal(saved.data.receipt.documentDataUrl, image.dataUrl);
    assert.equal((await db.Product.findOne({ shopId, code: 'UPLOAD-SKU' })).price, 150);
    assert.equal((await db.Product.findOne({ shopId, code: 'UPLOAD-SKU' })).stock, 2);
    assert.equal((await db.Product.findOne({ shopId, code: 'UPLOAD-SKU' })).warranty, '24 Months');
    assert.equal((await db.Supplier.findOne({ shopId, name: receipt.supplier })).balancePayable, 150);
    assert.equal(await db.FinancialTransaction.count({ shopId }), 1);

    // A later receipt matched by SKU updates stock, purchase cost, and explicitly entered sale price.
    const repriced = await api('/stock-receipts', {
      supplier: 'Upload Supplier', invoiceNo: 'UPLOAD-02', invoiceDate: '2026-10-22', invoiceTotal: 360,
      items: [{ name: 'Uploaded Product', code: 'UPLOAD-SKU', qty: 3, cost: 120, price: 520 }],
      paymentMethod: 'credit', paidNow: 0,
    });
    assert.equal(repriced.status, 201);
    let savedProduct = await db.Product.findOne({ shopId, code: 'UPLOAD-SKU' });
    assert.equal(savedProduct.stock, 5);
    assert.equal(savedProduct.cost, 120);
    assert.equal(savedProduct.price, 520);

    // If sale price is omitted for an existing SKU, retain its current value.
    const keepPrice = await api('/stock-receipts', {
      supplier: 'Upload Supplier', invoiceNo: 'UPLOAD-03', invoiceDate: '2026-10-22', invoiceTotal: 120,
      items: [{ name: 'Uploaded Product', code: 'UPLOAD-SKU', qty: 1, cost: 120 }],
      paymentMethod: 'credit', paidNow: 0,
    });
    assert.equal(keepPrice.status, 201);
    savedProduct = await db.Product.findOne({ shopId, code: 'UPLOAD-SKU' });
    assert.equal(savedProduct.stock, 6);
    assert.equal(savedProduct.price, 520);
    assert.equal(savedProduct.warranty, '24 Months', 'warranty stays unchanged when the receipt leaves it optional');

    const noWarrantyReceipt = await api('/stock-receipts', {
      supplier: 'Upload Supplier', invoiceNo: 'UPLOAD-05', invoiceDate: '2026-10-22', invoiceTotal: 100,
      items: [{ name: 'No Warranty Product', code: 'NO-WARRANTY-SKU', qty: 1, cost: 100, price: 140 }],
      paymentMethod: 'credit', paidNow: 0,
    });
    assert.equal(noWarrantyReceipt.status, 201);
    assert.equal((await db.Product.findOne({ shopId, code: 'NO-WARRANTY-SKU' })).warranty, '');

    // New products cannot silently enter inventory with a zero sale price.
    const missingSalePrice = await api('/stock-receipts', {
      supplier: 'Upload Supplier', invoiceNo: 'UPLOAD-04', invoiceDate: '2026-10-22', invoiceTotal: 100,
      items: [{ name: 'No Price Product', code: 'NO-PRICE', qty: 1, cost: 100 }],
      paymentMethod: 'credit', paidNow: 0,
    });
    assert.equal(missingSalePrice.status, 400);
    assert.equal(await db.Product.findOne({ shopId, code: 'NO-PRICE' }), null);

    assert.equal((await api('/stock-receipts', receipt)).status, 400);
    assert.equal((await db.Product.findOne({ shopId, code: 'UPLOAD-SKU' })).stock, 6);
    const bootstrapResponse = await fetch(`http://127.0.0.1:${server.address().port}/api/bootstrap`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const bootstrap = await bootstrapResponse.json();
    const uploadedReceipt = bootstrap.stockReceipts.find((savedReceipt) => savedReceipt.invoiceNo === 'UPLOAD-01');
    assert.equal(uploadedReceipt.documentDataUrl, undefined);
    assert.equal(uploadedReceipt.hasDocument, true);
  } finally {
    if (oldKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = oldKey;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('Urdu invoice drafts separate totals and flag unclear handwriting without inventing fields', async () => {
 const { normalizeInvoiceDraft } = await import('../utils/invoiceOcr.js');
 const draft=normalizeInvoiceDraft({supplier:'',invoiceNo:'2128',date:'2026-10-07',invoiceTotal:1679900,paidAmount:1000000,balanceAmount:679900,
  items:[{name:'Urdu item',code:'4589',codeType:'hsn',qty:9,cost:11800,price:null,lineTotal:106200},
         {name:'',qty:null,cost:12200,price:null,lineTotal:122000,reviewNote:'Description obscured by glare'}]});
 assert.equal(draft.invoiceTotal,1679900);
 assert.equal(draft.paidAmount,1000000);
 assert.equal(draft.balanceAmount,679900);
 assert.equal(draft.supplier,'');
 assert.equal(draft.items[0].code,'');
 assert.equal(draft.items[0].price,undefined);
 assert.equal(draft.items[1].name,'');
 assert.equal(draft.items[1].qty,'');
 assert.match(draft.warnings.join(' '),/unclear/);
 assert.ok(!draft.warnings.join(' ').includes('retail prices'));
 const mismatch=normalizeInvoiceDraft({items:[{name:'Test',qty:2,cost:100,price:null,lineTotal:300}]});
 assert.match(mismatch.warnings.join(' '),/does not match/);
});

test('Finance and expense edits keep invoice, bank, and ledger balances in sync', async () => {
  resetInMemoryStateForTests();
  const { db } = await import('../db.js');
  const server = await new Promise((resolve) => {
    const listener = createApp().listen(0, '127.0.0.1', () => resolve(listener));
  });
  const api = async (path, { method = 'GET', token = '', body } = {}) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, {
      method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() };
  };
  try {
    const registration = await api('/auth/register-shop', { method: 'POST', body: {
      shopName: 'Ledger Test', ownerName: 'Owner', email: 'ledger@test.invalid', password: 'LedgerTest123',
    } });
    const token = registration.data.token;
    assert.equal(registration.status, 201);

    const product = await api('/products', { method: 'POST', token, body: { name: 'Test item', code: 'LEDGER-1', cost: 50, price: 100, stock: 2 } });
    const sale = await api('/sales', { method: 'POST', token, body: {
      customerId: 'new', customerInfo: { name: 'Ledger Customer' }, saleType: 'cash', items: [{ productId: product.data.product.id, qty: 1, price: 100 }],
      salePayment: { method: 'cash', cash: 40 },
    } });
    assert.equal(sale.status, 201);

    const invalidMethod = await api('/finance/transactions', { method: 'POST', token, body: {
      type: 'arbitrary', direction: 'out', method: 'split', amount: 1, relatedId: sale.data.sale.invoiceNo,
    } });
    assert.equal(invalidMethod.status, 400);
    const splitSale = await api('/sales', { method: 'POST', token, body: {
      saleType: 'cash', items: [{ productId: product.data.product.id, qty: 1, price: 100 }],
      salePayment: { method: 'split', cash: 50, bank: 50 },
    } });
    assert.equal(splitSale.status, 400);
    assert.equal((await api('/cheques', { method: 'POST', token, body: { chequeNo: 'CHQ-1', bankName: 'HBL', partyName: 'Test', amount: 1 } })).status, 410);
    assert.equal((await api('/installments/plans', { method: 'POST', token, body: { name: 'Long Plan', total: 1000, advance: 0, months: 61 } })).status, 400);
    const overpayment = await api('/finance/transactions', { method: 'POST', token, body: {
      type: 'customer_receipt', direction: 'in', method: 'bank', bankName: 'HBL', amount: 61, relatedId: sale.data.sale.invoiceNo,
    } });
    assert.equal(overpayment.status, 400);
    assert.equal((await db.Sale.findOne({ invoiceNo: sale.data.sale.invoiceNo })).paid, 40);
    assert.equal((await db.BankAccount.findOne({ shopId: registration.data.shop.id, bankName: 'HBL' })).balance, 0);

    const receipt = await api('/finance/transactions', { method: 'POST', token, body: {
      type: 'customer_receipt', direction: 'in', method: 'bank', bankName: 'HBL', amount: 60, relatedId: sale.data.sale.invoiceNo,
    } });
    assert.equal(receipt.status, 201);
    assert.equal((await db.Sale.findOne({ invoiceNo: sale.data.sale.invoiceNo })).balance, 0);
    const bank = await db.BankAccount.findOne({ shopId: registration.data.shop.id, bankName: 'HBL' });
    assert.equal(bank.balance, 60);

    const expense = await api('/expenses', { method: 'POST', token, body: {
      title: 'Shop rent', category: 'Rent', date: '2026-10-23', amount: 20, paymentMethod: 'Bank', bankName: 'HBL',
    } });
    assert.equal(expense.status, 201);
    assert.equal((await db.BankAccount.findOne({ _id: bank.id })).balance, 40);
    const edit = await api(`/expenses/${expense.data.expense.id}`, { method: 'PUT', token, body: {
      title: 'Shop rent', category: 'Rent', date: '2026-10-23', amount: 35, paymentMethod: 'Bank', bankName: 'HBL',
    } });
    assert.equal(edit.status, 200);
    assert.equal((await db.BankAccount.findOne({ _id: bank.id })).balance, 25);
    let expenseTx = await db.FinancialTransaction.findOne({ shopId: registration.data.shop.id, type: 'expense', relatedId: expense.data.expense.id });
    assert.equal(expenseTx.amount, 35);
    assert.equal(expenseTx.bankName, 'HBL');

    const switchToCash = await api(`/expenses/${expense.data.expense.id}`, { method: 'PUT', token, body: {
      amount: 10, paymentMethod: 'Cash', bankName: '',
    } });
    assert.equal(switchToCash.status, 200);
    assert.equal((await db.BankAccount.findOne({ _id: bank.id })).balance, 60);
    expenseTx = await db.FinancialTransaction.findOne({ shopId: registration.data.shop.id, type: 'expense', relatedId: expense.data.expense.id });
    assert.equal(expenseTx.amount, 10);
    assert.equal(expenseTx.method, 'cash');

    const noBank = await api('/expenses', { method: 'POST', token, body: {
      title: 'Invalid bank payment', date: '2026-10-23', amount: 3, paymentMethod: 'Bank', bankName: 'Not configured',
    } });
    assert.equal(noBank.status, 400);
    assert.equal(await db.Expense.count({ shopId: registration.data.shop.id }), 1);

    const supplier = await api('/suppliers', { method: 'POST', token, body: { name: 'Supplier A', openingBalance: 100 } });
    assert.equal(supplier.status, 201);
    const rejectedChequePayment = await api(`/suppliers/${supplier.data.supplier.id}/pay`, { method: 'POST', token, body: { amount: 10, method: 'cheque' } });
    assert.equal(rejectedChequePayment.status, 400);
    assert.equal((await db.Supplier.findOne({ _id: supplier.data.supplier.id })).balancePayable, 100);
    const missingBankSupplierPayment = await api(`/suppliers/${supplier.data.supplier.id}/pay`, { method: 'POST', token, body: { amount: 10, method: 'bank', bankName: 'Not configured' } });
    assert.equal(missingBankSupplierPayment.status, 400);
    assert.equal((await db.Supplier.findOne({ _id: supplier.data.supplier.id })).balancePayable, 100);

    const partialSale = await api('/sales', { method: 'POST', token, body: {
      customerId: 'new', customerInfo: { name: 'Partial Buyer' }, saleType: 'cash',
      items: [{ productId: product.data.product.id, qty: 1, price: 100 }], salePayment: { method: 'cash', cash: 40 },
    } });
    assert.equal(partialSale.status, 201);
    assert.equal((await db.Customer.findOne({ shopId: registration.data.shop.id, name: 'Partial Buyer' })).creditBalance, 60);
    const partialReturn = await api('/returns', { method: 'POST', token, body: {
      invoiceNo: partialSale.data.sale.invoiceNo, items: [{ productId: product.data.product.id, qty: 1 }], refundMethod: 'cash',
    } });
    assert.equal(partialReturn.status, 201);
    assert.equal((await db.Sale.findOne({ invoiceNo: partialSale.data.sale.invoiceNo })).balance, 0);
    assert.equal((await db.Customer.findOne({ shopId: registration.data.shop.id, name: 'Partial Buyer' })).creditBalance, 0);
    const returnTx = await db.FinancialTransaction.findOne({ shopId: registration.data.shop.id, type: 'return_refund', relatedId: partialSale.data.sale.invoiceNo });
    assert.equal(returnTx.amount, 40, 'only the paid portion of a returned item is refunded as cash');
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('Installment sales save customer and guarantor photos inside one details object', async () => {
  resetInMemoryStateForTests();
  const { db } = await import('../db.js');
  const server = await new Promise((resolve) => {
    const listener = createApp().listen(0, '127.0.0.1', () => resolve(listener));
  });
  const api = async (path, { method = 'POST', token = '', body } = {}) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() };
  };
  try {
    const registration = await api('/auth/register-shop', { body: {
      shopName: 'Installment Photo Test', ownerName: 'Owner', email: 'installment-photo@test.invalid', password: 'InstallmentPhoto123',
    } });
    assert.equal(registration.status, 201);
    const token = registration.data.token;
    const product = await api('/products', { token, body: { name: 'Test fan', code: 'PHOTO-1', cost: 50, price: 100, stock: 2 } });
    assert.equal(product.status, 201);
    const customerPhoto = 'data:image/jpeg;base64,/9j/2Q==';
    const guarantorPhoto = 'data:image/png;base64,iVBORw0KGgo=';
    const sale = await api('/sales', { token, body: {
      customerId: 'new', saleType: 'installment',
      customerInfo: {
        name: 'Test Customer', phone: '03001234567', whatsapp: '03007654321', cnic: '12345-1234567-1', address: 'Test address',
        customerPhoto, guarantor: 'Test Guarantor', guarantorPhone: '03001112222', guarantorAddress: 'Guarantor address', guarantorPhoto,
      },
      items: [{ productId: product.data.product.id, qty: 1, price: 100 }],
      plan: { months: 10, advance: 20, percent: 10 },
      salePayment: { method: 'cash' },
    } });
    assert.equal(sale.status, 201, sale.data.error);
    const storedPlan = await db.InstallmentPlan.findOne({ invoiceNo: sale.data.sale.invoiceNo });
    assert.equal(storedPlan.installmentDetails.customer.photoDataUrl, customerPhoto);
    assert.equal(storedPlan.installmentDetails.guarantor.photoDataUrl, guarantorPhoto);
    assert.equal(storedPlan.installmentDetails.plan.months, 10);
    assert.equal(storedPlan.installmentDetails.customer.cnic, '12345-1234567-1');
    const missingConsent = await api(`/installments/${storedPlan.id}/reminders`, {
      method: 'PATCH', token, body: { enabled: true, customerConsent: false },
    });
    assert.equal(missingConsent.status, 400);
    const enabledReminder = await api(`/installments/${storedPlan.id}/reminders`, {
      method: 'PATCH', token, body: { enabled: true, customerConsent: true },
    });
    assert.equal(enabledReminder.status, 200);
    assert.equal(enabledReminder.data.plan.whatsappReminderEnabled, true);
    const disabledReminder = await api(`/installments/${storedPlan.id}/reminders`, {
      method: 'PATCH', token, body: { enabled: false, customerConsent: false },
    });
    assert.equal(disabledReminder.data.plan.whatsappReminderEnabled, false);

    const invalidPhotoSale = await api('/sales', { token, body: {
      customerId: 'new', saleType: 'installment', customerInfo: { name: 'Invalid Photo', customerPhoto: 'data:application/pdf;base64,AA==' },
      items: [{ productId: product.data.product.id, qty: 1, price: 100 }], plan: { months: 10, advance: 20, percent: 10 },
    } });
    assert.equal(invalidPhotoSale.status, 400);
    assert.match(invalidPhotoSale.data.error, /customer photo/i);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('Shop accounts require eight-character passwords and reset codes lock after five wrong attempts', async () => {
  resetInMemoryStateForTests();
  const { db } = await import('../db.js');
  const crypto = await import('node:crypto');
  const server = await new Promise((resolve) => {
    const listener = createApp().listen(0, '127.0.0.1', () => resolve(listener));
  });
  const api = async (path, { method = 'POST', token = '', body } = {}) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, {
      method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() };
  };
  try {
    const registration = await api('/auth/register-shop', { body: {
      shopName: 'Password Test', ownerName: 'Owner', email: 'password@test.invalid', password: 'PasswordTest123',
    } });
    assert.equal(registration.status, 201);
    assert.equal((await api('/users', { token: registration.data.token, body: {
      name: 'Short Password', email: 'short@test.invalid', password: '1234567',
    } })).status, 400);

    const user = await db.User.findOne({ email: 'password@test.invalid' });
    const resetCode = '123456';
    await db.User.updateOne({ _id: user.id, shopId: user.shopId }, {
      resetCodeHash: crypto.createHash('sha256').update(resetCode).digest('hex'),
      resetExpiresAt: new Date(Date.now() + 15 * 60 * 1000), resetAttempts: 0, resetLockedUntil: null,
    });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      assert.equal((await api('/auth/reset-password', { body: {
        email: user.email, resetCode: '000000', newPassword: 'NewPassword123',
      } })).status, 400);
    }
    const lockedUser = await db.User.findOne({ _id: user.id, shopId: user.shopId });
    assert.equal(lockedUser.resetCodeHash, null);
    assert.ok(new Date(lockedUser.resetLockedUntil) > new Date());
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('WhatsApp automations deduplicate monthly reminders and rearm stock alerts after restocking', async () => {
  const { db, resetInMemoryStateForTests } = await import('../db.js');
  const { runAutomationCycle } = await import('../services/automationScheduler.js');
  const envKeys = [
    'WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_GRAPH_API_VERSION',
    'WHATSAPP_TEMPLATE_LANGUAGE', 'WHATSAPP_INSTALLMENT_TEMPLATE', 'WHATSAPP_LOW_STOCK_TEMPLATE',
  ];
  const previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  const sent = [];
  envKeys.forEach((key) => delete process.env[key]);
  process.env.WHATSAPP_ACCESS_TOKEN = 'test-token';
  process.env.WHATSAPP_PHONE_NUMBER_ID = 'test-phone-id';
  globalThis.fetch = async (url, options) => {
    sent.push({ url, body: JSON.parse(options.body) });
    return { ok: true, status: 200, json: async () => ({ messages: [{ id: `test-${sent.length}` }] }) };
  };

  try {
    resetInMemoryStateForTests();
    const shop = await db.Shop.create({
      name: 'Automation Test Shop',
      automation: {
        installmentRemindersEnabled: true,
        lowStockAlertsEnabled: true,
        lowStockRecipients: ['03001234567', '+923007654321'],
      },
    });
    const product = await db.Product.create({
      shopId: shop.id, name: 'Test Fan', code: 'FAN-01', stock: 2, reorderThreshold: 5,
    });
    const plan = await db.InstallmentPlan.create({
      shopId: shop.id, planNo: 'PLAN-TEST-1', customerName: 'Test Customer',
      whatsapp: '03007654321', totalAmount: 12000, paid: 2000, balance: 10000,
      monthlyAmount: 1000, nextDueDate: '2026-10-01',
      whatsappReminderEnabled: true, whatsappReminderConsent: true,
    });

    await runAutomationCycle(new Date('2026-10-23T06:00:00.000Z'));
    assert.equal(sent.length, 3, 'one customer reminder and two recipient stock alerts are sent');
    assert.deepEqual(
      sent.slice(0, 2).map((message) => message.body.to),
      ['923001234567', '923007654321']
    );
    assert.equal(sent[0].body.template.name, 'low_stock_alert');
    assert.equal(sent[2].body.type, 'template');
    assert.equal(sent[2].body.template.name, 'installment_payment_reminder');
    assert.equal(sent[2].body.to, '923007654321');

    await runAutomationCycle(new Date('2026-10-23T06:10:00.000Z'));
    assert.equal(sent.length, 3, 'the same month and low-stock period do not send duplicates');

    await db.Product.updateOne({ _id: product.id, shopId: shop.id }, { stock: 6 });
    await runAutomationCycle(new Date('2026-10-23T06:15:00.000Z'));
    await db.Product.updateOne({ _id: product.id, shopId: shop.id }, { stock: 4 });
    await runAutomationCycle(new Date('2026-10-23T06:20:00.000Z'));
    assert.equal(sent.length, 5, 'restocking above threshold rearms both recipient alerts');

    await runAutomationCycle(new Date('2026-11-23T06:00:00.000Z'));
    assert.equal(sent.length, 6, 'the unpaid plan gets one reminder in the next due month');
    assert.equal((await db.InstallmentPlan.findById(plan.id)).lastWhatsAppReminderMonth, '2026-11');
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of envKeys) {
      if (previousEnv[key] === undefined) delete process.env[key];
      else process.env[key] = previousEnv[key];
    }
  }
});
