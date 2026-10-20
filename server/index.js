import 'dotenv/config';
import { createApp } from './app.js';

const app = createApp();
const port = Number(process.env.PORT || 4000);
const host = process.env.HOST || '127.0.0.1';
app.listen(port, host, () => {
  console.log(`VOICE API: http://localhost:${port}`);
  console.log(`Storage and database: ${app.locals.config.dataDir}`);
  if (app.locals.config.demo) console.warn('DEMO MODE: sample accounts enabled. Never expose this mode publicly.');
});
