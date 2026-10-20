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

Requires **Node.js 22.13+** (uses the built-in `node:sqlite`).

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

**Routing:** for each upload, the server picks the *active, connected* Drive with the most free space (quota is cached for 5 minutes). When a Drive is nearly full, **Pause** it — existing files stay available, new uploads go elsewhere. If no Drive is connected, the file is stored locally on the server (`DATA_DIR/files`). Site admins can also choose a specific destination when uploading.

**Workspace Shared Drives** are also supported: set `GOOGLE_APPLICATION_CREDENTIALS` to a service-account key, add the service account as a member of the Shared Drive, and choose *Workspace Shared Drive* when adding storage.

Files are always served through the API after permission checks, so Drive folders do not need to be shared publicly.

## Production

```bash
npm run build
NODE_ENV=production npm start
```

Production requires HTTPS `APP_ORIGIN`, Google OAuth credentials and `SITE_ADMIN_EMAILS`. Run behind a reverse proxy (nginx, Caddy) and back up `DATA_DIR` (SQLite database + local files).

### Free hosting: Oracle Cloud Always Free (recommended)

The app needs a persistent disk for its SQLite database, so a small always-on VM is the best free option (Render/Vercel free tiers wipe the disk on restart).

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
