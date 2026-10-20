# VOICE — Moderated Content Hub

A professional content-sharing platform for communities. Members contribute **images, video, audio, documents and links**; every contribution is reviewed by an **admin** before it is published. On phones it looks and feels like an Android app (bottom navigation, floating upload button, bottom sheets) and can be installed to the home screen. Files are stored across **multiple Google Drives** with automatic routing.

## Features

- **Roles**
  | Role | Can do |
  |------|--------|
  | **Site admin** | Approve/reject all submissions, appoint or remove **org admins**, suspend/reactivate accounts, remove content, manage Google Drive storage, view the activity log |
  | **Org admin** | Approve or reject submissions (except their own), plus everything a member can do. Nothing else. |
  | **Member** | Browse the library, save items, contribute content, track their submissions |
- **Approval workflow** — every upload (including from org admins and site admins) starts as *Pending* and only appears in the library once a site admin or org admin approves it. Org admins cannot approve their own submissions. Rejections require a note, which the contributor sees under **My submissions**.
- **Multi-Google-Drive storage** — connect as many Drives as you need; uploads are routed automatically (see below).
- Sign up / sign in with email + password or Google (one sign-in page for every role), scrypt-hashed passwords, file signature verification, rate limiting, CSRF origin checks, encrypted refresh tokens, audit log.

## Quick start (local)

Requires **Node.js 20+**. Locally the database is a SQLite file in `DATA_DIR`; set `TURSO_DATABASE_URL` to use a hosted Turso database instead.

```bash
npm install
cp .env.example .env          # fill in the values (see below)
npm run server                # API on http://localhost:4000
npm run dev                   # UI on  http://localhost:5173
```

The site starts empty. To create the first site admin, either list your email in `SITE_ADMIN_EMAILS` and use **Continue with Google**, or sign up with email + password and then run:

```bash
npm run make-admin -- you@example.com
```

> Behind a corporate TLS proxy, if `npm install` fails with `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`, set `NODE_USE_SYSTEM_CA=1` so Node trusts the operating system's certificate store.

## Google sign-in

1. In Google Cloud Console create a project, enable the **Google Drive API**, and configure the OAuth consent screen.
2. Create an **OAuth client ID** (Web application) with redirect URI `<APP_ORIGIN>/api/auth/google/callback`.
3. Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `APP_ORIGIN` and `SITE_ADMIN_EMAILS` in `.env`.

Everyone uses the same sign-in page; what they see depends on their role.

- **Sign up** with name, email and password (8+ characters), or **Continue with Google**. New accounts are members.
- Emails in `SITE_ADMIN_EMAILS` become site admins, but only through verified Google sign-in (password sign-up is refused for these addresses).
- Site admins promote members to org admin from **Members**.
- If someone signs in with Google using an email that already has a password account, the accounts are linked and the old password is removed, so nobody can pre-register someone else's address.
- Suspended accounts are signed out immediately and cannot sign in.

## Using multiple Google Drives

Each free Google account offers 15 GB. The platform treats every Drive folder as a **storage destination** and spreads uploads across them.

1. In each Google account, create a folder (e.g. `VOICE Media`).
2. Sign in as a site admin → **Storage** → **Add Google Drive**. Paste the folder link and give it a name. Every Drive accepts all file types. (You can register Drives before the Google settings below are configured; they show *Needs connection* until then.)
3. Click **Connect** and sign in with the Google account that owns that folder. A refresh token is stored encrypted with `STORAGE_ENCRYPTION_KEY`.
4. Click **Test** to verify access and read the Drive's quota.

**Routing:** for each upload, the server picks the *active, connected* Drive with the most free space (quota is cached for 5 minutes). When a Drive is nearly full, **Pause** it — existing files stay available, new uploads go elsewhere. If no Drive is connected, the file is stored locally on the server (`DATA_DIR/files`) — except on Vercel, where a connected Drive is required. Site admins can also choose a specific destination when uploading.

**Large files:** the browser sends files in 4 MB chunks, which the server streams straight into Google Drive's resumable upload. This keeps every request within serverless limits, so `MAX_UPLOAD_MB` can be raised (up to 5120).

**Workspace Shared Drives** are also supported: set `GOOGLE_APPLICATION_CREDENTIALS` to a service-account key file (or paste the key JSON into `GOOGLE_SERVICE_ACCOUNT_JSON`), add the service account as a member of the Shared Drive, and choose *Workspace Shared Drive* when adding storage.

Files are always served through the API after permission checks, so Drive folders do not need to be shared publicly.

## Production

```bash
npm run build
NODE_ENV=production npm start
```

Production requires HTTPS `APP_ORIGIN`, Google OAuth credentials and `SITE_ADMIN_EMAILS`. Run behind a reverse proxy (nginx, Caddy) and back up `DATA_DIR` (SQLite database + local files).

## Deploy to Vercel (free)

Vercel hosts the website and runs the API as a serverless function (`api/index.js`, configured in `vercel.json`). Serverless functions have no permanent disk, so the database lives in **Turso** (free hosted SQLite) and files live in your **Google Drives**.

1. **Create the database (Turso, free).** Sign up at [turso.tech](https://turso.tech) → **Create Database** (e.g. `voice`, region closest to your users). Copy its URL (`libsql://voice-<you>.turso.io`) and click **Create Token** (read & write) to get an auth token.
2. **Google Cloud.** Follow *Google sign-in* above. In your OAuth client add:
   - Authorized JavaScript origin: `https://<project>.vercel.app`
   - Authorized redirect URI: `https://<project>.vercel.app/api/auth/google/callback`
3. **Import the project.** At [vercel.com/new](https://vercel.com/new), sign in with GitHub, import this repository and keep the detected settings (framework **Vite**, output `dist`).
4. **Environment variables** (Project → Settings → Environment Variables), before the first deploy:
   | Name | Value |
   |------|-------|
   | `TURSO_DATABASE_URL` | the `libsql://…` URL |
   | `TURSO_AUTH_TOKEN` | the Turso token |
   | `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | from Google Cloud |
   | `SITE_ADMIN_EMAILS` | your Gmail address(es), comma-separated |
   | `STORAGE_ENCRYPTION_KEY` | 64 hex chars (`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`) |
   | `APP_ORIGIN` | `https://<project>.vercel.app` (or your custom domain) |
   | `GOOGLE_SERVICE_ACCOUNT_JSON` | *optional*, the full key JSON for Shared Drives |
   | `MAX_UPLOAD_MB` | *optional*, default 100 |

   Do **not** set `NODE_ENV` — Vercel needs the build tools, and the app already runs in production mode on Vercel.
5. **Deploy.** Open the site and **Continue with Google** with an address from `SITE_ADMIN_EMAILS`; you become site admin.
6. **Connect storage.** Storage → **Add Google Drive** → **Connect** → **Test**. File uploads are refused until at least one Drive is connected.

Every `git push` to `main` redeploys automatically. Sign-in only works on the `APP_ORIGIN` URL (preview URLs are rejected by the origin check). To promote a password account to site admin, put the Turso variables in your local `.env` and run `npm run make-admin -- email@example.com`.

**Free-plan notes:** Vercel's Hobby plan is for personal, non-commercial use. Videos and downloads stream through the API function, which counts towards Hobby bandwidth and function-time allowances; media responses are sent in 4 MB ranges.

### Alternative: Oracle Cloud Always Free VM

1. Create an Oracle Cloud account and launch an **Always Free** Ubuntu 24.04 VM (Ampere A1 or E2.1.Micro). In the VM's subnet security list, allow inbound TCP **80** and **443**.
2. Point a domain at the VM's public IP (any domain, or a free subdomain from e.g. DuckDNS).
3. On the VM:
   ```bash
   sudo apt update && sudo apt install -y git caddy
   curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs
   sudo iptables -I INPUT -p tcp --dport 80 -j ACCEPT && sudo iptables -I INPUT -p tcp --dport 443 -j ACCEPT
   sudo netfilter-persistent save
   git clone https://github.com/chetak-dev/voice-preaching_repo_backend.git voice && cd voice
   npm ci && npm run build
   cp .env.example .env && nano .env   # NODE_ENV=production, APP_ORIGIN=https://your-domain, Google keys, etc.
   ```
4. Caddy gives you free automatic HTTPS. Put this in `/etc/caddy/Caddyfile` and run `sudo systemctl reload caddy`:
   ```
   your-domain.com {
     reverse_proxy 127.0.0.1:4000
   }
   ```
5. Keep the app running with systemd: create `/etc/systemd/system/voice.service`:
   ```ini
   [Unit]
   Description=VOICE
   After=network.target

   [Service]
   WorkingDirectory=/home/ubuntu/voice
   ExecStart=/usr/bin/node server/index.js
   Restart=always
   User=ubuntu

   [Install]
   WantedBy=multi-user.target
   ```
   then `sudo systemctl enable --now voice`.
6. In Google Cloud Console add `https://your-domain.com` as an authorized JavaScript origin and `https://your-domain.com/api/auth/google/callback` as a redirect URI.

To update later: `git pull && npm ci && npm run build && sudo systemctl restart voice`.

## Tests

```bash
npm test
```

Covers authentication, origin checks, the approval workflow for every role, rejection notes, upload verification, sign-up/sign-in, role changes, suspension rules, org-admin permissions and storage permissions.
