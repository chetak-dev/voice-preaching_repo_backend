import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { google } from 'googleapis';
import stream from 'stream';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const upload = multer({ storage: multer.memoryStorage() });
app.use(cors());
app.use(express.json());

// Configure Google Drive API v3 Auth
const auth = new google.auth.GoogleAuth({
  keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS || './server/service-account.json',
  scopes: ['https://www.googleapis.com/auth/drive']
});
const drive = google.drive({ version: 'v3', auth });

// Multi-Google Drive Node Registry
const DRIVE_NODES = {
  'drive-1': {
    id: 'drive-1',
    name: 'Drive Node #1 • High-Res Media Vault',
    folderId: process.env.DRIVE_NODE_1_MEDIA_FOLDER_ID || '1A9x_MediaVault_992kLpQ',
    types: ['image', 'video']
  },
  'drive-2': {
    id: 'drive-2',
    name: 'Drive Node #2 • Scriptures & Docs Archive',
    folderId: process.env.DRIVE_NODE_2_DOCS_FOLDER_ID || '1B7y_DocsArchive_441mNzR',
    types: ['doc']
  },
  'drive-3': {
    id: 'drive-3',
    name: 'Drive Node #3 • Audio & Lecture Streams',
    folderId: process.env.DRIVE_NODE_3_AUDIO_FOLDER_ID || '1C4z_AudioStreams_883vBxW',
    types: ['audio']
  },
  'drive-4': {
    id: 'drive-4',
    name: 'Drive Node #4 • Team Enterprise Workspace',
    folderId: process.env.DRIVE_NODE_4_ENTERPRISE_FOLDER_ID || '0AD9_EnterprisePool_001xYz',
    types: ['link', 'video', 'image']
  }
};

// 1. Fetch files across all connected Google Drive folders
app.get('/api/files', async (req, res) => {
  try {
    const allResults = [];
    for (const node of Object.values(DRIVE_NODES)) {
      const response = await drive.files.list({
        q: `'${node.folderId}' in parents and trashed = false`,
        fields: 'files(id, name, mimeType, size, thumbnailLink, webViewLink, webContentLink, createdTime, description)'
      });
      const mapped = (response.data.files || []).map((f) => ({
        ...f,
        driveNodeId: node.id,
        driveNodeName: node.name
      }));
      allResults.push(...mapped);
    }
    res.json({ ok: true, files: allResults });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 2. Upload file and auto-route to the optimal Google Drive folder
app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    const { targetDriveId = 'drive-1', description = '' } = req.body;
    const node = DRIVE_NODES[targetDriveId] || DRIVE_NODES['drive-1'];

    const bufferStream = new stream.PassThrough();
    bufferStream.end(req.file.buffer);

    const created = await drive.files.create({
      requestBody: {
        name: req.file.originalname,
        description,
        parents: [node.folderId]
      },
      media: {
        mimeType: req.file.mimetype,
        body: bufferStream
      },
      fields: 'id, name, webViewLink, webContentLink, size'
    });

    res.json({ ok: true, driveNode: node.name, file: created.data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Sarvajna Multi-Drive Backend running on http://localhost:${PORT}`);
});
