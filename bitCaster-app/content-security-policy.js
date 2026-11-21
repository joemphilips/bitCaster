// The Content Security Policy of the frontend server (server.js).
// The production build loads its scripts, styles, workers and manifest from this origin.
// - script-src: the oracle (Kormir) WASM needs 'wasm-unsafe-eval'. No inline script exists.
// - style-src and font-src: index.html loads Google Fonts. The two hashes allow only the
//   style attributes of the deposit QR scanner overlay (qr-scanner). No other inline style
//   is allowed.
// - img-src: Nostr profile pictures are https or data: images. Image previews are blob: URLs.
// - connect-src: a user can add any https mint. Nostr relays use wss.
// - worker-src: the deposit QR scanner starts its decoder worker from a blob: URL.
import { createHash } from "node:crypto";

export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' https://fonts.googleapis.com 'unsafe-hashes'" +
    " 'sha256-WJ4j1S+Lg0uXNK3sw0TRF93tPA//eAz36eL7k8Ss620='" +
    " 'sha256-FjZ9tznq9lxGuKN6dQKvforasppptrlhMV7TcBgRDq0='",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob: https:",
  "connect-src 'self' https: wss:",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join("; ");

// The service worker serves the precached index.html with the response headers that it
// cached. The build writes this digest into index.html (vite.config.ts), so a policy change
// also changes index.html and its precache revision.
export const CONTENT_SECURITY_POLICY_DIGEST = createHash("sha256")
  .update(CONTENT_SECURITY_POLICY)
  .digest("hex");
