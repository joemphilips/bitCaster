// Production server for Azure App Service.
// Mirrors Vite dev proxy (vite.config.ts) so frontend code uses relative URLs everywhere.
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

const proxyErrorHandler = (err, _req, res) => {
  console.error('Proxy error:', err.message);
  if (!res.headersSent) res.status(502).json({ error: 'Bad Gateway' });
};

if (MINT_URL) {
  app.use(createProxyMiddleware({
    target: MINT_URL, changeOrigin: true, pathFilter: '/v1/**',
    on: { error: proxyErrorHandler },
  }));
  console.log(`/v1/* -> ${MINT_URL}`);
}

let hubsProxy;
if (BACKEND_URL) {
  app.use(createProxyMiddleware({
    target: BACKEND_URL, changeOrigin: true, pathFilter: '/api/**',
    on: { error: proxyErrorHandler },
  }));
  hubsProxy = createProxyMiddleware({
    target: BACKEND_URL, changeOrigin: true, pathFilter: '/hubs/**', ws: true,
    on: { error: proxyErrorHandler },
  });
  app.use(hubsProxy);
  console.log(`/api/* -> ${BACKEND_URL}`);
  console.log(`/hubs/* -> ${BACKEND_URL} (ws)`);
}

// Block server-side files from being served as static assets
app.use(['/server.js', '/package.json', '/package-lock.json'], (_req, res) => res.status(404).end());
app.use(express.static(__dirname));
app.get('*', (_req, res) => res.sendFile(join(__dirname, 'index.html')));

const server = app.listen(PORT, () => console.log(`Listening on port ${PORT}`));
if (hubsProxy) server.on('upgrade', hubsProxy.upgrade);
