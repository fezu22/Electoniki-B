# Electroniki Backend

Express API and MongoDB data layer for the Electroniki shop-management app.

## Run locally

1. Install Node.js dependencies with `npm install`.
2. Configure `backend/.env` with a valid `MONGODB_URI` and a `JWT_SECRET` of at least 32 characters.
3. Start the API with `npm run dev` (or `npm start`). The default port is `3000`.

Invoice OCR calls the Google Gemini API directly through Google AI Studio. It requires `GEMINI_API_KEY`, tries `GEMINI_MODEL` first, and then tries backup Gemini models. Keep API keys in `backend/.env`; never put them in frontend code or commit them. SMTP variables (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`) enable password-reset emails. Do not commit `.env` or database files.

The backend runs as an API by default. To also serve a built frontend in production, set `FRONTEND_DIST_DIR` to the frontend build directory.

## WhatsApp automations

The long-running backend checks for due installments and low-stock products every five minutes. It sends one installment reminder per opted-in plan each day at 8:00 AM Pakistan time after its due date, until a payment is recorded in Khata, the plan is paid, or reminders are disabled. Low-stock alerts go to the two configured shop recipient numbers once per low-stock period; restocking above the threshold rearms the next alert.

Automated messages use Meta WhatsApp Cloud API. Configure `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, and the Graph API version in the backend environment. Create and get approval for two Utility templates matching these body variables in order:

- `installment_payment_reminder`: `{{1}}` customer, `{{2}}` plan, `{{3}}` monthly amount, `{{4}}` due date, `{{5}}` remaining balance, `{{6}}` shop.
- `low_stock_alert`: `{{1}}` shop, `{{2}}` product, `{{3}}` SKU, `{{4}}` current stock, `{{5}}` reorder threshold.

Set template names and language with the `WHATSAPP_*_TEMPLATE` and `WHATSAPP_TEMPLATE_LANGUAGE` variables. Recipients and shop-level switches are managed in Settings. Each customer must agree before their installment reminders are enabled. The scheduler requires the backend to run as a continuously running service; it does not run in a sleeping/serverless process.

Run the automated backend tests with `npm test`.
