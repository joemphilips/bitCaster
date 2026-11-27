// Production server for Azure App Service.
// Mirrors Vite dev proxy (vite.config.ts) so frontend code uses relative URLs everywhere.
import {
  CONTENT_SECURITY_POLICY,
  STOPPED_CONTENT_SECURITY_POLICY,
} from "./content-security-policy.js";
import { captureDeploymentIdentity, deploymentIdentityHandler } from "./deployment-identity.js";
import compression from "compression";
import express from "express";
import { createProxyMiddleware } from "http-proxy-middleware";
import { existsSync } from "node:fs";
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

// Search engines do not index any host of this server.
app.use((_req, res, next) => {
  res.setHeader("X-Robots-Tag", "noindex");
  next();
});

const firstHeaderValue = (value) => {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw?.split(",")[0]?.trim();
};

// A stopped host serves only the stopped page (src/stopped, built into ./stopped). It
// forwards nothing to the backend or the mint, and its responses name no other host of
// this site. An API host serves the API paths, and the stopped page for every other path,
// so that it does not serve the app. Both settings are comma-separated lists of host
// names without a port.
const hostNames = (value) =>
  new Set(
    (value ?? "")
      .split(",")
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean),
  );
const STOPPED_HOST_NAMES = hostNames(process.env.STOPPED_HOST_NAMES);
const API_HOST_NAMES = hostNames(process.env.API_HOST_NAMES);
const STOPPED_ROOT = join(__dirname, "stopped");
if (
  STOPPED_HOST_NAMES.size + API_HOST_NAMES.size > 0 &&
  !existsSync(join(STOPPED_ROOT, "index.html"))
) {
  throw new Error(
    `STOPPED_HOST_NAMES or API_HOST_NAMES is set, but the stopped page ${STOPPED_ROOT}/index.html is missing.`,
  );
}
const requestHost = (req) => firstHeaderValue(req.headers.host)?.toLowerCase().replace(/:\d+$/, "");
const isStoppedHost = (req) => STOPPED_HOST_NAMES.has(requestHost(req));
const isApiHost = (req) => API_HOST_NAMES.has(requestHost(req));

const stopped = express.Router();
stopped.use((_req, res, next) => {
  res.setHeader("Content-Security-Policy", STOPPED_CONTENT_SECURITY_POLICY);
  res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  next();
});
// A cached app can still call the backend and the mint until its service worker updates.
// An empty 503 tells it that the service is unavailable, and it reaches no upstream.
stopped.use(["/api", "/hubs", "/v1"], (_req, res) => res.status(503).end());
stopped.get("/deployment-identity", deploymentIdentityHandler(identity));
stopped.use(express.static(STOPPED_ROOT));
stopped.get("/{*path}", (_req, res) => res.sendFile("index.html", { root: STOPPED_ROOT }));
// No request of a stopped host continues to the app routes.
stopped.use((_req, res) => res.status(404).end());
app.use((req, res, next) =>
  isStoppedHost(req) || (isApiHost(req) && !isPathUnder(req.url, ["/api", "/hubs", "/v1"]))
    ? stopped(req, res, next)
    : next(),
);

// Security headers
app.use((_req, res, next) => {
  res.setHeader("Content-Security-Policy", CONTENT_SECURITY_POLICY);
  res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  // A request to another site carries no referrer.
  res.setHeader("Referrer-Policy", "no-referrer");
  // The deposit QR scanner reads the camera. Only this origin can use it.
  res.setHeader("Permissions-Policy", "camera=(self), microphone=(), geolocation=()");
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
    // The proxy library also listens for upgrades on its own after its first request. This
    // filter keeps that listener from forwarding an upgrade of a stopped host.
    // "/hubs/**" matches "/hubs" and every path below it, as this prefix test does.
    pathFilter: (pathname, req) => !isStoppedHost(req) && isPathUnder(pathname, ["/hubs"]),
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
    "/content-security-policy.js",
    "/deployment-identity.js",
    "/deployment-identity.json",
    "/package.json",
    "/package-lock.json",
  ],
  (_req, res) => res.status(404).end(),
);
app.use(express.static(__dirname));
// Express 5 route syntax: "/{*path}" also matches "/", where "/*path" needs one segment.
// A relative path with the root option checks dot segments only inside the root. An absolute path
// refuses a dot segment anywhere, for example in a parent directory such as ~/.local.
app.get("/{*path}", (_req, res) => res.sendFile("index.html", { root: __dirname }));

// Express 5 passes a listen error to this callback. Throw it so that the process stops
// with the error, as an unhandled server error event does.
const server = app.listen(PORT, (error) => {
  if (error) throw error;
  console.log(`Listening on port ${PORT}`);
});
if (hubsProxy) {
  // An upgrade request does not pass through the Express middleware. The proxy library
  // adds its own upgrade listener on its first HTTP request, and then its upgrade() does
  // nothing. A prepended listener sets the headers before that listener runs.
  server.prependListener("upgrade", (req, socket, head) => {
    // Only the hub proxy of an app host accepts an upgrade. Close any other upgrade socket.
    if (isStoppedHost(req) || !isPathUnder(req.url, ["/hubs"])) {
      socket.destroy();
      return;
    }
    setForwardedHeaders(req);
    hubsProxy.upgrade(req, socket, head);
  });
}
