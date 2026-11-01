// Production server for Azure App Service.
// Mirrors Vite dev proxy (vite.config.ts) so frontend code uses relative URLs everywhere.
import { captureDeploymentIdentity, deploymentIdentityHandler } from "./deployment-identity.js";
import compression from "compression";
import express from "express";
import { createProxyMiddleware } from "http-proxy-middleware";
import { isIP } from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const identity = captureDeploymentIdentity(__dirname);
const app = express();
const PORT = process.env.PORT || 8080;
const MINT_URL = process.env.MINT_URL;
const BACKEND_URL = process.env.BACKEND_URL;

app.disable("x-powered-by");
app.use(compression());

// Security headers
app.use((_req, res, next) => {
  res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  next();
});

// Only this server sets the client-address header, and only on a request to the backend
// (/api and /hubs), so that the backend can apply its request limits per client. Other
// requests, such as those to the mint, have no client-address header. The hosting front
// end appends the address of its own peer to X-Forwarded-For. Thus only the rightmost
// element is trustworthy: a browser controls every element to its left. Without a valid
// rightmost element, the backend request has no client-address header.
const CLIENT_ADDRESS_HEADER = "x-bitcaster-client-ip";

// "203.0.113.7:5678" and "[2001:db8::1]:5678" carry a port. Returns [address, IP family].
const withoutPort = (element) => {
  const bracketed = /^\[([^\]]*)\](?::\d{1,5})?$/.exec(element);
  if (bracketed) return [bracketed[1], 6];
  const ipv4 = /^([^:]*):\d{1,5}$/.exec(element);
  if (ipv4) return [ipv4[1], 4];
  return [element, isIP(element)];
};

/** Returns the plain address in the rightmost X-Forwarded-For element, or undefined. */
export const clientAddressFromForwardedFor = (forwardedFor) => {
  const [address, family] = withoutPort((forwardedFor ?? "").split(",").at(-1).trim());
  // A zone index ("fe80::1%eth0") names a front-end interface, not a client.
  return family !== 0 && isIP(address) === family && !address.includes("%") ? address : undefined;
};

const proxyErrorHandler = (err, _req, res) => {
  console.error("Proxy error:", err.message);
  if (!res.headersSent) res.status(502).json({ error: "Bad Gateway" });
};

const firstHeaderValue = (value) => {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw?.split(",")[0]?.trim();
};

const isAzurePublicHost = (host) => host?.endsWith(".azurewebsites.net");

const lastHeaderValue = (value) => {
  const raw = Array.isArray(value) ? value.at(-1) : value;
  return raw?.split(",").at(-1)?.trim().toLowerCase();
};
const forwardedProtos = new Set(["http", "https", "ws", "wss"]);
const browserFacingProto = (req, host) => {
  // The platform front end sets or appends the rightmost element.
  const rightmost = lastHeaderValue(req.headers["x-forwarded-proto"]);
  const forwardedProto = forwardedProtos.has(rightmost) ? rightmost : undefined;
  if (forwardedProto === "wss") return "https";
  if (forwardedProto === "ws") {
    return req.headers["x-arr-ssl"] || isAzurePublicHost(host) ? "https" : "http";
  }
  if (forwardedProto) return forwardedProto;
  if (req.headers["x-arr-ssl"] || isAzurePublicHost(host)) return "https";
  return req.socket.encrypted ? "https" : "http";
};

// The prefix test includes every path that the "/api/**" and "/hubs/**" proxy filters
// match. Those filters test this same URL pathname, and they do not proxy a URL that
// cannot be parsed.
const isPathUnder = (url, roots) => {
  let pathname;
  try {
    pathname = new URL(url ?? "", "http://0.0.0.0").pathname;
  } catch {
    return false;
  }
  return roots.some((root) => pathname === root || pathname.startsWith(`${root}/`));
};
const isBackendPath = (url) => isPathUnder(url, ["/api", "/hubs"]);

// Set the forwarded headers on the incoming request, before a proxy copies its headers.
// A proxy request hook does not run for every request (for example, one with an Expect
// header). The proxy keeps an X-Forwarded-Host that a browser sends, and it adds this
// server's own peer to X-Forwarded-For when that header is absent.
const setForwardedHeaders = (req) => {
  if (!isBackendPath(req.url)) {
    delete req.headers[CLIENT_ADDRESS_HEADER];
    return;
  }
  // Use the frontend request Host, not a client-supplied X-Forwarded-Host.
  // NIP-98 URL binding should reflect the origin the browser actually opened.
  const host = firstHeaderValue(req.headers.host);
  const proto = browserFacingProto(req, host);
  if (host) req.headers["x-forwarded-host"] = host;
  else delete req.headers["x-forwarded-host"];
  req.headers["x-forwarded-proto"] = proto;
  // Node joins repeated X-Forwarded-For lines with ", " in the order received.
  const address = clientAddressFromForwardedFor(req.headers["x-forwarded-for"]);
  if (address) req.headers[CLIENT_ADDRESS_HEADER] = address;
  else delete req.headers[CLIENT_ADDRESS_HEADER];
};

app.use((req, _res, next) => {
  setForwardedHeaders(req);
  next();
});

if (MINT_URL) {
  app.use(
    createProxyMiddleware({
      target: MINT_URL,
      changeOrigin: true,
      pathFilter: "/v1/**",
      on: { error: proxyErrorHandler },
    }),
  );
  console.log(`/v1/* -> ${MINT_URL}`);
}

let hubsProxy;
if (BACKEND_URL) {
  // xfwd:true sets X-Forwarded-{For,Port,Proto,Host} on the upstream request
  // when the incoming request does not have them.
  // The matching engine signs/verifies NIP-98 against the user-facing URL
  // (browser origin); without X-Forwarded-Host the engine reconstructs the URL
  // from its own Host header (which changeOrigin:true rewrites to the backend
  // hostname) and rejects every body-bearing request as "Invalid NIP-98 event".
  // setForwardedHeaders sets the browser-facing host and protocol for /api and
  // /hubs, over HTTP and WebSocket, before these proxies run.
  app.use(
    createProxyMiddleware({
      target: BACKEND_URL,
      changeOrigin: true,
      xfwd: true,
      pathFilter: "/api/**",
      on: { error: proxyErrorHandler },
    }),
  );
  hubsProxy = createProxyMiddleware({
    target: BACKEND_URL,
    changeOrigin: true,
    xfwd: true,
    pathFilter: "/hubs/**",
    ws: true,
    on: { error: proxyErrorHandler },
  });
  app.use(hubsProxy);
  console.log(`/api/* -> ${BACKEND_URL}`);
  console.log(`/hubs/* -> ${BACKEND_URL} (ws)`);
}

app.get("/deployment-identity", deploymentIdentityHandler(identity));

// Block server-side files from being served as static assets
app.use(
  [
    "/server.js",
    "/deployment-identity.js",
    "/deployment-identity.json",
    "/package.json",
    "/package-lock.json",
  ],
  (_req, res) => res.status(404).end(),
);
app.use(express.static(__dirname));
app.get("*", (_req, res) => res.sendFile(join(__dirname, "index.html")));

const server = app.listen(PORT, () => console.log(`Listening on port ${PORT}`));
if (hubsProxy) {
  // An upgrade request does not pass through the Express middleware. The proxy library
  // adds its own upgrade listener on its first HTTP request, and then its upgrade() does
  // nothing. A prepended listener sets the headers before that listener runs.
  server.prependListener("upgrade", (req, socket, head) => {
    // Only the hub proxy accepts an upgrade. Close any other upgrade socket.
    if (!isPathUnder(req.url, ["/hubs"])) {
      socket.destroy();
      return;
    }
    setForwardedHeaders(req);
    hubsProxy.upgrade(req, socket, head);
  });
}
