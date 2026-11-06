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

## Production

Build the frontend from its sibling folder with `npm run build`, then start the backend with `NODE_ENV=production` and the required environment variables set in the hosting platform. The backend serves `../frontend/dist` in production. The host must run a persistent Node process for scheduled WhatsApp automation. Never put backend secrets in frontend environment variables.

## Commands

- `npm run dev` - start the API with file watching
- `npm start` - start the API normally
- `npm test` - run backend unit and API integration checks
