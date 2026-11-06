export function normalizeWhatsAppNumber(value) {
  let digits = String(value || '').replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.length === 11 && digits.startsWith('03')) digits = `92${digits.slice(1)}`;
  else if (digits.length === 10 && digits.startsWith('3')) digits = `92${digits}`;
  return /^923\d{9}$/.test(digits) ? digits : '';
}

export function getWhatsAppAutomationConfig(env = process.env) {
  const apiVersion = String(env.WHATSAPP_GRAPH_API_VERSION || 'v25.0').trim();
  return {
    accessToken: String(env.WHATSAPP_ACCESS_TOKEN || '').trim(),
    phoneNumberId: String(env.WHATSAPP_PHONE_NUMBER_ID || '').trim(),
    apiVersion: /^v\d+\.\d+$/.test(apiVersion) ? apiVersion : '',
    language: String(env.WHATSAPP_TEMPLATE_LANGUAGE || 'en_US').trim(),
    installmentTemplate: String(env.WHATSAPP_INSTALLMENT_TEMPLATE || 'installment_payment_reminder').trim(),
    lowStockTemplate: String(env.WHATSAPP_LOW_STOCK_TEMPLATE || 'low_stock_alert').trim(),
  };
}

export function isWhatsAppAutomationConfigured(env = process.env) {
  const config = getWhatsAppAutomationConfig(env);
  return Boolean(config.accessToken && config.phoneNumberId && config.apiVersion && config.language &&
    config.installmentTemplate && config.lowStockTemplate);
}

export async function sendWhatsAppDocument({ to, fileName, pdf, caption = '' }, env = process.env) {
  const config = getWhatsAppAutomationConfig(env);
  if (!config.accessToken || !config.phoneNumberId || !config.apiVersion) {
    throw new Error('WhatsApp Cloud API is not configured. Add WHATSAPP_ACCESS_TOKEN and WHATSAPP_PHONE_NUMBER_ID to the backend environment.');
  }
  const recipient = normalizeWhatsAppNumber(to);
  if (!recipient) throw new Error('Customer WhatsApp number is missing or invalid.');
  if (!Buffer.isBuffer(pdf) || pdf.length === 0 || pdf.length > 10 * 1024 * 1024) {
    throw new Error('Invoice PDF must be between 1 byte and 10 MiB.');
  }
  const safeFileName = String(fileName || 'invoice.pdf').replace(/[^\w.-]/g, '_').slice(0, 120) || 'invoice.pdf';

  const upload = new FormData();
  upload.append('messaging_product', 'whatsapp');
  upload.append('type', 'application/pdf');
  upload.append('file', new Blob([pdf], { type: 'application/pdf' }), safeFileName);
  const mediaResponse = await fetch(`https://graph.facebook.com/${config.apiVersion}/${config.phoneNumberId}/media`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.accessToken}` },
    body: upload,
  });
  const mediaResult = await mediaResponse.json().catch(() => ({}));
  if (!mediaResponse.ok || !mediaResult.id) {
    throw new Error(mediaResult?.error?.message || `WhatsApp PDF upload failed (${mediaResponse.status}).`);
  }

  const messageResponse = await fetch(`https://graph.facebook.com/${config.apiVersion}/${config.phoneNumberId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: recipient,
      type: 'document',
      document: {
        id: mediaResult.id,
        filename: safeFileName,
        ...(caption ? { caption: String(caption).slice(0, 1024) } : {}),
      },
    }),
  });
  const messageResult = await messageResponse.json().catch(() => ({}));
  if (!messageResponse.ok) {
    throw new Error(messageResult?.error?.message || `WhatsApp could not send the invoice (${messageResponse.status}).`);
  }
  return messageResult;
}

export async function sendWhatsAppTemplate({ to, templateName, parameters }, env = process.env) {
  const config = getWhatsAppAutomationConfig(env);
  if (!config.accessToken || !config.phoneNumberId || !config.apiVersion) {
    throw new Error('WhatsApp Cloud API credentials are not configured.');
  }
  const recipient = normalizeWhatsAppNumber(to);
  if (!recipient) throw new Error('Recipient WhatsApp number is invalid.');

  const response = await fetch(`https://graph.facebook.com/${config.apiVersion}/${config.phoneNumberId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: recipient,
      type: 'template',
      template: {
        name: templateName,
        language: { code: config.language },
        components: [{
          type: 'body',
          parameters: parameters.map((text) => ({ type: 'text', text: String(text ?? '') })),
        }],
      },
    }),
  });

  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = result?.error?.message || `WhatsApp Cloud API request failed (${response.status}).`;
    throw new Error(message);
  }
  return result;
}
