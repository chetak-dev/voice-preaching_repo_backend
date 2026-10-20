# Sarvajna — Multi-Google Drive Team Content Hub

A modern, responsive team content-sharing platform for uploading, indexing, previewing, and downloading **Images, Videos, Audios, PDFs/Docs, and Beneficial Team Links** backed by **multiple Google Drive accounts/folders**.

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Start Vite React Frontend (http://localhost:5173)
npm run dev

# 3. Start Multi-Drive Express API Server (http://localhost:4000)
npm run server
```

## Multi-Google Drive Backend Setup
1. Create a Google Cloud Project and enable the **Google Drive API v3**.
2. Create a Service Account (or OAuth2 client) and download `service-account.json`.
3. Share your team folders across your multiple Google Drive accounts with the Service Account email.
4. Copy `.env.example` to `.env` and paste each Google Drive Folder ID.
