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

app.disable('x-powered-by');

// Security headers
app.use((_req, res, next) => {
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

const proxyErrorHandler = (err, _req, res) => {
  console.error('Proxy error:', err.message);
  if (!res.headersSent) res.status(502).json({ error: 'Bad Gateway' });
};

const firstHeaderValue = (value) => {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw?.split(',')[0]?.trim();
};

const isAzurePublicHost = (host) => host?.endsWith('.azurewebsites.net');

const browserFacingProto = (req, host) => {
  const forwardedProto = firstHeaderValue(req.headers['x-forwarded-proto']);
  if (forwardedProto === 'wss') return 'https';
  if (forwardedProto === 'ws') {
    return req.headers['x-arr-ssl'] || isAzurePublicHost(host) ? 'https' : 'http';
  }
  if (forwardedProto) return forwardedProto;
  if (req.headers['x-arr-ssl'] || isAzurePublicHost(host)) return 'https';
  return req.socket.encrypted ? 'https' : 'http';
};

const setBrowserForwardedHeaders = (proxyReq, req) => {
  // Use the frontend request Host, not a client-supplied X-Forwarded-Host.
  // NIP-98 URL binding should reflect the origin the browser actually opened.
  const host = firstHeaderValue(req.headers.host);
  if (host) proxyReq.setHeader('x-forwarded-host', host);
  proxyReq.setHeader('x-forwarded-proto', browserFacingProto(req, host));
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
  // xfwd:true sets X-Forwarded-{For,Port,Proto,Host} on the upstream request.
  // The matching engine signs/verifies NIP-98 against the user-facing URL
  // (browser origin); without X-Forwarded-Host the engine reconstructs the URL
  // from its own Host header (which changeOrigin:true rewrites to the backend
  // hostname) and rejects every body-bearing request as "Invalid NIP-98 event".
  app.use(createProxyMiddleware({
    target: BACKEND_URL, changeOrigin: true, xfwd: true, pathFilter: '/api/**',
    on: { error: proxyErrorHandler },
  }));
  // Wallet-service callbacks use the same frontend-to-backend private path as
  // browser API calls. The backend still authenticates /internal/** with the
  // WalletService Entra-MI bearer scheme; this proxy is transport reachability,
  // not authorization.
  app.use(createProxyMiddleware({
    target: BACKEND_URL, changeOrigin: true, xfwd: true, pathFilter: '/internal/**',
    on: { error: proxyErrorHandler },
  }));
  hubsProxy = createProxyMiddleware({
    target: BACKEND_URL, changeOrigin: true, xfwd: true, pathFilter: '/hubs/**', ws: true,
    on: {
      proxyReqWs: setBrowserForwardedHeaders,
      error: proxyErrorHandler,
    },
  });
  app.use(hubsProxy);
  console.log(`/api/* -> ${BACKEND_URL}`);
  console.log(`/internal/* -> ${BACKEND_URL}`);
  console.log(`/hubs/* -> ${BACKEND_URL} (ws)`);
}

// Block server-side files from being served as static assets
app.use(['/server.js', '/package.json', '/package-lock.json'], (_req, res) => res.status(404).end());
app.use(express.static(__dirname));
app.get('*', (_req, res) => res.sendFile(join(__dirname, 'index.html')));

const server = app.listen(PORT, () => console.log(`Listening on port ${PORT}`));
if (hubsProxy) server.on('upgrade', hubsProxy.upgrade);
