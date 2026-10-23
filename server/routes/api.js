import { INVOICE_OCR_PROMPT, normalizeInvoiceDraft } from '../utils/invoiceOcr.js';
import express from 'express';
import crypto from 'crypto';
import nodemailer from 'nodemailer';
import { GoogleGenAI } from '@google/genai';
import { db, runInTransaction } from '../db.js';
import { matchProduct, normalizeKey } from '../utils/productMatching.js';
import {
  AUTH_COOKIE_NAME,
  AUTH_COOKIE_MAX_AGE_MS,
  hashPassword,
  verifyPassword,
  signAuthToken,
  extractToken,
  verifyAuthToken,
  requireAuth,
  requireOwner,
} from '../middleware/auth.js';
import {
  num,
  signedNum,
  verifyTenantAccess,
  calculateSaleTotals,
  validateStockAvailability,
  calculateCustomerReturn,
  calculateInstallmentPayment,
  validateStockReceipt,
  calculateShopFinancialSummary,
} from '../utils/calculations.js';

export const apiRouter = express.Router();

const pakistanDateString = (date = new Date()) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Karachi', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);

function isValidDateOnly(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) &&
    Number.isFinite(Date.parse(`${value}T00:00:00Z`)) &&
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

function validateAttachment(dataUrl, allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf']) {
  if (!dataUrl) return { valid: true, mimeType: '' };
  const match = /^data:(image\/(?:jpeg|png|webp)|application\/pdf);base64,([A-Za-z0-9+/=\r\n]+)$/.exec(String(dataUrl));
  if (!match || !allowedTypes.includes(match[1])) return { valid: false, error: 'Attachment must be a JPEG, PNG, WebP, or PDF.' };
  const encoded = match[2].replace(/\s/g, '');
  const bytes = Math.floor(encoded.length * 3 / 4) - (encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0);
  if (bytes > 10 * 1024 * 1024) return { valid: false, error: 'Attachment must be 10 MiB or smaller.' };
  return { valid: true, mimeType: match[1] };
}

function validateInstallmentPhoto(dataUrl, label) {
  const result = validateAttachment(dataUrl, ['image/jpeg', 'image/png', 'image/webp']);
  if (!result.valid) return { valid: false, error: `${label} must be a JPG, PNG, or WebP image.` };
  const encoded = String(dataUrl || '').split(',')[1] || '';
  const bytes = Math.floor(encoded.length * 3 / 4) - (encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0);
  if (bytes > 2 * 1024 * 1024) return { valid: false, error: `${label} must be 2 MiB or smaller.` };
  return { valid: true };
}

function setAuthCookie(res, token) {
  res.cookie(AUTH_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: AUTH_COOKIE_MAX_AGE_MS,
    path: '/',
  });
}

async function logAudit(shopId, user, action, entityType, entityId, summary) {
  await db.AuditEvent.create({
    shopId: String(shopId),
    action,
    entityType,
    entityId: String(entityId || ''),
    summary,
    actorName: user?.name || 'System',
    actorRole: user?.role || 'system',
  });
}

// ============================================================================
// 1. AUTHENTICATION & TENANT REGISTRATION ROUTES
// ============================================================================

apiRouter.get('/auth/me', async (req, res) => {
  try {
    const token = extractToken(req);
    if (!token) {
      return res.json({ authenticated: false });
    }
    const decoded = verifyAuthToken(token);
    if (!decoded || !decoded.sub || !decoded.shopId) {
      return res.json({ authenticated: false });
    }
    const user = await db.User.findOne({ _id: decoded.sub, shopId: decoded.shopId });
    if (!user || user.active === false) {
      return res.json({ authenticated: false });
    }
    const shop = await db.Shop.findById(user.shopId);
    if (!shop) {
      return res.json({ authenticated: false });
    }
    return res.json({
      authenticated: true,
      user: {
        id: user.id,
        shopId: user.shopId,
        name: user.name,
        email: user.email,
        role: user.role,
      },
      shop,
    });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to check session.' });
  }
});

apiRouter.post('/auth/register-shop', async (req, res) => {
  try {
    if (process.env.ALLOW_PUBLIC_SHOP_REGISTRATION !== 'true') {
      return res.status(403).json({ error: 'Public shop registration is disabled. Ask your shop owner for an account.' });
    }
    const { shopName, whatsapp, phone, address, city, ownerName, email, password } = req.body || {};
    const cleanShop = String(shopName || '').trim();
    const cleanOwner = String(ownerName || '').trim();
    const cleanEmail = String(email || '').trim().toLowerCase();
    const cleanPass = String(password || '');

    if (!cleanShop || !cleanOwner || !cleanEmail || cleanPass.length < 8) {
      return res.status(400).json({
        error: 'Shop name, owner name, email, and a password of at least 8 characters are required.',
      });
    }

    const existingEmail = await db.User.findOne({ email: cleanEmail });
    if (existingEmail) {
      return res.status(409).json({
        error: 'An account with this email already exists. Please sign in or use another email.',
      });
    }

    const result = await runInTransaction(async () => {
      const shop = await db.Shop.create({
        name: cleanShop,
        whatsapp: String(whatsapp || phone || '').trim(),
        phone: String(phone || whatsapp || '').trim(),
        address: String(address || '').trim(),
        city: String(city || '').trim(),
        receiptFooter: `Thank you for shopping at ${cleanShop}!`,
        invoicePrefix: 'INV',
        currency: 'PKR',
        openingCash: 0,
      });

      const passwordHash = await hashPassword(cleanPass);
      const user = await db.User.create({
        shopId: shop.id,
        name: cleanOwner,
        email: cleanEmail,
        passwordHash,
        role: 'owner',
        active: true,
        lastLoginAt: new Date().toISOString(),
      });

      const defaultBanks = [
        ['HBL', '/assets/payment-banks/hbl.png'],
        ['Meezan Bank', '/assets/payment-banks/meezan-bank.png'],
        ['UBL', '/assets/payment-banks/ubl.png'],
        ['Easypaisa', '/assets/payment-banks/easypaisa.png'],
        ['Faysal Bank', '/assets/payment-banks/faysal-bank.png'],
        ['Allied Bank', '/assets/payment-banks/allied-bank.png'],
      ];
      for (const [bName, logo] of defaultBanks) {
        await db.BankAccount.create({
          shopId: shop.id,
          bankName: bName,
          accountTitle: `${cleanShop} · ${bName}`,
          accountNumber: '',
          logo,
          openingBalance: 0,
          balance: 0,
          active: true,
        });
      }

      await logAudit(shop.id, user, 'shop_registered', 'Shop', shop.id, `Registered shop "${cleanShop}"`);
      return { shop, user };
    });

    const token = signAuthToken(result.user);
    setAuthCookie(res, token);

    return res.status(201).json({
      token,
      user: {
        id: result.user.id,
        shopId: result.user.shopId,
        name: result.user.name,
        email: result.user.email,
        role: result.user.role,
      },
      shop: result.shop,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Could not register shop.' });
  }
});

apiRouter.post('/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const cleanEmail = String(email || '').trim().toLowerCase();
    const cleanPass = String(password || '');

    if (!cleanEmail || !cleanPass) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    const user = await db.User.findOne({ email: cleanEmail });
    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }
    if (user.active === false) {
      return res.status(403).json({
        error: 'This Shop Account has been deactivated by the shop owner.',
      });
    }

    const ok = await verifyPassword(cleanPass, user.passwordHash);
    if (!ok) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const shop = await db.Shop.findById(user.shopId);
    if (!shop) {
      return res.status(404).json({ error: 'Associated shop workspace not found.' });
    }

    await db.User.updateOne({ _id: user.id, shopId: user.shopId }, { lastLoginAt: new Date().toISOString() });

    const token = signAuthToken(user);
    setAuthCookie(res, token);

    return res.json({
      token,
      user: {
        id: user.id,
        shopId: user.shopId,
        name: user.name,
        email: user.email,
        role: user.role,
      },
      shop,
    });
  } catch (err) {
    return res.status(500).json({ error: 'Login failed.' });
  }
});

apiRouter.post('/auth/logout', (req, res) => {
  res.clearCookie(AUTH_COOKIE_NAME, { path: '/' });
  return res.json({ ok: true });
});

apiRouter.post('/auth/forgot-password', async (req, res) => {
  try {
    const cleanEmail = String(req.body?.email || '').trim().toLowerCase();
    if (!cleanEmail) {
      return res.status(400).json({ error: 'Enter your registered email address.' });
    }
    const smtpHost = process.env.SMTP_HOST;
    const smtpUser = process.env.SMTP_USER;
    const smtpPass = process.env.SMTP_PASS;
    if (!smtpHost || !smtpUser || !smtpPass || !process.env.SMTP_FROM) {
      return res.status(503).json({ error: 'Password reset email is not configured. Ask the shop owner to configure SMTP.' });
    }
    const user = await db.User.findOne({ email: cleanEmail });
    const message = 'If an account exists for this email, a password reset code will arrive shortly.';
    if (user) {
      const code = String(crypto.randomInt(100000, 1000000));
      const expires = new Date(Date.now() + 15 * 60 * 1000).toISOString();
      const transporter = nodemailer.createTransport({
        host: smtpHost,
        port: Number(process.env.SMTP_PORT || 587),
        secure: String(process.env.SMTP_SECURE).toLowerCase() === 'true',
        auth: { user: smtpUser, pass: smtpPass },
      });
      await transporter.sendMail({
        from: process.env.SMTP_FROM,
        to: user.email,
        subject: 'Your ElectroHub password reset code',
        text: `Your password reset code is ${code}. It expires in 15 minutes. If you did not request it, ignore this email.`,
      });
      await db.User.updateOne(
        { _id: user.id, shopId: user.shopId },
        { resetCodeHash: crypto.createHash('sha256').update(code).digest('hex'), resetExpiresAt: expires, resetAttempts: 0, resetLockedUntil: null }
      );
    }
    return res.json({ ok: true, message });
  } catch (err) {
    console.error('Password reset email failed:', err.message);
    return res.status(503).json({ error: 'Could not send the password reset email. Check SMTP settings and try again.' });
  }
});

apiRouter.post('/auth/reset-password', async (req, res) => {
  try {
    const { email, resetCode, newPassword } = req.body || {};
    const cleanEmail = String(email || '').trim().toLowerCase();
    const cleanCode = String(resetCode || '').trim();
    const cleanPass = String(newPassword || '');

    if (!cleanEmail || !cleanCode || cleanPass.length < 8) {
      return res.status(400).json({
        error: 'Email, 6-digit reset code, and a new password (min 8 chars) are required.',
      });
    }

    const user = await db.User.findOne({ email: cleanEmail });
    const locked = user?.resetLockedUntil && new Date(user.resetLockedUntil) > new Date();
    const expired = !user?.resetExpiresAt || new Date(user.resetExpiresAt) < new Date();
    const codeHash = crypto.createHash('sha256').update(cleanCode).digest('hex');
    if (locked || !user || !user.resetCodeHash || expired || codeHash !== user.resetCodeHash) {
      if (user?.resetCodeHash && !locked && !expired) {
        const attempts = Number(user.resetAttempts || 0) + 1;
        await db.User.updateOne({ _id: user.id, shopId: user.shopId }, attempts >= 5
          ? { resetCodeHash: null, resetExpiresAt: null, resetAttempts: 0, resetLockedUntil: new Date(Date.now() + 15 * 60 * 1000) }
          : { resetAttempts: attempts });
      }
      return res.status(400).json({ error: 'Invalid or expired reset code.' });
    }

    const passwordHash = await hashPassword(cleanPass);
    await db.User.updateOne(
      { _id: user.id, shopId: user.shopId },
      { passwordHash, resetCodeHash: null, resetExpiresAt: null, resetAttempts: 0, resetLockedUntil: null }
    );

    return res.json({ ok: true, message: 'Password updated successfully. You can now sign in.' });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to reset password.' });
  }
});

// ============================================================================
// PROTECTED TENANT-SCOPED ROUTES (requireAuth enforces req.shopId)
// ============================================================================

apiRouter.use(requireAuth);

// Overview viewers receive aggregate, read-only shop metrics and cannot use any other API.
apiRouter.get('/overview', async (req, res, next) => {
  try {
    const [shop, bills, returns, expenses, products, suppliers, bankAccounts, installmentPayments, financialTransactions] = await Promise.all([
      db.Shop.findById(req.shopId),
      db.Sale.find({ shopId: req.shopId }),
      db.CustomerReturn.find({ shopId: req.shopId }),
      db.Expense.find({ shopId: req.shopId }),
      db.Product.find({ shopId: req.shopId }),
      db.Supplier.find({ shopId: req.shopId }),
      db.BankAccount.find({ shopId: req.shopId }),
      db.InstallmentPayment.find({ shopId: req.shopId }),
      db.FinancialTransaction.find({ shopId: req.shopId }),
    ]);
    const summary = calculateShopFinancialSummary({
      bills, returns, expenses, products, suppliers, bankAccounts, installmentPayments,
      openingCash: shop?.openingCash || 0,
      supplierPayments: financialTransactions.filter((entry) => entry.type === 'supplier_payment'),
    });
    return res.json({
      shop: { name: shop?.name || '', currency: shop?.currency || 'PKR' },
      user: { id: req.user.id, name: req.user.name, email: req.user.email, role: req.user.role },
      summary,
    });
  } catch (err) { next(err); }
});

apiRouter.use((req, res, next) => {
  if (req.user?.role === 'overview_viewer') {
    return res.status(403).json({ error: 'This account can only view the shop overview.' });
  }
  return next();
});

// Keep legacy cheque data readable, but stop removed cheque workflows from writing to the ledger.
apiRouter.use(['/cheques', '/cheques/:id/status'], (req, res, next) => {
  if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
    return res.status(410).json({ error: 'Cheque payments are no longer supported. Use cash or bank transfer.' });
  }
  return next();
});

apiRouter.get('/stock-workspace', async (req, res, next) => {
  try {
    const [products, suppliers, bankAccounts, stockReceipts, stockMovements] = await Promise.all([
      db.Product.find({ shopId: req.shopId }),
      db.Supplier.find({ shopId: req.shopId }),
      db.BankAccount.find({ shopId: req.shopId }),
      db.StockReceipt.find({ shopId: req.shopId }),
      db.StockMovement.find({ shopId: req.shopId }),
    ]);
    res.json({ shop: req.shop, user: { id: req.user.id, name: req.user.name, role: req.user.role },
      products, suppliers, bankAccounts,
      stockReceipts: stockReceipts.map(({ documentDataUrl, ...receipt }) => ({ ...receipt, hasDocument: Boolean(documentDataUrl) })),
      stockMovements,
      summary: {
        stockUnits: products.reduce((sum, p) => sum + num(p.stock), 0),
        stockCostValuation: products.reduce((sum, p) => sum + num(p.stock) * num(p.cost), 0),
        stockRetailValuation: products.reduce((sum, p) => sum + num(p.stock) * num(p.price), 0),
        lowStockCount: products.filter((p) => num(p.stock) <= num(p.reorderThreshold ?? 5)).length,
      },
    });
  } catch (err) { next(err); }
});

async function buildShopBootstrap(shopId, currentUser) {
  const [
    shop,
    usersRaw,
    products,
    customers,
    suppliers,
    sales,
    installmentPlans,
    installmentPayments,
    stockReceipts,
    stockMovements,
    expenses,
    bankAccounts,
    financialTransactions,
    cheques,
    customerReturns,
    heldOrders,
    auditEvents,
  ] = await Promise.all([
    db.Shop.findById(shopId),
    db.User.find({ shopId }),
    db.Product.find({ shopId }),
    db.Customer.find({ shopId }),
    db.Supplier.find({ shopId }),
    db.Sale.find({ shopId }),
    db.InstallmentPlan.find({ shopId }),
    db.InstallmentPayment.find({ shopId }),
    db.StockReceipt.find({ shopId }),
    db.StockMovement.find({ shopId }, { sort: { createdAt: -1 }, limit: 100 }),
    db.Expense.find({ shopId }),
    db.BankAccount.find({ shopId }),
    db.FinancialTransaction.find({ shopId }, { sort: { createdAt: -1 }, limit: 150 }),
    db.Cheque.find({ shopId }),
    db.CustomerReturn.find({ shopId }),
    db.HeldOrder.find({ shopId }),
    db.AuditEvent.find({ shopId }, { sort: { createdAt: -1 }, limit: 60 }),
  ]);

  const supplierPayments = financialTransactions.filter((t) => t.type === 'supplier_payment');

  const safeStockReceipts = stockReceipts.map(({ documentDataUrl, ...receipt }) => ({ ...receipt, hasDocument: Boolean(documentDataUrl) }));
  const safeExpenses = expenses.map(({ attachmentDataUrl, ...expense }) => ({ ...expense, hasAttachment: Boolean(attachmentDataUrl) }));
  const summary = calculateShopFinancialSummary({
    bills: sales,
    returns: customerReturns,
    expenses: safeExpenses,
    products,
    suppliers,
    bankAccounts,
    installmentPayments,
    openingCash: shop?.openingCash || 0,
    supplierPayments,
  });

  const users = usersRaw.map((u) => ({
    id: u.id,
    shopId: u.shopId,
    name: u.name,
    email: u.email,
    role: u.role,
    active: u.active !== false,
    lastLoginAt: u.lastLoginAt,
    createdAt: u.createdAt,
  }));

  return {
    shop,
    user: currentUser,
    users,
    products,
    customers,
    suppliers,
    sales,
    installmentPlans,
    installmentPayments,
    stockReceipts: safeStockReceipts,
    stockMovements,
    expenses: safeExpenses,
    bankAccounts,
    financialTransactions,
    cheques,
    customerReturns,
    heldOrders,
    auditEvents,
    summary,
  };
}

apiRouter.get('/bootstrap', async (req, res) => {
  try {
    const payload = await buildShopBootstrap(req.shopId, req.user);
    return res.json(payload);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to load workspace data.' });
  }
});

// ============================================================================
// 2. SHOP SETTINGS & USER MANAGEMENT (Owner-only write operations)
// ============================================================================

apiRouter.get('/settings', async (req, res) => {
  const shop = await db.Shop.findById(req.shopId);
  const usersRaw = await db.User.find({ shopId: req.shopId });
  const users = usersRaw.map((u) => ({
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    active: u.active !== false,
    lastLoginAt: u.lastLoginAt,
  }));
  return res.json({ shop, users });
});

apiRouter.put('/settings', requireOwner, async (req, res) => {
  try {
    const {
      name,
      whatsapp,
      phone,
      address,
      city,
      receiptFooter,
      invoicePrefix,
      openingCash,
      taxNumber,
      currency,
    } = req.body || {};

    const cleanName = String(name || '').trim();
    if (!cleanName) {
      return res.status(400).json({ error: 'Shop name cannot be empty.' });
    }

    const patch = {
      name: cleanName,
      whatsapp: String(whatsapp ?? req.shop.whatsapp ?? '').trim(),
      phone: String(phone ?? req.shop.phone ?? '').trim(),
      address: String(address ?? req.shop.address ?? '').trim(),
      city: String(city ?? req.shop.city ?? '').trim(),
      receiptFooter: String(receiptFooter ?? req.shop.receiptFooter ?? '').trim(),
      invoicePrefix: String(invoicePrefix || 'INV').trim().toUpperCase(),
      openingCash: openingCash !== undefined ? num(openingCash) : num(req.shop.openingCash),
      taxNumber: String(taxNumber ?? req.shop.taxNumber ?? '').trim(),
      currency: String(currency || 'PKR').trim(),
    };

    const updated = await db.Shop.updateOne({ _id: req.shopId }, patch);
    await logAudit(
      req.shopId,
      req.user,
      'settings_updated',
      'Shop',
      req.shopId,
      `Updated shop settings (${cleanName}, WhatsApp: ${patch.whatsapp})`
    );

    return res.json({ shop: updated });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to update shop settings.' });
  }
});

apiRouter.post('/users', requireOwner, async (req, res) => {
  try {
    const { name, email, password, role } = req.body || {};
    const cleanName = String(name || '').trim();
    const cleanEmail = String(email || '').trim().toLowerCase();
    const cleanPass = String(password || '');

    if (!cleanName || !cleanEmail || cleanPass.length < 8) {
      return res.status(400).json({
        error: 'Name, email, and a password of at least 8 characters are required.',
      });
    }

    const requestedRole = role === 'overview_viewer' ? 'overview_viewer' : 'shop_account';
    if (requestedRole === 'overview_viewer') {
      const existingViewers = await db.User.find({ shopId: req.shopId, role: 'overview_viewer' });
      const activeViewerCount = existingViewers.filter((viewer) => viewer.active !== false).length;
      if (activeViewerCount >= 2) {
        return res.status(400).json({ error: 'Each shop can have up to two active Overview-only accounts.' });
      }
    }

    const existing = await db.User.findOne({ email: cleanEmail });
    if (existing) {
      return res.status(409).json({ error: 'A user with this email already exists.' });
    }

    const passwordHash = await hashPassword(cleanPass);
    const created = await db.User.create({
      shopId: req.shopId,
      name: cleanName,
      email: cleanEmail,
      passwordHash,
      role: requestedRole,
      active: true,
    });

    await logAudit(
      req.shopId,
      req.user,
      'user_created',
      'User',
      created.id,
      `Created ${requestedRole === 'overview_viewer' ? 'Overview-only' : 'Shop Account'} user "${cleanName}" (${cleanEmail})`
    );

    return res.status(201).json({
      user: {
        id: created.id,
        shopId: created.shopId,
        name: created.name,
        email: created.email,
        role: created.role,
        active: created.active,
      },
    });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to create user.' });
  }
});

apiRouter.put('/users/:id', requireOwner, async (req, res) => {
  try {
    const targetId = String(req.params.id);
    const target = await db.User.findOne({ _id: targetId, shopId: req.shopId });
    if (!target || !verifyTenantAccess(target.shopId, req.shopId)) {
      return res.status(404).json({ error: 'User not found in your shop.' });
    }

    const { name, email, active, newPassword } = req.body || {};
    const patch = {};
    if (name !== undefined && String(name).trim()) patch.name = String(name).trim();
    if (email !== undefined && String(email).trim()) patch.email = String(email).trim().toLowerCase();
    if (active !== undefined) {
      if (target.id === req.user.id && active === false) {
        return res.status(400).json({ error: 'You cannot deactivate your own owner account.' });
      }
      if (Boolean(active) && target.role === 'overview_viewer' && target.active === false) {
        const otherViewers = await db.User.find({ shopId: req.shopId, role: 'overview_viewer' });
        if (otherViewers.filter((viewer) => viewer.id !== target.id && viewer.active !== false).length >= 2) {
          return res.status(400).json({ error: 'This store already has two active Overview-only accounts. Deactivate one before reactivating another.' });
        }
      }
      patch.active = Boolean(active);
    }
    if (newPassword !== undefined && String(newPassword).length > 0 && String(newPassword).length < 8) {
      return res.status(400).json({ error: 'A new password must be at least 8 characters.' });
    }
    if (newPassword && String(newPassword).length >= 8) {
      patch.passwordHash = await hashPassword(newPassword);
    }

    const updated = await db.User.updateOne({ _id: target.id, shopId: req.shopId }, patch);
    await logAudit(
      req.shopId,
      req.user,
      'user_updated',
      'User',
      target.id,
      `Updated user "${updated.name}" (active: ${updated.active})`
    );

    return res.json({
      user: {
        id: updated.id,
        shopId: updated.shopId,
        name: updated.name,
        email: updated.email,
        role: updated.role,
        active: updated.active,
      },
    });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to update user.' });
  }
});

// ============================================================================
// 3. PRODUCTS & STOCK ADJUSTMENTS
// ============================================================================

apiRouter.get('/products', async (req, res) => {
  const products = await db.Product.find({ shopId: req.shopId });
  return res.json({ products });
});

function productInputError(input) {
  if (!String(input.name || '').trim() || !Number.isFinite(Number(input.price)) || Number(input.price) <= 0) {
    return 'Product name and a positive sale price are required.';
  }
  if (!Number.isFinite(Number(input.cost ?? 0)) || Number(input.cost ?? 0) < 0 ||
      !Number.isSafeInteger(Number(input.stock ?? 0)) || Number(input.stock ?? 0) < 0 ||
      !Number.isSafeInteger(Number(input.reorderThreshold ?? 5)) || Number(input.reorderThreshold ?? 5) < 0) {
    return 'Cost must be non-negative; stock and reorder threshold must be non-negative whole numbers.';
  }
  return null;
}

async function hasConflictingProduct(shopId, input, exceptId) {
  const products = await db.Product.find({ shopId });
  return products.some((p) => p.id !== exceptId && [input.code, input.barcode].map(normalizeKey).filter(Boolean)
    .some((key) => key === normalizeKey(p.code) || key === normalizeKey(p.barcode)));
}

apiRouter.post('/products', async (req, res) => {
  try {
    const {
      name,
      code,
      barcode,
      serialNumber,
      category,
      warranty,
      cost,
      price,
      stock,
      reorderThreshold,
      active,
    } = req.body || {};

    const cleanName = String(name || '').trim();
    const inputError = productInputError(req.body || {});
    if (inputError) return res.status(400).json({ error: inputError });
    if (await hasConflictingProduct(req.shopId, req.body || {})) {
      return res.status(409).json({ error: 'This SKU or barcode already belongs to a product.' });
    }

    const cleanCode =
      String(code || '').trim() || `SKU-${crypto.randomUUID().slice(0, 8)}`;
    const initialStock = Math.floor(num(stock));

    const product = await db.Product.create({
      shopId: req.shopId,
      name: cleanName,
      code: cleanCode,
      barcode: String(barcode || cleanCode).trim(),
      serialNumber: String(serialNumber || '').trim(),
      category: String(category || 'Electronics').trim(),
      warranty: String(warranty || '').trim(),
      cost: num(cost),
      price: num(price),
      stock: initialStock,
      reorderThreshold: reorderThreshold !== undefined ? Math.floor(num(reorderThreshold)) : 5,
      active: active !== false,
    });

    if (initialStock > 0) {
      await db.StockMovement.create({
        shopId: req.shopId,
        productId: product.id,
        productName: product.name,
        code: product.code,
        type: 'adjustment',
        qtyChange: initialStock,
        stockAfter: initialStock,
        unitCost: product.cost,
        unitPrice: product.price,
        referenceId: 'INITIAL',
        note: 'Opening stock on product creation',
        createdBy: req.user.name,
      });
    }

    await logAudit(
      req.shopId,
      req.user,
      'product_created',
      'Product',
      product.id,
      `Added product "${product.name}" (${product.code})`
    );

    return res.status(201).json({ product });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to create product.' });
  }
});

apiRouter.put('/products/:id', async (req, res) => {
  try {
    const existing = await db.Product.findOne({ _id: req.params.id, shopId: req.shopId });
    if (!existing || !verifyTenantAccess(existing.shopId, req.shopId)) {
      return res.status(404).json({ error: 'Product not found.' });
    }

    const {
      name,
      code,
      barcode,
      serialNumber,
      category,
      warranty,
      cost,
      price,
      stock,
      reorderThreshold,
      active,
      adjustmentNote,
    } = req.body || {};

    const newStock = stock !== undefined ? Math.floor(num(stock)) : existing.stock;
    const inputError = productInputError({ ...existing, ...req.body });
    if (inputError) return res.status(400).json({ error: inputError });
    if (await hasConflictingProduct(req.shopId, { ...existing, ...req.body }, existing.id)) {
      return res.status(409).json({ error: 'This SKU or barcode already belongs to another product.' });
    }
    const stockDelta = newStock - num(existing.stock);

    const updated = await db.Product.updateOne(
      { _id: existing.id, shopId: req.shopId },
      {
        name: name !== undefined ? String(name).trim() : existing.name,
        code: code !== undefined ? String(code).trim() : existing.code,
        barcode: barcode !== undefined ? String(barcode).trim() : existing.barcode,
        serialNumber: serialNumber !== undefined ? String(serialNumber).trim() : existing.serialNumber,
        category: category !== undefined ? String(category).trim() : existing.category,
        warranty: warranty !== undefined ? String(warranty).trim() : existing.warranty,
        cost: cost !== undefined ? num(cost) : existing.cost,
        price: price !== undefined ? num(price) : existing.price,
        stock: newStock,
        reorderThreshold:
          reorderThreshold !== undefined ? Math.floor(num(reorderThreshold)) : existing.reorderThreshold,
        active: active !== undefined ? Boolean(active) : existing.active,
      }
    );

    if (stockDelta !== 0) {
      await db.StockMovement.create({
        shopId: req.shopId,
        productId: updated.id,
        productName: updated.name,
        code: updated.code,
        type: 'adjustment',
        qtyChange: stockDelta,
        stockAfter: newStock,
        unitCost: updated.cost,
        unitPrice: updated.price,
        referenceId: 'ADJ-' + String(Date.now()).slice(-5),
        note: String(adjustmentNote || 'Manual stock adjustment').trim(),
        createdBy: req.user.name,
      });
    }

    return res.json({ product: updated });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to update product.' });
  }
});

// ============================================================================
// 4. CUSTOMERS
// ============================================================================

apiRouter.post('/customers', async (req, res) => {
  try {
    const {
      name,
      phone,
      whatsapp,
      cnic,
      address,
      guarantor,
      guarantorPhone,
      guarantorAddress,
    } = req.body || {};

    const cleanName = String(name || '').trim();
    if (!cleanName) {
      return res.status(400).json({ error: 'Customer name is required.' });
    }

    const customer = await db.Customer.create({
      shopId: req.shopId,
      name: cleanName,
      phone: String(phone || '').trim(),
      whatsapp: String(whatsapp || phone || '').trim(),
      cnic: String(cnic || '').trim(),
      address: String(address || '').trim(),
      guarantor: String(guarantor || '').trim(),
      guarantorPhone: String(guarantorPhone || '').trim(),
      guarantorAddress: String(guarantorAddress || '').trim(),
      creditBalance: 0,
    });

    return res.status(201).json({ customer });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to save customer.' });
  }
});

apiRouter.put('/customers/:id', async (req, res) => {
  try {
    const existing = await db.Customer.findOne({ _id: req.params.id, shopId: req.shopId });
    if (!existing) {
      return res.status(404).json({ error: 'Customer not found.' });
    }
    const {
      name,
      phone,
      whatsapp,
      cnic,
      address,
      guarantor,
      guarantorPhone,
      guarantorAddress,
    } = req.body || {};

    const updated = await db.Customer.updateOne(
      { _id: existing.id, shopId: req.shopId },
      {
        name: name !== undefined ? String(name).trim() : existing.name,
        phone: phone !== undefined ? String(phone).trim() : existing.phone,
        whatsapp: whatsapp !== undefined ? String(whatsapp).trim() : existing.whatsapp,
        cnic: cnic !== undefined ? String(cnic).trim() : existing.cnic,
        address: address !== undefined ? String(address).trim() : existing.address,
        guarantor: guarantor !== undefined ? String(guarantor).trim() : existing.guarantor,
        guarantorPhone: guarantorPhone !== undefined ? String(guarantorPhone).trim() : existing.guarantorPhone,
        guarantorAddress:
          guarantorAddress !== undefined ? String(guarantorAddress).trim() : existing.guarantorAddress,
      }
    );

    return res.json({ customer: updated });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to update customer.' });
  }
});

// ============================================================================
// 5. NEW SALE & BILLS WORKFLOW (Transaction-Safe + Stock Validated)
// ============================================================================

apiRouter.post('/sales', async (req, res) => {
  try {
    const {
      idempotencyKey,
      customerId,
      customerInfo,
      saleType = 'cash',
      items = [],
      billDiscount = 0,
      plan = {},
      salePayment = {},
    } = req.body || {};

    const installmentMonths = Math.floor(num(plan?.months ?? 12));
    const installmentPercent = num(plan?.percent ?? 10);
    const chosenMethod = String(salePayment?.method || 'cash').toLowerCase();
    if (!['cash', 'installment'].includes(saleType) || !['cash', 'bank'].includes(chosenMethod) ||
        !Number.isFinite(Number(billDiscount)) || Number(billDiscount) < 0 ||
        ['cash', 'bank'].some((key) => salePayment?.[key] !== undefined && salePayment[key] !== '' && !Number.isFinite(Number(salePayment[key]))) ||
        (saleType === 'installment' && (
          !Number.isFinite(Number(plan?.percent ?? 10)) || installmentMonths < 1 || installmentMonths > 60 ||
          installmentPercent < 0 || installmentPercent > 100 ||
          (plan?.advance !== undefined && plan.advance !== '' && !Number.isFinite(Number(plan.advance)))
        ))) {
      return res.status(400).json({ error: 'Choose cash or installment, a cash/bank payment method, and an installment duration of 1-60 months with markup from 0-100%.' });
    }
    if (saleType === 'installment') {
      const photoChecks = [
        validateInstallmentPhoto(customerInfo?.customerPhoto, 'Customer photo'),
        validateInstallmentPhoto(customerInfo?.guarantorPhoto, 'Guarantor photo'),
      ];
      const invalidPhoto = photoChecks.find((photo) => !photo.valid);
      if (invalidPhoto) return res.status(400).json({ error: invalidPhoto.error });
    }

    if (idempotencyKey) {
      const existingSale = await db.Sale.findOne({
        shopId: req.shopId,
        idempotencyKey: String(idempotencyKey),
      });
      if (existingSale) {
        return res.json({ sale: existingSale, duplicate: true });
      }
    }

    const shopProducts = await db.Product.find({ shopId: req.shopId });
    const productsById = new Map();
    for (const p of shopProducts) {
      productsById.set(String(p.id), p);
    }

    const stockCheck = validateStockAvailability(items, productsById);
    if (!stockCheck.valid) {
      return res.status(400).json({
        error: stockCheck.errors[0],
        errors: stockCheck.errors,
      });
    }

    // Enrich cart items with product cost, code, warranty from DB
    if (!Number.isFinite(Number(billDiscount)) || Number(billDiscount) < 0) {
      return res.status(400).json({ error: 'Bill discount must be a non-negative amount.' });
    }
    const enrichedItems = items.map((item) => {
      const prod = productsById.get(String(item.productId || item.id));
      const price = item.price === undefined || item.price === null || item.price === '' ? Number(prod.price) : Number(item.price);
      if (!Number.isFinite(price) || price <= 0) throw Object.assign(new Error(`Enter a positive sale price for ${prod.name}.`), { status: 400 });
      return {
        productId: prod.id,
        name: prod.name,
        code: prod.code,
        category: prod.category || 'Electronics',
        serialNumber: item.serialNumber || prod.serialNumber || '',
        warranty: item.warranty || (prod.warranty === '12 Months' ? '' : prod.warranty) || '',
        qty: Number(item.qty),
        price,
        cost: num(prod.cost),
      };
    });

    const payMethod = saleType === 'installment' ? String(salePayment.method || 'cash').toLowerCase() : chosenMethod;
    const totals = calculateSaleTotals({
      items: enrichedItems,
      billDiscount,
      saleType,
      installmentPercent: plan.percent ?? 10,
      advance: plan.advance ?? 0,
      months: plan.months ?? 12,
      paymentMethod: payMethod,
      cashAmount: salePayment.cash,
      bankAmount: salePayment.bank,
    });
    if (Number(billDiscount) > totals.gross) {
      return res.status(400).json({ error: 'Bill discount cannot exceed the sale subtotal.' });
    }
    if (totals.excess > 0) {
      return res.status(400).json({ error: 'Received payment cannot exceed the invoice total.' });
    }

    const result = await runInTransaction(async () => {
      // 1. Resolve or upsert Customer
      let resolvedCustomer = null;
      if (customerId && customerId !== 'walkin' && customerId !== 'new') {
        // Customer IDs can be stale when a browser still has the old demo data.
        // Match within this shop without passing an arbitrary string to Mongoose's _id cast.
        const shopCustomers = await db.Customer.find({ shopId: req.shopId });
        resolvedCustomer = shopCustomers.find((customer) => String(customer.id) === String(customerId)) || null;
        const requestedCustomerName = String(customerInfo?.name || '').trim();
        if (!resolvedCustomer && requestedCustomerName && requestedCustomerName.toLowerCase() !== 'walk-in customer') {
          const error = new Error('Selected customer was not found. Please select the customer again.');
          error.status = 400;
          throw error;
        }
      }

      const custName = String(
        customerInfo?.name || resolvedCustomer?.name || 'Walk-in customer'
      ).trim();
      if (saleType === 'cash' && !resolvedCustomer && custName.toLowerCase() === 'walk-in customer' && totals.balance > 0) {
        const error = new Error('Walk-in sales must be paid in full. Collect the remaining balance or select a registered customer.');
        error.status = 400;
        throw error;
      }
      const custPhone = String(customerInfo?.phone || resolvedCustomer?.phone || '').trim();
      const custWhatsapp = String(
        customerInfo?.whatsapp || resolvedCustomer?.whatsapp || custPhone
      ).trim();
      const custCnic = String(customerInfo?.cnic || resolvedCustomer?.cnic || '').trim();
      const custAddress = String(customerInfo?.address || resolvedCustomer?.address || '').trim();
      const guarantor = String(customerInfo?.guarantor || resolvedCustomer?.guarantor || '').trim();
      const guarantorPhone = String(
        customerInfo?.guarantorPhone || resolvedCustomer?.guarantorPhone || ''
      ).trim();
      const guarantorAddress = String(
        customerInfo?.guarantorAddress || resolvedCustomer?.guarantorAddress || ''
      ).trim();

      if (resolvedCustomer) {
        resolvedCustomer = await db.Customer.updateOne(
          { _id: resolvedCustomer.id, shopId: req.shopId },
          {
            name: custName,
            phone: custPhone,
            whatsapp: custWhatsapp,
            cnic: custCnic,
            address: custAddress,
            guarantor: guarantor || resolvedCustomer.guarantor,
            guarantorPhone: guarantorPhone || resolvedCustomer.guarantorPhone,
            guarantorAddress: guarantorAddress || resolvedCustomer.guarantorAddress,
            creditBalance:
              saleType === 'cash' && totals.balance > 0
                ? num(resolvedCustomer.creditBalance) + totals.balance
                : num(resolvedCustomer.creditBalance),
          }
        );
      } else if (custName && custName.toLowerCase() !== 'walk-in customer') {
        resolvedCustomer = await db.Customer.create({
          shopId: req.shopId,
          name: custName,
          phone: custPhone,
          whatsapp: custWhatsapp,
          cnic: custCnic,
          address: custAddress,
          guarantor,
          guarantorPhone,
          guarantorAddress,
          creditBalance: saleType === 'cash' ? totals.balance : 0,
        });
      }

      // 2. Generate Invoice Number
      const prefix = req.shop?.invoicePrefix || 'INV';
      const existingSalesCount = await db.Sale.count({ shopId: req.shopId });
      const invoiceNo = `${prefix}-${1085 + existingSalesCount + 1}`;
      const todayDate = pakistanDateString();

      // 3. Decrement Product Stock & Record Stock Movements
      for (const line of totals.items) {
        const currentProd = await db.Product.findOne({ _id: line.productId, shopId: req.shopId });
        const nextStock = Math.max(0, num(currentProd.stock) - line.qty);
        await db.Product.updateOne(
          { _id: line.productId, shopId: req.shopId },
          { stock: nextStock }
        );
        await db.StockMovement.create({
          shopId: req.shopId,
          productId: line.productId,
          productName: line.name,
          code: line.code,
          type: 'sale',
          qtyChange: -line.qty,
          stockAfter: nextStock,
          unitCost: line.cost,
          unitPrice: line.price,
          referenceId: invoiceNo,
          note: `${saleType === 'installment' ? 'Installment' : 'Cash'} sale to ${custName}`,
          createdBy: req.user.name,
        });
      }

      // 4. Create Sale / Invoice record
      const statusLabel =
        saleType === 'installment'
          ? totals.balance > 0
            ? 'Active plan'
            : 'Paid'
          : totals.balance > 0
          ? 'Partial / Udhaar'
          : 'Paid';

      const sale = await db.Sale.create({
        shopId: req.shopId,
        invoiceNo,
        idempotencyKey: String(idempotencyKey || ''),
        customerId: resolvedCustomer?.id || 'walkin',
        customer: custName,
        phone: custPhone,
        whatsapp: custWhatsapp,
        cnic: custCnic,
        address: custAddress,
        guarantor,
        guarantorPhone,
        guarantorAddress,
        type: saleType,
        items: totals.items,
        gross: totals.gross,
        billDiscount: totals.billDiscount,
        discounted: totals.discounted,
        installmentPercent: totals.installmentPercent,
        add: totals.add,
        total: totals.final,
        totalCost: totals.totalCost,
        initialPaid: totals.paid,
        paid: totals.paid,
        cashCollected: totals.cashCollected,
        bankCollected: totals.bankCollected,
        chequeCollected: totals.chequeCollected,
        balance: totals.balance,
        paymentMethod: saleType === 'installment' ? 'Installment advance' : payMethod,
        paymentDetails: salePayment,
        months: totals.months,
        monthly: totals.monthly,
        planStart: todayDate,
        status: statusLabel,
        createdBy: req.user.name,
      });

      // 5. If Installment Sale, create InstallmentPlan
      let createdPlan = null;
      if (saleType === 'installment') {
        const nextDue = new Date();
        nextDue.setMonth(nextDue.getMonth() + 1);
        createdPlan = await db.InstallmentPlan.create({
          shopId: req.shopId,
          planNo: `PLAN-${invoiceNo.replace(/^[A-Z]+-/, '')}`,
          saleId: sale.id,
          invoiceNo: sale.invoiceNo,
          customerId: resolvedCustomer?.id || 'walkin',
          customerName: custName,
          installmentDetails: {
            customer: {
              name: custName,
              phone: custPhone,
              whatsapp: custWhatsapp,
              cnic: custCnic,
              address: custAddress,
              photoDataUrl: String(customerInfo?.customerPhoto || ''),
            },
            guarantor: {
              name: guarantor,
              phone: guarantorPhone,
              address: guarantorAddress,
              photoDataUrl: String(customerInfo?.guarantorPhoto || ''),
            },
            plan: {
              totalAmount: totals.final,
              advancePaid: totals.paid,
              balance: totals.balance,
              months: totals.months,
              monthlyAmount: totals.monthly,
              installmentPercent: totals.installmentPercent,
              paymentMethod: String(salePayment?.method || 'cash'),
              startDate: todayDate,
              nextDueDate: pakistanDateString(nextDue),
            },
          },
          phone: custPhone,
          whatsapp: custWhatsapp,
          cnic: custCnic,
          address: custAddress,
          guarantor,
          guarantorPhone,
          guarantorAddress,
          productSummary: totals.items.map((i) => `${i.name} × ${i.qty}`).join(', '),
          totalAmount: totals.final,
          advancePaid: totals.paid,
          paid: totals.paid,
          balance: totals.balance,
          months: totals.months,
          monthlyAmount: totals.monthly,
          installmentPercent: totals.installmentPercent,
          startDate: todayDate,
          nextDueDate: pakistanDateString(nextDue),
          status: totals.balance > 0 ? 'Active' : 'Paid',
        });
      }

      // 6. Record Financial Transactions & Update Bank / Cheque Register
      if (totals.cashCollected > 0) {
        await db.FinancialTransaction.create({
          shopId: req.shopId,
          txNo: 'FIN-' + String(Date.now()).slice(-6),
          type: 'sale_receipt',
          direction: 'in',
          amount: totals.cashCollected,
          method: 'cash',
          partyName: custName,
          relatedId: invoiceNo,
          note: `${saleType === 'installment' ? 'Installment advance' : 'Cash sale'} on ${invoiceNo}`,
          createdBy: req.user.name,
        });
      }

      if (totals.bankCollected > 0) {
        const bankName = String(salePayment.bankName || '').trim();
        const bankAcc = await db.BankAccount.findOne({ shopId: req.shopId, bankName });
        if (!bankAcc || bankAcc.active === false) { const error = new Error('Select an active bank account for this sale.'); error.status = 400; throw error; }
        await db.BankAccount.updateOne({ _id: bankAcc.id, shopId: req.shopId }, { balance: signedNum(bankAcc.balance) + totals.bankCollected });
        await db.FinancialTransaction.create({
          shopId: req.shopId,
          txNo: 'FIN-' + String(Date.now()).slice(-6) + 'B',
          type: 'sale_receipt',
          direction: 'in',
          amount: totals.bankCollected,
          method: 'bank',
          bankName,
          reference: salePayment.bankAccount || '',
          partyName: custName,
          relatedId: invoiceNo,
          note: `Bank payment (${bankName}) on ${invoiceNo}`,
          createdBy: req.user.name,
        });
      }

      await logAudit(
        req.shopId,
        req.user,
        'sale_completed',
        'Sale',
        sale.id,
        `Sale ${invoiceNo} (${saleType}) saved for ${custName} · Rs. ${totals.final.toLocaleString()}`
      );

      return { sale, plan: createdPlan, customer: resolvedCustomer };
    });

    return res.status(201).json(result);
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message || 'Failed to save sale.' });
  }
});

// ============================================================================
// 6. INSTALLMENT KHATA & CUSTOMER PAYMENTS
// ============================================================================

apiRouter.post('/installments/plans', async (req, res) => {
  try {
    const {
      name,
      phone,
      whatsapp,
      cnic,
      address,
      guarantor,
      guarantorPhone,
      guarantorAddress,
      product,
      total,
      advance,
      months,
      startDate,
    } = req.body || {};

    const cleanName = String(name || '').trim();
    const totalAmt = num(total);
    const advAmt = num(advance);
    const durMonths = Math.floor(num(months) || 12);
    const planDate = startDate || pakistanDateString();

    if (!cleanName || !Number.isFinite(Number(total)) || !Number.isFinite(Number(advance)) ||
        totalAmt <= 0 || advAmt < 0 || advAmt > totalAmt || durMonths < 1 || durMonths > 60 ||
        !isValidDateOnly(planDate)) {
      return res.status(400).json({
        error: 'Enter a customer, valid plan amount, advance within the total, 1–60 months, and a valid start date.',
      });
    }

    const balance = Math.max(0, totalAmt - advAmt);
    const monthly = Math.round(balance / durMonths);
    const start = planDate;
    const nextDue = new Date(start);
    nextDue.setMonth(nextDue.getMonth() + 1);

    const result = await runInTransaction(async () => {
      let customer = await db.Customer.findOne({ shopId: req.shopId, name: cleanName });
      if (customer) {
        customer = await db.Customer.updateOne(
          { _id: customer.id, shopId: req.shopId },
          {
            phone: String(phone || customer.phone || '').trim(),
            whatsapp: String(whatsapp || phone || customer.whatsapp || '').trim(),
            cnic: String(cnic || customer.cnic || '').trim(),
            address: String(address || customer.address || '').trim(),
            guarantor: String(guarantor || customer.guarantor || '').trim(),
            guarantorPhone: String(guarantorPhone || customer.guarantorPhone || '').trim(),
            guarantorAddress: String(guarantorAddress || customer.guarantorAddress || '').trim(),
          }
        );
      } else {
        customer = await db.Customer.create({
          shopId: req.shopId,
          name: cleanName,
          phone: String(phone || '').trim(),
          whatsapp: String(whatsapp || phone || '').trim(),
          cnic: String(cnic || '').trim(),
          address: String(address || '').trim(),
          guarantor: String(guarantor || '').trim(),
          guarantorPhone: String(guarantorPhone || '').trim(),
          guarantorAddress: String(guarantorAddress || '').trim(),
        });
      }

      const planNo = 'PLAN-' + String(Date.now()).slice(-6);
      const sale = await db.Sale.create({
        shopId: req.shopId,
        invoiceNo: planNo,
        customerId: customer.id,
        customer: customer.name,
        phone: customer.phone,
        whatsapp: customer.whatsapp,
        cnic: customer.cnic,
        address: customer.address,
        guarantor: customer.guarantor,
        guarantorPhone: customer.guarantorPhone,
        guarantorAddress: customer.guarantorAddress,
        type: 'installment',
        items: [
          {
            productId: 'custom',
            name: String(product || 'Installment plan').trim(),
            code: 'PLAN',
            category: 'Electronics',
            qty: 1,
            price: totalAmt,
            cost: Math.round(totalAmt * 0.82),
            total: totalAmt,
          },
        ],
        gross: totalAmt,
        billDiscount: 0,
        discounted: totalAmt,
        installmentPercent: 0,
        add: 0,
        total: totalAmt,
        totalCost: Math.round(totalAmt * 0.82),
        initialPaid: advAmt,
        paid: advAmt,
        cashCollected: advAmt,
        bankCollected: 0,
        chequeCollected: 0,
        balance,
        paymentMethod: 'Installment advance',
        months: durMonths,
        monthly,
        planStart: start,
        status: balance > 0 ? 'Active plan' : 'Paid',
        createdBy: req.user.name,
      });

      const planDoc = await db.InstallmentPlan.create({
        shopId: req.shopId,
        planNo,
        saleId: sale.id,
        invoiceNo: sale.invoiceNo,
        customerId: customer.id,
        customerName: customer.name,
        installmentDetails: {
          customer: {
            name: customer.name,
            phone: customer.phone,
            whatsapp: customer.whatsapp,
            cnic: customer.cnic,
            address: customer.address,
            photoDataUrl: '',
          },
          guarantor: {
            name: customer.guarantor,
            phone: customer.guarantorPhone,
            address: customer.guarantorAddress,
            photoDataUrl: '',
          },
          plan: {
            totalAmount: totalAmt,
            advancePaid: advAmt,
            balance,
            months: durMonths,
            monthlyAmount: monthly,
            installmentPercent: 0,
            paymentMethod: 'cash',
            startDate: start,
            nextDueDate: pakistanDateString(nextDue),
          },
        },
        phone: customer.phone,
        whatsapp: customer.whatsapp,
        cnic: customer.cnic,
        address: customer.address,
        guarantor: customer.guarantor,
        guarantorPhone: customer.guarantorPhone,
        guarantorAddress: customer.guarantorAddress,
        productSummary: String(product || 'Installment plan').trim(),
        totalAmount: totalAmt,
        advancePaid: advAmt,
        paid: advAmt,
        balance,
        months: durMonths,
        monthlyAmount: monthly,
        startDate: start,
          nextDueDate: pakistanDateString(nextDue),
        status: balance > 0 ? 'Active' : 'Paid',
      });

      if (advAmt > 0) {
        await db.FinancialTransaction.create({
          shopId: req.shopId,
          txNo: 'FIN-' + String(Date.now()).slice(-6),
          type: 'sale_receipt',
          direction: 'in',
          amount: advAmt,
          method: 'cash',
          partyName: customer.name,
          relatedId: planNo,
          note: `Advance on installment plan ${planNo}`,
          createdBy: req.user.name,
        });
      }

      await logAudit(
        req.shopId,
        req.user,
        'installment_plan_created',
        'InstallmentPlan',
        planDoc.id,
        `Installment plan ${planNo} created for ${customer.name}`
      );

      return { plan: planDoc, sale, customer };
    });

    return res.status(201).json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Failed to add installment customer.' });
  }
});

apiRouter.post('/installments/:planId/pay', async (req, res) => {
  try {
    const { amount, method = 'cash', bankName = '', reference = '', note = '', idempotencyKey } = req.body || {};
    const cleanMethod = String(method || '').toLowerCase();
    const cleanBank = String(bankName || '').trim();
    if (!Number.isFinite(Number(amount)) || !['cash', 'bank'].includes(cleanMethod) ||
        (cleanMethod === 'bank' && !cleanBank)) {
      return res.status(400).json({ error: 'Enter a valid amount and choose cash or a bank account.' });
    }

    if (idempotencyKey) {
      const existingPay = await db.InstallmentPayment.findOne({
        shopId: req.shopId,
        idempotencyKey: String(idempotencyKey),
      });
      if (existingPay) {
        return res.json({ payment: existingPay, duplicate: true });
      }
    }

    // Lookup plan by id, planNo, or invoiceNo within req.shopId
    let plan = await db.InstallmentPlan.findOne({ _id: req.params.planId, shopId: req.shopId });
    if (!plan) {
      plan = await db.InstallmentPlan.findOne({ planNo: req.params.planId, shopId: req.shopId });
    }
    if (!plan) {
      plan = await db.InstallmentPlan.findOne({ invoiceNo: req.params.planId, shopId: req.shopId });
    }

    const calc = calculateInstallmentPayment({ plan, amount });
    if (!calc.valid) {
      return res.status(400).json({ error: calc.error });
    }
    const result = await runInTransaction(async () => {
      const nextDue = new Date(plan.nextDueDate || Date.now());
      nextDue.setMonth(nextDue.getMonth() + 1);

      const updatedPlan = await db.InstallmentPlan.updateOne(
        { _id: plan.id, shopId: req.shopId },
        {
          paid: calc.newPaid,
          balance: calc.newBalance,
          status: calc.newStatus,
          nextDueDate: calc.newStatus === 'Paid' ? 'Completed' : pakistanDateString(nextDue),
        }
      );

      if (plan.saleId || plan.invoiceNo) {
        const saleQuery = plan.saleId
          ? { _id: plan.saleId, shopId: req.shopId }
          : { invoiceNo: plan.invoiceNo, shopId: req.shopId };
        await db.Sale.updateOne(saleQuery, {
          paid: calc.newPaid,
          balance: calc.newBalance,
          status: calc.newBalance === 0 ? 'Paid' : 'Active plan',
        });
      }

      const receiptNo = 'KHP-' + String(Date.now()).slice(-6);
      const payment = await db.InstallmentPayment.create({
        shopId: req.shopId,
        receiptNo,
        planId: plan.id,
        saleId: plan.saleId || '',
        customerId: plan.customerId || '',
        customerName: plan.customerName,
        amount: calc.amount,
        method: cleanMethod,
        bankName: cleanMethod === 'bank' ? cleanBank : '',
        reference: String(reference || '').trim(),
        note: String(note || '').trim(),
        idempotencyKey: String(idempotencyKey || ''),
        receivedBy: req.user.name,
      });

      if (cleanMethod === 'bank') {
        const bankAcc = await db.BankAccount.findOne({ shopId: req.shopId, bankName: cleanBank });
        if (!bankAcc || bankAcc.active === false) { const error = new Error('Select an active bank account.'); error.status = 400; throw error; }
        await db.BankAccount.updateOne({ _id: bankAcc.id, shopId: req.shopId }, { balance: signedNum(bankAcc.balance) + calc.amount });
      }

      await db.FinancialTransaction.create({
        shopId: req.shopId,
        txNo: 'FIN-' + String(Date.now()).slice(-6),
        type: 'installment_receipt',
        direction: 'in',
        amount: calc.amount,
        method: cleanMethod,
        bankName: cleanMethod === 'bank' ? cleanBank : '',
        reference: receiptNo,
        partyName: plan.customerName,
        relatedId: plan.planNo || plan.invoiceNo,
        note: `Installment payment (${receiptNo}) from ${plan.customerName}`,
        createdBy: req.user.name,
      });

      await logAudit(
        req.shopId,
        req.user,
        'installment_payment_received',
        'InstallmentPayment',
        payment.id,
        `Received Rs. ${calc.amount.toLocaleString()} from ${plan.customerName} (${receiptNo})`
      );

      return { payment, plan: updatedPlan };
    });

    return res.status(201).json(result);
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.status ? err.message : err.message || 'Failed to record installment payment.' });
  }
});

// ============================================================================
// 7. RECEIVE STOCK FROM SUPPLIER INVOICE (OCR Draft + Validation + Posting)
// ============================================================================

apiRouter.post('/ocr/invoice', async (req, res) => {
  try {
    const { dataUrl, fileName = 'invoice.jpg', mimeType = 'image/jpeg' } = req.body || {};
    const documentMatch = typeof dataUrl === 'string' && dataUrl.match(/^data:(image\/(?:jpeg|png|webp)|application\/pdf);base64,([A-Za-z0-9+/]+={0,2})$/);
    if (!documentMatch || documentMatch[1] !== mimeType) {
      return res.status(400).json({ error: 'Upload a JPEG, PNG, WebP image or PDF with a matching document type.' });
    }
    if (Buffer.from(documentMatch[2], 'base64').length > 10 * 1024 * 1024) {
      return res.status(413).json({ error: 'Invoice document must be 10 MB or smaller.' });
    }

    const isPdf = String(mimeType).includes('pdf') || String(fileName).toLowerCase().endsWith('.pdf');

    // Attempt Gemini Vision OCR extraction if GEMINI_API_KEY is available and valid
    const apiKey = (process.env.GEMINI_API_KEY || '').trim();
    let ocrFailure = '';
    const hasRealKey = apiKey && apiKey !== 'MY_GEMINI_API_KEY' && dataUrl && dataUrl.startsWith('data:image/');

    if (hasRealKey) {
      try {
        const ai = new GoogleGenAI({ apiKey });
        const base64Data = dataUrl.split(',')[1];
        const response = await ai.models.generateContent({
          model: process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite',
          config: {
            responseMimeType: 'application/json',
            httpOptions: { timeout: 25000, retryOptions: { attempts: 2, initialDelay: 1, maxDelay: 2 } },
          },
          contents: [
            {
              inlineData: {
                mimeType: mimeType || 'image/jpeg',
                data: base64Data,
              },
            },
            {
              text: INVOICE_OCR_PROMPT,
            },
          ],
        });
        const text = response.text || '';
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          const draft = normalizeInvoiceDraft(parsed);
          return res.json({
            ocrStatus: 'extracted',
            limitationNote: ['Invoice draft extracted. Review all fields against the original before confirming.', ...draft.warnings].join(' '),
            draft,
          });
        }
      } catch (error) {
        const status = Number(error.status);
        ocrFailure = [429, 503, 504].includes(status) || /timeout|deadline|abort/i.test(error.message || '')
          ? 'Invoice reading timed out or the OCR service is busy. Upload the invoice again to retry; no items were saved.'
          : 'Automatic invoice reading failed. Upload again to retry or enter the items manually; no items were saved.';
        // Fall through to safe draft template with transparent explanation
      }
    }

    if (isPdf) {
      return res.json({
        ocrStatus: 'manual_required',
        limitationNote:
          'PDF attached for review. No product data was guessed. Enter the supplier and invoice items manually before posting.',
        draft: {
          supplier: '',
          invoiceNo: '',
          date: '',
          items: [],
          invoiceTotal: '',
        },
      });
    }

    return res.json({
      ocrStatus: 'manual_required',
      limitationNote: !apiKey
        ? 'Automatic invoice reading is not configured. The original invoice is attached; enter its details manually. Stock changes only after confirmation.'
        : ocrFailure || 'Invoice could not be read. No product data was guessed. Enter the supplier and invoice items manually; inventory will remain unchanged until you confirm.',
      draft: {
        supplier: '',
        invoiceNo: '',
        date: '',
        items: [],
        invoiceTotal: '',
      },
    });
  } catch (err) {
    return res.status(500).json({ error: 'Could not process invoice document.' });
  }
});

apiRouter.post('/stock-receipts', async (req, res) => {
  try {
    const {
      idempotencyKey,
      supplier,
      invoiceNo,
      invoiceDate,
      invoiceTotal,
      items = [],
      paymentMethod = 'credit',
      paidNow = 0,
      bankName = '',
      paymentReference = '',
      documentName = '',
      documentType = '',
      documentDataUrl = '',
      ocrDraftUsed = false,
    } = req.body || {};

    if (idempotencyKey) {
      const existingRec = await db.StockReceipt.findOne({
        shopId: req.shopId,
        idempotencyKey: String(idempotencyKey),
      });
      if (existingRec) {
        return res.json({ receipt: existingRec, duplicate: true });
      }
    }

    const existingReceipts = await db.StockReceipt.find({ shopId: req.shopId });
    const validation = validateStockReceipt({
      supplier,
      invoiceNo,
      invoiceTotal,
      paidNow,
      items,
      existingReceipts,
    });

    if (!validation.valid) {
      return res.status(400).json({ error: validation.error });
    }

    const cleanSupplier = String(supplier).trim();
    const cleanInvoiceNo = String(invoiceNo).trim();
    const dateStr = String(invoiceDate || pakistanDateString());
    if (!isValidDateOnly(dateStr)) {
      return res.status(400).json({ error: 'A valid invoice date is required.' });
    }
    if (!['credit', 'cash', 'bank'].includes(paymentMethod) ||
        (paymentMethod === 'credit' && validation.paidNow !== 0)) {
      return res.status(400).json({ error: 'Choose a valid payment method. Supplier credit must have zero paid now.' });
    }
    if (validation.paidNow > 0 && paymentMethod === 'bank' && !String(bankName).trim()) {
      return res.status(400).json({ error: 'Select the payment bank.' });
    }
    if (validation.paidNow > 0 && paymentMethod === 'bank') {
      const bankAcc = await db.BankAccount.findOne({ shopId: req.shopId, bankName: String(bankName).trim() });
      if (!bankAcc || bankAcc.active === false) return res.status(400).json({ error: 'Select an active bank account.' });
    }
    const documentCheck = validateAttachment(documentDataUrl);
    if (!documentCheck.valid) return res.status(400).json({ error: documentCheck.error });
    if (documentCheck.mimeType && documentType && documentCheck.mimeType !== documentType) {
      return res.status(400).json({ error: 'Invoice document type does not match its uploaded file.' });
    }

    const result = await runInTransaction(async () => {
      // Recheck inside the transaction; the normalized unique index also blocks concurrent posts.
      const currentReceipts = await db.StockReceipt.find({ shopId: req.shopId });
      if (currentReceipts.some((r) => normalizeKey(r.supplier) === normalizeKey(cleanSupplier) &&
          normalizeKey(r.invoiceNo) === normalizeKey(cleanInvoiceNo))) {
        const error = new Error('Duplicate supplier invoice is blocked.');
        error.status = 409;
        throw error;
      }
      const shopProducts = await db.Product.find({ shopId: req.shopId });
      const processedLines = [];

      // A missing sale price is safe only when an existing product already has one.
      // Require an explicit retail price for a new product instead of silently saving it at Rs. 0.
      for (const line of items) {
        const cleanName = String(line.name).trim();
        const cleanCode = String(line.code || line.barcode || '').trim();
        const matched = matchProduct(shopProducts, { ...line, name: cleanName, code: cleanCode });
        const hasSalePrice = line.price !== undefined && line.price !== null && line.price !== '';
        if (!hasSalePrice && (!matched || num(matched.price) <= 0)) {
          const error = new Error(`Enter a sale price for new product "${cleanName}" before confirming stock.`);
          error.status = 400;
          throw error;
        }
      }

      // 1. Update or create products & record StockMovements
      for (const line of items) {
        const cleanName = String(line.name).trim();
        const cleanCode = String(line.code || line.barcode || '').trim();
        const qty = Math.floor(num(line.qty));
        const cost = num(line.cost);
        let prod = matchProduct(shopProducts, { ...line, name: cleanName, code: cleanCode });
        // Only apply an explicitly entered retail price; OCR never guesses one.
        const hasSalePrice = line.price !== undefined && line.price !== null && line.price !== '';
        const price = hasSalePrice ? Number(line.price) : prod ? num(prod.price) : 0;
        const warranty = String(line.warranty || '').trim();

        let stockAfter = qty;
        if (prod) {
          stockAfter = num(prod.stock) + qty;
          prod = await db.Product.updateOne(
            { _id: prod.id, shopId: req.shopId },
            {
              name: cleanName,
              stock: stockAfter,
              cost,
              price,
              ...(warranty ? { warranty } : {}),
            }
          );
          shopProducts[shopProducts.findIndex((p) => p.id === prod.id)] = prod;
        } else {
          const generatedCode = cleanCode || `SKU-${crypto.randomUUID().slice(0, 8)}`;
          prod = await db.Product.create({
            shopId: req.shopId,
            name: cleanName,
            code: generatedCode,
            barcode: generatedCode,
            category: String(line.category || 'Electronics').trim(),
            warranty,
            stock: qty,
            cost,
            price,
            reorderThreshold: 5,
            active: true,
          });
          shopProducts.push(prod);
        }

        processedLines.push({
          productId: prod.id,
          name: prod.name,
          code: prod.code,
          qty,
          cost,
          price,
          warranty: warranty || prod.warranty || '',
        });

        await db.StockMovement.create({
          shopId: req.shopId,
          productId: prod.id,
          productName: prod.name,
          code: prod.code,
          type: 'receive',
          qtyChange: qty,
          stockAfter,
          unitCost: cost,
          unitPrice: price,
          referenceId: cleanInvoiceNo,
          note: `Supplier invoice ${cleanInvoiceNo} (${cleanSupplier})`,
          createdBy: req.user.name,
        });
      }

      // 2. Update or create Supplier
      let sup = (await db.Supplier.find({ shopId: req.shopId })).find((s) => normalizeKey(s.name) === normalizeKey(cleanSupplier));
      if (sup) {
        sup = await db.Supplier.updateOne(
          { _id: sup.id, shopId: req.shopId },
          {
            balancePayable: num(sup.balancePayable) + validation.supplierPayableAdded,
            lastPurchaseDate: dateStr,
          }
        );
      } else {
        sup = await db.Supplier.create({
          shopId: req.shopId,
          name: cleanSupplier,
          contactPerson: '',
          phone: '',
          address: '',
          openingBalance: 0,
          balancePayable: validation.supplierPayableAdded,
          lastPurchaseDate: dateStr,
          status: 'Active',
        });
      }

      // 3. Create StockReceipt
      const receiptNo = 'REC-' + crypto.randomUUID().slice(0, 8);
      const receipt = await db.StockReceipt.create({
        shopId: req.shopId,
        receiptNo,
        supplierId: sup.id,
        supplier: cleanSupplier,
        invoiceNo: cleanInvoiceNo,
        invoiceKey: JSON.stringify([normalizeKey(cleanSupplier), normalizeKey(cleanInvoiceNo)]),
        date: dateStr,
        total: validation.calculatedTotal,
        items: processedLines,
        documentName: String(documentName || ''),
        documentType: String(documentType || ''),
        documentDataUrl: String(documentDataUrl || ''),
        ocrDraftUsed: Boolean(ocrDraftUsed),
        payment: {
          method: paymentMethod,
          paid: validation.paidNow,
          bankName: paymentMethod === 'bank' ? bankName || 'HBL' : '',
          reference: String(paymentReference || ''),
          balance: validation.supplierPayableAdded,
        },
        idempotencyKey: String(idempotencyKey || ''),
        createdBy: req.user.name,
      });

      // 4. Record supplier payment if paidNow > 0
      if (validation.paidNow > 0) {
        if (paymentMethod === 'bank') {
          const targetBank = String(bankName).trim();
          const bankAcc = await db.BankAccount.findOne({ shopId: req.shopId, bankName: targetBank });
          if (!bankAcc || bankAcc.active === false) { const error = new Error('Select an active bank account.'); error.status = 400; throw error; }
          await db.BankAccount.updateOne({ _id: bankAcc.id, shopId: req.shopId }, { balance: signedNum(bankAcc.balance) - validation.paidNow });
        }

        await db.FinancialTransaction.create({
            shopId: req.shopId,
            txNo: 'FIN-' + String(Date.now()).slice(-6),
            type: 'supplier_payment',
            direction: 'out',
            amount: validation.paidNow,
            method: paymentMethod,
            bankName: paymentMethod === 'bank' ? bankName || 'HBL' : '',
            reference: paymentReference || cleanInvoiceNo,
            partyName: cleanSupplier,
            relatedId: receiptNo,
            note: `Paid on supplier invoice ${cleanInvoiceNo}`,
            createdBy: req.user.name,
        });
      }

      await logAudit(
        req.shopId,
        req.user,
        'stock_received',
        'StockReceipt',
        receipt.id,
        `Stock received from ${cleanSupplier} (${cleanInvoiceNo}) · Rs. ${validation.calculatedTotal.toLocaleString()}`
      );

      return { receipt, supplier: sup };
    });

    return res.status(201).json(result);
  } catch (err) {
    return res.status(err.code === 11000 ? 409 : err.status || 500).json({
      error: err.code === 11000 ? 'Duplicate supplier invoice is blocked.' : err.message || 'Failed to save stock receipt.' });
  }
});

// ============================================================================
// 8. CUSTOMER RETURNS (Prevent Over-Return + Update Inventory & Finance)
// ============================================================================

apiRouter.post('/returns', async (req, res) => {
  try {
    const {
      invoiceNo,
      saleId,
      items = [],
      reason = '',
      refundMethod = 'cash',
      bankName = '',
    } = req.body || {};

    let bill = null;
    if (saleId) {
      bill = await db.Sale.findOne({ _id: saleId, shopId: req.shopId });
    }
    if (!bill && invoiceNo) {
      bill = await db.Sale.findOne({ invoiceNo: String(invoiceNo).trim(), shopId: req.shopId });
    }
    if (!bill || !verifyTenantAccess(bill.shopId, req.shopId)) {
      return res.status(404).json({ error: 'Original sale invoice not found in your shop.' });
    }

    const priorReturns = await db.CustomerReturn.find({
      shopId: req.shopId,
      invoiceNo: bill.invoiceNo,
    });

    const calc = calculateCustomerReturn({
      bill,
      returnItems: items,
      priorReturns,
    });

    if (!calc.valid) {
      return res.status(400).json({ error: calc.error });
    }
    const cleanRefundMethod = String(refundMethod || '').toLowerCase();
    const cleanRefundBank = String(bankName || '').trim();
    if (!['cash', 'bank', 'credit_adjustment'].includes(cleanRefundMethod) ||
        (cleanRefundMethod === 'bank' && !cleanRefundBank)) {
      return res.status(400).json({ error: 'Choose cash refund, bank refund, or customer balance adjustment; select a bank for bank refunds.' });
    }

    const result = await runInTransaction(async () => {
      const returnNo = 'RET-' + String(Date.now()).slice(-5);

      // 1. Restore inventory stock & log StockMovement
      for (const line of calc.items) {
        if (line.productId && line.productId !== 'custom') {
          const prod = await db.Product.findOne({ _id: line.productId, shopId: req.shopId });
          if (prod) {
            const nextStock = num(prod.stock) + line.qty;
            await db.Product.updateOne(
              { _id: prod.id, shopId: req.shopId },
              { stock: nextStock }
            );
            await db.StockMovement.create({
              shopId: req.shopId,
              productId: prod.id,
              productName: prod.name,
              code: prod.code,
              type: 'return',
              qtyChange: line.qty,
              stockAfter: nextStock,
              unitCost: line.unitCost,
              unitPrice: line.unitPrice,
              referenceId: returnNo,
              note: `Customer return from ${bill.invoiceNo}: ${reason || 'Returned item'}`,
              createdBy: req.user.name,
            });
          }
        }
      }

      // 2. Create CustomerReturn record
      const retRecord = await db.CustomerReturn.create({
        shopId: req.shopId,
        returnNo,
        saleId: bill.id,
        invoiceNo: bill.invoiceNo,
        customerId: bill.customerId || '',
        customerName: bill.customer || 'Walk-in customer',
        items: calc.items,
        totalReturnAmount: calc.totalReturnAmount,
        totalCostRestored: calc.totalCostRestored,
        reason: String(reason || 'Customer return').trim(),
        refundMethod: cleanRefundMethod,
        bankName: cleanRefundMethod === 'bank' ? cleanRefundBank : '',
        status: 'Processed',
        createdBy: req.user.name,
      });

      // Apply any unpaid invoice balance first, then refund only value the customer has paid.
      const balanceApplied = Math.min(num(bill.balance), calc.totalReturnAmount);
      const cashRefund = Math.max(0, calc.totalReturnAmount - balanceApplied);
      const nextBalance = Math.max(0, num(bill.balance) - balanceApplied);
      await db.Sale.updateOne({ _id: bill.id, shopId: req.shopId }, {
        balance: nextBalance, status: nextBalance === 0 ? 'Paid' : bill.status,
      });
      if (bill.type === 'installment') {
        const plan = await db.InstallmentPlan.findOne({ shopId: req.shopId, invoiceNo: bill.invoiceNo });
        if (plan) {
          const planBalance = Math.max(0, num(plan.balance) - balanceApplied);
          await db.InstallmentPlan.updateOne({ _id: plan.id, shopId: req.shopId }, {
            balance: planBalance, status: planBalance === 0 ? 'Paid' : 'Active',
          });
        }
      }
      if (bill.customerId && bill.customerId !== 'walkin') {
        const customer = await db.Customer.findOne({ _id: bill.customerId, shopId: req.shopId });
        if (customer) {
          await db.Customer.updateOne({ _id: customer.id, shopId: req.shopId }, {
            creditBalance: Math.max(0, num(customer.creditBalance) - balanceApplied + (cleanRefundMethod === 'credit_adjustment' ? cashRefund : 0)),
          });
        }
      }
      if (cleanRefundMethod === 'credit_adjustment') {
        // Any return value beyond the unpaid invoice becomes customer credit above.
      } else if (cashRefund > 0) {
        if (cleanRefundMethod === 'bank') {
          const bankAcc = await db.BankAccount.findOne({ shopId: req.shopId, bankName: cleanRefundBank });
          if (!bankAcc || bankAcc.active === false) { const error = new Error('The selected refund bank was not found.'); error.status = 400; throw error; }
          await db.BankAccount.updateOne({ _id: bankAcc.id, shopId: req.shopId }, { balance: signedNum(bankAcc.balance) - cashRefund });
        }
        await db.FinancialTransaction.create({
          shopId: req.shopId,
          txNo: 'FIN-' + String(Date.now()).slice(-6),
          type: 'return_refund',
          direction: 'out',
          amount: cashRefund,
          method: cleanRefundMethod,
          bankName: cleanRefundMethod === 'bank' ? cleanRefundBank : '',
          reference: returnNo,
          partyName: bill.customer || 'Walk-in customer',
          relatedId: bill.invoiceNo,
          note: `Refund for return ${returnNo} on ${bill.invoiceNo}`,
          createdBy: req.user.name,
        });
      }

      await logAudit(
        req.shopId,
        req.user,
        'customer_return_processed',
        'CustomerReturn',
        retRecord.id,
        `Return ${returnNo} for ${bill.invoiceNo} · Rs. ${calc.totalReturnAmount.toLocaleString()}`
      );

      return { customerReturn: retRecord };
    });

    return res.status(201).json(result);
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message || 'Failed to process customer return.' });
  }
});

// ============================================================================
// 9. ORDERS & HELD BILLS
// ============================================================================

apiRouter.post('/orders', async (req, res) => {
  try {
    const {
      customerId = 'walkin',
      customerName = 'Walk-in customer',
      phone = '',
      saleType = 'cash',
      cartItems = [],
      billDiscount = 0,
      plan = {},
      total = 0,
      status = 'Held',
      note = '',
    } = req.body || {};

    if (!Array.isArray(cartItems) || cartItems.length === 0) {
      return res.status(400).json({ error: 'Add at least one item before holding a bill or order.' });
    }

    const prefix = status === 'Held' ? 'HOLD' : 'ORD';
    const orderNo = `${prefix}-${String(Date.now()).slice(-5)}`;
    const computedTotal =
      num(total) ||
      Math.max(
        0,
        cartItems.reduce((s, i) => s + num(i.price) * Math.max(1, num(i.qty)), 0) - num(billDiscount)
      );

    const order = await db.HeldOrder.create({
      shopId: req.shopId,
      orderNo,
      customerId,
      customerName: String(customerName || 'Walk-in customer').trim(),
      phone: String(phone || '').trim(),
      saleType,
      cartItems,
      billDiscount: num(billDiscount),
      plan,
      total: computedTotal,
      status,
      history: [
        {
          status,
          updatedAt: new Date().toISOString(),
          updatedBy: req.user.name,
          note: String(note || 'Saved from POS').trim(),
        },
      ],
      createdBy: req.user.name,
    });

    await logAudit(
      req.shopId,
      req.user,
      'order_held',
      'HeldOrder',
      order.id,
      `Saved ${orderNo} for ${order.customerName} (Rs. ${computedTotal.toLocaleString()})`
    );

    return res.status(201).json({ order });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to save held bill/order.' });
  }
});

apiRouter.put('/orders/:id/status', async (req, res) => {
  try {
    const order = await db.HeldOrder.findOne({ _id: req.params.id, shopId: req.shopId });
    if (!order) {
      return res.status(404).json({ error: 'Held bill or order not found.' });
    }
    const { status, note = '' } = req.body || {};
    if (!status) {
      return res.status(400).json({ error: 'Status is required.' });
    }
    const history = [
      ...(order.history || []),
      {
        status,
        updatedAt: new Date().toISOString(),
        updatedBy: req.user.name,
        note: String(note || `Changed status to ${status}`).trim(),
      },
    ];
    const updated = await db.HeldOrder.updateOne(
      { _id: order.id, shopId: req.shopId },
      { status, history }
    );
    return res.json({ order: updated });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to update order status.' });
  }
});

apiRouter.delete('/orders/:id', async (req, res) => {
  const deleted = await db.HeldOrder.deleteOne({ _id: req.params.id, shopId: req.shopId });
  return res.json({ ok: deleted });
});

// ============================================================================
// 10. SUPPLIERS & SUPPLIER PAYMENTS
// ============================================================================

apiRouter.post('/suppliers', async (req, res) => {
  try {
    const { name, contactPerson, phone, address, openingBalance } = req.body || {};
    const cleanName = String(name || '').trim();
    if (!cleanName) {
      return res.status(400).json({ error: 'Supplier name is required.' });
    }
    const openBal = num(openingBalance);
    const supplier = await db.Supplier.create({
      shopId: req.shopId,
      name: cleanName,
      contactPerson: String(contactPerson || '').trim(),
      phone: String(phone || '').trim(),
      address: String(address || '').trim(),
      openingBalance: openBal,
      balancePayable: openBal,
      lastPurchaseDate: '—',
      status: 'Active',
    });

    await logAudit(
      req.shopId,
      req.user,
      'supplier_created',
      'Supplier',
      supplier.id,
      `Added supplier "${cleanName}"`
    );

    return res.status(201).json({ supplier });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to create supplier.' });
  }
});

apiRouter.post('/suppliers/:id/pay', async (req, res) => {
  try {
    const sup = await db.Supplier.findOne({ _id: req.params.id, shopId: req.shopId });
    if (!sup || !verifyTenantAccess(sup.shopId, req.shopId)) {
      return res.status(404).json({ error: 'Supplier not found.' });
    }

    const { amount, method = 'cash', bankName = '', reference = '', note = '' } = req.body || {};
    const payAmt = num(amount);
    const cleanMethod = String(method || '').toLowerCase();
    const cleanBank = String(bankName || '').trim();
    if (!Number.isFinite(Number(amount)) || payAmt <= 0 || payAmt > num(sup.balancePayable) ||
        !['cash', 'bank'].includes(cleanMethod) || (cleanMethod === 'bank' && !cleanBank)) {
      return res.status(400).json({
        error: `Enter a valid cash/bank payment up to Rs. ${num(sup.balancePayable).toLocaleString()} and select a bank when needed.`,
      });
    }

    const result = await runInTransaction(async () => {
      const nextBalance = Math.max(0, num(sup.balancePayable) - payAmt);
      const updatedSup = await db.Supplier.updateOne(
        { _id: sup.id, shopId: req.shopId },
        { balancePayable: nextBalance }
      );

      if (cleanMethod === 'bank') {
        const bankAcc = await db.BankAccount.findOne({ shopId: req.shopId, bankName: cleanBank });
        if (!bankAcc || bankAcc.active === false) { const error = new Error('Select an active bank account.'); error.status = 400; throw error; }
        await db.BankAccount.updateOne({ _id: bankAcc.id, shopId: req.shopId }, { balance: signedNum(bankAcc.balance) - payAmt });
      }

      const tx = await db.FinancialTransaction.create({
        shopId: req.shopId,
        txNo: 'FIN-' + String(Date.now()).slice(-6),
        type: 'supplier_payment',
        direction: 'out',
        amount: payAmt,
        method: cleanMethod,
        bankName: cleanMethod === 'bank' ? cleanBank : '',
        reference: String(reference || '').trim(),
        partyName: sup.name,
        relatedId: sup.id,
        note: String(note || `Payment to supplier ${sup.name}`).trim(),
        createdBy: req.user.name,
      });

      await logAudit(
        req.shopId,
        req.user,
        'supplier_payment',
        'Supplier',
        sup.id,
        `Paid Rs. ${payAmt.toLocaleString()} to ${sup.name} via ${method}`
      );

      return { supplier: updatedSup, transaction: tx };
    });

    return res.status(201).json(result);
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.status ? err.message : 'Failed to record supplier payment.' });
  }
});

// ============================================================================
// 11. SHOP EXPENSES (With Audit History + Cash/Bank Balance Update)
// ============================================================================

apiRouter.post('/expenses', async (req, res) => {
  try {
    const {
      title,
      category = 'General',
      date,
      amount,
      paymentMethod = 'Cash',
      bankName = '',
      description = '',
      attachmentName = '',
      attachmentDataUrl = '',
    } = req.body || {};

    const cleanTitle = String(title || '').trim();
    const amt = num(amount);
    const normalizedMethod = String(paymentMethod || '').toLowerCase();
    const cleanBank = String(bankName || '').trim();
    const dateStr = String(date || pakistanDateString());
    const attachmentCheck = validateAttachment(attachmentDataUrl);
    if (!cleanTitle || !Number.isFinite(Number(amount)) || amt <= 0 || !['cash', 'bank'].includes(normalizedMethod) ||
        !isValidDateOnly(dateStr) || !attachmentCheck.valid || (normalizedMethod === 'bank' && !cleanBank)) {
      if (!attachmentCheck.valid) return res.status(400).json({ error: attachmentCheck.error });
      return res.status(400).json({ error: 'Expense title and amount (> 0) are required.' });
    }

    const expenseNo = 'EXP-' + String(Date.now()).slice(-5);

    const result = await runInTransaction(async () => {
      const expense = await db.Expense.create({
        shopId: req.shopId,
        expenseNo,
        title: cleanTitle,
        category: String(category || 'General').trim(),
        date: dateStr,
        amount: amt,
        paymentMethod: normalizedMethod === 'bank' ? 'Bank' : 'Cash',
        bankName: normalizedMethod === 'bank' ? cleanBank : '',
        description: String(description || '').trim(),
        attachmentName: String(attachmentName || ''),
        attachmentDataUrl: String(attachmentDataUrl || ''),
        addedBy: req.user.name,
        auditHistory: [
          {
            updatedAt: new Date().toISOString(),
            updatedBy: req.user.name,
            summary: `Created expense (${cleanTitle} · Rs. ${amt.toLocaleString()} via ${paymentMethod})`,
          },
        ],
      });

      if (normalizedMethod === 'bank') {
        const bankAcc = await db.BankAccount.findOne({ shopId: req.shopId, bankName: cleanBank });
        if (!bankAcc || bankAcc.active === false) {
          const error = new Error('The selected bank account was not found.'); error.status = 400; throw error;
        }
        await db.BankAccount.updateOne({ _id: bankAcc.id, shopId: req.shopId }, { balance: signedNum(bankAcc.balance) - amt });
      }

      await db.FinancialTransaction.create({
        shopId: req.shopId,
        txNo: 'FIN-' + String(Date.now()).slice(-6),
        type: 'expense',
        direction: 'out',
        amount: amt,
        method: normalizedMethod,
        bankName: normalizedMethod === 'bank' ? cleanBank : '',
        reference: expenseNo,
        partyName: cleanTitle,
        relatedId: expense.id,
        note: `${category}: ${description || cleanTitle}`,
        createdBy: req.user.name,
      });

      await logAudit(
        req.shopId,
        req.user,
        'expense_added',
        'Expense',
        expense.id,
        `Expense "${cleanTitle}" (Rs. ${amt.toLocaleString()}) recorded`
      );

      return { expense };
    });

    return res.status(201).json(result);
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.status ? err.message : 'Failed to save expense.' });
  }
});

apiRouter.put('/expenses/:id', async (req, res) => {
  try {
    const existing = await db.Expense.findOne({ _id: req.params.id, shopId: req.shopId });
    if (!existing || !verifyTenantAccess(existing.shopId, req.shopId)) {
      return res.status(404).json({ error: 'Expense not found.' });
    }

    const { title, category, date, amount, paymentMethod, bankName, description } = req.body || {};
    const newTitle = title !== undefined ? String(title).trim() : existing.title;
    const newAmount = amount !== undefined ? num(amount) : num(existing.amount);
    const newMethod = String(paymentMethod || existing.paymentMethod || 'Cash').toLowerCase();
    const newBank = String(bankName !== undefined ? bankName : existing.bankName || '').trim();
    if (!newTitle || !Number.isFinite(newAmount) || newAmount <= 0 || !['cash', 'bank'].includes(newMethod) ||
        (newMethod === 'bank' && !newBank) || (date !== undefined && !isValidDateOnly(date))) {
      return res.status(400).json({ error: 'Enter a valid title, amount, date, and cash or a selected bank account.' });
    }

    const historyEntry = {
      updatedAt: new Date().toISOString(),
      updatedBy: req.user.name,
      summary: `Edited: ${existing.title} (Rs. ${num(existing.amount).toLocaleString()}) -> ${newTitle} (Rs. ${newAmount.toLocaleString()})`,
    };

    const result = await runInTransaction(async () => {
      const oldIsBank = String(existing.paymentMethod || '').toLowerCase() === 'bank';
      const oldBank = oldIsBank ? await db.BankAccount.findOne({ shopId: req.shopId, bankName: existing.bankName }) : null;
      const newBankAccount = newMethod === 'bank' ? await db.BankAccount.findOne({ shopId: req.shopId, bankName: newBank }) : null;
      if (newMethod === 'bank' && (!newBankAccount || newBankAccount.active === false)) {
        const error = new Error('The selected bank account was not found.'); error.status = 400; throw error;
      }
      if (oldBank && newBankAccount && oldBank.id === newBankAccount.id) {
        await db.BankAccount.updateOne({ _id: oldBank.id, shopId: req.shopId }, { balance: signedNum(oldBank.balance) + num(existing.amount) - newAmount });
      } else {
        if (oldBank) await db.BankAccount.updateOne({ _id: oldBank.id, shopId: req.shopId }, { balance: signedNum(oldBank.balance) + num(existing.amount) });
        if (newBankAccount) await db.BankAccount.updateOne({ _id: newBankAccount.id, shopId: req.shopId }, { balance: signedNum(newBankAccount.balance) - newAmount });
      }
      const updated = await db.Expense.updateOne({ _id: existing.id, shopId: req.shopId }, {
        title: newTitle, category: category !== undefined ? String(category).trim() : existing.category,
        date: date || existing.date, amount: newAmount, paymentMethod: newMethod === 'bank' ? 'Bank' : 'Cash',
        bankName: newMethod === 'bank' ? newBank : '',
        description: description !== undefined ? String(description).trim() : existing.description,
        auditHistory: [...(existing.auditHistory || []), historyEntry],
      });
      const tx = await db.FinancialTransaction.findOne({ shopId: req.shopId, type: 'expense', relatedId: existing.id });
      const txPatch = { direction: 'out', amount: newAmount, method: newMethod, bankName: newMethod === 'bank' ? newBank : '',
        partyName: newTitle, reference: existing.expenseNo, note: `${category || existing.category}: ${description || existing.description || newTitle}` };
      if (tx) await db.FinancialTransaction.updateOne({ _id: tx.id, shopId: req.shopId }, txPatch);
      else await db.FinancialTransaction.create({ shopId: req.shopId, txNo: 'FIN-' + String(Date.now()).slice(-6), type: 'expense',
        ...txPatch, createdBy: req.user.name, relatedId: existing.id });
      await logAudit(req.shopId, req.user, 'expense_edited', 'Expense', existing.id, historyEntry.summary);
      return { expense: updated };
    });
    return res.json(result);
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.status ? err.message : 'Failed to update expense.' });
  }
});

// ============================================================================
// 12. CHEQUE REGISTER & FINANCE / BANK ACCOUNTS
// ============================================================================

apiRouter.post('/cheques', async (req, res) => {
  try {
    const {
      chequeNo,
      direction = 'received',
      bankName,
      accountTitle = '',
      partyName,
      amount,
      issueDate,
      dueDate,
      status = 'Pending',
    } = req.body || {};

    const cleanNo = String(chequeNo || '').trim();
    const cleanBank = String(bankName || '').trim();
    const cleanParty = String(partyName || '').trim();
    const amt = num(amount);

    if (!cleanNo || !cleanBank || !cleanParty || amt <= 0) {
      return res.status(400).json({
        error: 'Cheque number, bank name, party name, and amount are required.',
      });
    }

    const today = new Date().toISOString().slice(0, 10);
    const cheque = await db.Cheque.create({
      shopId: req.shopId,
      chequeNo: cleanNo,
      direction,
      bankName: cleanBank,
      accountTitle: String(accountTitle || 'Business Account').trim(),
      partyName: cleanParty,
      amount: amt,
      issueDate: issueDate || today,
      dueDate: dueDate || today,
      status,
      history: [
        {
          status,
          changedAt: new Date().toISOString(),
          changedBy: req.user.name,
          note: `Recorded ${direction} cheque #${cleanNo}`,
        },
      ],
    });

    await logAudit(
      req.shopId,
      req.user,
      'cheque_recorded',
      'Cheque',
      cheque.id,
      `Cheque #${cleanNo} (${cleanBank}) for ${cleanParty} · Rs. ${amt.toLocaleString()}`
    );

    return res.status(201).json({ cheque });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to record cheque.' });
  }
});

apiRouter.put('/cheques/:id/status', async (req, res) => {
  try {
    const cheque = await db.Cheque.findOne({ _id: req.params.id, shopId: req.shopId });
    if (!cheque || !verifyTenantAccess(cheque.shopId, req.shopId)) {
      return res.status(404).json({ error: 'Cheque not found.' });
    }

    const { status, note = '' } = req.body || {};
    if (!['Pending', 'Cleared', 'Bounced', 'Cancelled'].includes(status)) {
      return res.status(400).json({ error: 'Invalid cheque status.' });
    }

    const prevStatus = cheque.status;
    const history = [
      ...(cheque.history || []),
      {
        status,
        changedAt: new Date().toISOString(),
        changedBy: req.user.name,
        note: String(note || `Changed from ${prevStatus} to ${status}`).trim(),
      },
    ];

    const updated = await db.Cheque.updateOne(
      { _id: cheque.id, shopId: req.shopId },
      { status, history }
    );

    // If transitioning to Cleared for the first time, update bank balance and financial ledger
    if (prevStatus !== 'Cleared' && status === 'Cleared') {
      const bankAcc = await db.BankAccount.findOne({
        shopId: req.shopId,
        bankName: cheque.bankName,
      });
      const delta = cheque.direction === 'received' ? num(cheque.amount) : -num(cheque.amount);
      if (bankAcc) {
        await db.BankAccount.updateOne(
          { _id: bankAcc.id, shopId: req.shopId },
          { balance: signedNum(bankAcc.balance) + delta }
        );
      }
      await db.FinancialTransaction.create({
        shopId: req.shopId,
        txNo: 'FIN-' + String(Date.now()).slice(-6),
        type: cheque.direction === 'received' ? 'customer_receipt' : 'supplier_payment',
        direction: cheque.direction === 'received' ? 'in' : 'out',
        amount: num(cheque.amount),
        method: 'cheque',
        bankName: cheque.bankName,
        reference: cheque.chequeNo,
        partyName: cheque.partyName,
        relatedId: cheque.id,
        note: `Cheque #${cheque.chequeNo} cleared (${cheque.bankName})`,
        createdBy: req.user.name,
      });
    }

    return res.json({ cheque: updated });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to update cheque status.' });
  }
});

apiRouter.post('/finance/banks', async (req, res) => {
  try {
    const { bankName, accountTitle, accountNumber, openingBalance } = req.body || {};
    const cleanBank = String(bankName || '').trim();
    if (!cleanBank) {
      return res.status(400).json({ error: 'Bank name is required.' });
    }
    if (await db.BankAccount.findOne({ shopId: req.shopId, bankName: cleanBank })) {
      return res.status(409).json({ error: 'A bank account with this name already exists in your shop.' });
    }
    const openBal = signedNum(openingBalance);
    const bank = await db.BankAccount.create({
      shopId: req.shopId,
      bankName: cleanBank,
      accountTitle: String(accountTitle || cleanBank).trim(),
      accountNumber: String(accountNumber || '').trim(),
      logo: '/assets/payment-banks/hbl.png',
      openingBalance: openBal,
      balance: openBal,
      active: true,
    });
    return res.status(201).json({ bankAccount: bank });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to add bank account.' });
  }
});

apiRouter.post('/finance/transactions', async (req, res) => {
  try {
    const {
      type = 'customer_receipt',
      direction = 'in',
      amount,
      method = 'cash',
      bankName = '',
      reference = '',
      partyName = '',
      relatedId = '',
      note = '',
    } = req.body || {};

    const amt = Number(amount);
    const cleanBank = String(bankName || '').trim();
    const cleanInvoice = String(relatedId || '').trim();
    if (!Number.isFinite(amt) || amt <= 0 || type !== 'customer_receipt' || direction !== 'in' ||
        !['cash', 'bank'].includes(method) || !cleanInvoice || (method === 'bank' && !cleanBank)) {
      return res.status(400).json({ error: 'A customer receipt needs a positive amount, invoice, valid inflow direction, and cash or a selected bank.' });
    }

    const result = await runInTransaction(async () => {
      const bill = await db.Sale.findOne({ invoiceNo: cleanInvoice, shopId: req.shopId });
      if (!bill) {
        const error = new Error('The invoice was not found in this shop.'); error.status = 404; throw error;
      }
      const balance = num(bill.balance);
      if (amt > balance) {
        const error = new Error(`Receipt exceeds the remaining invoice balance of Rs. ${balance.toLocaleString()}.`); error.status = 400; throw error;
      }
      let bankAcc = null;
      if (method === 'bank') {
        bankAcc = await db.BankAccount.findOne({ shopId: req.shopId, bankName: cleanBank });
        if (!bankAcc) {
          const error = new Error('The selected bank account was not found.'); error.status = 400; throw error;
        }
      }
      const newBal = balance - amt;
      await db.Sale.updateOne({ _id: bill.id, shopId: req.shopId }, {
        paid: num(bill.paid) + amt,
        balance: newBal,
        cashCollected: method === 'cash' ? num(bill.cashCollected) + amt : num(bill.cashCollected),
        bankCollected: method === 'bank' ? num(bill.bankCollected) + amt : num(bill.bankCollected),
        status: newBal === 0 ? 'Paid' : bill.status,
      });
      if (bill.customerId && bill.customerId !== 'walkin') {
        const customer = await db.Customer.findOne({ _id: bill.customerId, shopId: req.shopId });
        if (customer) await db.Customer.updateOne({ _id: customer.id, shopId: req.shopId }, {
          creditBalance: Math.max(0, num(customer.creditBalance) - amt),
        });
      }
      if (bankAcc) await db.BankAccount.updateOne({ _id: bankAcc.id, shopId: req.shopId }, { balance: signedNum(bankAcc.balance) + amt });
      const transaction = await db.FinancialTransaction.create({
        shopId: req.shopId, txNo: 'FIN-' + String(Date.now()).slice(-6), type, direction, amount: amt,
        method, bankName: cleanBank, reference: String(reference || '').trim(), partyName: String(partyName || '').trim(),
        relatedId: cleanInvoice, note: String(note || '').trim(), createdBy: req.user.name,
      });
      return { transaction };
    });
    return res.status(201).json(result);
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.status ? err.message : 'Failed to record financial transaction.' });
  }
});
