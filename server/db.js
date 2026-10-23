import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import mongoose from 'mongoose';
import { AsyncLocalStorage } from 'node:async_hooks';
import { MongooseModels } from './models/schemas.js';

const DATA_DIR = path.resolve(process.cwd(), '.data');
const DATA_FILE = path.join(DATA_DIR, 'electrohub-db.json');

const COLLECTIONS = [
  'Shop',
  'User',
  'Product',
  'Customer',
  'Supplier',
  'Sale',
  'InstallmentPlan',
  'InstallmentPayment',
  'StockReceipt',
  'StockMovement',
  'Expense',
  'BankAccount',
  'FinancialTransaction',
  'Cheque',
  'CustomerReturn',
  'HeldOrder',
  'AuditEvent',
];

let useMongo = false;
let localState = null;
let inMemoryTestMode = false;
const transactionContext = new AsyncLocalStorage();

function initLocalState() {
  if (localState) return localState;
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (fs.existsSync(DATA_FILE)) {
    try {
      const raw = fs.readFileSync(DATA_FILE, 'utf8');
      localState = JSON.parse(raw);
    } catch {
      localState = {};
    }
  } else {
    localState = {};
  }
  for (const col of COLLECTIONS) {
    if (!Array.isArray(localState[col])) {
      localState[col] = [];
    }
  }
  return localState;
}

export function saveLocalState() {
  if (useMongo || inMemoryTestMode || !localState) return;
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    fs.writeFileSync(DATA_FILE, JSON.stringify(localState, null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to persist local state:', err.message);
  }
}

export function resetInMemoryStateForTests() {
  useMongo = false;
  inMemoryTestMode = true;
  localState = {};
  for (const col of COLLECTIONS) {
    localState[col] = [];
  }
}

function matchesQuery(doc, query = {}) {
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined) continue;
    if (k === '$or' && Array.isArray(v)) {
      if (!v.some((sub) => matchesQuery(doc, sub))) return false;
      continue;
    }
    const actual = k === '_id' || k === 'id' ? doc.id || doc._id : doc[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof RegExp)) {
      if ('$regex' in v) {
        const re = new RegExp(v.$regex, v.$options || 'i');
        if (!re.test(String(actual ?? ''))) return false;
        continue;
      }
      if ('$in' in v && Array.isArray(v.$in)) {
        if (!v.$in.map(String).includes(String(actual))) return false;
        continue;
      }
      if ('$gte' in v || '$lte' in v || '$gt' in v || '$lt' in v) {
        const val = typeof actual === 'number' ? actual : new Date(actual).getTime();
        if ('$gte' in v && val < (typeof v.$gte === 'number' ? v.$gte : new Date(v.$gte).getTime())) return false;
        if ('$gt' in v && val <= (typeof v.$gt === 'number' ? v.$gt : new Date(v.$gt).getTime())) return false;
        if ('$lte' in v && val > (typeof v.$lte === 'number' ? v.$lte : new Date(v.$lte).getTime())) return false;
        if ('$lt' in v && val >= (typeof v.$lt === 'number' ? v.$lt : new Date(v.$lt).getTime())) return false;
        continue;
      }
    }
    if (v instanceof RegExp) {
      if (!v.test(String(actual ?? ''))) return false;
      continue;
    }
    if (String(actual) !== String(v)) return false;
  }
  return true;
}

function normalizeDoc(raw) {
  if (!raw) return null;
  const obj = typeof raw.toObject === 'function' ? raw.toObject() : { ...raw };
  const id = String(obj._id || obj.id || '');
  return { ...obj, _id: id, id };
}

function createRepository(name) {
  const Model = MongooseModels[name];

  return {
    async find(query = {}, { sort = { createdAt: -1 }, limit = 0 } = {}) {
      if (useMongo) {
        const mQuery = { ...query };
        if (mQuery.id && !mQuery._id) {
          mQuery._id = mQuery.id;
          delete mQuery.id;
        }
        let q = Model.find(mQuery).session(transactionContext.getStore() || null);
        if (sort) q = q.sort(sort);
        if (limit > 0) q = q.limit(limit);
        const docs = await q.lean();
        return docs.map(normalizeDoc);
      }

      const state = initLocalState();
      let list = state[name].filter((doc) => matchesQuery(doc, query));
      if (sort) {
        const [field, dir] = Object.entries(sort)[0] || ['createdAt', -1];
        list = list.slice().sort((a, b) => {
          const av = a[field] ?? '';
          const bv = b[field] ?? '';
          if (av < bv) return dir < 0 ? 1 : -1;
          if (av > bv) return dir < 0 ? -1 : 1;
          return 0;
        });
      }
      if (limit > 0) list = list.slice(0, limit);
      return list.map(normalizeDoc);
    },

    async findOne(query = {}) {
      if (useMongo) {
        const mQuery = { ...query };
        if (mQuery.id && !mQuery._id) {
          mQuery._id = mQuery.id;
          delete mQuery.id;
        }
        const doc = await Model.findOne(mQuery).session(transactionContext.getStore() || null).lean();
        return normalizeDoc(doc);
      }
      const state = initLocalState();
      const found = state[name].find((doc) => matchesQuery(doc, query));
      return normalizeDoc(found);
    },

    async findById(id) {
      if (!id) return null;
      return this.findOne({ _id: String(id) });
    },

    async create(data) {
      const now = new Date().toISOString();
      if (useMongo) {
        const payload = { ...data };
        if (payload.id && !payload._id) payload._id = payload.id;
        const [created] = await Model.create([payload], { session: transactionContext.getStore() });
        return normalizeDoc(created);
      }
      const state = initLocalState();
      const id = String(data._id || data.id || crypto.randomUUID());
      const doc = {
        ...data,
        _id: id,
        id,
        createdAt: data.createdAt || now,
        updatedAt: now,
      };
      state[name].unshift(doc);
      saveLocalState();
      return normalizeDoc(doc);
    },

    async updateOne(query, patch) {
      const now = new Date().toISOString();
      if (useMongo) {
        const mQuery = { ...query };
        if (mQuery.id && !mQuery._id) {
          mQuery._id = mQuery.id;
          delete mQuery.id;
        }
        const updated = await Model.findOneAndUpdate(
          mQuery,
          { $set: { ...patch, updatedAt: now } },
          { new: true, runValidators: true, session: transactionContext.getStore() }
        ).lean();
        return normalizeDoc(updated);
      }
      const state = initLocalState();
      const idx = state[name].findIndex((doc) => matchesQuery(doc, query));
      if (idx === -1) return null;
      state[name][idx] = {
        ...state[name][idx],
        ...patch,
        updatedAt: now,
      };
      saveLocalState();
      return normalizeDoc(state[name][idx]);
    },

    async deleteOne(query) {
      if (useMongo) {
        const mQuery = { ...query };
        if (mQuery.id && !mQuery._id) {
          mQuery._id = mQuery.id;
          delete mQuery.id;
        }
        const res = await Model.deleteOne(mQuery).session(transactionContext.getStore() || null);
        return res.deletedCount > 0;
      }
      const state = initLocalState();
      const idx = state[name].findIndex((doc) => matchesQuery(doc, query));
      if (idx === -1) return false;
      state[name].splice(idx, 1);
      saveLocalState();
      return true;
    },

    async count(query = {}) {
      if (useMongo) {
        return Model.countDocuments(query).session(transactionContext.getStore() || null);
      }
      const state = initLocalState();
      return state[name].filter((doc) => matchesQuery(doc, query)).length;
    },
  };
}

export const db = {};
for (const col of COLLECTIONS) {
  db[col] = createRepository(col);
}

/**
 * The application uses MongoDB for persisted data. In-memory storage is limited to tests.
 */
export async function connectDatabase() {
  const uri = (process.env.MONGODB_URI || '').trim();
  const isPlaceholder = !uri || /username:password@|MY_MONGODB_URI|<.*>/.test(uri);
  if (isPlaceholder) {
    throw new Error('Set a valid MONGODB_URI in backend/.env before starting the server.');
  }
  try {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
    useMongo = true;
    inMemoryTestMode = false;
    console.log('Connected to MongoDB.');
    return { mode: 'mongodb' };
  } catch (err) {
    throw new Error(`MongoDB connection failed: ${err.message}`);
  }
}

/**
 * Executes a multi-step database workflow inside a MongoDB session transaction
 * when connected to a replica set / Atlas, or with an atomic state snapshot rollback
 * when using the local persistent store.
 */
export async function runInTransaction(workFn) {
  if (useMongo) {
    let session = null;
    try {
      session = await mongoose.startSession();
      let result;
      await session.withTransaction(async () => {
        result = await transactionContext.run(session, () => workFn(session));
      });
      session.endSession();
      return result;
    } catch (err) {
      if (session) session.endSession();
      // Receiving must never leave partially posted inventory or payments.
      if (/Transaction numbers are only allowed on a replica set/i.test(err.message)) {
        throw new Error('MongoDB transactions require Atlas or a replica set. No stock was posted.');
      }
      throw err;
    }
  }

  // Atomic snapshot rollback for local persistent store
  const state = initLocalState();
  const snapshot = JSON.stringify(state);
  try {
    const res = await workFn(null);
    saveLocalState();
    return res;
  } catch (err) {
    localState = JSON.parse(snapshot);
    saveLocalState();
    throw err;
  }
}
