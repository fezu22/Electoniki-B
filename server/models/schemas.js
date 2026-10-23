import mongoose from 'mongoose';

const { Schema } = mongoose;

const shopSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    whatsapp: { type: String, default: '', trim: true },
    phone: { type: String, default: '', trim: true },
    address: { type: String, default: '', trim: true },
    city: { type: String, default: '', trim: true },
    receiptFooter: {
      type: String,
      default: 'Thank you for shopping with us! Warranty claims require original invoice.',
    },
    invoicePrefix: { type: String, default: 'INV', trim: true },
    currency: { type: String, default: 'PKR' },
    openingCash: { type: Number, default: 0 },
    taxNumber: { type: String, default: '' },
    automation: {
      type: Schema.Types.Mixed,
      default: () => ({
        installmentRemindersEnabled: false,
        lowStockAlertsEnabled: false,
        lowStockRecipients: [],
      }),
    },
  },
  { timestamps: true }
);

const userSchema = new Schema(
  {
    shopId: { type: String, required: true, index: true },
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    role: { type: String, enum: ['owner', 'shop_account', 'overview_viewer'], default: 'shop_account' },
    active: { type: Boolean, default: true },
    resetCodeHash: { type: String, default: null },
    resetExpiresAt: { type: Date, default: null },
    resetAttempts: { type: Number, default: 0, min: 0 },
    resetLockedUntil: { type: Date, default: null },
    lastLoginAt: { type: Date, default: null },
  },
  { timestamps: true }
);
userSchema.index({ shopId: 1, email: 1 }, { unique: true });

const productSchema = new Schema(
  {
    shopId: { type: String, required: true, index: true },
    name: { type: String, required: true, trim: true },
    code: { type: String, required: true, trim: true },
    barcode: { type: String, default: '', trim: true },
    serialNumber: { type: String, default: '', trim: true },
    category: { type: String, default: 'Electronics', trim: true },
    warranty: { type: String, default: '', trim: true },
    cost: { type: Number, default: 0, min: 0 },
    price: { type: Number, required: true, min: 0 },
    stock: { type: Number, default: 0, min: 0 },
    reorderThreshold: { type: Number, default: 5, min: 0 },
    lowStockNotifiedRecipients: { type: [String], default: [] },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);
productSchema.index({ shopId: 1, code: 1 });
productSchema.index({ shopId: 1, name: 1 });

const customerSchema = new Schema(
  {
    shopId: { type: String, required: true, index: true },
    name: { type: String, required: true, trim: true },
    phone: { type: String, default: '', trim: true },
    whatsapp: { type: String, default: '', trim: true },
    cnic: { type: String, default: '', trim: true },
    address: { type: String, default: '', trim: true },
    guarantor: { type: String, default: '', trim: true },
    guarantorPhone: { type: String, default: '', trim: true },
    guarantorAddress: { type: String, default: '', trim: true },
    creditBalance: { type: Number, default: 0 },
  },
  { timestamps: true }
);
customerSchema.index({ shopId: 1, phone: 1 });
customerSchema.index({ shopId: 1, name: 1 });

const supplierSchema = new Schema(
  {
    shopId: { type: String, required: true, index: true },
    name: { type: String, required: true, trim: true },
    contactPerson: { type: String, default: '', trim: true },
    phone: { type: String, default: '', trim: true },
    address: { type: String, default: '', trim: true },
    openingBalance: { type: Number, default: 0 },
    balancePayable: { type: Number, default: 0 },
    lastPurchaseDate: { type: String, default: '' },
    status: { type: String, default: 'Active' },
  },
  { timestamps: true }
);
supplierSchema.index({ shopId: 1, name: 1 });

const saleItemSchema = new Schema(
  {
    productId: { type: String, required: true },
    name: { type: String, required: true },
    code: { type: String, default: '' },
    category: { type: String, default: 'Electronics' },
    serialNumber: { type: String, default: '' },
    warranty: { type: String, default: '' },
    qty: { type: Number, required: true, min: 1 },
    price: { type: Number, required: true, min: 0 },
    cost: { type: Number, default: 0, min: 0 },
    total: { type: Number, required: true, min: 0 },
  },
  { _id: false }
);

const saleSchema = new Schema(
  {
    shopId: { type: String, required: true, index: true },
    invoiceNo: { type: String, required: true },
    idempotencyKey: { type: String, default: '' },
    customerId: { type: String, default: 'walkin' },
    customer: { type: String, default: 'Walk-in customer' },
    phone: { type: String, default: '' },
    whatsapp: { type: String, default: '' },
    cnic: { type: String, default: '' },
    address: { type: String, default: '' },
    guarantor: { type: String, default: '' },
    guarantorPhone: { type: String, default: '' },
    guarantorAddress: { type: String, default: '' },
    type: { type: String, enum: ['cash', 'installment'], default: 'cash' },
    items: [saleItemSchema],
    gross: { type: Number, required: true },
    billDiscount: { type: Number, default: 0 },
    discounted: { type: Number, required: true },
    installmentPercent: { type: Number, default: 0 },
    add: { type: Number, default: 0 },
    total: { type: Number, required: true },
    totalCost: { type: Number, default: 0 },
    initialPaid: { type: Number, default: 0 },
    paid: { type: Number, default: 0 },
    cashCollected: { type: Number, default: 0 },
    bankCollected: { type: Number, default: 0 },
    chequeCollected: { type: Number, default: 0 },
    balance: { type: Number, default: 0 },
    paymentMethod: { type: String, default: 'cash' },
    paymentDetails: { type: Schema.Types.Mixed, default: {} },
    months: { type: Number, default: 0 },
    monthly: { type: Number, default: 0 },
    planStart: { type: String, default: '' },
    status: { type: String, default: 'Paid' },
    createdBy: { type: String, default: '' },
  },
  { timestamps: true }
);
saleSchema.index({ shopId: 1, invoiceNo: 1 });
saleSchema.index({ shopId: 1, createdAt: -1 });

const installmentPlanSchema = new Schema(
  {
    shopId: { type: String, required: true, index: true },
    planNo: { type: String, required: true },
    saleId: { type: String, default: '' },
    invoiceNo: { type: String, default: '' },
    customerId: { type: String, default: '' },
    customerName: { type: String, required: true },
    installmentDetails: { type: Schema.Types.Mixed, default: {} },
    phone: { type: String, default: '' },
    whatsapp: { type: String, default: '' },
    cnic: { type: String, default: '' },
    address: { type: String, default: '' },
    guarantor: { type: String, default: '' },
    guarantorPhone: { type: String, default: '' },
    guarantorAddress: { type: String, default: '' },
    productSummary: { type: String, default: '' },
    totalAmount: { type: Number, required: true },
    advancePaid: { type: Number, default: 0 },
    paid: { type: Number, default: 0 },
    balance: { type: Number, default: 0 },
    months: { type: Number, default: 12 },
    monthlyAmount: { type: Number, default: 0 },
    installmentPercent: { type: Number, default: 0 },
    startDate: { type: String, default: '' },
    nextDueDate: { type: String, default: '' },
    whatsappReminderEnabled: { type: Boolean, default: false },
    whatsappReminderConsent: { type: Boolean, default: false },
    lastWhatsAppReminderMonth: { type: String, default: '' },
    status: { type: String, default: 'Active' },
  },
  { timestamps: true }
);
installmentPlanSchema.index({ shopId: 1, status: 1 });

const installmentPaymentSchema = new Schema(
  {
    shopId: { type: String, required: true, index: true },
    receiptNo: { type: String, required: true },
    planId: { type: String, required: true },
    saleId: { type: String, default: '' },
    customerId: { type: String, default: '' },
    customerName: { type: String, required: true },
    amount: { type: Number, required: true, min: 1 },
    method: { type: String, default: 'cash' },
    bankName: { type: String, default: '' },
    reference: { type: String, default: '' },
    note: { type: String, default: '' },
    idempotencyKey: { type: String, default: '' },
    receivedBy: { type: String, default: '' },
  },
  { timestamps: true }
);
installmentPaymentSchema.index({ shopId: 1, planId: 1 });

const stockReceiptSchema = new Schema(
  {
    shopId: { type: String, required: true, index: true },
    receiptNo: { type: String, required: true },
    supplierId: { type: String, default: '' },
    supplier: { type: String, required: true },
    invoiceNo: { type: String, required: true },
    date: { type: String, required: true },
    total: { type: Number, required: true },
    items: { type: Array, default: [] },
    invoiceKey: { type: String },
    documentName: { type: String, default: '' },
    documentType: { type: String, default: '' },
    documentDataUrl: { type: String, default: '' },
    ocrDraftUsed: { type: Boolean, default: false },
    payment: { type: Schema.Types.Mixed, default: {} },
    idempotencyKey: { type: String, default: '' },
    createdBy: { type: String, default: '' },
  },
  { timestamps: true }
);
stockReceiptSchema.index({ shopId: 1, supplier: 1, invoiceNo: 1 }, { unique: true });
stockReceiptSchema.index({ shopId: 1, invoiceKey: 1 }, {
  unique: true,
  partialFilterExpression: { invoiceKey: { $type: 'string' } },
});

const stockMovementSchema = new Schema(
  {
    shopId: { type: String, required: true, index: true },
    productId: { type: String, required: true },
    productName: { type: String, required: true },
    code: { type: String, default: '' },
    type: { type: String, enum: ['receive', 'sale', 'return', 'adjustment'], required: true },
    qtyChange: { type: Number, required: true },
    stockAfter: { type: Number, required: true },
    unitCost: { type: Number, default: 0 },
    unitPrice: { type: Number, default: 0 },
    referenceId: { type: String, default: '' },
    note: { type: String, default: '' },
    createdBy: { type: String, default: '' },
  },
  { timestamps: true }
);
stockMovementSchema.index({ shopId: 1, createdAt: -1 });

const expenseSchema = new Schema(
  {
    shopId: { type: String, required: true, index: true },
    expenseNo: { type: String, required: true },
    title: { type: String, required: true },
    category: { type: String, default: 'General' },
    date: { type: String, required: true },
    amount: { type: Number, required: true, min: 0 },
    paymentMethod: { type: String, default: 'Cash' },
    bankName: { type: String, default: '' },
    description: { type: String, default: '' },
    attachmentName: { type: String, default: '' },
    attachmentDataUrl: { type: String, default: '' },
    addedBy: { type: String, default: '' },
    auditHistory: { type: Array, default: [] },
  },
  { timestamps: true }
);
expenseSchema.index({ shopId: 1, date: -1 });

const bankAccountSchema = new Schema(
  {
    shopId: { type: String, required: true, index: true },
    bankName: { type: String, required: true },
    accountTitle: { type: String, default: '' },
    accountNumber: { type: String, default: '' },
    logo: { type: String, default: '' },
    openingBalance: { type: Number, default: 0 },
    balance: { type: Number, default: 0 },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);
bankAccountSchema.index({ shopId: 1, bankName: 1 });

const financialTransactionSchema = new Schema(
  {
    shopId: { type: String, required: true, index: true },
    txNo: { type: String, required: true },
    type: {
      type: String,
      enum: [
        'sale_receipt',
        'installment_receipt',
        'customer_receipt',
        'supplier_payment',
        'expense',
        'return_refund',
        'transfer',
        'opening_balance',
      ],
      required: true,
    },
    direction: { type: String, enum: ['in', 'out'], required: true },
    amount: { type: Number, required: true },
    method: { type: String, default: 'cash' },
    bankName: { type: String, default: '' },
    reference: { type: String, default: '' },
    partyName: { type: String, default: '' },
    relatedId: { type: String, default: '' },
    note: { type: String, default: '' },
    createdBy: { type: String, default: '' },
  },
  { timestamps: true }
);
financialTransactionSchema.index({ shopId: 1, createdAt: -1 });

const chequeSchema = new Schema(
  {
    shopId: { type: String, required: true, index: true },
    chequeNo: { type: String, required: true },
    direction: { type: String, enum: ['received', 'issued'], default: 'received' },
    bankName: { type: String, required: true },
    accountTitle: { type: String, default: '' },
    partyName: { type: String, required: true },
    amount: { type: Number, required: true },
    issueDate: { type: String, default: '' },
    dueDate: { type: String, default: '' },
    status: { type: String, enum: ['Pending', 'Cleared', 'Bounced', 'Cancelled'], default: 'Pending' },
    relatedInvoice: { type: String, default: '' },
    history: { type: Array, default: [] },
  },
  { timestamps: true }
);
chequeSchema.index({ shopId: 1, chequeNo: 1 });

const customerReturnSchema = new Schema(
  {
    shopId: { type: String, required: true, index: true },
    returnNo: { type: String, required: true },
    saleId: { type: String, required: true },
    invoiceNo: { type: String, required: true },
    customerId: { type: String, default: '' },
    customerName: { type: String, default: '' },
    items: { type: Array, default: [] },
    totalReturnAmount: { type: Number, required: true },
    totalCostRestored: { type: Number, default: 0 },
    reason: { type: String, default: '' },
    refundMethod: { type: String, enum: ['cash', 'bank', 'credit_adjustment'], default: 'cash' },
    bankName: { type: String, default: '' },
    status: { type: String, default: 'Processed' },
    createdBy: { type: String, default: '' },
  },
  { timestamps: true }
);
customerReturnSchema.index({ shopId: 1, invoiceNo: 1 });

const heldOrderSchema = new Schema(
  {
    shopId: { type: String, required: true, index: true },
    orderNo: { type: String, required: true },
    customerId: { type: String, default: 'walkin' },
    customerName: { type: String, default: 'Walk-in customer' },
    phone: { type: String, default: '' },
    saleType: { type: String, default: 'cash' },
    cartItems: { type: Array, default: [] },
    billDiscount: { type: Number, default: 0 },
    plan: { type: Schema.Types.Mixed, default: {} },
    total: { type: Number, default: 0 },
    status: {
      type: String,
      enum: ['Held', 'Pending Delivery', 'Partial Delivery', 'Completed', 'Cancelled'],
      default: 'Held',
    },
    history: { type: Array, default: [] },
    createdBy: { type: String, default: '' },
  },
  { timestamps: true }
);
heldOrderSchema.index({ shopId: 1, status: 1 });

const auditEventSchema = new Schema(
  {
    shopId: { type: String, required: true, index: true },
    action: { type: String, required: true },
    entityType: { type: String, default: '' },
    entityId: { type: String, default: '' },
    summary: { type: String, required: true },
    actorName: { type: String, default: '' },
    actorRole: { type: String, default: '' },
  },
  { timestamps: true }
);
auditEventSchema.index({ shopId: 1, createdAt: -1 });

export const MongooseModels = {
  Shop: mongoose.models.Shop || mongoose.model('Shop', shopSchema),
  User: mongoose.models.User || mongoose.model('User', userSchema),
  Product: mongoose.models.Product || mongoose.model('Product', productSchema),
  Customer: mongoose.models.Customer || mongoose.model('Customer', customerSchema),
  Supplier: mongoose.models.Supplier || mongoose.model('Supplier', supplierSchema),
  Sale: mongoose.models.Sale || mongoose.model('Sale', saleSchema),
  InstallmentPlan: mongoose.models.InstallmentPlan || mongoose.model('InstallmentPlan', installmentPlanSchema),
  InstallmentPayment:
    mongoose.models.InstallmentPayment || mongoose.model('InstallmentPayment', installmentPaymentSchema),
  StockReceipt: mongoose.models.StockReceipt || mongoose.model('StockReceipt', stockReceiptSchema),
  StockMovement: mongoose.models.StockMovement || mongoose.model('StockMovement', stockMovementSchema),
  Expense: mongoose.models.Expense || mongoose.model('Expense', expenseSchema),
  BankAccount: mongoose.models.BankAccount || mongoose.model('BankAccount', bankAccountSchema),
  FinancialTransaction:
    mongoose.models.FinancialTransaction || mongoose.model('FinancialTransaction', financialTransactionSchema),
  Cheque: mongoose.models.Cheque || mongoose.model('Cheque', chequeSchema),
  CustomerReturn: mongoose.models.CustomerReturn || mongoose.model('CustomerReturn', customerReturnSchema),
  HeldOrder: mongoose.models.HeldOrder || mongoose.model('HeldOrder', heldOrderSchema),
  AuditEvent: mongoose.models.AuditEvent || mongoose.model('AuditEvent', auditEventSchema),
};
