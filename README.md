# ElectroHub Backend

Express API and MongoDB data layer for the ElectroHub shop-management app. The frontend and backend are published as separate GitHub repositories and must sit beside each other in folders named `frontend` and `backend`.

## Local setup on Windows

Install Node.js 22.12 or newer, then clone both repositories into the same parent folder:

```cmd
mkdir ElectroHub
cd ElectroHub
git clone https://github.com/fezu22/Electoniki-F.git frontend
git clone https://github.com/fezu22/Electoniki-B.git backend
```

Create the private backend environment file and install dependencies:

```cmd
copy backend\.env.example backend\.env
cd backend
npm install
notepad .env
```

Edit `backend\.env` and set:

- `MONGODB_URI`: a MongoDB database URI that this computer can access. Use a separate database and credentials for your own installation.
- `JWT_SECRET`: generate a unique secret with `node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"` and paste the output here.
- `SUPER_ADMIN_NAME`, `SUPER_ADMIN_EMAIL`, and `SUPER_ADMIN_PASSWORD`: set all three before the first start on a new database. The password must be at least 12 characters. This creates the first Super Admin so they can sign in and create the shop and owner account.

Do not copy someone else's real `.env` or commit your `.env` to GitHub. `.env` is ignored by Git; `.env.example` contains names and blank placeholders only. Keep public shop registration disabled.

Start the API in this terminal:

```cmd
npm run dev
```

Open a second Command Prompt in the sibling `frontend` folder and run:

```cmd
npm install
npm run dev
```

Open <http://localhost:5173>. The Vite dev server forwards `/api` requests to the backend port from `backend/.env` (3000 by default). Keep both terminals running while using the local app. If port 3000 is changed, the proxy reads the new `PORT` value from `backend/.env` after restarting the frontend.

## Environment variables and optional integrations

`server/index.js` loads `backend/.env` through `dotenv/config`. MongoDB URI and JWT secret are required. Gemini invoice OCR, SMTP password-reset email, and WhatsApp Cloud API credentials are optional; without Gemini, supplier invoice details can be entered manually. WhatsApp automation also needs approved Meta message templates and recipients configured in the shop settings. See `.env.example` for every supported environment variable.

### QR-linked WhatsApp invoice PDFs (optional)

Invoice PDFs can be sent as actual PDF documents through a Shop Owner's linked WhatsApp account. This is separate from the official Meta Cloud API used for installment reminders and low-stock alerts.

1. In `backend/.env`, set `WHATSAPP_WEB_ENABLED=true` and choose `WHATSAPP_WEB_DATA_PATH`. The default is `./.wwebjs_auth` relative to the backend working directory.
2. Install Chrome or Chromium on the host. Puppeteer's bundled browser may be installed by `npm install`; on Linux, install Chromium's runtime libraries as required by Puppeteer. If using system Chrome/Chromium, set `WHATSAPP_WEB_BROWSER_PATH` to its executable path.
3. Give the backend a persistent, private writable disk/volume mounted at the session path. The `LocalAuth` directories contain account credentials and must never be copied to the frontend, served over HTTP, committed to Git, or shared. Do not run multiple backend workers against the same WhatsApp session directory.
4. Sign in as the Shop Owner, open Settings → WhatsApp Invoice Connection, select **Link WhatsApp**, and scan the displayed QR in WhatsApp → Linked devices → Link a device. The server stores a separate `LocalAuth` session for each shop and attempts to restore saved sessions at startup.
5. Keep the backend process and persistent volume running. Disconnect from the same owner-only Settings section to log out and remove that shop's saved local session.

This integration uses the unofficial `whatsapp-web.js` client and WhatsApp Web automation. It is not affiliated with or endorsed by WhatsApp, can stop working when WhatsApp changes, and may result in account restrictions. Use it only if those limitations are acceptable; the Meta Cloud API automation remains available independently. A successful send is reported only after the WhatsApp client accepts the document. The recipient is checked against the invoice stored in the active shop. See the [whatsapp-web.js project disclaimer](https://github.com/wwebjs/whatsapp-web.js#disclaimer) and its [LocalAuth persistence documentation](https://wwebjs.dev/guide/creating-your-bot/authentication.html).

## Production

Build the frontend from its sibling folder with `npm run build`, then start the backend with `NODE_ENV=production` and the required environment variables set in the hosting platform. The backend serves `../frontend/dist` in production. The host must run a persistent Node process for scheduled WhatsApp automation. Never put backend secrets in frontend environment variables.

## Commands

- `npm run dev` - start the API with file watching
- `npm start` - start the API normally
- `npm test` - run backend unit and API integration checks
