import 'dotenv/config';
import { createApp } from './app.js';

const app = createApp();
const port = Number(process.env.PORT || 4000);
const host = process.env.HOST || '127.0.0.1';
app.locals.ready.then(() => {
  app.listen(port, host, () => {
    console.log(`VOICE API: http://localhost:${port}`);
    const { databaseUrl, dataDir } = app.locals.config;
    console.log(`Database: ${databaseUrl ? databaseUrl.replace(/\?.*$/, '') : dataDir}`);
  });
}, () => process.exit(1));
