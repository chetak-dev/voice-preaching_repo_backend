# Kalpa Taru

A professional content-sharing platform for communities. Members contribute **images, video, audio, documents and links**; every contribution is reviewed by an **admin** before it is published. On phones it looks and feels like an Android app (bottom navigation, floating upload button, bottom sheets) and can be installed to the home screen. Files are stored across **multiple Google Drives** with automatic routing.

## Features

- **Roles**
  | Role | Can do |
  |------|--------|
  | **Site admin** | Approve/reject all submissions, appoint or remove **org admins**, suspend/reactivate accounts, remove content (only site admins can, and must give a reason and type REMOVE to confirm), manage Google Drive storage, view the activity log |
  | **Org admin** | Approve or reject submissions (except their own), plus everything a member can do. Nothing else. |
  | **Member** | Browse the library, save items, contribute content, track their submissions |
- **Approval workflow** — uploads from members start as *Pending* and only appear in the library once a site admin or org admin approves them. Uploads from site admins and org admins are published immediately. Rejections require a note, which the contributor sees under **My submissions**.
- **Thumbnails and preview** — the browser generates a thumbnail for every file it uploads: image, video frame, PDF first page, audio cover art, Office document or text. Thumbnails are stored in the database. Items uploaded before this feature get thumbnails when an admin or the uploader opens the library. Opening an item shows its full content before download: every PDF page, Word text, PowerPoint slides, Excel sheets, text files, and playable video, audio and YouTube links. Files over 50MB (except PDFs and media, which stream) must be downloaded to read.
- **Overview** (admins only) — storage use and totals by content type. Members never see storage figures.
- **Adding to an upload** — open any item and choose **Add files** to attach more files or links to it. Contributors can add to their own upload while it is pending or approved; anyone can add to an approved upload. Each addition is reviewed separately, earns its contributor points once approved, and is removed if the upload is deleted. Rejecting an upload also rejects its pending additions.
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

1. In Google Cloud Console create a project, enable the **Google Drive API**, and configure the OAuth consent screen:
   - User type **External**; add the app name, support email and the Privacy (`<APP_ORIGIN>/#/privacy`) and Terms (`<APP_ORIGIN>/#/terms`) links. Skip the logo (a logo triggers a brand review).
   - Scopes: `openid`, `email`, `profile` and `.../auth/drive.file`. All are non-sensitive, so **no Google verification is needed**.
   - Click **Publish app** so the status is *In production* (in *Testing*, Drive connections expire after 7 days).
2. Create an **OAuth client ID** (Web application) with redirect URI `<APP_ORIGIN>/api/auth/google/callback`.
3. Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `APP_ORIGIN` and `SITE_ADMIN_EMAILS` in `.env`.

Everyone uses the same sign-in page; what they see depends on their role.

- **Sign up** with name, email and password (8+ characters), or **Continue with Google**. New accounts are members.
- Emails in `SITE_ADMIN_EMAILS` become site admins, but only through verified Google sign-in (password sign-up is refused for these addresses).
- Site admins promote members to org admin from **Members**.
- If someone signs in with Google using an email that already has a password account, the accounts are linked and the old password is removed, so nobody can pre-register someone else's address.
- Suspended accounts are signed out immediately and cannot sign in.

## Using multiple Google Drives

Each free Google account offers 15 GB. The platform treats every connected Drive as a **storage destination** and spreads uploads across them. Use one Google account per Drive (ideally accounts created just for Kalpa Taru storage).

1. Sign in as a site admin → **Storage** → **Add Google Drive**, give it a name and keep *Personal Google account*. Every Drive accepts all file types. (You can register Drives before the Google settings below are configured; they show *Needs connection* until then.)
2. Click **Connect** and sign in with the Google account for that Drive. Kalpa Taru creates a **Kalpa Taru Media** folder in it (or reuses its existing one, including a **VOICE Media** folder from before the rename) and stores a refresh token encrypted with `STORAGE_ENCRYPTION_KEY`. Inside that folder, uploads are sorted automatically into **Images**, **Videos**, **Audios** and **Documents** subfolders, which are created the first time a file of that type is uploaded. Links are not files, so they are kept in the database only.
3. Click **Test** to verify access and read the Drive's quota.

**Limited access:** personal Drives use Google's `drive.file` permission, so Kalpa Taru can only see and manage the files it uploads, never anything else in the account. This is why no Google app verification is required. Files you add to the folder by hand are not visible to Kalpa Taru. If a connection is ever lost, click **Reconnect** with the same Google account; Kalpa Taru regains access to all of its files.

**Routing:** for each upload, the server picks the *active, connected* Drive with the most free space (quota is cached for 5 minutes). When a Drive is nearly full, **Pause** it — existing files stay available, new uploads go elsewhere. If no Drive is connected, the file is stored locally on the server (`DATA_DIR/files`) — except on Vercel, where a connected Drive is required. Site admins can also choose a specific destination when uploading.

**Large files:** the browser sends files in 4 MB chunks, which the server streams straight into Google Drive's resumable upload. This keeps every request within serverless limits, so there is no file size limit (only the free space on your Drives).

**Background uploads:** uploads run in the background, so people can keep browsing while a progress tray shows status. Files waiting to upload are kept in the browser's storage on the device. If the tab is closed, the phone suspends it, or the connection drops, the upload continues from the last finished chunk when Kalpa Taru is opened again (within 24 hours) or the connection returns. Signing out cancels pending uploads and removes those saved files from the device.

**Workspace Shared Drives** are also supported: set `GOOGLE_APPLICATION_CREDENTIALS` to a service-account key file (or paste the key JSON into `GOOGLE_SERVICE_ACCOUNT_JSON`), add the service account as a member of the Shared Drive, and choose *Workspace Shared Drive* (with the Shared Drive folder link) when adding storage.

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
   Description=Kalpa Taru
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
