import path from 'path';
import { fileURLToPath } from 'url';
import { createApp } from './web/app.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, '..', 'public');

const PORT = process.env.PORT ?? 3000;
const app = createApp(publicDir);
app.listen(PORT, () => {
  console.log(`\n  SiteRip v3 -> http://localhost:${PORT}\n`);
});
