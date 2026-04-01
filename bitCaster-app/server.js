import express from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 8080;
const MINT_URL = process.env.MINT_URL;
const BACKEND_URL = process.env.BACKEND_URL;

if (MINT_URL) {
  app.use(createProxyMiddleware({ target: MINT_URL, changeOrigin: true, pathFilter: '/v1/**' }));
  console.log(`/v1/* -> ${MINT_URL}`);
}

if (BACKEND_URL) {
  app.use(createProxyMiddleware({ target: BACKEND_URL, changeOrigin: true, pathFilter: '/api/**' }));
  app.use(createProxyMiddleware({ target: BACKEND_URL, changeOrigin: true, pathFilter: '/hubs/**', ws: true }));
  console.log(`/api/* -> ${BACKEND_URL}`);
  console.log(`/hubs/* -> ${BACKEND_URL} (ws)`);
}

app.use(express.static(__dirname));
app.get('*', (_req, res) => res.sendFile(join(__dirname, 'index.html')));

app.listen(PORT, () => console.log(`Listening on port ${PORT}`));
