import 'dotenv/config';
import express from 'express';
import mongoose from 'mongoose';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import path from 'path';
import { fileURLToPath } from 'url';
import { connectDatabase, db } from './db.js';
import { apiRouter } from './routes/api.js';
import { hashPassword } from './middleware/auth.js';
import { startAutomationScheduler } from './services/automationScheduler.js';
import { getWhatsAppWebSessionManager } from './services/whatsappWebSessions.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
    next();
  });

  // The browser app and API share an origin, including through the Vite proxy.
  // Reject state-changing requests from other origins, including login/logout.
  app.use('/api', (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const origin = req.get('Origin');
    if (req.get('Sec-Fetch-Site') === 'cross-site') {
      return res.status(403).json({ error: 'Cross-site requests are not allowed.' });
    }
    if (origin) {
      try {
        const parsed = new URL(origin);
        if (!['http:', 'https:'].includes(parsed.protocol) || parsed.host.toLowerCase() !== String(req.get('Host') || '').toLowerCase()) {
          return res.status(403).json({ error: 'Cross-origin requests are not allowed.' });
        }
      } catch {
        return res.status(403).json({ error: 'Invalid request origin.' });
      }
    }
    next();
  });

  // A 10 MiB invoice expands to ~13.4 MiB when encoded as a data URL.
  app.use(express.json({ limit: '16mb' }));
  app.use(express.urlencoded({ extended: true, limit: '12mb' }));
  app.use(cookieParser());

  // Rate limiting for auth endpoints
  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many authentication attempts, please try again shortly.' },
  });
  const passwordResetLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many password reset requests. Please try again after 15 minutes.' },
  });
  app.use('/api/auth/login', authLimiter);
  app.use('/api/auth/register-shop', authLimiter);
  app.use('/api/auth/forgot-password', passwordResetLimiter);
  app.use('/api/auth/reset-password', passwordResetLimiter);

  app.use('/api', apiRouter);

  // Safe JSON error handler for API routes
  app.use('/api', (err, _req, res, _next) => {
    console.error('API Error:', err?.message || err);
    res.status(err?.status || 500).json({
      error: err?.status >= 400 && err?.status < 500 ? err.message : 'An unexpected server error occurred.',
    });
  });

  return app;
}

export async function startServer() {
  await connectDatabase();
  await ensurePlatformAdmin();

  const app = createApp();
  const port = Number(process.env.PORT || 3000);
  const isProd = process.env.NODE_ENV === 'production';

  if (isProd) {
    const distPath = path.resolve(__dirname, '../../frontend/dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  return new Promise((resolve, reject) => {
    const server = app.listen(port, '0.0.0.0', () => {
      console.log(`ElectroHub SaaS server listening on http://0.0.0.0:${port}`);
      startAutomationScheduler();
      if (getWhatsAppWebSessionManager().isEnabled()) {
        // Reopen the per-shop LocalAuth directories in the background so the
        // API can start serving requests even if Chromium takes time to boot.
        db.Shop.find({})
          .then((shops) => getWhatsAppWebSessionManager().restorePersistedSessions(shops.map((shop) => shop.id)))
          .then((count) => { if (count) console.log(`Restoring ${count} linked WhatsApp shop session(s).`); })
          .catch((error) => console.error('WhatsApp session restore failed:', error?.message || error));
      }
      resolve(server);
    });
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        reject(new Error(`Port ${port} is already in use. Stop the existing ElectroHub backend before starting another copy.`));
      } else {
        reject(err);
      }
    });
  });
}

export async function ensurePlatformAdmin() {
  const email = String(process.env.SUPER_ADMIN_EMAIL || '').trim().toLowerCase();
  const password = String(process.env.SUPER_ADMIN_PASSWORD || '');
  const name = String(process.env.SUPER_ADMIN_NAME || '').trim();
  if (!email && !password && !name) return false;
  if (!email || !password || !name) {
    throw new Error('Set SUPER_ADMIN_EMAIL, SUPER_ADMIN_NAME, and SUPER_ADMIN_PASSWORD together in backend/.env.');
  }
  if (password.length < 12) {
    throw new Error('SUPER_ADMIN_PASSWORD must be at least 12 characters long.');
  }

  let platformShop = (await db.Shop.find({})).find((shop) => shop.platformAdminWorkspace === true);
  if (!platformShop) {
    platformShop = await db.Shop.create({
      name: 'Platform Administration',
      platformAdminWorkspace: true,
      receiptFooter: '',
      invoicePrefix: 'SYS',
      currency: 'PKR',
      openingCash: 0,
    });
  }

  const passwordHash = await hashPassword(password);
  const existing = await db.User.findOne({ email });
  if (existing) {
    if (existing.role === 'super_admin') return false;
    if (String(process.env.SUPER_ADMIN_PROMOTE_EXISTING || '').toLowerCase() !== 'true') {
      throw new Error('SUPER_ADMIN_EMAIL is already assigned to a non-platform user. Set SUPER_ADMIN_PROMOTE_EXISTING=true only if this account should become the platform Super Admin.');
    }
    await db.User.updateOne({ _id: existing.id }, {
      shopId: platformShop.id,
      name,
      passwordHash,
      role: 'super_admin',
      active: true,
    });
    console.info('Existing account promoted to Platform Super Admin.');
    return true;
  }

  await db.User.create({
    shopId: platformShop.id,
    name,
    email,
    passwordHash,
    role: 'super_admin',
    active: true,
  });
  console.info('Platform Super Admin bootstrap completed.');
  return true;
}

// Start server if invoked directly or via server.ts
if (
  process.argv[1] &&
  (process.argv[1].replace(/\\/g, '/').endsWith('server/index.js') || process.argv[1].endsWith('server.ts') || process.argv[1].endsWith('server.js'))
) {
  startServer().catch(async (err) => {
    console.error('Server startup failed:', err.message);
    await mongoose.disconnect();
    process.exitCode = 1;
  });
}
