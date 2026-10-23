# Electroniki Backend

Express API and MongoDB data layer for the Electroniki shop-management app.

## Run locally

1. Install Node.js dependencies with `npm install`.
2. Copy `.env.example` to `.env`, then set a valid `MONGODB_URI` and a `JWT_SECRET` of at least 32 characters.
3. Start the API with `npm run dev` (or `npm start`). The default port is `3000`.

`GEMINI_API_KEY` enables invoice OCR. SMTP variables (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`) enable password-reset emails. Do not commit `.env` or database files.

The backend runs as an API by default. To also serve a built frontend in production, set `FRONTEND_DIST_DIR` to the frontend build directory.

Run the automated backend tests with `npm test`.
