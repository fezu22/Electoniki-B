import mongoose from 'mongoose';
import { db } from '../db.js';
import {
  getWhatsAppAutomationConfig,
  isWhatsAppAutomationConfigured,
  normalizeWhatsAppNumber,
  sendWhatsAppTemplate,
} from '../utils/whatsappCloud.js';

const POLL_INTERVAL_MS = 5 * 60 * 1000;
let schedulerTimer = null;
let cycleRunning = false;

function pakistanDateParts(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Karachi',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  return Object.fromEntries(parts.filter((part) => part.type !== 'literal').map(({ type, value }) => [type, value]));
}

function normalizedRecipients(values = []) {
  return [...new Set(values.map(normalizeWhatsAppNumber).filter(Boolean))].slice(0, 2);
}

async function resetRecoveredStockAlerts(shopId, products) {
  for (const product of products) {
    const threshold = Number(product.reorderThreshold ?? 5);
    const recovered = Number(product.stock || 0) > threshold;
    if (recovered && product.lowStockNotifiedRecipients?.length) {
      await db.Product.updateOne(
        { _id: product.id, shopId },
        { lowStockNotifiedRecipients: [] }
      );
    }
  }
}

async function processLowStockAlerts(shop, products, configReady) {
  const automation = shop.automation || {};
  const recipients = normalizedRecipients(automation.lowStockRecipients || []);
  if (!automation.lowStockAlertsEnabled || !configReady || recipients.length !== 2) return;

  const config = getWhatsAppAutomationConfig();
  for (const product of products) {
    const threshold = Number(product.reorderThreshold ?? 5);
    if (Number(product.stock || 0) > threshold) continue;
    const alreadyNotified = (product.lowStockNotifiedRecipients || []).map(normalizeWhatsAppNumber);
    for (const recipient of recipients) {
      if (alreadyNotified.includes(recipient)) continue;
      try {
        await sendWhatsAppTemplate({
          to: recipient,
          templateName: config.lowStockTemplate,
          parameters: [shop.name, product.name, product.code, product.stock || 0, threshold],
        });
        alreadyNotified.push(recipient);
        await db.Product.updateOne(
          { _id: product.id, shopId: shop.id },
          { lowStockNotifiedRecipients: [...new Set(alreadyNotified)] }
        );
      } catch (error) {
        console.error(`Low-stock WhatsApp alert failed for product ${product.code}:`, error.message);
      }
    }
  }
}

async function processInstallmentReminders(shop, plans, paidPlanIdsThisMonth, dateKey, monthKey, hour, configReady) {
  const automation = shop.automation || {};
  if (!automation.installmentRemindersEnabled || !configReady) return;
  const config = getWhatsAppAutomationConfig();

  for (const plan of plans) {
    if (!shouldSendInstallmentReminder(plan, dateKey, monthKey, hour, paidPlanIdsThisMonth.has(String(plan.id)))) continue;

    const recipient = normalizeWhatsAppNumber(plan.whatsapp || plan.phone);
    if (!recipient) continue;
    try {
      await sendWhatsAppTemplate({
        to: recipient,
        templateName: config.installmentTemplate,
        parameters: [
          plan.customerName,
          plan.planNo || plan.invoiceNo,
          plan.monthlyAmount || plan.balance,
          plan.nextDueDate,
          plan.balance,
          shop.name,
        ],
      });
      await db.InstallmentPlan.updateOne(
        { _id: plan.id, shopId: shop.id },
        { lastWhatsAppReminderDate: dateKey, lastWhatsAppReminderMonth: monthKey }
      );
    } catch (error) {
      console.error(`Installment WhatsApp reminder failed for plan ${plan.planNo}:`, error.message);
    }
  }
}

export function shouldSendInstallmentReminder(plan, dateKey, monthKey, hour, paymentRecordedThisMonth = false) {
  if (hour !== '08') return false;
  if (paymentRecordedThisMonth) return false;
  if (Number(plan.balance || 0) <= 0 || !plan.whatsappReminderEnabled || !plan.whatsappReminderConsent) return false;
  if (!plan.nextDueDate || plan.nextDueDate === 'Completed' || plan.nextDueDate > dateKey) return false;
  if (plan.lastWhatsAppReminderDate === dateKey) return false;
    if (plan.lastInstallmentPaymentAt) {
    const paymentDate = pakistanDateParts(new Date(plan.lastInstallmentPaymentAt));
    if (`${paymentDate.year}-${paymentDate.month}` === monthKey) return false;
  }
  return true;
}

export async function runAutomationCycle(now = new Date()) {
  // Skip scheduled work while MongoDB is disconnected or reconnecting. This
  // also avoids querying through a session that startup cleanup has ended.
  if (mongoose.connection.readyState !== 1) return;
  if (cycleRunning) return;
  cycleRunning = true;
  try {
    const { year, month, day, hour } = pakistanDateParts(now);
    const dateKey = `${year}-${month}-${day}`;
    const monthKey = `${year}-${month}`;
    const shops = await db.Shop.find({});
    const configReady = isWhatsAppAutomationConfigured();

    for (const shop of shops) {
      const [products, plans, payments] = await Promise.all([
        db.Product.find({ shopId: shop.id }),
        db.InstallmentPlan.find({ shopId: shop.id }),
        db.InstallmentPayment.find({ shopId: shop.id }),
      ]);
      const paidPlanIdsThisMonth = new Set(payments
        .filter((payment) => payment.createdAt && (() => {
          const paymentDate = pakistanDateParts(new Date(payment.createdAt));
          return `${paymentDate.year}-${paymentDate.month}` === monthKey;
        })())
        .map((payment) => String(payment.planId)));
      await resetRecoveredStockAlerts(shop.id, products);
      await processLowStockAlerts(shop, products, configReady);
      await processInstallmentReminders(shop, plans, paidPlanIdsThisMonth, dateKey, monthKey, hour, configReady);
    }
  } finally {
    cycleRunning = false;
  }
}

export function startAutomationScheduler() {
  if (schedulerTimer) return schedulerTimer;
  const run = () => runAutomationCycle().catch((error) => {
    console.error('WhatsApp automation cycle failed:', error.message);
  });
  void run();
  schedulerTimer = setInterval(run, POLL_INTERVAL_MS);
  schedulerTimer.unref?.();
  return schedulerTimer;
}
