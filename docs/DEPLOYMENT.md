# ChurchMouse Music — Deployment Guide
## Cloudflare Free Tier — churchmouse.co.za

---

## Architecture Overview

```
churchmouse.co.za          → Cloudflare Pages (static frontend)
churchmouse.co.za/api/*    → Cloudflare Workers (API)
R2 Bucket                  → PDF file storage (10 GB free)
D1 Database                → SQLite metadata + users
MailChannels               → Transactional email (free via Workers)
```

---

## Prerequisites

1. **Node.js 18+** installed locally
2. **Cloudflare account** (free) — https://dash.cloudflare.com
3. **Domain churchmouse.co.za** — point nameservers to Cloudflare (in GoDaddy)
4. **Wrangler CLI**: `npm install -g wrangler`

---

## Step 1 — Point GoDaddy domain to Cloudflare

1. Log into GoDaddy → My Products → DNS → Manage DNS
2. Change nameservers to the two Cloudflare nameservers shown in your CF dashboard
3. In Cloudflare dashboard → Add a Site → enter `churchmouse.co.za`
4. Choose **Free** plan
5. Wait for DNS propagation (minutes to hours)

---

## Step 2 — Authenticate Wrangler

```bash
cd /path/to/churchmouse
npm install
npx wrangler login
```

This opens a browser to authorise Wrangler with your Cloudflare account.

---

## Step 3 — Create D1 Database

```bash
npx wrangler d1 create churchmouse-db
```

Copy the `database_id` from the output and paste it into `wrangler.toml`:
```toml
database_id = "REPLACE_WITH_YOUR_D1_DATABASE_ID"
```

### Apply the schema:
```bash
# Remote (production)
npx wrangler d1 execute churchmouse-db --file=schema.sql

# Local dev
npx wrangler d1 execute churchmouse-db --local --file=schema.sql
```

---

## Step 4 — Create R2 Bucket

```bash
npx wrangler r2 bucket create churchmouse-pdfs
```

---

## Step 5 — Set Secrets

```bash
# Generate a strong random JWT secret (keep this safe!)
npx wrangler secret put JWT_SECRET
# Paste a long random string e.g.: openssl rand -base64 48

npx wrangler secret put EMAIL_FROM
# Value: noreply@churchmouse.co.za
```

For MailChannels email to work, you'll need to add a DNS TXT record.
See: https://support.mailchannels.net/hc/en-us/articles/16918954360845

---

## Step 6 — Seed the Admin Password

The schema seeds an admin user but with a placeholder hash.
Run this to generate a real PBKDF2 hash and insert it:

```bash
# Open D1 console
npx wrangler d1 execute churchmouse-db --command="
  UPDATE users
  SET password_hash = 'REPLACE_WITH_HASH'
  WHERE email = 'admin@churchmouse.co.za';
"
```

**Easier approach**: deploy first, then use the API directly:

```bash
# After deploying, hit the forgot-password endpoint to reset the admin password
curl -X POST https://churchmouse.co.za/api/auth/forgot-password \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@churchmouse.co.za"}'
```

Or just set a new password directly via SQL (the hash in schema.sql is a placeholder —
use the Workers PBKDF2 implementation by calling the API).

**Simplest**: After first deploy, use the /api/auth/change-password endpoint with curl.

---

## Step 7 — Deploy the Worker API

```bash
npx wrangler deploy
```

This deploys the Worker and binds D1 + R2.

### Add the route in Cloudflare dashboard:
1. Workers & Pages → your Worker → Triggers → Add route
2. Route: `churchmouse.co.za/api/*`
3. Zone: `churchmouse.co.za`

---

## Step 8 — Deploy the Frontend (Cloudflare Pages)

```bash
npx wrangler pages deploy frontend/ --project-name=churchmouse-music
```

On first run it creates the Pages project. Subsequent deploys use the same command.

### Custom domain for Pages:
1. Cloudflare Dashboard → Pages → churchmouse-music → Custom domains
2. Add `churchmouse.co.za`
3. Cloudflare will handle the DNS record automatically

---

## Step 9 — Verify

1. Visit https://churchmouse.co.za — you should see the login screen
2. Login with `admin@churchmouse.co.za` and the password you set
3. Create a test user, upload a PDF, run a search

---

## Local Development

```bash
# Terminal 1: run Worker locally
npx wrangler dev --local

# Terminal 2: serve frontend
cd frontend && npx serve .
```

The Worker runs on `http://localhost:8787`.
Change `const API = '/api'` in index.html to `const API = 'http://localhost:8787/api'` for local dev.

---

## Free Tier Limits (as of 2024)

| Service          | Free Allowance                    | Your likely usage |
|------------------|-----------------------------------|-------------------|
| Workers          | 100,000 req/day                   | Low (hobby)       |
| D1               | 5M rows read/day, 5GB storage     | Comfortable       |
| R2               | 10GB storage, 1M Class A ops/mo   | Good for PDFs     |
| Pages            | Unlimited static requests         | ✓                 |

---

## File Structure

```
churchmouse/
├── wrangler.toml              # Cloudflare config
├── package.json
├── schema.sql                 # D1 database schema + seed
├── frontend/
│   ├── index.html             # Single-page app (entire UI)
│   └── _redirects             # SPA routing
└── workers/
    └── src/
        ├── index.js           # Router entry point
        ├── lib/
        │   └── utils.js       # JWT, password, email helpers
        └── routes/
            ├── auth.js        # Login, password reset
            ├── users.js       # Admin user management
            ├── master.js      # Music master CRUD
            ├── pdf.js         # PDF upload/serve/delete
            ├── search.js      # FTS5 search
            └── playlists.js   # Playlist CRUD + items
```

---

## Default Admin Account

Email: `admin@churchmouse.co.za`
Password: (set via reset flow on first deploy)

**Change this immediately after first login.**

---

## Roles Summary

| Action                        | Reader | Content Manager | Admin |
|-------------------------------|--------|-----------------|-------|
| Search & view PDFs            | ✓      | ✓               | ✓     |
| Download PDFs                 | ✓      | ✓               | ✓     |
| Create/manage own playlists   | ✓      | ✓               | ✓     |
| Make playlists public         | ✗      | ✓               | ✓     |
| Upload PDFs                   | ✗      | ✓               | ✓     |
| Manage master records         | ✗      | ✓               | ✓     |
| Manage users                  | ✗      | ✗               | ✓     |
