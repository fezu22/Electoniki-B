import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { db } from '../db.js';

const JWT_SECRET = process.env.JWT_SECRET || '';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '30d';
if (JWT_SECRET.length < 32) {
  throw new Error('JWT_SECRET is required and must contain at least 32 characters. Set it in backend/.env.');
}

function durationToMilliseconds(value) {
  const match = String(value).trim().match(/^(\d+)\s*(s|m|h|d|w)$/i);
  if (!match) throw new Error('JWT_EXPIRES_IN must use a duration such as 30d, 12h, or 45m.');
  const amount = Number(match[1]);
  const units = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
  return amount * units[match[2].toLowerCase()];
}

export const AUTH_COOKIE_MAX_AGE_MS = durationToMilliseconds(JWT_EXPIRES_IN);
export const AUTH_COOKIE_NAME = 'eh_auth_token';

export async function hashPassword(plain) {
  return bcrypt.hash(String(plain), 10);
}

export async function verifyPassword(plain, hash) {
  if (!plain || !hash) return false;
  return bcrypt.compare(String(plain), String(hash));
}

export function signAuthToken(user) {
  return jwt.sign(
    {
      sub: String(user.id || user._id),
      shopId: String(user.shopId),
      role: user.role,
      email: user.email,
      name: user.name,
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

export function verifyAuthToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

export function extractToken(req) {
  const authHeader = req.headers?.authorization || '';
  if (authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7).trim();
  }
  if (req.cookies && req.cookies[AUTH_COOKIE_NAME]) {
    return req.cookies[AUTH_COOKIE_NAME];
  }
  return null;
}

/**
 * Authenticates the user and enforces server-side tenant context.
 * Never trusts client-provided shopId in body/query/params.
 */
export async function requireAuth(req, res, next) {
  try {
    const token = extractToken(req);
    if (!token) {
      return res.status(401).json({ error: 'Authentication required. Please log in.' });
    }

    const decoded = verifyAuthToken(token);
    if (!decoded || !decoded.sub || !decoded.shopId) {
      return res.status(401).json({ error: 'Invalid or expired session. Please log in again.' });
    }

    const user = await db.User.findOne({ _id: decoded.sub, shopId: decoded.shopId });
    if (!user || user.active === false) {
      return res.status(403).json({ error: 'User account is inactive or no longer exists.' });
    }

    const shop = await db.Shop.findById(user.shopId);
    if (!shop) {
      return res.status(403).json({ error: 'Shop workspace not found.' });
    }

    // If the client attempted to pass a mismatched shopId in body or query, reject it explicitly
    const clientShopId = req.body?.shopId || req.query?.shopId || req.headers?.['x-shop-id'];
    if (clientShopId && String(clientShopId) !== String(user.shopId)) {
      return res.status(403).json({
        error: 'Tenant isolation violation: cross-shop access is strictly forbidden.',
      });
    }

    req.user = {
      id: user.id,
      shopId: user.shopId,
      name: user.name,
      email: user.email,
      role: user.role,
    };
    req.shop = shop;
    req.shopId = String(user.shopId);

    // Force-overwrite any body shopId with authenticated shopId
    if (req.body && typeof req.body === 'object') {
      req.body.shopId = req.shopId;
    }

    next();
  } catch (err) {
    return res.status(500).json({ error: 'Authentication check failed.' });
  }
}

/**
 * Restricts route to Shop Owner role only.
 */
export function requireOwner(req, res, next) {
  if (!req.user || req.user.role !== 'owner') {
    return res.status(403).json({
      error: 'Owner permission required. Shop Account users cannot perform this action.',
    });
  }
  next();
}
