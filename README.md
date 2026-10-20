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

## Quick start (demo mode)

Requires **Node.js 22.13+** (uses the built-in `node:sqlite`).

```bash
npm install
cp .env.example .env          # then set DEMO_MODE=true
npm run server                # API on http://localhost:4000
npm run dev                   # UI on  http://localhost:5173
```

Demo mode seeds sample content and three accounts (password `demo-password` for all):

| Email | Role |
|-------|------|
| `admin@example.test` | Site admin |
| `orgadmin@example.test` | Org admin |
| `member@example.test` | Member |

Never enable demo mode in production.

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
2. Sign in as a site admin → **Storage** → **Add Google Drive**. Paste the folder link, give it a name, and choose which file types it should accept (e.g. one Drive for video, another for audio + documents).
3. Click **Connect** and sign in with the Google account that owns that folder. A refresh token is stored encrypted with `STORAGE_ENCRYPTION_KEY`.
4. Click **Test** to verify access and read the Drive's quota.

**Routing:** for each upload, the server picks the *active, connected* Drive that accepts the file type and has the most free space (quota is cached for 5 minutes). When a Drive is nearly full, **Pause** it — existing files stay available, new uploads go elsewhere. If no Drive accepts a type, the file is stored locally on the server (`DATA_DIR/files`). Site admins can also choose a specific destination when uploading.

**Workspace Shared Drives** are also supported: set `GOOGLE_APPLICATION_CREDENTIALS` to a service-account key, add the service account as a member of the Shared Drive, and choose *Workspace Shared Drive* when adding storage.

Files are always served through the API after permission checks, so Drive folders do not need to be shared publicly.

## Production

```bash
npm run build
NODE_ENV=production npm start
```

Production requires HTTPS `APP_ORIGIN`, Google OAuth credentials and `SITE_ADMIN_EMAILS`. Run behind a reverse proxy (nginx, Caddy) and back up `DATA_DIR` (SQLite database + local files).

## Tests

```bash
npm test
```

Covers authentication, origin checks, the approval workflow for every role, rejection notes, upload verification, sign-up/sign-in, role changes, suspension rules, org-admin permissions and storage permissions.
