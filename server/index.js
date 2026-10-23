import 'dotenv/config';
import express from 'express';
import mongoose from 'mongoose';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import path from 'path';
import { connectDatabase } from './db.js';
import { apiRouter } from './routes/api.js';

export function createApp() {
  const app = express();

  // A 10 MiB invoice expands to ~13.4 MiB when encoded as a data URL.
  app.use(express.json({ limit: '16mb' }));
  app.use(express.urlencoded({ extended: true, limit: '12mb' }));
  app.use(cookieParser());

  // Rate limiting for auth endpoints
  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 120,
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
      error: err?.message || 'An unexpected server error occurred.',
    });
  });

  return app;
}

export async function startServer() {
  await connectDatabase();

  const app = createApp();
  const port = Number(process.env.PORT || 3000);
  const isProd = process.env.NODE_ENV === 'production';

  const frontendDistDir = (process.env.FRONTEND_DIST_DIR || '').trim();
  if (isProd && frontendDistDir) {
    const distPath = path.resolve(frontendDistDir);
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  return new Promise((resolve, reject) => {
    const server = app.listen(port, '0.0.0.0', () => {
      console.log(`ElectroHub SaaS server listening on http://0.0.0.0:${port}`);
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

