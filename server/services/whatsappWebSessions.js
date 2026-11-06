import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import QRCode from 'qrcode';
import WhatsAppWeb from 'whatsapp-web.js';
import { normalizeWhatsAppNumber } from '../utils/whatsappCloud.js';

const { Client, LocalAuth, MessageMedia } = WhatsAppWeb;

const truthy = (value) => String(value || '').trim().toLowerCase() === 'true';

function shopSessionId(shopId) {
  return `shop-${crypto.createHash('sha256').update(String(shopId)).digest('hex').slice(0, 32)}`;
}

export function createWhatsAppWebSessionManager({
  env = process.env,
  dataPath = env.WHATSAPP_WEB_DATA_PATH || path.resolve(process.cwd(), '.wwebjs_auth'),
  clientFactory = async ({ clientId, dataPath: authPath, browserPath }) => new Client({
    authStrategy: new LocalAuth({ clientId, dataPath: authPath }),
    puppeteer: {
      headless: true,
      ...(browserPath ? { executablePath: browserPath } : {}),
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    },
  }),
  qrEncoder = (value) => QRCode.toDataURL(value, { errorCorrectionLevel: 'M', margin: 2, width: 320 }),
  messageMediaFactory = (mimeType, data, fileName) => new MessageMedia(mimeType, data, fileName),
  now = () => Date.now(),
} = {}) {
  const sessions = new Map();
  const invoiceSends = new Map();
  const rootPath = path.resolve(dataPath);

  const isEnabled = () => truthy(env.WHATSAPP_WEB_ENABLED);
  const sessionPath = (shopId) => path.join(rootPath, `session-${shopSessionId(shopId)}`);

  function publicStatus(shopId, entry = sessions.get(String(shopId))) {
    if (!isEnabled()) return { enabled: false, status: 'disabled', connected: false, phoneNumber: '', qrDataUrl: '' };
    if (!entry) return { enabled: true, status: 'disconnected', connected: false, phoneNumber: '', qrDataUrl: '' };
    return {
      enabled: true,
      status: entry.status,
      connected: entry.status === 'connected',
      phoneNumber: entry.phoneNumber || '',
      qrDataUrl: entry.status === 'qr' ? entry.qrDataUrl || '' : '',
      error: entry.status === 'error' ? entry.error || 'WhatsApp could not start.' : '',
    };
  }

  function startClient(shopId) {
    const id = String(shopId);
    const existing = sessions.get(id);
    if (existing) return existing;

    const entry = {
      shopId: id,
      status: 'starting',
      phoneNumber: '',
      qrDataUrl: '',
      error: '',
      client: null,
      disconnecting: false,
    };
    sessions.set(id, entry);

    entry.startPromise = (async () => {
      try {
        const client = await clientFactory({
          clientId: shopSessionId(id),
          dataPath: rootPath,
          browserPath: String(env.WHATSAPP_WEB_BROWSER_PATH || '').trim(),
          shopId: id,
        });
        entry.client = client;
        client.on('qr', async (qr) => {
          if (entry.disconnecting) return;
          try {
            entry.qrDataUrl = await qrEncoder(qr);
            entry.status = 'qr';
            entry.error = '';
          } catch {
            entry.status = 'error';
            entry.error = 'Could not create a WhatsApp link QR code.';
          }
        });
        client.on('authenticated', () => {
          entry.status = 'authenticated';
          entry.qrDataUrl = '';
          entry.error = '';
        });
        client.on('ready', () => {
          entry.status = 'connected';
          entry.qrDataUrl = '';
          entry.error = '';
          entry.phoneNumber = String(client.info?.wid?.user || '');
        });
        client.on('auth_failure', () => {
          entry.status = 'error';
          entry.qrDataUrl = '';
          entry.error = 'WhatsApp authentication failed. Disconnect and link the device again.';
        });
        client.on('disconnected', (reason) => {
          if (entry.disconnecting) return;
          entry.status = 'disconnected';
          entry.phoneNumber = '';
          entry.qrDataUrl = '';
          entry.error = String(reason || 'WhatsApp device disconnected.');
        });
        await client.initialize();
      } catch (error) {
        entry.status = 'error';
        entry.qrDataUrl = '';
        entry.error = error?.message || 'Could not start the WhatsApp session.';
      }
      return entry;
    })();
    return entry;
  }

  async function getStatus(shopId) {
    if (!isEnabled()) return publicStatus(shopId);
    const id = String(shopId || '');
    let entry = sessions.get(id);
    if (!entry) {
      try {
        await fs.access(sessionPath(id));
        entry = startClient(id); // Restore a previously linked LocalAuth session lazily.
      } catch {
        return publicStatus(id);
      }
    }
    return publicStatus(id, entry);
  }

  async function link(shopId) {
    if (!isEnabled()) throw new Error('WhatsApp Web linking is disabled by the backend feature flag.');
    const entry = startClient(String(shopId || ''));
    return publicStatus(shopId, entry);
  }

  async function disconnect(shopId) {
    const id = String(shopId || '');
    const entry = sessions.get(id);
    if (entry) {
      entry.disconnecting = true;
      try {
        await entry.client?.logout();
      } catch {
        // Clearing the local session below still completes a disconnect.
      }
      try {
        await entry.client?.destroy();
      } catch {
        // The browser may already have exited after logout.
      }
      sessions.delete(id);
    }
    await fs.rm(sessionPath(id), { recursive: true, force: true });
    return publicStatus(id);
  }

  async function sendInvoiceDocument({ shopId, invoiceNo, to, pdf, fileName, caption = '' }) {
    if (!isEnabled()) throw new Error('WhatsApp Web invoice sending is disabled.');
    const id = String(shopId || '');
    const recipient = normalizeWhatsAppNumber(to);
    if (!recipient) throw new Error('The invoice has no valid customer WhatsApp number.');
    if (!Buffer.isBuffer(pdf) || pdf.length === 0 || pdf.length > 10 * 1024 * 1024) {
      throw new Error('Invoice PDF must be between 1 byte and 10 MiB.');
    }

    const dedupeKey = `${id}:${String(invoiceNo || '')}`;
    const recent = invoiceSends.get(dedupeKey);
    if (recent && recent.expiresAt > now()) {
      if (recent.promise) return recent.promise;
      return { ...recent.result, duplicate: true };
    }

    const safeFileName = String(fileName || `${invoiceNo || 'invoice'}.pdf`).replace(/[^\w.-]/g, '_').slice(0, 120) || 'invoice.pdf';
    const sendPromise = (async () => {
      const entry = sessions.get(id) || await getStatus(id).then(() => sessions.get(id));
      if (!entry || entry.status !== 'connected' || !entry.client) {
        throw new Error('This shop has no linked WhatsApp device. Ask the Shop Owner to link WhatsApp in Settings.');
      }
      const numberId = await entry.client.getNumberId(recipient);
      if (!numberId) throw new Error('The customer WhatsApp number is invalid or is not registered on WhatsApp.');
      const media = messageMediaFactory('application/pdf', pdf.toString('base64'), safeFileName);
      const message = await entry.client.sendMessage(numberId._serialized || `${recipient}@c.us`, media, {
        caption: String(caption || '').slice(0, 1024),
        sendMediaAsDocument: true,
      });
      return { messageId: String(message?.id?._serialized || ''), duplicate: false };
    })();
    const sendRecord = { promise: sendPromise, result: null, expiresAt: now() + 5 * 60 * 1000 };
    invoiceSends.set(dedupeKey, sendRecord);
    try {
      sendRecord.result = await sendPromise;
      sendRecord.promise = null;
      sendRecord.expiresAt = now() + 5 * 60 * 1000;
      return sendRecord.result;
    } catch (error) {
      invoiceSends.delete(dedupeKey);
      throw error;
    }
  }

  async function restorePersistedSessions(shopIds = []) {
    if (!isEnabled()) return 0;
    let restored = 0;
    for (const shopId of shopIds) {
      try {
        await fs.access(sessionPath(shopId));
        startClient(shopId);
        restored += 1;
      } catch {
        // No saved session for this shop.
      }
    }
    return restored;
  }

  return {
    getStatus,
    link,
    disconnect,
    sendInvoiceDocument,
    // Only metadata is returned by the API. Never expose a client, auth path, or credentials.
    restorePersistedSessions,
    sessionPath,
    isEnabled,
  };
}

let activeWhatsAppWebSessionManager = createWhatsAppWebSessionManager();

export function getWhatsAppWebSessionManager() {
  return activeWhatsAppWebSessionManager;
}

export function setWhatsAppWebSessionManagerForTests(manager) {
  const previous = activeWhatsAppWebSessionManager;
  activeWhatsAppWebSessionManager = manager;
  return () => { activeWhatsAppWebSessionManager = previous; };
}
